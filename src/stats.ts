/**
 * The arithmetic every verdict rests on, and the verdicts.
 *
 * One convention throughout: a two-sided 95 percent interval, and a decision
 * made on its ends. A rate passes a bar when the whole interval is at or above
 * it, which is the regulators' convention for non-inferiority (the lower end of
 * a two-sided 95 percent interval, a one-sided test at 2.5 percent). The same
 * interval gives the bound printed when nothing failed, so the report never
 * mixes a one-sided 95 and a two-sided 95 in one screen.
 *
 * Why these methods and not the textbook ones:
 *
 * - **Exact, not Wald, for one rate.** Wald's interval is p plus or minus
 *   z times its standard error, which is zero when every case passed: 20 of 20
 *   would "prove" a rate of 1 and clear any bar. The verdict was first taken on
 *   Wilson's interval, which is honest at the ends on average; tick 5 measured it
 *   calling a rate equal to the bar a FAIL 4.32 percent of the time at 20 cases
 *   where 2.5 is promised, so the verdict is now taken on the exact
 *   (Clopper-Pearson) interval, whose ends hold their level at every rate.
 *   The "about how many cases" figure uses the same interval at a fractional
 *   count; `wilson` stays for the measurement that compares the two.
 * - **Paired, for two runs on the same cases.** Only the cases where the runs
 *   disagree carry information. evalkit had to use the conservative unpaired
 *   arithmetic because the evaluation it judged never recorded those cases;
 *   evalbar records every case, so it uses them.
 * - **McNemar's mid-p and Tango's score interval** for that comparison, the
 *   pair Fagerland, Lydersen and Laake recommend after comparing 24 methods
 *   (Statistics in Medicine, 2014), and not the Wald interval they advise
 *   against. ai-knowledge 07-evaluation/01 section 2 has the measured case
 *   where Wald called a win the data could not carry.
 *
 * Every function is checked against values computed by statsmodels and scipy
 * in tools/reference/stats_reference.py, which shares no code with this file.
 */
import { Z80, Z95, nNeededPaired } from './vendor/evalkit/power.mjs'

export { Z95 }

export type Interval = { lo: number; hi: number }

/** Below this, two rates are the same rate: far under any precision a report prints, far over double noise. */
const EPS = 1e-12

/** The Wilson score interval for k successes in n. k may be fractional, which the planning search below uses. */
export function wilson(k: number, n: number, z = Z95): Interval {
  if (!(n > 0)) throw new RangeError(`wilson: n must be positive, got ${n}`)
  if (k < 0 || k > n) throw new RangeError(`wilson: k must be within 0 and ${n}, got ${k}`)
  const p = k / n
  const z2 = z * z
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n)
  const half = (z / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  // at the ends the formula's own value is exact in real numbers and off by a few ulps in doubles
  return { lo: k === 0 ? 0 : Math.max(0, centre - half), hi: k === n ? 1 : Math.min(1, centre + half) }
}

export type BarVerdict = {
  verdict: 'pass' | 'fail' | 'cannot tell'
  k: number
  n: number
  rate: number
  lo: number
  hi: number
  bar: number
  /** Cases that would decide it, if the rate stayed what was observed; null when it is decided, or when no sample could. */
  needed: number | null
}

/**
 * Does a rate of k in n clear the bar?
 *
 * Three answers and no fourth. "cannot tell" is the one most tools never give:
 * 95 of 100 against a bar of 0.9 reads like a pass and is not one, because the
 * interval runs from 0.888 to 0.978.
 */
export function againstBar(k: number, n: number, bar: number): BarVerdict {
  if (!(bar >= 0 && bar <= 1)) throw new RangeError(`the bar is a rate from 0 to 1, got ${bar}`)
  const { lo, hi } = exactInterval(k, n)
  const base = { k, n, rate: k / n, lo, hi, bar }
  if (lo >= bar - EPS) return { ...base, verdict: 'pass', needed: null }
  if (hi < bar - EPS) return { ...base, verdict: 'fail', needed: null }
  return { ...base, verdict: 'cannot tell', needed: casesToDecide(k / n, bar, n) }
}

/**
 * The smallest sample at which an observed rate, held fixed, would put the
 * whole interval on one side of the bar. A planning figure, said as "about":
 * the true rate is not the observed one, which is the point of the interval.
 */
export function casesToDecide(rate: number, bar: number, from = 1): number | null {
  if (Math.abs(rate - bar) < EPS) return null
  const decides = (m: number) => {
    const { lo, hi } = exactInterval(rate * m, m)
    return rate > bar ? lo >= bar - EPS : hi < bar - EPS
  }
  // a rate of exactly 1 against a bar of 1 never decides: no finite sample proves a rate of 1
  let hiN = Math.max(1, from)
  while (!decides(hiN)) {
    if (hiN > 1e12) return null
    hiN *= 2
  }
  let loN = Math.max(1, Math.floor(hiN / 2))
  while (hiN - loN > 1) {
    const mid = Math.floor((loN + hiN) / 2)
    if (decides(mid)) hiN = mid
    else loN = mid
  }
  return decides(loN) ? loN : hiN
}

/** log of C(m, i), summed rather than factorised so that m in the hundreds of thousands neither overflows nor rounds to nothing. */
function logChoose(m: number, i: number): number {
  let s = 0
  const j = Math.min(i, m - i)
  for (let t = 1; t <= j; t++) s += Math.log((m - j + t) / t)
  return s
}

/**
 * McNemar's mid-p: on the m cases where two runs disagree, how surprising the
 * split is if neither run is better. Two-sided, 2 x (P(X < k) + P(X = k) / 2)
 * with X binomial(m, 1/2) and k the smaller count, capped at 1.
 */
export function mcnemarMidP(lost: number, won: number): number {
  const m = lost + won
  if (m === 0) return 1
  const k = Math.min(lost, won)
  const logHalf = m * Math.log(0.5)
  let below = 0
  for (let i = 0; i < k; i++) below += Math.exp(logChoose(m, i) + logHalf)
  const at = Math.exp(logChoose(m, k) + logHalf)
  return Math.min(1, 2 * (below + at / 2))
}

/**
 * Tango's score statistic for the paired difference d = (x12 - x21) / n, at a
 * hypothesised d0, with the constrained maximum likelihood of p21 in closed
 * form (Tango, Statistics in Medicine 17:891, 1998).
 */
function tangoZ(x12: number, x21: number, n: number, d0: number): number {
  const a = 2 * n
  const b = -x12 - x21 + (2 * n - x12 + x21) * d0
  const c = -x21 * d0 * (1 - d0)
  const p21 = (-b + Math.sqrt(Math.max(b * b - 4 * a * c, 0))) / (2 * a)
  const v = n * (2 * p21 + d0 * (1 - d0))
  const num = x12 - x21 - n * d0
  if (v <= 0) return num === 0 ? 0 : num > 0 ? Infinity : -Infinity
  return num / Math.sqrt(v)
}

/** Tango's 95 percent score interval for (x12 - x21) / n, by bisection on a statistic that falls as d0 rises. */
export function tango(x12: number, x21: number, n: number, z = Z95): Interval {
  if (!(n > 0) || x12 < 0 || x21 < 0 || x12 + x21 > n) throw new RangeError(`tango: counts ${x12} and ${x21} do not fit in ${n}`)
  const est = (x12 - x21) / n
  const solve = (from: number, to: number, target: number) => {
    let a = from
    let b = to
    for (let i = 0; i < 200 && b - a > 1e-15; i++) {
      const mid = (a + b) / 2
      if (tangoZ(x12, x21, n, mid) > target) a = mid
      else b = mid
    }
    return (a + b) / 2
  }
  return {
    lo: est <= -1 ? -1 : solve(-1, est, z),
    hi: est >= 1 ? 1 : solve(est, 1, -z),
  }
}

/** Cases needed to detect a paired difference at 80 percent power, from evalkit, which takes percentages. */
export function pairedNeeded(diff: number, discordantRate: number): number | null {
  return nNeededPaired(Math.abs(diff) * 100, discordantRate * 100)
}

/**
 * The smallest paired difference n cases can detect at 80 percent power, at the
 * observed rate of disagreement. The figure a refusal is built on.
 */
export function pairedDetectable(n: number, discordantRate: number): number | null {
  if (!(discordantRate > 0)) return null
  let lo = 0
  let hi = Math.sqrt(discordantRate)
  if ((pairedNeeded(hi * (1 - 1e-9), discordantRate) ?? Infinity) > n) return null
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    const need = pairedNeeded(mid, discordantRate)
    if (need !== null && need <= n) hi = mid
    else lo = mid
  }
  return hi
}

export type Comparison = {
  verdict: 'better' | 'worse' | 'refused'
  n: number
  /** cases the second run passed and the first failed */
  won: number
  /** cases the first run passed and the second failed */
  lost: number
  /** (won - lost) / n, the second run's rate minus the first's */
  diff: number
  lo: number
  hi: number
  midP: number
  /** the smallest difference this sample detects at 80 percent power, at its rate of disagreement */
  detectable: number | null
  /** cases needed to detect the observed difference, at 80 percent power */
  needed: number | null
  margin: number | null
  /** with a margin: the second run is not worse than the first by the margin or more */
  noWorse: boolean | null
  /** with a margin: the whole interval lies inside plus or minus the margin */
  within: boolean | null
}

/**
 * Two runs on the same n cases. The decision is the interval's: better when it
 * is all above zero, worse when all below, refused otherwise, with what this
 * sample could have seen and what it would take. Z80 is evalkit's power
 * convention, carried through `pairedNeeded`.
 */
export function compare(lost: number, won: number, n: number, margin: number | null = null): Comparison {
  const { lo, hi } = tango(won, lost, n)
  const diff = (won - lost) / n
  const disc = (won + lost) / n
  const verdict = lo > EPS ? 'better' : hi < -EPS ? 'worse' : 'refused'
  return {
    verdict,
    n,
    won,
    lost,
    diff,
    lo,
    hi,
    midP: mcnemarMidP(lost, won),
    detectable: pairedDetectable(n, disc),
    needed: diff === 0 ? null : pairedNeeded(diff, disc),
    margin,
    noWorse: margin === null ? null : lo > -margin,
    within: margin === null ? null : lo > -margin && hi < margin,
  }
}

/** The power convention, exported so a report can say which one it used. */
export const POWER = { z: Z80, power: 0.8 }

/**
 * The upper tail of the standard normal, from the complementary error function
 * (Numerical Recipes' erfcc, fractional error under 1.2e-7: far finer than
 * any threshold a verdict is taken at, and checked against scipy).
 */
export function normalUpper(z: number): number {
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.5 * x)
  const erfc =
    t *
    Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))))
  const upper = erfc / 2
  return z >= 0 ? upper : 1 - upper
}

/**
 * The two-sided score test of "the rate is the bar": the test the Wilson
 * interval inverts, so one tag on its own gets the verdict its interval gives.
 */
export function barTestP(k: number, n: number, bar: number): number {
  const rate = k / n
  if (bar <= 0) return k > 0 ? 0 : 1
  if (bar >= 1) return k < n ? 0 : 1
  const z = (rate - bar) / Math.sqrt((bar * (1 - bar)) / n)
  return Math.min(1, 2 * normalUpper(Math.abs(z)))
}

/**
 * Holm's step-down rejections at a family-wise level: the smallest p against
 * alpha / k, the next against alpha / (k - 1), stopping at the first that
 * fails. Uniformly more powerful than Bonferroni, and with one test it is the
 * test itself.
 */
export function holm(ps: number[], alpha = 0.05): boolean[] {
  const order = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p)
  const reject = ps.map(() => false)
  for (let j = 0; j < order.length; j++) {
    if (order[j].p > alpha / (order.length - j) + EPS) break
    reject[order[j].i] = true
  }
  return reject
}

/**
 * The exact two-sided binomial test of "the rate is p0": twice the smaller
 * tail, capped at 1. The tag verdicts use this and not the score test above,
 * because tick 5 measured the score test's p-values too small when a tag
 * expects two or three failures: Holm on them let 11.7 percent of simulated
 * runs carry a false verdict at 10 tags of 20 cases, against the 5 it
 * promises (measurements/tag-verdicts.json). The exact test is conservative,
 * so the promise holds.
 */
export function binomTestP(k: number, n: number, p0: number): number {
  if (p0 <= 0) return k <= 0 ? 1 : 0
  if (p0 >= 1) return k >= n ? 1 : 0
  // the binomial tails through the incomplete beta, P(X <= k) = I_(1-p0)(n-k, k+1) and P(X >= k) = I_p0(k, n-k+1),
  // which also take the fractional count a clustered tag is read at (B9)
  const below = k >= n ? 1 : betaInc(1 - p0, n - k, k + 1)
  const above = k <= 0 ? 1 : betaInc(p0, k, n - k + 1)
  return Math.min(1, 2 * Math.min(below, above))
}

/** log Gamma by Lanczos (g = 7, nine terms), good to about 1e-15 for positive arguments. */
export function logGamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x)
  const y = x - 1
  let a = c[0]
  const t = y + 7.5
  for (let i = 1; i < 9; i++) a += c[i] / (y + i)
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(a)
}

/** The continued fraction of the incomplete beta, by Lentz's method (Numerical Recipes, betacf). */
function betaFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300
  let c = 1
  let d = 1 - ((a + b) * x) / (a + 1)
  if (Math.abs(d) < tiny) d = tiny
  d = 1 / d
  let h = d
  for (let m = 1; m <= 500; m++) {
    const m2 = 2 * m
    let num = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2))
    d = 1 + num * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + num / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    h *= d * c
    num = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1))
    d = 1 + num * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + num / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-15) break
  }
  return h
}

/** The regularised incomplete beta I_x(a, b): P(X <= x) for X ~ Beta(a, b). */
export function betaInc(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  return x < (a + 1) / (a + b + 2) ? (front * betaFraction(a, b, x)) / a : 1 - (front * betaFraction(b, a, 1 - x)) / b
}

/**
 * The exact (Clopper-Pearson) 95 percent interval for k in n, k allowed to be
 * fractional for an effective sample size. Its two ends each hold their 2.5
 * percent at every true rate, which Wilson's do only on average: tick 5
 * measured Wilson calling a rate equal to a bar of 0.9 a FAIL 4.32 percent of
 * the time at 20 cases and 3.99 at 100, where 2.5 was promised; exact, 1.13 and
 * 2.06 (decision B14).
 */
export function exactInterval(k: number, n: number, alpha = 0.05): Interval {
  if (!(n > 0)) throw new RangeError(`exactInterval: n must be positive, got ${n}`)
  // a count scaled to an effective sample size can overshoot its end by a few ulps
  if (k > n && k - n < 1e-9 * n) k = n
  if (k < 0 && k > -1e-9 * n) k = 0
  if (k < 0 || k > n) throw new RangeError(`exactInterval: k must be within 0 and ${n}, got ${k}`)
  const solve = (f: (p: number) => number, target: number) => {
    let lo = 0
    let hi = 1
    for (let i = 0; i < 200 && hi - lo > 1e-15; i++) {
      const mid = (lo + hi) / 2
      if (f(mid) < target) lo = mid
      else hi = mid
    }
    return (lo + hi) / 2
  }
  return {
    // P(X >= k | p) = I_p(k, n - k + 1) rises with p; the low end is where it reaches alpha / 2
    lo: k <= 0 ? 0 : solve((p) => betaInc(p, k, n - k + 1), alpha / 2),
    // P(X <= k | p) = 1 - I_p(k + 1, n - k) falls with p; the high end is where it falls to alpha / 2
    hi: k >= n ? 1 : solve((p) => betaInc(p, k + 1, n - k), 1 - alpha / 2),
  }
}

/** Student's t distribution function, through the incomplete beta. */
export function tCdf(t: number, df: number): number {
  const tail = 0.5 * betaInc(df / (df + t * t), df / 2, 0.5)
  return t >= 0 ? 1 - tail : tail
}

const tMemo = new Map<string, number>()

/** The p quantile of Student's t on df degrees of freedom, by bisection, remembered: a report asks for the same few. */
export function tQuantile(p: number, df: number): number {
  const key = `${p}|${df}`
  const known = tMemo.get(key)
  if (known !== undefined) return known
  const q = tQuantileOnce(p, df)
  tMemo.set(key, q)
  return q
}

function tQuantileOnce(p: number, df: number): number {
  let lo = -1e3
  let hi = 1e3
  for (let i = 0; i < 200 && hi - lo > 1e-12; i++) {
    const mid = (lo + hi) / 2
    if (tCdf(mid, df) < p) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** One cluster's counts: cases graded, and of them passed. */
export type ClusterCount = { k: number; n: number }

export type Clustered = {
  k: number
  n: number
  clusters: number
  /** the variance of the rate with the clusters, over the variance it would have without them; at least 1 */
  designEffect: number
  /** the independent cases these are worth, after the design effect and the degrees of freedom */
  effective: number
  /** effective over n: multiply a count by it to read it at the effective sample size */
  factor: number
}

/** The counts a clustered rate is read at: the observed rate, at the effective sample size. */
export const effectiveCounts = (c: Clustered) => ({ k: c.n ? (c.k / c.n) * c.effective : 0, n: c.effective })

/**
 * A rate over cases that come in clusters (decision B9): the design effect from
 * the cluster-robust variance of the ratio estimator, with G/(G-1), and Korn
 * and Graubard's effective sample size (Statistics in Medicine 17:1745, 1998),
 * n / deff scaled by (t on n-1 over t on G-1) squared, so that few clusters cost
 * what an estimated variance costs. Read at that size, the exact interval.
 *
 * One departure, on the conservative side: at a rate of 0 or 1 every cluster
 * agrees with every other and the data cannot say how alike a cluster's cases
 * are, so each cluster counts once. Korn and Graubard set the design effect to
 * 1 there, which would let 20 near-copies of one answer count as 20 cases.
 * There is no variance estimated at that point, so no allowance for estimating
 * one either: the first live run printed 4 of 4 in 2 clusters as 0.000 to
 * 1.000, the penalty for a variance on 1 degree of freedom applied to a
 * variance nobody computed (tick 8b). Each cluster once gives 0.158 to 1.
 */
export function clusteredRate(counts: ClusterCount[]): Clustered {
  const k = counts.reduce((s, c) => s + c.k, 0)
  const n = counts.reduce((s, c) => s + c.n, 0)
  const G = counts.length
  if (G === n || G < 2) return { k, n, clusters: G, designEffect: 1, effective: n, factor: 1 }
  if (k === 0 || k === n) return { k, n, clusters: G, designEffect: n / G, effective: G, factor: G / n }
  const p = k / n
  const dfFactor = (tQuantile(0.975, n - 1) / tQuantile(0.975, G - 1)) ** 2
  const varCluster = (G / (G - 1)) * counts.reduce((s, c) => s + (c.k - p * c.n) ** 2, 0) / (n * n)
  const deff = Math.max(1, varCluster / ((p * (1 - p)) / n))
  const effective = Math.min(n, (n / deff) * dfFactor)
  return { k, n, clusters: G, designEffect: deff, effective, factor: effective / n }
}

/** One cluster's paired counts: cases graded in both runs, those the second won and those it lost. */
export type PairCount = { n: number; won: number; lost: number }

/**
 * Two runs on cases that come in clusters. Durkalski's clustered McNemar
 * (Statistics in Medicine 22:2417, 2003), (sum of per-cluster differences)
 * squared over the sum of their squares, which is McNemar's own statistic when
 * every cluster holds one case; and an interval on the cluster-robust variance
 * of the paired difference (Obuchowski, Statistics in Medicine 17:1495, 1998),
 * with t on G-1. The decision is the interval's, as in `compare`. The detectable
 * difference and the cases needed are the unclustered ones scaled by the
 * design effect of the difference.
 */
export function compareClustered(counts: PairCount[], margin: number | null = null): Comparison & { clusters: number; designEffect: number; method: 'clustered' } {
  const n = counts.reduce((s, c) => s + c.n, 0)
  const won = counts.reduce((s, c) => s + c.won, 0)
  const lost = counts.reduce((s, c) => s + c.lost, 0)
  const G = counts.length
  const diff = (won - lost) / n
  const d = counts.map((c) => c.won - c.lost)
  const sumSq = d.reduce((s, x) => s + x * x, 0)
  const chi = sumSq ? (won - lost) ** 2 / sumSq : 0
  const p = sumSq ? Math.min(1, 2 * normalUpper(Math.sqrt(chi))) : 1
  const varCluster = G > 1 ? ((G / (G - 1)) * counts.reduce((s, c, i) => s + (d[i] - diff * c.n) ** 2, 0)) / (n * n) : Infinity
  const half = G > 1 ? tQuantile(0.975, G - 1) * Math.sqrt(varCluster) : Infinity
  const lo = Math.max(-1, diff - half)
  const hi = Math.min(1, diff + half)
  const disc = (won + lost) / n
  const varNaive = (disc - diff * diff) / n
  const designEffect = varNaive > 0 && Number.isFinite(varCluster) ? Math.max(1, varCluster / varNaive) : G > 1 ? n / G : Infinity
  const verdict = lo > EPS ? 'better' : hi < -EPS ? 'worse' : 'refused'
  const detectable = pairedDetectable(n / designEffect, disc)
  const need = diff === 0 ? null : pairedNeeded(diff, disc)
  return {
    verdict,
    n,
    won,
    lost,
    diff,
    lo,
    hi,
    midP: p,
    detectable,
    needed: need === null ? null : Math.ceil(need * designEffect),
    margin,
    noWorse: margin === null ? null : lo > -margin,
    within: margin === null ? null : lo > -margin && hi < margin,
    clusters: G,
    designEffect,
    method: 'clustered',
  }
}

export type Agreement = {
  n: number
  /** the share of items the humans called a pass */
  prevalence: number
  /** raw agreement, printed beside kappa and never instead of it */
  agreement: number
  kappa: number
  kappaLo: number
  kappaHi: number
  /** the judge's pass rate on the items humans passed, and its fail rate on the ones they failed */
  tpr: number | null
  tnr: number | null
  /** prevalence and bias adjusted kappa: twice the agreement, less one */
  pabak: number
}

/**
 * Cohen's kappa between a judge and human labels, with the large-sample
 * variance of Fleiss, Cohen and Everitt (1969) as statsmodels computes it, the
 * true positive and true negative rates apart, and PABAK beside it, because
 * 07-evaluation/04 section 4 measured raw agreement 0.96 next to kappa 0.65 on
 * a skewed set, and a judge that always says pass agrees with 95 percent of a
 * set where 5 percent fail.
 */
export function cohensKappa(pairs: { human: boolean; judge: boolean }[]): Agreement {
  const n = pairs.length
  if (!n) throw new RangeError('cohensKappa: no pairs')
  // rows: human pass, human fail; columns: judge pass, judge fail
  const t = [
    [0, 0],
    [0, 0],
  ]
  for (const p of pairs) t[p.human ? 0 : 1][p.judge ? 0 : 1]++
  const prob = t.map((r) => r.map((x) => x / n))
  const row = [prob[0][0] + prob[0][1], prob[1][0] + prob[1][1]]
  const col = [prob[0][0] + prob[1][0], prob[0][1] + prob[1][1]]
  const agree = prob[0][0] + prob[1][1]
  const expected = row[0] * col[0] + row[1] * col[1]
  const kappa = expected === 1 ? 1 : (agree - expected) / (1 - expected)
  let a = 0
  let b = 0
  for (let i = 0; i < 2; i++)
    for (let j = 0; j < 2; j++) {
      if (i === j) a += prob[i][i] * (1 - (row[i] + col[i]) * (1 - kappa)) ** 2
      else b += prob[i][j] * (col[i] + row[j]) ** 2
    }
  const c = (kappa - expected * (1 - kappa)) ** 2
  const variance = expected === 1 ? 0 : (a + (1 - kappa) ** 2 * b - c) / (1 - expected) ** 2 / n
  const half = Z95 * Math.sqrt(Math.max(0, variance))
  const humansPass = t[0][0] + t[0][1]
  const humansFail = t[1][0] + t[1][1]
  return {
    n,
    prevalence: humansPass / n,
    agreement: agree,
    kappa,
    kappaLo: kappa - half,
    kappaHi: Math.min(1, kappa + half),
    tpr: humansPass ? t[0][0] / humansPass : null,
    tnr: humansFail ? t[1][1] / humansFail : null,
    pabak: 2 * agree - 1,
  }
}
