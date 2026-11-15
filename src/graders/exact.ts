/**
 * The exact grader: the output is the expected answer, or one of several.
 *
 * Exact, not rigid. 07-evaluation/01 section 6 lists the ways an exact check
 * fails a right answer (whitespace, case, 4 against 4.0, a markdown fence) and
 * the way it is made too lenient (a wrong answer that passes). What it forgives,
 * all of it:
 *
 * - a markdown fence around the whole answer, and quotes around it, Greek
 *   guillemets included;
 * - whitespace, and one full stop, exclamation mark, colon, comma or semicolon
 *   at the end (so "Αθήνα." is Αθήνα, and so is "Αθήνα;", which in Greek is a
 *   question: the price of the rule, said here);
 * - case, by Unicode folding: the final sigma, the sharp s;
 * - accents in a word written in capitals, and only there (src/text.ts);
 * - two numbers written plainly that are equal, so 4 is 4.0. Not 3,14 against
 *   3.14: in Greek the comma is the decimal point and in English it groups
 *   thousands, and a grader that guessed would be right half the time.
 *
 * Nothing else. Anything a domain needs beyond that belongs in a program grader.
 */
import { clip, nfc, sameText, squash } from '../text.ts'

export type Grade = { pass: boolean; reason: string }

const FENCE = /^```[^\n]*\n([\s\S]*?)\n?```$/
const QUOTES: [string, string][] = [['"', '"'], ["'", "'"], ['`', '`'], ['«', '»'], ['“', '”'], ['‘', '’']]
const PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/

export function unwrap(s: string): string {
  // NFC first, or a Greek question mark survives the closing-mark rule that strips its ASCII twin (tick 3);
  // then the fence, before the whitespace: squashing turns a fence's newlines into spaces and it no longer matches
  const text = nfc(s)
  const fence = text.trim().match(FENCE)
  let t = squash(fence ? fence[1] : text)
  for (const [open, close] of QUOTES) {
    if (t.length >= 2 && t.startsWith(open) && t.endsWith(close)) {
      t = squash(t.slice(open.length, -close.length))
      break
    }
  }
  if (t.length > 1 && /[.!:,;]$/.test(t)) t = t.slice(0, -1).trimEnd()
  return t
}

function same(output: string, expected: string): boolean {
  const a = unwrap(output)
  const b = unwrap(expected)
  if (PLAIN_NUMBER.test(a) && PLAIN_NUMBER.test(b)) return Number(a) === Number(b)
  return sameText(a, b)
}

export function gradeExact(output: string, expected: unknown): Grade {
  const wanted = (Array.isArray(expected) ? expected : [expected]).filter((x) => typeof x === 'string' || typeof x === 'number').map(String)
  if (!wanted.length) return { pass: false, reason: 'the case has no expected answer to compare with' }
  if (wanted.some((w) => same(output, w))) return { pass: true, reason: 'matches' }
  return { pass: false, reason: `"${clip(squash(output), 80)}" is not ${wanted.map((w) => `"${clip(w, 40)}"`).join(' or ')}` }
}
