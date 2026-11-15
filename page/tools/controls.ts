/**
 * The page gates' broken states, each made on a throwaway copy of the
 * repository, and each gate required to fail on it.
 *
 *   npm run controls          (in page/, after npm install)
 *
 * The copy holds what the page builds from: `src`, `measurements`, `examples`,
 * `tools/measure` and `page`, with links to the installed packages rather than
 * copies of them. It is built and verified once unbroken first, so a control
 * cannot pass because the copy was broken to begin with. Each break is undone
 * before the next. The links are removed before the copy is, and the packages
 * they point at are checked to be there afterwards: a recursive delete that
 * followed a link would reach the real ones.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const page = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(page, '..')

type Control = { why: string; file: string; from: string; to: string; expect: RegExp }
const CONTROLS: Control[] = [
  {
    why: "a headline written by hand, its number no longer the measurement's",
    file: 'page/main.ts',
    from: "$('headline').textContent = headline(m)",
    to: "$('headline').textContent = headline(m).replace('5,231', '5,000')",
    expect: /FAIL {2}at 1280, the headline/,
  },
  {
    why: "the page deciding for itself instead of evalbar: the bar nudged before the report runs",
    file: 'page/main.ts',
    from: 'term(out, reportText(n!, k!, bar!))',
    to: 'term(out, reportText(n!, k!, Math.min(1, bar! + 0.001)))',
    expect: /FAIL {2}at 1280, run preset/,
  },
  {
    why: 'a figure in a result that no committed file holds',
    file: 'page/lib.ts',
    from: 'About ${int(s92.casesToDecide!)} requests would decide it.',
    to: 'About ${int(s92.casesToDecide!)} requests, or 3,700, would decide it.',
    expect: /3700 is in no committed file/,
  },
  {
    why: 'the claim reworded and the link preview not taken again',
    file: 'page/lib.ts',
    from: 'evalbar says this sample cannot tell',
    to: 'evalbar says that this sample cannot tell',
    expect: /FAIL {2}the card shows headline/,
  },
]

const copy = mkdtempSync(join(tmpdir(), 'evalbar-page-controls-'))
const links = [join(copy, 'node_modules'), join(copy, 'page', 'node_modules')]
const skip = (p: string) => /[\\/](node_modules|dist|\.git)$/.test(p) || /examples[\\/]judge-calibration[\\/]data$/.test(p)
for (const part of ['src', 'measurements', 'examples', 'tools/measure', 'page']) cpSync(join(repo, part), join(copy, part), { recursive: true, filter: (p) => !skip(p) })
symlinkSync(join(repo, 'node_modules'), links[0], 'junction')
symlinkSync(join(page, 'node_modules'), links[1], 'junction')

const npm = (script: string) => spawnSync(`npm run ${script}`, { cwd: join(copy, 'page'), shell: true, encoding: 'utf8' })
const buildAndVerify = () => {
  const build = npm('build')
  if (build.status !== 0) return { status: build.status, out: `${build.stdout}${build.stderr}` }
  const verify = npm('verify')
  return { status: verify.status, out: `${verify.stdout}${verify.stderr}` }
}

let bad = 0
try {
  const base = buildAndVerify()
  if (base.status !== 0) {
    console.error(`the unbroken copy does not pass, so no control can be read:\n${base.out}`)
    process.exit(1)
  }
  for (const c of CONTROLS) {
    const path = join(copy, c.file)
    const before = readFileSync(path, 'utf8')
    if (!before.includes(c.from)) {
      console.error(`CONTROL BROKEN  ${c.file} no longer holds ${JSON.stringify(c.from)}`)
      bad++
      continue
    }
    writeFileSync(path, before.replace(c.from, c.to))
    const run = buildAndVerify()
    writeFileSync(path, before)
    if (run.status !== 0 && c.expect.test(run.out)) console.log(`control bites  against ${c.why}`)
    else {
      console.error(`CONTROL MISSED  against ${c.why}: exit ${run.status}, wanted ${c.expect}\n${run.out.slice(-1500)}`)
      bad++
    }
  }
} finally {
  for (const l of links) if (existsSync(l)) unlinkSync(l)
  rmSync(copy, { recursive: true, force: true })
  for (const real of [join(repo, 'node_modules', 'typescript'), join(page, 'node_modules', 'vite')])
    if (!existsSync(real)) console.error(`the installed packages are gone from ${real}: reinstall them`)
}
if (bad) process.exit(1)
console.log(`controls ok: ${CONTROLS.length} of ${CONTROLS.length} page controls make a gate fail`)
