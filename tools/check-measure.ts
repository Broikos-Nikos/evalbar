/**
 * Every committed measurement is what its command prints today.
 *
 *   npm run check:measure
 *
 * A number in the README or the devlog is quoted from a file under
 * measurements/, and that file is quoted from a command. If the command and the
 * file disagree, every quotation of the file is about a document nobody can
 * produce. So each measurement is run again into a scratch file and compared
 * byte for byte with the one committed. They are seeded, so any difference is
 * a change in the code they measure or in the file, and both are findings.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { root: { type: 'string' } } })
const root = resolve(values.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'))

const MEASUREMENTS = [
  { script: 'tools/measure/tag-verdicts.ts', output: 'measurements/tag-verdicts.json' },
  { script: 'tools/measure/clusters.ts', output: 'measurements/clusters.json' },
]

const fails: string[] = []
const scratch = mkdtempSync(join(tmpdir(), 'evalbar-measure-'))
try {
  for (const m of MEASUREMENTS) {
    const committed = join(root, m.output)
    if (!existsSync(committed)) {
      fails.push(`${m.output} is not committed: run node ${m.script}`)
      continue
    }
    const fresh = join(scratch, 'out.json')
    const run = spawnSync(process.execPath, [join(root, m.script)], { cwd: root, env: { ...process.env, EVALBAR_MEASURE_OUT: fresh }, encoding: 'utf8' })
    if (run.status !== 0) {
      fails.push(`${m.script} exited ${run.status}: ${run.stderr.trim().split('\n').slice(-1)[0]}`)
      continue
    }
    const a = readFileSync(committed, 'utf8').replace(/\r\n/g, '\n')
    const b = readFileSync(fresh, 'utf8')
    if (a !== b) {
      const la = a.split('\n')
      const lb = b.split('\n')
      const i = la.findIndex((l, j) => l !== lb[j])
      fails.push(`${m.output} is not what ${m.script} prints today; first difference at line ${i + 1}:\n      committed ${la[i]?.trim()}\n      today     ${lb[i]?.trim()}`)
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
if (fails.length) {
  console.error(fails.map((f) => 'FAIL  ' + f).join('\n'))
  process.exit(1)
}
console.log(`check:measure ok: ${MEASUREMENTS.length} measurements run again and identical to the committed files`)
