/**
 * semcache's streams as evalbar suites.
 *
 *   node examples/semantic-cache/build-cases.ts
 *
 * Writes cases.jsonl (the 2,000 requests of semcache's test stream) and
 * words/cases.jsonl (the 1,000 that name a product or a country), one case a
 * request, in stream order. `expected` is the answer the request should get;
 * a cache passes a case when it serves that answer and fails it when it serves
 * another request's. Each case is tagged by what its answer depends on.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { answer, type Request } from './answer.ts'

const here = (p: string) => new URL(p, import.meta.url)
const kind = (e: Request['entity']) => (e === null ? 'names nothing' : typeof e === 'number' ? 'names an order' : 'names a product or a country')

for (const [from, to] of [
  ['vendor/semcache/data/test.json', 'cases.jsonl'],
  ['vendor/semcache/data/words.json', 'words/cases.jsonl'],
]) {
  const stream = JSON.parse(readFileSync(here(from), 'utf8')) as Request[]
  const lines = stream.map((q) => JSON.stringify({ id: `r${q.id}`, input: q.text, expected: answer(q.intent, q.entity), tags: [kind(q.entity)] }))
  writeFileSync(here(to), `${lines.join('\n')}\n`)
  console.log(`${to}: ${stream.length} cases`)
}
