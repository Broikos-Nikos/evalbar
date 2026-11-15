/**
 * The importer: its checksums on the values the knowledge base verified, its
 * filters, its duplicates, a holdout that never splits a session, and a seal
 * that shows every look.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { main } from '../src/app.ts'
import { importLog, leansOnContext, looksPasted } from '../src/importer/import.ts'
import { afmValid, amkaValid, ibanValid, luhnValid, scrubLine } from '../src/importer/scrub.ts'

const root = mkdtempSync(join(tmpdir(), 'evalbar-import-'))
after(() => rmSync(root, { recursive: true, force: true }))

test("the checksums agree with the values ai-knowledge 08-security-and-privacy/05 verified", () => {
  assert.deepEqual(['094019245', '094259216', '123456781', '000000000'].map(afmValid), [true, true, false, false])
  assert.deepEqual(['01013099997', '01013099999'].map(amkaValid), [true, false])
  assert.equal(ibanValid('GR9608100010000001234567890'), true)
  assert.equal(ibanValid('GR96 0810 0010 0000 0123 4567 890'), true)
  assert.equal(ibanValid('GR9608100010000001234567891'), false)
  // a Luhn-valid eleven digits whose first six are no date is not an AMKA
  const notADate = Array.from({ length: 10 }, (_, c) => `3213304567${c}`).find(luhnValid)!
  assert.equal(amkaValid(notADate), false)
})

test('nine digits are a tax number only beside a word that says so', () => {
  assert.equal(scrubLine('Ο ΑΦΜ μου είναι 094019245.').text, 'Ο ΑΦΜ μου είναι <AFM>.')
  assert.doesNotMatch(scrubLine('order 1042 shipped with 094019245 units').text, /<AFM>/)
})

test('Greek identifiers go before the generic rules can eat their digits', () => {
  const r = scrubLine('Επιστροφή στον GR96 0810 0010 0000 0123 4567 890, ΑΜΚΑ 01013099997, κινητό +30 6912345678, ΑΔΤ ΑΚ 123456. Με λένε Μαρία Παπαδοπούλου.')
  assert.equal(r.text, 'Επιστροφή στον <IBAN>, ΑΜΚΑ <AMKA>, κινητό <PHONE>, ΑΔΤ <ID>. Με λένε <NAME>.')
})

test('a capitalised pair is taken as a name, including the ones that are not, and --names off leaves it', () => {
  assert.equal(scrubLine('Maria Papadopoulou here, where is my order').text, '<NAME> here, where is my order')
  assert.equal(scrubLine('I bought the Blue Kettle yesterday').text, 'I bought the <NAME> yesterday')
  assert.equal(scrubLine('Maria Papadopoulou here', { names: 'off' }).text, 'Maria Papadopoulou here')
})

test('a paste is not a request, and a request is not a paste', () => {
  assert.equal(looksPasted('Traceback (most recent call last):\n  File "a.py", line 3\nValueError: no'), true)
  assert.equal(looksPasted('```\n{"a": 1}\n```'), true)
  assert.equal(looksPasted(Array.from({ length: 16 }, (_, i) => `line ${i}`).join('\n')), true)
  assert.equal(looksPasted('Where is my order 1042? It was due on Monday.\nThanks'), false)
})

test('a line that leans on the conversation is not a test, in English or Greek', () => {
  for (const t of ['and this one?', 'do it again', 'same again please', 'και αυτό;', 'όπως πριν', 'πάλι δεν δουλεύει αυτό']) assert.equal(leansOnContext(t), true, t)
  for (const t of ['how do i change my password', 'πού είναι η παραγγελία μου 1042', 'is this item in stock']) assert.equal(leansOnContext(t), false, t)
})

const OPTS = { minChars: 12, near: 0.9 }

test('duplicates go, exactly after folding and then by meaning, the first by time kept', () => {
  const rows = [
    { id: 2, time: '2026-10-02', input: 'Where is my order 1042?' },
    { id: 1, time: '2026-10-01', input: 'where is my order 1042' },
    // 0.934 by the hashed n-grams; "hi, where is my order 1042 please" is only 0.821, which is why it is not this case
    { id: 5, time: '2026-10-01', input: 'can you tell me where my order 1042 is right now' },
    { id: 3, time: '2026-10-03', input: 'can you tell me where my order 1042 is right now please' },
    { id: 4, time: '2026-10-04', input: 'how do I reset my password' },
  ]
  const r = importLog(rows, OPTS)
  assert.deepEqual([r.funnel.exactDuplicate, r.funnel.nearDuplicate, r.funnel.kept], [1, 1, 3])
  assert.equal(r.dev[0].id, 'log-1')
})

test('a holdout by time never splits a session: the session goes where its first message went', () => {
  const rows = [
    { id: 1, time: '2026-10-10T10:00', session: 'a', input: 'where is my order 1001 today' },
    { id: 2, time: '2026-10-20T10:00', session: 'a', input: 'can I change the delivery address' },
    { id: 3, time: '2026-10-21T10:00', session: 'b', input: 'do you ship to Cyprus at all' },
  ]
  const r = importLog(rows, { ...OPTS, holdoutAfter: '2026-10-17' })
  assert.deepEqual(r.dev.map((c) => c.id), ['log-1', 'log-2'])
  assert.deepEqual(r.test.map((c) => c.id), ['log-3'])
})

test('the logged answer is kept beside the case and is never its expected answer', () => {
  const r = importLog([{ messages: [{ role: 'user', content: 'what is your refund policy for gifts' }, { role: 'assistant', content: 'Thirty days.' }] }], OPTS)
  assert.equal(r.dev[0].logged_output, 'Thirty days.')
  assert.equal('expected' in r.dev[0], false)
})

async function cli(...argv: string[]) {
  let out = ''
  let err = ''
  const code = await main(argv, { out: (s) => (out += s), err: (s) => (err += s) })
  return { code, out, err }
}

test('the held-out file is sealed: refused without --sealed, counted with it, refused when spent or edited', async () => {
  const log = join(root, 'log.jsonl')
  const lines = Array.from({ length: 6 }, (_, i) => JSON.stringify({ id: i, time: `2026-10-${10 + i * 3}`, session: `s${i}`, input: `question number ${i} about my order` }))
  writeFileSync(log, `${lines.join('\n')}\n`)
  const out = join(root, 'suite')
  const imp = await cli('import', log, '--out', out, '--holdout-after', '2026-10-17', '--budget', '1')
  assert.equal(imp.code, 0)
  assert.match(imp.out, /held out: 3 to test\.jsonl \(sealed\), 3 to dev\.jsonl/)
  const script = join(root, 'echo.mjs')
  writeFileSync(script, "import { createInterface } from 'node:readline'\nfor await (const l of createInterface({ input: process.stdin })) process.stdout.write(JSON.stringify({ output: 'x' }) + '\\n')\n")
  const cmd = `"${process.execPath}" "${script}"`
  // an imported suite has no expected answers by design, so it is graded by a program
  const grader = join(root, 'any.mjs')
  writeFileSync(grader, 'export const grade = () => ({ pass: true, reason: "any" })')
  const test1 = join(out, 'test.jsonl')
  const casual = await cli('run', test1, '--command', cmd, '--grader', `program:${grader}`, '--out', join(root, 'r1'))
  assert.equal(casual.code, 2)
  assert.match(casual.err, /is a sealed held-out file: score it with --sealed, which spends one of its 1 decisions \(0 spent\)/)
  const sealed = await cli('run', test1, '--command', cmd, '--grader', `program:${grader}`, '--sealed', '--out', join(root, 'r2'))
  assert.notEqual(sealed.code, 2)
  assert.equal(JSON.parse(readFileSync(join(out, 'test.seal.json'), 'utf8')).runs.length, 1)
  const again = await cli('run', test1, '--command', cmd, '--grader', `program:${grader}`, '--sealed', '--out', join(root, 'r3'))
  assert.match(again.err, /has spent its 1 sealed runs/)
  writeFileSync(test1, `${readFileSync(test1, 'utf8')}{"id":"x","input":"one more"}\n`)
  const edited = await cli('run', test1, '--command', cmd, '--grader', `program:${grader}`, '--sealed', '--out', join(root, 'r4'))
  assert.match(edited.err, /has changed since it was sealed/)
})
