// Helpers shared by the browser check (quoroom.e2e.ts) and the pilot script
// rehearsal (rehearsal.ts). Everything they make is synthetic.
import { strict as assert } from 'node:assert'
import { join } from 'node:path'

import { type Browser, type Locator, type Page } from 'playwright-core'

export const PASSWORD = 'synthetic-pass-1234'

// NOTE: read at each call, so a script can set its own folder first.
const shotsDir = (): string => process.env.E2E_SHOTS ?? '/tmp/quoroom-e2e-screens'

// NOTE: A committee member is added by a click that the server answers; the
// box shows the answer. A member change is one add operation, so a second
// click while the first is still in flight is harmless, and a click that did
// not take is tried again instead of being waited for.
export const ensureChecked = async (box: Locator, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await box.check({ timeout: 4000 })
      return
    } catch {
      if (await box.isChecked()) return
    }
  }
  assert.ok(await box.isChecked(), what)
}

export const results: Array<{ name: string; ok: boolean }> = []

export const step = async (name: string, body: () => Promise<void>): Promise<void> => {
  try {
    await body()
    results.push({ name, ok: true })
    console.log(`ok   ${name}`)
  } catch (error) {
    results.push({ name, ok: false })
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : error}`)
  }
}

export const noSideScroll = async (page: Page): Promise<void> => {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  assert.ok(overflow <= 0, `the page scrolls sideways by ${overflow}px`)
}

export const shot = async (page: Page, name: string): Promise<void> => {
  await noSideScroll(page)
  await page.screenshot({ path: join(shotsDir(), `${name}.png`), fullPage: true })
}

// NOTE: a person in their own browser context, at phone width unless asked.
export const person = async (browser: Browser, width = 375): Promise<Page> => {
  const context = await browser.newContext({
    viewport: width === 375 ? { width: 375, height: 812 } : { width, height: 900 },
    deviceScaleFactor: width === 375 ? 2 : 1,
    acceptDownloads: true,
  })
  const page = await context.newPage()
  if (process.env.E2E_DEBUG === '1') {
    page.on('console', message => console.log(`[console ${message.type()}] ${message.text()}`))
    page.on('pageerror', error => console.log(`[pageerror] ${error.message}`))
  }
  return page
}

export const activate = async (page: Page, link: string, name: string): Promise<void> => {
  await page.goto(link)
  await page.getByRole('heading', { name: 'Set your password' }).waitFor()
  await shot(page, `${name}-1-set-password`)
  await page.getByLabel('New password').fill(PASSWORD)
  await page.getByLabel('Type it again').fill(PASSWORD)
  await page.getByRole('button', { name: 'Set password and sign in' }).click()
  await page.getByRole('button', { name: 'Sign out' }).waitFor()
  assert.equal(new URL(page.url()).pathname, '/')
  assert.equal(new URL(page.url()).hash, '', 'the token is left in the address')
  await shot(page, `${name}-2-signed-in`)
}

export const copiedLink = async (page: Page): Promise<string> => {
  const link = await page.getByRole('textbox', { name: 'Link' }).inputValue()
  assert.match(link, /\/link#[0-9a-f]{64}$/)
  await page.getByRole('button', { name: 'I have copied it' }).click()
  await page.getByRole('textbox', { name: 'Link' }).waitFor({ state: 'detached' })
  return link
}

export const reportIdOf = (page: Page): string => new URL(page.url()).pathname.split('/').pop() ?? ''

// NOTE: on a phone the sections are behind a "Sections" button.
export const openIn = async (page: Page, name: RegExp): Promise<void> => {
  const row = page.getByRole('button', { name })
  const sections = page.getByRole('button', { name: /^Sections/ })
  await row.first().or(sections).first().waitFor()
  if (!(await row.first().isVisible())) {
    await sections.click()
  }
  await row.first().click()
}

export const settled = async (page: Page): Promise<void> => {
  await page.waitForTimeout(400)
  await page.getByText(/Saved at \d\d:\d\d/).waitFor()
}

// NOTE: selects a phrase inside the item `[data-comment-item=<item>]`, as a
// person dragging over it would.
export const selectPhrase = async (page: Page, item: string, phrase: string): Promise<void> => {
  await page.locator(`[data-comment-item="${item}"]`, { hasText: phrase }).first().waitFor()
  await page.evaluate(
    ({ item, phrase }) => {
      const root = document.querySelector(`[data-comment-item="${item}"]`)
      if (root === null) throw new Error(`no item ${item} to select in`)
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const at = (node.textContent ?? '').indexOf(phrase)
        if (at >= 0) {
          const range = document.createRange()
          range.setStart(node, at)
          range.setEnd(node, at + phrase.length)
          const selection = window.getSelection()
          selection?.removeAllRanges()
          selection?.addRange(range)
          return
        }
      }
      throw new Error(`the phrase is not in ${item}`)
    },
    { item, phrase },
  )
}

// NOTE: a generated picture, made in the page. No real photograph is ever used.
export const syntheticImage = (
  page: Page,
  options: { width: number; height: number; kind: 'photo' | 'transparent' | 'noise'; quality: number },
): Promise<string> =>
  page.evaluate(async ({ width, height, kind, quality }) => {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (context === null) {
      throw new Error('no canvas')
    }
    if (kind === 'photo') {
      const gradient = context.createLinearGradient(0, 0, width, height)
      gradient.addColorStop(0, '#264653')
      gradient.addColorStop(0.5, '#e9c46a')
      gradient.addColorStop(1, '#e76f51')
      context.fillStyle = gradient
      context.fillRect(0, 0, width, height)
      context.fillStyle = '#ffffff'
      context.beginPath()
      context.arc(width / 2, height / 2, height / 4, 0, Math.PI * 2)
      context.fill()
    } else if (kind === 'transparent') {
      context.clearRect(0, 0, width, height)
      context.fillStyle = '#d62828'
      context.beginPath()
      context.arc(width / 2, height / 2, height / 3, 0, Math.PI * 2)
      context.fill()
    } else {
      const pixels = context.createImageData(width, height)
      for (let at = 0; at < pixels.data.length; at += 65_536) {
        crypto.getRandomValues(pixels.data.subarray(at, Math.min(at + 65_536, pixels.data.length)))
      }
      for (let at = 3; at < pixels.data.length; at += 4) {
        pixels.data[at] = 255
      }
      // NOTE: one translucent pixel makes the re-encoded picture a PNG, and
      // noise does not compress, so it stays over 1 MB.
      pixels.data[3] = 128
      context.putImageData(pixels, 0, 0)
    }
    const blob = await canvas.convertToBlob(
      kind !== 'photo' ? { type: 'image/png' } : { type: 'image/jpeg', quality },
    )
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let binary = ''
    for (let at = 0; at < bytes.length; at += 32_768) {
      binary += String.fromCharCode(...bytes.subarray(at, at + 32_768))
    }
    return btoa(binary)
  }, options)

// NOTE: The People screen's "Add person" form: a unit to write reports in,
// and any of People, Theme and Templates. A new e-mail gets a one-time link.
export const addPerson = async (
  page: Page,
  who: Readonly<{ email: string; name: string; unit?: string; permissions?: ReadonlyArray<'People' | 'Theme' | 'Templates'> }>,
): Promise<void> => {
  const form = page.getByRole('form', { name: 'Add person' })
  await form.getByLabel('E-mail', { exact: true }).fill(who.email)
  await form.getByLabel('Name', { exact: true }).fill(who.name)
  if (who.unit !== undefined) {
    await form.getByLabel('Reports in unit', { exact: true }).selectOption({ label: who.unit })
  }
  for (const permission of who.permissions ?? []) {
    await form.getByLabel(permission, { exact: true }).check()
  }
  await form.getByRole('button', { name: 'Add person' }).click()
}

// NOTE: The People screen's "New unit" form; the unit's folder appears.
export const createUnit = async (page: Page, name: string, code: string): Promise<void> => {
  const form = page.getByRole('form', { name: 'New unit' })
  await form.getByLabel('Unit name').fill(name)
  await form.getByLabel('Unit code').fill(code)
  await form.getByRole('button', { name: 'Create unit' }).click()
  await page.getByRole('button', { name: new RegExp(`^. ${name} \\(${code}\\)`) }).waitFor()
}
