/**
 * Greek and other non-English text, each defect shown twice: what the naive
 * code every grader starts from does with it, and what evalbar does. A test
 * whose naive line stopped failing would be testing nothing, so the naive line
 * is asserted too.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { loadCases } from '../src/cases.ts'
import { gradeExact } from '../src/graders/exact.ts'
import { firstBadUtf8, readText } from '../src/read.ts'
import { clip, containsWord, fold, sameText, stripMarks } from '../src/text.ts'

const cp = (...c: number[]) => String.fromCodePoint(...c)
const REPLACEMENT = cp(0xfffd)
/** What nearly every grader does. */
const naive = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
/** What a grader does when it learns about accents and strips them all. */
const stripsAll = (a: string, b: string) => stripMarks(fold(a)) === stripMarks(fold(b))

const dir = mkdtempSync(join(tmpdir(), 'evalbar-greek-'))
after(() => rmSync(dir, { recursive: true, force: true }))

/** windows-1253, by inverting Node's own decoder: Node can decode it but has no encoder. */
const to1253 = (() => {
  const dec = new TextDecoder('windows-1253')
  const map = new Map<string, number>()
  for (let b = 0x80; b <= 0xff; b++) {
    const ch = dec.decode(Uint8Array.of(b))
    if (ch !== REPLACEMENT) map.set(ch, b)
  }
  return (s: string) =>
    Uint8Array.from([...s], (ch) => {
      const c = ch.codePointAt(0)!
      if (c < 0x80) return c
      const b = map.get(ch)
      if (b === undefined) throw new Error(`windows-1253 has no byte for ${ch}`)
      return b
    })
})()

const LINE = '{"input": "Ποια είναι η πρωτεύουσα της Ελλάδας;", "expected": "Αθήνα", "tags": ["el"]}\n'
const file = (name: string, bytes: Uint8Array) => {
  const p = join(dir, name)
  writeFileSync(p, bytes)
  return p
}

test('capitals drop the tonos, so ΑΘΗΝΑ is the answer Αθήνα', () => {
  assert.equal(naive('ΑΘΗΝΑ', 'Αθήνα'), false)
  assert.equal(gradeExact('ΑΘΗΝΑ', 'Αθήνα').pass, true)
  // the dialytika that capitals add where a tonos split a diphthong
  assert.equal(gradeExact('ΜΑΪΟΣ', 'Μάιος').pass, true)
})

test('accents count where they could be written: πότε (when) is not ποτέ (never)', () => {
  assert.equal(stripsAll('πότε', 'ποτέ'), true)
  assert.equal(gradeExact('πότε', 'ποτέ').pass, false)
  assert.equal(gradeExact('Πότε', 'ποτέ').pass, false)
  assert.equal(gradeExact('ΠΟΤΕ', 'ποτέ').pass, true)
})

test('one sigma, two letters: οδοσ is οδος, and ΟΔΟΣ is οδός', () => {
  assert.equal(naive('οδοσ', 'οδος'), false)
  assert.equal(gradeExact('οδοσ', 'οδος').pass, true)
  assert.equal(gradeExact('ΟΔΟΣ', 'οδός').pass, true)
})

test('decomposed text from a Mac or a PDF is the same text', () => {
  const nfd = 'Αθήνα'.normalize('NFD')
  assert.notEqual(nfd, 'Αθήνα')
  assert.equal(naive(nfd, 'Αθήνα'), false)
  assert.equal(gradeExact(nfd, 'Αθήνα').pass, true)
})

test('the Greek question mark is a semicolon, as Unicode says', () => {
  const asked = `Τι ώρα είναι${cp(0x37e)}`
  assert.equal(naive(asked, 'Τι ώρα είναι;'), false)
  assert.equal(sameText(asked, 'Τι ώρα είναι;'), true)
  // and through the grader, which once stripped the ASCII mark and kept the Greek one, so the two no longer matched
  assert.equal(gradeExact(asked, 'Τι ώρα είναι;').pass, true)
  assert.equal(gradeExact('Τι ώρα είναι;', asked).pass, true)
})

test('a word boundary that sees Greek letters', () => {
  assert.equal(/\bναι\b/iu.test('Ναι, φυσικά'), false)
  assert.equal(containsWord('Ναι, φυσικά', 'ναι'), true)
  assert.equal(containsWord('ΝΑΙ!', 'ναι'), true)
  // είναι, is, ends in ναι, yes: a substring check reads the answer Δεν είναι as a yes
  assert.equal('Δεν είναι'.includes('ναι'), true)
  assert.equal(containsWord('Δεν είναι', 'ναι'), false)
})

test('a file in windows-1253 is refused with its line and byte, not read as replacement characters', () => {
  const p = file('legacy.jsonl', to1253(LINE))
  const quiet = JSON.parse(readFileSync(p, 'utf8')) as { input: string }
  assert.ok(quiet.input.includes(REPLACEMENT), 'the naive read should have mangled it silently')
  assert.throws(() => loadCases(p), /line 1, byte 12 is not UTF-8 \(d0 ef e9 e1\)\. It reads as Greek in windows-1253/)
  const cases = loadCases(p, 'windows-1253')
  assert.equal(cases[0].input, 'Ποια είναι η πρωτεύουσα της Ελλάδας;')
})

test('a file from a PowerShell 5 redirect, UTF-16 with its byte order mark, is read', () => {
  const utf16 = Uint8Array.from([0xff, 0xfe, ...Buffer.from(LINE, 'utf16le')])
  const p = file('ps5.jsonl', utf16)
  assert.throws(() => JSON.parse(readFileSync(p, 'utf8')))
  assert.equal(loadCases(p)[0].expected, 'Αθήνα')
})

test('a UTF-8 byte order mark does not break the first line', () => {
  const p = file('bom.jsonl', Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(LINE)]))
  assert.throws(() => JSON.parse(readFileSync(p, 'utf8')))
  assert.equal(loadCases(p)[0].tags[0], 'el')
})

test('the UTF-8 check catches what TextDecoder would and says where', () => {
  assert.equal(firstBadUtf8(new TextEncoder().encode(`Αθήνα ${cp(0x1f600)}`)), -1)
  assert.equal(firstBadUtf8(Uint8Array.of(0x61, 0xc0, 0x80)), 1) // an overlong NUL
  assert.equal(firstBadUtf8(Uint8Array.of(0xed, 0xa0, 0x80)), 0) // a surrogate
  assert.equal(firstBadUtf8(Uint8Array.of(0x61, 0x62, 0xe2, 0x82)), 2) // cut short
  assert.equal(firstBadUtf8(Uint8Array.of(0xf4, 0x90, 0x80, 0x80)), 0) // past U+10FFFF
})

test('CRLF line ends and blank lines are not cases', () => {
  const p = file('crlf.jsonl', new TextEncoder().encode(`${LINE.trim()}\r\n\r\n${LINE.trim().replace('Αθήνα', 'Πάτρα')}\r\n`))
  const cases = loadCases(p)
  assert.deepEqual(cases.map((c) => [c.id, c.expected]), [['line-1', 'Αθήνα'], ['line-3', 'Πάτρα']])
})

test('other scripts: STRASSE is Straße, and folding does not depend on the machine', () => {
  assert.equal(naive('STRASSE', 'Straße'), false)
  assert.equal(gradeExact('STRASSE', 'Straße').pass, true)
  // toLocaleLowerCase on a Turkish machine would give a dotless i; fold never asks the machine
  assert.equal(fold('ISTANBUL'), 'istanbul')
})

test('a cut never separates a letter from its accent', () => {
  const s = 'άέήί'.normalize('NFD')
  assert.equal(s.slice(0, 3).normalize('NFC'), 'άε')
  assert.equal(clip(s, 2).normalize('NFC'), 'άέ...')
})

test('reading a file that is not there says so', () => {
  assert.throws(() => readText(join(dir, 'missing.jsonl')), /no such file/)
})
