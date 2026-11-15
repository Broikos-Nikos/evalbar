/**
 * The nine Greek pairs an exact grader must get right, and the two other ways
 * of grading them that `measurements/greek.json` counts. Shared by the
 * measurement and the page, so the page shows the pairs that were measured.
 */
import { fold, stripMarks } from '../../src/text.ts'

const cp = (...c: number[]) => String.fromCodePoint(...c)

export const PAIRS: { output: string; expected: string; right: boolean; why: string }[] = [
  { output: 'ΑΘΗΝΑ', expected: 'Αθήνα', right: true, why: 'capitals carry no tonos' },
  { output: 'ΜΑΪΟΣ', expected: 'Μάιος', right: true, why: 'capitals add a dialytika where the tonos went' },
  { output: 'πότε', expected: 'ποτέ', right: false, why: 'when is not never' },
  { output: 'ΠΟΤΕ', expected: 'ποτέ', right: true, why: 'in capitals the two cannot be told apart' },
  { output: 'οδοσ', expected: 'οδος', right: true, why: 'one sigma, two letters' },
  { output: 'ΟΔΟΣ', expected: 'οδός', right: true, why: 'capitals, and the final sigma' },
  { output: 'Αθήνα'.normalize('NFD'), expected: 'Αθήνα', right: true, why: 'decomposed text from a Mac or a PDF' },
  { output: `Τι ώρα είναι${cp(0x37e)}`, expected: 'Τι ώρα είναι;', right: true, why: 'the Greek question mark is a semicolon' },
  { output: 'STRASSE', expected: 'Straße', right: true, why: 'German folds the sharp s' },
]

/** The way nearly every grader compares an answer with the expected one. */
export const lowerCase = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** The way a grader compares them after learning that Greek has accents, and so throwing every one away. */
export const stripEveryAccent = (a: string, b: string) => stripMarks(fold(a)) === stripMarks(fold(b))
