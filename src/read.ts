/**
 * Reading a file of cases without guessing at its bytes.
 *
 * `readFileSync(path, 'utf8')` never fails: a byte that is not UTF-8 becomes
 * U+FFFD and the read carries on. A Greek file saved in windows-1253, which is
 * what older Windows tools and many Greek exports still write, then arrives as
 * a row of replacement characters, every Greek case fails, and the report
 * blames the model. Two Windows habits do the same to any language: a UTF-8
 * byte order mark, which makes the first line's JSON invalid, and PowerShell
 * 5's `>` redirect, which writes UTF-16.
 *
 * So: a UTF-8 byte order mark is dropped, a UTF-16 one is honoured, and
 * anything else must be valid UTF-8 or the read stops at the first bad byte
 * with its line, and says windows-1253 when the bytes read as Greek in it.
 * `--encoding` reads a legacy file on purpose.
 */
import { readFileSync } from 'node:fs'
import { UserError } from './errors.ts'

export class ReadError extends UserError {}

/** The byte offset of the first sequence that is not well-formed UTF-8, or -1. Overlongs, surrogates and code points past U+10FFFF included. */
export function firstBadUtf8(b: Uint8Array): number {
  let i = 0
  while (i < b.length) {
    const x = b[i]
    if (x < 0x80) {
      i++
      continue
    }
    let need: number
    let min: number
    if (x >= 0xc2 && x <= 0xdf) [need, min] = [1, 0x80]
    else if (x >= 0xe0 && x <= 0xef) [need, min] = [2, 0x800]
    else if (x >= 0xf0 && x <= 0xf4) [need, min] = [3, 0x10000]
    else return i
    let cp = x & (0x3f >> need)
    for (let k = 1; k <= need; k++) {
      const y = b[i + k]
      if (y === undefined || (y & 0xc0) !== 0x80) return i
      cp = (cp << 6) | (y & 0x3f)
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return i
    i += need + 1
  }
  return -1
}

/** Of the bytes at or above 0x80, the share windows-1253 reads as Greek letters. */
function greekShare(b: Uint8Array): number {
  const text = new TextDecoder('windows-1253').decode(b)
  let high = 0
  let greek = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp < 0x80) continue
    high++
    if (cp >= 0x0370 && cp <= 0x03ff) greek++
  }
  return high ? greek / high : 0
}

export function decode(bytes: Uint8Array, path: string, encoding?: string): string {
  if (encoding) {
    let dec: InstanceType<typeof TextDecoder>
    try {
      dec = new TextDecoder(encoding, { fatal: true })
    } catch {
      throw new ReadError(`${path}: unknown encoding "${encoding}"`)
    }
    try {
      return dec.decode(bytes)
    } catch {
      throw new ReadError(`${path}: is not valid ${encoding}`)
    }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2))
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes
  const bad = firstBadUtf8(body)
  if (bad === -1) return new TextDecoder('utf-8', { fatal: true }).decode(body)
  let line = 1
  let col = 1
  for (let i = 0; i < bad; i++) {
    if (body[i] === 0x0a) {
      line++
      col = 1
    } else col++
  }
  const hex = Array.from(body.subarray(bad, bad + 4), (x) => x.toString(16).padStart(2, '0')).join(' ')
  const hint =
    greekShare(body) >= 0.8
      ? ' It reads as Greek in windows-1253: save it as UTF-8, or pass --encoding windows-1253.'
      : ' Save it as UTF-8, or pass --encoding with the one it was written in.'
  throw new ReadError(`${path}: line ${line}, byte ${col} is not UTF-8 (${hex}).${hint}`)
}

export function readText(path: string, encoding?: string): string {
  let bytes: Uint8Array
  try {
    bytes = readFileSync(path)
  } catch (e) {
    throw new ReadError(`${path}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : (e as Error).message}`)
  }
  return decode(bytes, path, encoding)
}

export type Line = { line: number; value: unknown }

/** One JSON value a line; blank lines skipped, CRLF or LF, every bad line named before anything runs. */
export function parseJsonl(text: string, path: string): Line[] {
  const out: Line[] = []
  const bad: string[] = []
  text.split('\n').forEach((raw, i) => {
    const s = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!s.trim()) return
    try {
      out.push({ line: i + 1, value: JSON.parse(s) })
    } catch (e) {
      bad.push(`${path}: line ${i + 1} is not JSON: ${(e as Error).message}`)
    }
  })
  if (bad.length) throw new ReadError(bad.slice(0, 5).join('\n') + (bad.length > 5 ? `\n...and ${bad.length - 5} more` : ''))
  return out
}
