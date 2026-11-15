/**
 * The link preview still shows the page.
 *
 *   npm run check:capture     (inside npm run verify)
 *
 * Pixels differ between machines for reasons that are not the page (font
 * hinting, the GPU), so this compares words: what `capture.json` says the card
 * shows, against the same words read off the page being served now. When the
 * page's claim or its opening answer changes, this fails until `npm run
 * capture` takes the picture again.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { visibleWords } from './capture.ts'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const url = process.env.EVALBAR_PAGE_URL
if (!url) {
  console.error('EVALBAR_PAGE_URL is not set: run this through `npm run verify`')
  process.exit(1)
}

const stored = JSON.parse(readFileSync(here('../capture.json'), 'utf8')) as Record<string, unknown>
const browser = await chromium.launch()
let now: Record<string, unknown>
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
  await page.goto(url)
  await page.waitForSelector('#real .stat')
  now = await visibleWords(page)
} finally {
  await browser.close()
}
const differ = Object.keys(stored).filter((k) => JSON.stringify(stored[k]) !== JSON.stringify(now[k]))
if (differ.length) {
  for (const k of differ) console.error(`FAIL  the card shows ${k} ${JSON.stringify(stored[k])}, the page now shows ${JSON.stringify(now[k])}`)
  console.error('      run `npm run capture` and look at the new picture before committing it')
  process.exit(1)
}
console.log(`check:capture ok: the link preview shows the page as it is (${Object.keys(stored).length} fields compared)`)
