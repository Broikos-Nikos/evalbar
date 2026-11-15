/**
 * Reused code is the code it claims to be.
 *
 *   npm run check:vendor
 *
 * evalbar reuses its sibling repositories by copying files from a named commit
 * (decision B3 in its tracking folder). A copy that has been edited is a fork
 * that still carries the original's name and the original's measured claims,
 * which is worse than a rewrite, because a reader trusts it. So:
 *
 * 1. Every file under src/vendor and examples/<name>/vendor is listed in MANIFEST.json.
 * 2. Every listed file has the sha256 the manifest records.
 * 3. Where the sibling repository is checked out beside this one, the file is
 *    byte for byte `git show <commit>:<path>` there, so the manifest's hash was
 *    taken from the real commit and not from a copy edited before it was hashed.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { root: { type: 'string' } } })
const root = resolve(values.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'))

type Entry = { project: string; commit: string; from: string; to: string; sha256: string }
const manifest = JSON.parse(readFileSync(join(root, 'src/vendor/MANIFEST.json'), 'utf8')) as { files: Entry[] }

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]))

const fails: string[] = []
const listed = new Set(manifest.files.map((f) => f.to))
// vendored code lives under src/vendor, and an example's own under examples/<name>/vendor
const vendorRoots = [
  join(root, 'src/vendor'),
  ...(existsSync(join(root, 'examples')) ? readdirSync(join(root, 'examples')).map((e) => join(root, 'examples', e, 'vendor')).filter((p) => existsSync(p)) : []),
]
for (const file of vendorRoots.flatMap(walk)) {
  const rel = relative(root, file).split('\\').join('/')
  if (rel !== 'src/vendor/MANIFEST.json' && !listed.has(rel)) fails.push(`${rel} is in a vendor folder and not in the manifest`)
}

let compared = 0
for (const f of manifest.files) {
  const path = join(root, f.to)
  if (!existsSync(path)) {
    fails.push(`${f.to} is in the manifest and missing`)
    continue
  }
  const bytes = readFileSync(path)
  const sha = createHash('sha256').update(bytes).digest('hex')
  if (sha !== f.sha256) fails.push(`${f.to} has sha256 ${sha.slice(0, 12)}, the manifest says ${f.sha256.slice(0, 12)}: it was edited after it was copied`)
  const sibling = resolve(root, '..', f.project)
  if (existsSync(join(sibling, '.git'))) {
    let original: Buffer | null = null
    try {
      original = execFileSync('git', ['-C', sibling, 'show', `${f.commit}:${f.from}`])
    } catch {
      fails.push(`${f.project} is checked out beside this repository and has no ${f.from} at ${f.commit.slice(0, 7)}`)
    }
    if (original) {
      compared++
      if (!original.equals(bytes)) fails.push(`${f.to} differs from ${f.project} ${f.commit.slice(0, 7)}:${f.from}`)
    }
  }
}

if (fails.length) {
  console.error(fails.map((f) => 'FAIL  ' + f).join('\n'))
  process.exit(1)
}
console.log(`check:vendor ok: ${manifest.files.length} vendored files at their recorded sha256, ${compared} compared byte for byte with the commit they came from`)
