/**
 * What every provider returns, and the one error type that is not a grade.
 *
 * The line between the two is the line 07-evaluation/01 section 6 calls the
 * central failure of a harness: an infrastructure fault scored as a model
 * fault. A timeout, a 429 that outlasted its retries or a crashed process is
 * a ProviderError, goes to errors.jsonl, and is never in the pass rate. An
 * empty answer the model really gave is a Reply, and is graded.
 */
import type { Case } from '../cases.ts'

/** Tokens as the response's own usage block counts them, never estimated from the text. */
export type Usage = { input: number; output: number; cachedInput: number }

export type Reply = {
  text: string
  usage: Usage | null
  /** the model the response names, which is not always the one asked for */
  model: string | null
  /** why generation stopped; "length" means the answer was cut off */
  finish: string | null
  latencyMs: number
  attempts: number
}

export type ErrorKind = 'timeout' | 'http' | 'network' | 'auth' | 'protocol' | 'process' | 'grader'

export class ProviderError extends Error {
  readonly kind: ErrorKind
  readonly status: number | null
  readonly attempts: number
  /** stop the whole run: every case would fail the same way */
  readonly fatal: boolean
  constructor(kind: ErrorKind, message: string, opts: { status?: number | null; attempts?: number; fatal?: boolean } = {}) {
    super(message)
    this.kind = kind
    this.status = opts.status ?? null
    this.attempts = opts.attempts ?? 1
    this.fatal = opts.fatal ?? false
  }
}

/** A system under test: one case's input in, one reply out. It is given the id and the input, never the expected answer. */
export type Provider = {
  describe: string
  call: (id: string, input: Case['input']) => Promise<Reply>
  close: () => Promise<void>
}
