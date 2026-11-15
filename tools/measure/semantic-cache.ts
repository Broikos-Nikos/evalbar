/**
 * semcache's caches through evalbar, every configuration semcache published,
 * and what evalbar says about each.
 *
 *   node tools/measure/semantic-cache.ts      writes measurements/semantic-cache.json
 *
 * Each run is examples/semantic-cache/system.ts as a command, through the same
 * runner, grader and report a user gets, in a scratch folder. Nothing here is
 * timed, so the file is the same on every machine.
 *
 * The thresholds are the ones semcache chose on its calibration stream (0.92
 * for similarity alone, 0.58 with a guard) and the "usual" 0.80; no cache is a
 * threshold above 1, which nothing can reach, and is the bill the others cut.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCases } from '../../src/cases.ts'
import { gradeExact } from '../../src/graders/exact.ts'
import { commandProvider } from '../../src/providers/command.ts'
import { buildReport, pairRuns } from '../../src/report.ts'
import { readRows, runSuite, sha256, type ErrorRow, type Row, type RunConfig } from '../../src/run.ts'

const here = dirname(fileURLToPath(import.meta.url))
const example = join(here, '..', '..', 'examples', 'semantic-cache')
const BAR = 0.999
const PRICES = { input: 3, output: 15 }
const NODE = `"${process.execPath}" --experimental-transform-types --disable-warning=ExperimentalWarning`

type Config = { stream: 'test' | 'words'; threshold: number; guard: 'none' | 'digits' | 'names'; label: string }
const CONFIGS: Config[] = [
  { stream: 'test', threshold: 2, guard: 'none', label: 'no cache' },
  { stream: 'test', threshold: 0.92, guard: 'none', label: 'similarity only, 0.92' },
  { stream: 'test', threshold: 0.8, guard: 'none', label: 'similarity only, 0.80' },
  { stream: 'test', threshold: 0.58, guard: 'digits', label: 'guard on digits, 0.58' },
  { stream: 'test', threshold: 0.58, guard: 'names', label: 'guard on digits and names, 0.58' },
  { stream: 'words', threshold: 2, guard: 'none', label: 'no cache' },
  { stream: 'words', threshold: 0.92, guard: 'none', label: 'similarity only, 0.92' },
  { stream: 'words', threshold: 0.58, guard: 'digits', label: 'guard on digits, 0.58' },
  { stream: 'words', threshold: 0.58, guard: 'names', label: 'guard on digits and names, 0.58' },
]

const scratch = mkdtempSync(join(tmpdir(), 'evalbar-semcache-'))
const runs = new Map<string, { config: RunConfig; rows: Row[]; errors: ErrorRow[] }>()
const r4 = (x: number | null) => (x === null ? null : Number(x.toFixed(4)))
const r6 = (x: number | null) => (x === null ? null : Number(x.toFixed(6)))
try {
  for (const c of CONFIGS) {
    const casesPath = join(example, c.stream === 'test' ? 'cases.jsonl' : join('words', 'cases.jsonl'))
    const cases = loadCases(casesPath)
    const command = `${NODE} system.ts --stream vendor/semcache/data/${c.stream}.json --threshold ${c.threshold} --guard ${c.guard}`
    const provider = commandProvider({ command, cwd: example, timeoutMs: 30_000 })
    const outDir = join(scratch, `${c.stream}-${c.guard}-${c.threshold}`)
    const config: RunConfig = {
      evalbar: 'measure',
      suite: casesPath,
      suiteSha256: sha256(readFileSync(casesPath)),
      cases: cases.length,
      provider: provider.describe,
      requestedModel: null,
      grader: 'exact',
      bar: BAR,
      temperature: 0,
      seed: null,
      prices: PRICES,
      graderPrices: null,
      judge: null,
      startedAt: '',
    }
    try {
      const outcome = await runSuite({ cases, provider, grader: { name: 'exact', grade: (k, out) => gradeExact(out, k.expected) }, outDir, concurrency: 1, config })
      if (outcome.aborted || outcome.errors.length) throw new Error(`${c.stream} ${c.label}: ${outcome.aborted ?? outcome.errors[0].message}`)
    } finally {
      await provider.close()
    }
    runs.set(`${c.stream}|${c.label}`, { config, rows: readRows<Row>(join(outDir, 'results.jsonl')), errors: [] })
  }

  const results = CONFIGS.map((c) => {
    const run = runs.get(`${c.stream}|${c.label}`)!
    const r = buildReport(run.config, run.rows, run.errors)
    const none = runs.get(`${c.stream}|no cache`)!
    const baseline = buildReport(none.config, none.rows, none.errors).cost.total!
    return {
      stream: c.stream,
      cache: c.label,
      requests: r.graded,
      rightAnswers: r.passed,
      wrongAnswers: r.graded - r.passed,
      hits: run.rows.filter((x) => x.usage && x.usage.input === 0 && x.usage.output === 0).length,
      interval: { lo: r4(r.rate!.lo), hi: r4(r.rate!.hi) },
      verdict: r.verdict!.verdict,
      casesToDecide: r.verdict!.needed,
      cost: { total: r6(r.cost.total), perCase: r6(r.cost.perCase), perPassedCase: r6(r.cost.perPassed) },
      billCut: r4(1 - r.cost.total! / baseline),
    }
  })
  const pair = (stream: string, a: string, b: string) => {
    const p = pairRuns(runs.get(`${stream}|${a}`)!, runs.get(`${stream}|${b}`)!, null).comparison
    return { stream, a, b, won: p.won, lost: p.lost, n: p.n, interval: { lo: r4(p.lo), hi: r4(p.hi) }, midP: r4(p.midP), verdict: p.verdict, casesNeeded: p.needed }
  }
  const comparisons = [pair('test', 'similarity only, 0.92', 'guard on digits, 0.58'), pair('words', 'guard on digits, 0.58', 'guard on digits and names, 0.58')]

  const out = { made_by: 'node tools/measure/semantic-cache.ts', bar: BAR, prices: PRICES, semcacheCommit: 'a5ed729', results, comparisons }
  const path = process.env.EVALBAR_MEASURE_OUT ?? join(here, '..', '..', 'measurements', 'semantic-cache.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(out, null, 1)}\n`)
  if (!process.env.EVALBAR_MEASURE_OUT) {
    for (const r of results)
      console.log(
        `${r.stream.padEnd(6)} ${r.cache.padEnd(34)} wrong ${String(r.wrongAnswers).padStart(4)} of ${r.requests}  interval ${r.interval.lo!.toFixed(4)} to ${r.interval.hi!.toFixed(4)}  ${r.verdict.padEnd(12)} ${r.casesToDecide ?? ''}  cut ${((r.billCut ?? 0) * 100).toFixed(1)}%  $${r.cost.perPassedCase} a right answer`,
      )
    for (const c of comparisons) console.log(`${c.stream}: ${c.a} against ${c.b}: won ${c.won}, lost ${c.lost} of ${c.n}, ${c.interval.lo} to ${c.interval.hi}, mid-p ${c.midP}, ${c.verdict}${c.casesNeeded ? `, ${c.casesNeeded} cases needed` : ''}`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
