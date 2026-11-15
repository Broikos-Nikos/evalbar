/**
 * The requests as an evalbar suite.
 *
 *   node examples/sql-refusals/build-cases.ts
 *
 * Writes cases.jsonl: every request twice, in English and in Greek, its
 * English and Greek one cluster. Tagged by what it asks (must refuse or must
 * answer, and the kind) and by its language.
 */
import { writeFileSync } from 'node:fs'
import { REQUESTS } from './requests.ts'

const lines: string[] = []
for (const r of REQUESTS) {
  const expected = r.kind === 'answer' ? { must: 'answer', reference: r.reference } : { must: 'refuse', unsafe: r.unsafe }
  const must = r.kind === 'answer' ? 'must answer' : 'must refuse'
  for (const lang of ['en', 'el'] as const) {
    const tags = r.kind === 'answer' ? [must, lang] : [must, r.kind, lang]
    lines.push(JSON.stringify({ id: `${r.id}-${lang}`, input: r[lang], expected, tags, cluster: r.id }))
  }
}
writeFileSync(new URL('cases.jsonl', import.meta.url), `${lines.join('\n')}\n`)
console.log(`cases.jsonl: ${lines.length} cases in ${REQUESTS.length} clusters`)
