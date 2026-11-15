/**
 * Greek text graded three ways: the way nearly every grader does it, the way
 * a grader does it after learning that Greek has accents, and evalbar's.
 *
 *   node tools/measure/greek.ts      writes measurements/greek.json
 *
 * Nine pairs an exact grader must get right (src/text.ts says why each is
 * hard), and for each way of grading, how many it gets wrong. Then three files
 * a Greek user's tools write, and what a plain UTF-8 read makes of each.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gradeExact } from '../../src/graders/exact.ts'
import { decode, ReadError } from '../../src/read.ts'
import { lowerCase, PAIRS, stripEveryAccent } from './greek-pairs.ts'

const cp = (...c: number[]) => String.fromCodePoint(...c)
const ways: Record<string, (a: string, b: string) => boolean> = {
  lowerCase,
  stripEveryAccent,
  evalbar: (a, b) => gradeExact(a, b).pass,
}
const wrong = Object.fromEntries(Object.entries(ways).map(([name, f]) => [name, PAIRS.filter((p) => f(p.output, p.expected) !== p.right).length]))

// three files: the line in windows-1253, in UTF-16 from a PowerShell 5 redirect, and in UTF-8 with a byte order mark
const LINE = '{"input": "Ποια είναι η πρωτεύουσα της Ελλάδας;", "expected": "Αθήνα"}'
const to1253 = (() => {
  const dec = new TextDecoder('windows-1253')
  const map = new Map<string, number>()
  for (let b = 0x80; b <= 0xff; b++) map.set(dec.decode(Uint8Array.of(b)), b)
  return (s: string) => Uint8Array.from([...s], (ch) => (ch.codePointAt(0)! < 0x80 ? ch.codePointAt(0)! : map.get(ch)!))
})()
const files: Record<string, Uint8Array> = {
  'windows-1253': to1253(LINE),
  'UTF-16 from a PowerShell 5 redirect': Uint8Array.from([0xff, 0xfe, ...Buffer.from(LINE, 'utf16le')]),
  'UTF-8 with a byte order mark': Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(LINE)]),
}
const reads = Object.entries(files).map(([name, bytes]) => {
  const plain = Buffer.from(bytes).toString('utf8')
  let plainResult: string
  try {
    const v = JSON.parse(plain) as { input: string }
    plainResult = v.input.includes(cp(0xfffd)) ? 'reads, with the Greek turned into replacement characters' : 'reads'
  } catch {
    plainResult = 'fails to parse'
  }
  let evalbar: string
  try {
    const v = JSON.parse(decode(bytes, name)) as { input: string }
    evalbar = v.input === 'Ποια είναι η πρωτεύουσα της Ελλάδας;' ? 'reads the Greek' : 'reads something else'
  } catch (e) {
    evalbar = e instanceof ReadError ? `refuses: ${e.message.replace(`${name}: `, '')}` : 'crashes'
  }
  return { file: name, plainUtf8Read: plainResult, evalbar }
})

const out = { made_by: 'node tools/measure/greek.ts', pairs: PAIRS.length, wrong, reads }
const path = process.env.EVALBAR_MEASURE_OUT ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'measurements', 'greek.json')
mkdirSync(dirname(path), { recursive: true })
writeFileSync(path, `${JSON.stringify(out, null, 1)}\n`)
if (!process.env.EVALBAR_MEASURE_OUT) {
  console.log(`of ${PAIRS.length} pairs, graded wrongly: ${Object.entries(wrong).map(([k, n]) => `${k} ${n}`).join(', ')}`)
  for (const r of reads) console.log(`${r.file}: a plain read ${r.plainUtf8Read}; evalbar ${r.evalbar}`)
}
