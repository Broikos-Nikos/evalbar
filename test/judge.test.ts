/**
 * The judge and its calibration, against judges that misbehave on request: one
 * that follows the hidden rule the human labels follow, one that always says
 * pass, one that never gives a verdict. And the rule that a judge's verdicts
 * decide nothing without a record that matches it (decision B10 included).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { main } from '../src/app.ts'
import { family, trusts, type CalibrationRecord } from '../src/calibration.ts'
import { readVerdict } from '../src/graders/judge.ts'
import { fakeOpenAi, type Fake } from './fake-openai.ts'

const root = mkdtempSync(join(tmpdir(), 'evalbar-judge-'))
let fake: Fake
// the system under test answers request i with the answer registered for it
const answers: Record<string, string> = {}
for (let i = 0; i < 40; i++) answers[`request ${i}`] = i % 4 === 0 ? `I can't help with request ${i}.` : `Sure, about request ${i}: done.`
before(async () => {
  fake = await fakeOpenAi(answers)
})
after(async () => {
  await fake.close()
  rmSync(root, { recursive: true, force: true })
})

const file = (name: string, text: string) => {
  const p = join(root, name)
  writeFileSync(p, text)
  return p
}
const rubric = file('rubric.md', 'pass: the answer helps with this request. fail: it refuses, or answers something else.\n')
const otherRubric = file('rubric2.md', 'pass: the answer is polite.\n')
// 60 labelled answers, the label the hidden rule's, a second annotator who disagrees on 3
const labels = file(
  'labels.jsonl',
  Array.from({ length: 60 }, (_, i) => {
    const pass = i % 3 !== 0
    const output = pass ? `Sure, about item ${i}: here it is.` : `I won't do item ${i}.`
    const label = pass ? 'pass' : 'fail'
    const second = i < 3 ? (pass ? 'fail' : 'pass') : label
    return JSON.stringify({ id: `l${i}`, input: `item ${i}`, output, label, first: label, second, model: 'llama-test' })
  }).join('\n') + '\n',
)
const suite = file('suite.jsonl', Object.keys(answers).map((q, i) => JSON.stringify({ id: `q${i}`, input: q, expected: 'any' })).join('\n') + '\n')

async function cli(...argv: string[]) {
  let out = ''
  let err = ''
  const code = await main(argv, { out: (s) => (out += s), err: (s) => (err += s) })
  return { code, out, err }
}
const calibrate = (model: string, record: string, r = rubric) => cli('calibrate', labels, '--judge-base-url', fake.url, '--judge-model', model, '--rubric', r, '--record', join(root, record))
const runJudged = (candidate: string, judgeModel: string, out: string, ...extra: string[]) =>
  cli('run', suite, '--base-url', fake.url, '--model', candidate, '--grader', 'judge', '--judge-base-url', fake.url, '--judge-model', judgeModel, '--rubric', rubric, '--bar', '0.5', '--out', join(root, out), ...extra)

test('a judge that follows the humans is trusted, and the report says what kappa is and what agreement would hide', async () => {
  const r = await calibrate('judge-good', 'good.json')
  assert.equal(r.code, 0)
  assert.match(r.out, /kappa 1\.000, 95% interval 1\.000 to 1\.000/)
  assert.match(r.out, /a judge that always said pass would agree 0\.667/)
  assert.match(r.out, /two humans on the same items: kappa 0\.\d+/)
  assert.match(r.out, /negatives it must fail: an empty answer failed, "I don't know" failed, an answer to another question failed/)
  assert.match(r.out, /^TRUSTED at a kappa bar of 0\.6/m)
  const record = JSON.parse(readFileSync(join(root, 'good.json'), 'utf8')) as CalibrationRecord
  assert.equal(record.items.length, 60)
  assert.ok(!JSON.stringify(record).includes('here it is'), 'the record must not carry the texts')
})

test('a judge that always says pass agrees with two thirds of the labels, has a kappa of 0, and is not trusted', async () => {
  const r = await calibrate('judge-always-pass', 'always.json')
  assert.equal(r.code, 3)
  assert.match(r.out, /kappa 0\.000/)
  assert.match(r.out, /raw agreement 0\.667/)
  assert.match(r.out, /an empty answer PASSED/)
  assert.match(r.out, /^NOT TRUSTED/m)
})

test('a judge that never gives a verdict cannot be calibrated, and says so', async () => {
  const r = await calibrate('judge-garbage', 'garbage.json')
  assert.equal(r.code, 2)
  assert.match(r.err, /the judge gave a verdict on 0 of 60 items; nothing to calibrate/)
})

test('without a calibration record a judge grades and decides nothing', async () => {
  const r = await runJudged('oracle', 'judge-good', 'none')
  assert.equal(r.code, 3)
  assert.match(r.out, /JUDGE NOT TRUSTED: no calibration record was given/)
  assert.doesNotMatch(r.out, /^(PASS|FAIL|CANNOT TELL)/m)
  assert.match(r.out, /^30 of 40 passed/m)
})

test('with its record, the same judge decides', async () => {
  const r = await runJudged('oracle', 'judge-good', 'trusted', '--calibration', join(root, 'good.json'))
  assert.match(r.out, /^PASS: the whole interval is at or above the bar of 0\.5/m)
  assert.doesNotMatch(r.out, /JUDGE NOT TRUSTED/)
})

test('a record made with another rubric is not this judge', async () => {
  await calibrate('judge-good', 'other-rubric.json', otherRubric)
  const r = await runJudged('oracle', 'judge-good', 'other', '--calibration', join(root, 'other-rubric.json'))
  assert.match(r.out, /JUDGE NOT TRUSTED: the calibration was made with another prompt or rubric/)
})

test("a judge grading its own family needs a record made on that family's outputs", async () => {
  await calibrate('qwen-judge-good', 'qwen-on-llama.json')
  const r = await runJudged('qwen-oracle', 'qwen-judge-good', 'same-family', '--calibration', join(root, 'qwen-on-llama.json'))
  assert.match(r.out, /JUDGE NOT TRUSTED: the judge and the candidate are both qwen, and the calibration was not made on qwen outputs/)
  // the same judge on a candidate of another family is fine
  const other = await runJudged('oracle', 'qwen-judge-good', 'other-family', '--calibration', join(root, 'qwen-on-llama.json'))
  assert.doesNotMatch(other.out, /JUDGE NOT TRUSTED/)
})

test("the judge's reply is read for its last verdict, and the families are read from the names", () => {
  assert.deepEqual(readVerdict('ok {"reasoning": "a", "verdict": "fail"} then {"reasoning": "b", "verdict": "PASS"}'), { verdict: 'pass', reasoning: 'b' })
  assert.equal(readVerdict('no verdict here {"x": 1}'), null)
  assert.deepEqual(['gpt-4o-mini', 'o3', 'claude-3-5-sonnet', 'gemma-2-9b', 'Qwen/Qwen2.5-Coder-1.5B-Instruct', 'meta-llama/Llama-2-70b-chat-hf', 'mistral-small', 'deepseek-chat', 'oracle'].map(family), [
    'openai',
    'openai',
    'anthropic',
    'google',
    'qwen',
    'meta',
    'mistral',
    'deepseek',
    'unknown',
  ])
  assert.equal(trusts(null, { promptSha256: 'x', judgeAnswered: null, candidate: null, kappaBar: 0.6 }).trusted, false)
})
