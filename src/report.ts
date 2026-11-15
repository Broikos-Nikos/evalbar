/**
 * What a run means, recomputed from its rows every time it is asked.
 *
 * Never from an aggregate: 07-evaluation/01 section 6 asks that the headline
 * recompute from the per-case rows, because an aggregate field is a number
 * that can go stale beside the rows it summarises. `report.json` is written
 * for tools to read, and nothing here reads it back.
 *
 * Four things the screen always carries, because each is a way a pass rate
 * misleads when it is printed alone:
 *
 * 1. **The interval**, and a verdict against the bar on its ends (src/stats.ts).
 * 2. **The cases kept out.** Errors and cut-off answers are not in the rate,
 *    which is right, and can still decide the verdict: a model that times out on
 *    exactly the hard cases looks better for it. So the verdict is recomputed
 *    with every case kept out counted as a failure, and as a pass, and if
 *    either turns it over the report says so.
 * 3. **The cost of a passed case**, not of a request. A model at half the price
 *    that passes half as often costs the same per task done.
 * 4. **No zero that is not a zero.** A rate with no failures is printed as the
 *    bound the sample supports; a run without prices or without usage says it
 *    is not priced rather than costing $0.00.
 */
import { UserError } from './errors.ts'
import { againstBar, binomTestP, clusteredRate, compare, compareClustered, exactInterval, holm, type BarVerdict, type ClusterCount, type Clustered, type Comparison, type PairCount } from './stats.ts'
import type { ErrorRow, Prices, Row, RunConfig } from './run.ts'
import type { Usage } from './providers/types.ts'

export type Rate = { k: number; n: number; rate: number; lo: number; hi: number }
/** A tag's verdict comes from the exact binomial test at the bar, Holm-adjusted across all the tags (B11). */
export type TagLine = Rate & { tag: string; p: number | null; verdict: BarVerdict['verdict'] | null }
export type Cost = {
  priced: boolean
  /** why there is no total, when there is none */
  why: string | null
  model: number | null
  grader: number | null
  total: number | null
  perCase: number | null
  perPassed: number | null
  tokens: { input: number; cachedInput: number; output: number; graderInput: number; graderOutput: number }
}

export type Report = {
  suite: string
  provider: string
  cases: number
  graded: number
  passed: number
  truncated: number
  /** distinct cases whose last attempt was an error and that have no row */
  errored: number
  errorKinds: Record<string, number>
  notRun: number
  rate: Rate | null
  /** set when the rows name clusters: how much they hold, read as independent cases */
  clusters: Clustered | null
  bar: number | null
  verdict: BarVerdict | null
  /** the verdict with every case kept out counted as a failure, and as a pass */
  sensitivity: { allFail: BarVerdict['verdict']; allPass: BarVerdict['verdict'] } | null
  tags: TagLine[]
  cost: Cost
  models: { requested: string | null; answered: Record<string, number> }
  latency: { median: number; p95: number } | null
  retried: number
  sampling: { temperature: number | null; seed: number | null; note: string | null }
}

/** A rate's interval read at an effective sample size: the counts times `factor`, which is 1 without clusters. */
const rateAt = (k: number, n: number, factor = 1): Rate | null => (n ? { k, n, rate: k / n, ...exactInterval(k * factor, n * factor) } : null)

/** The bar verdict at an effective sample size, with the counts and the cases needed put back in real cases. */
function verdictAt(k: number, n: number, bar: number, factor = 1): BarVerdict {
  const v = againstBar(k * factor, n * factor, bar)
  return { ...v, k, n, rate: k / n, needed: v.needed === null ? null : Math.ceil(v.needed / factor) }
}

/** Rows grouped by cluster; a row with none is a cluster of its own. */
function clusterCounts(rows: Row[]): ClusterCount[] {
  const by = new Map<string, ClusterCount>()
  for (const r of rows) {
    const key = r.cluster === null ? `case ${r.id}` : `cluster ${r.cluster}`
    const c = by.get(key) ?? { k: 0, n: 0 }
    c.n++
    if (r.pass) c.k++
    by.set(key, c)
  }
  return [...by.values()]
}

function price(u: Usage | null, p: Prices): number | null {
  if (!u) return null
  const cached = Math.min(u.cachedInput, u.input)
  return ((u.input - cached) * p.input + cached * (p.cachedInput ?? p.input) + u.output * p.output) / 1e6
}

function costOf(rows: Row[], config: RunConfig, passed: number): Cost {
  const tokens = { input: 0, cachedInput: 0, output: 0, graderInput: 0, graderOutput: 0 }
  for (const r of rows) {
    if (r.usage) {
      tokens.input += r.usage.input
      tokens.cachedInput += r.usage.cachedInput
      tokens.output += r.usage.output
    }
    if (r.graderUsage) {
      tokens.graderInput += r.graderUsage.input
      tokens.graderOutput += r.graderUsage.output
    }
  }
  const none = (why: string): Cost => ({ priced: false, why, model: null, grader: null, total: null, perCase: null, perPassed: null, tokens })
  if (!rows.length) return none('nothing ran')
  if (!config.prices) return none('no prices given: pass --price-in and --price-out, in dollars per million tokens')
  const missing = rows.filter((r) => !r.usage).length
  if (missing) return none(`${missing} of ${rows.length} answers came without a usage block, so their cost is unknown`)
  const model = rows.reduce((s, r) => s + price(r.usage, config.prices!)!, 0)
  const judged = rows.filter((r) => r.graderUsage)
  let grader: number | null = 0
  if (judged.length) {
    if (!config.graderPrices) return none("the grader is a model and has no prices: pass the judge's prices")
    grader = judged.reduce((s, r) => s + price(r.graderUsage, config.graderPrices!)!, 0)
  }
  const total = model + grader
  return { priced: true, why: null, model, grader, total, perCase: total / rows.length, perPassed: passed ? total / passed : null, tokens }
}

function percentile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
}

export function buildReport(config: RunConfig, rows: Row[], errorRows: ErrorRow[], suiteName = config.suite): Report {
  // a resumed run can hold a case twice; the last row is the case
  const byId = new Map(rows.map((r) => [r.id, r]))
  const final = [...byId.values()]
  const graded = final.filter((r) => r.status === 'graded')
  const passed = graded.filter((r) => r.pass).length
  const truncated = final.length - graded.length
  const lastError = new Map<string, ErrorRow>()
  for (const e of errorRows) if (!byId.has(e.id)) lastError.set(e.id, e)
  const errorKinds: Record<string, number> = {}
  for (const e of lastError.values()) errorKinds[e.kind] = (errorKinds[e.kind] ?? 0) + 1
  const errored = lastError.size
  const notRun = Math.max(0, config.cases - final.length - errored)
  // cases in one cluster carry less than their count (B9); every verdict below is read at the effective sample size
  const clustered = graded.some((r) => r.cluster !== null)
  const clusters = clustered ? clusteredRate(clusterCounts(graded)) : null
  const factor = clusters?.factor ?? 1
  const rate = rateAt(passed, graded.length, factor)
  const bar = config.bar
  const verdict = bar !== null && graded.length ? verdictAt(passed, graded.length, bar, factor) : null
  const out = truncated + errored + notRun
  const sensitivity =
    verdict && out
      ? { allFail: verdictAt(passed, graded.length + out, bar!, factor).verdict, allPass: verdictAt(passed + out, graded.length + out, bar!, factor).verdict }
      : null

  const tagNames = [...new Set(graded.flatMap((r) => r.tags))].sort()
  const tagRates = tagNames.map((tag) => {
    const these = graded.filter((r) => r.tags.includes(tag))
    const f = clustered ? clusteredRate(clusterCounts(these)).factor : 1
    return { tag, f, ...rateAt(these.filter((r) => r.pass).length, these.length, f)! }
  })
  const ps = bar === null ? [] : tagRates.map((t) => binomTestP(t.k * t.f, t.n * t.f, bar))
  const decided = holm(ps)
  const tags: TagLine[] = tagRates.map(({ f: _f, ...t }, i) => ({
    ...t,
    p: bar === null ? null : ps[i],
    verdict: bar === null ? null : decided[i] ? (bar === 0 || t.rate > bar ? 'pass' : 'fail') : 'cannot tell',
  }))

  const answered: Record<string, number> = {}
  for (const r of final) if (r.model) answered[r.model] = (answered[r.model] ?? 0) + 1
  const lat = final.map((r) => r.latencyMs).sort((a, b) => a - b)
  return {
    suite: suiteName,
    provider: config.provider,
    cases: config.cases,
    graded: graded.length,
    passed,
    truncated,
    errored,
    errorKinds,
    notRun,
    rate,
    clusters,
    bar,
    verdict,
    sensitivity,
    tags,
    cost: costOf(final, config, passed),
    models: { requested: config.requestedModel, answered },
    latency: lat.length ? { median: percentile(lat, 0.5), p95: percentile(lat, 0.95) } : null,
    retried: final.filter((r) => r.attempts > 1).length,
    sampling: {
      temperature: config.temperature,
      seed: config.seed,
      note:
        config.temperature === 0
          ? null
          : `one answer a case at ${config.temperature === null ? "the endpoint's default temperature" : `temperature ${config.temperature}`}: the interval is over the cases, not over the answers a second run would draw`,
    },
  }
}

const f3 = (x: number) => x.toFixed(3)
/** "1 case", "2 cases": a report a stranger reads should not say "1 cases". */
const count = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`
const int = (x: number) => x.toLocaleString('en-US')
function usd(x: number): string {
  if (x === 0) return '$0'
  if (x >= 1) return `$${x.toFixed(2)}`
  const digits = Math.min(8, Math.max(2, 1 - Math.floor(Math.log10(x)) + 1))
  return `$${x.toFixed(digits)}`
}
const WORDS: Record<BarVerdict['verdict'], string> = { pass: 'PASS', fail: 'FAIL', 'cannot tell': 'CANNOT TELL' }

/** The rate in words, the count first, and no zero failures printed as certainty. */
export function sayRate(r: Rate): string {
  const head = `${int(r.k)} of ${int(r.n)} passed`
  if (r.k === r.n) return `${head}: the pass rate is at least ${f3(r.lo)} (the low end of its 95% interval), not 1`
  if (r.k === 0) return `${head}: the pass rate is at most ${f3(r.hi)} (the high end of its 95% interval), not 0`
  return `${head}: ${f3(r.rate)}, 95% interval ${f3(r.lo)} to ${f3(r.hi)}`
}

export function sayVerdict(v: BarVerdict): string {
  if (v.verdict === 'pass') return `PASS: the whole interval is at or above the bar of ${v.bar}`
  if (v.verdict === 'fail') return `FAIL: the whole interval is below the bar of ${v.bar}`
  const need = v.needed === null ? 'no number of cases would decide it at this rate' : `about ${int(v.needed)} cases at this rate would decide it`
  return `CANNOT TELL: the bar of ${v.bar} is inside the interval; ${need}`
}

export function renderReport(r: Report): string {
  const L: string[] = []
  L.push(`evalbar  ${r.suite}  through ${r.provider}`)
  const kept = [r.truncated && `${r.truncated} cut off by the token limit`, r.errored && `${count(r.errored, "error")} (${Object.entries(r.errorKinds).map(([k, n]) => `${n} ${k}`).join(', ')})`, r.notRun && `${r.notRun} not run`].filter(Boolean)
  L.push(`graded ${int(r.graded)} of ${int(r.cases)} cases${r.clusters ? ` in ${count(r.clusters.clusters, 'cluster')}` : ''}${kept.length ? `; kept out of the rate: ${kept.join(', ')}` : ''}`)
  L.push('')
  if (!r.rate) L.push('no case was graded, so there is no rate')
  else {
    L.push(sayRate(r.rate))
    if (r.clusters)
      L.push(
        `  clustered: design effect ${r.clusters.designEffect.toFixed(1)}, so the ${int(r.graded)} cases count as ${r.clusters.effective.toFixed(1)} independent ones, and the interval is theirs`,
      )
    if (r.verdict) L.push(sayVerdict(r.verdict))
    if (r.sensitivity && r.verdict) {
      const { allFail, allPass } = r.sensitivity
      const out = r.truncated + r.errored + r.notRun
      if (allFail !== r.verdict.verdict || allPass !== r.verdict.verdict)
        L.push(`  but the ${count(out, "case")} kept out could change it: counted as failures it is ${WORDS[allFail]}, as passes ${WORDS[allPass]}`)
      else L.push(`  and the ${count(out, "case")} kept out cannot change it: counted as failures or as passes it stays ${WORDS[r.verdict.verdict]}`)
    }
  }
  if (r.tags.length) {
    L.push('')
    const shown = r.tags.slice(0, 20)
    const w = Math.max(3, ...shown.map((t) => [...t.tag].length))
    L.push(`  ${'tag'.padEnd(w)}  ${'passed'.padStart(12)}  ${'rate'.padStart(5)}  interval${r.bar !== null ? `        verdict: exact test, Holm over ${count(r.tags.length, "tag")}` : ''}`)
    for (const t of shown) {
      const pad = ' '.repeat(Math.max(0, w - [...t.tag].length))
      L.push(`  ${t.tag}${pad}  ${`${int(t.k)} of ${int(t.n)}`.padStart(12)}  ${f3(t.rate)}  ${f3(t.lo)} to ${f3(t.hi)}${t.verdict ? `  ${WORDS[t.verdict]}` : ''}`)
    }
    if (r.tags.length > shown.length) L.push(`  and ${r.tags.length - shown.length} more tags in report.json`)
  }
  L.push('')
  const c = r.cost
  if (c.priced) {
    const per = c.perPassed === null ? 'no case passed, so a passed case has no price' : `${usd(c.perPassed)} a passed case`
    L.push(`cost      ${usd(c.total!)} in all, ${usd(c.perCase!)} a case, ${per}${c.grader ? ` (the grader ${usd(c.grader)} of it)` : ''}`)
  } else L.push(`cost      not priced: ${c.why}`)
  const t = c.tokens
  if (t.input || t.output) L.push(`tokens    ${int(t.input)} in (${int(t.cachedInput)} of them cached), ${int(t.output)} out${t.graderInput ? `; the grader ${int(t.graderInput)} in, ${int(t.graderOutput)} out` : ''}`)
  if (r.sampling.note) L.push(`sampling  ${r.sampling.note}${r.sampling.seed !== null ? `; seed ${r.sampling.seed}` : ''}`)
  if (r.latency) L.push(`latency   median ${int(r.latency.median)} ms, 95th percentile ${int(r.latency.p95)} ms${r.retried ? `; ${count(r.retried, "case")} needed a retry` : ''}`)
  const others = Object.entries(r.models.answered).filter(([m]) => r.models.requested && m !== r.models.requested)
  if (others.length) L.push(`model     asked for ${r.models.requested}; answered as ${others.map(([m, n]) => `${m} (${n})`).join(', ')}`)
  return `${L.join('\n')}\n`
}

/** 0 pass or no bar, 1 fail, 3 cannot tell: a CI step can treat the last as it likes. */
export function exitCode(r: Report): number {
  if (!r.verdict) return 0
  return r.verdict.verdict === 'pass' ? 0 : r.verdict.verdict === 'fail' ? 1 : 3
}

export type Pairing = {
  comparison: Comparison & { clusters?: number; designEffect?: number; method?: 'clustered' }
  onlyA: number
  onlyB: number
  sameSuite: boolean
}

/** Two runs, paired on the cases both graded. */
export function pairRuns(a: { config: RunConfig; rows: Row[] }, b: { config: RunConfig; rows: Row[] }, margin: number | null): Pairing {
  const graded = (rows: Row[]) => new Map(rows.filter((r) => r.status === 'graded').map((r) => [r.id, r]))
  const A = graded(a.rows)
  const B = graded(b.rows)
  // clusters come from A's rows: the same suite gives both runs the same ones (B9)
  const byCluster = new Map<string, PairCount>()
  let lost = 0
  let won = 0
  let n = 0
  for (const [id, ra] of A) {
    const rb = B.get(id)
    if (!rb) continue
    n++
    const key = ra.cluster === null ? `case ${id}` : `cluster ${ra.cluster}`
    const c = byCluster.get(key) ?? { n: 0, won: 0, lost: 0 }
    c.n++
    if (ra.pass && !rb.pass) {
      lost++
      c.lost++
    }
    if (!ra.pass && rb.pass) {
      won++
      c.won++
    }
    byCluster.set(key, c)
  }
  if (!n) throw new UserError('the two runs share no graded case')
  const clustered = byCluster.size < n
  return {
    comparison: clustered ? compareClustered([...byCluster.values()], margin) : compare(lost, won, n, margin),
    onlyA: [...A.keys()].filter((id) => !B.has(id)).length,
    onlyB: [...B.keys()].filter((id) => !A.has(id)).length,
    sameSuite: a.config.suiteSha256 === b.config.suiteSha256,
  }
}

const pts = (x: number) => `${x >= 0 ? 'plus' : 'minus'} ${Math.abs(x * 100).toFixed(1)}`

export function renderComparison(p: Pairing, nameA: string, nameB: string): string {
  const c = p.comparison
  const L: string[] = []
  L.push(`evalbar compare  A ${nameA}  against  B ${nameB}`)
  if (!p.sameSuite) L.push('the runs used different suite files; only the case ids they share are compared')
  if (p.onlyA || p.onlyB) L.push(`${count(p.onlyA, "case")} graded only in A and ${p.onlyB} only in B are left out`)
  L.push(`${count(c.n, 'case')} graded in both: B passed ${c.won} that A failed, and failed ${c.lost} that A passed`)
  if (c.method === 'clustered')
    L.push(`in ${count(c.clusters!, 'cluster')}, design effect ${c.designEffect!.toFixed(1)}: tested on the clusters, Durkalski's clustered McNemar and a cluster-robust interval`)
  L.push(`difference ${pts(c.diff)} points, 95% interval ${pts(c.lo)} to ${pts(c.hi)}; ${c.method === 'clustered' ? 'clustered McNemar p' : 'McNemar mid-p'} ${c.midP.toFixed(3)}`)
  if (c.verdict === 'better') L.push('B IS BETTER: the whole interval is above zero')
  else if (c.verdict === 'worse') L.push('B IS WORSE: the whole interval is below zero')
  else {
    const disc = (c.won + c.lost) / c.n
    const sees = c.detectable === null ? 'the runs disagree on no case, so there is no rate of disagreement to size a test on' : `at this rate of disagreement (${(disc * 100).toFixed(1)}% of cases) it detects ${(c.detectable * 100).toFixed(1)} points and more`
    const need = c.needed === null ? '' : `; about ${int(c.needed)} cases would detect a difference of ${(Math.abs(c.diff) * 100).toFixed(1)}`
    L.push(`REFUSED: the interval includes no difference, so this sample cannot tell. ${sees[0].toUpperCase()}${sees.slice(1)}${need}`)
  }
  if (c.margin !== null) {
    const m = (c.margin * 100).toFixed(1)
    L.push(c.noWorse ? `margin ${m} points: B is not worse than A by ${m} points or more${c.within ? `, and the whole interval is inside plus or minus ${m}` : ''}` : `margin ${m} points: B could still be worse than A by ${m} points or more`)
  }
  return `${L.join('\n')}\n`
}

/** 0 when B is better, or no worse within a margin; 1 when worse; 3 when the sample cannot tell. */
export function compareExit(p: Pairing): number {
  const c = p.comparison
  if (c.verdict === 'worse') return 1
  if (c.margin !== null) return c.noWorse ? 0 : 3
  return c.verdict === 'better' ? 0 : 3
}
