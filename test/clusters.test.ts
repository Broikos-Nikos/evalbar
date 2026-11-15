/**
 * Cases that come in clusters (decision B9), and the control the knowledge base
 * audit asked for: twenty near-copies a cluster must not PASS a bar that only
 * their naive count clears.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { main } from '../src/app.ts'
import { toCases } from '../src/cases.ts'
import type { Row, RunConfig } from '../src/run.ts'
import { clusteredRate, compareClustered } from '../src/stats.ts'

const root = mkdtempSync(join(tmpdir(), 'evalbar-clusters-'))
after(() => rmSync(root, { recursive: true, force: true }))

const config = (bar: number | null): RunConfig => ({
  evalbar: 'test',
  suite: 'suite.jsonl',
  suiteSha256: 'abc',
  cases: 0,
  provider: 'fake',
  requestedModel: null,
  grader: 'exact',
  bar,
  temperature: 0,
  seed: null,
  prices: null,
  graderPrices: null,
  startedAt: '',
})
const row = (id: string, pass: boolean, cluster: string | null): Row => ({
  id,
  tags: [],
  cluster,
  input: id,
  output: '',
  status: 'graded',
  pass,
  reason: '',
  model: null,
  usage: null,
  graderUsage: null,
  finish: null,
  latencyMs: 1,
  attempts: 1,
  at: '',
})
let n = 0
function folder(bar: number | null, rows: Row[]) {
  const dir = join(root, `run-${++n}`)
  mkdirSync(dir)
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...config(bar), cases: rows.length }))
  writeFileSync(join(dir, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return dir
}
async function cli(...argv: string[]) {
  let out = ''
  let err = ''
  const code = await main(argv, { out: (s) => (out += s), err: (s) => (err += s) })
  return { code, out, err }
}

/** clusters of `size` near-copies: every case in a cluster has the cluster's outcome */
const copies = (clusters: number, size: number, passing: (c: number) => boolean, named: boolean) =>
  Array.from({ length: clusters }, (_, c) => Array.from({ length: size }, (_, i) => row(`c${c}-${i}`, passing(c), named ? `s${c}` : null))).flat()

test('20 near-copies a cluster, 9 clusters right and 1 wrong: the naive count clears 0.84, the clusters cannot', async () => {
  const naive = await cli('report', folder(0.84, copies(10, 20, (c) => c < 9, false)))
  assert.match(naive.out, /^PASS/m)
  const clustered = await cli('report', folder(0.84, copies(10, 20, (c) => c < 9, true)))
  assert.match(clustered.out, /^CANNOT TELL/m)
  assert.equal(clustered.code, 3)
  assert.match(clustered.out, /graded 200 of 200 cases in 10 clusters/)
  assert.match(clustered.out, /clustered: design effect 22\.2, so the 200 cases count as 6\.8 independent ones/)
})

test('20 near-copies a cluster, all right: the naive count clears 0.95, the clusters cannot', async () => {
  const naive = await cli('report', folder(0.95, copies(10, 20, () => true, false)))
  assert.match(naive.out, /^PASS/m)
  const clustered = await cli('report', folder(0.95, copies(10, 20, () => true, true)))
  assert.match(clustered.out, /^CANNOT TELL/m)
  assert.match(clustered.out, /count as 7\.6 independent ones/)
})

test('clusters whose cases vary as independent ones cost almost nothing', () => {
  // 100 sessions of 2, one case right and one wrong in a third of them: no more alike within than across
  const counts = Array.from({ length: 100 }, (_, i) => ({ k: i % 3 === 0 ? 1 : 2, n: 2 }))
  const c = clusteredRate(counts)
  assert.equal(c.designEffect, 1)
  assert.ok(c.factor > 0.98, `factor ${c.factor}`)
})

test('without a cluster field nothing changes', () => {
  const c = clusteredRate(Array.from({ length: 50 }, (_, i) => ({ k: i < 45 ? 1 : 0, n: 1 })))
  assert.deepEqual([c.designEffect, c.effective, c.factor], [1, 50, 1])
})

test("families that flip together: Tango calls B better, the clustered test refuses", async () => {
  // 50 families of 4; B fixes three whole families, breaks none (the shape of the base's M14)
  const a = Array.from({ length: 50 }, (_, f) => Array.from({ length: 4 }, (_, i) => row(`f${f}-${i}`, f >= 10, `f${f}`))).flat()
  const b = a.map((r) => ({ ...r, pass: r.pass || ['f0', 'f1', 'f2'].includes(r.cluster!) }))
  const strip = (rows: Row[]) => rows.map((r) => ({ ...r, cluster: null }))
  const naive = await cli('compare', folder(null, strip(a)), folder(null, strip(b)))
  assert.match(naive.out, /B IS BETTER/)
  const clustered = await cli('compare', folder(null, a), folder(null, b))
  assert.match(clustered.out, /in 50 clusters, design effect \d+\.\d: tested on the clusters/)
  assert.match(clustered.out, /clustered McNemar p 0\.083/)
  assert.match(clustered.out, /REFUSED/)
  assert.equal(clustered.code, 3)
})

test("Durkalski's statistic is McNemar's when every cluster holds one case", () => {
  // 1 against 7: asymptotic McNemar p 0.0339 (test/fixtures/stats-reference.json)
  const counts = [...Array.from({ length: 7 }, () => ({ n: 1, won: 1, lost: 0 })), { n: 1, won: 0, lost: 1 }, ...Array.from({ length: 13 }, () => ({ n: 1, won: 0, lost: 0 }))]
  assert.equal(compareClustered(counts).midP.toFixed(4), '0.0339')
})

test('a cluster is read from the file as a string, and anything else is refused', () => {
  const ok = toCases([{ line: 1, value: { input: 'a', cluster: 17 } }, { line: 2, value: { input: 'b' } }], 's.jsonl')
  assert.deepEqual(ok.map((c) => c.cluster), ['17', null])
  assert.throws(() => toCases([{ line: 1, value: { input: 'a', cluster: { user: 1 } } }], 's.jsonl'), /cluster must be a string or a number/)
})
