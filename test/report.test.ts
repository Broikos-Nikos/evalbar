/**
 * The report and compare, through the command line, on run folders written by
 * hand so every number is known before it is printed.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { main } from '../src/app.ts'
import type { ErrorRow, Row, RunConfig } from '../src/run.ts'

const root = mkdtempSync(join(tmpdir(), 'evalbar-report-'))
after(() => rmSync(root, { recursive: true, force: true }))

const config = (over: Partial<RunConfig> = {}): RunConfig => ({
  evalbar: 'test',
  suite: 'suite.jsonl',
  suiteSha256: 'abc',
  cases: 0,
  provider: 'fake',
  requestedModel: 'm',
  grader: 'exact',
  bar: null,
  temperature: 0,
  seed: null,
  prices: null,
  graderPrices: null,
  startedAt: '',
  ...over,
})

type Spec = { pass?: boolean | null; tags?: string[]; usage?: Row['usage']; status?: Row['status']; model?: string; cluster?: string }
const row = (id: string, s: Spec = {}): Row => ({
  id,
  tags: s.tags ?? [],
  cluster: s.cluster ?? null,
  input: `input ${id}`,
  output: 'out',
  status: s.status ?? 'graded',
  pass: s.status === 'truncated' ? null : (s.pass ?? true),
  reason: '',
  model: s.model ?? 'm',
  usage: s.usage === undefined ? { input: 100, output: 10, cachedInput: 0 } : s.usage,
  graderUsage: null,
  finish: 'stop',
  latencyMs: 100,
  attempts: 1,
  at: '',
})

let n = 0
function folder(cfg: RunConfig, rows: Row[], errors: ErrorRow[] = [], extra: Record<string, string> = {}) {
  const dir = join(root, `run-${++n}`)
  mkdirSync(dir)
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...cfg, cases: cfg.cases || rows.length + new Set(errors.map((e) => e.id)).size }))
  writeFileSync(join(dir, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  if (errors.length) writeFileSync(join(dir, 'errors.jsonl'), errors.map((r) => JSON.stringify(r)).join('\n') + '\n')
  for (const [f, text] of Object.entries(extra)) writeFileSync(join(dir, f), text)
  return dir
}

async function cli(...argv: string[]) {
  let out = ''
  let err = ''
  const code = await main(argv, { out: (s) => (out += s), err: (s) => (err += s) })
  return { code, out, err }
}

const many = (count: number, passing: number, s: Spec = {}) => Array.from({ length: count }, (_, i) => row(`c${i}`, { ...s, pass: i < passing }))
const errorRow = (id: string): ErrorRow => ({ id, tags: [], kind: 'timeout', message: 'slow', status: null, attempts: 4, at: '' })

test('the report is rebuilt from the rows, whatever report.json says', async () => {
  const stale = JSON.stringify({ passed: 10, graded: 10, rate: { k: 10, n: 10 } })
  const dir = folder(config(), many(10, 9), [], { 'report.json': stale })
  const r = await cli('report', dir)
  assert.match(r.out, /^9 of 10 passed: 0\.900, 95% interval 0\.555 to 0\.997$/m)
})

test('the three verdicts set the exit code: 0 pass, 1 fail, 3 cannot tell', async () => {
  assert.equal((await cli('report', folder(config({ bar: 0.8 }), many(100, 97)))).code, 0)
  assert.equal((await cli('report', folder(config({ bar: 0.8 }), many(100, 60)))).code, 1)
  const ct = await cli('report', folder(config({ bar: 0.9 }), many(100, 95)))
  assert.equal(ct.code, 3)
  assert.match(ct.out, /CANNOT TELL: the bar of 0\.9 is inside the interval; about \d+ cases at this rate would decide it/)
})

test('no failures is printed as a bound, never as a rate of 1', async () => {
  const r = await cli('report', folder(config(), many(50, 50)))
  assert.match(r.out, /50 of 50 passed: the pass rate is at least 0\.929 \(the low end of its 95% interval\), not 1/)
})

test('cases kept out of the rate that could turn the verdict over are named', async () => {
  const errs = Array.from({ length: 10 }, (_, i) => errorRow(`e${i}`))
  const r = await cli('report', folder(config({ bar: 0.85 }), many(100, 95), errs))
  assert.match(r.out, /PASS: the whole interval is at or above the bar of 0\.85/)
  assert.match(r.out, /but the 10 cases kept out could change it: counted as failures it is CANNOT TELL, as passes PASS/)
  assert.match(r.out, /kept out of the rate: 10 errors \(10 timeout\)/)
})

test('cases kept out that cannot change the verdict say so too', async () => {
  const r = await cli('report', folder(config({ bar: 0.5 }), many(100, 95), [errorRow('e1')]))
  assert.match(r.out, /and the 1 case kept out cannot change it/)
})

test('twenty tags at 16 of 20 against 0.95: each alone fails, together Holm cannot tell', async () => {
  const tags = Array.from({ length: 20 }, (_, t) => `t${String(t).padStart(2, '0')}`)
  const rows = tags.flatMap((t) => Array.from({ length: 20 }, (_, i) => row(`${t}-${i}`, { tags: [t], pass: i < 16 })))
  const r = await cli('report', folder(config({ bar: 0.95 }), rows))
  const verdicts = [...r.out.matchAll(/^ {2}t\d\d .*(CANNOT TELL|FAIL|PASS)$/gm)].map((m) => m[1])
  assert.equal(verdicts.length, 20)
  assert.ok(verdicts.every((v) => v === 'CANNOT TELL'), verdicts.join(','))
  assert.match(r.out, /verdict: exact test, Holm over 20 tags/)
  const alone = await cli('report', folder(config({ bar: 0.95 }), rows.filter((x) => x.tags[0] === 't00')))
  assert.match(alone.out, /^ {2}t00 .*FAIL$/m)
})

test('cost is per case and per passed case, from the usage, at the prices given', async () => {
  // 4 rows of 1,000 in (200 cached) and 100 out at $1 in, $0.10 cached, $2 out per million: $0.00102 each
  const usage = { input: 1000, output: 100, cachedInput: 200 }
  const rows = [row('a', { usage }), row('b', { usage }), row('c', { usage, pass: false }), row('d', { usage, pass: false })]
  const r = await cli('report', folder(config({ prices: { input: 1, output: 2, cachedInput: 0.1 } }), rows))
  assert.match(r.out, /cost {6}\$0\.00408 in all, \$0\.00102 a case, \$0\.00204 a passed case/)
  assert.match(r.out, /tokens {4}4,000 in \(800 of them cached\), 400 out/)
})

test('a run without prices, without usage, or without a pass is not given a price it does not have', async () => {
  assert.match((await cli('report', folder(config(), many(3, 3)))).out, /cost {6}not priced: no prices given/)
  const noUsage = [row('a'), row('b', { usage: null })]
  assert.match((await cli('report', folder(config({ prices: { input: 1, output: 1 } }), noUsage))).out, /not priced: 1 of 2 answers came without a usage block/)
  assert.match((await cli('report', folder(config({ prices: { input: 1, output: 1 } }), many(2, 0)))).out, /no case passed, so a passed case has no price/)
})

test('one answer a case at a sampling temperature says what the interval covers', async () => {
  assert.match((await cli('report', folder(config({ temperature: null }), many(5, 5)))).out, /sampling  one answer a case at the endpoint's default temperature: the interval is over the cases/)
  assert.match((await cli('report', folder(config({ temperature: 0.7, seed: 42 }), many(5, 5)))).out, /at temperature 0\.7: .*; seed 42/)
  assert.doesNotMatch((await cli('report', folder(config({ temperature: 0 }), many(5, 5)))).out, /sampling/)
})

test('an answer under another model name is shown against the one asked for', async () => {
  const r = await cli('report', folder(config({ requestedModel: 'gpt-x' }), [row('a', { model: 'gpt-x-2026-01' }), row('b', { model: 'gpt-x-2026-01' })]))
  assert.match(r.out, /model {5}asked for gpt-x; answered as gpt-x-2026-01 \(2\)/)
})

test('compare: better, worse and refused, with their exit codes', async () => {
  const base = many(100, 50)
  const better = base.map((r, i) => ({ ...r, pass: i < 70 }))
  const a = folder(config(), base)
  const b = folder(config(), better)
  const up = await cli('compare', a, b)
  assert.equal(up.code, 0)
  assert.match(up.out, /B passed 20 that A failed, and failed 0 that A passed/)
  assert.match(up.out, /B IS BETTER/)
  const down = await cli('compare', b, a)
  assert.equal(down.code, 1)
  assert.match(down.out, /B IS WORSE/)
  // the knowledge base's vault case: 6 won, 1 lost of 45
  const kbA = many(45, 20)
  const kbB = kbA.map((r, i) => ({ ...r, pass: i === 0 ? false : i < 26 }))
  const refused = await cli('compare', folder(config(), kbA), folder(config(), kbB))
  assert.equal(refused.code, 3)
  assert.match(refused.out, /difference plus 11\.1 points, 95% interval minus 0\.5 to plus 24\.5; McNemar mid-p 0\.070/)
  assert.match(refused.out, /REFUSED: .* it detects 16\.0 points and more; about 97 cases would detect a difference of 11\.1/)
})

test('compare with a margin: not worse by it, or could still be', async () => {
  const a = many(200, 150)
  const same = folder(config(), a)
  const r = await cli('compare', same, folder(config(), a), '--margin', '0.05')
  assert.equal(r.code, 0)
  assert.match(r.out, /margin 5\.0 points: B is not worse than A by 5\.0 points or more, and the whole interval is inside plus or minus 5\.0/)
  const slightlyWorse = a.map((x, i) => ({ ...x, pass: i < 140 }))
  const w = await cli('compare', same, folder(config(), slightlyWorse), '--margin', '0.05')
  assert.match(w.out, /could still be worse than A by 5\.0 points or more/)
})

test('compare refuses runs that share no case, and names cases graded on one side only', async () => {
  const r = await cli('compare', folder(config(), [row('x')]), folder(config(), [row('y')]))
  assert.equal(r.code, 2)
  assert.match(r.err, /share no graded case/)
  const partial = await cli('compare', folder(config(), [row('x'), row('y')]), folder(config({ suiteSha256: 'other' }), [row('x')]))
  assert.match(partial.out, /different suite files/)
  assert.match(partial.out, /1 case graded only in A and 0 only in B are left out/)
  assert.match(partial.out, /^1 case graded in both/m)
})
