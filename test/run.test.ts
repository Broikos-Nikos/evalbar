/**
 * The runner, against an endpoint and a program that misbehave on request.
 *
 * 07-evaluation/01 section 6 gives the two-minute audit to run before any paid
 * pass: an oracle scores about 100, a null about 0, and an induced error lands
 * as an error and not as a 0. All three are here, with the faults a real
 * endpoint produces: a 503 that clears, a 429 that does not, a stall, an answer
 * cut off by the token limit, a missing usage block, a bad key.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { Case } from '../src/cases.ts'
import { gradeExact } from '../src/graders/exact.ts'
import { commandProvider } from '../src/providers/command.ts'
import { openaiProvider } from '../src/providers/openai.ts'
import type { Provider } from '../src/providers/types.ts'
import { readRows, runSuite, type ErrorRow, type Grader, type Row, type RunConfig } from '../src/run.ts'
import { fakeOpenAi, type Fake } from './fake-openai.ts'

const CASES: Case[] = [
  { id: 'a', input: 'capital of Greece', expected: 'Αθήνα', tags: ['el'], cluster: null, line: 1, extra: {} },
  { id: 'b', input: 'capital of Italy', expected: 'Rome', tags: ['en'], cluster: null, line: 2, extra: {} },
  { id: 'c', input: 'capital of Cyprus', expected: 'Λευκωσία', tags: ['el'], cluster: null, line: 3, extra: {} },
]
const ANSWERS = { 'capital of Greece': 'Αθήνα', 'capital of Italy': 'Rome', 'capital of Cyprus': 'Λευκωσία' }
const exact: Grader = { name: 'exact', grade: (c, out) => gradeExact(out, c.expected) }

const root = mkdtempSync(join(tmpdir(), 'evalbar-run-'))
let fake: Fake
before(async () => {
  fake = await fakeOpenAi(ANSWERS)
})
after(async () => {
  await fake.close()
  rmSync(root, { recursive: true, force: true })
})

let n = 0
const config = (provider: string): RunConfig => ({
  evalbar: 'test',
  suite: 'cases.jsonl',
  suiteSha256: 'x',
  cases: CASES.length,
  provider,
  requestedModel: null,
  grader: 'exact',
  bar: null,
  temperature: null,
  seed: null,
  prices: null,
  graderPrices: null,
  startedAt: '',
})

async function go(provider: Provider, outDir = join(root, `run-${++n}`), cases = CASES) {
  try {
    const outcome = await runSuite({ cases, provider, grader: exact, outDir, concurrency: 2, config: config(provider.describe) })
    return { ...outcome, outDir, rows: readRows<Row>(join(outDir, 'results.jsonl')), errorRows: readRows<ErrorRow>(join(outDir, 'errors.jsonl')) }
  } finally {
    await provider.close()
  }
}
const http = (model: string, extra: { retries?: number; timeoutMs?: number } = {}) =>
  openaiProvider({ baseUrl: fake.url, model, timeoutMs: extra.timeoutMs ?? 2000, retries: extra.retries ?? 2, backoffMs: 1 })

test('an oracle passes every case, with usage, model and one attempt each', async () => {
  const r = await go(http('oracle'))
  assert.equal(r.rows.length, 3)
  assert.ok(r.rows.every((x) => x.pass === true && x.status === 'graded' && x.attempts === 1 && x.model === 'oracle'))
  assert.ok(r.rows.every((x) => x.usage !== null && x.usage.cachedInput === 4))
  assert.equal(r.errorRows.length, 0)
})

test('a null passes none, and each failure says what it got', async () => {
  const r = await go(http('null'))
  assert.equal(r.rows.filter((x) => x.pass).length, 0)
  assert.match(r.rows.find((x) => x.id === 'b')!.reason, /^"" is not "Rome"$/)
})

test('a 503 that clears is retried and counted', async () => {
  const r = await go(http('flaky'))
  assert.ok(r.rows.every((x) => x.pass && x.attempts === 2))
})

test('a 429 that does not clear is an error with its attempts, never a failed case', async () => {
  const r = await go(http('ratelimit', { retries: 2 }))
  assert.equal(r.rows.length, 0)
  assert.equal(r.errorRows.length, 3)
  assert.ok(r.errorRows.every((e) => e.kind === 'http' && e.status === 429 && e.attempts === 3))
})

test('a stalled endpoint times out per case and lands in errors', async () => {
  const r = await go(http('hang', { retries: 0, timeoutMs: 150 }))
  assert.equal(r.rows.length, 0)
  assert.deepEqual(r.errorRows.map((e) => e.kind), ['timeout', 'timeout', 'timeout'])
})

test('an answer cut off by the token limit is counted, not graded', async () => {
  const r = await go(http('truncate'))
  assert.ok(r.rows.every((x) => x.status === 'truncated' && x.pass === null && x.finish === 'length'))
})

test('no usage block is recorded as unknown, not as zero', async () => {
  const r = await go(http('nousage'))
  assert.ok(r.rows.every((x) => x.usage === null && x.pass))
})

test('a model answering under another name is recorded under that name', async () => {
  const r = await go(http('alias'))
  assert.ok(r.rows.every((x) => x.model === 'some-other-model-2026'))
})

test('a bad key stops the run after the first case', async () => {
  const before = fake.calls
  const r = await go(http('auth'))
  assert.match(r.aborted ?? '', /HTTP 401/)
  assert.equal(r.errorRows.length, 1)
  assert.equal(fake.calls - before, 1)
})

test('a second run in the same folder resumes and calls nothing it already has', async () => {
  const outDir = join(root, 'resume')
  await go(http('oracle'), outDir, CASES.slice(0, 2))
  const before = fake.calls
  const r = await go(http('oracle'), outDir)
  assert.equal(fake.calls - before, 1)
  assert.equal(r.skipped, 2)
  assert.deepEqual(r.rows.map((x) => x.id).sort(), ['a', 'b', 'c'])
})

test('a run folder of another suite is refused, not mixed', async () => {
  const outDir = join(root, 'mixed')
  await go(http('oracle'), outDir, CASES.slice(0, 1))
  await assert.rejects(
    runSuite({ cases: CASES, provider: http('null'), grader: exact, outDir, concurrency: 1, config: { ...config('another'), suiteSha256: 'y' } }),
    /holds a run of another suiteSha256, provider/,
  )
})

test('the endpoint is sent the input and never the expected answer', async () => {
  const start = fake.bodies.length
  await go(http('oracle'), join(root, 'leak'), [{ id: 'z', input: 'what is 2+2', expected: 'SECRET-4', tags: ['t'], cluster: null, line: 1, extra: { hidden: 'SECRET-X' } }])
  const sent = fake.bodies.slice(start).join('')
  assert.ok(sent.includes('what is 2+2') && !sent.includes('SECRET'))
})

const script = (name: string, body: string) => {
  const p = join(root, name)
  writeFileSync(p, body)
  return `"${process.execPath}" "${p}"`
}

test('a command answers one line at a time and is sent only the id and the input', async () => {
  const cmd = script(
    'echo.mjs',
    `import { createInterface } from 'node:readline'
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line)
  const keys = Object.keys(c).sort().join(',')
  process.stdout.write(JSON.stringify({ output: keys === 'id,input' ? ${JSON.stringify(ANSWERS)}[c.input] : 'saw ' + keys, usage: { input: 3, output: 1 } }) + '\\n')
}`,
  )
  const r = await go(commandProvider({ command: cmd, timeoutMs: 5000 }))
  assert.ok(r.rows.every((x) => x.pass && x.usage?.input === 3), JSON.stringify(r.rows.map((x) => x.reason)))
})

test('a command that cannot start stops the run at the first case', async () => {
  const r = await go(commandProvider({ command: `"${process.execPath}" "${join(root, 'missing.mjs')}"`, timeoutMs: 5000 }))
  assert.match(r.aborted ?? '', /^the first case: the command exited \(code 1\) before answering: Error: Cannot find module/)
  assert.equal(r.errorRows.length, 1)
  assert.equal(r.rows.length, 0)
})

test("a command that dies on a syntax error is reported by the error, not by Node's own frame", async () => {
  // tick 7: TypeScript Node cannot strip prints "triggerUncaughtException(" first, and that line was picked
  const cmd = script('params.ts', 'class Box { constructor(readonly size: number) {} }\nconsole.log(new Box(1).size)\n')
  const r = await go(commandProvider({ command: cmd, timeoutMs: 5000 }))
  assert.match(r.aborted ?? '', /before answering: SyntaxError \[ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX\]/)
})

test('a command that crashes on one case loses that case to errors and answers the next', async () => {
  const cmd = script(
    'crash.mjs',
    `import { createInterface } from 'node:readline'
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line)
  if (c.id === 'b') { process.stderr.write('index not loaded\\n'); process.exit(3) }
  process.stdout.write(JSON.stringify({ output: ${JSON.stringify(ANSWERS)}[c.input] }) + '\\n')
}`,
  )
  const r = await go(commandProvider({ command: cmd, timeoutMs: 5000 }))
  assert.deepEqual(r.rows.map((x) => x.id).sort(), ['a', 'c'])
  assert.equal(r.errorRows[0].kind, 'process')
  assert.match(r.errorRows[0].message, /exited \(code 3\) before answering: index not loaded/)
})

test('a command that stalls on one case is killed, and a fresh one answers the next', async () => {
  const cmd = script(
    'stall.mjs',
    `import { createInterface } from 'node:readline'
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line)
  if (c.id === 'a') continue
  process.stdout.write(JSON.stringify({ output: ${JSON.stringify(ANSWERS)}[c.input] }) + '\\n')
}`,
  )
  const r = await go(commandProvider({ command: cmd, timeoutMs: 800 }))
  assert.deepEqual(r.errorRows.map((e) => [e.id, e.kind]), [['a', 'timeout']])
  assert.deepEqual(r.rows.map((x) => x.id).sort(), ['b', 'c'])
})
