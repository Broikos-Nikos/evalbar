/**
 * The runner: every case through the provider and the grader, one row on disk
 * the moment each finishes.
 *
 * The layout is 07-evaluation/01 section 7's: `results.jsonl` holds one row a
 * case, appended as it completes, so a crash keeps finished work and a rerun
 * resumes at the first case without a row; `errors.jsonl` holds what went
 * wrong outside the model, with its kind, and is never read as a grade;
 * `run.json` says what was run. The report recomputes everything from the rows.
 *
 * The first case runs alone. If it fails in a way every case would (a missing
 * key, a wrong URL, a command that will not start), the run stops there rather
 * than buying the same error four hundred times.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inputText, type Case } from './cases.ts'
import { UserError } from './errors.ts'
import type { Grade } from './graders/exact.ts'
import { ProviderError, type ErrorKind, type Provider, type Usage } from './providers/types.ts'

export type Grader = { name: string; grade: (c: Case, output: string) => Promise<Grade> | Grade }

/** Per million tokens, in dollars, as the user states them. */
export type Prices = { input: number; output: number; cachedInput?: number }

export type Row = {
  id: string
  tags: string[]
  input: string
  output: string
  /** graded, or cut off by the token limit and therefore not graded */
  status: 'graded' | 'truncated'
  pass: boolean | null
  reason: string
  model: string | null
  usage: Usage | null
  /** what grading cost, when the grader is a model: a judge's own usage */
  graderUsage: Usage | null
  finish: string | null
  latencyMs: number
  attempts: number
  at: string
}

export type ErrorRow = { id: string; tags: string[]; kind: ErrorKind; message: string; status: number | null; attempts: number; at: string }

export type RunConfig = {
  evalbar: string
  suite: string
  suiteSha256: string
  cases: number
  provider: string
  requestedModel: string | null
  grader: string
  bar: number | null
  /** as requested; null when left to the endpoint, whose default is usually 1 */
  temperature: number | null
  seed: number | null
  prices: Prices | null
  graderPrices: Prices | null
  startedAt: string
}

export type RunOutcome = { results: Row[]; errors: ErrorRow[]; skipped: number; aborted: string | null }

export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

export function readRows<T>(path: string): T[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T)
}

/** The grader's own usage, when it reports one: a judge does, an exact match does not. */
export type GradeWithUsage = Grade & { usage?: Usage | null }

export async function runSuite(o: {
  cases: Case[]
  provider: Provider
  grader: Grader
  outDir: string
  concurrency: number
  config: RunConfig
  onRow?: (done: number, total: number) => void
}): Promise<RunOutcome> {
  mkdirSync(o.outDir, { recursive: true })
  const runPath = join(o.outDir, 'run.json')
  const resultsPath = join(o.outDir, 'results.jsonl')
  const errorsPath = join(o.outDir, 'errors.jsonl')

  if (existsSync(runPath)) {
    const before = JSON.parse(readFileSync(runPath, 'utf8')) as RunConfig
    const changed = (['suiteSha256', 'provider', 'grader'] as const).filter((k) => before[k] !== o.config[k])
    if (changed.length) throw new UserError(`${o.outDir} holds a run of another ${changed.join(', ')}: resume it with the same settings, or use another --out`)
  } else writeFileSync(runPath, `${JSON.stringify(o.config, null, 2)}\n`)

  const done = new Set(readRows<Row>(resultsPath).map((r) => r.id))
  const pending = o.cases.filter((c) => !done.has(c.id))
  const skipped = o.cases.length - pending.length
  const results: Row[] = []
  const errors: ErrorRow[] = []
  let aborted: string | null = null
  let finished = 0

  async function one(c: Case): Promise<void> {
    const at = () => new Date().toISOString()
    const fail = (e: ProviderError) => {
      const row: ErrorRow = { id: c.id, tags: c.tags, kind: e.kind, message: e.message, status: e.status, attempts: e.attempts, at: at() }
      appendFileSync(errorsPath, `${JSON.stringify(row)}\n`)
      errors.push(row)
      if (e.fatal && !aborted) aborted = `${c.id}: ${e.message}`
    }
    let reply
    try {
      reply = await o.provider.call(c.id, c.input)
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e
      fail(e)
      return
    }
    const truncated = reply.finish === 'length'
    let grade: GradeWithUsage = { pass: false, reason: 'not graded: the answer was cut off by the token limit' }
    if (!truncated) {
      try {
        grade = await o.grader.grade(c, reply.text)
      } catch (e) {
        if (e instanceof ProviderError) {
          fail(new ProviderError('grader', `the grader failed: ${e.message}`, { status: e.status, attempts: e.attempts, fatal: e.fatal }))
          return
        }
        fail(new ProviderError('grader', `the grader threw: ${(e as Error).message}`))
        return
      }
    }
    const row: Row = {
      id: c.id,
      tags: c.tags,
      input: inputText(c.input),
      output: reply.text,
      status: truncated ? 'truncated' : 'graded',
      pass: truncated ? null : grade.pass,
      reason: grade.reason,
      model: reply.model,
      usage: reply.usage,
      graderUsage: grade.usage ?? null,
      finish: reply.finish,
      latencyMs: Math.round(reply.latencyMs),
      attempts: reply.attempts,
      at: at(),
    }
    appendFileSync(resultsPath, `${JSON.stringify(row)}\n`)
    results.push(row)
  }

  const queue = [...pending]
  const tick = () => o.onRow?.(skipped + ++finished, o.cases.length)
  // the canary: alone, so a fault every case shares costs one call
  const first = queue.shift()
  if (first) {
    await one(first)
    tick()
    // a first case that cannot reach the system at all (connection refused, a command that dies before
    // answering, an answer in the wrong format) is a fault every case shares: stop on it, not 400 times later
    const e = errors.find((x) => x.id === first.id)
    if (e && !aborted && (e.kind === 'network' || e.kind === 'process' || e.kind === 'protocol')) aborted = `the first case: ${e.message}`
  }
  const worker = async () => {
    while (!aborted) {
      const c = queue.shift()
      if (!c) return
      await one(c)
      tick()
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, worker))
  return { results, errors, skipped, aborted }
}
