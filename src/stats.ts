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
 * - **Wilson, not Wald, for one rate.** Wald's interval is p plus or minus
 *   z times its standard error, which is zero when every case passed: 20 of 20
 *   would "prove" a rate of 1 and clear any bar. Wilson's is honest at the ends,
 *   where small evaluations live.
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
  const { lo, hi } = wilson(k, n)
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
    const { lo, hi } = wilson(rate * m, m)
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
