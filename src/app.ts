/**
 * The command line, as a function: arguments in, an exit code out, text written
 * to the two streams it is given. `cli.ts` hands it the real ones; the tests
 * hand it buffers, so what a user would see is what the tests read.
 *
 * Only the commands that exist are listed. A help screen naming a command still
 * being written is a claim the tool cannot back, and this one is read by
 * strangers deciding in a minute whether it works.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { loadCases } from './cases.ts'
import { UserError } from './errors.ts'
import { gradeExact } from './graders/exact.ts'
import { commandProvider } from './providers/command.ts'
import { openaiProvider } from './providers/openai.ts'
import { ProviderError, type Provider } from './providers/types.ts'
import { buildReport, compareExit, exitCode, pairRuns, renderComparison, renderReport } from './report.ts'
import { readRows, runSuite, sha256, type ErrorRow, type Grader, type Prices, type Row, type RunConfig } from './run.ts'
import { resolveSuite } from './suite.ts'

export type Io = { out: (s: string) => void; err: (s: string) => void }

export const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

const HELP = `evalbar ${VERSION}

Usage
  evalbar run <suite> [options]     every case through a model or your command, graded
  evalbar report <run>              the report again, recomputed from the run's rows
  evalbar compare <run A> <run B> [--margin <rate>]   two runs on the same cases, paired
  evalbar --version
  evalbar --help

A suite is a JSONL file of cases, or a folder with cases.jsonl and suite.json.

run, the system under test (one of)
  --base-url <url> --model <name>   any OpenAI-compatible endpoint, cloud or local
  --api-key-env <NAME>              the environment variable holding its key
  --system <text>                   a system prompt for every case
  --temperature <n>  --seed <n>  --max-tokens <n>
  --command "<cmd>"                 your own program: one JSON line in, one out

run, the rest
  --grader exact                    the grader (exact is the default)
  --bar <rate>                      the pass rate it must clear, 0 to 1
  --price-in <usd> --price-out <usd> [--price-cached <usd>]   per million tokens
  --out <dir>                       where results go (default .evalbar/runs/<time>)
  --concurrency <n>  --timeout <seconds>  --retries <n>  --encoding <name>

Exit codes: 0 pass (or no bar), 1 fail, 3 cannot tell, 2 the run could not be made.
compare: 0 B better (or, with --margin, not worse by it), 1 B worse, 3 cannot tell.
`

class UsageError extends UserError {}

const num = (v: unknown, flag: string, min = -Infinity, max = Infinity): number | undefined => {
  if (v === undefined) return undefined
  const n = Number(v)
  if (typeof v !== 'string' || !v.trim() || !Number.isFinite(n) || n < min || n > max) throw new UsageError(`${flag} wants a number from ${min} to ${max}, got ${String(v)}`)
  return n
}

async function run(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'base-url': { type: 'string' },
      model: { type: 'string' },
      'api-key-env': { type: 'string' },
      system: { type: 'string' },
      temperature: { type: 'string' },
      seed: { type: 'string' },
      'max-tokens': { type: 'string' },
      command: { type: 'string' },
      grader: { type: 'string' },
      bar: { type: 'string' },
      'price-in': { type: 'string' },
      'price-out': { type: 'string' },
      'price-cached': { type: 'string' },
      out: { type: 'string' },
      concurrency: { type: 'string' },
      timeout: { type: 'string' },
      retries: { type: 'string' },
      encoding: { type: 'string' },
    },
  })
  if (positionals.length !== 1) throw new UsageError('run wants one suite: a JSONL file, or a folder with cases.jsonl')
  const suite = resolveSuite(positionals[0])
  const cfg = suite.config
  const p = cfg.provider ?? {}
  const command = values.command ?? (values['base-url'] ? undefined : p.command)
  const baseUrl = values['base-url'] ?? (values.command ? undefined : p.baseUrl)
  if (!command && !baseUrl) throw new UsageError('say what to run: --base-url and --model for an endpoint, or --command for your own program')
  if (command && baseUrl) throw new UsageError('--command and --base-url both given: pick one system under test')
  const model = values.model ?? p.model
  if (baseUrl && !model) throw new UsageError('--base-url needs --model')

  const bar = num(values.bar, '--bar', 0, 1) ?? cfg.bar ?? null
  const timeoutMs = (num(values.timeout, '--timeout', 0.001) ?? 60) * 1000
  const retries = num(values.retries, '--retries', 0, 10) ?? 3
  const priceIn = num(values['price-in'], '--price-in', 0)
  const priceOut = num(values['price-out'], '--price-out', 0)
  if ((priceIn === undefined) !== (priceOut === undefined)) throw new UsageError('--price-in and --price-out go together')
  const prices: Prices | null =
    priceIn !== undefined && priceOut !== undefined ? { input: priceIn, output: priceOut, cachedInput: num(values['price-cached'], '--price-cached', 0) } : (cfg.prices ?? null)
  const temperature = num(values.temperature, '--temperature', 0, 2) ?? p.temperature
  const seed = num(values.seed, '--seed', 0)
  if (command && (values.temperature !== undefined || seed !== undefined)) throw new UsageError('--temperature and --seed go to an endpoint; your own command sets its own')

  const graderName = values.grader ?? (typeof cfg.grader === 'string' ? cfg.grader : 'exact')
  if (graderName !== 'exact') throw new UsageError(`unknown grader "${graderName}": this version has exact`)
  const grader: Grader = { name: 'exact', grade: (c, out) => gradeExact(out, c.expected) }

  const cases = loadCases(suite.casesPath, values.encoding ?? cfg.encoding)
  const provider: Provider = command
    ? commandProvider({ command, cwd: suite.dir, timeoutMs })
    : openaiProvider({
        baseUrl: baseUrl!,
        model: model!,
        apiKeyEnv: values['api-key-env'] ?? p.apiKeyEnv,
        system: values.system ?? p.system,
        temperature,
        seed,
        maxTokens: num(values['max-tokens'], '--max-tokens', 1) ?? p.maxTokens,
        timeoutMs,
        retries,
      })
  const concurrency = num(values.concurrency, '--concurrency', 1, 64) ?? (command ? 1 : 4)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
  const outDir = resolve(values.out ?? join('.evalbar', 'runs', `${stamp}-${suite.name}`))

  const config: RunConfig = {
    evalbar: VERSION,
    suite: suite.casesPath,
    suiteSha256: sha256(readFileSync(suite.casesPath)),
    cases: cases.length,
    provider: provider.describe,
    requestedModel: model ?? null,
    grader: grader.name,
    bar,
    // a command decides its own sampling; nothing evalbar sends makes it draw
    temperature: command ? 0 : (temperature ?? null),
    seed: seed ?? null,
    prices,
    graderPrices: null,
    startedAt: new Date().toISOString(),
  }
  io.err(`evalbar: ${cases.length} cases from ${suite.casesPath}\n  through ${provider.describe}, graded ${grader.name}${bar !== null ? `, against a bar of ${bar}` : ''}\n  rows to ${outDir}\n`)
  let outcome
  try {
    outcome = await runSuite({ cases, provider, grader, outDir, concurrency, config })
  } finally {
    await provider.close()
  }
  if (outcome.skipped) io.err(`  ${outcome.skipped} cases were already done in this folder and were not run again\n`)
  const code = report(outDir, io, suite.name)
  if (outcome.aborted) {
    io.err(`evalbar: stopped after ${outcome.aborted}\n`)
    return 2
  }
  return code
}

/** A run folder's rows. The report is rebuilt from them every time, and report.json is never read back. */
function loadRun(dir: string): { config: RunConfig; rows: Row[]; errors: ErrorRow[] } {
  const runPath = join(dir, 'run.json')
  if (!existsSync(runPath)) throw new UsageError(`${dir}: not a run folder (no run.json)`)
  return {
    config: JSON.parse(readFileSync(runPath, 'utf8')) as RunConfig,
    rows: readRows<Row>(join(dir, 'results.jsonl')),
    errors: readRows<ErrorRow>(join(dir, 'errors.jsonl')),
  }
}

function report(dir: string, io: Io, name?: string): number {
  const run = loadRun(dir)
  const r = buildReport(run.config, run.rows, run.errors, name ?? run.config.suite)
  const text = renderReport(r)
  writeFileSync(join(dir, 'report.txt'), text)
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(r, null, 2)}\n`)
  io.out(text)
  return exitCode(r)
}

function compareRuns(argv: string[], io: Io): number {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { margin: { type: 'string' } } })
  if (positionals.length !== 2) throw new UsageError('compare wants two run folders: the first is A, the second B')
  const margin = num(values.margin, '--margin', 0, 1) ?? null
  const [a, b] = positionals.map((d) => loadRun(resolve(d)))
  const p = pairRuns(a, b, margin)
  io.out(renderComparison(p, positionals[0], positionals[1]))
  return compareExit(p)
}

export async function main(argv: string[], io: Io): Promise<number> {
  const [cmd, ...rest] = argv
  try {
    if (cmd === 'run') return await run(rest, io)
    if (cmd === 'report') {
      if (rest.length !== 1) throw new UsageError('report wants one run folder')
      return report(resolve(rest[0]), io)
    }
    if (cmd === 'compare') return compareRuns(rest, io)
    if (cmd === '--version') {
      io.out(`${VERSION}\n`)
      return 0
    }
    if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') {
      io.out(HELP)
      return 0
    }
    throw new UsageError(`unknown command "${cmd}"`)
  } catch (e) {
    const parse = (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')
    if (e instanceof UserError || e instanceof ProviderError || parse) {
      io.err(`evalbar: ${(e as Error).message}\n`)
      if (e instanceof UsageError || parse) io.err('evalbar --help lists the options\n')
      return 2
    }
    throw e
  }
}
