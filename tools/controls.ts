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
    why: "Wald's arithmetic inside wilson(), which the planning figure and the measurement still use",
    breakIt: (dir) => {
      mutate(dir, 'src/stats.ts', 'const centre = (p + z2 / (2 * n)) / (1 + z2 / n)', 'const centre = p + 0 * z2')
      mutate(dir, 'src/stats.ts', 'const half = (z / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))', 'const half = z * Math.sqrt((p * (1 - p)) / n)')
    },
    run: tests('test/stats.test.ts'),
    expect: [/✖ Wilson intervals equal statsmodels/],
  },
  {
    gate: 'test/stats.test.ts',
    why: "Wald's interval under the bar verdict, which calls 20 of 20 a certainty",
    breakIt: (dir) =>
      mutate(
        dir,
        'src/stats.ts',
        '  const { lo, hi } = exactInterval(k, n)\n  const base = { k, n, rate: k / n, lo, hi, bar }',
        '  const half = Z95 * Math.sqrt(((k / n) * (1 - k / n)) / n)\n  const lo = k / n - half\n  const hi = k / n + half\n  const base = { k, n, rate: k / n, lo, hi, bar }',
      ),
    run: tests('test/stats.test.ts'),
    // the one-tag test does not catch Wald, its five cases being decided alike by both: only Wilson's interval differs there
    expect: [/✖ 20 of 20 does not clear a bar of 0\.85/],
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
  {
    gate: 'test/run.test.ts',
    why: 'an infrastructure error written as a failed case, the conflation 07-evaluation/01 calls the central failure',
    breakIt: (dir) => mutate(dir, 'src/run.ts', 'appendFileSync(errorsPath, `${JSON.stringify(row)}\\n`)', "appendFileSync(resultsPath, JSON.stringify({ ...row, pass: false, status: 'graded' }) + '\\n')"),
    run: tests('test/run.test.ts'),
    expect: [/✖ a 429 that does not clear is an error/, /✖ a stalled endpoint times out per case and lands in errors/],
  },
  {
    gate: 'test/run.test.ts',
    why: 'an answer cut off by the token limit graded as wrong',
    breakIt: (dir) => mutate(dir, 'src/run.ts', "const truncated = reply.finish === 'length'", 'const truncated = reply.finish === null && false'),
    run: tests('test/run.test.ts'),
    expect: [/✖ an answer cut off by the token limit is counted, not graded/],
  },
  {
    gate: 'test/run.test.ts',
    why: 'a missing usage block recorded as zero tokens',
    breakIt: (dir) => mutate(dir, 'src/providers/openai.ts', '        : null\n    return {', '        : { input: 0, output: 0, cachedInput: 0 }\n    return {'),
    run: tests('test/run.test.ts'),
    expect: [/✖ no usage block is recorded as unknown, not as zero/],
  },
  {
    gate: 'test/run.test.ts',
    why: 'no canary: the first case runs alongside the others',
    breakIt: (dir) => mutate(dir, 'src/run.ts', 'const first = queue.shift()', 'const first = queue.length < 0 ? queue.shift() : undefined'),
    run: tests('test/run.test.ts'),
    expect: [/✖ a bad key stops the run after the first case/],
  },
  {
    gate: 'test/run.test.ts',
    why: 'a first case that cannot reach the system treated as one bad case, which is how tick 4 found the runner',
    breakIt: (dir) => mutate(dir, 'src/run.ts', "if (e && !aborted && (e.kind === 'network'", "if (e && aborted === 'never' && (e.kind === 'network'"),
    run: tests('test/run.test.ts'),
    expect: [/✖ a command that cannot start stops the run at the first case/],
  },
  {
    gate: 'test/report.test.ts',
    why: 'the report read back from report.json instead of rebuilt from the rows',
    breakIt: (dir) =>
      mutate(
        dir,
        'src/app.ts',
        'const r = buildReport(run.config, run.rows, run.errors, name ?? run.config.suite)',
        "const fresh = buildReport(run.config, run.rows, run.errors, name ?? run.config.suite)\n  const old = existsSync(join(dir, 'report.json')) ? JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) : {}\n  const r = { ...fresh, passed: old.passed ?? fresh.passed, graded: old.graded ?? fresh.graded, rate: old.rate?.n ? { ...fresh.rate, ...old.rate, rate: old.rate.k / old.rate.n } : fresh.rate }",
      ),
    run: tests('test/report.test.ts'),
    expect: [/✖ the report is rebuilt from the rows, whatever report.json says/],
  },
  {
    gate: 'test/report.test.ts',
    why: 'per-tag verdicts taken one by one, with no adjustment for the number of tags',
    breakIt: (dir) => mutate(dir, 'src/report.ts', 'const decided = holm(ps)', 'const decided = ps.map((x) => x <= 0.05)'),
    run: tests('test/report.test.ts'),
    expect: [/✖ twenty tags at 16 of 20 against 0\.95: each alone fails, together Holm cannot tell/],
  },
  {
    gate: 'test/report.test.ts',
    why: 'the cases kept out of the rate never weighed against the verdict',
    breakIt: (dir) => mutate(dir, 'src/report.ts', 'const sensitivity =\n    verdict && out', 'const sensitivity =\n    verdict && out < 0'),
    run: tests('test/report.test.ts'),
    expect: [/✖ cases kept out of the rate that could turn the verdict over are named/],
  },
  {
    gate: 'test/stats.test.ts',
    why: "Wilson's interval back under the verdict, the one tick 5 measured missing its level",
    breakIt: (dir) => mutate(dir, 'src/stats.ts', '  const { lo, hi } = exactInterval(k, n)\n  const base = { k, n, rate: k / n, lo, hi, bar }', '  const { lo, hi } = wilson(k, n)\n  const base = { k, n, rate: k / n, lo, hi, bar }'),
    run: tests('test/stats.test.ts'),
    expect: [/✖ one tag alone gets the verdict the whole suite gets/],
  },
  {
    gate: 'test/clusters.test.ts',
    why: 'the report counting every case as independent, clusters or not',
    breakIt: (dir) => mutate(dir, 'src/report.ts', 'const factor = clusters?.factor ?? 1', 'const factor = clusters ? 1 : 1'),
    run: tests('test/clusters.test.ts'),
    expect: [/✖ 20 near-copies a cluster, 9 clusters right and 1 wrong/, /✖ 20 near-copies a cluster, all right/],
  },
  {
    gate: 'test/clusters.test.ts',
    why: "Korn and Graubard's own rule at a rate of 1, a design effect of 1, which counts 20 near-copies as 20 cases",
    breakIt: (dir) => mutate(dir, 'src/stats.ts', '    base = G\n    deff = n / G', '    base = n\n    deff = 1'),
    run: tests('test/clusters.test.ts'),
    expect: [/✖ 20 near-copies a cluster, all right: the naive count clears 0\.95, the clusters cannot/],
  },
  {
    gate: 'test/clusters.test.ts',
    why: 'no allowance for estimating the variance from few clusters',
    breakIt: (dir) => mutate(dir, 'src/stats.ts', 'const dfFactor = (tQuantile(0.975, n - 1) / tQuantile(0.975, G - 1)) ** 2', 'const dfFactor = 1 + 0 * tQuantile(0.975, G - 1)'),
    run: tests('test/clusters.test.ts'),
    expect: [/✖ 20 near-copies a cluster, 9 clusters right and 1 wrong/],
  },
  {
    gate: 'test/clusters.test.ts',
    why: 'compare pairing case by case whatever the clusters',
    breakIt: (dir) => mutate(dir, 'src/report.ts', 'const clustered = byCluster.size < n', 'const clustered = byCluster.size < 0'),
    run: tests('test/clusters.test.ts'),
    expect: [/✖ families that flip together: Tango calls B better, the clustered test refuses/],
  },
  {
    gate: 'check:vendor',
    why: 'a file dropped into an example vendor folder without a manifest entry',
    breakIt: (dir) => writeFileSync(join(dir, 'examples/semantic-cache/vendor/semcache/lib/extra.ts'), 'export const x = 1\n'),
    run: gate('tools/check-vendor.ts'),
    expect: [/examples\/semantic-cache\/vendor\/semcache\/lib\/extra\.ts is in a vendor folder and not in the manifest/],
  },
  {
    gate: 'check:measure',
    why: "the cache example's digits guard switched off, the code the headline measures",
    breakIt: (dir) => mutate(dir, 'examples/semantic-cache/system.ts', 'const guards = { none: null, digits, names: digitsAndNames(CATALOG) } as const', 'const guards = { none: null, digits: null, names: digitsAndNames(CATALOG) } as const'),
    run: gate('tools/check-measure.ts'),
    expect: [/measurements\/semantic-cache\.json is not what tools\/measure\/semantic-cache\.ts prints today/],
  },
  {
    gate: 'check:measure',
    why: 'one number in the committed measurement changed by hand',
    breakIt: (dir) => mutate(dir, 'measurements/tag-verdicts.json', '"wilson": 0.0432', '"wilson": 0.0250'),
    run: gate('tools/check-measure.ts'),
    expect: [/measurements\/tag-verdicts\.json is not what tools\/measure\/tag-verdicts\.ts prints today/, /committed "wilson": 0\.025/],
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
