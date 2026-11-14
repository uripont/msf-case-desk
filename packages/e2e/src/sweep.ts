// Every route of the web app, at 375 px and 1280 px, in every
// browser engine that runs here, in its loaded, empty, loading and error
// states. Nothing here names a route by hand for the list: the tags come from
// the router (`AppRoute.members`), and a route without a sample fails the sweep,
// so a new route cannot be missed (and the table below does not compile
// without it).
//
// Per page: no horizontal page scroll, no console error and no page error, a
// small accessibility check (names on inputs, buttons and links, alt on
// images, one level-1 heading, headings that do not skip a level, unique ids,
// a language and a title), and one screenshot under `.screens/`.
import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { type Browser, type BrowserContext, type Page } from 'playwright-core'

import { AppRoute, pathOf } from '../../../apps/web/src/route.ts'

export type Engine = Readonly<{ name: string; browser: Browser }>

export type Actor = 'admin' | 'reviewer' | 'empty' | 'anonymous'

export type SweepContext = Readonly<{
  pilotUrl: string
  password: string
  emails: Readonly<Record<Exclude<Actor, 'anonymous'>, string>>
  reports: Readonly<{ closing: string; empty: string }>
  template: Readonly<{ templateId: string; version: number }>
  engines: ReadonlyArray<Engine>
  screens: string
  step: (name: string, body: () => Promise<void>) => Promise<void>
}>

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>

type Sample = Readonly<{
  route: AppRoute
  actor: Actor
  // The same screen with nothing in it, seen by the author with no data.
  empty?: AppRoute
}>

// NOTE: Screens that make no request when they open (a form over what the
// session already holds), so a failing server has nothing to break there.
const NO_LOAD = new Set(['Home', 'Account', 'NotFound'])

const WIDTHS = [375, 1280] as const
const STATES = ['loaded', 'empty', 'loading', 'error'] as const
type State = (typeof STATES)[number]

// NOTE: The answer of the server is held back this long to see the loading
// state, and the screen must then arrive.
const LOADING_MS = 2500

export const routeTags = (): ReadonlyArray<string> =>
  AppRoute.members.map(member => member.fields._tag.schema.literal)

export const samples = (ctx: SweepContext): Record<AppRoute['_tag'], Sample> => {
  const { closing, empty } = ctx.reports
  return {
    Home: { route: AppRoute.Home(), actor: 'admin' },
    Account: { route: AppRoute.Account(), actor: 'admin' },
    Unit: { route: AppRoute.Unit(), actor: 'admin', empty: AppRoute.Unit() },
    Reports: { route: AppRoute.Reports(), actor: 'admin', empty: AppRoute.Reports() },
    Admin: { route: AppRoute.Admin(), actor: 'admin' },
    Theme: { route: AppRoute.Theme(), actor: 'admin' },
    Templates: { route: AppRoute.Templates(), actor: 'admin' },
    TemplateEditor: {
      route: AppRoute.TemplateEditor(ctx.template),
      actor: 'admin',
    },
    Inbox: { route: AppRoute.Inbox(), actor: 'reviewer', empty: AppRoute.Inbox() },
    Notifications: {
      route: AppRoute.Notifications(),
      actor: 'admin',
      empty: AppRoute.Notifications(),
    },
    Link: { route: AppRoute.Link(), actor: 'anonymous' },
    Report: {
      route: AppRoute.Report({ reportId: closing }),
      actor: 'admin',
      empty: AppRoute.Report({ reportId: empty }),
    },
    Share: {
      route: AppRoute.Share({ reportId: closing }),
      actor: 'admin',
      empty: AppRoute.Share({ reportId: empty }),
    },
    Names: {
      route: AppRoute.Names({ reportId: closing }),
      actor: 'admin',
      empty: AppRoute.Names({ reportId: empty }),
    },
    Publish: {
      route: AppRoute.Publish({ reportId: closing }),
      actor: 'admin',
      empty: AppRoute.Publish({ reportId: empty }),
    },
    Drafts: {
      route: AppRoute.Drafts({ reportId: closing }),
      actor: 'admin',
      empty: AppRoute.Drafts({ reportId: empty }),
    },
    Draft: {
      route: AppRoute.Draft({ reportId: closing, draft: 1 }),
      actor: 'admin',
      empty: AppRoute.Draft({ reportId: empty, draft: 1 }),
    },
    Comments: {
      route: AppRoute.Comments({ reportId: closing }),
      actor: 'admin',
      empty: AppRoute.Comments({ reportId: empty }),
    },
    Grid: {
      route: AppRoute.Grid({ reportId: closing }),
      actor: 'admin',
      empty: AppRoute.Grid({ reportId: empty }),
    },
    Audit: {
      route: AppRoute.Audit({ reportId: closing }),
      actor: 'admin',
      empty: AppRoute.Audit({ reportId: empty }),
    },
    Downloads: {
      route: AppRoute.Downloads({ reportId: closing }),
      actor: 'admin',
      empty: AppRoute.Downloads({ reportId: empty }),
    },
    Revision: {
      route: AppRoute.Revision({ reportId: closing, revision: 2 }),
      actor: 'reviewer',
      empty: AppRoute.Revision({ reportId: empty, revision: 1 }),
    },
    NotFound: { route: AppRoute.NotFound({ path: '/no-such-page' }), actor: 'admin' },
  }
}

// NOTE: The checks run in the page. Each returns a list of problems.
export const accessibilityProblems = (page: Page): Promise<Array<string>> =>
  page.evaluate(() => {
    const problems: Array<string> = []
    const visible = (element: Element): boolean => {
      const box = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return style.visibility !== 'hidden' && style.display !== 'none' && (box.width > 0 || box.height > 0)
    }
    const textOf = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim()
    const describe = (element: Element): string => {
      const id = element.id === '' ? '' : `#${element.id}`
      return `${element.tagName.toLowerCase()}${id} "${textOf(element).slice(0, 40)}"`
    }
    const labelled = (element: Element): boolean => {
      if ((element.getAttribute('aria-label') ?? '').trim() !== '') {
        return true
      }
      const by = element.getAttribute('aria-labelledby')
      if (by !== null && by.split(/\s+/).some(id => textOf(document.getElementById(id) ?? element) !== '' && document.getElementById(id) !== null)) {
        return true
      }
      const labels = (element as HTMLInputElement).labels
      if (labels !== undefined && labels !== null && Array.from(labels).some(label => textOf(label) !== '')) {
        return true
      }
      return (element.getAttribute('title') ?? '').trim() !== ''
    }
    for (const element of Array.from(document.querySelectorAll('input, select, textarea'))) {
      if ((element as HTMLInputElement).type === 'hidden' || !visible(element)) {
        continue
      }
      const type = (element as HTMLInputElement).type
      if ((type === 'submit' || type === 'button') && (element as HTMLInputElement).value !== '') {
        continue
      }
      if (!labelled(element)) {
        problems.push(`input without a name: ${describe(element)}`)
      }
    }
    for (const element of Array.from(document.querySelectorAll('[role="textbox"], [contenteditable="true"]'))) {
      if (visible(element) && !labelled(element)) {
        problems.push(`editable region without a name: ${describe(element)}`)
      }
    }
    for (const element of Array.from(document.querySelectorAll('button, [role="button"], a[href]'))) {
      if (!visible(element)) {
        continue
      }
      const image = element.querySelector('img[alt]')
      const hasName =
        textOf(element) !== '' ||
        (element.getAttribute('aria-label') ?? '').trim() !== '' ||
        (element.getAttribute('title') ?? '').trim() !== '' ||
        (image !== null && (image.getAttribute('alt') ?? '').trim() !== '')
      if (!hasName) {
        problems.push(`${element.tagName.toLowerCase()} without a name: ${describe(element)}`)
      }
    }
    for (const element of Array.from(document.querySelectorAll('img'))) {
      if (!element.hasAttribute('alt')) {
        problems.push(`image without alt: ${element.getAttribute('src')?.slice(0, 60) ?? ''}`)
      }
    }
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')).filter(visible)
    const levelOf = (element: Element): number =>
      element.hasAttribute('aria-level') ? Number(element.getAttribute('aria-level')) : Number(element.tagName.slice(1))
    const ones = headings.filter(heading => levelOf(heading) === 1)
    if (ones.length !== 1) {
      problems.push(`${ones.length} level-1 headings, expected 1`)
    }
    let previous = 0
    for (const heading of headings) {
      const level = levelOf(heading)
      if (previous !== 0 && level > previous + 1) {
        problems.push(`heading skips from level ${previous} to ${level}: ${describe(heading)}`)
      }
      previous = level
    }
    const seen = new Set<string>()
    for (const element of Array.from(document.querySelectorAll('[id]'))) {
      if (seen.has(element.id)) {
        problems.push(`duplicate id: ${element.id}`)
      }
      seen.add(element.id)
    }
    if ((document.documentElement.lang ?? '') === '') {
      problems.push('no lang on the page')
    }
    if (document.title.trim() === '') {
      problems.push('no title')
    }
    if (document.querySelector('main') === null) {
      problems.push('no main landmark')
    }
    return problems
  })

const signIn = async (
  browser: Browser,
  base: string,
  email: string,
  password: string,
): Promise<StorageState> => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  try {
    const page = await context.newPage()
    await page.goto(`${base}/`)
    await page.getByLabel('E-mail').fill(email)
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByRole('button', { name: 'Sign out' }).waitFor()
    return await context.storageState()
  } finally {
    await context.close()
  }
}

// NOTE: In the error state every RPC but the one that asks who is signed in
// is answered with a server error, so the screen's own load fails and not the
// whole session.
const SESSION_TAGS = new Set(['GetMe'])
const tagsOf = (body: string | null): ReadonlyArray<string> => {
  try {
    const parsed: unknown = JSON.parse(body ?? '')
    const messages = Array.isArray(parsed) ? parsed : [parsed]
    return messages.flatMap(message =>
      typeof message === 'object' && message !== null && 'tag' in message && typeof message.tag === 'string'
        ? [message.tag]
        : [],
    )
  } catch {
    return []
  }
}
const isApiCall = (url: string): boolean => /\/api\/(q\/rpc|q\/public|rpc|images)/.test(url)

const interceptFor = async (page: Page, state: State): Promise<void> => {
  if (state !== 'loading' && state !== 'error') {
    return
  }
  await page.route(
    url => isApiCall(url.toString()),
    async route => {
      const request = route.request()
      if (request.method() !== 'POST' && !request.url().includes('/api/images')) {
        await route.continue()
        return
      }
      const tags = tagsOf(request.postData())
      if (tags.length > 0 && tags.every(tag => SESSION_TAGS.has(tag))) {
        await route.continue()
        return
      }
      if (state === 'error') {
        await route.fulfill({ status: 500, contentType: 'text/plain', body: 'Injected failure' })
        return
      }
      await new Promise(resolve => setTimeout(resolve, LOADING_MS))
      await route.continue().catch(() => undefined)
    },
  )
}

export const runSweep = async (ctx: SweepContext): Promise<void> => {
  const table = samples(ctx)
  const tags = routeTags()
  const index: Array<string> = ['# Quoroom screens', '', 'Engine, route, state, width, file.', '']
  let pages = 0

  await ctx.step('every route of the router has a sweep sample', async () => {
    assert.deepEqual([...tags].sort(), Object.keys(table).sort())
    assert.ok(tags.length >= 23, `only ${tags.length} routes`)
  })

  for (const engine of ctx.engines) {
    await ctx.step(`${engine.name}: the accessibility check finds what it should`, async () => {
      const page = await engine.browser.newPage()
      try {
        await page.setContent(
          '<html><body><h3>Late</h3><input><img src="x.png"><button style="width:20px;height:20px"></button><a href="/x" style="display:inline-block;width:20px;height:20px"></a><p id="a"></p><p id="a"></p></body></html>',
        )
        const found = await accessibilityProblems(page)
        for (const expected of ['input without a name', 'image without alt', 'button without a name', 'a without a name', 'duplicate id', 'level-1 headings', 'no lang', 'no title', 'no main']) {
          assert.ok(found.some(problem => problem.includes(expected)), `not found: ${expected}`)
        }
      } finally {
        await page.close()
      }
    })
    const states = new Map<Actor, StorageState | undefined>()
    await ctx.step(`${engine.name}: the sweep accounts sign in`, async () => {
      states.set('anonymous', undefined)
      for (const actor of ['admin', 'reviewer', 'empty'] as const) {
        states.set(actor, await signIn(engine.browser, ctx.pilotUrl, ctx.emails[actor], ctx.password))
      }
    })
    const outDir = join(ctx.screens, engine.name)
    mkdirSync(outDir, { recursive: true })

    for (const tag of tags) {
      const sample = table[tag as AppRoute['_tag']]
      for (const state of STATES) {
        const route = state === 'empty' ? sample.empty : sample.route
        if (route === undefined) {
          continue
        }
        const actor: Actor = state === 'empty' ? 'empty' : sample.actor
        const base = ctx.pilotUrl
        for (const width of WIDTHS) {
          await ctx.step(`${engine.name} ${tag} ${state} at ${width}`, async () => {
            const context = await engine.browser.newContext({
              viewport: { width, height: width === 375 ? 812 : 900 },
              ...(states.get(actor) === undefined ? {} : { storageState: states.get(actor) as StorageState }),
            })
            const problems: Array<string> = []
            try {
              const page = await context.newPage()
              page.on('console', message => {
                const text = message.text()
                const expected = state === 'error' && /Failed to load resource|status of 500|Injected failure/.test(text)
                if (message.type() === 'error' && !expected) {
                  problems.push(`console error: ${text.slice(0, 200)}`)
                }
              })
              page.on('pageerror', error => problems.push(`page error: ${error.message.slice(0, 200)}`))
              await interceptFor(page, state)
              const path = tag === 'Link' && state === 'loaded' ? `${pathOf(route)}#${'0'.repeat(64)}` : pathOf(route)
              await page.goto(`${base}${path}`, { waitUntil: 'commit' })
              await page.locator('h1').first().waitFor({ timeout: 20_000 })
              if (state === 'loading') {
                assert.ok(
                  (await page.locator('h1, [role="status"]').count()) > 0,
                  'nothing is shown while loading',
                )
              } else {
                await settle(page, state)
              }
              const overflow = await page.evaluate(
                () => document.documentElement.scrollWidth - window.innerWidth,
              )
              assert.ok(overflow <= 0, `the page scrolls sideways by ${overflow}px`)
              const file = `${tag}-${state}-${width}.png`
              await page.screenshot({ path: join(outDir, file), fullPage: true })
              index.push(`- ${engine.name} | ${tag} | ${state} | ${width} | ${engine.name}/${file}`)
              pages += 1
              if (state === 'loading') {
                await settle(page, 'loaded')
              }
              if (state === 'loaded' || state === 'empty') {
                problems.push(...(await accessibilityProblems(page)).map(problem => `a11y: ${problem}`))
              }
              if (state === 'error') {
                const shown =
                  (await page.locator('[role="alert"]').count()) > 0 ||
                  /could not|did not answer|try again|unavailable|not available|failed/i.test(
                    await page.locator('main').innerText(),
                  )
                assert.ok(shown || NO_LOAD.has(tag), 'a failing server shows nothing to the reader')
              }
              assert.deepEqual(problems, [])
            } finally {
              await context.close()
            }
          })
        }
      }
    }
  }
  mkdirSync(ctx.screens, { recursive: true })
  writeFileSync(join(ctx.screens, 'index.md'), `${index.join('\n')}\n`)
  console.log(`sweep: ${pages} screenshots, index at ${join(ctx.screens, 'index.md')}`)
}

// NOTE: A screen is settled when no "Loading" status is left and the network
// has been quiet for a moment.
const settle = async (page: Page, state: State): Promise<void> => {
  await page
    .locator('[role="status"]', { hasText: /^Loading|Loading\.$|Loading…$/ })
    .first()
    .waitFor({ state: 'detached', timeout: state === 'loaded' ? 20_000 : 10_000 })
    .catch(() => undefined)
  await page.waitForTimeout(250)
}
