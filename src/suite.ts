/**
 * What `evalbar run <suite>` points at: a JSONL file, or a folder holding
 * `cases.jsonl` and an optional `suite.json` with the settings that belong to
 * the suite rather than to one run (the system under test, the grader, the
 * bar). Flags on the command line override it. Paths in it are relative to the
 * folder, and a command runs in the folder.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { UserError } from './errors.ts'
import type { Prices } from './run.ts'

export type SuiteConfig = {
  description?: string
  cases?: string
  provider?: {
    command?: string
    baseUrl?: string
    model?: string
    apiKeyEnv?: string
    system?: string
    temperature?: number
    maxTokens?: number
  }
  grader?: string | { program: string }
  bar?: number
  prices?: Prices
  encoding?: string
}

export type Suite = { name: string; dir: string; casesPath: string; config: SuiteConfig }

export function resolveSuite(path: string): Suite {
  const abs = resolve(path)
  if (!existsSync(abs)) throw new UserError(`${path}: no such file or folder`)
  if (statSync(abs).isDirectory()) {
    const cfgPath = join(abs, 'suite.json')
    const config = existsSync(cfgPath) ? (JSON.parse(readFileSync(cfgPath, 'utf8')) as SuiteConfig) : {}
    const casesPath = join(abs, config.cases ?? 'cases.jsonl')
    if (!existsSync(casesPath)) throw new UserError(`${path}: no ${config.cases ?? 'cases.jsonl'} in the folder`)
    return { name: basename(abs), dir: abs, casesPath, config }
  }
  return { name: basename(abs).replace(/\.jsonl?$/i, ''), dir: dirname(abs), casesPath: abs, config: {} }
}
