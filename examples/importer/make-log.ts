/**
 * A production log with known contents, so the importer can be measured
 * rather than trusted.
 *
 *   node examples/importer/make-log.ts      writes examples/importer/log.jsonl and examples/importer/truth.jsonl
 *
 * The requests are logs-to-evals's synthetic support log, its generator
 * vendored unchanged (1,500 requests, its planted emails, phones, cards and
 * names, its Greek, its unhappy-user signal). Around them, with seed
 * 20261117: the times of 60 days, users who write one to four messages a
 * session, two channels, and what a real log also holds and a test set must
 * not: 100 lines too short to test, 60 pastes, 120 lines that lean on the
 * conversation, and Greek identifiers (AFM, AMKA, IBAN, phones, identity
 * cards, names after an introduction) with valid check digits, made here.
 *
 * The importer reads log.jsonl only. truth.jsonl, one line a row, is what the
 * measurement compares with: what each row is, and every identifier planted in
 * it.
 */
import { writeFileSync } from 'node:fs'
import { genLog } from './vendor/logs-to-evals/gen-log.ts'

const SEED = 20261117
function mulberry32(a: number) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const r = mulberry32(SEED)
const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]
const digits = (n: number) => Array.from({ length: n }, () => Math.floor(r() * 10)).join('')

function afm(): string {
  for (;;) {
    const d = digits(8)
    let c = 0
    for (const x of d) c = c * 2 + Number(x)
    const v = d + (((c * 2) % 11) % 10)
    if (!/^0+$/.test(v)) return v
  }
}
function amka(): string {
  const day = String(1 + Math.floor(r() * 28)).padStart(2, '0')
  const month = String(1 + Math.floor(r() * 12)).padStart(2, '0')
  const body = `${day}${month}${String(Math.floor(r() * 100)).padStart(2, '0')}${digits(4)}`
  for (let check = 0; check < 10; check++) {
    const d = body + check
    let sum = 0
    for (let i = 0; i < d.length; i++) {
      let x = Number(d[d.length - 1 - i])
      if (i % 2 === 1) {
        x *= 2
        if (x > 9) x -= 9
      }
      sum += x
    }
    if (sum % 10 === 0) return d
  }
  throw new Error('unreachable')
}
function iban(): string {
  const bban = digits(23)
  const moved = `${bban}162700` // G=16, R=27, then 00 for the check digits
  let rest = 0
  for (const ch of moved) rest = (rest * 10 + Number(ch)) % 97
  const check = String(98 - rest).padStart(2, '0')
  const flat = `GR${check}${bban}`
  return flat.replace(/(.{4})/g, '$1 ').trim()
}
const GREEK_NAMES = ['Μαρία Παπαδοπούλου', 'Γιώργος Νικολάου', 'Ελένη Κωνσταντίνου', 'Δημήτρης Αλεξίου', 'Κατερίνα Βλάχου', 'Νίκος Σταθόπουλος']

type Planted = { kind: string; value: string }
type Truth = { row: number; what: 'request' | 'short' | 'pasted' | 'context'; planted: Planted[] }

const base = genLog(SEED, 1500)
const rows: { text: string; signal: boolean; what: Truth['what']; planted: Planted[] }[] = base.map((b) => ({
  text: b.text,
  signal: b.signal,
  what: 'request',
  planted: b.pii.map((p) => ({ kind: p.kind, value: p.value })),
}))

// Greek identifiers, on requests that are written in Greek or about orders, money and accounts
const greek: [string, () => Planted & { line: string }][] = [
  ['afm', () => ((v) => ({ kind: 'afm', value: v, line: `Ο ΑΦΜ μου είναι ${v} για το τιμολόγιο.` }))(afm())],
  ['amka', () => ((v) => ({ kind: 'amka', value: v, line: `ΑΜΚΑ ${v}, αν το χρειάζεστε.` }))(amka())],
  ['iban', () => ((v) => ({ kind: 'iban', value: v, line: `Επιστροφή στον λογαριασμό ${v} παρακαλώ.` }))(iban())],
  ['gr-phone', () => ((v) => ({ kind: 'gr-phone', value: v, line: `Καλέστε με στο ${v}.` }))(`+30 69${digits(8)}`)],
  ['id-card', () => ((v) => ({ kind: 'id-card', value: v, line: `ΑΔΤ ${v} στο όνομά μου.` }))(`${pick(['ΑΚ', 'ΑΒ', 'ΑΗ', 'ΑΖ'])} ${digits(6)}`)],
  ['gr-name', () => ((v) => ({ kind: 'gr-name', value: v, line: `Με λένε ${v}.` }))(pick(GREEK_NAMES))],
]
for (let i = 0; i < 180; i++) {
  const target = rows[Math.floor(r() * rows.length)]
  if (target.what !== 'request' || target.planted.length) continue
  const [, make] = greek[i % greek.length]
  const p = make()
  target.text = `${target.text} ${p.line}`
  target.planted.push({ kind: p.kind, value: p.value })
}

const SHORT = ['ok', 'thanks!', 'hello?', 'yes', 'no thanks', 'ευχαριστώ', 'ναι', 'οκ', 'γεια σας', '??']
const CONTEXT = ['and this one?', 'do the same for it', 'what about that order', 'same again please', 'it still does not work', 'and the other one?', 'και αυτό;', 'το ίδιο για την άλλη παραγγελία', 'όπως πριν', 'πάλι δεν δουλεύει αυτό']
const PASTED = [
  () => `Traceback (most recent call last):\n  File "shop.py", line ${10 + Math.floor(r() * 90)}, in checkout\n    total = cart.total()\nAttributeError: 'NoneType' object has no attribute 'total'`,
  () => '```\n' + `{"order": ${1000 + Math.floor(r() * 4000)}, "status": "error", "code": ${Math.floor(r() * 600)}}\n` + '```',
  () => Array.from({ length: 16 }, (_, i) => `line ${i + 1}: item ${Math.floor(r() * 30)} qty ${Math.floor(r() * 5)}`).join('\n'),
  () => `Error: request failed\n    at fetchOrder (app.js:${Math.floor(r() * 400)}:12)\n    at process (app.js:88:3)`,
]
const insert = (what: Truth['what'], text: string) => rows.splice(Math.floor(r() * (rows.length + 1)), 0, { text, signal: false, what, planted: [] })
for (let i = 0; i < 100; i++) insert('short', pick(SHORT))
for (let i = 0; i < 60; i++) insert('pasted', pick(PASTED)())
for (let i = 0; i < 120; i++) insert('context', pick(CONTEXT))

// users, sessions, channels and times: 60 days in order, a session one to four rows from one user
const start = Date.UTC(2026, 8, 1)
const day = 86_400_000
let session = 0
let left = 0
let user = ''
let channel = ''
const log: object[] = []
const truth: Truth[] = []
rows.forEach((row, i) => {
  if (left === 0) {
    session++
    left = 1 + Math.floor(r() * 4)
    user = `u${1 + Math.floor(r() * 400)}`
    channel = r() < 0.7 ? 'web' : 'app'
  }
  left--
  const time = new Date(start + Math.floor((i / rows.length) * 60 * day) + Math.floor(r() * 3_600_000)).toISOString()
  log.push({ id: i + 1, time, session: `s${session}`, user, channel, input: row.text, thumbs_down: row.signal || undefined })
  truth.push({ row: i + 1, what: row.what, planted: row.planted })
})
writeFileSync(new URL('log.jsonl', import.meta.url), `${log.map((l) => JSON.stringify(l)).join('\n')}\n`)
writeFileSync(new URL('truth.jsonl', import.meta.url), `${truth.map((t) => JSON.stringify(t)).join('\n')}\n`)
const count = (w: Truth['what']) => truth.filter((t) => t.what === w).length
console.log(`log.jsonl: ${log.length} rows in ${session} sessions: ${count('request')} requests, ${count('short')} short, ${count('pasted')} pasted, ${count('context')} leaning on context; ${truth.reduce((s, t) => s + t.planted.length, 0)} identifiers planted`)
