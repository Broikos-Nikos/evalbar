/**
 * Public human labels for calibrating a judge: XSTest's (Rottger et al., NAACL
 * 2024) annotations of Llama 2's answers to its 250 safe prompts, fetched from
 * the authors' repository at a pinned commit and held to its sha256.
 *
 *   node examples/judge-calibration/fetch.ts      writes examples/judge-calibration/data/labels.jsonl
 *
 * The answers are fetched, not committed: XSTest's prompts are CC-BY-4.0, and
 * its README says the model completions are under the licences of the models
 * that wrote them. What evalbar commits is the calibration record, which holds
 * ids and verdicts and none of the text.
 *
 * Safe prompts only. The unsafe ones carry answers to requests for harm, and a
 * calibration of "did it comply" does not need them: with Llama 2's original
 * system prompt, which over-refuses, the safe prompts alone give both classes
 * (101 full compliance against 149 refusals, full or partial).
 *
 * The property is XSTest's own: an answer passes when it complies in full and
 * fails when it refuses in whole or in part. Both annotators' labels are kept,
 * so the report can say how far two humans agree on the same 250 answers.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'

const COMMIT = 'd7bb5bd738c1fcbc36edd83d5e7d1b71a3e2d84d'
const FILE = 'model_completions/xstest_v2_completions_llama2orig.csv'
const SHA256 = 'cbc52550e8ba8197a3e3d97a5af078d27bae4766737cd62df80270126a87ffc6'
const MODEL = 'meta-llama/Llama-2-70b-chat-hf, original system prompt'

/** RFC 4180: fields in double quotes may hold commas, newlines and doubled quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const url = `https://raw.githubusercontent.com/paul-rottger/xstest/${COMMIT}/${FILE}`
const res = await fetch(url)
if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
const bytes = new Uint8Array(await res.arrayBuffer())
const sha = createHash('sha256').update(bytes).digest('hex')
if (sha !== SHA256) throw new Error(`${FILE} at ${COMMIT.slice(0, 7)} has sha256 ${sha}, not the ${SHA256} this was written against`)
const [header, ...rows] = parseCsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
const col = (name: string) => {
  const i = header.indexOf(name)
  if (i < 0) throw new Error(`no column ${name} in ${FILE}`)
  return i
}
const [id, type, prompt, completion, a1, a2, final] = ['id', 'type', 'prompt', 'completion', 'annotation_1', 'annotation_2', 'final_label'].map(col)
const complies = (label: string) => (label === '1_full_compliance' ? 'pass' : 'fail')
const labels = rows
  .filter((r) => r.length === header.length && !r[type].startsWith('contrast_'))
  .map((r) => ({ id: r[id], input: r[prompt], output: r[completion].trim(), label: complies(r[final]), first: complies(r[a1]), second: complies(r[a2]), model: MODEL }))
mkdirSync(new URL('data/', import.meta.url), { recursive: true })
writeFileSync(new URL('data/labels.jsonl', import.meta.url), `${labels.map((l) => JSON.stringify(l)).join('\n')}\n`)
const passes = labels.filter((l) => l.label === 'pass').length
console.log(`data/labels.jsonl: ${labels.length} answers, ${passes} that comply and ${labels.length - passes} that refuse in whole or in part`)
