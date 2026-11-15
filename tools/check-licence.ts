/**
 * The repository carries the licence its README claims.
 *
 *   npm run check:licence
 *
 * Taken from logs-to-evals, where it exists because three repositories in this
 * workspace once said MIT in prose with no LICENSE behind it, and one shipped a
 * licence with its template placeholders still in.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { root: { type: 'string' } } })
const root = resolve(values.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
const fails: string[] = []

if (!/\bMIT\b/.test(readme)) fails.push('the README names no licence')
const path = resolve(root, 'LICENSE')
if (!existsSync(path)) fails.push('the README claims MIT and there is no LICENSE file')
else {
  const text = readFileSync(path, 'utf8')
  if (!/^MIT License/.test(text)) fails.push('LICENSE does not start with "MIT License"')
  if (!/Copyright \(c\) 20\d\d \S+/.test(text)) fails.push('LICENSE names no year and holder')
  if (/\[(year|yyyy|fullname|name of copyright owner)\]/i.test(text)) fails.push('LICENSE still has a template placeholder')
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { license?: string }
  if (pkg.license !== 'MIT') fails.push(`package.json says ${pkg.license}, the README says MIT`)
}
if (fails.length) {
  console.error(fails.map((f) => 'FAIL  ' + f).join('\n'))
  process.exit(1)
}
console.log('check:licence ok: README, LICENSE and package.json all say MIT, with a holder and no placeholder')
