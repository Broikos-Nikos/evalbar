/**
 * Comparing text the way a reader would, in Greek as much as in English.
 *
 * Most graders compare with `a.toLowerCase() === b.toLowerCase()` and call it
 * case insensitive. In Greek that is wrong in four ways, each with a test in
 * test/greek.test.ts and a control that puts the naive version back:
 *
 * 1. **Capitals drop the accent.** Greek written in capitals carries no tonos,
 *    by rule: Αθήνα is ΑΘΗΝΑ. Lowercasing gives αθηνα against αθήνα, and a
 *    correct answer fails. French in capitals often drops its accents too.
 * 2. **But accents are not decoration.** πότε is "when" and ποτέ is "never".
 *    A grader that strips every accent to get round (1) passes a wrong answer.
 *    So accents are ignored only in a word written in capitals, where they
 *    could not have been written, and counted everywhere else.
 * 3. **Two sigmas.** σ inside a word, ς at its end, one letter. Unicode case
 *    folding maps both to σ; `toLowerCase` keeps them apart.
 * 4. **Two encodings of one letter.** ή is one code point, or η followed by a
 *    combining accent, and text pasted from a Mac or a PDF is often the second.
 *    NFC first, always.
 *
 * And one that is not Greek's fault: JavaScript's `\b` and `\w` are ASCII, so
 * `/\bναι\b/` matches nothing in "ναι" at all. `wordPattern` is the boundary a
 * program grader should use.
 *
 * Folding uses `toLowerCase`, never `toLocaleLowerCase`: on a machine set to
 * Turkish the second turns I into a dotless ı, and a grade would depend on the
 * computer it ran on.
 */

const MARKS = /\p{M}+/gu
const WORD = /[\p{L}\p{M}\p{N}]+/gu

/** Canonical composition: the same letter is the same code points. Also turns the Greek question mark into ';' and the ano teleia into a middle dot, as Unicode defines them. */
export const nfc = (s: string) => s.normalize('NFC')

/** Accents and every other combining mark removed, letters kept. */
export const stripMarks = (s: string) => s.normalize('NFD').replace(MARKS, '').normalize('NFC')

/**
 * Lower case as Unicode's case folding would compare it, for the letters where
 * JavaScript's lower case falls short: the final sigma, and the German sharp s,
 * which folds to "ss" so that STRASSE and Straße are one word.
 */
export function fold(s: string): string {
  return nfc(s).toLowerCase().replace(/ς/g, 'σ').replace(/ß/g, 'ss')
}

/** A word with at least one letter that has case, and no lower case letter: written in capitals. */
export function inCapitals(word: string): boolean {
  return /\p{Lu}/u.test(word) && !/\p{Ll}/u.test(word)
}

/** Words and what lies between them, so two texts can be compared word by word. */
function pieces(s: string): string[] {
  const out: string[] = []
  let last = 0
  for (const m of s.matchAll(WORD)) {
    out.push(s.slice(last, m.index), m[0])
    last = m.index + m[0].length
  }
  out.push(s.slice(last))
  return out
}

/**
 * Two texts are the same answer when, word by word, they fold to the same
 * letters, a word in capitals on either side being compared without accents.
 * Whitespace runs count as one space and the ends are trimmed.
 */
export function sameText(a: string, b: string): boolean {
  const pa = pieces(squash(nfc(a)))
  const pb = pieces(squash(nfc(b)))
  if (pa.length !== pb.length) return false
  for (let i = 0; i < pa.length; i++) {
    const x = fold(pa[i])
    const y = fold(pb[i])
    if (x === y) continue
    // odd pieces are words: a word in capitals could not carry its accents
    if (i % 2 === 1 && (inCapitals(pa[i]) || inCapitals(pb[i])) && stripMarks(x) === stripMarks(y)) continue
    return false
  }
  return true
}

/** Every run of whitespace, Unicode's included, as one space; the ends trimmed. */
export function squash(s: string): string {
  return s.replace(/\s+/gu, ' ').trim()
}

/** The pattern a program grader should use for "contains the word": a boundary that knows Greek letters are letters. */
export function wordPattern(word: string, flags = 'u'): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escaped}(?![\\p{L}\\p{M}\\p{N}_])`, flags.includes('u') ? flags : flags + 'u')
}

/** Does the text contain the word, folded on both sides, so ΝΑΙ and Ναι and ναι all count? */
export function containsWord(text: string, word: string): boolean {
  return wordPattern(fold(word)).test(fold(text))
}

/**
 * Cut to at most `max` characters a reader would count, never inside a letter
 * and its accent. `slice` counts UTF-16 units, so it can split an accent from
 * its letter in decomposed text, or a character outside the BMP in half.
 */
export function clip(s: string, max: number): string {
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  let out = ''
  let count = 0
  for (const { segment } of seg.segment(s)) {
    if (count === max) return out + '...'
    out += segment
    count++
  }
  return out
}
