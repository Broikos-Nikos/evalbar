/**
 * What the page computes, kept apart from the page so `tools/check-page.ts`
 * can run the same functions in Node and hold the page to them.
 *
 * Nothing here reimplements evalbar. A visitor's numbers become rows and a run
 * config, and `buildReport`, `renderReport`, `pairRuns` and `renderComparison`
 * are the command's own functions; the Greek grader is `gradeExact`, and the
 * scrubber is `scrubLine`, the importer's.
 */
import { gradeExact } from '../src/graders/exact.ts'
import { scrubLine } from '../src/importer/scrub.ts'
import { buildReport, pairRuns, renderComparison, renderReport } from '../src/report.ts'
import type { Row, RunConfig } from '../src/run.ts'
import { lowerCase } from '../tools/measure/greek-pairs.ts'

export { PAIRS } from '../tools/measure/greek-pairs.ts'

/** The parts of the committed measurements the page reads; the page imports the files whole. */
export type Measured = {
  semantic: {
    bar: number
    results: { stream: string; cache: string; requests: number; rightAnswers: number; wrongAnswers: number; verdict: string; casesToDecide: number | null }[]
    comparisons: { stream: string; a: string; b: string; won: number; lost: number; n: number; midP: number; verdict: string; casesNeeded: number | null }[]
  }
  sql: { cases: number; mustRefuse: Record<string, number> }
  sqlReport: { graded: number; passed: number; bar: number; verdict: { verdict: string }; sampling: { temperature: number | null }; models: { requested: string } }
  judge: { judge: { requested: string }; agreement: { kappa: number }; humans: { kappa: number }; labels: { n: number }; trusted: boolean }
  importer: { funnel: { read: number; kept: number }; scrub: { name: { inKept: number; survived: number } }; namesWithoutRecogniser: { inKept: number; survived: number } }
  greek: { pairs: number; wrong: { lowerCase: number; stripEveryAccent: number; evalbar: number } }
}

const int = (n: number) => n.toLocaleString('en-US')

/** The headline: semcache's digits guard against similarity alone, as `evalbar compare` judged it. */
export function headline(m: Measured): string {
  const c = m.semantic.comparisons.find((x) => x.stream === 'test')!
  return `${int(c.lost)} wrong answers against ${int(c.won)} in ${int(c.n)} requests. evalbar says this sample cannot tell, and that about ${int(c.casesNeeded!)} would.`
}

/** The four results on real systems, every number in them read from a committed file. */
export function realCards(m: Measured) {
  const s92 = m.semantic.results.find((r) => r.stream === 'test' && r.cache === 'similarity only, 0.92')!
  const threshold = s92.cache.split(', ')[1]
  const oneIn = Math.round(1 / (1 - m.semantic.bar))
  const refuse = m.sql.mustRefuse
  const mustRefuse = Object.values(refuse).reduce((a, b) => a + b, 0)
  const size = /(\d+(?:\.\d+)?B)/i.exec(m.sqlReport.models.requested)![1]
  const named = m.importer.scrub.name
  const unnamed = m.importer.namesWithoutRecogniser
  return [
    {
      n: 'CANNOT TELL',
      what: `semcache at a threshold of ${threshold}: ${int(s92.wrongAnswers)} wrong answers in ${int(s92.requests)}, against a bar of one wrong in ${int(oneIn)}. About ${int(s92.casesToDecide!)} requests would decide it.`,
      cmd: 'node tools/measure/semantic-cache.ts',
    },
    {
      n: `${refuse.harm} of ${mustRefuse}`,
      what: `requests a ${size} text to SQL model had to refuse, and carried out on a seeded shop's database. It passed ${m.sqlReport.passed} of ${m.sqlReport.graded} in all: ${m.sqlReport.verdict.verdict.toUpperCase()} against a bar of ${m.sqlReport.bar}.`,
      cmd: 'node tools/measure/sql-run.ts',
    },
    {
      n: m.judge.agreement.kappa.toFixed(3),
      what: `Cohen's kappa of the same model as a judge, against XSTest's annotators on ${m.judge.labels.n} answers; the annotators agree with each other at ${m.judge.humans.kappa.toFixed(3)}. ${m.judge.trusted ? 'Trusted.' : 'Not trusted, so a run it grades gets no PASS or FAIL.'}`,
      cmd: 'evalbar calibrate',
    },
    {
      n: `${named.survived} of ${named.inKept}`,
      what: `planted names left in the ${int(m.importer.funnel.kept)} cases the importer kept from ${int(m.importer.funnel.read)} log rows. logs-to-evals's rules alone let ${unnamed.survived} of ${unnamed.inKept} through.`,
      cmd: 'node tools/measure/importer.ts',
    },
  ]
}

export function greekNote(m: Measured): string {
  const w = m.greek.wrong
  return `${m.greek.pairs === 9 ? 'Nine' : int(m.greek.pairs)} pairs an exact grader must get right. A grader that lower-cases both sides gets ${w.lowerCase} of them wrong; one that throws every accent away gets ${w.stripEveryAccent}; evalbar gets ${w.evalbar}.`
}

/** What the page does not show, its figures from the same files. */
export function failureCards(m: Measured): [string, string][] {
  const refuse = m.sql.mustRefuse
  const passed = Object.values(refuse).reduce((a, b) => a + b, 0) - refuse.harm
  const model = m.sqlReport.models.requested.split('/').pop()!
  const t = m.sqlReport.sampling.temperature
  return [
    ['The SQL suite grades harm, not refusal', `A request it must refuse passes when the database comes to no harm. Of the ${passed} that passed, ${passed - refuse.refused} were not refusals: the model misread them, or wrote SQL that did not run.`],
    ['No trusted judge is shown working', 'The one model this machine could serve fails its calibration, so the path where a calibrated judge decides a verdict is exercised by the tests, with a scripted judge.'],
    ['The name recogniser is a capital letter', 'Two or three capitalised words in a row are taken as a name. On the synthetic log every planted name is written that way; a real log will not be so kind. The examples above show both ways it fails.'],
    ['One small model, one run', `The SQL result is about ${model} and one prompt, at ${t === null ? "the endpoint's default temperature" : `temperature ${t}`}. The interval covers the cases, not the answers another run would draw.`],
  ]
}

const config = (cases: number, bar: number | null): RunConfig => ({
  evalbar: 'page',
  suite: 'your-cases.jsonl',
  suiteSha256: 'page',
  cases,
  provider: 'your system',
  requestedModel: null,
  grader: 'exact',
  bar,
  temperature: 0,
  seed: null,
  prices: null,
  graderPrices: null,
  judge: null,
  startedAt: '',
})

const row = (id: string, pass: boolean): Row => ({
  id, tags: [], cluster: null, input: '', output: '', status: 'graded', pass, reason: '', model: null,
  usage: null, graderUsage: null, graderModel: null, finish: 'stop', latencyMs: 0, attempts: 1, at: '',
})

/** A count a visitor typed: a whole number from 0 to 100,000, or null when it is not one; a run is built case by case, and more would stall the page. */
export function count(s: string): number | null {
  if (!/^\s*\d[\d,]*\s*$/.test(s)) return null
  const n = Number(s.replace(/[\s,]/g, ''))
  return Number.isSafeInteger(n) && n <= 100_000 ? n : null
}

/** A bar a visitor typed: a rate from 0 to 1. */
export function rate(s: string): number | null {
  if (!/^\s*(0|1|0?\.\d+|1\.0*)\s*$/.test(s)) return null
  return Number(s)
}

/**
 * `evalbar report` on a run of `n` graded cases with `k` passed, as the command prints it, down to
 * the verdict. What it prints after that, cost and latency, is about a run that happened, and these
 * cases did not happen, so the page stops where the made-up part would begin.
 */
export function reportText(n: number, k: number, bar: number): string {
  const rows = Array.from({ length: n }, (_, i) => row(String(i + 1), i < k))
  const text = renderReport(buildReport(config(n, bar), rows, []))
  return text.slice(0, text.indexOf('\ncost ') + 1).trimEnd() + '\n'
}

/** `evalbar compare` on two runs of the same `n` cases, where B failed `lost` that A passed and passed `won` that A failed. */
export function compareText(n: number, lost: number, won: number, nameA: string, nameB: string): string {
  // the cases both runs agree on are passes for both; which way they agree does not enter the test
  const a: Row[] = []
  const b: Row[] = []
  for (let i = 0; i < n; i++) {
    const id = String(i + 1)
    const aPass = i >= won
    const bPass = i < won || i >= won + lost
    a.push(row(id, aPass))
    b.push(row(id, bPass))
  }
  return renderComparison(pairRuns({ config: config(n, null), rows: a }, { config: config(n, null), rows: b }, null), nameA, nameB)
}

/** What a visitor asked for, refused in words when it cannot be a run. */
export function runProblem(n: number | null, k: number | null, bar: number | null): string | null {
  if (n === null || n === 0) return 'the cases graded must be a whole number from 1 to 100,000'
  if (k === null || k > n) return `the cases passed must be a whole number from 0 to ${n.toLocaleString('en-US')}`
  if (bar === null) return 'the bar must be a rate from 0 to 1, such as 0.9'
  return null
}

export function compareProblem(n: number | null, lost: number | null, won: number | null): string | null {
  if (n === null || n === 0) return 'the cases graded in both must be a whole number from 1 to 100,000'
  if (lost === null || won === null || lost + won > n) return `the two disagreements must be whole numbers that add up to at most ${n.toLocaleString('en-US')}`
  return null
}

/** The Greek grader against the grader nearly everyone writes. */
export function gradeBoth(output: string, expected: string) {
  const e = gradeExact(output, expected)
  return { evalbar: e.pass, reason: e.reason, lowerCase: lowerCase(output, expected) }
}

/** The importer's scrubber on one line, as the page shows it: the line, then what it took out. */
export function scrubShown(line: string): string {
  const r = scrubLine(line)
  const removed = Object.entries(r.removed).map(([tag, n]) => `${tag} ${n}`).join(', ')
  return `${r.text}\n\ntaken out: ${removed || 'nothing'}`
}

export const SCRUB_EXAMPLES = [
  { label: 'Greek identifiers', text: 'Επιστροφή στον GR96 0810 0010 0000 0123 4567 890, ΑΜΚΑ 01013099997, κινητό +30 6912345678. Με λένε Μαρία Παπαδοπούλου.' },
  { label: 'a card and an email', text: 'Maria Papadopoulou here, card 4111 1111 1111 1111, write to maria@example.com about order 1042' },
  { label: 'a name it misses', text: 'maria papadopoulou here, where is my order' },
  { label: 'a name that is not one', text: 'I bought the Blue Kettle yesterday and it leaks' },
]

/** The page's presets: the semantic cache's own runs, from the committed measurement, and one run that passes. */
export function runPresets(m: Measured) {
  const at = (cache: string) => m.semantic.results.find((r) => r.stream === 'test' && r.cache === cache)!
  const s92 = at('similarity only, 0.92')
  const s80 = at('similarity only, 0.80')
  return [
    { label: `semcache at 0.92: ${s92.rightAnswers.toLocaleString('en-US')} right of ${s92.requests.toLocaleString('en-US')}`, n: s92.requests, k: s92.rightAnswers, bar: m.semantic.bar },
    { label: `semcache at 0.80: ${s80.rightAnswers.toLocaleString('en-US')} right of ${s80.requests.toLocaleString('en-US')}`, n: s80.requests, k: s80.rightAnswers, bar: m.semantic.bar },
    { label: '1,000 of 1,000 against 0.99', n: 1000, k: 1000, bar: 0.99 },
  ]
}

const SHORT: Record<string, string> = {
  'similarity only, 0.92': 'similarity-0.92',
  'guard on digits, 0.58': 'digits-guard-0.58',
  'guard on digits and names, 0.58': 'digits-and-names-guard-0.58',
}

export function comparePresets(m: Measured) {
  return m.semantic.comparisons.map((c) => ({
    label: c.stream === 'test' ? 'semcache: similarity alone, then the digits guard' : 'semcache on product questions: the names guard',
    n: c.n, lost: c.lost, won: c.won, nameA: SHORT[c.a] ?? c.a, nameB: SHORT[c.b] ?? c.b,
  }))
}
