/**
 * A suite built from production logs.
 *
 * Most of what a log holds is not a test. On the owner's own prompts, 29 of
 * 400 asked for something a test could check, 74 more leaned on context the
 * line did not carry, and the rest were instructions, pastes and repeats
 * (ai-knowledge 03-retrieval-rag/07 section 5). So the output of an import is
 * its funnel as much as its cases: every row in, each reason a row was left
 * out with its count, and what was kept.
 *
 * In order:
 *
 * 1. **Read** a row's request, its logged answer, its time, its source, its
 *    cluster (session or user, else the source) and its signal (a thumbs
 *    down, an escalation), from named fields or from chat messages.
 * 2. **Scrub** personal data (src/importer/scrub.ts), before anything else
 *    reads the text.
 * 3. **Drop** what is not a test: under 12 characters (B16), a pasted block (code,
 *    a stack trace, a wall of lines), a line that leans on a conversation it
 *    does not carry ("and this one?", "και αυτό;").
 * 4. **Deduplicate**, exactly after folding and then by meaning, with
 *    logs-to-evals's hashed n-gram embedder at a similarity of 0.9; the first
 *    by time is kept.
 * 5. **Pick**, if asked, with logs-to-evals's selector, which spends a budget
 *    on clusters of requests by traffic and by unhappy users.
 * 6. **Hold out** by time or by source, a whole cluster on one side, so no
 *    session is split between what is tuned on and what is scored. The held
 *    out file is sealed (src/importer/seal.ts).
 *
 * The logged answer is kept beside each case as `logged_output` and never as
 * `expected`: an answer the system gave is not the answer it should give, and
 * reference matching against it rewards repeating the system
 * (07-evaluation/01 section 6).
 */
import { fold, squash } from '../text.ts'
import { cosine, embed, type Vec } from '../vendor/logs-to-evals/embed.ts'
import { select } from '../vendor-derived/logs-to-evals/select.ts'
import { scrubLine, type Removed } from './scrub.ts'

export type ImportOptions = {
  inputField?: string
  outputField?: string
  timeField?: string
  sourceField?: string
  clusterField?: string
  signalField?: string
  idField?: string
  minChars: number
  near: number
  pick?: number
  holdoutAfter?: string
  holdoutSource?: string
}

export type ImportedCase = {
  id: string
  input: string
  tags: string[]
  cluster: string | null
  logged_output?: string
  time?: string
  source?: string
}

export type Funnel = {
  read: number
  noRequest: number
  short: number
  pasted: number
  needsContext: number
  exactDuplicate: number
  nearDuplicate: number
  kept: number
  picked: number | null
  dev: number
  test: number
  clusters: number
  removed: Removed
}

const FIELDS = {
  input: ['input', 'prompt', 'question', 'query', 'request', 'text', 'message', 'user'],
  output: ['output', 'response', 'answer', 'completion', 'assistant', 'reply'],
  time: ['time', 'timestamp', 'ts', 'created_at', 'date'],
  source: ['source', 'channel'],
  cluster: ['cluster', 'session', 'session_id', 'conversation', 'conversation_id', 'thread', 'user', 'user_id'],
  signal: ['signal', 'thumbs_down', 'flagged', 'escalated', 'unhappy'],
  id: ['id', 'request_id'],
}

type Row = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined)
const field = (row: Row, named: string | undefined, guesses: string[]) => (named ? row[named] : guesses.map((g) => row[g]).find((v) => v !== undefined))

/** A request from a row: a named field, a guessed one, or the last user turn of a conversation, with the answer after it. */
function readRow(row: Row, o: ImportOptions): { input?: string; output?: string } {
  const messages = row.messages
  if (!o.inputField && Array.isArray(messages)) {
    const turns = messages as { role?: string; content?: unknown }[]
    const u = turns.map((m) => m.role).lastIndexOf('user')
    if (u < 0) return {}
    const reply = turns.slice(u + 1).find((m) => m.role === 'assistant')
    return { input: str(turns[u].content), output: str(reply?.content) }
  }
  return { input: str(field(row, o.inputField, FIELDS.input)), output: str(field(row, o.outputField, FIELDS.output)) }
}

/** A paste rather than a request: a fence, a stack trace, a wall of lines, or text that is mostly symbols. */
export function looksPasted(t: string): boolean {
  if (t.includes('```')) return true
  if (t.split('\n').length >= 15) return true
  if (/Traceback \(most recent call last\)|^\s+at \S+ \(.*:\d+:\d+\)|^\s+at \S+:\d+:\d+|Exception in thread/m.test(t)) return true
  if (t.length >= 120) {
    const symbols = (t.match(/[{}()[\];=<>"\\]/g) ?? []).length
    if (symbols / t.length > 0.08) return true
  }
  return false
}

const LEANS_EN = /^(?:and |but |also |so |ok |okay )?(?:this|that|these|those|it|them|the same|same|the above|above|again|do it|try again|fix it|what about|how about|now do|one more|another one)\b/i
const LEANS_EL = /^(?:και |αλλά |εντάξει )?(?:αυτό|αυτά|αυτή|αυτός|αυτές|εκείνο|εκείνα|το ίδιο|τα ίδια|ξανά|πάλι|όπως πριν|το παραπάνω|τα παραπάνω|κι άλλο|τι λες για)(?![\p{L}])/iu

/** A short line that opens by pointing at something the line itself does not hold. */
export function leansOnContext(t: string): boolean {
  const words = t.split(/\s+/).filter(Boolean)
  if (words.length > 8) return false
  const n = t.normalize('NFC').trim()
  return LEANS_EN.test(n) || LEANS_EL.test(n)
}

const exactKey = (t: string) => fold(squash(t)).replace(/[\p{P}\p{S}]+/gu, '')

/** What happened to each row, in the log's order: the measurement compares it with what the row was. */
export type Fate = 'no request' | 'short' | 'pasted' | 'needs context' | 'exact duplicate' | 'near duplicate' | 'kept' | 'not picked'

export function importLog(rows: Row[], o: ImportOptions): { dev: ImportedCase[]; test: ImportedCase[]; funnel: Funnel; fates: Fate[] } {
  const fates: Fate[] = rows.map(() => 'kept')
  const f: Funnel = { read: rows.length, noRequest: 0, short: 0, pasted: 0, needsContext: 0, exactDuplicate: 0, nearDuplicate: 0, kept: 0, picked: null, dev: 0, test: 0, clusters: 0, removed: {} }
  type Item = ImportedCase & { order: number; signal: boolean; vec?: Vec }
  const items: Item[] = []
  rows.forEach((row, i) => {
    const { input, output } = readRow(row, o)
    if (!input || !input.trim()) {
      f.noRequest++
      fates[i] = 'no request'
      return
    }
    const clean = scrubLine(input)
    for (const [k, n] of Object.entries(clean.removed)) f.removed[k] = (f.removed[k] ?? 0) + n
    const text = clean.text.trim()
    if ([...text].length < o.minChars) {
      f.short++
      fates[i] = 'short'
      return
    }
    if (looksPasted(text)) {
      f.pasted++
      fates[i] = 'pasted'
      return
    }
    if (leansOnContext(text)) {
      f.needsContext++
      fates[i] = 'needs context'
      return
    }
    const time = str(field(row, o.timeField, FIELDS.time))
    const source = str(field(row, o.sourceField, FIELDS.source))
    const cluster = str(field(row, o.clusterField, FIELDS.cluster)) ?? source ?? null
    const id = str(field(row, o.idField, FIELDS.id)) ?? String(i + 1)
    const loggedOutput = output === undefined ? undefined : scrubLine(output).text
    items.push({ id: `log-${id}`, input: text, tags: source ? [source] : [], cluster, logged_output: loggedOutput, time, source, order: i, signal: Boolean(field(row, o.signalField, FIELDS.signal)) })
  })

  // the first by time is kept; rows without a time keep the log's order
  items.sort((a, b) => (a.time && b.time && a.time !== b.time ? (a.time < b.time ? -1 : 1) : a.order - b.order))
  const seen = new Set<string>()
  const kept: Item[] = []
  for (const it of items) {
    const key = exactKey(it.input)
    if (seen.has(key)) {
      f.exactDuplicate++
      fates[it.order] = 'exact duplicate'
      continue
    }
    seen.add(key)
    it.vec = embed(it.input)
    if (kept.some((k) => cosine(k.vec!, it.vec!) >= o.near)) {
      f.nearDuplicate++
      fates[it.order] = 'near duplicate'
      continue
    }
    kept.push(it)
  }
  f.kept = kept.length

  let chosen = kept
  if (o.pick !== undefined) {
    const { picks } = select(
      kept.map((k, n) => ({ id: n, text: k.input, signal: k.signal })),
      o.pick,
    )
    chosen = picks.map((p) => kept[p.row.id])
    f.picked = chosen.length
    const inPick = new Set(chosen.map((c) => c.order))
    for (const k of kept) if (!inPick.has(k.order)) fates[k.order] = 'not picked'
  }

  // a cluster goes to the side of its first row, so no session is scored on one side and tuned on the other
  const sideOf = new Map<string, 'dev' | 'test'>()
  const side = (it: Item): 'dev' | 'test' => {
    const own: 'dev' | 'test' = o.holdoutSource !== undefined ? (it.source === o.holdoutSource ? 'test' : 'dev') : o.holdoutAfter !== undefined && it.time !== undefined && it.time >= o.holdoutAfter ? 'test' : 'dev'
    if (!it.cluster) return own
    if (!sideOf.has(it.cluster)) sideOf.set(it.cluster, own)
    return sideOf.get(it.cluster)!
  }
  const dev: ImportedCase[] = []
  const test: ImportedCase[] = []
  for (const it of [...chosen].sort((a, b) => (a.time && b.time && a.time !== b.time ? (a.time < b.time ? -1 : 1) : a.order - b.order))) {
    const { order: _o, signal: _s, vec: _v, ...out } = it
    ;(side(it) === 'test' ? test : dev).push(out)
  }
  f.dev = dev.length
  f.test = test.length
  f.clusters = new Set(chosen.map((c) => c.cluster ?? c.id)).size
  return { dev, test, funnel: f, fates }
}
