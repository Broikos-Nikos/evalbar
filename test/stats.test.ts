/**
 * The statistics against code that shares nothing with them, and the verdicts
 * at the boundaries where a careless implementation turns over.
 *
 * test/fixtures/stats-reference.json is printed by
 * `python tools/reference/stats_reference.py` (statsmodels and scipy).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { againstBar, barTestP, betaInc, binomTestP, casesToDecide, compare, exactInterval, holm, mcnemarMidP, normalUpper, pairedDetectable, pairedNeeded, tango, wilson } from '../src/stats.ts'

type Ref = {
  wilson: { k: number; n: number; lo: number; hi: number }[]
  mcnemar: { b: number; c: number; midp: number }[]
  tango: { x12: number; x21: number; n: number; lo: number; hi: number }[]
}
const ref = JSON.parse(readFileSync(new URL('./fixtures/stats-reference.json', import.meta.url), 'utf8')) as Ref

const near = (got: number, want: number, tol: number, what: string) =>
  assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, statsmodels and scipy say ${want}`)

test('Wilson intervals equal statsmodels on 11 cases, the ends included', () => {
  for (const r of ref.wilson) {
    const w = wilson(r.k, r.n)
    near(w.lo, r.lo, 1e-9, `wilson(${r.k}, ${r.n}).lo`)
    near(w.hi, r.hi, 1e-9, `wilson(${r.k}, ${r.n}).hi`)
  }
})

test("McNemar's mid-p equals scipy's binomial on 8 cases", () => {
  for (const r of ref.mcnemar) near(mcnemarMidP(r.b, r.c), r.midp, 1e-9, `midp(${r.b}, ${r.c})`)
})

test("Tango's interval equals a numerical maximum likelihood on 8 cases", () => {
  for (const r of ref.tango) {
    const t = tango(r.x12, r.x21, r.n)
    near(t.lo, r.lo, 1e-6, `tango(${r.x12}, ${r.x21}, ${r.n}).lo`)
    near(t.hi, r.hi, 1e-6, `tango(${r.x12}, ${r.x21}, ${r.n}).hi`)
  }
})

test('two published figures come out as published', () => {
  // ai-knowledge 07-evaluation/01 section 2: 6 won, 1 lost of 45, "minus 0.5 to plus 24.5", mid-p 0.07
  const kb = compare(1, 6, 45)
  assert.equal((kb.lo * 100).toFixed(1), '-0.5')
  assert.equal((kb.hi * 100).toFixed(1), '24.5')
  assert.equal(kb.midP.toFixed(2), '0.07')
  assert.equal(kb.verdict, 'refused')
  // Fagerland, Lydersen and Laake's airway example, 1 against 7 of 21: Tango -0.517 to -0.026, mid-p 0.039
  const ahr = compare(7, 1, 21)
  assert.equal(ahr.lo.toFixed(3), '-0.517')
  assert.equal(ahr.hi.toFixed(3), '-0.026')
  assert.equal(ahr.midP.toFixed(3), '0.039')
  assert.equal(ahr.verdict, 'worse')
})

test('20 of 20 does not clear a bar of 0.85: the interval Wald would make has no width', () => {
  // Wald: 1 plus or minus 0, a pass; exact: 0.832 to 1
  const v = againstBar(20, 20, 0.85)
  assert.equal(v.verdict, 'cannot tell')
  assert.ok(v.lo < 0.85 && v.hi === 1)
  assert.ok(v.needed !== null && v.needed > 20)
})

test('the three verdicts, each where it belongs', () => {
  assert.equal(againstBar(99, 100, 0.9).verdict, 'pass')
  assert.equal(againstBar(95, 100, 0.9).verdict, 'cannot tell')
  assert.equal(againstBar(80, 100, 0.9).verdict, 'fail')
  assert.equal(againstBar(2000, 2000, 0.99).verdict, 'pass')
  assert.equal(againstBar(50, 50, 0.95).verdict, 'cannot tell')
})

test('the bar sits exactly on an end of the interval: the end counts as clearing it', () => {
  const { lo } = exactInterval(90, 100)
  assert.equal(againstBar(90, 100, lo).verdict, 'pass')
})

test('no sample decides a rate equal to the bar, or a perfect rate against a bar of 1', () => {
  assert.deepEqual([againstBar(90, 100, 0.9).verdict, againstBar(90, 100, 0.9).needed], ['cannot tell', null])
  assert.deepEqual([againstBar(50, 50, 1).verdict, againstBar(50, 50, 1).needed], ['cannot tell', null])
})

test('the cases needed are the smallest that decide', () => {
  for (const [rate, bar] of [[0.95, 0.9], [0.85, 0.9], [0.5, 0.6], [0.999, 0.99]]) {
    const m = casesToDecide(rate, bar)!
    const decides = (n: number) => {
      const w = exactInterval(rate * n, n)
      return rate > bar ? w.lo >= bar : w.hi < bar
    }
    assert.ok(decides(m), `${m} cases should decide ${rate} against ${bar}`)
    assert.ok(!decides(m - 1), `${m - 1} cases already decide ${rate} against ${bar}`)
  }
})

test('the detectable difference is the one the paired formula needs exactly this many cases for', () => {
  for (const [n, r] of [[45, 7 / 45], [2000, 3 / 2000], [200, 0.2]]) {
    const d = pairedDetectable(n, r)!
    assert.ok(pairedNeeded(d, r)! <= n)
    assert.ok(pairedNeeded(d * 0.99, r)! > n)
  }
})

test('two runs that agree on every case: refused, and a margin can still be met', () => {
  const c = compare(0, 0, 50)
  assert.equal(c.verdict, 'refused')
  assert.equal(c.detectable, null)
  assert.equal(c.needed, null)
  const m = compare(0, 0, 50, 0.1)
  assert.deepEqual([m.within, m.noWorse], [true, true])
  assert.deepEqual([compare(0, 0, 50, 0.05).within], [false])
})

test('three wrong answers against none in 2,000 is refused', () => {
  const c = compare(3, 0, 2000)
  assert.equal(c.verdict, 'refused')
  near(c.midP, 0.125, 1e-12, 'midp(3, 0)')
})

type More = {
  binom: { k: number; n: number; p0: number; exact: number; score: number }[]
  normal_upper: { z: number; upper: number }[]
}
const more = ref as unknown as More

test('the normal tail equals scipy to 1e-7 on 8 points', () => {
  for (const r of more.normal_upper) near(normalUpper(r.z), r.upper, 1e-7, `normalUpper(${r.z})`)
})

test('the exact binomial test and the score test equal scipy on 8 cases', () => {
  for (const r of more.binom) {
    near(binomTestP(r.k, r.n, r.p0), r.exact, 1e-9, `binomTestP(${r.k}, ${r.n}, ${r.p0})`)
    near(barTestP(r.k, r.n, r.p0), r.score, 1e-6, `barTestP(${r.k}, ${r.n}, ${r.p0})`)
  }
})

test('15 of 20 against 0.9: the score test says 0.025, the exact test 0.086', () => {
  // the case behind the switch to exact tests for tags: two expected failures, and the normal tail is too thin
  assert.equal(barTestP(15, 20, 0.9).toFixed(3), '0.025')
  assert.equal(binomTestP(15, 20, 0.9).toFixed(3), '0.086')
})

test("Holm: the smallest p against alpha over k, stopping at the first that fails", () => {
  assert.deepEqual(holm([0.01, 0.04, 0.03, 0.005], 0.05), [true, false, false, true])
  assert.deepEqual(holm([0.04]), [true])
  assert.deepEqual(holm([0.04, 0.04]), [false, false])
  assert.deepEqual(holm([0.001, 0.02, 0.04]), [true, true, true])
})

type Exact = { exact: { k: number; n: number; lo: number; hi: number }[]; betainc: { x: number; a: number; b: number; value: number }[] }
const ex = ref as unknown as Exact

test('the incomplete beta equals scipy on 5 cases', () => {
  for (const r of ex.betainc) near(betaInc(r.x, r.a, r.b), r.value, 1e-10, `betaInc(${r.x}, ${r.a}, ${r.b})`)
})

test('exact intervals equal statsmodels on 11 cases, the ends included', () => {
  for (const r of ex.exact) {
    const w = exactInterval(r.k, r.n)
    near(w.lo, r.lo, 1e-9, `exact(${r.k}, ${r.n}).lo`)
    near(w.hi, r.hi, 1e-9, `exact(${r.k}, ${r.n}).hi`)
  }
})

test('one tag alone gets the verdict the whole suite gets', () => {
  // the exact interval and the exact test are duals; with Wilson on one line and exact tests on the other they were not
  for (const [k, n, bar] of [[17, 20, 0.95], [15, 20, 0.9], [99, 100, 0.9], [190, 200, 0.9], [58, 60, 0.85]]) {
    const v = againstBar(k, n, bar).verdict
    const rejected = holm([binomTestP(k, n, bar)])[0]
    assert.equal(rejected ? (k / n > bar ? 'pass' : 'fail') : 'cannot tell', v, `${k} of ${n} against ${bar}`)
  }
})
