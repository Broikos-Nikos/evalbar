/**
 * What clustering does to a verdict, and what the cluster-robust rule gives
 * back (decision B9). A seeded simulation, not a measurement of any model.
 *
 *   node tools/measure/clusters.ts      writes measurements/clusters.json
 *
 * Part 1, one rate against a bar of 0.9. G clusters of m cases; each cluster
 * draws its own rate from a beta distribution whose mean is the true rate and
 * whose intra-cluster correlation is rho (0 is independent cases, 1 is
 * near-copies: a cluster is all right or all wrong). Counted: a false FAIL when
 * the true rate is the bar, a false PASS when it is 3 points under, for the
 * exact interval on the raw counts and on the effective sample size.
 *
 * Part 2, two runs on 50 families of 4, the design of the knowledge base's
 * M14: each item is fixed with probability (churn + effect) / 2 and broken with
 * (churn - effect) / 2, either on its own or with its whole family. Counted:
 * how often the comparison decides (better or worse) with no true effect, and
 * with a true gain of 10 points, for Tango on the cases and the clustered test.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clusteredRate, compare, compareClustered, effectiveCounts, exactInterval, type PairCount } from '../../src/stats.ts'

const SEED = 20261116
const BAR = 0.9
const r4 = (x: number) => Number(x.toFixed(4))

function mulberry32(a: number) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(SEED)
const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand())
/** Marsaglia and Tsang, with the boost for a shape under 1. */
function gamma(shape: number): number {
  if (shape < 1) return gamma(shape + 1) * rand() ** (1 / shape)
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x: number
    let v: number
    do {
      x = normal()
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = rand()
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}
function clusterRate(mean: number, rho: number): number {
  if (rho === 0) return mean
  if (rho === 1) return rand() < mean ? 1 : 0
  const a = (mean * (1 - rho)) / rho
  const b = ((1 - mean) * (1 - rho)) / rho
  const x = gamma(a)
  return x / (x + gamma(b))
}
const verdictOf = (lo: number, hi: number) => (lo >= BAR ? 'pass' : hi < BAR ? 'fail' : 'cannot tell')

// part 1
const TRIALS_1 = 2000
const part1 = []
for (const rho of [0, 0.2, 1])
  for (const G of [10, 30, 100])
    for (const m of [5, 20]) {
      const n = G * m
      const naive = Array.from({ length: n + 1 }, (_, k) => {
        const iv = exactInterval(k, n)
        return verdictOf(iv.lo, iv.hi)
      })
      const row: Record<string, unknown> = { rho, clusters: G, perCluster: m }
      for (const [label, truth, wrong] of [
        ['falseFailAtTheBar', BAR, 'fail'],
        ['falsePassThreePointsUnder', BAR - 0.03, 'pass'],
      ] as const) {
        let naiveWrong = 0
        let clusteredWrong = 0
        for (let t = 0; t < TRIALS_1; t++) {
          const counts = Array.from({ length: G }, () => {
            const p = clusterRate(truth, rho)
            let k = 0
            for (let i = 0; i < m; i++) if (rand() < p) k++
            return { k, n: m }
          })
          const k = counts.reduce((s, c) => s + c.k, 0)
          if (naive[k] === wrong) naiveWrong++
          const e = effectiveCounts(clusteredRate(counts))
          const iv = exactInterval(e.k, e.n)
          if (verdictOf(iv.lo, iv.hi) === wrong) clusteredWrong++
        }
        row[label] = { naive: r4(naiveWrong / TRIALS_1), clustered: r4(clusteredWrong / TRIALS_1) }
      }
      part1.push(row)
    }

// part 2
const TRIALS_2 = 2000
const FAMILIES = 50
const SIZE = 4
const part2 = []
for (const together of [false, true])
  for (const churn of [0.06, 0.1, 0.14])
    for (const effect of [0, 0.1]) {
      const fix = (churn + effect) / 2
      const brk = (churn - effect) / 2
      const draw = () => {
        const u = rand()
        return u < fix ? 1 : u < fix + brk ? -1 : 0
      }
      let naiveDecided = 0
      let clusteredDecided = 0
      for (let t = 0; t < TRIALS_2; t++) {
        const counts: PairCount[] = Array.from({ length: FAMILIES }, () => {
          const flips = together ? Array(SIZE).fill(draw()) : Array.from({ length: SIZE }, draw)
          return { n: SIZE, won: flips.filter((x) => x === 1).length, lost: flips.filter((x) => x === -1).length }
        })
        const won = counts.reduce((s, c) => s + c.won, 0)
        const lost = counts.reduce((s, c) => s + c.lost, 0)
        if (compare(lost, won, FAMILIES * SIZE).verdict !== 'refused') naiveDecided++
        if (compareClustered(counts).verdict !== 'refused') clusteredDecided++
      }
      part2.push({
        flips: together ? 'whole families' : 'items',
        churn,
        effect,
        decided: { tangoOnCases: r4(naiveDecided / TRIALS_2), clustered: r4(clusteredDecided / TRIALS_2) },
      })
    }

const out = { made_by: 'node tools/measure/clusters.ts', seed: SEED, bar: BAR, rate: { trials: TRIALS_1, results: part1 }, compare: { trials: TRIALS_2, families: FAMILIES, perFamily: SIZE, results: part2 } }
const path = process.env.EVALBAR_MEASURE_OUT ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'measurements', 'clusters.json')
mkdirSync(dirname(path), { recursive: true })
writeFileSync(path, `${JSON.stringify(out, null, 1)}\n`)

if (!process.env.EVALBAR_MEASURE_OUT) {
  console.log(`one rate against ${BAR}         false FAIL at the bar     false PASS 3 points under`)
  console.log('rho  clusters  per cluster    naive   clustered          naive   clustered')
  for (const r of part1 as { rho: number; clusters: number; perCluster: number; falseFailAtTheBar: { naive: number; clustered: number }; falsePassThreePointsUnder: { naive: number; clustered: number } }[])
    console.log(
      `${r.rho.toFixed(1)}  ${String(r.clusters).padStart(8)}  ${String(r.perCluster).padStart(11)}    ${r.falseFailAtTheBar.naive.toFixed(3)}   ${r.falseFailAtTheBar.clustered.toFixed(3)}              ${r.falsePassThreePointsUnder.naive.toFixed(3)}   ${r.falsePassThreePointsUnder.clustered.toFixed(3)}`,
    )
  console.log('')
  console.log(`two runs, ${FAMILIES} families of ${SIZE}: share of runs where the comparison decides`)
  console.log('flips           churn  effect    tango on cases   clustered')
  for (const r of part2) console.log(`${r.flips.padEnd(15)} ${r.churn.toFixed(2)}   ${r.effect.toFixed(2)}        ${r.decided.tangoOnCases.toFixed(3)}          ${r.decided.clustered.toFixed(3)}`)
}
