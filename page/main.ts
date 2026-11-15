/**
 * The page: evalbar's functions on what a visitor types, and the figures of the
 * committed measurements. Every computation is in `lib.ts`, which
 * `tools/check-page.ts` runs in Node to hold this page to it.
 */
import './style.css'
import semantic from '../measurements/semantic-cache.json'
import sql from '../measurements/sql-run.json'
import importer from '../measurements/importer.json'
import greek from '../measurements/greek.json'
import sqlReport from '../examples/sql-refusals/runs/qwen2.5-coder-1.5b/report.json'
import judge from '../examples/judge-calibration/records/qwen2.5-coder-1.5b.json'
import {
  compareProblem, comparePresets, compareText, count, failureCards, gradeBoth, greekNote, headline, PAIRS, rate, realCards, reportText, runPresets, runProblem, SCRUB_EXAMPLES, scrubShown, type Measured,
} from './lib.ts'

const m = { semantic, sql, sqlReport, judge, importer, greek } as unknown as Measured
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const int = (n: number) => n.toLocaleString('en-US')
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The command's output, with its one verdict word marked: the thing on the screen being argued about. */
function term(el: HTMLElement, text: string) {
  el.innerHTML = esc(text).replace(/^(PASS|FAIL|CANNOT TELL|REFUSED|B IS BETTER|B IS WORSE)(?=:)/m, (w) => `<b class="v-${w === 'PASS' || w === 'B IS BETTER' ? 'ok' : 'hot'}">${w}</b>`)
}

$('headline').textContent = headline(m)
const cmp0 = comparePresets(m)[0]
$('hero-cmd').textContent = `$ evalbar compare ${cmp0.nameA} ${cmp0.nameB}`
term($('hero-out'), compareText(cmp0.n, cmp0.lost, cmp0.won, cmp0.nameA, cmp0.nameB))

// ask it: one run against a bar, or two runs on the same cases
const runs = runPresets(m)
const pairs = comparePresets(m)
let mode: 'run' | 'compare' = 'run'
let names = { a: pairs[0].nameA, b: pairs[0].nameB }

function chips(holder: HTMLElement, labels: string[], pick: (i: number) => void) {
  holder.innerHTML = ''
  labels.forEach((label, i) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'chip'
    b.textContent = label
    b.setAttribute('aria-pressed', 'false')
    b.addEventListener('click', () => {
      for (const c of holder.querySelectorAll('.chip')) c.setAttribute('aria-pressed', String(c === b))
      pick(i)
    })
    holder.append(b)
  })
}
const unpress = (holder: HTMLElement) => { for (const c of holder.querySelectorAll('.chip')) c.setAttribute('aria-pressed', 'false') }
const press = (holder: HTMLElement, i: number) => holder.querySelectorAll('.chip').forEach((c, j) => c.setAttribute('aria-pressed', String(i === j)))

function ask() {
  const out = $('ask-out')
  if (mode === 'run') {
    const n = count($<HTMLInputElement>('run-n').value)
    const k = count($<HTMLInputElement>('run-k').value)
    const bar = rate($<HTMLInputElement>('run-bar').value)
    $('ask-cmd').textContent = `$ evalbar report runs/yours`
    const problem = runProblem(n, k, bar)
    if (problem) { out.classList.add('problem'); out.textContent = problem; return }
    out.classList.remove('problem')
    term(out, reportText(n!, k!, bar!))
  } else {
    const n = count($<HTMLInputElement>('cmp-n').value)
    const lost = count($<HTMLInputElement>('cmp-lost').value)
    const won = count($<HTMLInputElement>('cmp-won').value)
    $('ask-cmd').textContent = `$ evalbar compare ${names.a} ${names.b}`
    const problem = compareProblem(n, lost, won)
    if (problem) { out.classList.add('problem'); out.textContent = problem; return }
    out.classList.remove('problem')
    term(out, compareText(n!, lost!, won!, names.a, names.b))
  }
}

function setRun(i: number) {
  const p = runs[i]
  $<HTMLInputElement>('run-n').value = int(p.n)
  $<HTMLInputElement>('run-k').value = int(p.k)
  $<HTMLInputElement>('run-bar').value = String(p.bar)
  ask()
}
function setCompare(i: number) {
  const p = pairs[i]
  names = { a: p.nameA, b: p.nameB }
  $<HTMLInputElement>('cmp-n').value = int(p.n)
  $<HTMLInputElement>('cmp-lost').value = int(p.lost)
  $<HTMLInputElement>('cmp-won').value = int(p.won)
  ask()
}
chips($('run-presets'), runs.map((p) => p.label), setRun)
chips($('compare-presets'), pairs.map((p) => p.label), setCompare)
for (const id of ['run-n', 'run-k', 'run-bar']) $(id).addEventListener('input', () => { unpress($('run-presets')); ask() })
for (const id of ['cmp-n', 'cmp-lost', 'cmp-won'])
  $(id).addEventListener('input', () => { unpress($('compare-presets')); names = { a: 'runs/a', b: 'runs/b' }; ask() })
for (const b of $('mode').querySelectorAll<HTMLButtonElement>('.chip'))
  b.addEventListener('click', () => {
    mode = b.dataset.mode as 'run' | 'compare'
    for (const c of $('mode').querySelectorAll('.chip')) c.setAttribute('aria-pressed', String(c === b))
    $('run-form').hidden = mode !== 'run'
    $('compare-form').hidden = mode !== 'compare'
    ask()
  })
press($('run-presets'), 0)
press($('compare-presets'), 0)
setCompare(0)
mode = 'run'
setRun(0)

// what it said about real systems: each figure read from its committed file
$('real').innerHTML = realCards(m)
  .map((c, i) => `<div class="stat"><div class="n${i === 0 ? ' hot' : ''}">${esc(c.n)}</div><div class="what">${esc(c.what)}</div><div class="cmd mono">${esc(c.cmd)}</div></div>`)
  .join('')

// Greek: the nine measured pairs, and anything typed
$('greek-note').textContent = greekNote(m)
function grade() {
  const out = $<HTMLInputElement>('gr-out').value
  const exp = $<HTMLInputElement>('gr-exp').value
  const g = gradeBoth(out, exp)
  const known = PAIRS.find((p) => p.output === out && p.expected === exp)
  const right = known ? known.right : null
  const line = (who: string, pass: boolean, extra: string) => {
    const wrong = right !== null && pass !== right
    return `<p class="vline${wrong ? ' wrong' : ''}"><span class="who mono">${who}</span><b class="mono">${pass ? 'PASS' : 'FAIL'}</b>${extra}${wrong ? '<span class="tag mono">wrong</span>' : ''}</p>`
  }
  $('gr-verdicts').innerHTML =
    (known ? `<p class="why">${esc(known.why)}: the right verdict is ${known.right ? 'PASS' : 'FAIL'}</p>` : '') +
    line('evalbar', g.evalbar, ` <span class="reason">${esc(g.reason)}</span>`) +
    line('lower-casing', g.lowerCase, '')
}
chips($('greek-presets'), PAIRS.map((p) => `${p.output} / ${p.expected}`), (i) => {
  $<HTMLInputElement>('gr-out').value = PAIRS[i].output
  $<HTMLInputElement>('gr-exp').value = PAIRS[i].expected
  grade()
})
for (const id of ['gr-out', 'gr-exp']) $(id).addEventListener('input', () => { unpress($('greek-presets')); grade() })
press($('greek-presets'), 0)
$<HTMLInputElement>('gr-out').value = PAIRS[0].output
$<HTMLInputElement>('gr-exp').value = PAIRS[0].expected
grade()

// the scrubber
function scrub() {
  $('scrub-out').textContent = scrubShown($<HTMLTextAreaElement>('scrub-in').value)
}
chips($('scrub-presets'), SCRUB_EXAMPLES.map((e) => e.label), (i) => { $<HTMLTextAreaElement>('scrub-in').value = SCRUB_EXAMPLES[i].text; scrub() })
$('scrub-in').addEventListener('input', () => { unpress($('scrub-presets')); scrub() })
press($('scrub-presets'), 0)
$<HTMLTextAreaElement>('scrub-in').value = SCRUB_EXAMPLES[0].text
scrub()

// what this does not show, its figures from the same files
$('failures').innerHTML = failureCards(m)
  .map(([h, p]) => `<div class="fail"><h3>${esc(h)}</h3><p>${esc(p)}</p></div>`)
  .join('')
