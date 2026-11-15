/**
 * Every number in the README comes from a file a command in this repository
 * wrote.
 *
 *   npm run check:claims
 *
 * The sources are the committed outputs: measurements/*.json (rerun by
 * check:measure), every run folder's report.json and report.txt (rebuilt from
 * its rows by evalbar report), every calibration record (recomputed by
 * check:calibration), and the picture. A number in the README's prose that
 * none of them holds, in any of the ways a number is written (as is, rounded,
 * as a percentage, with thousands commas), fails the build, unless
 * tools/claims-allow.json names it with the reason it is not a measurement
 * (Node 24, a 95 percent interval, a default).
 *
 * Code blocks are skipped, since a command's arguments are not claims; so are
 * links, commit hashes and dates.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// --siblings: where the sibling repositories are checked out, beside this one unless said otherwise
const { values } = parseArgs({ options: { root: { type: 'string' }, siblings: { type: 'string' } } })
const root = resolve(values.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'))

const sources: string[] = []
const add = (p: string) => existsSync(p) && sources.push(p)
for (const f of existsSync(join(root, 'measurements')) ? readdirSync(join(root, 'measurements')) : []) add(join(root, 'measurements', f))
for (const e of existsSync(join(root, 'examples')) ? readdirSync(join(root, 'examples')) : []) {
  for (const sub of ['runs', 'records']) {
    const d = join(root, 'examples', e, sub)
    if (!existsSync(d)) continue
    for (const x of readdirSync(d)) {
      const p = join(d, x)
      if (x.endsWith('.json')) add(p)
      for (const f of ['report.json', 'report.txt']) add(join(p, f))
    }
  }
}
add(join(root, 'docs', 'compare.svg'))

const known = new Set<string>()
const withCommas = (s: string) => s.replace(/^(\d+)/, (d) => Number(d).toLocaleString('en-US'))
function addNumber(v: number) {
  const forms = [String(v)]
  for (let d = 0; d <= 4; d++) forms.push(v.toFixed(d), (v * 100).toFixed(d))
  for (const f of forms) {
    known.add(f.replace(/^-/, ''))
    known.add(withCommas(f.replace(/^-/, '')))
  }
}
function walk(x: unknown) {
  if (typeof x === 'number') addNumber(x)
  else if (Array.isArray(x)) x.forEach(walk)
  else if (x && typeof x === 'object') Object.values(x).forEach(walk)
  else if (typeof x === 'string') for (const m of x.matchAll(/\d[\d,]*(?:\.\d+)?/g)) known.add(m[0])
}
for (const s of sources) {
  const text = readFileSync(s, 'utf8')
  if (s.endsWith('.json')) walk(JSON.parse(text))
  else for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) known.add(m[0])
}

// figures quoted from the sibling repositories: pinned to a file, a commit and a hash, and checked there
type Sibling = { project: string; commit: string; file: string; sha256: string; quotes: string[] }
const siblingPath = join(root, 'docs', 'sibling-claims.json')
const siblingFails: string[] = []
if (existsSync(siblingPath)) {
  const { claims } = JSON.parse(readFileSync(siblingPath, 'utf8')) as { claims: Sibling[] }
  for (const c of claims) {
    for (const q of c.quotes) for (const m of q.matchAll(/\d[\d,]*(?:\.\d+)?/g)) known.add(m[0])
    const repo = resolve(values.siblings ?? resolve(root, '..'), c.project)
    if (!existsSync(join(repo, '.git'))) continue
    let text: Buffer
    try {
      text = execFileSync('git', ['-C', repo, 'show', `${c.commit}:${c.file}`])
    } catch {
      siblingFails.push(`${c.project} has no ${c.file} at ${c.commit.slice(0, 7)}`)
      continue
    }
    if (createHash('sha256').update(text).digest('hex') !== c.sha256) siblingFails.push(`${c.project} ${c.commit.slice(0, 7)}:${c.file} does not have the pinned sha256`)
    for (const q of c.quotes) if (!text.toString('utf8').includes(q)) siblingFails.push(`${c.project} ${c.commit.slice(0, 7)}:${c.file} does not say "${q}"`)
  }
}

type Allow = { number: string; why: string }
const allowPath = join(root, 'tools', 'claims-allow.json')
const allow = new Map((existsSync(allowPath) ? (JSON.parse(readFileSync(allowPath, 'utf8')) as Allow[]) : []).map((a) => [a.number, a.why]))

const readme = readFileSync(join(root, 'README.md'), 'utf8')
const fails: string[] = [...siblingFails]
let checked = 0
let inFence = false
readme.split('\n').forEach((raw, i) => {
  if (/^\s*```/.test(raw)) {
    inFence = !inFence
    return
  }
  if (inFence) return
  const line = raw
    .replace(/`[^`]*`/g, ' ')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b[0-9a-f]{7,40}\b/g, ' ')
  for (const m of line.matchAll(/(?<![\w.])\d[\d,]*(?:\.\d+)?(?![\w])/g)) {
    const n = m[0].replace(/[.,]$/, '')
    checked++
    if (known.has(n) || allow.has(n)) continue
    fails.push(`README.md:${i + 1} says ${n}, and no committed output holds it: ${raw.trim().slice(0, 90)}`)
  }
})
if (fails.length) {
  console.error(fails.map((f) => 'FAIL  ' + f).join('\n'))
  process.exit(1)
}
console.log(`check:claims ok: ${checked} numbers in the README, each in one of ${sources.length} committed outputs or allowed with its reason`)
