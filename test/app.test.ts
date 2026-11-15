import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { main, VERSION } from '../src/app.ts'

const run = async (...argv: string[]) => {
  let out = ''
  let err = ''
  const code = await main(argv, { out: (s) => (out += s), err: (s) => (err += s) })
  return { code, out, err }
}

test('--version prints the version package.json holds', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(VERSION, pkg.version)
  assert.deepEqual(await run('--version'), { code: 0, out: `${pkg.version}\n`, err: '' })
})

test('the exact grader with nothing to compare against is refused before anything runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evalbar-app-'))
  try {
    const suite = join(dir, 'cases.jsonl')
    writeFileSync(suite, ['{"input": "a", "expected": "x"}', '{"input": "b"}', '{"input": "c"}', ''].join('\n'))
    const r = await run('run', suite, '--command', 'node never-started.mjs', '--out', join(dir, 'out'))
    assert.equal(r.code, 2)
    assert.match(r.err, /the exact grader compares each answer with "expected", and 2 of 3 cases have none \(the first on line 2\)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('help lists no command that does not exist', async () => {
  const { out } = await run('--help')
  const listed = [...out.matchAll(/^ {2}evalbar (\S+)/gm)].map((m) => m[1])
  assert.deepEqual(listed, ['run', 'report', 'compare', 'calibrate', 'import', '--version', '--help'])
})

test('help lists every flag the parser accepts, and no other', async () => {
  const { out } = await run('--help')
  const listed = new Set([...out.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]))
  // the flags each command hands to parseArgs, read from the source because they are declared inside the commands
  const src = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')
  const declared = new Set([...src.matchAll(/'?([a-z][a-z-]*)'?: \{ type: '(?:string|boolean)'/g)].map((m) => m[1]))
  declared.add('version').add('help')
  assert.deepEqual([...listed].sort(), [...declared].sort())
})
