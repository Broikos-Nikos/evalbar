/**
 * How often a verdict against a bar is wrong by chance: one verdict, and a
 * table of per-tag verdicts (decisions B11 and B14).
 *
 *   node tools/measure/tag-verdicts.ts      writes measurements/tag-verdicts.json
 *
 * Part 1 is exact, no simulation: for one rate, the chance of a false FAIL
 * when the true rate is exactly the bar, and of a false PASS when it is 2
 * points under, summed over every count the binomial can produce, for the
 * Wilson interval evalbar first used and the exact interval it uses now.
 *
 * Part 2 is a seeded simulation of a per-tag table. Each trial draws every
 * tag's pass count from its true rate and takes each tag's verdict three ways:
 * alone (its own exact interval), Holm over the score test's p-values, and
 * Holm over the exact test's (the rule the report uses). A verdict is false
 * when it says PASS and the true rate is under the bar, or FAIL and it is at or
 * over. CANNOT TELL is never false; the right decisive verdicts are counted
 * apart, as the price of the adjustment.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { barTestP, binomTestP, exactInterval, holm, wilson } from '../../src/stats.ts'

const SEED = 20261115
const TRIALS = 4000
const BAR = 0.9

function mulberry32(a: number) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Verdict = 'pass' | 'fail' | 'cannot tell'
const r4 = (x: number) => Number(x.toFixed(4))
const verdictOf = (lo: number, hi: number): Verdict => (lo >= BAR ? 'pass' : hi < BAR ? 'fail' : 'cannot tell')

function pmf(n: number, p: number): number[] {
  const out: number[] = []
  let logC = 0
  for (let k = 0; k <= n; k++) {
    if (k > 0) logC += Math.log((n - k + 1) / k)
    out.push(Math.exp(logC + k * Math.log(p) + (n - k) * Math.log(1 - p)))
  }
  return out
}

// part 1: one verdict, exactly
const single = [20, 50, 100, 200, 1000].map((n) => {
  const at = pmf(n, BAR)
  const under = pmf(n, BAR - 0.02)
  const sum = (probs: number[], pick: (k: number) => boolean) => probs.reduce((s, p, k) => s + (pick(k) ? p : 0), 0)
  const wil = Array.from({ length: n + 1 }, (_, k) => wilson(k, n))
  const ex = Array.from({ length: n + 1 }, (_, k) => exactInterval(k, n))
  return {
    n,
    falseFailAtTheBar: { wilson: r4(sum(at, (k) => verdictOf(wil[k].lo, wil[k].hi) === 'fail')), exact: r4(sum(at, (k) => verdictOf(ex[k].lo, ex[k].hi) === 'fail')) },
    falsePassTwoPointsUnder: { wilson: r4(sum(under, (k) => verdictOf(wil[k].lo, wil[k].hi) === 'pass')), exact: r4(sum(under, (k) => verdictOf(ex[k].lo, ex[k].hi) === 'pass')) },
  }
})

// part 2: a table of tags, simulated
const rand = mulberry32(SEED)
const isFalse = (v: Verdict, truth: number) => (v === 'pass' && truth < BAR) || (v === 'fail' && truth >= BAR)

function scenario(tags: number, perTag: number, spread: 'at' | 'around') {
  // every verdict and p-value depends on the count alone, so each is computed once for every count
  const alone: Verdict[] = []
  const scoreP: number[] = []
  const exactP: number[] = []
  for (let k = 0; k <= perTag; k++) {
    const iv = exactInterval(k, perTag)
    alone.push(verdictOf(iv.lo, iv.hi))
    scoreP.push(barTestP(k, perTag, BAR))
    exactP.push(binomTestP(k, perTag, BAR))
  }
  const tally = { alone: [0, 0, 0], score: [0, 0, 0], exact: [0, 0, 0] } // runs with a false verdict, false verdicts, right decisive verdicts
  for (let t = 0; t < TRIALS; t++) {
    const truth = Array.from({ length: tags }, () => (spread === 'at' ? BAR : BAR - 0.05 + 0.1 * rand()))
    const k = truth.map((p) => {
      let s = 0
      for (let i = 0; i < perTag; i++) if (rand() < p) s++
      return s
    })
    const decide = (rejected: boolean[]): Verdict[] => k.map((x, i) => (rejected[i] ? (x / perTag > BAR ? 'pass' : 'fail') : 'cannot tell'))
    const ways: Record<keyof typeof tally, Verdict[]> = {
      alone: k.map((x) => alone[x]),
      score: decide(holm(k.map((x) => scoreP[x]))),
      exact: decide(holm(k.map((x) => exactP[x]))),
    }
    for (const w of Object.keys(tally) as (keyof typeof tally)[]) {
      const wrong = ways[w].filter((v, i) => isFalse(v, truth[i])).length
      tally[w][0] += wrong > 0 ? 1 : 0
      tally[w][1] += wrong
      tally[w][2] += ways[w].filter((v, i) => v !== 'cannot tell' && !isFalse(v, truth[i])).length
    }
  }
  const of = (i: number) => ({ alone: r4(tally.alone[i] / TRIALS), holmScore: r4(tally.score[i] / TRIALS), holmExact: r4(tally.exact[i] / TRIALS) })
  return {
    tags,
    perTag,
    truth: spread === 'at' ? 'every tag at the bar' : 'true rates within 5 points of the bar',
    runsWithAFalseVerdict: of(0),
    falseVerdictsPerRun: of(1),
    rightVerdictsPerRun: of(2),
  }
}

const table = []
for (const spread of ['at', 'around'] as const) for (const tags of [5, 10, 20]) for (const perTag of [20, 50, 200]) table.push(scenario(tags, perTag, spread))

const out = { made_by: 'node tools/measure/tag-verdicts.ts', bar: BAR, single, table: { seed: SEED, trials: TRIALS, results: table } }
const path = process.env.EVALBAR_MEASURE_OUT ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'measurements', 'tag-verdicts.json')
mkdirSync(dirname(path), { recursive: true })
writeFileSync(path, `${JSON.stringify(out, null, 1)}\n`)

if (!process.env.EVALBAR_MEASURE_OUT) {
  console.log(`one verdict against a bar of ${BAR}            false FAIL at the bar      false PASS 2 points under`)
  console.log('                                         wilson    exact            wilson    exact')
  for (const s of single)
    console.log(`  ${String(s.n).padStart(5)} cases                            ${s.falseFailAtTheBar.wilson.toFixed(4)}   ${s.falseFailAtTheBar.exact.toFixed(4)}           ${s.falsePassTwoPointsUnder.wilson.toFixed(4)}   ${s.falsePassTwoPointsUnder.exact.toFixed(4)}`)
  console.log('')
  console.log('a table of tags                         tags  per tag   runs with a false verdict      right verdicts a run')
  console.log('                                                        alone   holm on   holm on      alone   holm on   holm on')
  console.log('                                                                score     exact                score     exact')
  for (const r of table)
    console.log(
      `${r.truth.padEnd(40)}${String(r.tags).padStart(4)}${String(r.perTag).padStart(9)}   ${r.runsWithAFalseVerdict.alone.toFixed(3).padStart(6)}   ${r.runsWithAFalseVerdict.holmScore.toFixed(3).padStart(6)}    ${r.runsWithAFalseVerdict.holmExact.toFixed(3).padStart(6)}      ${r.rightVerdictsPerRun.alone.toFixed(2).padStart(5)}   ${r.rightVerdictsPerRun.holmScore.toFixed(2).padStart(5)}     ${r.rightVerdictsPerRun.holmExact.toFixed(2).padStart(5)}`,
    )
}
