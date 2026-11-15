/**
 * The committed files the page reads, loaded in Node: the same files `main.ts`
 * imports, so a gate can compute what the page must say. And every number those
 * files hold, for the gate that requires each figure on the page to come from one.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Measured } from '../lib.ts'

export const FILES = {
  semantic: '../../measurements/semantic-cache.json',
  sql: '../../measurements/sql-run.json',
  sqlReport: '../../examples/sql-refusals/runs/qwen2.5-coder-1.5b/report.json',
  judge: '../../examples/judge-calibration/records/qwen2.5-coder-1.5b.json',
  importer: '../../measurements/importer.json',
  greek: '../../measurements/greek.json',
} as const

const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'))

export function measured(): Measured {
  return Object.fromEntries(Object.entries(FILES).map(([k, rel]) => [k, read(rel)])) as unknown as Measured
}

/** A number as a claim writes it, without the thousands commas: "2,000" is 2000. */
export const numbersIn = (s: string) => (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((x) => x.replace(/,/g, '')).filter((x) => x !== '')

/**
 * Every number in the files: each numeric value as it is and rounded to one,
 * two and three places, and every number written inside a string value (a
 * cache named "similarity only, 0.92", a model named "Qwen2.5-Coder-1.5B").
 */
export function fileNumbers(): Set<string> {
  const known = new Set<string>()
  const walk = (x: unknown) => {
    if (typeof x === 'number') {
      known.add(String(x))
      if (!Number.isInteger(x)) for (const d of [1, 2, 3]) known.add(x.toFixed(d))
    } else if (typeof x === 'string') for (const n of numbersIn(x)) known.add(n)
    else if (Array.isArray(x)) x.forEach(walk)
    else if (x && typeof x === 'object') Object.values(x).forEach(walk)
  }
  for (const rel of Object.values(FILES)) walk(read(rel))
  return known
}
