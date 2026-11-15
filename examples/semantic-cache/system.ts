/**
 * semcache's semantic cache as a system under test, for evalbar's command
 * provider: one JSON line in, `{"id", "input"}`, one line out, `{"output",
 * "usage"}`, in the stream's order, because a cache is the requests before it.
 *
 *   node system.ts --stream vendor/semcache/data/test.json --threshold 0.58 --guard digits
 *
 * The cache is semcache's own code, vendored unchanged from commit a5ed729 and
 * held to it by evalbar's check:vendor: `SemanticCache`, its guards and its
 * hashed n-gram embedder. A hit serves the answer stored for an earlier
 * request; a miss asks the model and stores the answer.
 *
 * The model is a stand-in that answers every miss correctly, which is the
 * assumption semcache's own measurement makes, so every wrong answer in a run
 * is the cache's. The stand-in is the only code that reads the stream's
 * answers, and it is called on a miss only: the cache decides a hit from the
 * text alone. A miss costs the intent's tokens from semcache's table, a hit
 * costs none, so evalbar's cost per case is the bill the cache leaves.
 */
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { answer, type Request } from './answer.ts'

// semcache's files import './embed' without an extension, as its bundler allows and Node does not
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (e) {
      if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context)
      throw e
    }
  },
})
const { SemanticCache } = await import('./vendor/semcache/lib/cache.ts')
const { digits, digitsAndNames } = await import('./vendor/semcache/lib/entities.ts')
const { INTENTS, WORD_INTENTS, CATALOG } = await import('./vendor/semcache/intents.ts')

const { values } = parseArgs({ options: { stream: { type: 'string' }, threshold: { type: 'string' }, guard: { type: 'string' } } })
if (!values.stream || !values.threshold || !values.guard) {
  process.stderr.write('error: system.ts wants --stream <file> --threshold <0..1, or above 1 for no cache> --guard none|digits|names\n')
  process.exit(2)
}
const threshold = Number(values.threshold)
const guards = { none: null, digits, names: digitsAndNames(CATALOG) } as const
if (!(values.guard in guards)) {
  process.stderr.write(`error: unknown guard ${values.guard}\n`)
  process.exit(2)
}
const guard = guards[values.guard as keyof typeof guards]

// the stand-in model: the right answer for a request text, and what generating it costs
const stream = JSON.parse(readFileSync(new URL(values.stream, import.meta.url), 'utf8')) as Request[]
const truth = new Map(stream.map((q) => [q.text, q]))
const tokens = new Map([...INTENTS, ...WORD_INTENTS].map((i) => [i.id, i.tokens]))
function model(text: string): { output: string; usage: { input: number; output: number } } {
  const q = truth.get(text)
  if (!q) throw new Error(`the stand-in model has no answer for "${text}"`)
  const [input, output] = tokens.get(q.intent)!
  return { output: answer(q.intent, q.entity), usage: { input, output } }
}

const cache = new SemanticCache<string>(threshold, guard)
for await (const line of createInterface({ input: process.stdin })) {
  const { input } = JSON.parse(line) as { id: string; input: string }
  const hit = cache.lookup(input)
  if (hit.hit && hit.entry) {
    process.stdout.write(`${JSON.stringify({ output: hit.entry.value, usage: { input: 0, output: 0 } })}\n`)
    continue
  }
  const fresh = model(input)
  cache.insert(input, fresh.output)
  process.stdout.write(`${JSON.stringify(fresh)}\n`)
}
