/**
 * A suite is a JSONL file, one case a line:
 *
 *   {"id": "q1", "input": "Ποια είναι η πρωτεύουσα της Ελλάδας;", "expected": "Αθήνα", "tags": ["el"]}
 *
 * `input` is the text sent, or a list of chat messages. `expected` is whatever
 * the grader reads: a reference answer for `exact`, anything at all for a
 * program grader. `tags` group the report. `id` is the line number when absent.
 * `cluster` names the session, user, document or template a case shares with
 * others: cases in one cluster are counted as the information they carry, not
 * as so many independent cases (decision B9).
 * Fields beyond these are kept and handed to the grader.
 *
 * Every problem in the file is reported before anything runs, because a run
 * that stops at case 212 of 400 on a typo has spent money finding it.
 */
import { parseJsonl, readText, ReadError } from './read.ts'

export type Message = { role: 'system' | 'user' | 'assistant'; content: string }
export type Case = {
  id: string
  input: string | Message[]
  expected?: unknown
  tags: string[]
  /** what the case shares with others, if anything: a session, a user, a source document, a template */
  cluster: string | null
  /** the line it came from, for every message about it */
  line: number
  /** fields the file carries beyond the five above, for program graders */
  extra: Record<string, unknown>
}

const KNOWN = new Set(['id', 'input', 'expected', 'tags', 'cluster'])
const ROLES = new Set(['system', 'user', 'assistant'])

export function toCases(lines: { line: number; value: unknown }[], path: string): Case[] {
  const problems: string[] = []
  const cases: Case[] = []
  const seen = new Map<string, number>()
  for (const { line, value } of lines) {
    const at = `${path}: line ${line}`
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      problems.push(`${at} is not an object`)
      continue
    }
    const v = value as Record<string, unknown>
    let input: string | Message[] | null = null
    if (typeof v.input === 'string' && v.input.trim()) input = v.input
    else if (Array.isArray(v.input) && v.input.length) {
      const ok = v.input.every((m) => m && typeof m === 'object' && ROLES.has((m as Message).role) && typeof (m as Message).content === 'string')
      if (ok && v.input.some((m) => (m as Message).role === 'user')) input = v.input as Message[]
    }
    if (input === null) {
      const fields = Object.keys(v).join(', ') || 'none'
      problems.push(`${at} has no input: a non-empty string, or messages with a user turn (fields found: ${fields})`)
      continue
    }
    if (v.tags !== undefined && !(Array.isArray(v.tags) && v.tags.every((t) => typeof t === 'string'))) {
      problems.push(`${at}: tags must be a list of strings`)
      continue
    }
    if (v.id !== undefined && typeof v.id !== 'string' && typeof v.id !== 'number') {
      problems.push(`${at}: id must be a string or a number`)
      continue
    }
    if (v.cluster !== undefined && v.cluster !== null && typeof v.cluster !== 'string' && typeof v.cluster !== 'number') {
      problems.push(`${at}: cluster must be a string or a number`)
      continue
    }
    const id = v.id === undefined ? `line-${line}` : String(v.id)
    if (seen.has(id)) {
      problems.push(`${at} repeats the id "${id}" of line ${seen.get(id)}`)
      continue
    }
    seen.set(id, line)
    const extra: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) if (!KNOWN.has(k)) extra[k] = x
    const cluster = v.cluster === undefined || v.cluster === null ? null : String(v.cluster)
    cases.push({ id, input, expected: v.expected, tags: (v.tags as string[] | undefined) ?? [], cluster, line, extra })
  }
  if (problems.length) throw new ReadError(problems.slice(0, 8).join('\n') + (problems.length > 8 ? `\n...and ${problems.length - 8} more` : ''))
  if (!cases.length) throw new ReadError(`${path}: no cases`)
  return cases
}

export function loadCases(path: string, encoding?: string): Case[] {
  return toCases(parseJsonl(readText(path, encoding), path), path)
}

/** The text a grader or a report shows for an input: the last user turn of a conversation. */
export function inputText(input: Case['input']): string {
  if (typeof input === 'string') return input
  return [...input].reverse().find((m) => m.role === 'user')?.content ?? ''
}
