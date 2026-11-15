/**
 * A grader you write: a JavaScript or TypeScript module that exports
 *
 *   export function grade(c, output) { return { pass: true, reason: 'why' } }
 *
 * `c` is the case as the suite holds it (id, input, expected, tags, cluster,
 * and every extra field); `output` is what the system answered. It may be
 * async. It sees the expected answer, the system under test never does.
 *
 * What it returns is checked: a grader that returns `true`, or forgets the
 * reason, has a bug that would otherwise be scored as the model's, so it
 * lands in errors.jsonl as a grader error instead.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Case } from '../cases.ts'
import { UserError } from '../errors.ts'
import { ProviderError } from '../providers/types.ts'
import type { Grader } from '../run.ts'
import type { Grade } from './exact.ts'

type GradeFn = (c: Case, output: string) => Grade | Promise<Grade>

export async function programGrader(path: string, base = process.cwd()): Promise<Grader> {
  const abs = resolve(base, path)
  if (!existsSync(abs)) throw new UserError(`the grader ${path} does not exist`)
  const mod = (await import(pathToFileURL(abs).href)) as { grade?: GradeFn; default?: GradeFn }
  const fn = mod.grade ?? mod.default
  if (typeof fn !== 'function') throw new UserError(`${path} exports no grade function: export function grade(c, output) { ... }`)
  return {
    name: `program ${path}`,
    async grade(c, output) {
      const g = (await fn(c, output)) as unknown
      if (!g || typeof g !== 'object' || typeof (g as Grade).pass !== 'boolean' || typeof (g as Grade).reason !== 'string')
        throw new ProviderError('grader', `${path} returned ${JSON.stringify(g)?.slice(0, 80)} for ${c.id}, not { pass: boolean, reason: string }`)
      return g as Grade
    },
  }
}
