/**
 * The one vendored file Node cannot load as it is, made loadable by a rule a
 * reader can check.
 *
 *   node tools/derive-vendor.ts           writes src/vendor-derived/
 *   node tools/derive-vendor.ts --check   fails if what is committed is not what the rule makes
 *
 * logs-to-evals's selector imports './embed' and './scrub' without a file
 * extension, which its bundler allows and Node's module loader, and TypeScript
 * on NodeNext, do not. The original stays under src/vendor byte for byte as
 * logs-to-evals has it (check:vendor), excluded from the compile; the copy
 * here differs only in those two import paths, and check:vendor runs this
 * script with --check so the copy cannot drift from the original plus the
 * rule.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { root: { type: 'string' }, check: { type: 'boolean' } } })
const root = resolve(values.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'))

export const DERIVED = [
  {
    from: 'src/vendor/logs-to-evals/select.ts',
    to: 'src/vendor-derived/logs-to-evals/select.ts',
    imports: [
      ["from './embed'", "from '../../vendor/logs-to-evals/embed.ts'"],
      ["from './scrub'", "from '../../vendor/logs-to-evals/scrub.ts'"],
    ],
  },
]

const header = (from: string) => `// Derived from ${from} by tools/derive-vendor.ts: the same file with its import paths given extensions. Do not edit.\n`

let bad = 0
for (const d of DERIVED) {
  let text = readFileSync(join(root, d.from), 'utf8')
  for (const [a, b] of d.imports) {
    if (!text.includes(a)) throw new Error(`${d.from} no longer contains ${a}: the rule is stale`)
    text = text.replace(a, b)
  }
  const want = header(d.from) + text
  const path = join(root, d.to)
  if (values.check) {
    let have = ''
    try {
      have = readFileSync(path, 'utf8')
    } catch {
      // missing is a difference too
    }
    if (have !== want) {
      bad++
      console.error(`FAIL  ${d.to} is not ${d.from} with its imports given extensions: run node tools/derive-vendor.ts`)
    }
  } else {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, want)
    console.log(`wrote ${d.to}`)
  }
}
if (bad) process.exit(1)
if (values.check) console.log(`derive-vendor ok: ${DERIVED.length} derived file equal to its original under the rule`)
