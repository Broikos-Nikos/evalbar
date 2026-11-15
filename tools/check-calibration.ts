/**
 * Every committed calibration record says what its own verdicts say.
 *
 *   npm run check:calibration
 *
 * A record is made by a model run this repository cannot repeat in CI: the
 * judge needs a GPU or a key. What it can repeat is the arithmetic. Each record
 * carries every item's human label and judge verdict, so kappa, its interval,
 * the rates and the trust decision are computed again from those and compared
 * with what the record states. And a record must hold no text: ids and
 * verdicts only, whatever the licence of the answers it was made on.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import type { CalibrationRecord } from '../src/calibration.ts'
import { cohensKappa } from '../src/stats.ts'

const { values } = parseArgs({ options: { root: { type: 'string' } } })
const root = resolve(values.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'))

const records: string[] = []
for (const e of existsSync(join(root, 'examples')) ? readdirSync(join(root, 'examples')) : []) {
  const dir = join(root, 'examples', e, 'records')
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith('.json')) records.push(join(dir, f))
}

const fails: string[] = []
for (const path of records) {
  const rel = path.slice(root.length + 1).split('\\').join('/')
  const r = JSON.parse(readFileSync(path, 'utf8')) as CalibrationRecord
  const a = cohensKappa(r.items)
  for (const k of ['n', 'prevalence', 'agreement', 'kappa', 'kappaLo', 'kappaHi', 'tpr', 'tnr', 'pabak'] as const) {
    const got = a[k]
    const said = r.agreement[k]
    if (got === null || said === null ? got !== said : Math.abs(got - said) > 1e-12) fails.push(`${rel}: ${k} is ${said} in the record and ${got} from its items`)
  }
  if (r.items.length + r.errors !== r.labels.n) fails.push(`${rel}: ${r.items.length} verdicts and ${r.errors} errors for ${r.labels.n} labels`)
  const trusted = a.kappaLo >= r.kappaBar && r.negatives.empty && r.negatives.dontKnow && r.negatives.otherQuestion && r.errors === 0
  if (trusted !== r.trusted) fails.push(`${rel}: says trusted ${r.trusted}, and its own numbers say ${trusted}`)
  const extra = r.items.flatMap((i) => Object.keys(i)).filter((k) => !['id', 'human', 'judge'].includes(k))
  if (extra.length) fails.push(`${rel}: items carry ${[...new Set(extra)].join(', ')}; a record holds ids and verdicts only`)
}
if (fails.length) {
  console.error(fails.map((f) => 'FAIL  ' + f).join('\n'))
  process.exit(1)
}
console.log(`check:calibration ok: ${records.length} record${records.length === 1 ? '' : 's'}, every statistic recomputed from its verdicts and equal, and no text in any`)
