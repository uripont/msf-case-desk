// Stage 10a: keyboard use and a session that ends in the middle of work. Every
// step is driven with the keyboard alone (no click) where it says so.
import { strict as assert } from 'node:assert'

import { type Browser, type Page } from 'playwright-core'

import { type Engine } from './sweep.ts'

export type KeyboardContext = Readonly<{
  pilotUrl: string
  password: string
  emails: Readonly<{ admin: string; reviewer: string; empty: string }>
  reports: Readonly<{ closing: string; empty: string; reviewing: string }>
  engines: ReadonlyArray<Engine>
  step: (name: string, body: () => Promise<void>) => Promise<void>
  // Issues a reset link for an account and uses it with the same password,
  // which ends all the sessions of the account.
  endSessionsOf: (name: string) => Promise<void>
}>

type Focused = Readonly<{
  tag: string
  id: string
  name: string
  inDialog: boolean
  hasFocusStyle: boolean
}>

const focused = (page: Page): Promise<Focused> =>
  page.evaluate(() => {
    const element = document.activeElement ?? document.body
    const style = getComputedStyle(element)
    const name =
      element.getAttribute('aria-label') ??
      (element as HTMLInputElement).labels?.[0]?.textContent ??
      element.textContent ??
      ''
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id,
      name: name.replace(/\s+/g, ' ').trim().slice(0, 80),
      inDialog: element.closest('[role="alertdialog"], [role="dialog"]') !== null,
      hasFocusStyle:
        (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) ||
        style.boxShadow !== 'none',
    }
  })

// NOTE: Presses Tab until the focused element matches, at most `max` times.
const tabTo = async (
  page: Page,
  matches: (info: Focused) => boolean,
  what: string,
  max = 150,
): Promise<Focused> => {
  for (let count = 0; count < max; count += 1) {
    await page.keyboard.press('Tab')
    const info = await focused(page)
    if (matches(info)) {
      return info
    }
  }
  throw new Error(`Tab never reached ${what}`)
}

// NOTE: Every stop of the tab order of a page shows where the focus is, and
// the focus is never lost to the page body in the middle of it.
const tabThrough = async (page: Page, label: string): Promise<void> => {
  const bare: Array<string> = []
  let stops = 0
  const seen = new Set<string>()
  for (let count = 0; count < 120; count += 1) {
    await page.keyboard.press('Tab')
    const info = await focused(page)
    if (info.tag === 'body') {
      break
    }
    const key = `${info.tag}#${info.id}:${info.name}:${count > 100 ? count : ''}`
    if (seen.has(key) && info.id === '') {
      continue
    }
    seen.add(key)
    stops += 1
    if (!info.hasFocusStyle) {
      bare.push(`${info.tag}#${info.id} "${info.name}"`)
    }
  }
  assert.ok(stops >= 3, `${label}: only ${stops} tab stops`)
  assert.deepEqual(bare, [], `${label}: focus is not visible on`)
}

const newPage = async (browser: Browser, width = 1280): Promise<Page> => {
  const context = await browser.newContext({ viewport: { width, height: 900 } })
  return context.newPage()
}

const signInByKeyboard = async (page: Page, base: string, email: string, password: string, path = '/'): Promise<void> => {
  await page.goto(`${base}${path}`)
  await page.getByRole('heading', { name: 'Sign in' }).waitFor()
  await tabTo(page, info => info.id === 'login-email', 'the e-mail field')
  await page.keyboard.type(email)
  await page.keyboard.press('Tab')
  assert.equal((await focused(page)).id, 'login-password')
  await page.keyboard.type(password)
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Sign out' }).waitFor()
}

const gone = async (page: Page, selector: string): Promise<void> => {
  await page.locator(selector).first().waitFor({ state: 'detached', timeout: 5000 })
}

// NOTE: A dialog opened with the keyboard takes the focus into it, Escape
// closes it, and the focus is back on what opened it (or at least not lost).
const dialogCycle = async (
  page: Page,
  trigger: RegExp,
  dialog: string,
  label: string,
): Promise<void> => {
  const info = await tabTo(page, each => each.tag === 'button' && trigger.test(each.name), `the button ${trigger}`)
  await page.keyboard.press('Enter')
  await page.locator(dialog).first().waitFor({ timeout: 8000 })
  await page.waitForTimeout(200)
  assert.ok((await focused(page)).inDialog, `${label}: the focus did not move into the dialog`)
  await page.keyboard.press('Escape')
  await gone(page, dialog)
  await page.waitForTimeout(200)
  const after = await focused(page)
  assert.notEqual(after.tag, 'body', `${label}: the focus was lost when the dialog closed`)
  assert.equal(after.name, info.name, `${label}: the focus did not return to "${info.name}" (it is on "${after.name}")`)
}

export const runKeyboard = async (ctx: KeyboardContext): Promise<void> => {
  const { pilotUrl: base, password, emails, reports } = ctx
  for (const engine of ctx.engines) {
    const tag = (name: string): string => `${engine.name}: ${name}`

    await ctx.step(tag('sign in with the keyboard alone, and every tab stop of the main screens shows the focus'), async () => {
      const page = await newPage(engine.browser)
      try {
        await signInByKeyboard(page, base, emails.admin, password)
        for (const path of ['/reports', '/unit', '/templates', `/r/${reports.closing}`, `/r/${reports.closing}/grid`]) {
          await page.goto(`${base}${path}`)
          await page.locator('h1').first().waitFor()
          await page.waitForTimeout(600)
          await page.locator('body').click({ position: { x: 1, y: 1 } })
          await tabThrough(page, path)
        }
      } finally {
        await page.context().close()
      }
    })

    await ctx.step(tag('a reviewer comments and sends from the keyboard; the send dialog takes the focus, Escape closes it and gives the focus back'), async () => {
      const page = await newPage(engine.browser)
      try {
        await signInByKeyboard(page, base, emails.reviewer, password, `/r/${reports.reviewing}/rev/1`)
        await page.getByRole('heading', { name: 'Revision 1' }).waitFor()
        await page.getByRole('button', { name: 'Comment on this section' }).first().waitFor()
        await tabTo(page, info => info.tag === 'button' && info.name === 'Comment on this section', 'the section comment button')
        await page.keyboard.press('Enter')
        await page.getByRole('textbox', { name: 'Your comment' }).waitFor()
        assert.equal((await focused(page)).id, 'new-comment', 'the comment box did not take the focus')
        await page.keyboard.type(`Keyboard comment from ${engine.name}.`)
        await tabTo(page, info => info.tag === 'button' && info.name === 'Add comment', 'Add comment')
        await page.keyboard.press('Space')
        await page.locator('[data-comment]').first().waitFor()
        await dialogCycle(page, /^Send your review$/, '[data-dialog="send-review"]', 'the send dialog')
        await page.keyboard.press('Enter')
        await page.locator('[data-dialog="send-review"]').waitFor()
        await page.keyboard.press('Escape')
        await gone(page, '[data-dialog="send-review"]')
        await page.locator('[data-pending-count]').first().waitFor()
      } finally {
        await page.context().close()
      }
    })

    await ctx.step(tag('names, template and editor dialogs: opened by keyboard, Escape closes, focus returns'), async () => {
      const eve = await newPage(engine.browser)
      const pia = await newPage(engine.browser)
      try {
        await signInByKeyboard(eve, base, emails.empty, password, `/r/${reports.empty}/names`)
        await eve.getByRole('button', { name: 'Add a person' }).first().waitFor()
        await eve.getByRole('button', { name: 'Add a person' }).first().focus()
        await eve.keyboard.press('Enter')
        await eve.locator('#person-name').waitFor()
        await eve.locator('#person-name').fill(`Nora Names ${engine.name}`)
        await eve.getByRole('button', { name: /^(Add|Save) this person/ }).first().click()
        await eve.getByRole('button', { name: new RegExp(`^Remove Nora Names ${engine.name}`) }).waitFor()
        await dialogCycle(eve, new RegExp(`^Remove Nora Names ${engine.name}`), '[role="alertdialog"]', 'removing a person')

        await signInByKeyboard(pia, base, emails.admin, password, '/templates')
        await pia.getByRole('button', { name: /^Discard the draft of/ }).first().waitFor()
        await dialogCycle(pia, /^Discard the draft of/, '[role="alertdialog"]', 'discarding a template draft')
      } finally {
        await eve.context().close()
        await pia.context().close()
      }
    })

    await ctx.step(tag('a session that ends while a reviewer has pending comments: the next action shows the sign-in, and the comments are there after it'), async () => {
      const page = await newPage(engine.browser)
      try {
        await signInByKeyboard(page, base, emails.reviewer, password, `/r/${reports.reviewing}/rev/1`)
        await page.getByRole('heading', { name: 'Revision 1' }).waitFor()
        await page.locator('[data-pending-count]').first().waitFor()
        const pendingBefore = Number(await page.locator('[data-pending-count]').first().getAttribute('data-pending-count'))
        assert.ok(pendingBefore >= 1, 'no pending comment to keep')
        await page.getByRole('button', { name: 'Comment on this section' }).first().click()
        await page.getByRole('textbox', { name: 'Your comment' }).fill('Typed when the session had ended.')
        await ctx.endSessionsOf('Ravi Reviewer')
        await page.getByRole('button', { name: 'Add comment' }).click()
        await page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout: 10_000 })
        assert.equal(new URL(page.url()).pathname, `/r/${reports.reviewing}/rev/1`)
        await page.getByLabel('Password', { exact: true }).fill(password)
        await page.getByRole('button', { name: 'Sign in' }).click()
        await page.getByRole('heading', { name: 'Revision 1' }).waitFor()
        assert.equal(new URL(page.url()).pathname, `/r/${reports.reviewing}/rev/1`)
        assert.equal(
          await page.getByRole('textbox', { name: 'Your comment' }).inputValue(),
          'Typed when the session had ended.',
          'the comment being written was lost',
        )
        await page.getByRole('button', { name: 'Add comment' }).click()
        await page.locator(`[data-pending-count="${pendingBefore + 1}"]`).waitFor()
        await page.reload()
        await page.getByRole('heading', { name: 'Revision 1' }).waitFor()
        await page.locator(`[data-pending-count="${pendingBefore + 1}"]`).waitFor()
      } finally {
        await page.context().close()
      }
    })

    await ctx.step(tag('a session that ends mid-drafting: the edit is kept, the sign-in shows, and the edit is saved after it'), async () => {
      const page = await newPage(engine.browser)
      try {
        await signInByKeyboard(page, base, emails.empty, password, `/r/${reports.empty}`)
        const field = page.getByLabel('Investigator', { exact: true })
        await field.waitFor()
        await ctx.endSessionsOf('Eve Empty')
        const text = `Written after the session ended (${engine.name}).`
        await field.fill(text)
        await page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout: 20_000 })
        assert.equal(new URL(page.url()).pathname, `/r/${reports.empty}`)
        await page.getByLabel('Password', { exact: true }).fill(password)
        await page.getByRole('button', { name: 'Sign in' }).click()
        await page.getByLabel('Investigator', { exact: true }).waitFor()
        assert.equal(await page.getByLabel('Investigator', { exact: true }).inputValue(), text, 'the edit was lost')
        await page.getByText(/Saved at \d\d:\d\d/).waitFor({ timeout: 20_000 })
        await page.reload()
        await page.getByLabel('Investigator', { exact: true }).waitFor()
        assert.equal(await page.getByLabel('Investigator', { exact: true }).inputValue(), text, 'the edit was not saved')
      } finally {
        await page.context().close()
      }
    })
  }
}
