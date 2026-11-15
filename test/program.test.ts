/**
 * A grader the user writes is checked like any other input: a module with no
 * grade function is refused before the run, and a grade function that
 * returns the wrong shape is a grader error, never a failed case.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { programGrader } from '../src/graders/program.ts'
import type { Provider } from '../src/providers/types.ts'
import { readRows, runSuite, type ErrorRow, type Row } from '../src/run.ts'

const root = mkdtempSync(join(tmpdir(), 'evalbar-program-'))
after(() => rmSync(root, { recursive: true, force: true }))
const mod = (name: string, body: string) => {
  writeFileSync(join(root, name), body)
  return name
}
const echo: Provider = {
  describe: 'echo',
  call: async (_id, input) => ({ text: String(input), usage: null, model: null, finish: null, latencyMs: 0, attempts: 1 }),
  close: async () => {},
}
const cases = [{ id: 'a', input: 'yes', expected: 'yes', tags: [], cluster: null, line: 1, extra: {} }]
const config = { evalbar: 't', suite: 's', suiteSha256: 'x', cases: 1, provider: 'echo', requestedModel: null, grader: 'program', bar: null, temperature: 0, seed: null, prices: null, graderPrices: null, judge: null, startedAt: '' }

test('a program grader grades, async or not', async () => {
  const g = await programGrader(mod('ok.mjs', 'export async function grade(c, out) { return { pass: out === c.expected, reason: "compared" } }'), root)
  const outDir = join(root, 'ok')
  await runSuite({ cases, provider: echo, grader: g, outDir, concurrency: 1, config })
  assert.deepEqual(readRows<Row>(join(outDir, 'results.jsonl')).map((r) => [r.pass, r.reason]), [[true, 'compared']])
})

test('a grade function that returns the wrong shape is a grader error, not a failed case', async () => {
  const g = await programGrader(mod('bad.mjs', 'export const grade = () => true'), root)
  const outDir = join(root, 'bad')
  await runSuite({ cases, provider: echo, grader: g, outDir, concurrency: 1, config })
  assert.equal(readRows<Row>(join(outDir, 'results.jsonl')).length, 0)
  const errors = readRows<ErrorRow>(join(outDir, 'errors.jsonl'))
  assert.equal(errors[0].kind, 'grader')
  assert.match(errors[0].message, /returned true for a, not \{ pass: boolean, reason: string \}/)
})

test('a module without a grade function is refused before anything runs', async () => {
  await assert.rejects(programGrader(mod('none.mjs', 'export const x = 1'), root), /exports no grade function/)
  await assert.rejects(programGrader('missing.mjs', root), /does not exist/)
})
