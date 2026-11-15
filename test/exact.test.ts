/**
 * The exact grader: forgiving where 07-evaluation/01 section 6 says a check is
 * too rigid, and not where it would pass a wrong answer. The audit gates from
 * the same section are here too: an empty output, "I don't know" and a
 * confident wrong answer all fail.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toCases } from '../src/cases.ts'
import { gradeExact, unwrap } from '../src/graders/exact.ts'

const pass = (out: string, exp: unknown) => gradeExact(out, exp).pass

test('a fence, quotes, guillemets and one closing mark are not the answer', () => {
  assert.ok(pass('```\nAthens\n```', 'Athens'))
  assert.ok(pass('"Athens"', 'Athens'))
  assert.ok(pass('«Αθήνα»', 'Αθήνα'))
  assert.ok(pass('Athens.', 'Athens'))
  assert.ok(pass('  Athens \n', 'athens'))
  assert.equal(unwrap('...'), '..')
})

test('4 is 4.0, and 3,14 is not 3.14', () => {
  assert.ok(pass('4', '4.0'))
  assert.ok(pass('4', 4))
  assert.ok(pass('-0.50', '-.5'))
  assert.ok(!pass('3,14', '3.14'))
  assert.ok(!pass('1,000', '1000'))
})

test('any of several expected answers', () => {
  assert.ok(pass('Αθήνα', ['Athens', 'Αθήνα']))
  assert.ok(!pass('Πάτρα', ['Athens', 'Αθήνα']))
})

test('the three negatives every grader must fail, and a near miss', () => {
  for (const out of ['', "I don't know", 'Thessaloniki is the capital of Greece', 'Athens is not the capital']) assert.ok(!pass(out, 'Athens'), out)
})

test('a case with nothing to compare with fails and says why', () => {
  assert.deepEqual(gradeExact('Athens', undefined), { pass: false, reason: 'the case has no expected answer to compare with' })
})

test('a failing grade shows both sides', () => {
  assert.equal(gradeExact('Πάτρα', 'Αθήνα').reason, '"Πάτρα" is not "Αθήνα"')
})

test('every problem in a suite is reported before anything runs', () => {
  const lines = [
    { line: 1, value: { input: 'a', id: 'x' } },
    { line: 2, value: { question: 'b' } },
    { line: 3, value: { input: 'c', id: 'x' } },
    { line: 4, value: { input: 'd', tags: 'el' } },
    { line: 5, value: [1, 2] },
  ]
  assert.throws(
    () => toCases(lines, 's.jsonl'),
    (e: Error) =>
      /line 2 has no input.*fields found: question/.test(e.message) &&
      /line 3 repeats the id "x" of line 1/.test(e.message) &&
      /line 4: tags must be a list of strings/.test(e.message) &&
      /line 5 is not an object/.test(e.message),
  )
})

test('chat messages are an input, and need a user turn', () => {
  const ok = toCases([{ line: 1, value: { input: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] } }], 's.jsonl')
  assert.equal(ok.length, 1)
  assert.throws(() => toCases([{ line: 1, value: { input: [{ role: 'system', content: 's' }] } }], 's.jsonl'), /has no input/)
})
