/**
 * Personal data out of a log line before it can become a case.
 *
 * logs-to-evals's scrubber, vendored unchanged, removes what has a shape in an
 * English support log: emails, card numbers, phones, order numbers, and a name
 * after "my name is". A Greek log holds more, and ai-knowledge
 * 08-security-and-privacy/05 gives the algorithms; each identifier here is a
 * pattern and a check, because nine digits alone are an order number as often
 * as a tax number:
 *
 * - AFM, the tax number: nine digits, the mod 11 check digit, not all zeros,
 *   and a context word near it (ΑΦΜ, ΔΟΥ, VAT, ΦΠΑ).
 * - AMKA, the social insurance number: eleven digits, a Luhn check digit, and
 *   a first six that is a real date.
 * - A Greek IBAN: GR and 25 more, ISO 7064 mod 97.
 * - A Greek phone: +30 or 0030 and ten digits, or a mobile 69 and eight more.
 * - An identity card number after its context word (ΑΔΤ, ταυτότητα).
 * - A name after a Greek introduction (με λένε, ονομάζομαι, λέγομαι).
 *
 * These run first, so the generic card rule cannot eat an IBAN's digits. NFC
 * runs before everything: a rule over characters applied before normalisation
 * is the defect tick 3 found in the exact grader.
 */
import { scrub as vendoredScrub } from '../vendor/logs-to-evals/scrub.ts'

export type Removed = Record<string, number>

const NOT_DIGIT_BEFORE = '(?<![0-9])'
const NOT_DIGIT_AFTER = '(?![0-9])'

export function afmValid(d: string): boolean {
  if (!/^[0-9]{9}$/.test(d) || /^0+$/.test(d)) return false
  let c = 0
  for (let i = 0; i < 8; i++) c = c * 2 + Number(d[i])
  return ((c * 2) % 11) % 10 === Number(d[8])
}

export function luhnValid(d: string): boolean {
  let sum = 0
  for (let i = 0; i < d.length; i++) {
    let x = Number(d[d.length - 1 - i])
    if (i % 2 === 1) {
      x *= 2
      if (x > 9) x -= 9
    }
    sum += x
  }
  return sum % 10 === 0
}

/** The first six digits as DDMMYY must be a date in one of the two centuries a living person was born in. */
export function amkaValid(d: string): boolean {
  if (!/^[0-9]{11}$/.test(d) || !luhnValid(d)) return false
  const day = Number(d.slice(0, 2))
  const month = Number(d.slice(2, 4))
  const yy = Number(d.slice(4, 6))
  return [1900, 2000].some((c) => {
    const date = new Date(Date.UTC(c + yy, month - 1, day))
    return date.getUTCDate() === day && date.getUTCMonth() === month - 1
  })
}

export function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, '').toUpperCase()
  if (!/^GR[0-9]{2}[0-9A-Z]{23}$/.test(s)) return false
  const moved = s.slice(4) + s.slice(0, 4)
  let rest = 0
  for (const ch of moved) {
    const v = /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55)
    for (const digit of v) rest = (rest * 10 + Number(digit)) % 97
  }
  return rest === 1
}

type Rule = { tag: string; re: RegExp; valid?: (match: RegExpExecArray) => boolean; group?: number }

const RULES: Rule[] = [
  { tag: '<IBAN>', re: /GR[0-9]{2}(?:\s?[0-9A-Z]{4}){5}\s?[0-9A-Z]{3}/gi, valid: (m) => ibanValid(m[0]) },
  { tag: '<AMKA>', re: new RegExp(`${NOT_DIGIT_BEFORE}[0-9]{11}${NOT_DIGIT_AFTER}`, 'g'), valid: (m) => amkaValid(m[0]) },
  {
    tag: '<AFM>',
    re: new RegExp(`(ΑΦΜ|Α\\.Φ\\.Μ\\.|ΔΟΥ|Δ\\.Ο\\.Υ\\.|ΦΠΑ|VAT|AFM)[^0-9]{0,20}${NOT_DIGIT_BEFORE}([0-9]{9})${NOT_DIGIT_AFTER}`, 'giu'),
    valid: (m) => afmValid(m[2]),
    group: 2,
  },
  { tag: '<PHONE>', re: /(?:\+30|0030)[\s.-]?(?:[0-9][\s.]?){10}(?![0-9])/g },
  { tag: '<PHONE>', re: new RegExp(`${NOT_DIGIT_BEFORE}69[0-9](?:[\\s.]?[0-9]){7}${NOT_DIGIT_AFTER}`, 'g') },
  { tag: '<ID>', re: /(ΑΔΤ|Α\.Δ\.Τ\.|ταυτότητα[ςσ]?)[^0-9]{0,15}?([Α-ΩA-Z]{1,2}\s?[0-9]{6})(?![0-9])/giu, group: 2 },
  // the phrase in either case, since a message often opens with it; a first name in any case, a surname only
  // when capitalised. Not the i flag: under it \p{Lu} matches lower case too, and "νίκος και" lost its "και"
  { tag: '<NAME>', re: /([Μμ]ε λένε|[Οο]νομάζομαι|[Λλ]έγομαι)\s+(\p{L}+(?:\s+\p{Lu}\p{L}+)?)/gu, group: 2 },
]

export function scrubLine(text: string, o: { names?: 'capitalised' | 'off' } = {}): { text: string; removed: Removed } {
  const removed: Removed = {}
  let t = text.normalize('NFC')
  for (const rule of RULES) {
    t = t.replace(rule.re, (...args) => {
      const m = Object.assign([...args.slice(0, -2)] as string[], { index: args.at(-2) as number, input: t }) as unknown as RegExpExecArray
      if (rule.valid && !rule.valid(m)) return m[0]
      removed[rule.tag] = (removed[rule.tag] ?? 0) + 1
      if (rule.group === undefined) return rule.tag
      return m[0].replace(m[rule.group], rule.tag)
    })
  }
  // then logs-to-evals's own rules, counted by the tags they leave
  const before = countTags(t)
  t = vendoredScrub(t)
  const after = countTags(t)
  for (const [tag, n] of Object.entries(after)) if (n > (before[tag] ?? 0)) removed[tag] = (removed[tag] ?? 0) + n - (before[tag] ?? 0)
  // last, a name recogniser of the crudest kind: two or three capitalised words in a row. The rules above
  // catch a name only after "my name is", and 45 of 64 planted names survived them (tick 10); the knowledge
  // base's position is that a pattern stack without a name recogniser leaks names first (08/01 section 3).
  // It errs towards scrubbing: "Blue Kettle" goes too, and the measurement counts how often that happens.
  if (o.names !== 'off')
    t = t.replace(NAME_PAIR, () => {
    removed['<NAME>'] = (removed['<NAME>'] ?? 0) + 1
    return '<NAME>'
  })
  return { text: t, removed }
}

const NAME_PAIR = /\p{Lu}\p{Ll}+(?:[ \t]+\p{Lu}\p{Ll}+){1,2}/gu

function countTags(t: string): Removed {
  const out: Removed = {}
  for (const m of t.matchAll(/<[A-Z]+>/g)) out[m[0]] = (out[m[0]] ?? 0) + 1
  return out
}
