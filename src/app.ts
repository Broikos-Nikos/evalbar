/**
 * The command line, as a function: arguments in, an exit code out, text written
 * to the two streams it is given. `cli.ts` hands it the real ones; the tests
 * hand it buffers, so what a user would see is what the tests read.
 *
 * Only the commands that exist are listed. A help screen naming a command still
 * being written is a claim the tool cannot back, and this one is read by
 * strangers deciding in a minute whether it works.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { loadCases } from './cases.ts'
import { UserError } from './errors.ts'
import { gradeExact } from './graders/exact.ts'
import { judgeGrader } from './graders/judge.ts'
import { programGrader } from './graders/program.ts'
import { calibrate, loadLabels, readRecord } from './calibration.ts'
import { importLog, type Funnel } from './importer/import.ts'
import { spendSeal, writeSeal } from './importer/seal.ts'
import { parseJsonl, readText } from './read.ts'
import { commandProvider } from './providers/command.ts'
import { openaiProvider } from './providers/openai.ts'
import { ProviderError, type Provider } from './providers/types.ts'
import { buildReport, compareExit, exitCode, pairRuns, renderCalibration, renderComparison, renderReport } from './report.ts'
import { readRows, runSuite, sha256, type ErrorRow, type Grader, type Prices, type Row, type RunConfig } from './run.ts'
import { resolveSuite } from './suite.ts'

export type Io = { out: (s: string) => void; err: (s: string) => void }

export const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

const HELP = `evalbar ${VERSION}

Usage
  evalbar run <suite> [options]     every case through a model or your command, graded
  evalbar report <run>              the report again, recomputed from the run's rows
  evalbar compare <run A> <run B> [--margin <rate>]   two runs on the same cases, paired
  evalbar calibrate <labels> [judge options]   a judge against human labels, and its record
  evalbar import <log> --out <folder> [options]  a suite from production logs, scrubbed and sorted
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
  --grader exact | judge | program:<file>   exact (the default), a model judge, or your own module
  --bar <rate>                      the pass rate it must clear, 0 to 1
  --price-in <usd> --price-out <usd> [--price-cached <usd>]   per million tokens
  --out <dir>                       where results go (default .evalbar/runs/<time>)
  --concurrency <n>  --timeout <seconds>  --retries <n>  --encoding <name>
  --sealed                          score a sealed held-out file, spending one of its decisions

judge (for --grader judge, and for calibrate)
  --judge-base-url <url> --judge-model <name> [--judge-api-key-env <NAME>]
  --rubric <file>                   the property, as claims a reader can check
  --calibration <record>            the record calibrate wrote; without one the verdict is withheld
  --kappa-bar <k>                   the lowest kappa trusted, at the low end of its interval (0.6)
  --judge-price-in <usd> --judge-price-out <usd>
  --record <file>                   calibrate only: where the record goes (.evalbar/calibrations/)

import
  --input-field --output-field --time-field --source-field --cluster-field --signal-field --id-field
                                    which fields hold what, when the names are not the usual ones
  --min-chars <n>  --near <similarity>  --pick <n>   the length floor (12), duplicates (0.9), a budget
  --holdout-after <date> | --holdout-source <name>   held out to a sealed test.jsonl
  --budget <n>                      sealed runs allowed on it (3); run it with --sealed
  --names capitalised | off         scrub capitalised word pairs as names (the default), or not

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
      sealed: { type: 'boolean' },
      ...JUDGE_OPTIONS,
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

  // --grader program:<file> is relative to where you are; suite.json's {"program": file} to the suite's folder
  let grader: Grader
  let judge: RunConfig['judge'] = null
  let judgeProvider: Provider | null = null
  const flag = values.grader
  if (flag?.startsWith('program:')) grader = await programGrader(flag.slice('program:'.length))
  else if (!flag && cfg.grader && typeof cfg.grader === 'object') grader = await programGrader(cfg.grader.program, suite.dir)
  else {
    const name = flag ?? (typeof cfg.grader === 'string' ? cfg.grader : 'exact')
    if (name === 'judge') {
      const j = judgeFrom(values, timeoutMs, retries)
      judgeProvider = j.provider
      const g = judgeGrader(j.provider, j.rubric)
      grader = g
      const kappaBar = num(values['kappa-bar'], '--kappa-bar', -1, 1) ?? 0.6
      const record = values.calibration ? readRecord(values.calibration) : null
      // the record travels inside run.json without its per-item rows, so a run folder alone can be reported on
      judge = { promptSha256: g.promptSha256, requested: j.model, kappaBar, calibration: record ? (({ items: _items, ...rest }) => rest)(record) : null }
    } else if (name === 'exact') grader = { name: 'exact', grade: (c, out) => gradeExact(out, c.expected) }
    else throw new UsageError(`unknown grader "${name}": exact, judge, or program:<file>`)
  }

  const cases = loadCases(suite.casesPath, values.encoding ?? cfg.encoding)
  // the exact grader with nothing to compare against fails every case, and the report would read as a bad model:
  // the audit's first ten minutes did exactly that (tick 12), so it is refused here, before anything is spent
  if (grader.name === 'exact') {
    const usable = (x: unknown) => typeof x === 'string' || typeof x === 'number'
    const missing = cases.filter((c) => !(usable(c.expected) || (Array.isArray(c.expected) && c.expected.some(usable))))
    if (missing.length)
      throw new UsageError(
        `the exact grader compares each answer with "expected", and ${missing.length} of ${cases.length} cases have none (the first on line ${missing[0].line}); add it, or grade with --grader judge or --grader program:<file>`,
      )
  }
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
    // relative to where evalbar ran, with forward slashes: a run folder that gets committed must not carry this machine's paths
    suite: relative(process.cwd(), suite.casesPath).split(sep).join('/'),
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
    graderPrices: judgePrices(values),
    judge,
    startedAt: new Date().toISOString(),
  }
  const seal = spendSeal(suite.casesPath, values.sealed === true, provider.describe, cases.length)
  if (seal) io.err(`evalbar: a sealed run, ${seal.runs.length} of its ${seal.budget} decisions spent with this one\n`)
  io.err(`evalbar: ${cases.length} cases from ${suite.casesPath}\n  through ${provider.describe}, graded ${grader.name}${bar !== null ? `, against a bar of ${bar}` : ''}\n  rows to ${outDir}\n`)
  let outcome
  try {
    outcome = await runSuite({ cases, provider, grader, outDir, concurrency, config })
  } finally {
    await provider.close()
    await judgeProvider?.close()
  }
  if (outcome.skipped) io.err(`  ${outcome.skipped} cases were already done in this folder and were not run again\n`)
  const code = report(outDir, io, suite.name)
  if (outcome.aborted) {
    io.err(`evalbar: stopped after ${outcome.aborted}\n`)
    return 2
  }
  return code
}

const JUDGE_OPTIONS = {
  'judge-base-url': { type: 'string' },
  'judge-model': { type: 'string' },
  'judge-api-key-env': { type: 'string' },
  rubric: { type: 'string' },
  calibration: { type: 'string' },
  'kappa-bar': { type: 'string' },
  'judge-price-in': { type: 'string' },
  'judge-price-out': { type: 'string' },
} as const

type JudgeValues = { [K in keyof typeof JUDGE_OPTIONS]?: string | boolean }

/** The judge's endpoint and rubric from the flags; the judge always runs at temperature 0. */
function judgeFrom(values: JudgeValues, timeoutMs: number, retries: number): { provider: Provider; rubric: string; model: string } {
  const baseUrl = values['judge-base-url']
  const model = values['judge-model']
  const rubricPath = values.rubric
  if (typeof baseUrl !== 'string' || typeof model !== 'string' || typeof rubricPath !== 'string')
    throw new UsageError('a judge needs --judge-base-url, --judge-model and --rubric <file>')
  let rubric: string
  try {
    rubric = readFileSync(rubricPath, 'utf8')
  } catch {
    throw new UsageError(`the rubric ${rubricPath} cannot be read`)
  }
  const apiKeyEnv = typeof values['judge-api-key-env'] === 'string' ? values['judge-api-key-env'] : undefined
  return { provider: openaiProvider({ baseUrl, model, apiKeyEnv, temperature: 0, maxTokens: 300, timeoutMs, retries }), rubric, model }
}

function judgePrices(values: JudgeValues): Prices | null {
  const i = num(values['judge-price-in'], '--judge-price-in', 0)
  const o = num(values['judge-price-out'], '--judge-price-out', 0)
  if ((i === undefined) !== (o === undefined)) throw new UsageError('--judge-price-in and --judge-price-out go together')
  return i === undefined || o === undefined ? null : { input: i, output: o }
}

async function calibrateCommand(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { ...JUDGE_OPTIONS, record: { type: 'string' }, concurrency: { type: 'string' }, timeout: { type: 'string' } },
  })
  if (positionals.length !== 1) throw new UsageError('calibrate wants one labels file: JSONL with id, input, output and label (pass or fail)')
  const labelsFile = positionals[0]
  const labels = loadLabels(labelsFile)
  const j = judgeFrom(values, (num(values.timeout, '--timeout', 0.001) ?? 120) * 1000, 3)
  const g = judgeGrader(j.provider, j.rubric)
  const kappaBar = num(values['kappa-bar'], '--kappa-bar', -1, 1) ?? 0.6
  io.err(`evalbar calibrate: ${labels.length} labelled answers, judged by ${j.provider.describe}\n`)
  let record
  try {
    record = await calibrate({
      labels,
      labelsFile: relative(process.cwd(), resolve(labelsFile)).split(sep).join('/'),
      judge: j.provider,
      requestedModel: j.model,
      rubric: j.rubric,
      promptSha256: g.promptSha256,
      kappaBar,
      concurrency: num(values.concurrency, '--concurrency', 1, 64) ?? 1,
      // a calibration on a small local model can take half an hour, and silence looks like a hang (tick 9)
      onItem: (done, total) => {
        if (done % 25 === 0 || done === total) io.err(`  ${done} of ${total} judged\n`)
      },
      evalbar: VERSION,
    })
  } finally {
    await j.provider.close()
  }
  const out = resolve(values.record ?? join('.evalbar', 'calibrations', `${g.promptSha256.slice(0, 12)}.json`))
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(record, null, 1)}\n`)
  io.out(renderCalibration(record))
  io.out(`record: ${relative(process.cwd(), out).split(sep).join('/')}\n`)
  return record.trusted ? 0 : 3
}

/** The funnel, in the order a row meets it: what came in, why each left, what stayed. */
function renderFunnel(f: Funnel): string {
  const L = [`${f.read} rows read`]
  const out: [number, string][] = [
    [f.noRequest, 'had no request'],
    [f.short, 'were under the minimum length'],
    [f.pasted, 'were pasted blocks: code, stack traces, walls of lines'],
    [f.needsContext, 'leaned on context the line does not carry'],
    [f.exactDuplicate, 'repeated an earlier request exactly'],
    [f.nearDuplicate, 'repeated one closely, at the similarity limit or above'],
  ]
  for (const [n, why] of out) if (n) L.push(`  ${String(n).padStart(6)} ${why}`)
  L.push(`${f.kept} kept as test-worthy${f.picked !== null ? `, ${f.picked} picked by logs-to-evals's selector` : ''}, in ${f.clusters} clusters`)
  if (f.test) L.push(`held out: ${f.test} to test.jsonl (sealed), ${f.dev} to dev.jsonl`)
  const removed = Object.entries(f.removed)
  if (removed.length) L.push(`personal data removed: ${removed.map(([k, n]) => `${n} ${k}`).join(', ')}`)
  return `${L.join('\n')}\n`
}

async function importCommand(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      'input-field': { type: 'string' },
      'output-field': { type: 'string' },
      'time-field': { type: 'string' },
      'source-field': { type: 'string' },
      'cluster-field': { type: 'string' },
      'signal-field': { type: 'string' },
      'id-field': { type: 'string' },
      'min-chars': { type: 'string' },
      near: { type: 'string' },
      pick: { type: 'string' },
      'holdout-after': { type: 'string' },
      'holdout-source': { type: 'string' },
      budget: { type: 'string' },
      encoding: { type: 'string' },
      names: { type: 'string' },
    },
  })
  if (positionals.length !== 1 || !values.out) throw new UsageError('import wants a log file and --out <folder>')
  if (values['holdout-after'] && values['holdout-source']) throw new UsageError('hold out by time or by source, not both')
  if (values.names !== undefined && values.names !== 'capitalised' && values.names !== 'off') throw new UsageError('--names is capitalised (the default) or off')
  const rows = parseJsonl(readText(positionals[0], values.encoding), positionals[0]).map((l) => l.value as Record<string, unknown>)
  const { dev, test, funnel } = importLog(rows, {
    inputField: values['input-field'],
    outputField: values['output-field'],
    timeField: values['time-field'],
    sourceField: values['source-field'],
    clusterField: values['cluster-field'],
    signalField: values['signal-field'],
    idField: values['id-field'],
    minChars: num(values['min-chars'], '--min-chars', 0) ?? 12,
    near: num(values.near, '--near', 0, 1) ?? 0.9,
    pick: num(values.pick, '--pick', 1),
    holdoutAfter: values['holdout-after'],
    holdoutSource: values['holdout-source'],
    names: values.names as 'capitalised' | 'off' | undefined,
  })
  const out = resolve(values.out)
  mkdirSync(out, { recursive: true })
  const lines = (cs: object[]) => cs.map((c) => JSON.stringify(c)).join('\n') + (cs.length ? '\n' : '')
  const held = Boolean(values['holdout-after'] || values['holdout-source'])
  writeFileSync(join(out, held ? 'dev.jsonl' : 'cases.jsonl'), lines(dev))
  if (held) {
    writeFileSync(join(out, 'test.jsonl'), lines(test))
    writeSeal(join(out, 'test.jsonl'), num(values.budget, '--budget', 1, 100) ?? 3)
  }
  writeFileSync(join(out, 'funnel.json'), `${JSON.stringify(funnel, null, 2)}\n`)
  io.out(renderFunnel(funnel))
  return 0
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
    if (cmd === 'calibrate') return await calibrateCommand(rest, io)
    if (cmd === 'import') return await importCommand(rest, io)
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
