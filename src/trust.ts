/**
 * Whether a judge's verdicts may count, and the record that decides it.
 *
 * Kept apart from `calibration.ts`, which reads label files and calls the
 * judge, so that the report, which only asks the question, imports nothing that
 * needs a file system: the page runs `evalbar report` in a browser (B18).
 */
import type { Agreement } from './stats.ts'

export type CalibrationRecord = {
  evalbar: string
  madeAt: string
  judge: { requested: string; answered: string | null; family: string }
  promptSha256: string
  labels: { file: string; sha256: string; n: number; families: string[] }
  agreement: Agreement
  /** two humans on the same items, where the labels carry both: the ceiling */
  humans: Agreement | null
  negatives: { empty: boolean; dontKnow: boolean; otherQuestion: boolean }
  errors: number
  kappaBar: number
  trusted: boolean
  why: string
  items: { id: string; human: boolean; judge: boolean }[]
}

/** The vendor a model comes from, read from its name: enough to see a judge grading its own family. */
export function family(model: string | null | undefined): string {
  const m = (model ?? '').toLowerCase()
  if (/(^|[/:])(gpt|chatgpt|o[134](-|$)|text-davinci)/.test(m)) return 'openai'
  if (/claude/.test(m)) return 'anthropic'
  if (/gemini|gemma/.test(m)) return 'google'
  if (/llama/.test(m)) return 'meta'
  if (/mistral|mixtral|ministral|codestral/.test(m)) return 'mistral'
  if (/qwen|qwq/.test(m)) return 'qwen'
  if (/deepseek/.test(m)) return 'deepseek'
  if (/\bphi/.test(m)) return 'microsoft'
  return 'unknown'
}

/**
 * Does a record let a run count this judge's verdicts? The record's own
 * verdict, and then whether it is the record of this judge, this prompt and,
 * where the judge shares the candidate's family, this family.
 */
export function trusts(record: CalibrationRecord | null, run: { promptSha256: string; judgeAnswered: string | null; candidate: string | null; kappaBar: number }): { trusted: boolean; why: string } {
  if (!record) return { trusted: false, why: 'no calibration record was given (evalbar calibrate makes one)' }
  if (record.promptSha256 !== run.promptSha256) return { trusted: false, why: 'the calibration was made with another prompt or rubric' }
  if (run.judgeAnswered && record.judge.answered && record.judge.answered !== run.judgeAnswered)
    return { trusted: false, why: `the calibration measured ${record.judge.answered}, and ${run.judgeAnswered} judged this run` }
  if (!record.trusted) return { trusted: false, why: `the calibration did not trust it: ${record.why}` }
  if (record.agreement.kappaLo < run.kappaBar) return { trusted: false, why: `kappa's low end ${record.agreement.kappaLo.toFixed(3)} is under this run's bar of ${run.kappaBar}` }
  const judgeFamily = family(run.judgeAnswered ?? record.judge.answered)
  const candidateFamily = family(run.candidate)
  if (judgeFamily !== 'unknown' && judgeFamily === candidateFamily && !record.labels.families.includes(candidateFamily))
    return { trusted: false, why: `the judge and the candidate are both ${judgeFamily}, and the calibration was not made on ${judgeFamily} outputs (a judge favours its own family)` }
  return { trusted: true, why: record.why }
}
