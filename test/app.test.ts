import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

test('help lists no command that does not exist', async () => {
  const { out } = await run('--help')
  const listed = [...out.matchAll(/^ {2}evalbar (\S+)/gm)].map((m) => m[1])
  assert.deepEqual(listed, ['--version', '--help'])
})
