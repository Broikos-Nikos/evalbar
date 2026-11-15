/**
 * What the importer does to a log whose contents are known.
 *
 *   node tools/measure/importer.ts      writes measurements/importer.json
 *
 * examples/importer/log.jsonl (make-log.ts, seed 20261117) through the
 * importer as a user would run it, holding out the last two weeks, compared
 * with examples/importer/truth.jsonl, which the importer never reads:
 *
 * - for each kind of row (a request, a short line, a paste, a line leaning on
 *   context), what the importer did with it;
 * - for each kind of identifier planted in a kept request, how many survived
 *   into the case, by its value or its run of digits;
 * - whether any session landed on both sides of the holdout;
 * - and the length floor priced: real requests lost and short lines caught at
 *   floors of 0, 12 and 20 characters, since the base's 20 was measured on a
 *   developer's prompts and this is a support log.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importLog, type Fate, type ImportOptions } from '../../src/importer/import.ts'

const here = dirname(fileURLToPath(import.meta.url))
const example = join(here, '..', '..', 'examples', 'importer')
const read = (f: string) => readFileSync(join(example, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const log = read('log.jsonl') as Record<string, unknown>[]
type Truth = { row: number; what: 'request' | 'short' | 'pasted' | 'context'; planted: { kind: string; value: string }[] }
const truth = read('truth.jsonl') as Truth[]

const OPTIONS: ImportOptions = { minChars: 12, near: 0.9, holdoutAfter: '2026-10-17' }
const { dev, test, funnel, fates } = importLog(log, OPTIONS)

const byKind: Record<string, Partial<Record<Fate, number>>> = {}
truth.forEach((t, i) => {
  const k = (byKind[t.what] ??= {})
  k[fates[i]] = (k[fates[i]] ?? 0) + 1
})

// an identifier survived when its value, or its run of six or more digits, is in the case it became
const cases = new Map([...dev, ...test].map((c) => [Number(c.id.replace('log-', '')), c.input]))
const scrub: Record<string, { inKept: number; survived: number }> = {}
for (const t of truth) {
  const text = cases.get(t.row)
  if (text === undefined) continue
  for (const p of t.planted) {
    const s = (scrub[p.kind] ??= { inKept: 0, survived: 0 })
    s.inKept++
    const run = p.value.replace(/[^0-9]/g, '')
    if (text.includes(p.value) || (run.length >= 6 && text.replace(/[^0-9]/g, ' ').split(/\s+/).some((d) => d.length >= 6 && run.includes(d)))) s.survived++
  }
}

const devClusters = new Set(dev.map((c) => c.cluster))
const straddling = test.filter((c) => devClusters.has(c.cluster)).length

const floors = [0, 12, 20].map((minChars) => {
  const f = importLog(log, { ...OPTIONS, minChars }).fates
  const real = truth.filter((t, i) => t.what === 'request' && f[i] === 'short').length
  const short = truth.filter((t, i) => t.what === 'short' && f[i] === 'short').length
  const shortKept = truth.filter((t, i) => t.what === 'short' && f[i] === 'kept').length
  return { minChars, requestsDroppedAsShort: real, shortLinesCaught: short, shortLinesKept: shortKept }
})

const rowsByKind = Object.fromEntries(['request', 'short', 'pasted', 'context'].map((k) => [k, truth.filter((t) => t.what === k).length]))
const out = { made_by: 'node tools/measure/importer.ts', log: 'examples/importer/log.jsonl', options: OPTIONS, rows: rowsByKind, funnel, byKind, scrub, holdout: { dev: dev.length, test: test.length, casesInATestSessionAlsoInDev: straddling }, floors }
const path = process.env.EVALBAR_MEASURE_OUT ?? join(here, '..', '..', 'measurements', 'importer.json')
mkdirSync(dirname(path), { recursive: true })
writeFileSync(path, `${JSON.stringify(out, null, 1)}\n`)
if (!process.env.EVALBAR_MEASURE_OUT) {
  console.log('what each kind of row became:')
  for (const [k, v] of Object.entries(byKind)) console.log(`  ${k.padEnd(8)} ${Object.entries(v).map(([f, n]) => `${f} ${n}`).join(', ')}`)
  console.log('identifiers planted in kept requests, and how many survived:')
  for (const [k, v] of Object.entries(scrub)) console.log(`  ${k.padEnd(9)} ${v.survived} of ${v.inKept} survived`)
  console.log(`holdout: ${dev.length} dev, ${test.length} test, ${straddling} test cases from a session that is also in dev`)
  for (const f of floors) console.log(`floor ${String(f.minChars).padStart(2)}: ${f.requestsDroppedAsShort} real requests dropped as short; ${f.shortLinesCaught} of 100 short lines caught, ${f.shortLinesKept} kept`)
}
