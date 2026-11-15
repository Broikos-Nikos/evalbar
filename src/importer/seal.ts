/**
 * A held-out file that shows when it has been looked at (decision B12, from
 * the owner's sealed-set protocol in ai-knowledge 07-evaluation/01 section 4).
 *
 * A test split that is scored every time something changes stops being held
 * out: the change that wins is partly the one whose noise ran high on it, and
 * the base's M13 measured that at 3.3 to 6.9 points of flattery. So the
 * importer writes `test.seal.json` beside `test.jsonl`: the file's sha256 and a
 * decision budget. `evalbar run` refuses a sealed file without `--sealed`, and
 * every sealed run is written into the seal before it starts, so the third
 * look is a line anyone can read, and a fourth is refused.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { UserError } from '../errors.ts'

export type Seal = {
  about: string
  file: string
  sha256: string
  budget: number
  runs: { at: string; provider: string; cases: number }[]
}

export const sealPath = (casesPath: string) => `${casesPath.replace(/\.jsonl$/i, '')}.seal.json`

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

export function writeSeal(casesPath: string, budget: number): Seal {
  const seal: Seal = {
    about: `A held-out file. evalbar run scores it only with --sealed, and each sealed run spends one of ${budget} decisions and is written here.`,
    file: casesPath.split(/[\\/]/).pop()!,
    sha256: sha(casesPath),
    budget,
    runs: [],
  }
  writeFileSync(sealPath(casesPath), `${JSON.stringify(seal, null, 2)}\n`)
  return seal
}

/** Before a run: refuse a sealed file run casually, an edited one, or one whose budget is spent; otherwise spend a decision. */
export function spendSeal(casesPath: string, sealed: boolean, provider: string, cases: number): Seal | null {
  const path = sealPath(casesPath)
  if (!existsSync(path)) {
    if (sealed) throw new UserError(`--sealed, and ${casesPath} has no seal`)
    return null
  }
  const seal = JSON.parse(readFileSync(path, 'utf8')) as Seal
  if (!sealed) throw new UserError(`${casesPath} is a sealed held-out file: score it with --sealed, which spends one of its ${seal.budget} decisions (${seal.runs.length} spent)`)
  if (sha(casesPath) !== seal.sha256) throw new UserError(`${casesPath} has changed since it was sealed: a held-out file that is edited is no longer the one that was held out`)
  if (seal.runs.length >= seal.budget) throw new UserError(`${casesPath} has spent its ${seal.budget} sealed runs (the last on ${seal.runs.at(-1)!.at}); a new decision needs a new held-out file`)
  seal.runs.push({ at: new Date().toISOString(), provider, cases })
  writeFileSync(path, `${JSON.stringify(seal, null, 2)}\n`)
  return seal
}
