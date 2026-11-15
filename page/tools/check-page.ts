/**
 * The page a visitor gets, read after its script has run, at 1280 and at 390.
 *
 *   npm run check:page        (inside npm run verify, which starts the server)
 *
 * The HTML file is empty where the claims go: `main.ts` writes them from the
 * committed measurements, through `lib.ts`. So this reads the DOM a browser
 * built and holds it to two things.
 *
 * - To evalbar run in Node. Every preset and a set of typed inputs, in both
 *   modes, must print what `evalbar report` and `evalbar compare` print for
 *   the same numbers; each of the nine Greek pairs must get the verdicts
 *   `gradeExact` and a lower-casing grader give; each example line must come
 *   out of the scrubber as it does in Node. A bundling mistake, or a page that
 *   computed its own answer, would differ here.
 * - To the committed files. The headline, the four results, the Greek note and
 *   the failures must read as the shared functions write them from the files,
 *   and every number in them must be in one of the files or follow from them by
 *   one of the sums stated below.
 *
 * And no console error, and nothing wider than the window, at either width.
 */
import { chromium, type Page } from 'playwright'
import {
  comparePresets, compareProblem, compareText, count, failureCards, gradeBoth, greekNote, headline, PAIRS, rate, realCards, reportText, runPresets, runProblem, SCRUB_EXAMPLES, scrubShown,
} from '../lib.ts'
import { fileNumbers, measured, numbersIn } from './measured.ts'

const url = process.env.EVALBAR_PAGE_URL
if (!url) {
  console.error('EVALBAR_PAGE_URL is not set: run this through `npm run verify`')
  process.exit(1)
}

const m = measured()
const fails: string[] = []
const expect = (ok: boolean, what: string) => {
  if (!ok) fails.push(what)
}
const same = (where: string, got: string, want: string) => expect(got === want, `${where}: the page shows\n${got}\n      evalbar in Node prints\n${want}`)

// the numbers a claim may use: those in the files, and these, each a sum of numbers in them
const known = fileNumbers()
const refuse = m.sql.mustRefuse
const mustRefuse = Object.values(refuse).reduce((a, b) => a + b, 0)
for (const derived of [
  mustRefuse, // the must-refuse requests: the four outcomes added up
  mustRefuse - refuse.harm, // the ones that passed: all but those that did harm
  mustRefuse - refuse.harm - refuse.refused, // the passes that were not refusals
  Math.round(1 / (1 - m.semantic.bar)), // a bar of 0.999 is one wrong answer in 1,000
])
  known.add(String(derived))
const fromFiles = (where: string, text: string) => {
  for (const n of numbersIn(text)) expect(known.has(n), `${where}: ${n} is in no committed file and follows from none by a stated sum`)
}

const text = (page: Page, sel: string) => page.$eval(sel, (el) => el.textContent ?? '')
const texts = (page: Page, sel: string) => page.$$eval(sel, (els) => els.map((el) => el.textContent ?? ''))
async function type(page: Page, values: Record<string, string>) {
  for (const [id, v] of Object.entries(values)) await page.fill(`#${id}`, v)
}

const browser = await chromium.launch()
try {
  for (const [w, h] of [
    [1280, 900],
    [390, 844],
  ]) {
    const page = await browser.newPage({ viewport: { width: w, height: h } })
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto(url)
    await page.waitForSelector('#real .stat')
    const at = `at ${w}`

    // the claims, as the shared functions write them from the files
    const head = await text(page, '#headline')
    same(`${at}, the headline`, head, headline(m))
    fromFiles(`${at}, the headline`, head)
    const first = m.semantic.comparisons.find((c) => c.stream === 'test')!
    const metaWords = `${first.lost} wrong answers against ${first.won} in ${first.n.toLocaleString('en-US')} requests`
    for (const sel of ['meta[name="description"]', 'meta[property="og:description"]']) {
      const content = await page.$eval(sel, (el) => el.getAttribute('content') ?? '')
      expect(content.includes(metaWords) && content.includes(`about ${first.casesNeeded!.toLocaleString('en-US')} would`), `${at}: ${sel} says "${content}", the measurement says ${metaWords} and about ${first.casesNeeded}`)
    }
    const hero = comparePresets(m)[0]
    same(`${at}, the opening comparison`, await text(page, '#hero-out'), compareText(hero.n, hero.lost, hero.won, hero.nameA, hero.nameB))

    const cards = realCards(m)
    const shown = { n: await texts(page, '#real .stat .n'), what: await texts(page, '#real .stat .what'), cmd: await texts(page, '#real .stat .cmd') }
    cards.forEach((c, i) => {
      same(`${at}, result ${i + 1}`, `${shown.n[i]} | ${shown.what[i]} | ${shown.cmd[i]}`, `${c.n} | ${c.what} | ${c.cmd}`)
      fromFiles(`${at}, result ${i + 1}`, `${shown.n[i]} ${shown.what[i]}`)
    })
    expect(shown.n.length === cards.length, `${at}: ${shown.n.length} results shown, ${cards.length} written`)
    const note = await text(page, '#greek-note')
    same(`${at}, the Greek note`, note, greekNote(m))
    fromFiles(`${at}, the Greek note`, note)
    const failures = failureCards(m)
    const fh = await texts(page, '#failures .fail h3')
    const fp = await texts(page, '#failures .fail p')
    failures.forEach(([h3, p], i) => {
      same(`${at}, failure ${i + 1}`, `${fh[i]} | ${fp[i]}`, `${h3} | ${p}`)
      fromFiles(`${at}, failure ${i + 1}`, `${fh[i]} ${fp[i]}`)
    })

    // one run against a bar: each preset, then typed numbers, against evalbar report in Node
    const runs = runPresets(m)
    for (let i = 0; i < runs.length; i++) {
      await page.click(`#run-presets .chip >> nth=${i}`)
      same(`${at}, run preset "${runs[i].label}"`, await text(page, '#ask-out'), reportText(runs[i].n, runs[i].k, runs[i].bar))
    }
    for (const [n, k, bar] of [
      ['50', '35', '0.9'],
      ['20', '20', '0.9'],
      ['1,000', '999', '0.99'],
      ['400', '0', '0.5'],
      ['10', '11', '0.9'],
      ['abc', '1', '0.9'],
      ['100', '80', '1.5'],
    ]) {
      await type(page, { 'run-n': n, 'run-k': k, 'run-bar': bar })
      const problem = runProblem(count(n), count(k), rate(bar))
      same(`${at}, typed run ${n} ${k} ${bar}`, await text(page, '#ask-out'), problem ?? reportText(count(n)!, count(k)!, rate(bar)!))
    }

    // two runs on the same cases: each preset, then typed numbers, against evalbar compare in Node
    await page.click('#mode [data-mode="compare"]')
    const pairs = comparePresets(m)
    for (let i = 0; i < pairs.length; i++) {
      await page.click(`#compare-presets .chip >> nth=${i}`)
      const p = pairs[i]
      same(`${at}, compare preset "${p.label}"`, await text(page, '#ask-out'), compareText(p.n, p.lost, p.won, p.nameA, p.nameB))
    }
    for (const [n, lost, won] of [
      ['500', '4', '30'],
      ['2,000', '3', '0'],
      ['300', '0', '0'],
      ['100', '60', '50'],
    ]) {
      await type(page, { 'cmp-n': n, 'cmp-lost': lost, 'cmp-won': won })
      const problem = compareProblem(count(n), count(lost), count(won))
      same(`${at}, typed comparison ${n} ${lost} ${won}`, await text(page, '#ask-out'), problem ?? compareText(count(n)!, count(lost)!, count(won)!, 'runs/a', 'runs/b'))
    }

    // the nine Greek pairs, and two typed ones, against gradeExact and a lower-casing grader in Node
    const verdicts = async () =>
      page.$$eval('#gr-verdicts .vline', (ls) => ls.map((l) => ({ who: l.querySelector('.who')!.textContent, verdict: l.querySelector('b')!.textContent, wrong: !!l.querySelector('.tag') })))
    for (let i = 0; i < PAIRS.length; i++) {
      await page.click(`#greek-presets .chip >> nth=${i}`)
      const p = PAIRS[i]
      const g = gradeBoth(p.output, p.expected)
      const want = [
        { who: 'evalbar', verdict: g.evalbar ? 'PASS' : 'FAIL', wrong: g.evalbar !== p.right },
        { who: 'lower-casing', verdict: g.lowerCase ? 'PASS' : 'FAIL', wrong: g.lowerCase !== p.right },
      ]
      same(`${at}, Greek pair ${i + 1} (${p.why})`, JSON.stringify(await verdicts()), JSON.stringify(want))
    }
    for (const [out, exp] of [
      ['ΑΘΗΝΑ', 'αθηνα'],
      ['Πότε;', 'ποτέ;'],
    ]) {
      await type(page, { 'gr-out': out, 'gr-exp': exp })
      const g = gradeBoth(out, exp)
      const want = [
        { who: 'evalbar', verdict: g.evalbar ? 'PASS' : 'FAIL', wrong: false },
        { who: 'lower-casing', verdict: g.lowerCase ? 'PASS' : 'FAIL', wrong: false },
      ]
      same(`${at}, typed Greek ${out} against ${exp}`, JSON.stringify(await verdicts()), JSON.stringify(want))
    }

    // the scrubber, on each example line, against scrubLine in Node
    for (let i = 0; i < SCRUB_EXAMPLES.length; i++) {
      await page.click(`#scrub-presets .chip >> nth=${i}`)
      same(`${at}, scrubbed "${SCRUB_EXAMPLES[i].label}"`, await text(page, '#scrub-out'), scrubShown(SCRUB_EXAMPLES[i].text))
    }

    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(wide <= 0, `${at}: the page is ${wide}px wider than the window`)
    expect(!errors.length, `${at}: console errors: ${errors.join(' | ')}`)
    await page.close()
  }
} finally {
  await browser.close()
}

if (fails.length) {
  console.error(fails.map((f) => `FAIL  ${f}`).join('\n'))
  process.exit(1)
}
console.log(
  `check:page ok: the claims as the files write them, every number in them from a file, ${runPresets(m).length + 7} runs and ${comparePresets(m).length + 4} comparisons as evalbar prints them, ${PAIRS.length + 2} Greek pairs and ${SCRUB_EXAMPLES.length} scrubbed lines as in Node, at 1280 and 390`,
)
