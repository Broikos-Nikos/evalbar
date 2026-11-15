/**
 * The pictures of the page.
 *
 *   npm run capture                                  public/card.png, the link preview, 1200 by 630
 *   node tools/capture.ts --still <file.jpg> [--url <page>]
 *                                                    the page at 1920 by 1080 as a desktop visitor sees
 *                                                    it at load, for the card on broikos.gr
 *
 * Both are the page at load: the headline and `evalbar compare` refusing
 * semcache's two caches. Beside the card, `capture.json` keeps the words the
 * card shows; `check:capture` reads the same words off the page being served
 * and fails when they differ, so a page that changed its claim cannot keep an
 * old picture of it.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium, type Page } from 'playwright'
import { browserReady } from './preflight.ts'
import { serve } from './serve.ts'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/** The words a reader sees in the card: the claim and the command's answer. */
export async function visibleWords(page: Page) {
  return page.evaluate(() => ({
    headline: document.querySelector('#headline')!.textContent!.trim(),
    command: document.querySelector('#hero-cmd')!.textContent!.trim(),
    answer: document.querySelector('#hero-out')!.textContent!.trim().split('\n'),
  }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { still: { type: 'string' }, url: { type: 'string' } } })
  await browserReady()
  const server = values.url ? null : await serve()
  const url = values.url ?? server!.url
  const browser = await chromium.launch()
  try {
    if (values.still) {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
      await page.goto(url, { waitUntil: 'networkidle' })
      await page.waitForSelector('#real .stat')
      await page.screenshot({ path: values.still, type: 'jpeg', quality: 90 })
      console.log(`wrote ${values.still} from ${url}`)
    } else {
      const card = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
      await card.goto(url)
      await card.waitForSelector('#real .stat')
      await card.screenshot({ path: here('../public/card.png') })
      writeFileSync(here('../capture.json'), `${JSON.stringify(await visibleWords(card), null, 1)}\n`)
      console.log('wrote public/card.png and capture.json')
    }
  } finally {
    await browser.close()
    server?.stop()
  }
}
