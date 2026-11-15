/**
 * The picture at the top of the README: a terminal, drawn from what evalbar
 * prints today, never typed.
 *
 *   node tools/picture.ts      writes docs/compare.svg
 *
 * It runs semcache's two caches through evalbar as a user would (the example
 * system, both streams' first one), compares them, and draws the command and
 * its output. The line the screen argues about, the verdict, is the one line
 * in the house's flame orange (STYLEGUIDE.md: orange is the colour of the one
 * thing being argued about); the rest is paper and dim on the warm black.
 * check:picture runs this again and requires the committed file.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../src/app.ts'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const suite = join(repo, 'examples', 'semantic-cache')
const NODE = `"${process.execPath}" --experimental-transform-types --disable-warning=ExperimentalWarning`
const scratch = mkdtempSync(join(tmpdir(), 'evalbar-picture-'))
const quiet = { out: () => {}, err: () => {} }

let shown = ''
try {
  for (const [name, threshold, guard] of [
    ['similarity-0.92', '0.92', 'none'],
    ['digits-guard-0.58', '0.58', 'digits'],
  ]) {
    const command = `${NODE} system.ts --stream vendor/semcache/data/test.json --threshold ${threshold} --guard ${guard}`
    const code = await main(['run', suite, '--command', command, '--out', join(scratch, name)], quiet)
    if (code === 2) throw new Error(`the ${name} run failed`)
  }
  const here = process.cwd()
  process.chdir(scratch)
  try {
    await main(['compare', 'similarity-0.92', 'digits-guard-0.58'], { out: (s) => (shown += s), err: () => {} })
  } finally {
    process.chdir(here)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

const lines = ['$ evalbar compare similarity-0.92 digits-guard-0.58', ...shown.trimEnd().split('\n')]
// the long refusal sentence, wrapped at a word so it fits the frame
const wrapped = lines.flatMap((l) => {
  if (l.length <= 96) return [l]
  const out: string[] = []
  let rest = l
  while (rest.length > 96) {
    const cut = rest.lastIndexOf(' ', 96)
    out.push(rest.slice(0, cut))
    rest = `  ${rest.slice(cut + 1)}`
  }
  return [...out, rest]
})
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const LINE = 24
const width = 920
const height = 40 + wrapped.length * LINE + 24
let verdict = false
const text = wrapped
  .map((l, i) => {
    if (/^(REFUSED|B IS BETTER|B IS WORSE)/.test(l)) verdict = true
    else if (!l.startsWith('  ')) verdict = false
    const fill = i === 0 ? '#9a8f88' : verdict ? '#ff6a00' : '#ffffff'
    return `<text x="28" y="${44 + i * LINE}" fill="${fill}"${verdict ? ' font-weight="600"' : ''}>${esc(l)}</text>`
  })
  .join('\n  ')
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="evalbar compare on semcache's two caches: the guard served 3 wrong answers where similarity alone served none, in 2,000 requests, and evalbar refuses to call the difference">
  <rect width="${width}" height="${height}" rx="6" fill="#080604"/>
  <g font-family="ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace" font-size="14.5">
  ${text}
  </g>
</svg>
`
const path = process.env.EVALBAR_MEASURE_OUT ?? join(repo, 'docs', 'compare.svg')
mkdirSync(dirname(path), { recursive: true })
writeFileSync(path, svg)
if (!process.env.EVALBAR_MEASURE_OUT) console.log(`${path}: ${wrapped.length} lines`)
