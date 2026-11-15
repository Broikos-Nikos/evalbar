/**
 * Every gate's control: the broken state made on a throwaway copy, the gate run
 * against it, and its failure required.
 *
 *   npm run controls
 *
 * The copy is a clone of HEAD with this working tree laid over it, so a control
 * tests the gate as it is now, before the commit that adds it, with the history
 * the commit checks need.
 *
 * The build contract's rule is that a control which passes means the gate is
 * wrong, and in this workspace it has never once meant the gate was right. So
 * each control names the failure lines it expects, and a control that exits 1
 * for another reason (a crash, a missing file) fails here too: a gate that dies
 * on a broken tree has caught nothing. A mutation whose target text is gone
 * throws, so a control cannot drift into breaking nothing.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

type Control = {
  gate: string
  why: string
  breakIt: (dir: string) => void
  /** the command, run with the copy as its working directory */
  run: (dir: string) => string[]
  expect: RegExp[]
}

const commit = (dir: string, who: string, message: string) => {
  execFileSync('git', ['-C', dir, 'add', '-A'])
  execFileSync('git', ['-C', dir, '-c', `user.name=${who}`, '-c', 'user.email=someone@example.test', 'commit', '-q', '-m', message])
}

/** Replace text that must be there. */
const mutate = (dir: string, file: string, from: string, to: string) => {
  const path = join(dir, file)
  const text = readFileSync(path, 'utf8')
  if (!text.includes(from)) throw new Error(`control is stale: ${file} no longer contains ${JSON.stringify(from.slice(0, 60))}`)
  writeFileSync(path, text.replace(from, to))
}

const gate = (script: string) => (dir: string) => [process.execPath, join(root, script), '--root', dir]
const tests = (file: string) => () => [process.execPath, '--test', file]

const CONTROLS: Control[] = [
  {
    gate: 'check:source',
    why: 'an en dash in the README, and a commit by someone else with a trailer and a tool named',
    breakIt: (dir) => {
      appendFileSync(join(dir, 'README.md'), `\nA claim ${String.fromCodePoint(0x2013)} with a dash.\n`)
      commit(dir, 'Someone Else', 'Add a line\n\nWritten with claude.\n\nCo-Authored-By: A Helper <helper@example.test>')
    },
    run: gate('tools/check-source.ts'),
    expect: [/README\.md:\d+ has an en or em dash/, /is authored by Someone Else/, /carries a trailer: Co-Authored-By/, /names a coding tool: claude/],
  },
  {
    gate: 'check:licence',
    why: 'the LICENSE file deleted while the README still says MIT',
    breakIt: (dir) => unlinkSync(join(dir, 'LICENSE')),
    run: gate('tools/check-licence.ts'),
    expect: [/the README claims MIT and there is no LICENSE file/],
  },
  {
    gate: 'check:vendor',
    why: 'one character of the vendored evalkit power.mjs changed, Z80 from 0.84 to 0.85',
    breakIt: (dir) => mutate(dir, 'src/vendor/evalkit/power.mjs', 'Z80 = 0.84', 'Z80 = 0.85'),
    run: gate('tools/check-vendor.ts'),
    expect: [/src\/vendor\/evalkit\/power\.mjs has sha256 \w+, the manifest says c04801b9df94/],
  },
  {
    gate: 'test/stats.test.ts',
    why: "Wald's interval in place of Wilson's",
    breakIt: (dir) => {
      mutate(dir, 'src/stats.ts', 'const centre = (p + z2 / (2 * n)) / (1 + z2 / n)', 'const centre = p + 0 * z2')
      mutate(dir, 'src/stats.ts', 'const half = (z / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))', 'const half = z * Math.sqrt((p * (1 - p)) / n)')
    },
    run: tests('test/stats.test.ts'),
    expect: [/✖ Wilson intervals equal statsmodels/, /✖ 20 of 20 does not clear a bar of 0\.85/],
  },
  {
    gate: 'test/stats.test.ts',
    why: 'a bar verdict that refuses everything',
    breakIt: (dir) => {
      mutate(dir, 'src/stats.ts', "if (lo >= bar - EPS) return { ...base, verdict: 'pass', needed: null }", "if (lo > 2) return { ...base, verdict: 'pass', needed: null }")
      mutate(dir, 'src/stats.ts', "if (hi < bar - EPS) return { ...base, verdict: 'fail', needed: null }", "if (hi < -1) return { ...base, verdict: 'fail', needed: null }")
    },
    run: tests('test/stats.test.ts'),
    expect: [/✖ the three verdicts, each where it belongs/],
  },
  {
    gate: 'test/stats.test.ts',
    why: 'a bar verdict that decides everything on the point estimate, as most tools do',
    breakIt: (dir) =>
      mutate(dir, 'src/stats.ts', "return { ...base, verdict: 'cannot tell', needed: casesToDecide(k / n, bar, n) }", "return { ...base, verdict: k / n >= bar ? 'pass' : 'fail', needed: null }"),
    run: tests('test/stats.test.ts'),
    expect: [/✖ 20 of 20 does not clear a bar of 0\.85/, /✖ the three verdicts, each where it belongs/],
  },
  {
    gate: 'test/stats.test.ts',
    why: 'a comparison that refuses everything',
    breakIt: (dir) => mutate(dir, 'src/stats.ts', "const verdict = lo > EPS ? 'better' : hi < -EPS ? 'worse' : 'refused'", "const verdict = 'refused' as Comparison['verdict']"),
    run: tests('test/stats.test.ts'),
    expect: [/✖ two published figures come out as published/],
  },
  {
    gate: 'test/greek.test.ts',
    why: 'the capitals rule taken out of the comparison',
    breakIt: (dir) => mutate(dir, 'src/text.ts', 'if (i % 2 === 1 && (inCapitals(pa[i]) || inCapitals(pb[i]))', 'if (i < 0 && (inCapitals(pa[i]) || inCapitals(pb[i]))'),
    run: tests('test/greek.test.ts'),
    expect: [/✖ capitals drop the tonos/, /✖ one sigma, two letters/],
  },
  {
    gate: 'test/greek.test.ts',
    why: 'every accent stripped everywhere, the fix that passes wrong answers',
    breakIt: (dir) => mutate(dir, 'src/text.ts', 'const x = fold(pa[i])\n    const y = fold(pb[i])', 'const x = stripMarks(fold(pa[i]))\n    const y = stripMarks(fold(pb[i]))'),
    run: tests('test/greek.test.ts'),
    expect: [/✖ accents count where they could be written/],
  },
  {
    gate: 'test/greek.test.ts',
    why: 'folding without the final sigma',
    breakIt: (dir) => mutate(dir, 'src/text.ts', ".replace(/ς/g, 'σ')", ''),
    run: tests('test/greek.test.ts'),
    expect: [/✖ one sigma, two letters/],
  },
  {
    gate: 'test/greek.test.ts',
    why: "Node's forgiving UTF-8 read, which turns a windows-1253 file into replacement characters",
    breakIt: (dir) => {
      mutate(dir, 'src/read.ts', 'const bad = firstBadUtf8(body)', 'const bad = -1 + 0 * firstBadUtf8(body)')
      mutate(dir, 'src/read.ts', "if (bad === -1) return new TextDecoder('utf-8', { fatal: true }).decode(body)", "if (bad === -1) return new TextDecoder('utf-8').decode(body)")
    },
    run: tests('test/greek.test.ts'),
    expect: [/✖ a file in windows-1253 is refused with its line and byte/],
  },
  {
    gate: 'test/greek.test.ts',
    why: "JavaScript's ASCII word boundary in place of one that sees Greek letters",
    breakIt: (dir) => mutate(dir, 'src/text.ts', '`(?<![\\\\p{L}\\\\p{M}\\\\p{N}_])${escaped}(?![\\\\p{L}\\\\p{M}\\\\p{N}_])`', '`\\\\b${escaped}\\\\b`'),
    run: tests('test/greek.test.ts'),
    expect: [/✖ a word boundary that sees Greek letters/],
  },
  {
    gate: 'test/greek.test.ts',
    why: 'the exact grader unwrapping before NFC, the defect tick 3 measured and the tests had missed',
    breakIt: (dir) => mutate(dir, 'src/graders/exact.ts', 'const text = nfc(s)', 'const text = s + nfc("")'),
    run: tests('test/greek.test.ts'),
    expect: [/✖ the Greek question mark is a semicolon/],
  },
]

/** A clone of HEAD with the working tree's files, tracked and untracked, laid over it. */
function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'evalbar-control-'))
  execFileSync('git', ['clone', '-q', '--local', root, dir])
  const files = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  for (const rel of files.split('\0').filter(Boolean)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    try {
      copyFileSync(join(root, rel), join(dir, rel))
    } catch {
      // deleted in the working tree: the copy keeps HEAD's version, which a control may then break
    }
  }
  return dir
}

let bad = 0
for (const c of CONTROLS) {
  const dir = copy()
  try {
    c.breakIt(dir)
    const [cmd, ...args] = c.run(dir)
    const run = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8' })
    const out = `${run.stdout}${run.stderr}`
    const missing = c.expect.filter((re) => !re.test(out))
    const lines = out.split('\n').filter((l) => /FAIL|✖/.test(l) && !/failing tests/.test(l))
    const shown = [...new Set(lines.map((l) => l.trim()))].slice(0, 6).map((l) => `    ${l}`).join('\n')
    if (run.status !== 1 || missing.length) {
      bad++
      console.error(`CONTROL PASSED  ${c.gate}, against ${c.why}: exit ${run.status}, missing ${missing.map(String).join(', ') || 'nothing'}`)
      console.error(out.trim().replace(/^/gm, '    '))
    } else {
      console.log(`control bites  ${c.gate}, against ${c.why}:\n${shown}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
if (bad) process.exit(1)
console.log(`controls ok: ${CONTROLS.length} of ${CONTROLS.length} controls make their gate fail`)
