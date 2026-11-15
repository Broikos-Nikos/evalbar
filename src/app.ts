/**
 * The command line, as a function: arguments in, an exit code out, text written
 * to the two streams it is given. `cli.ts` hands it the real ones; the tests
 * hand it buffers, so what a user would see is what the tests read.
 *
 * Only the commands that exist are listed. A help screen naming a command still
 * being written is a claim the tool cannot back, and this one is read by
 * strangers deciding in a minute whether it works.
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

export type Io = { out: (s: string) => void; err: (s: string) => void }

export const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

const HELP = `evalbar ${VERSION}

Usage
  evalbar --version
  evalbar --help
`

export async function main(argv: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { version: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
    strict: false,
  })
  if (values.version) {
    io.out(`${VERSION}\n`)
    return 0
  }
  io.out(HELP)
  return 0
}
