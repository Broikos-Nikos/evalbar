/**
 * The recorded SQL run, broken down by what the grader said about each answer.
 *
 *   node tools/measure/sql-run.ts      writes measurements/sql-run.json
 *
 * The grader passes a must-refuse request when nothing is harmed, and that is
 * of two kinds: a refusal, and SQL that does no harm. The second can be a
 * request the model misread: on the recorded run, Greek requests to change data
 * came back as harmless SELECTs that answered something else. Outcome grading
 * counts those as safe, which is right about the database and flatters the
 * model, so the split is counted here, by kind of request and by language.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Row } from '../../src/run.ts'

const here = dirname(fileURLToPath(import.meta.url))
const RUN = 'examples/sql-refusals/runs/qwen2.5-coder-1.5b'
const rows = readFileSync(join(here, '..', '..', RUN, 'results.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as Row)

const kinds = ['writes', 'secrets', 'forbidden table', 'schema', 'row cap', 'must answer']
const outcome = (r: Row) => (r.reason.startsWith('ran: ') ? 'harm' : r.reason)
const table: Record<string, Record<string, Record<string, number>>> = {}
for (const r of rows) {
  const kind = kinds.find((k) => r.tags.includes(k))!
  const lang = r.tags.includes('el') ? 'el' : 'en'
  const k = (table[kind] ??= {})
  const l = (k[lang] ??= {})
  l[outcome(r)] = (l[outcome(r)] ?? 0) + 1
}
// every request it had to refuse, by what came back
const mustRefuse: Record<string, number> = {}
for (const r of rows.filter((x) => x.tags.includes('must refuse'))) mustRefuse[outcome(r)] = (mustRefuse[outcome(r)] ?? 0) + 1
const out = { made_by: 'node tools/measure/sql-run.ts', run: RUN, cases: rows.length, mustRefuse, byKindAndLanguage: table }
const path = process.env.EVALBAR_MEASURE_OUT ?? join(here, '..', '..', 'measurements', 'sql-run.json')
mkdirSync(dirname(path), { recursive: true })
writeFileSync(path, `${JSON.stringify(out, null, 1)}\n`)
if (!process.env.EVALBAR_MEASURE_OUT)
  for (const [kind, langs] of Object.entries(table)) for (const [lang, o] of Object.entries(langs)) console.log(`${kind.padEnd(16)} ${lang}  ${Object.entries(o).map(([k, n]) => `${k} ${n}`).join(', ')}`)
