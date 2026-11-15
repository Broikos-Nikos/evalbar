/**
 * A judge is trusted only after it has been measured against people.
 *
 * `evalbar calibrate` runs the judge on outputs that humans have labelled and
 * writes a record: Cohen's kappa with its interval, the true positive and true
 * negative rates, raw agreement and PABAK beside it (07-evaluation/02 section
 * 5, 07-evaluation/04 section 4), the agreement of two humans where the labels
 * carry a second annotator (the ceiling a judge can reach), and the three
 * negative tests every judge must fail: an empty answer, "I don't know", and a
 * confident answer to another question.
 *
 * A run counts a judge's verdicts only with a record that matches it: the same
 * prompt and rubric (their sha256), the same model answering, the low end of
 * kappa's interval at or over the bar (0.6 by default, the base's figure for
 * high-confidence use, a convention and said so), and all three negatives
 * failed. Decision B10 adds one more: a judge from the candidate's own family
 * favours it (GPT-4 by about 10 points, Claude-v1 by about 25, 07-evaluation/02
 * section 4), so when the two share a family the record must have been made on
 * that family's outputs.
 *
 * The record holds ids and verdicts, never the texts, so it can be committed
 * whatever the licence of the outputs it was made on.
 */
import { readFileSync } from 'node:fs'
import { UserError } from './errors.ts'
import { judgeOnce } from './graders/judge.ts'
import { ProviderError, type Provider } from './providers/types.ts'
import { parseJsonl, readText } from './read.ts'
import { sha256 } from './run.ts'
import { cohensKappa } from './stats.ts'
import { family, type CalibrationRecord } from './trust.ts'

// the record and the trust rules live in trust.ts, which reads no file, so the report can run in a browser (B18)
export { family, trusts, type CalibrationRecord } from './trust.ts'

export type Label = { id: string; input: string; output: string; label: 'pass' | 'fail'; second?: 'pass' | 'fail'; first?: 'pass' | 'fail'; model?: string }

export function loadLabels(path: string): Label[] {
  const rows = parseJsonl(readText(path), path)
  const problems: string[] = []
  const seen = new Set<string>()
  const out: Label[] = []
  for (const { line, value } of rows) {
    const v = value as Partial<Label>
    const at = `${path}: line ${line}`
    if (!v || typeof v.id !== 'string' || typeof v.input !== 'string' || typeof v.output !== 'string') problems.push(`${at} needs string id, input and output`)
    else if (v.label !== 'pass' && v.label !== 'fail') problems.push(`${at}: label must be "pass" or "fail"`)
    else if (seen.has(v.id)) problems.push(`${at} repeats the id ${v.id}`)
    else {
      seen.add(v.id)
      out.push(v as Label)
    }
  }
  if (problems.length) throw new UserError(problems.slice(0, 8).join('\n'))
  if (out.length < 2) throw new UserError(`${path}: a calibration needs labels, and this has ${out.length}`)
  return out
}

export async function calibrate(o: {
  labels: Label[]
  labelsFile: string
  judge: Provider
  requestedModel: string
  rubric: string
  promptSha256: string
  kappaBar: number
  concurrency: number
  evalbar: string
  onItem?: (done: number, total: number) => void
}): Promise<CalibrationRecord> {
  const items: CalibrationRecord['items'] = []
  let errors = 0
  let answered: string | null = null
  const queue = [...o.labels]
  let done = 0
  const worker = async () => {
    for (;;) {
      const l = queue.shift()
      if (!l) return
      try {
        const v = await judgeOnce(o.judge, o.rubric, l.input, l.output)
        answered ??= v.model
        items.push({ id: l.id, human: l.label === 'pass', judge: v.pass })
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e
        if (e.fatal) throw e
        errors++
      }
      o.onItem?.(++done, o.labels.length)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, worker))
  items.sort((a, b) => (a.id < b.id ? -1 : 1))
  if (items.length < 2) throw new UserError(`the judge gave a verdict on ${items.length} of ${o.labels.length} items; nothing to calibrate`)

  // the three answers every judge must fail, asked about the first labelled request
  const first = o.labels[0]
  const other = o.labels.find((l) => l.input !== first.input && l.label === 'pass') ?? o.labels.find((l) => l.input !== first.input)!
  const fails = async (answer: string) => {
    try {
      return !(await judgeOnce(o.judge, o.rubric, first.input, answer)).pass
    } catch {
      return false // a judge that cannot give a verdict has not failed the answer
    }
  }
  const negatives = { empty: await fails(''), dontKnow: await fails("I don't know."), otherQuestion: await fails(other.output) }

  const agreement = cohensKappa(items)
  const both = o.labels.filter((l) => l.first && l.second)
  const humans = both.length >= 2 ? cohensKappa(both.map((l) => ({ human: l.first === 'pass', judge: l.second === 'pass' }))) : null
  const reasons: string[] = []
  if (agreement.kappaLo < o.kappaBar) reasons.push(`kappa's 95% interval reaches down to ${agreement.kappaLo.toFixed(3)}, under the bar of ${o.kappaBar}`)
  const missed = Object.entries(negatives).filter(([, ok]) => !ok).map(([k]) => ({ empty: 'an empty answer', dontKnow: '"I don\'t know"', otherQuestion: 'an answer to another question' })[k as 'empty'])
  if (missed.length) reasons.push(`it passed ${missed.join(' and ')}`)
  if (errors) reasons.push(`it gave no verdict on ${errors} of ${o.labels.length} items`)
  const families = [...new Set(o.labels.map((l) => family(l.model)))].sort()
  return {
    evalbar: o.evalbar,
    madeAt: new Date().toISOString().slice(0, 10),
    judge: { requested: o.requestedModel, answered, family: family(answered ?? o.requestedModel) },
    promptSha256: o.promptSha256,
    labels: { file: o.labelsFile, sha256: sha256(readFileSync(o.labelsFile)), n: o.labels.length, families },
    agreement,
    humans,
    negatives,
    errors,
    kappaBar: o.kappaBar,
    trusted: reasons.length === 0,
    why: reasons.length ? reasons.join('; ') : `kappa ${agreement.kappaLo.toFixed(3)} at the low end of its interval clears ${o.kappaBar}, and it failed all three negatives`,
    items,
  }
}

export const readRecord = (path: string): CalibrationRecord => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CalibrationRecord
  } catch (e) {
    throw new UserError(`${path}: not a calibration record (${(e as Error).message})`)
  }
}
