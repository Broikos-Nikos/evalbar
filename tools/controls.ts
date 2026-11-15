/**
 * Every gate's control: the broken state made on a throwaway clone, the gate run
 * against it from this working tree, and its failure required.
 *
 *   npm run controls
 *
 * The build contract's rule is that a control which passes means the gate is
 * wrong, and in this workspace it has never once meant the gate was right. So
 * each control names the failure lines it expects, and a control that exits 1
 * for some other reason (a crash, a missing file) fails here too: a gate that
 * dies on a broken tree has not caught anything.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, unlinkSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

type Control = { gate: string; script: string; why: string; breakIt: (dir: string) => void; expect: RegExp[] }

const commit = (dir: string, who: string, message: string) => {
  execFileSync('git', ['-C', dir, 'add', '-A'])
  execFileSync('git', ['-C', dir, '-c', `user.name=${who}`, '-c', 'user.email=someone@example.test', 'commit', '-q', '-m', message])
}

const CONTROLS: Control[] = [
  {
    gate: 'check:source',
    script: 'tools/check-source.ts',
    why: 'an en dash in the README, and a commit by someone else with a trailer and a tool named',
    breakIt: (dir) => {
      appendFileSync(join(dir, 'README.md'), `\nA claim ${String.fromCodePoint(0x2013)} with a dash.\n`)
      commit(dir, 'Someone Else', 'Add a line\n\nWritten with claude.\n\nCo-Authored-By: A Helper <helper@example.test>')
    },
    expect: [/README\.md:\d+ has an en or em dash/, /is authored by Someone Else/, /carries a trailer: Co-Authored-By/, /names a coding tool: claude/],
  },
  {
    gate: 'check:licence',
    script: 'tools/check-licence.ts',
    why: 'the LICENSE file deleted while the README still says MIT',
    breakIt: (dir) => unlinkSync(join(dir, 'LICENSE')),
    expect: [/the README claims MIT and there is no LICENSE file/],
  },
]

let bad = 0
for (const c of CONTROLS) {
  const dir = mkdtempSync(join(tmpdir(), 'evalbar-control-'))
  try {
    execFileSync('git', ['clone', '-q', '--local', root, dir])
    c.breakIt(dir)
    const run = spawnSync(process.execPath, [join(root, c.script), '--root', dir], { encoding: 'utf8' })
    const out = `${run.stdout}${run.stderr}`
    const missing = c.expect.filter((re) => !re.test(out))
    if (run.status !== 1 || missing.length) {
      bad++
      console.error(`CONTROL PASSED  ${c.gate}, against ${c.why}: exit ${run.status}, missing ${missing.map(String).join(', ') || 'nothing'}`)
      console.error(out.trim().replace(/^/gm, '    '))
    } else {
      console.log(`control bites  ${c.gate}, against ${c.why}:`)
      console.log(out.trim().replace(/^/gm, '    '))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
if (bad) process.exit(1)
console.log(`controls ok: ${CONTROLS.length} of ${CONTROLS.length} gates fail on their broken state`)
