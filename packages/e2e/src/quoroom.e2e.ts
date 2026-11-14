// Browser check of the Quoroom "done when" flow of stage 3, at 375 px.
//
//   pnpm --filter @case-desk/e2e e2e
//
// It builds the web app and the workerd bundle, makes an administrator with
// `grant-admin` in a temporary folder (never in .local), starts plain workerd
// on a free port, and drives Chromium through: the administrator opens the
// activation link, creates a unit and grants two authors; an author invites a
// person and registers a reviewer; every one of them activates; a used link
// fails; inviting an existing e-mail makes no link; the throttle is explained.
// Screenshots go to E2E_SHOTS (default /tmp/quoroom-e2e-screens), outside the
// repository. Everything is synthetic.
import { strict as assert } from 'node:assert'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'

import { extractPages } from '@case-desk/pdf/testing'
import { type Browser, type Locator, type Page, chromium } from 'playwright-core'

const root = join(import.meta.dirname, '../../..')
// NOTE: invented, for the local test server only.
const TICK_SECRET = 'e2e-tick-secret-not-a-real-one'
const shots = process.env.E2E_SHOTS ?? '/tmp/quoroom-e2e-screens'
const chromePath = process.env.E2E_CHROMIUM ?? '/usr/bin/chromium'

// NOTE: A committee member is added by a click that the server answers; the
// box shows the answer. A member change is one add operation, so a second
// click while the first is still in flight is harmless, and a click that did
// not take is tried again instead of being waited for.
const ensureChecked = async (box: Locator, what: string): Promise<void> => {
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
const PASSWORD = 'synthetic-pass-1234'

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })

const run = (command: string, args: ReadonlyArray<string>, env = {}): string => {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr}`)
  }
  return result.stdout
}

const waitForHealth = async (base: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`)
      if (response.ok) {
        return
      }
    } catch {
      // not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('workerd did not come up')
}

const results: Array<{ name: string; ok: boolean }> = []

const step = async (name: string, body: () => Promise<void>): Promise<void> => {
  try {
    await body()
    results.push({ name, ok: true })
    console.log(`ok   ${name}`)
  } catch (error) {
    results.push({ name, ok: false })
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : error}`)
  }
}

const noSideScroll = async (page: Page): Promise<void> => {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  assert.ok(overflow <= 0, `the page scrolls sideways by ${overflow}px`)
}

const shot = async (page: Page, name: string): Promise<void> => {
  await noSideScroll(page)
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true })
}

const person = async (browser: Browser): Promise<Page> => {
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()
  if (process.env.E2E_DEBUG === '1') {
    page.on('console', message => console.log(`[console ${message.type()}] ${message.text()}`))
    page.on('pageerror', error => console.log(`[pageerror] ${error.message}`))
  }
  return page
}

const activate = async (page: Page, link: string, name: string): Promise<void> => {
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

const copiedLink = async (page: Page): Promise<string> => {
  const link = await page.getByRole('textbox', { name: 'Link' }).inputValue()
  assert.match(link, /\/link#[0-9a-f]{64}$/)
  await page.getByRole('button', { name: 'I have copied it' }).click()
  await page.getByRole('textbox', { name: 'Link' }).waitFor({ state: 'detached' })
  return link
}

const startWorkerd = (
  port: number,
  dataDir: string,
  env: Record<string, string>,
): ChildProcess =>
  spawn(
    'pnpm',
    [
      '--dir',
      join(root, 'apps/api'),
      'exec',
      'workerd',
      'serve',
      'workerd/case-desk.capnp',
      '--directory-path',
      `assets=${join(root, 'apps/web/dist')}`,
      '--directory-path',
      `data=${dataDir}`,
      '--socket-addr',
      `http=127.0.0.1:${port}`,
      '--experimental',
    ],
    { cwd: root, env: { ...process.env, ...env }, stdio: 'ignore', detached: true },
  )

// NOTE: Each server is its own process group (pnpm starts workerd as a child),
// so stopping the group ends exactly the processes this script started.
const stop = (child: ChildProcess | undefined): void => {
  if (child?.pid === undefined) {
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    // already gone
  }
}

// NOTE: Helpers for the image step (stage 4d). Everything is generated; no
// real photograph is ever used.
const jpegSize = (bytes: Buffer): { width: number; height: number } | undefined => {
  let at = 2
  while (at + 4 < bytes.length) {
    if (bytes[at] !== 0xff) {
      return undefined
    }
    const marker = bytes[at + 1] ?? 0
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) }
    }
    at += 2 + bytes.readUInt16BE(at + 2)
  }
  return undefined
}

// NOTE: An EXIF segment with an invented GPS-like text, put right after the
// start of a JPEG, to see that it does not survive the re-encoding.
const withExif = (jpeg: Buffer, marker: string): Buffer => {
  const payload = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from(marker)])
  const segment = Buffer.alloc(4)
  segment.writeUInt16BE(0xffe1, 0)
  segment.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([jpeg.subarray(0, 2), segment, payload, jpeg.subarray(2)])
}

const syntheticImage = (
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


const main = async (): Promise<void> => {
  mkdirSync(shots, { recursive: true })
  const local = mkdtempSync(join(tmpdir(), 'quoroom-e2e-'))
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  let server: ChildProcess | undefined
  let pilotServer: ChildProcess | undefined
  let pilotLink = ''
  let pilotUrl = ''
  let pilotPage: Page | undefined
  let browser: Browser | undefined

  try {
    const adminOutput = run('node', [
      'apps/api/scripts/grant-admin.ts',
      '--env',
      'workerd',
      '--email',
      'ada.admin@case-desk.test',
      '--name',
      'Ada Admin',
      '--origin',
      base,
      '--dir',
      local,
    ])
    const adminLink = adminOutput.split('\n').find(line => line.includes('/link#')) ?? ''
    assert.ok(adminLink !== '', 'grant-admin printed no link')
    assert.ok(!adminOutput.includes(PASSWORD))

    if (process.env.E2E_SKIP_BUILD !== '1') {
      run('pnpm', ['--filter', '@case-desk/web', 'build'])
    }
    run('node', ['apps/api/scripts/build-workerd.mjs'], {
      CASE_DESK_LOCAL_DIR: local,
    })
    mkdirSync(join(local, 'data'), { recursive: true })
    server = startWorkerd(port, join(local, 'data'), { RUNTIME_MODE: 'demo' })
    await waitForHealth(base)

    const launched = await chromium.launch({
      executablePath: chromePath,
      args: ['--no-sandbox'],
    })
    browser = launched

    await step('every response carries Referrer-Policy: no-referrer', async () => {
      for (const path of ['/', '/api/health', '/link']) {
        const response = await fetch(`${base}${path}`)
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer', path)
      }
    })

    const admin = await person(launched)
    await step('the administrator activates from the printed link', async () => {
      await activate(admin, adminLink, 'admin')
    })

    await step('a used link fails', async () => {
      const other = await person(launched)
      await other.goto(adminLink)
      await other.getByRole('heading', { name: 'This link does not work' }).waitFor()
      await shot(other, 'used-link')
      await other.context().close()
    })

    await step('an unknown link fails the same way', async () => {
      const other = await person(launched)
      await other.goto(`${base}/link#${'0'.repeat(64)}`)
      await other.getByRole('heading', { name: 'This link does not work' }).waitFor()
      await other.context().close()
    })

    await step('the administrator sees the administration and creates a unit', async () => {
      await admin.getByRole('link', { name: 'Administration' }).click()
      await admin.getByRole('heading', { name: 'Administration' }).waitFor()
      await admin.getByLabel('Unit name').fill('Synthetic Unit')
      await admin.getByLabel('Unit code').fill('SYN')
      await admin.getByRole('button', { name: 'Create unit' }).click()
      await admin.getByRole('list', { name: 'Units' }).getByText('Synthetic Unit').waitFor()
      await shot(admin, 'admin-1-unit-created')
    })

    const grant = async (email: string, name: string): Promise<string> => {
      await admin.getByLabel('E-mail', { exact: true }).fill(email)
      await admin.getByLabel('Name', { exact: true }).fill(name)
      await admin.getByRole('button', { name: 'Give capability' }).click()
      await admin.getByRole('textbox', { name: 'Link' }).waitFor()
      await shot(admin, `admin-grant-${name.split(' ')[0]?.toLowerCase()}`)
      return copiedLink(admin)
    }

    let anaLink = ''
    let benLink = ''
    await step('the administrator grants two authors in the unit and gets one link each', async () => {
      anaLink = await grant('ana.author@case-desk.test', 'Ana Author')
      benLink = await grant('ben.author@case-desk.test', 'Ben Author')
      await admin.getByText('Author in Synthetic Unit').first().waitFor()
    })

    await step('the accounts are listed and a reset link can be issued', async () => {
      await admin.getByRole('button', { name: 'Issue reset link for Ana Author' }).click()
      await admin.getByRole('textbox', { name: 'Link' }).waitFor()
      await shot(admin, 'admin-reset-link')
      await copiedLink(admin)
    })

    const ana = await person(launched)
    await step('the first author activates', async () => {
      await activate(ana, anaLink, 'ana')
    })

    const ben = await person(launched)
    await step('the second author activates', async () => {
      await activate(ben, benLink, 'ben')
    })

    await step('the author sees the unit, the other author, and nothing of administration', async () => {
      await assert.rejects(
        ana.getByRole('link', { name: 'Administration' }).waitFor({ timeout: 500 }),
      )
      await ana.getByRole('link', { name: 'My unit' }).click()
      await ana.getByRole('heading', { name: 'My unit' }).waitFor()
      await ana
        .getByRole('list', { name: 'Authors in this unit' })
        .getByText('Ben Author')
        .waitFor()
      await shot(ana, 'ana-1-unit')
    })

    let inviteeLink = ''
    await step('the author invites a person and gets a link to hand over', async () => {
      await ana.getByLabel('Name', { exact: true }).fill('Cleo Colleague')
      await ana.getByLabel('E-mail', { exact: true }).fill('cleo.colleague@case-desk.test')
      await ana.getByRole('button', { name: 'Invite', exact: true }).click()
      await ana.getByRole('textbox', { name: 'Link' }).waitFor()
      await shot(ana, 'ana-2-invited')
      inviteeLink = await copiedLink(ana)
    })

    await step('inviting an existing e-mail gives no link', async () => {
      await ana.getByLabel('Name', { exact: true }).fill('Ben Author')
      await ana.getByLabel('E-mail', { exact: true }).fill('ben.author@case-desk.test')
      await ana.getByRole('button', { name: 'Invite', exact: true }).click()
      await ana.getByText('already has an account').waitFor()
      assert.equal(await ana.getByRole('textbox', { name: 'Link' }).count(), 0)
      await shot(ana, 'ana-3-existing-email')
    })

    let reviewerLink = ''
    await step('the author registers a reviewer with a number and a consent request', async () => {
      await ana.getByLabel('Reviewer name').fill('Rae Viewer')
      await ana.getByLabel('Reviewer e-mail').fill('rae.viewer@case-desk.test')
      await ana.getByLabel('Reviewer phone number').fill('+34 600 000 000')
      await ana.getByLabel('Ask for WhatsApp consent').check()
      await ana.getByRole('button', { name: 'Register reviewer' }).click()
      await ana.getByRole('textbox', { name: 'Link' }).waitFor()
      reviewerLink = await copiedLink(ana)
      await ana
        .getByRole('list', { name: 'Reviewers' })
        .getByText('+34600000000 · WhatsApp consent requested')
        .waitFor()
      await shot(ana, 'ana-4-reviewer')
    })

    await step('the author groups reviewers into a committee', async () => {
      await ana.getByLabel('Committee name').fill('Synthetic Committee')
      await ana.getByRole('button', { name: 'Create committee' }).click()
      await ana.getByRole('heading', { name: 'Synthetic Committee' }).waitFor()
      const member = ana.getByLabel('Rae Viewer in Synthetic Committee')
      await ensureChecked(member, 'the member was not added')
      await shot(ana, 'ana-5-committee')
    })

    await step('the invited person activates', async () => {
      const cleo = await person(launched)
      await activate(cleo, inviteeLink, 'cleo')
    })

    const rae = await person(launched)
    await step('the reviewer activates', async () => {
      await activate(rae, reviewerLink, 'rae')
    })

    await step('only the reviewer gives WhatsApp consent, on their own account', async () => {
      await rae.getByRole('link', { name: 'My account' }).click()
      await rae.getByRole('heading', { name: 'Your account' }).waitFor()
      assert.equal(
        await rae
          .getByLabel('I agree to receive messages from Quoroom on WhatsApp at this number')
          .isChecked(),
        false,
      )
      await rae.getByLabel('Phone number').fill('+34 600 000 000')
      await rae
        .getByLabel('I agree to receive messages from Quoroom on WhatsApp at this number')
        .check()
      await rae.getByRole('button', { name: 'Save preferences' }).click()
      await rae.getByText('Saved.').waitFor()
      await shot(rae, 'rae-1-account')
    })

    await step('an author sets the approval notice (D19)', async () => {
      await ben.getByRole('link', { name: 'My account' }).click()
      await ben.getByRole('heading', { name: 'Your account' }).waitFor()
      await ben.getByLabel('Tell me about each single approval of my reports').check()
      await ben.getByRole('button', { name: 'Save preferences' }).click()
      await ben.getByText('Saved.').waitFor()
      await shot(ben, 'ben-1-notifications')
    })

    await step('signing out and in again returns to the desk', async () => {
      await rae.getByRole('button', { name: 'Sign out' }).click()
      await rae.getByRole('heading', { name: 'Sign in' }).waitFor()
      await rae.getByLabel('E-mail').fill('rae.viewer@case-desk.test')
      await rae.getByLabel('Password', { exact: true }).fill(PASSWORD)
      await rae.getByRole('button', { name: 'Sign in' }).click()
      await rae.getByRole('button', { name: 'Sign out' }).waitFor()
    })

    await step('too many wrong passwords are explained with a wait', async () => {
      const visitor = await person(launched)
      await visitor.goto(base)
      await visitor.getByRole('heading', { name: 'Sign in' }).waitFor()
      for (let attempt = 0; attempt < 7; attempt += 1) {
        await visitor.getByLabel('E-mail').fill('nobody@case-desk.test')
        await visitor.getByLabel('Password', { exact: true }).fill('wrong-password-1')
        const answered = visitor.waitForResponse(response =>
          response.url().includes('/api/q/public'),
        )
        await visitor.getByRole('button', { name: 'Sign in' }).click()
        await answered
        await visitor.getByRole('alert').waitFor()
      }
      await visitor.getByText('Too many attempts').waitFor()
      await shot(visitor, 'throttled')
    })

    await step('/api/config gives the demo mode and the neutral theme, briefly cached', async () => {
      const response = await fetch(`${base}/api/config`)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('cache-control') ?? '', /public, max-age=\d+/)
      const config = (await response.json()) as {
        mode: string
        theme: { organisationName: string; colors: { primary: string } }
      }
      assert.equal(config.mode, 'demo')
      assert.equal(config.theme.organisationName, 'Your organisation')
      assert.equal(config.theme.colors.primary, '#1f4e79')
    })

    await step('the theme from /api/config is applied: a colour and the organisation name', async () => {
      const themed = await person(launched)
      await themed.route('**/api/config', async route => {
        const response = await route.fetch()
        const config = (await response.json()) as Record<string, unknown>
        await route.fulfill({
          response,
          json: {
            ...config,
            theme: {
              ...(config.theme as Record<string, unknown>),
              organisationName: 'Synthetic Foundation',
              colors: {
                primary: '#0b5e3c',
                accent: '#7a2e0e',
                text: '#111111',
                background: '#ffffff',
              },
            },
          },
        })
      })
      await themed.goto(base)
      await themed.getByRole('heading', { name: 'Sign in' }).waitFor()
      await themed.getByText('Synthetic Foundation').first().waitFor()
      const primary = await themed
        .locator('#quoroom-root')
        .evaluate(element => element.style.getPropertyValue('--color-msf-red'))
      assert.equal(primary, '#0b5e3c')
      await shot(themed, 'theme-applied')
      await themed.context().close()
    })

    await step('a signed-out deep link asks for sign-in and returns to the exact link', async () => {
      const visitor = await person(launched)
      await visitor.goto(`${base}/r/syn-1/rev/2`)
      await visitor.getByRole('heading', { name: 'Sign in' }).waitFor()
      assert.equal(new URL(visitor.url()).pathname, '/r/syn-1/rev/2')
      await shot(visitor, 'deep-link-sign-in')
      await visitor.getByLabel('E-mail').fill('rae.viewer@case-desk.test')
      await visitor.getByLabel('Password', { exact: true }).fill(PASSWORD)
      await visitor.getByRole('button', { name: 'Sign in' }).click()
      await visitor.getByRole('heading', { name: 'Revision 2' }).waitFor()
      assert.equal(new URL(visitor.url()).pathname, '/r/syn-1/rev/2')
      await shot(visitor, 'deep-link-returned')
      await visitor.context().close()
    })

    // NOTE: a real pilot: a workerd bundle built with `--mode pilot` (no demo
    // cases, no demo accounts), started with RUNTIME_MODE=pilot, and a first
    // administrator from a generated grant file with an invented e-mail. The
    // demo server above has read its bundle already, so building over it is safe.
    await step('a pilot build: the server says so and the triage routes are gone', async () => {
      const pilotLocal = join(local, 'pilot-local')
      mkdirSync(pilotLocal, { recursive: true })
      const pilotPort = await freePort()
      const pilotBase = `http://127.0.0.1:${pilotPort}`
      const output = run('node', [
        'apps/api/scripts/grant-admin.ts',
        '--env',
        'workerd',
        '--email',
        'pia.pilot@case-desk.test',
        '--name',
        'Pia Pilot',
        '--origin',
        pilotBase,
        '--dir',
        pilotLocal,
      ])
      pilotLink = output.split('\n').find(line => line.includes('/link#')) ?? ''
      assert.ok(pilotLink !== '', 'grant-admin printed no link for the pilot')
      run('node', ['apps/api/scripts/build-workerd.mjs', '--mode', 'pilot'], {
        CASE_DESK_LOCAL_DIR: pilotLocal,
      })
      const pilotData = join(local, 'pilot-data')
      mkdirSync(pilotData, { recursive: true })
      pilotServer = startWorkerd(pilotPort, pilotData, {
        RUNTIME_MODE: 'pilot',
        TICK_SECRET: TICK_SECRET,
      })
      await waitForHealth(pilotBase)
      pilotUrl = pilotBase
      const config = (await (await fetch(`${pilotBase}/api/config`)).json()) as {
        mode: string
      }
      assert.equal(config.mode, 'pilot')
      for (const [path, method] of [
        ['/api/rpc', 'POST'],
        ['/api/login', 'POST'],
        ['/api/logout', 'POST'],
        ['/api/session', 'GET'],
      ] as const) {
        const answer = await fetch(`${pilotBase}${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          ...(method === 'POST' ? { body: '{}' } : {}),
        })
        assert.equal(answer.status, 404, path)
      }
    })

    await step('the pilot administrator activates and signs in; triage is absent', async () => {
      const pilot = await person(launched)
      pilotPage = pilot
      await activate(pilot, pilotLink, 'pilot-admin')
      await pilot.getByRole('link', { name: 'Home' }).waitFor()
      assert.equal(await pilot.getByRole('link', { name: 'New case' }).count(), 0)
      assert.equal(await pilot.getByRole('link', { name: 'Rules' }).count(), 0)
      await pilot.goto(`${pilotUrl}/new-case`)
      await pilot.getByText('This page is not available').waitFor()
      await shot(pilot, 'pilot-no-triage')
    })

    await step('the Quoroom screens work in the pilot', async () => {
      const pilot = pilotPage
      assert.ok(pilot !== undefined, 'no pilot page')
      await pilot.goto(`${pilotUrl}/admin`)
      await pilot.getByRole('heading', { name: 'Administration' }).waitFor()
      await pilot.getByLabel('Unit name').fill('Pilot Unit')
      await pilot.getByLabel('Unit code').fill('PIL')
      await pilot.getByRole('button', { name: 'Create unit' }).click()
      await pilot.getByRole('list', { name: 'Units' }).getByText('Pilot Unit').waitFor()
      await pilot.goto(`${pilotUrl}/account`)
      await pilot.getByRole('heading', { name: 'Your account' }).waitFor()
      await shot(pilot, 'pilot-quoroom')
    })

    // NOTE: Stage 4a and 4b, at 375 px: an author makes a case file and an
    // intake report, fills structured fields in two sections, ends the report
    // with a branch answer and restores it, reloads, and finds the values kept.
    await step('an author writes an intake report on a phone and the values persist', async () => {
      const pilot = pilotPage
      assert.ok(pilot !== undefined, 'no pilot page')
      await pilot.goto(`${pilotUrl}/admin`)
      await pilot.getByRole('heading', { name: 'Administration' }).waitFor()
      await pilot.getByLabel('E-mail', { exact: true }).fill('pia.pilot@case-desk.test')
      await pilot.getByLabel('Name', { exact: true }).fill('Pia Pilot')
      await pilot.getByLabel('Capability', { exact: true }).selectOption('author')
      await pilot.getByLabel('Unit', { exact: true }).selectOption({ label: 'Pilot Unit (PIL)' })
      await pilot.getByRole('button', { name: 'Give capability' }).click()
      await pilot.getByText('Author in Pilot Unit').first().waitFor()

      await pilot.goto(`${pilotUrl}/reports`)
      await pilot.getByRole('heading', { name: 'Start a report' }).waitFor()
      await pilot
        .getByLabel('Template', { exact: true })
        .selectOption({ label: 'Intake and initial assessment (version 1)' })
      await pilot.getByLabel('Integrity Line reference', { exact: true }).fill('PIL-0001')
      await pilot.getByLabel('Case file title', { exact: true }).fill('Synthetic pilot case file')
      await shot(pilot, 'reports-1-start')
      await pilot.getByRole('button', { name: 'Create report' }).click()
      await pilot.getByRole('link', { name: 'Open report PIL-0001' }).waitFor()
      await shot(pilot, 'reports-2-created')
      await pilot.getByRole('link', { name: 'Open report PIL-0001' }).click()
      await pilot.getByRole('heading', { name: 'Intake and initial assessment', level: 1 }).waitFor()

      const openSection = async (name: RegExp): Promise<void> => {
        const row = pilot.getByRole('button', { name })
        if (!(await row.first().isVisible())) {
          await pilot.getByRole('button', { name: /^Sections/ }).click()
        }
        await row.first().click()
      }
      const saved = async (): Promise<void> => {
        await pilot.getByText(/Saved at \d\d:\d\d/).waitFor()
      }

      await pilot.getByLabel('Investigator', { exact: true }).fill('Synthetic Investigator')
      await pilot.getByLabel('Date the project received the case', { exact: true }).fill('2026-03-04')
      await saved()
      await shot(pilot, 'report-1-case-details')

      await openSection(/Jurisdiction, /)
      await pilot.getByRole('radio', { name: 'No' }).check()
      await pilot.getByText('The report ends here').first().waitFor()
      await saved()
      await shot(pilot, 'report-2-ended')
      await pilot.getByRole('radio', { name: 'Yes' }).check()
      await pilot.getByText('The report ends here').first().waitFor({ state: 'detached' })
      await saved()
      await shot(pilot, 'report-3-restored')

      await pilot.reload()
      await pilot.getByRole('heading', { name: 'Intake and initial assessment', level: 1 }).waitFor()
      assert.equal(await pilot.getByLabel('Investigator', { exact: true }).inputValue(), 'Synthetic Investigator')
      assert.equal(
        await pilot.getByLabel('Date the project received the case', { exact: true }).inputValue(),
        '2026-03-04',
      )
      await openSection(/Jurisdiction, /)
      assert.ok(await pilot.getByRole('radio', { name: 'Yes' }).isChecked(), 'the answer was not kept')
      assert.equal(await pilot.getByText('The report ends here').count(), 0)
      await shot(pilot, 'report-4-reloaded')
    })

    // NOTE: Stage 4c, at 375 px: the rich-text editor. The editor chunk is not
    // requested until a section with a rich-text item is shown; the author
    // types, makes text bold, a list, a link (an unsafe address is refused), a
    // table with an added row and a resized column, undoes, and after a reload
    // the stored content is the same string.
    let intakePath = ''
    await step('rich text on a phone: format, list, link, table, resize, undo, reload', async () => {
      const first = pilotPage
      assert.ok(first !== undefined, 'no pilot page')
      const reportPath = new URL(first.url()).pathname
      intakePath = reportPath
      const page = first
      const requested: Array<string> = []
      page.on('request', request => requested.push(request.url()))
      const isEditorChunk = (url: string): boolean => /\/assets\/element-[^/]+\.js$/.test(url)
      await page.goto(`${pilotUrl}${reportPath}`)
      await page.getByRole('heading', { name: 'Intake and initial assessment', level: 1 }).waitFor()
      assert.equal(requested.filter(isEditorChunk).length, 0, 'the editor chunk was requested early')
      assert.equal(await page.locator('quoroom-editor').count(), 0)

      const openSection = async (name: RegExp): Promise<void> => {
        const row = page.getByRole('button', { name })
        if (!(await row.first().isVisible())) {
          await page.getByRole('button', { name: /^Sections/ }).click()
        }
        await row.first().click()
      }
      const openSummary = async (): Promise<void> => {
        await openSection(/Summary of the complaint/)
        await page.getByRole('textbox', { name: 'Summary' }).waitFor()
      }
      await openSummary()
      assert.equal(requested.filter(isEditorChunk).length, 1, 'the editor chunk was not requested once')

      const editor = page.getByRole('textbox', { name: 'Summary' })
      const tool = (name: string) => page.getByRole('button', { name, exact: true })
      const settle = async (): Promise<void> => {
        await page.waitForTimeout(700)
        await page.getByText(/Saved at \d\d:\d\d/).waitFor()
      }
      const storedContent = (): Promise<string> =>
        page.locator('quoroom-editor').evaluate(element => (element as unknown as { content: string }).content)

      await editor.click()
      await page.keyboard.type('Plain ')
      await tool('Bold').click()
      await page.keyboard.type('strong')
      await tool('Bold').click()
      await page.keyboard.type(' end')
      await page.keyboard.press('Enter')

      await tool('Bulleted list').click()
      await page.keyboard.type('one')
      await page.keyboard.press('Enter')
      await page.keyboard.type('two')
      await page.keyboard.press('Enter')
      await page.keyboard.press('Enter')
      await page.keyboard.type('Visit site')
      await page.locator('quoroom-editor').evaluate(element => {
        const seen: Array<unknown> = []
        Object.assign(element, { seen })
        element.addEventListener('selection', event => {
          if (event instanceof CustomEvent) {
            seen.push(event.detail)
          }
        })
      })
      await page.keyboard.press('Shift+ArrowLeft')
      await page.keyboard.press('Shift+ArrowLeft')
      await page.keyboard.press('Shift+ArrowLeft')
      await page.keyboard.press('Shift+ArrowLeft')

      await page.waitForTimeout(400)
      await tool('Link').click()
      await page.getByLabel('Link address').fill('javascript:alert(1)')
      await page.getByRole('button', { name: 'Apply link' }).click()
      await page.getByText('Use an address that starts with https://').waitFor()
      await page.getByLabel('Link address').fill('example.org')
      await page.getByRole('button', { name: 'Apply link' }).click()
      await page.getByRole('link', { name: 'site' }).waitFor()
      assert.equal(
        await page.getByRole('link', { name: 'site' }).getAttribute('href'),
        'https://example.org',
      )
      await page.waitForFunction(() => document.activeElement?.classList.contains('quoroom-prose'))
      await page.waitForTimeout(400)
      await page.locator('quoroom-editor p', { hasText: 'Visit' }).click({ position: { x: 300, y: 8 } })
      await page.waitForTimeout(400)
      await page.keyboard.press('Enter')

      await tool('Insert table').click()
      await page.keyboard.type('H1')
      await page.keyboard.press('Tab')
      await page.keyboard.type('H2')
      await page.keyboard.press('Tab')
      await page.keyboard.type('H3')
      await page.keyboard.press('Tab')
      await page.keyboard.type('cell')
      assert.equal(await page.locator('quoroom-editor table tr').count(), 3)
      await page.waitForTimeout(600)
      await tool('Add row below').click()
      assert.equal(await page.locator('quoroom-editor table tr').count(), 4)
      await shot(page, 'richtext-1-table')
      await page.waitForTimeout(600)

      const firstHeader = page.locator('quoroom-editor th').first()
      const before = await firstHeader.boundingBox()
      assert.ok(before !== null, 'no header cell')
      await page.mouse.move(before.x + before.width - 1, before.y + before.height / 2)
      await page.mouse.down()
      await page.mouse.move(before.x + before.width + 59, before.y + before.height / 2, { steps: 8 })
      await page.mouse.up()
      const after = await firstHeader.boundingBox()
      assert.ok(after !== null && after.width > before.width + 20, 'the column did not widen')
      await noSideScroll(page)
      await page.waitForTimeout(600)

      await page.locator('quoroom-editor p', { hasText: 'Plain' }).first().click()
      await settle()
      const withTable = await storedContent()
      const resized = JSON.parse(withTable)
      const table = resized.doc?.content?.find((block: { type: string }) => block.type === 'table') ?? resized.content?.find((block: { type: string }) => block.type === 'table')
      assert.ok(table !== undefined, 'no table in the stored content')
      assert.ok(Array.isArray(table.content[0].content[0].attrs?.colwidth), 'the column width was not stored')
      await shot(page, 'richtext-2-resized')

      await tool('Undo').click()
      const undone = await firstHeader.boundingBox()
      assert.ok(undone !== null && undone.width < after.width - 10, `undo did not undo the resize: ${before.width} ${after.width} ${undone?.width}`)
      assert.equal(await page.locator('quoroom-editor table tr').count(), 4)
      await page.waitForTimeout(600)
      await tool('Undo').click()
      assert.equal(await page.locator('quoroom-editor table tr').count(), 3, 'undo did not remove the added row')
      await tool('Redo').click()
      assert.equal(await page.locator('quoroom-editor table tr').count(), 4)

      const selected = await page.locator('quoroom-editor').evaluate(element => {
        const seen = (element as unknown as { seen: Array<{ text: string }> }).seen
        return seen.map(detail => detail.text)
      })
      assert.ok(selected.includes('site'), `the selection was not reported: ${JSON.stringify(selected)}`)

      await page.locator('quoroom-editor p', { hasText: 'Plain' }).first().click()
      await settle()
      const stored = await storedContent()
      assert.ok(!stored.includes('"target"') && !stored.includes('"rel"') && !stored.includes('"align"'), 'editor defaults leaked into the content')
      assert.ok(stored.includes('"href":"https://example.org"'), `the link was not stored: ${stored.slice(0, 600)}`)
      await shot(page, 'richtext-3-final')

      await page.reload()
      await page.getByRole('heading', { name: 'Intake and initial assessment', level: 1 }).waitFor()
      await openSummary()
      await page.getByText('strong').first().waitFor()
      assert.equal(await page.locator('quoroom-editor table tr').count(), 4)
      assert.equal(await storedContent(), stored, 'the content changed across a reload')
      assert.equal(await page.locator('quoroom-editor strong').first().innerText(), 'strong')
      await shot(page, 'richtext-4-reloaded')

      const chunkUrl = requested.find(isEditorChunk) ?? (await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name).find(name => /\/assets\/element-[^/]+\.js$/.test(name)))) ?? ''
      assert.ok(chunkUrl !== '', 'no editor chunk url')
      const bytes = Buffer.from(await (await fetch(chunkUrl)).arrayBuffer())
      const gzip = gzipSync(bytes, { level: 9 }).length
      const brotli = brotliCompressSync(bytes).length
      console.log(`     editor chunk: ${bytes.length} bytes, ${gzip} gzip, ${brotli} brotli`)
      assert.ok(gzip < 250 * 1024, `the editor chunk is ${gzip} bytes gzip`)
    })

    // NOTE: Stage 4d, at 375 px: images. A large synthetic JPEG with an EXIF
    // segment is chosen (4000 x 3000) and is stored at 1600 x 1200, under 1 MB,
    // with no EXIF; a transparent PNG stays a PNG with alpha; one is marked safe
    // to share, with alt text and a caption; after a reload both are shown and
    // the flags are kept; an image that is still over 1 MB after re-encoding is
    // refused with a message; a full database is explained and not retried; a
    // chunk that fails once is sent again; a column is widened and narrowed with
    // the toolbar.
    await step('images on a phone: resize, strip, transparency, safe flag, limits, retry, column buttons', async () => {
      const page = pilotPage
      assert.ok(page !== undefined, 'no pilot page')
      const reportPath = new URL(page.url()).pathname
      const reportId = reportPath.split('/').pop() ?? ''
      await page.goto(`${pilotUrl}${reportPath}`)
      await page.getByRole('heading', { name: 'Intake and initial assessment', level: 1 }).waitFor()
      const openSummary = async (): Promise<void> => {
        const row = page.getByRole('button', { name: /Summary of the complaint/ })
        if (!(await row.first().isVisible())) {
          await page.getByRole('button', { name: /^Sections/ }).click()
        }
        await row.first().click()
        await page.getByRole('textbox', { name: 'Summary' }).waitFor()
      }
      await openSummary()
      const tool = (name: string) => page.getByRole('button', { name, exact: true })
      const figures = page.locator('quoroom-editor figure')
      const settle = async (): Promise<void> => {
        await page.waitForTimeout(700)
        await page.getByText(/Saved at \d\d:\d\d/).waitFor()
      }
      type StoredChunk = { chunks: number; mime: string; width: number; height: number; base64: string }
      const storedChunk = async (imageId: string, index: number): Promise<StoredChunk> => {
        const response = await page
          .context()
          .request.get(`${pilotUrl}/api/images/${imageId}/${index}?context=working_copy&report=${reportId}`)
        assert.equal(response.status(), 200, `chunk ${index} of ${imageId}`)
        return (await response.json()) as StoredChunk
      }
      const storedChunks = async (imageId: string): Promise<{ bytes: Buffer; mime: string; width: number; height: number }> => {
        const first = await storedChunk(imageId, 0)
        const rest: Array<StoredChunk> = []
        for (let index = 1; index < first.chunks; index += 1) {
          rest.push(await storedChunk(imageId, index))
        }
        return {
          bytes: Buffer.concat([first, ...rest].map(chunk => Buffer.from(chunk.base64, 'base64'))),
          mime: first.mime,
          width: first.width,
          height: first.height,
        }
      }
      const addFile = async (file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> => {
        const [chooser] = await Promise.all([page.waitForEvent('filechooser'), tool('Insert image').click()])
        await chooser.setFiles(file)
      }

      await page.getByRole('textbox', { name: 'Summary' }).click()
      await page.keyboard.press('Control+End')

      // The large photo, with an EXIF segment.
      const exifMarker = 'SYNTHETIC-GPS-52.5200N-13.4050E'
      const photo = withExif(
        Buffer.from(await syntheticImage(page, { width: 4000, height: 3000, kind: 'photo', quality: 0.92 }), 'base64'),
        exifMarker,
      )
      assert.ok(photo.includes(exifMarker), 'the test photo has no EXIF')
      await addFile({ name: 'synthetic-photo.jpg', mimeType: 'image/jpeg', buffer: photo })
      await page.getByText('Picture added.').waitFor()
      await figures.first().locator('quoroom-image img').waitFor()
      const photoId = (await figures.first().getAttribute('data-image-id')) ?? ''
      assert.ok(photoId !== '')
      const storedPhoto = await storedChunks(photoId)
      assert.equal(storedPhoto.mime, 'image/jpeg')
      assert.deepEqual(jpegSize(storedPhoto.bytes), { width: 1600, height: 1200 }, 'the photo was not resized to 1600 x 1200')
      assert.ok(storedPhoto.bytes.length <= 1_000_000, `the stored photo is ${storedPhoto.bytes.length} bytes`)
      assert.ok(!storedPhoto.bytes.includes('Exif'), 'EXIF survived')
      assert.ok(!storedPhoto.bytes.includes(exifMarker), 'the GPS text survived')
      assert.equal(storedPhoto.width, 1600)
      assert.equal(storedPhoto.height, 1200)
      console.log(`     photo: ${photo.length} bytes in, ${storedPhoto.bytes.length} bytes stored`)
      await shot(page, 'images-1-photo')

      // The transparent PNG.
      await addFile({
        name: 'synthetic-logo.png',
        mimeType: 'image/png',
        buffer: Buffer.from(await syntheticImage(page, { width: 600, height: 400, kind: 'transparent', quality: 1 }), 'base64'),
      })
      await page.getByText('Picture added.').waitFor()
      await page.waitForFunction(() => document.querySelectorAll('quoroom-editor figure').length === 2)
      await page.waitForFunction(() => document.querySelectorAll('quoroom-editor figure quoroom-image img').length === 2)
      const pngId = (await figures.nth(1).getAttribute('data-image-id')) ?? ''
      assert.ok(pngId !== '' && pngId !== photoId)
      const storedPng = await storedChunks(pngId)
      assert.equal(storedPng.mime, 'image/png')
      assert.deepEqual([...storedPng.bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      assert.ok([4, 6].includes(storedPng.bytes[25] ?? 0), `the PNG has no alpha channel (colour type ${storedPng.bytes[25]})`)
      assert.equal(storedPng.bytes.readUInt32BE(16), 600, 'the PNG was resized although small')
      assert.equal(storedPng.bytes.readUInt32BE(20), 400)
      const corner = await figures.nth(1).locator('quoroom-image img').evaluate(async element => {
        if (!(element instanceof HTMLImageElement)) {
          return -1
        }
        const bitmap = await createImageBitmap(element)
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const context = canvas.getContext('2d')
        context?.drawImage(bitmap, 0, 0)
        return context?.getImageData(2, 2, 1, 1).data[3] ?? -1
      })
      assert.equal(corner, 0, 'the transparent corner is not transparent')

      // Alt text, caption, and marking the PNG safe to share.
      assert.equal(await figures.first().getByRole('button', { name: 'Safe to share' }).getAttribute('aria-pressed'), 'false')
      await figures.first().getByLabel('Description of the image (alt text)').fill('A synthetic gradient')
      await page.keyboard.press('Tab')
      await figures.first().locator('figcaption').click()
      await page.keyboard.type('Caption of the photo')
      await figures.nth(1).getByRole('button', { name: 'Safe to share' }).click()
      assert.equal(await figures.nth(1).getByRole('button', { name: 'Safe to share' }).getAttribute('aria-pressed'), 'true')
      await figures.nth(1).getByText('Marked safe to share.').waitFor()
      await figures.first().getByText('Not marked safe to share. Withheld from redacted views.').waitFor()
      await page.getByText(/Images in this report: .* of 20\.0 MB used/).waitFor()
      await noSideScroll(page)
      await shot(page, 'images-2-both')
      await settle()

      // After a reload both are shown, and the flags, the alt text and the caption are kept.
      await page.reload()
      await page.getByRole('heading', { name: 'Intake and initial assessment', level: 1 }).waitFor()
      await openSummary()
      await page.waitForFunction(() => document.querySelectorAll('quoroom-editor figure quoroom-image img').length === 2)
      const widths = await page
        .locator('quoroom-editor figure quoroom-image img')
        .evaluateAll(images => images.map(image => (image instanceof HTMLImageElement ? image.naturalWidth : 0)))
      assert.deepEqual(widths, [1600, 600])
      assert.equal(await figures.first().getByRole('button', { name: 'Safe to share' }).getAttribute('aria-pressed'), 'false')
      assert.equal(await figures.nth(1).getByRole('button', { name: 'Safe to share' }).getAttribute('aria-pressed'), 'true')
      assert.equal(await figures.first().getByLabel('Description of the image (alt text)').inputValue(), 'A synthetic gradient')
      assert.equal(await figures.first().locator('figcaption').innerText(), 'Caption of the photo')
      assert.equal(await figures.first().locator('quoroom-image img').getAttribute('alt'), 'A synthetic gradient')
      await shot(page, 'images-3-reloaded')

      // An image that is still over 1 MB after re-encoding is refused.
      await page.getByRole('textbox', { name: 'Summary' }).click()
      await page.keyboard.press('Control+End')
      await addFile({
        name: 'synthetic-noise.png',
        mimeType: 'image/png',
        buffer: Buffer.from(await syntheticImage(page, { width: 1600, height: 1200, kind: 'noise', quality: 0.9 }), 'base64'),
      })
      const refusal = page.locator('quoroom-editor .quoroom-image-alert')
      await refusal.getByText(/still .* MB after it was made smaller, and the limit is 1\.0 MB/).waitFor()
      assert.equal(await figures.count(), 2, 'a refused image was inserted')
      await shot(page, 'images-4-refused')

      // A full database is explained and not retried.
      const small = Buffer.from(await syntheticImage(page, { width: 300, height: 200, kind: 'photo', quality: 0.8 }), 'base64')
      const posts: Array<string> = []
      await page.route('**/api/images?*', route => {
        posts.push(route.request().method())
        return route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ code: 'database_full', message: 'database full' }) })
      })
      await addFile({ name: 'synthetic-small.jpg', mimeType: 'image/jpeg', buffer: small })
      await refusal.getByText(/storage of this environment is full/).waitFor()
      assert.equal(posts.length, 1, 'a full database was retried')
      assert.equal(await page.getByRole('button', { name: 'Send the picture again' }).isVisible(), false)
      assert.equal(await figures.count(), 2)
      await page.unroute('**/api/images?*')

      // A chunk that fails once is sent again by itself.
      let failures = 0
      await page.route('**/api/images?*', route => {
        if (failures === 0) {
          failures += 1
          return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'unknown', message: 'unavailable' }) })
        }
        return route.continue()
      })
      await addFile({ name: 'synthetic-small.jpg', mimeType: 'image/jpeg', buffer: small })
      await page.getByText('Picture added.').waitFor()
      await page.waitForFunction(() => document.querySelectorAll('quoroom-editor figure').length === 3)
      assert.equal(failures, 1)
      await page.unroute('**/api/images?*')
      await settle()

      // Widen and narrow a column with the toolbar (no mouse drag).
      const header = page.locator('quoroom-editor th').first()
      await header.scrollIntoViewIfNeeded()
      await header.click()
      const before = await header.boundingBox()
      assert.ok(before !== null, 'no header cell')
      await tool('Make column wider').click()
      const wider = await header.boundingBox()
      assert.ok(wider !== null && wider.width >= before.width + 30, `the column did not widen: ${before.width} -> ${wider?.width}`)
      await tool('Make column wider').click()
      const widest = await header.boundingBox()
      assert.ok(widest !== null && widest.width >= wider.width + 30, 'a second step did not widen it again')
      await tool('Make column narrower').click()
      await tool('Make column narrower').click()
      const back = await header.boundingBox()
      assert.ok(back !== null && Math.abs(back.width - wider.width + 40) < 6 && back.width <= before.width + 6, `narrowing did not undo widening: ${before.width} ${widest.width} ${back?.width}`)
      await noSideScroll(page)
      await settle()
      await shot(page, 'images-5-column-buttons')
      const storedText = await page.locator('quoroom-editor').evaluate(element => (element as unknown as { content: string }).content)
      assert.ok(storedText.includes('colwidth'), 'the column width was not stored')

      await page.reload()
      await page.getByRole('heading', { name: 'Intake and initial assessment', level: 1 }).waitFor()
      await openSummary()
      await page.waitForFunction(() => document.querySelectorAll('quoroom-editor figure quoroom-image img').length === 3)
      await noSideScroll(page)
    })

    // NOTE: Stages 4e and 4f, at 375 px. Entries, *not applicable*, the save
    // states, two tabs of one author, and a fixture that fills every item of
    // both built-in templates (entered through the API in bulk, read back and
    // compared with the expected JSON). The invented panel template cannot be
    // reached from here (the build holds the built-in templates only); it is
    // covered by the API tests with the same fixture generator.
    type Json = Record<string, any>
    let reportCalls = 0
    const rpc = async (page: Page, tag: string, payload: Json): Promise<any> => {
      reportCalls += 1
      const response = await page.context().request.post(`${pilotUrl}/api/q/rpc`, {
        headers: { 'content-type': 'application/json' },
        data: JSON.stringify({ _tag: 'Request', id: String(reportCalls), tag, payload, headers: [] }),
      })
      assert.equal(response.status(), 200, `${tag}: HTTP ${response.status()}`)
      const parsed: unknown = JSON.parse(await response.text())
      const messages: Array<Json> = Array.isArray(parsed) ? parsed : [parsed as Json]
      const exit = messages.find(message => message._tag === 'Exit')
      assert.ok(exit !== undefined, `${tag}: no answer in ${JSON.stringify(messages).slice(0, 300)}`)
      if (exit.exit._tag !== 'Success') {
        throw new Error(`${tag} failed: ${JSON.stringify(exit.exit).slice(0, 400)}`)
      }
      return exit.exit.value
    }
    const fixture = (name: string): Json =>
      JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures', `${name}.content.json`), 'utf8'))
    const reportIdOf = (page: Page): string => new URL(page.url()).pathname.split('/').pop() ?? ''
    // NOTE: the report of a reference, for the steps that come back to it.
    const reportsByReference: Record<string, string> = {}
    const openIn = async (page: Page, name: RegExp): Promise<void> => {
      const row = page.getByRole('button', { name })
      if (!(await row.first().isVisible())) {
        await page.getByRole('button', { name: /^Sections/ }).click()
      }
      await row.first().click()
    }
    const settled = async (page: Page): Promise<void> => {
      await page.waitForTimeout(400)
      await page.getByText(/Saved at \d\d:\d\d/).waitFor()
    }
    const storedSection = async (page: Page, sectionId: string): Promise<Json> =>
      (await rpc(page, 'GetWorkingCopySection', { reportId: reportIdOf(page), sectionId })).content
    // NOTE: Entry IDs are made by the browser, so they are replaced by their
    // place before a UI-built content is compared.
    const withoutEntryIds = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(withoutEntryIds)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value).map(([key, inner]) => [key, key === 'id' ? 'ID' : withoutEntryIds(inner)]),
            )
          : value
    const instructionsOf = (template: Json): Array<string> => {
      const out: Array<string> = []
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
          node.forEach(walk)
        } else if (node !== null && typeof node === 'object') {
          for (const [key, inner] of Object.entries(node)) {
            if (key === 'instruction' && typeof inner === 'string') {
              out.push(inner)
            } else {
              walk(inner)
            }
          }
        }
      }
      walk(template)
      return out
    }
    const reportPathOfIntake = new URL(pilotPage?.url() ?? pilotUrl).pathname
    let investigationPath = ''

    await step('repeatable subsections on a phone: add, title, reorder, remove after a confirmation, numbering', async () => {
      const page = pilotPage
      assert.ok(page !== undefined, 'no pilot page')
      await page.goto(`${pilotUrl}/reports`)
      await page.getByRole('heading', { name: 'Start a report' }).waitFor()
      await page
        .getByLabel('Template', { exact: true })
        .selectOption({ label: 'Investigation report (version 1)' })
      await page.getByLabel('Integrity Line reference', { exact: true }).fill('PIL-0002')
      await page.getByLabel('Case file title', { exact: true }).fill('Synthetic investigation file')
      await page.getByRole('button', { name: 'Create report' }).click()
      await page.getByRole('link', { name: 'Open report PIL-0002' }).click()
      await page.getByRole('heading', { name: 'Investigation report', level: 1 }).waitFor()
      investigationPath = new URL(page.url()).pathname
      await page.getByText(/Saved at \d\d:\d\d/).waitFor()

      await openIn(page, /Background, /)
      await page.getByText('0 background topic entries.').waitFor()
      await page.getByRole('button', { name: 'Add background topic' }).click()
      await page.getByRole('textbox', { name: /Title of this background topic/ }).fill('Security context')
      await settled(page)
      await openIn(page, /Background, /)
      await page.getByRole('button', { name: 'Add background topic' }).click()
      await page.getByRole('textbox', { name: /Title of this background topic/ }).fill('Staffing history')
      await settled(page)
      await openIn(page, /Background, /)
      await page.getByText('2 background topic entries.').waitFor()
      await shot(page, 'entries-1-two-topics')

      // The order, then the move buttons.
      const titles = async (): Promise<Array<string>> => {
        const content = await storedSection(page, 'background')
        return content.sections['background-topic'].entries.map((entry: Json) => entry.title)
      }
      assert.deepEqual(await titles(), ['Security context', 'Staffing history'])
      await page.getByRole('button', { name: 'Move Staffing history up' }).click()
      await settled(page)
      assert.deepEqual(await titles(), ['Staffing history', 'Security context'])

      // A removal asks first, and cancelling removes nothing.
      await page.getByRole('button', { name: 'Remove Security context' }).click()
      await page.getByRole('heading', { name: 'Remove Security context?' }).waitFor()
      await shot(page, 'entries-2-confirm')
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await page.getByRole('heading', { name: 'Remove Security context?' }).waitFor({ state: 'detached' })
      assert.deepEqual(await titles(), ['Staffing history', 'Security context'])
      await page.getByRole('button', { name: 'Remove Security context' }).click()
      await page.getByRole('button', { name: 'Remove', exact: true }).click()
      await settled(page)
      assert.deepEqual(await titles(), ['Staffing history'])
      await page.getByText('1 background topic entry.').waitFor().catch(() => undefined)
      await noSideScroll(page)

      // An entry opens as a section of its own, with the title the author chose.
      await page.getByRole('navigation', { name: 'Subsections' }).getByRole('button', { name: /Staffing history, / }).click()
      await page.getByRole('heading', { name: /Staffing history/, level: 2 }).waitFor()
      await shot(page, 'entries-3-entry')

      // The nested subsections of an allegation, and the numbering.
      await openIn(page, /Facts and findings, /)
      await page.getByText(/^0 allegation entries\. Add 1 more/).waitFor()
      await page.getByRole('button', { name: 'Add allegation' }).click()
      await settled(page)
      await openIn(page, /Facts and findings, /)
      await page.getByRole('button', { name: 'Add allegation' }).click()
      await settled(page)
      await page.getByRole('button', { name: 'Remove Allegation 2' }).click()
      await page.getByRole('button', { name: 'Remove', exact: true }).click()
      await settled(page)
      await page.getByRole('navigation', { name: 'Subsections' }).getByRole('button', { name: /Allegation 1, / }).click()
      await page.getByRole('button', { name: 'Add key element' }).click()
      await settled(page)
      await shot(page, 'entries-4-nested')
      const facts = await storedSection(page, 'facts-findings')
      const blocks = facts.sections['allegation-block'].entries
      assert.equal(blocks.length, 1)
      assert.equal(blocks[0].sections['key-element'].entries.length, 1)
    })

    await step('not applicable on a phone: a reason is required, what was written is kept, and it can be undone', async () => {
      const page = pilotPage
      assert.ok(page !== undefined, 'no pilot page')
      await openIn(page, /Recommendation, /)
      await page.getByRole('navigation', { name: 'Subsections' }).getByRole('button', { name: /For individuals, / }).click()
      await page.getByRole('heading', { name: /For individuals/, level: 2 }).waitFor()
      await page.getByRole('button', { name: 'Mark For individuals as not applicable' }).click()
      await page.getByRole('button', { name: 'Mark as not applicable' }).click()
      await page.getByText('Write a reason before marking this as not applicable.').waitFor()
      await shot(page, 'na-1-reason-required')
      await page.getByRole('textbox', { name: 'Why is this not applicable?' }).fill('No individual is recommended.')
      await page.getByRole('button', { name: 'Mark as not applicable' }).click()
      await page.getByText('No individual is recommended.').waitFor()
      await settled(page)
      await shot(page, 'na-2-marked')
      const recommendation = (await storedSection(page, 'recommendation')).sections['recommend-individuals']
      assert.equal(recommendation.notApplicable.reason, 'No individual is recommended.')

      await page.reload()
      await page.getByRole('heading', { name: 'Investigation report', level: 1 }).waitFor()
      await openIn(page, /Recommendation, /)
      await page.getByRole('navigation', { name: 'Subsections' }).getByRole('button', { name: /For individuals, / }).click()
      await page.getByText('No individual is recommended.').waitFor()
      await page.getByRole('button', { name: 'Mark For individuals as applicable again' }).click()
      await settled(page)
      await page.getByText('No individual is recommended.').waitFor({ state: 'detached' })
      const restored = (await storedSection(page, 'recommendation')).sections?.['recommend-individuals']
      assert.equal(restored?.notApplicable, undefined, 'the mark was not cleared')
      await noSideScroll(page)
    })

    await step('the save state is shown: saved at a time with a counter, offline, and a warning before leaving', async () => {
      const page = pilotPage
      assert.ok(page !== undefined, 'no pilot page')
      await openIn(page, /Background, /)
      await page.getByRole('navigation', { name: 'Subsections' }).getByRole('button', { name: /Staffing history, / }).click()
      await page.getByText(/^Save \d+$/).waitFor()
      const counter = async (): Promise<number> =>
        Number(((await page.getByText(/^Save \d+$/).textContent()) ?? '').replace('Save ', ''))
      const before = await counter()
      const titleBox = page.getByRole('textbox', { name: /Title of this background topic/ })
      await titleBox.fill('Staffing history, revised')
      await settled(page)
      assert.ok((await counter()) > before, 'the save counter did not move')

      // Offline: the edit waits, the state says so, and it is sent when the network returns.
      await page.context().setOffline(true)
      await page.getByText('Offline', { exact: true }).waitFor()
      await titleBox.fill('Staffing history, edited offline')
      await page.getByText('Offline', { exact: true }).waitFor()
      await shot(page, 'save-1-offline')
      // A page with unsaved edits asks before it is closed.
      let dialogType = ''
      page.once('dialog', dialog => {
        dialogType = dialog.type()
        void dialog.dismiss()
      })
      await page.close({ runBeforeUnload: true })
      await page.waitForTimeout(300)
      assert.equal(dialogType, 'beforeunload', 'leaving with unsaved edits did not ask')
      assert.equal(page.isClosed(), false, 'the page closed although the author stayed')
      // Leaving by a link of the app asks as well (stage 4 review), and staying keeps the edit.
      await page.getByRole('link', { name: 'Home' }).click()
      await page.getByRole('heading', { name: 'This report has changes that are not saved' }).waitFor()
      await shot(page, 'save-2-leave-asked')
      await page.getByRole('button', { name: 'Stay on this report' }).click()
      await page.getByRole('heading', { name: 'This report has changes that are not saved' }).waitFor({ state: 'detached' })
      assert.equal(
        await titleBox.inputValue(),
        'Staffing history, edited offline',
        'staying on the report lost the edit',
      )
      await page.context().setOffline(false)
      await page.getByText(/Saved at \d\d:\d\d/).waitFor({ timeout: 20_000 })
      await page.waitForTimeout(300)
      const content = await storedSection(page, 'background')
      assert.equal(content.sections['background-topic'].entries[0].title, 'Staffing history, edited offline')
      // Once saved, leaving asks nothing.
      let asked = false
      page.once('dialog', dialog => {
        asked = true
        void dialog.dismiss()
      })
      await page.reload()
      await page.getByRole('heading', { name: 'Investigation report', level: 1 }).waitFor()
      assert.equal(asked, false, 'a saved page asked before leaving')
    })

    await step('two tabs of one author: the second save is refused, nothing is overwritten, the edit is kept', async () => {
      const first = pilotPage
      assert.ok(first !== undefined, 'no pilot page')
      const second = await first.context().newPage()
      await second.goto(`${pilotUrl}${investigationPath}`)
      await second.getByRole('heading', { name: 'Investigation report', level: 1 }).waitFor()
      await openIn(second, /Background, /)
      await second.getByText(/Saved at \d\d:\d\d/).waitFor()

      // The first tab saves first.
      await openIn(first, /Background, /)
      await first.getByRole('button', { name: 'Add background topic' }).click()
      await first.getByRole('textbox', { name: /Title of this background topic/ }).fill('Written in the first tab')
      await settled(first)

      // The second tab edits an old copy.
      await second.getByRole('button', { name: 'Add background topic' }).click()
      await second.getByRole('textbox', { name: /Title of this background topic/ }).fill('Written in the second tab')
      await second.getByRole('heading', { name: 'This working copy changed in another tab' }).waitFor()
      await shot(second, 'tabs-1-other-tab')
      assert.equal(
        await second.getByRole('textbox', { name: /Title of this background topic/ }).inputValue(),
        'Written in the second tab',
        'the local edit was lost',
      )
      const stored = JSON.stringify(await storedSection(first, 'background'))
      assert.ok(stored.includes('Written in the first tab'), 'the first tab edit is not stored')
      assert.ok(!stored.includes('Written in the second tab'), 'the refused edit was stored')

      // Reload the saved version: the edit is kept, to copy or put back.
      await second.getByRole('button', { name: 'Reload the saved version' }).click()
      await second.getByRole('heading', { name: 'Edits that were not saved' }).waitFor()
      const kept = await second.getByRole('textbox', { name: 'Background' }).inputValue()
      assert.ok(kept.includes('Written in the second tab') || kept.includes('Staffing history'), 'the kept edit shows nothing')
      await shot(second, 'tabs-2-kept')
      await second.getByRole('button', { name: 'Put my version of Background back' }).click()
      // Putting it back replaces what the other tab saved, so it asks first.
      await second.getByRole('button', { name: 'Replace the saved version' }).click()
      await settled(second)
      const after = JSON.stringify(await storedSection(second, 'background'))
      assert.ok(after.includes('Written in the second tab'), 'the kept edit was not put back')
      await noSideScroll(second)
      await second.close()
    })

    await step('leaving the text by a link of the app keeps what was typed a moment before', async () => {
      const page = pilotPage
      assert.ok(page !== undefined, 'no pilot page')
      await page.goto(`${pilotUrl}${intakePath}`)
      await page.getByRole('heading', { name: 'Intake and initial assessment', level: 1 }).waitFor()
      await openIn(page, /Summary of the complaint/)
      await page.getByRole('textbox', { name: 'Summary' }).waitFor()
      await page.getByRole('textbox', { name: 'Summary' }).locator('p').first().click()
      await page.keyboard.press('End')
      await page.keyboard.type(' farewell-marker')
      await page.getByText('farewell-marker').waitFor({ timeout: 2000 })
      // No pause: the text is still inside the editor's delay when the link is used.
      await page.getByRole('link', { name: 'Home' }).click()
      const asked = page.getByRole('heading', { name: 'This report has changes that are not saved' })
      const wasAsked = await asked.waitFor({ timeout: 1500 }).then(
        () => true,
        () => false,
      )
      if (wasAsked) {
        await page.getByRole('button', { name: 'Wait for the save, then leave' }).click()
      }
      await page.waitForURL(`${pilotUrl}/`, { waitUntil: 'commit' })
      // The save goes on after the screen is left; a hard reload would cut it off.
      await page.waitForTimeout(1500)
      await page.goto(`${pilotUrl}${intakePath}`)
      await page.getByRole('heading', { name: 'Intake and initial assessment', level: 1 }).waitFor()
      await page.waitForTimeout(500)
      const stored = JSON.stringify(await storedSection(page, 'summary'))
      assert.ok(stored.includes('farewell-marker'), `what was typed just before leaving was lost (asked: ${String(wasAsked)})`)
      await page.goto(`${pilotUrl}${investigationPath}`)
      await page.getByRole('heading', { name: 'Investigation report', level: 1 }).waitFor()
    })

    await step('a report that fills every item of the investigation template is stored as expected, with no instruction text', async () => {
      const page = pilotPage
      assert.ok(page !== undefined, 'no pilot page')
      const reportId = reportIdOf(page)
      const expected = fixture('investigation')
      const copy = await rpc(page, 'StartWorkingCopy', { reportId })
      let saveCounter: number = copy.saveCounter
      for (const [sectionId, content] of Object.entries(expected.sections as Json)) {
        const saved = await rpc(page, 'SaveSection', { reportId, sectionId, saveCounter, content })
        saveCounter = saved.saveCounter
      }
      await page.reload()
      await page.getByRole('heading', { name: 'Investigation report', level: 1 }).waitFor()
      await openIn(page, /Facts and findings, /)
      await page.getByText('2 allegation entries.').waitFor()
      await shot(page, 'fixture-1-investigation')
      const stored: Json = {}
      for (const sectionId of Object.keys(expected.sections as Json)) {
        stored[sectionId] = await storedSection(page, sectionId)
      }
      assert.deepEqual(stored, expected.sections)
      const version = await rpc(page, 'GetTemplateVersion', {
        templateId: expected.templateId,
        version: expected.templateVersion,
        reportId,
      })
      const instructions = instructionsOf(version.template)
      assert.ok(instructions.length > 5, 'no instruction texts were found to scan for')
      const text = JSON.stringify(stored)
      for (const instruction of instructions) {
        assert.ok(!text.includes(instruction), `stored content holds an instruction text: ${instruction.slice(0, 40)}`)
      }
      assert.deepEqual(withoutEntryIds(stored), withoutEntryIds(expected.sections))
    })

    await step('a repeated item on a phone, and a report that fills every item of the intake template is stored as expected', async () => {
      const page = pilotPage
      assert.ok(page !== undefined, 'no pilot page')
      await page.goto(`${pilotUrl}${reportPathOfIntake}`)
      await page.getByRole('heading', { name: 'Intake and initial assessment', level: 1 }).waitFor()
      await openIn(page, /Allegations and regulatory framework, /)
      await page.getByText(/^\d+ allegation entr(y|ies)\./).waitFor()
      await page.getByRole('button', { name: 'Add allegation' }).click()
      await page.getByLabel('Type of allegation', { exact: true }).last().fill('Synthetic type')
      await settled(page)
      await page.getByRole('button', { name: 'Add allegation' }).click()
      await settled(page)
      await shot(page, 'items-1-allegations')
      await page.getByRole('button', { name: 'Move Allegation 2 up' }).click()
      await settled(page)
      await page.getByRole('button', { name: 'Remove Allegation 2' }).click()
      await page.getByRole('heading', { name: 'Remove Allegation 2?' }).waitFor()
      await page.getByRole('button', { name: 'Remove', exact: true }).click()
      await settled(page)
      const one = await storedSection(page, 'allegations')
      assert.equal(one.values['allegation-list'].entries.length, 1)
      await noSideScroll(page)

      const reportId = reportIdOf(page)
      const expected = fixture('intake')
      // NOTE: The committee's conclusion is written while the report is being
      // concluded, which this check does not reach; a drafting author is refused.
      const { 'committee-conclusion': _conclusion, ...drafted } = expected.sections as Json
      expected.sections = drafted
      const copy = await rpc(page, 'StartWorkingCopy', { reportId })
      let saveCounter: number = copy.saveCounter
      for (const [sectionId, content] of Object.entries(expected.sections as Json)) {
        const saved = await rpc(page, 'SaveSection', { reportId, sectionId, saveCounter, content })
        saveCounter = saved.saveCounter
      }
      await page.reload()
      await page.getByRole('heading', { name: 'Intake and initial assessment', level: 1 }).waitFor()
      await openIn(page, /Allegations and regulatory framework, /)
      await page.getByText('2 allegation entries.').waitFor()
      const stored: Json = {}
      for (const sectionId of Object.keys(expected.sections as Json)) {
        stored[sectionId] = await storedSection(page, sectionId)
      }
      assert.deepEqual(stored, expected.sections)
      const version = await rpc(page, 'GetTemplateVersion', {
        templateId: expected.templateId,
        version: expected.templateVersion,
        reportId,
      })
      const text = JSON.stringify(stored)
      for (const instruction of instructionsOf(version.template)) {
        assert.ok(!text.includes(instruction), `stored content holds an instruction text: ${instruction.slice(0, 40)}`)
      }
    })

    // NOTE: Stage 4g, at 375 px: two authors start from the same draft. Each
    // adds a different allegation and both change the investigator. The first
    // shares; the second sees the comparison with only the investigator as a
    // conflict and both allegations taken automatically, resolves, and gets
    // the next draft. Shared drafts never change. One author comments on a
    // phrase of the other's draft and the other resolves the comment.
    await step('two authors share from one draft: the comparison, the automatic changes, immutable drafts, comments', async () => {
      const pia = pilotPage
      assert.ok(pia !== undefined, 'no pilot page')
      await pia.goto(`${pilotUrl}/admin`)
      await pia.getByRole('heading', { name: 'Administration' }).waitFor()
      await pia.getByLabel('E-mail', { exact: true }).fill('bea.second@case-desk.test')
      await pia.getByLabel('Name', { exact: true }).fill('Bea Second')
      await pia.getByLabel('Capability', { exact: true }).selectOption('author')
      await pia.getByLabel('Unit', { exact: true }).selectOption({ label: 'Pilot Unit (PIL)' })
      await pia.getByRole('button', { name: 'Give capability' }).click()
      await pia.getByRole('textbox', { name: 'Link' }).waitFor()
      const beaLink = await copiedLink(pia)
      const bea = await person(launched)
      await activate(bea, beaLink.replace(/^https?:\/\/[^/]+/, pilotUrl), 'bea')

      await pia.goto(`${pilotUrl}/reports`)
      await pia.getByRole('heading', { name: 'Start a report' }).waitFor()
      await pia
        .getByLabel('Template', { exact: true })
        .selectOption({ label: 'Intake and initial assessment (version 1)' })
      await pia.getByLabel('Integrity Line reference', { exact: true }).fill('PIL-0004')
      await pia.getByLabel('Case file title', { exact: true }).fill('Synthetic sharing case file')
      await pia.getByRole('button', { name: 'Create report' }).click()
      await pia.getByRole('link', { name: 'Open report PIL-0004' }).click()
      await pia.getByRole('heading', { name: 'Intake and initial assessment', level: 1 }).waitFor()
      const reportId = reportIdOf(pia)
      await pia.locator('#co-author-choice').selectOption({ label: 'Bea Second' })
      await pia.getByRole('button', { name: 'Add co-author' }).click()
      await pia.getByText(/Bea Second/).first().waitFor()

      const details = (text: string): Json => ({
        values: { investigator: { type: 'text', text } },
        sections: {},
      })
      const allegation = (id: string, text: string): Json => ({
        values: {
          'allegation-list': {
            type: 'repeated',
            entries: [{ id, values: { 'allegation-type': { type: 'text', text } } }],
          },
        },
        sections: {},
      })
      const prepare = async (page: Page, who: string, id: string): Promise<void> => {
        const copy = await rpc(page, 'StartWorkingCopy', { reportId })
        assert.equal(copy.baseDraft, 0)
        let counter: number = copy.saveCounter
        const first = await rpc(page, 'SaveSection', {
          reportId,
          sectionId: 'case-details',
          saveCounter: counter,
          content: details(`Investigator named by ${who}`),
        })
        counter = first.saveCounter
        await rpc(page, 'SaveSection', {
          reportId,
          sectionId: 'allegations',
          saveCounter: counter,
          content: allegation(id, `Allegation added by ${who}`),
        })
      }
      await prepare(pia, 'Pia', 'pia-1')
      await prepare(bea, 'Bea', 'bea-1')

      await pia.goto(`${pilotUrl}/r/${reportId}`)
      await pia.getByRole('heading', { name: 'Intake and initial assessment', level: 1 }).waitFor()
      await bea.goto(`${pilotUrl}/r/${reportId}`)
      await bea.getByRole('heading', { name: 'Intake and initial assessment', level: 1 }).waitFor()
      await pia
        .getByText(/Bea Second is working from Draft 0, last saved \d\d:\d\d/)
        .waitFor()
      await shot(pia, 'share-1-who-is-drafting')

      // The first author shares.
      await pia.getByRole('link', { name: 'Share as Draft 1' }).click()
      await pia.getByRole('button', { name: 'Share as Draft 1' }).click()
      await pia.getByText('Shared as Draft 1.').waitFor()
      await shot(pia, 'share-2-first-shared')

      const sectionsOf = async (page: Page, draft: number): Promise<string> =>
        JSON.stringify([
          await rpc(page, 'GetDraftSection', { reportId, draft, sectionId: 'case-details', view: 'original' }),
          await rpc(page, 'GetDraftSection', { reportId, draft, sectionId: 'allegations', view: 'original' }),
        ])
      const draftOne = await sectionsOf(pia, 1)
      assert.ok(draftOne.includes('Investigator named by Pia'))

      // The second author shares on a stale base and sees the comparison.
      await bea.goto(`${pilotUrl}/r/${reportId}/share`)
      const go = bea.getByRole('button', { name: 'Share as Draft 2' })
      const heading = bea.getByRole('heading', { name: 'Compare with Draft 1' })
      await go.or(heading).first().waitFor()
      if (await go.isVisible()) await go.click()
      await heading.waitFor()
      assert.equal(await bea.getByRole('button', { name: /^Keep my version of/ }).count(), 1)
      const automatic = bea.getByRole('list', { name: 'Changes taken automatically' })
      await automatic.waitFor()
      assert.ok((await automatic.getByRole('listitem').count()) >= 1, 'no change is listed as automatic')
      assert.match(await automatic.innerText(), /llegation/)
      await shot(bea, 'share-3-comparison')
      await bea.getByRole('button', { name: /^Keep my version of/ }).click()
      await bea.getByText('Chosen: mine.').waitFor()
      await bea.getByRole('button', { name: /^Resolve and review Draft 2/ }).click()
      await bea.getByRole('button', { name: /^Confirm the redacted version and share as Draft 2/ }).click()
      await bea.getByText('Shared as Draft 2.').waitFor()
      await shot(bea, 'share-4-resolved')

      const two = JSON.parse(await sectionsOf(bea, 2))
      assert.ok(JSON.stringify(two[0]).includes('Investigator named by Bea'))
      const ids: Array<string> = two[1].content.values['allegation-list'].entries.map((entry: Json) => entry.id)
      assert.deepEqual([...ids].sort(), ['bea-1', 'pia-1'])
      const draftTwo = await sectionsOf(bea, 2)

      // Later shares and edits leave shared drafts as they were.
      const again = await rpc(pia, 'StartWorkingCopy', { reportId, baseDraft: 2, replace: true })
      await rpc(pia, 'SaveSection', {
        reportId,
        sectionId: 'case-details',
        saveCounter: again.saveCounter,
        content: details('Investigator named later by Pia'),
      })
      await pia.goto(`${pilotUrl}/r/${reportId}/share`)
      await pia.getByRole('button', { name: 'Share as Draft 3' }).click()
      await pia.getByText('Shared as Draft 3.').waitFor()
      assert.equal(await sectionsOf(pia, 1), draftOne, 'Draft 1 changed')
      assert.equal(await sectionsOf(pia, 2), draftTwo, 'Draft 2 changed')

      // History and a comment on a phrase of the first author's draft.
      await bea.goto(`${pilotUrl}/r/${reportId}/drafts`)
      await bea.getByRole('list', { name: 'Shared drafts' }).getByText(/Pia Second|Pia Pilot/).first().waitFor()
      await shot(bea, 'share-5-history')
      await bea.goto(`${pilotUrl}/r/${reportId}/drafts/1`)
      const item = bea.locator('[data-comment-item="investigator"]')
      await item.waitFor()
      assert.equal(await bea.locator('.tiptap, quoroom-editor').count(), 0, 'an editor is in the read-only view')
      const selected = await bea.evaluate(phrase => {
        const element = document.querySelector('[data-comment-item="investigator"]')
        if (element === null) return false
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        let node: Node | null = walker.nextNode()
        while (node !== null) {
          const at = (node.textContent ?? '').indexOf(phrase)
          if (at >= 0) {
            const range = document.createRange()
            range.setStart(node, at)
            range.setEnd(node, at + phrase.length)
            const selection = window.getSelection()
            selection?.removeAllRanges()
            selection?.addRange(range)
            return true
          }
          node = walker.nextNode()
        }
        return false
      }, 'named by Pia')
      assert.ok(selected, 'the phrase was not found')
      await bea.getByText('Selected: "named by Pia"').waitFor()
      await bea.getByRole('button', { name: 'Comment on the selected text' }).click()
      await bea.getByLabel('Your comment').fill('Please name the role as well.')
      await bea.getByRole('button', { name: 'Add comment' }).click()
      await bea.getByText('Please name the role as well.').waitFor()
      await shot(bea, 'share-6-comment')

      await pia.goto(`${pilotUrl}/r/${reportId}/drafts/1`)
      await pia.getByText('Please name the role as well.').waitFor()
      await shot(pia, 'share-7-comment-seen')
      await pia.getByRole('button', { name: 'Resolve this comment' }).click()
      await pia.getByRole('button', { name: 'Reopen this comment' }).waitFor()
      await shot(pia, 'share-8-resolved')
      assert.equal(await sectionsOf(pia, 1), draftOne, 'Draft 1 changed after comments')
      await bea.context().close()
    })

    await step('names and redaction on a phone: add a person, accept a suggestion, redacted view, mark an image safe, confirm the preview, share', async () => {
      const pia = pilotPage
      assert.ok(pia !== undefined, 'no pilot page')
      await pia.goto(`${pilotUrl}/reports`)
      await pia.getByRole('heading', { name: 'Start a report' }).waitFor()
      await pia
        .getByLabel('Template', { exact: true })
        .selectOption({ label: 'Intake and initial assessment (version 1)' })
      await pia.getByLabel('Integrity Line reference', { exact: true }).fill('PIL-0005')
      await pia.getByLabel('Case file title', { exact: true }).fill('Synthetic redaction case file')
      await pia.getByRole('button', { name: 'Create report' }).click()
      await pia.getByRole('link', { name: 'Open report PIL-0005' }).click()
      await pia.getByRole('heading', { name: 'Intake and initial assessment', level: 1 }).waitFor()
      const reportId = reportIdOf(pia)
      const copy = await rpc(pia, 'StartWorkingCopy', { reportId })
      await rpc(pia, 'SaveSection', {
        reportId,
        sectionId: 'case-details',
        saveCounter: copy.saveCounter,
        content: {
          values: {
            investigator: {
              type: 'text',
              text: 'Zorana Veltkamp interviewed Bertil Nwosu. Bertil Nwosu left. Zora stayed.',
            },
          },
          sections: {},
        },
      })

      // A picture in the summary, not marked safe.
      await pia.goto(`${pilotUrl}/r/${reportId}`)
      await pia.getByRole('heading', { name: 'Intake and initial assessment', level: 1 }).waitFor()
      const row = pia.getByRole('button', { name: /Summary of the complaint/ })
      if (!(await row.first().isVisible())) {
        await pia.getByRole('button', { name: /^Sections/ }).click()
      }
      await row.first().click()
      await pia.getByRole('textbox', { name: 'Summary' }).click()
      const picture = Buffer.from(
        await syntheticImage(pia, { width: 400, height: 300, kind: 'photo', quality: 0.9 }),
        'base64',
      )
      const [chooser] = await Promise.all([
        pia.waitForEvent('filechooser'),
        pia.getByRole('button', { name: 'Insert image', exact: true }).click(),
      ])
      await chooser.setFiles({ name: 'synthetic-redaction.jpg', mimeType: 'image/jpeg', buffer: picture })
      await pia.getByText('Picture added.').waitFor()
      await pia.waitForTimeout(700)
      await pia.getByText(/Saved at \d\d:\d\d/).waitFor()

      // The people panel: a person with an alias, from the default label.
      await pia.getByRole('link', { name: 'People and names (0)' }).click()
      await pia.getByRole('heading', { name: 'People, names and pictures' }).waitFor()
      await pia.getByRole('button', { name: 'Add a person', exact: true }).click()
      assert.equal(await pia.locator('#person-label').inputValue(), 'Person 1')
      await pia.locator('#person-name').fill('Zorana Veltkamp')
      await pia.locator('#person-aliases').fill('Zora')
      await pia.getByRole('button', { name: 'Add this person' }).click()
      await pia.getByText('The list of people is saved.').waitFor()
      await pia.getByText('Reviewers read: Person 1').waitFor()
      await shot(pia, 'names-1-person-added')

      // A suggestion taken as a new person, with the next label.
      const suggestion = pia.getByRole('button', { name: /^Add .*Nwosu.* as a new person$/ }).first()
      await suggestion.waitFor()
      await suggestion.click()
      assert.equal(await pia.locator('#person-label').inputValue(), 'Person 2')
      assert.match(await pia.locator('#person-name').inputValue(), /Nwosu/)
      await pia.getByRole('button', { name: 'Add this person' }).click()
      await pia.getByText('Reviewers read: Person 2').waitFor()
      await shot(pia, 'names-2-suggestion-accepted')

      // The picture is not safe until it is marked, and the mark can be taken back.
      const pictureRow = pia.locator('[data-image-id]').first()
      await pictureRow.waitFor()
      assert.equal(await pictureRow.getAttribute('data-safe'), 'false')
      await pictureRow.getByRole('button', { name: 'Mark safe to share' }).click()
      await pia.locator('[data-image-id][data-safe="true"]').waitFor()
      await shot(pia, 'names-3-image-safe')

      // The redacted view of the drafting screen: highlights, no names.
      await pia.getByRole('link', { name: 'Back to the report' }).click()
      await pia.getByRole('link', { name: 'People and names (2)' }).waitFor()
      await pia.getByRole('button', { name: 'Redacted', exact: true }).click()
      await openIn(pia, /Case details/)
      await pia.locator('[data-redaction="replaced"]').first().waitFor()
      const redactedText = await pia.locator('body').innerText()
      assert.ok(!/Veltkamp|Zorana|Nwosu/.test(redactedText), 'a name is in the redacted view')
      assert.ok(redactedText.includes('Person 1'), 'the label is not in the redacted view')
      await shot(pia, 'names-4-redacted-view')
      await pia.getByRole('button', { name: 'Original', exact: true }).click()
      const investigator = pia.getByRole('textbox', { name: 'Investigator' })
      await investigator.waitFor()
      assert.match(await investigator.inputValue(), /Zorana Veltkamp interviewed/)

      // The share preview, the confirmation, and what was stored.
      await pia.getByRole('link', { name: /^Share as Draft/ }).click()
      await pia.locator('[data-preview="redacted"] [data-redaction="replaced"]').first().waitFor()
      assert.ok(!/Veltkamp|Nwosu/.test(await pia.locator('[data-preview]').innerText()), 'a name is in the preview')
      await shot(pia, 'names-5-share-preview')
      await pia.getByRole('button', { name: /^Confirm the redacted version and share as Draft/ }).click()
      await pia.getByText(/^Shared as Draft \d+\.$/).waitFor()
      await shot(pia, 'names-6-shared')
      const stored = JSON.stringify(
        await rpc(pia, 'GetDraftSection', {
          reportId,
          draft: 1,
          sectionId: 'case-details',
          view: 'redacted',
        }),
      )
      assert.ok(!/Veltkamp|Zorana|Nwosu/.test(stored), 'a name is in the stored redacted section')
      assert.ok(stored.includes('Person 1'), 'the stored redacted section has no label')
    })

    // NOTE: Stage 6a, at 375 px: an author publishes Revision 1 to a committee
    // with a deadline after confirming the preview, sees the round and the
    // WhatsApp buttons (a link holding the deadline and no report content), then
    // publishes Revision 2 and Revision 1 shows as superseded.
    await step('publishing on a phone: a committee and a deadline, the round, wa.me links with no report content, a second revision supersedes the first', async () => {
      const pia = pilotPage
      assert.ok(pia !== undefined, 'no pilot page')

      // A reviewer with a number and consent, in a committee.
      await pia.goto(`${pilotUrl}/unit`)
      await pia.getByRole('heading', { name: 'My unit' }).waitFor()
      await pia.getByLabel('Reviewer name').fill('Pat Panel')
      await pia.getByLabel('Reviewer e-mail').fill('pat.panel@case-desk.test')
      await pia.getByLabel('Reviewer phone number').fill('+34 611 000 111')
      await pia.getByLabel('Ask for WhatsApp consent').check()
      await pia.getByRole('button', { name: 'Register reviewer' }).click()
      await pia.getByRole('textbox', { name: 'Link' }).waitFor()
      const patLink = await copiedLink(pia)
      await pia.getByLabel('Committee name').fill('Publishing Committee')
      await pia.getByRole('button', { name: 'Create committee' }).click()
      await pia.getByRole('heading', { name: 'Publishing Committee' }).waitFor()
      const member = pia.getByLabel('Pat Panel in Publishing Committee')
      await ensureChecked(member, 'the member was not added')

      const pat = await person(launched)
      await activate(pat, patLink, 'pat')
      await pat.getByRole('link', { name: 'My account' }).click()
      await pat.getByRole('heading', { name: 'Your account' }).waitFor()
      await pat.getByLabel('Phone number').fill('+34 611 000 111')
      await pat
        .getByLabel('I agree to receive messages from Quoroom on WhatsApp at this number')
        .check()
      await pat.getByRole('button', { name: 'Save preferences' }).click()
      await pat.getByText('Saved.').waitFor()

      // A report with a sentence in it, shared and published in one go.
      await pia.goto(`${pilotUrl}/reports`)
      await pia.getByRole('heading', { name: 'Start a report' }).waitFor()
      await pia
        .getByLabel('Template', { exact: true })
        .selectOption({ label: 'Intake and initial assessment (version 1)' })
      await pia.getByLabel('Integrity Line reference', { exact: true }).fill('PIL-0006')
      await pia.getByLabel('Case file title', { exact: true }).fill('Synthetic publishing case file')
      await pia.getByRole('button', { name: 'Create report' }).click()
      await pia.getByRole('link', { name: 'Open report PIL-0006' }).click()
      await pia.getByRole('heading', { name: 'Intake and initial assessment', level: 1 }).waitFor()
      const reportId = reportIdOf(pia)
      const save = async (text: string): Promise<void> => {
        let counter: number
        try {
          counter = (await rpc(pia, 'StartWorkingCopy', { reportId })).saveCounter
        } catch {
          counter = (await rpc(pia, 'GetWorkingCopy', { reportId })).saveCounter
        }
        await rpc(pia, 'SaveSection', {
          reportId,
          sectionId: 'case-details',
          saveCounter: counter,
          content: { values: { investigator: { type: 'text', text } }, sections: {} },
        })
      }
      const SECRET = 'The unmistakable sentence of Revision One.'
      await save(SECRET)
      await pia.goto(`${pilotUrl}/r/${reportId}`)
      await pia.getByRole('link', { name: /^Share as Draft/ }).click()
      await pia.locator('[data-preview="redacted"]').first().waitFor()
      await pia.getByLabel('Publish this draft for review as soon as it is shared').check()
      await pia.getByLabel('Publishing Committee').check()
      assert.ok((await pia.locator('#publish-date').inputValue()) !== '', 'no default date')
      assert.ok((await pia.locator('#publish-zone').inputValue()) !== '', 'no default zone')
      await shot(pia, 'publish-1-share-and-publish')
      await pia
        .getByRole('button', { name: /^Confirm the redacted version, share as Draft \d+ and publish/ })
        .click()
      await pia.locator('[data-published="1"]').waitFor()
      await pia.getByRole('link', { name: 'Review round, deadline and WhatsApp requests' }).click()
      await pia.locator('[data-current-round="1"]').waitFor()
      await pia.getByText(/Due .*left\./).first().waitFor()
      await noSideScroll(pia)
      // NOTE: no number is on the page until the author taps for that person.
      assert.equal(await pia.locator('a[href^="https://wa.me/"]').count(), 0, 'a number is on the page before the tap')
      await pia.getByRole('button', { name: 'Prepare the WhatsApp message for Pat Panel' }).click()
      const button = pia.getByRole('link', { name: 'Send on WhatsApp to Pat Panel' })
      await button.waitFor()
      const href = (await button.getAttribute('href')) ?? ''
      assert.ok(href.startsWith('https://wa.me/34611000111?text='), `href ${href}`)
      const decoded = decodeURIComponent(href)
      assert.ok(!decoded.includes('unmistakable'), 'report content is in the WhatsApp link')
      assert.ok(!decoded.includes('Synthetic publishing case file'), 'the case title is in the link')
      assert.ok(/Due|due/.test(decoded) || /\d{1,2}/.test(decoded), 'no deadline in the link')
      await shot(pia, 'publish-2-round-and-whatsapp')

      // Revision 2: a change, a new draft, published from the publish screen.
      await save('A second, different sentence for Revision Two.')
      await pia.goto(`${pilotUrl}/r/${reportId}/share`)
      await pia.locator('[data-preview="redacted"]').first().waitFor()
      await pia.getByRole('button', { name: /^Confirm the redacted version and share as Draft/ }).click()
      await pia.getByText(/^Shared as Draft \d+\.$/).waitFor()
      await pia.goto(`${pilotUrl}/r/${reportId}/publish`)
      await pia.getByRole('heading', { name: 'Publish Revision 2' }).waitFor()
      await pia.getByLabel('Publishing Committee').check()
      await pia.getByRole('button', { name: 'Publish Revision 2' }).click()
      await pia.locator('[data-published="2"]').waitFor()
      await pia.locator('[data-current-round="2"]').waitFor()
      await pia.locator('[data-revision="1"][data-status="superseded"]').waitFor()
      await pia.getByText('Superseded by Revision 2').waitFor()
      await noSideScroll(pia)
      await shot(pia, 'publish-3-superseded')
    })

    await step('reviewing: a deep link signs in, comments on a phrase and a section, a pending review survives a reload, the review is sent, and each reader sees only what is theirs', async () => {
      const pia = pilotPage
      assert.ok(pia !== undefined, 'no pilot page')
      const desktop = async (): Promise<Page> => {
        const context = await launched.newContext({ viewport: { width: 1280, height: 900 } })
        return context.newPage()
      }

      // Two redacted reviewers in one committee.
      await pia.goto(`${pilotUrl}/unit`)
      await pia.getByRole('heading', { name: 'My unit' }).waitFor()
      const register = async (name: string, email: string): Promise<string> => {
        await pia.getByLabel('Reviewer name').fill(name)
        await pia.getByLabel('Reviewer e-mail').fill(email)
        await pia.getByRole('button', { name: 'Register reviewer' }).click()
        await pia.getByRole('textbox', { name: 'Link' }).waitFor()
        return copiedLink(pia)
      }
      const rheaLink = await register('Rhea Reviewer', 'rhea.reviewer@case-desk.test')
      const raviLink = await register('Ravi Reviewer', 'ravi.reviewer@case-desk.test')
      await pia.getByLabel('Committee name').fill('Review Committee')
      await pia.getByRole('button', { name: 'Create committee' }).click()
      await pia.getByRole('heading', { name: 'Review Committee' }).waitFor()
      for (const name of ['Rhea Reviewer', 'Ravi Reviewer']) {
        const member = pia.getByLabel(`${name} in Review Committee`)
        await ensureChecked(member, `${name} was not added`)
      }

      const rheaFirst = await person(launched)
      await activate(rheaFirst, rheaLink, 'rhea')
      await rheaFirst.context().close()
      const ravi = await desktop()
      await activate(ravi, raviLink, 'ravi')

      // A report with a sentence in it, shared and published to the committee.
      await pia.goto(`${pilotUrl}/reports`)
      await pia.getByRole('heading', { name: 'Start a report' }).waitFor()
      await pia
        .getByLabel('Template', { exact: true })
        .selectOption({ label: 'Intake and initial assessment (version 1)' })
      await pia.getByLabel('Integrity Line reference', { exact: true }).fill('PIL-0007')
      await pia.getByLabel('Case file title', { exact: true }).fill('Synthetic reviewing case file')
      await pia.getByRole('button', { name: 'Create report' }).click()
      await pia.getByRole('link', { name: 'Open report PIL-0007' }).click()
      await pia.getByRole('heading', { name: 'Intake and initial assessment', level: 1 }).waitFor()
      const reportId = reportIdOf(pia)
      reportsByReference['PIL-0007'] = reportId
      const PHRASE = 'delay in the supply'
      const copy = await rpc(pia, 'StartWorkingCopy', { reportId })
      await rpc(pia, 'SaveSection', {
        reportId,
        sectionId: 'case-details',
        saveCounter: copy.saveCounter,
        content: {
          values: { investigator: { type: 'text', text: `The camp reported a ${PHRASE} of water.` } },
          sections: {},
        },
      })
      await pia.goto(`${pilotUrl}/r/${reportId}`)
      await pia.getByRole('link', { name: /^Share as Draft/ }).click()
      await pia.locator('[data-preview="redacted"]').first().waitFor()
      await pia.getByLabel('Publish this draft for review as soon as it is shared').check()
      await pia.getByRole('checkbox', { name: /^Review Committee/ }).check()
      await pia
        .getByRole('button', { name: /^Confirm the redacted version, share as Draft \d+ and publish/ })
        .click()
      await pia.locator('[data-published="1"]').waitFor()

      // R1 at 375 px: the deep link, a sign-in, a phrase, a section.
      const rhea = await person(launched)
      await rhea.goto(`${pilotUrl}/r/${reportId}/rev/1`)
      await rhea.getByRole('heading', { name: 'Sign in' }).waitFor()
      assert.equal(new URL(rhea.url()).pathname, `/r/${reportId}/rev/1`)
      await rhea.getByLabel('E-mail').fill('rhea.reviewer@case-desk.test')
      await rhea.getByLabel('Password', { exact: true }).fill(PASSWORD)
      await rhea.getByRole('button', { name: 'Sign in' }).click()
      await rhea.getByRole('heading', { name: 'Revision 1' }).waitFor()
      assert.equal(new URL(rhea.url()).pathname, `/r/${reportId}/rev/1`)
      await rhea.getByText(PHRASE, { exact: false }).first().waitFor()
      await shot(rhea, 'review-1-reading-375')

      const selectPhrase = async (page: Page): Promise<void> => {
        await page.evaluate(phrase => {
          const root = document.querySelector('[data-comment-item="investigator"]')
          if (root === null) {
            throw new Error('no item to select in')
          }
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
          throw new Error('the phrase is not in the item')
        }, PHRASE)
      }
      await selectPhrase(rhea)
      await rhea.locator('[data-selection-bar]').waitFor()
      await rhea.getByRole('button', { name: 'Comment on the selected text' }).click()
      await rhea.getByRole('textbox', { name: 'Your comment' }).fill('Which camp, and how late?')
      assert.ok(await rhea.getByRole('radio', { name: /Authors only/ }).isChecked(), 'authors only is not the default')
      await rhea.getByRole('button', { name: 'Add comment' }).click()
      await rhea.locator('[data-comment][data-visibility="authors"]').waitFor()
      await rhea.locator('[data-comment-highlight]').first().waitFor()
      await shot(rhea, 'review-2-text-comment-375')

      await rhea.getByRole('button', { name: 'Comment on this section' }).click()
      await rhea.getByRole('textbox', { name: 'Your comment' }).fill('The whole committee should read this.')
      await rhea.getByRole('radio', { name: /The whole committee/ }).check()
      await rhea.getByRole('button', { name: 'Add comment' }).click()
      await rhea.locator('[data-comment][data-visibility="committee"]').waitFor()

      // At 375 px the comments sit below the text.
      const below = await rhea.evaluate(() => {
        const text = document.querySelector('[data-revision-section]')?.getBoundingClientRect()
        const panel = document.querySelector('[data-comments-panel]')?.getBoundingClientRect()
        return text !== undefined && panel !== undefined && panel.top >= text.bottom - 1
      })
      assert.ok(below, 'at phone width the comments are not below the text')

      // A reload keeps the pending review.
      await rhea.reload()
      await rhea.getByRole('heading', { name: 'Revision 1' }).waitFor()
      await rhea.locator('[data-pending-count="2"]').waitFor()
      await shot(rhea, 'review-3-pending-after-reload-375')

      // R2 at desktop width cannot see them before they are sent.
      await ravi.goto(`${pilotUrl}/r/${reportId}/rev/1`)
      await ravi.getByRole('heading', { name: 'Revision 1' }).waitFor()
      await ravi.getByText(PHRASE, { exact: false }).first().waitFor().catch(async error => {
        console.log((await ravi.locator('main').innerText()).slice(0, 900))
        throw error
      })
      await ravi.getByText('No comments here yet.').waitFor()
      assert.equal(await ravi.locator('[data-comment]').count(), 0, 'a pending comment is visible to another reviewer')
      const beside = await ravi.evaluate(() => {
        const text = document.querySelector('[data-revision-section]')?.getBoundingClientRect()
        const panel = document.querySelector('[data-comments-panel]')?.getBoundingClientRect()
        return text !== undefined && panel !== undefined && panel.left >= text.right - 1 && panel.top < text.bottom
      })
      assert.ok(beside, 'at desktop width the comments are not beside the text')

      // R1 sends the review after a summary and a confirmation.
      await rhea.getByRole('button', { name: 'Send your review' }).click()
      await rhea.getByText('2 comments are sent: 1 to the authors only, 1 to the whole committee.').waitFor()
      assert.ok(
        await rhea.getByRole('button', { name: 'Confirm and send review' }).isDisabled(),
        'a review can be confirmed with no decision',
      )
      await rhea.getByRole('radio', { name: /Request changes/ }).check()
      await shot(rhea, 'review-4-send-dialog-375')
      await rhea.getByRole('button', { name: 'Confirm and send review' }).click()
      await rhea.locator('[data-review-sent="request_changes"]').waitFor()
      await shot(rhea, 'review-5-sent-375')

      // The author sees both, replies to the committee one, and resolves it.
      await pia.goto(`${pilotUrl}/r/${reportId}/comments`)
      await pia.getByRole('heading', { name: 'Comments from reviewers' }).waitFor()
      await pia.getByText('Which camp, and how late?').waitFor()
      await pia.getByText('The whole committee should read this.').waitFor()
      const committee = pia.locator('[data-comment][data-visibility="committee"]')
      await committee.getByRole('textbox', { name: 'Reply' }).fill('It was the north camp, about a week.')
      await committee.getByRole('button', { name: 'Send reply to this comment' }).click()
      await committee.locator('[data-reply]').waitFor()
      await committee.getByRole('button', { name: 'Resolve this comment' }).click()
      await pia.locator('[data-comment][data-visibility="committee"][data-resolved="true"]').waitFor()
      await shot(pia, 'review-6-author-comments-375')

      // R2 now sees only the committee comment, with its author and the reply.
      await ravi.reload()
      await ravi.getByRole('heading', { name: 'Revision 1' }).waitFor()
      await ravi.getByText('The whole committee should read this.').waitFor()
      await ravi.getByText('It was the north camp, about a week.').waitFor()
      await ravi.getByText('Rhea Reviewer', { exact: false }).first().waitFor()
      assert.equal(await ravi.locator('[data-comment]').count(), 1, 'R2 sees more than the committee comment')
      assert.equal(await ravi.getByText('Which camp, and how late?').count(), 0, 'an authors-only comment reached R2')
      await shot(ravi, 'review-7-committee-view-desktop')
      await ravi.context().close()
      await rhea.context().close()
    })
    // NOTE: Stage 6d and 6e at 375 px with three accounts: the author (Pia) and
    // two reviewers (Rhea, Ravi) of one committee. The closing path of a report
    // whose template has a conclusion, then the grid and the audit log.
    await step('the closing path on a phone: change request and comments, Revision 2, approvals on Revision 2 only, the round decided, the conclusion, the closing revision, the archive; then the grid and the audit log', async () => {
      const pia = pilotPage
      assert.ok(pia !== undefined, 'no pilot page')
      const signedIn = async (path: string, email: string): Promise<Page> => {
        const page = await person(launched)
        await page.goto(`${pilotUrl}${path}`)
        await page.getByRole('heading', { name: 'Sign in' }).waitFor()
        await page.getByLabel('E-mail').fill(email)
        await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
        await page.getByRole('button', { name: 'Sign in' }).click()
        return page
      }
      const doc = (text: string): Json => ({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      })
      const PHRASE = 'storage of the tents'

      // A report with Revision 1 published to the Review Committee.
      await pia.goto(`${pilotUrl}/reports`)
      await pia.getByRole('heading', { name: 'Start a report' }).waitFor()
      await pia
        .getByLabel('Template', { exact: true })
        .selectOption({ label: 'Intake and initial assessment (version 1)' })
      await pia.getByLabel('Integrity Line reference', { exact: true }).fill('PIL-0008')
      await pia.getByLabel('Case file title', { exact: true }).fill('Synthetic closing case file')
      await pia.getByRole('button', { name: 'Create report' }).click()
      await pia.getByRole('link', { name: 'Open report PIL-0008' }).click()
      await pia.getByRole('heading', { name: 'Intake and initial assessment', level: 1 }).waitFor()
      const reportId = reportIdOf(pia)
      reportsByReference['PIL-0008'] = reportId
      // Bea is a co-author who never opens the report until it is archived.
      await pia.locator('#co-author-choice').selectOption({ label: 'Bea Second' })
      await pia.getByRole('button', { name: 'Add co-author' }).click()
      await pia.getByText(/Bea Second/).first().waitFor()
      const saveSection = async (sectionId: string, itemId: string, type: 'text' | 'rich_text', text: string): Promise<void> => {
        let counter: number
        try {
          counter = (await rpc(pia, 'StartWorkingCopy', { reportId })).saveCounter
        } catch {
          counter = (await rpc(pia, 'GetWorkingCopy', { reportId })).saveCounter
        }
        await rpc(pia, 'SaveSection', {
          reportId,
          sectionId,
          saveCounter: counter,
          content: {
            values: { [itemId]: type === 'text' ? { type, text } : { type, doc: doc(text) } },
            sections: {},
          },
        })
      }
      await saveSection('case-details', 'investigator', 'text', `The report names the ${PHRASE} at the camp.`)
      await pia.goto(`${pilotUrl}/r/${reportId}`)
      await pia.getByRole('link', { name: /^Share as Draft/ }).click()
      await pia.locator('[data-preview="redacted"]').first().waitFor()
      await pia.getByLabel('Publish this draft for review as soon as it is shared').check()
      await pia.getByRole('checkbox', { name: /^Review Committee/ }).check()
      await pia
        .getByRole('button', { name: /^Confirm the redacted version, share as Draft \d+ and publish/ })
        .click()
      await pia.locator('[data-published="1"]').waitFor()

      // Revision 1: Rhea comments on a phrase and, for the committee, on the
      // section, and asks for changes.
      const rhea = await signedIn(`/r/${reportId}/rev/1`, 'rhea.reviewer@case-desk.test')
      await rhea.getByRole('heading', { name: 'Revision 1' }).waitFor()
      await rhea.getByText(PHRASE, { exact: false }).first().waitFor()
      await rhea.evaluate(phrase => {
        const root = document.querySelector('[data-comment-item="investigator"]')
        if (root === null) throw new Error('no item to select in')
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
        throw new Error('the phrase is not in the item')
      }, PHRASE)
      await rhea.locator('[data-selection-bar]').waitFor()
      await rhea.getByRole('button', { name: 'Comment on the selected text' }).click()
      await rhea.getByRole('textbox', { name: 'Your comment' }).fill('Where are the tents stored?')
      await rhea.getByRole('button', { name: 'Add comment' }).click()
      await rhea.locator('[data-comment][data-visibility="authors"]').waitFor()
      await rhea.getByRole('button', { name: 'Comment on this section' }).click()
      await rhea.getByRole('textbox', { name: 'Your comment' }).fill('The committee should look at the storage.')
      await rhea.getByRole('radio', { name: /The whole committee/ }).check()
      await rhea.getByRole('button', { name: 'Add comment' }).click()
      await rhea.locator('[data-comment][data-visibility="committee"]').waitFor()
      const send = async (page: Page, decision: RegExp, sent: string): Promise<void> => {
        await page.getByRole('button', { name: 'Send your review' }).click()
        await page.getByRole('radio', { name: decision }).check()
        await page.getByRole('button', { name: 'Confirm and send review' }).click()
        await page.locator(`[data-review-sent="${sent}"]`).waitFor()
      }
      await send(rhea, /Request changes/, 'request_changes')

      // The grid on a phone: the table scrolls inside its box, never the page,
      // and shows Rhea's decision with its time and Ravi's silence.
      await pia.goto(`${pilotUrl}/r/${reportId}/grid`)
      await pia.getByRole('heading', { name: 'Status grid' }).waitFor()
      await pia.getByRole('heading', { name: 'Revision 1, from Draft 1' }).waitFor()
      await pia.locator('[data-reviewer][data-removed="false"]').first().waitFor()
      await noSideScroll(pia)
      const scrolls = await pia.evaluate(() => {
        const box = document.querySelector('[role="region"][aria-label="Reviewers of Revision 1"]')
        return box === null ? undefined : box.scrollWidth > box.clientWidth
      })
      assert.equal(scrolls, true, 'the reviewer table does not scroll inside its own box at 375 px')
      assert.ok((await pia.getByText(/^Asked for changes, \d/).count()) >= 1, 'no decision with a time in the grid')
      await pia.getByText('No decision yet').waitFor()
      await shot(pia, 'closing-1-grid-375')

      // A deadline is extended from the grid, and the extension is logged.
      const later = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10)
      await pia.getByLabel('New date').fill(later)
      await pia.getByRole('button', { name: 'Extend the deadline' }).click()
      await pia.getByText('The deadline was extended. The reviewers are told.').waitFor()

      // Revision 2 replaces the round.
      await saveSection('case-details', 'investigator', 'text', 'The tents are now stored in the covered area of the camp.')
      await pia.goto(`${pilotUrl}/r/${reportId}/share`)
      await pia.locator('[data-preview="redacted"]').first().waitFor()
      await pia.getByRole('button', { name: /^Confirm the redacted version and share as Draft/ }).click()
      await pia.getByText(/^Shared as Draft \d+\.$/).waitFor()
      await pia.goto(`${pilotUrl}/r/${reportId}/publish`)
      await pia.getByRole('heading', { name: 'Publish Revision 2' }).waitFor()
      await pia.getByRole('checkbox', { name: /^Review Committee/ }).check()
      await pia.getByRole('button', { name: 'Publish Revision 2' }).click()
      await pia.locator('[data-published="2"]').waitFor()

      // A review of Revision 1 is refused, on the page and by the server.
      await rhea.reload()
      await rhea.getByRole('heading', { name: 'Revision 1' }).waitFor()
      await rhea.locator('[data-banner="superseded"]').waitFor()
      assert.equal(await rhea.getByRole('button', { name: 'Send your review' }).count(), 0, 'a review can be started on a superseded revision')
      await assert.rejects(() => rpc(rhea, 'SendReview', { reportId, revision: 1, decision: 'approve', commentIds: [] }))

      // Approvals on Revision 2 only: the round is decided by its rule.
      const approve = async (page: Page, revision: number): Promise<void> => {
        await page.goto(`${pilotUrl}/r/${reportId}/rev/${revision}`)
        await page.getByRole('heading', { name: new RegExp(`^Revision ${revision}`) }).waitFor()
        await send(page, /Approve/, 'approve')
      }
      await approve(rhea, 2)
      const ravi = await signedIn(`/r/${reportId}/rev/2`, 'ravi.reviewer@case-desk.test')
      await ravi.getByRole('heading', { name: 'Revision 2' }).waitFor()
      await send(ravi, /Approve/, 'approve')
      await pia.goto(`${pilotUrl}/r/${reportId}`)
      await pia.locator('[data-outcome="decided"]').waitFor()
      await pia.getByRole('heading', { name: 'Revision 2 was approved' }).waitFor()
      assert.equal(await pia.getByRole('link', { name: 'Publish another revision' }).count(), 1)
      await noSideScroll(pia)
      await shot(pia, 'closing-2-decided-375')
      await rhea.reload()
      await rhea.getByText('This round is decided', { exact: false }).waitFor()
      assert.equal(await rhea.getByRole('button', { name: 'Send your review' }).count(), 0, 'a decided round takes a review')

      // The conclusion: asked first, then only the conclusion can be written.
      await pia.getByRole('button', { name: 'Start the conclusion' }).click()
      await pia.getByRole('alertdialog', { name: 'Start the conclusion?' }).waitFor()
      await pia.getByRole('alertdialog', { name: 'Start the conclusion?' }).getByRole('button', { name: 'Start the conclusion' }).click()
      await pia.locator('[data-outcome="concluding"]').waitFor()
      await pia.getByRole('heading', { name: 'The conclusion is being written' }).waitFor()
      await openIn(pia, /^Case details/)
      await pia.getByText('The report is concluding. Only the conclusion can be edited now.', { exact: false }).first().waitFor()
      await shot(pia, 'closing-3-concluding-375')
      const copy = await rpc(pia, 'GetWorkingCopy', { reportId })
      await assert.rejects(() =>
        rpc(pia, 'SaveSection', {
          reportId,
          sectionId: 'case-details',
          saveCounter: copy.saveCounter,
          content: { values: { investigator: { type: 'text', text: 'No.' } }, sections: {} },
        }),
      )
      await saveSection('committee-conclusion', 'conclusion-decision', 'rich_text', 'The committee closed the case without further action.')

      // The closing revision: shared and published in one go.
      await pia.goto(`${pilotUrl}/r/${reportId}/share`)
      await pia.locator('[data-preview="redacted"]').first().waitFor()
      await pia.getByLabel('Publish this draft for review as soon as it is shared').check()
      await pia.getByRole('checkbox', { name: /^Review Committee/ }).check()
      await pia
        .getByRole('button', { name: /^Confirm the redacted version, share as Draft \d+ and publish/ })
        .click()
      await pia.locator('[data-published="3"]').waitFor()
      await approve(rhea, 3)
      await approve(ravi, 3)

      // Archived: read-only everywhere.
      await pia.goto(`${pilotUrl}/r/${reportId}`)
      await pia.getByRole('heading', { name: 'This report is archived' }).waitFor({ timeout: 8000 }).catch(async error => {
        console.log((await pia.locator('main').innerText()).slice(0, 900))
        throw error
      })
      assert.equal(await pia.getByRole('link', { name: /^Share as Draft/ }).count(), 0, 'an archived report offers to share')
      assert.equal(await pia.getByRole('link', { name: 'Publish for review' }).count(), 0)
      await pia.getByText('Archived', { exact: false }).first().waitFor()
      await openIn(pia, /^Case details/)
      await pia.getByText('This report is archived. It can be read, not changed.', { exact: false }).first().waitFor()
      const archivedCopy = await rpc(pia, 'GetWorkingCopy', { reportId })
      await assert.rejects(() =>
        rpc(pia, 'SaveSection', {
          reportId,
          sectionId: 'committee-conclusion',
          saveCounter: archivedCopy.saveCounter,
          content: { values: {}, sections: {} },
        }),
      )
      await rhea.reload()
      await rhea.getByText('This round is decided', { exact: false }).waitFor()
      assert.equal(await rhea.getByRole('button', { name: 'Send your review' }).count(), 0)
      await shot(pia, 'closing-4-archived-375')

      // A co-author who never opened the report reads the archived report from
      // the closing revision's draft, with no working copy of their own.
      const bea = await signedIn(`/r/${reportId}`, 'bea.second@case-desk.test')
      await bea.getByRole('heading', { name: 'This report is archived' }).waitFor({ timeout: 8000 })
      await openIn(bea, /Behaviour committee conclusion/)
      await bea.getByText('The committee closed the case without further action.', { exact: false }).first().waitFor()
      await assert.rejects(() => rpc(bea, 'GetWorkingCopy', { reportId }), 'reading the archived report started a working copy')
      await bea.context().close()

      // The grid at phone and desktop width, and the audit log with its filter.
      await pia.goto(`${pilotUrl}/r/${reportId}/grid`)
      await pia.getByRole('heading', { name: 'Revision 3 (closing), from Draft 3' }).waitFor()
      await pia.getByText('Decided, the approval rule was met').first().waitFor()
      assert.equal(await pia.getByRole('button', { name: 'Extend the deadline' }).count(), 0, 'an archived report offers round actions')
      await shot(pia, 'closing-5-grid-archived-375')
      await pia.setViewportSize({ width: 1280, height: 900 })
      await pia.getByRole('heading', { name: 'Revision 1, from Draft 1' }).waitFor()
      await noSideScroll(pia)
      await shot(pia, 'closing-6-grid-1280')
      await pia.setViewportSize({ width: 375, height: 812 })
      await pia.goto(`${pilotUrl}/r/${reportId}/audit`)
      await pia.getByRole('heading', { name: 'Audit log' }).waitFor()
      await pia.getByText('The deadline was extended').waitFor()
      await pia.getByLabel('Show').selectOption('revision')
      // NOTE: the filter is the server's: the list is replaced by the events of that kind.
      await pia.waitForFunction(() => {
        const rows = [...document.querySelectorAll('[data-audit]')]
        return rows.length > 0 && rows.every(row => (row.getAttribute('data-audit') ?? '').startsWith('revision.'))
      })
      assert.ok((await pia.locator('[data-audit="revision.published"]').count()) === 3, 'three revisions published')
      assert.equal(await pia.locator('[data-audit="round.decided"]').count(), 0, 'the filter shows another kind')
      await noSideScroll(pia)
      await shot(pia, 'closing-7-audit-375')
      await rhea.context().close()
      await ravi.context().close()
    })

    await step('notifications on a phone: /api/tick is guarded, the pass tells the author, the count shows in the navigation, a link opens the report, mark read', async () => {
      const pia = pilotPage
      assert.ok(pia !== undefined, 'no pilot page')
      const tick = (headers: Record<string, string>) =>
        fetch(`${pilotUrl}/api/tick`, { method: 'POST', headers })
      // NOTE: the route does not show itself to anyone without the secret: 404 for every request.
      assert.equal((await tick({})).status, 404)
      assert.equal((await tick({ authorization: 'Bearer wrong' })).status, 404)
      assert.equal((await fetch(`${pilotUrl}/api/tick`)).status, 404)
      const answer = await tick({ authorization: `Bearer ${TICK_SECRET}` })
      assert.equal(answer.status, 200)
      const counts = (await answer.json()) as { queries: number; sent: number }
      assert.ok(counts.queries <= 50, `the pass used ${counts.queries} queries`)
      assert.ok(counts.sent > 0, 'nothing was sent to the author')
      // NOTE: a pass takes only a few jobs (CPU); more passes drain the rest, and
      // then a pass has nothing left to send.
      let last = counts.sent
      for (let pass = 0; pass < 10 && last > 0; pass += 1) {
        const next = (await (await tick({ authorization: `Bearer ${TICK_SECRET}` })).json()) as { sent: number }
        last = next.sent
      }
      assert.equal(last, 0, 'passes kept sending')
      const idle = (await (await tick({ authorization: `Bearer ${TICK_SECRET}` })).json()) as { sent: number }
      assert.equal(idle.sent, 0, 'a pass sent again')

      await pia.goto(`${pilotUrl}/notifications`)
      await pia.getByRole('heading', { name: 'Notifications' }).waitFor()
      await pia.getByText('The review round is decided.').first().waitFor()
      await pia.getByRole('link', { name: /^Notifications \(\d+\)$/ }).waitFor()
      await noSideScroll(pia)
      await shot(pia, 'notifications-375')
      const link = pia.getByRole('link', { name: 'Open: The review round is decided.' }).first()
      assert.match((await link.getAttribute('href')) ?? '', /^\/r\/[^/]+$/)
      await pia.getByRole('button', { name: 'Mark all notifications as read' }).click()
      await pia.getByText('You have read everything.').waitFor()
      await pia.getByRole('link', { name: 'Notifications', exact: true }).waitFor()
      await pia.reload()
      await pia.getByText('You have read everything.').waitFor()
    })

    await step('downloads on a phone: an author gets a revision PDF and the zip of every version, a redacted reviewer gets only the redacted PDF, the browser and Node make the same text, the approval record', async () => {
      const pia = pilotPage
      assert.ok(pia !== undefined, 'no pilot page')
      const openReport = async (reference: string): Promise<string> => {
        const id = reportsByReference[reference]
        assert.ok(id !== undefined, `no report ${reference}`)
        await pia.goto(`${pilotUrl}/r/${id}`)
        await pia.getByRole('heading', { name: 'Intake and initial assessment', level: 1 }).waitFor()
        return id
      }
      // NOTE: a click that starts a download, the file saved in its own folder.
      let downloads = 0
      const saved = async (page: Page, button: string | RegExp): Promise<{ name: string; path: string; bytes: Buffer }> => {
        downloads += 1
        const folder = join(local, `download-${downloads}`)
        mkdirSync(folder, { recursive: true })
        const [file] = await Promise.all([
          page.waitForEvent('download', { timeout: 180_000 }),
          page.getByRole('button', { name: button }).click(),
        ])
        const path = join(folder, file.suggestedFilename())
        await file.saveAs(path)
        return { name: file.suggestedFilename(), path, bytes: readFileSync(path) }
      }
      const textOf = async (bytes: Buffer): Promise<string> =>
        (await extractPages(new Uint8Array(bytes))).join('\n').replace(/\s+/g, ' ')

      const reportId = await openReport('PIL-0007')
      await pia.getByRole('link', { name: 'Downloads', exact: true }).click()
      await pia.getByRole('heading', { name: 'Downloads' }).waitFor()
      await pia.locator('[data-download-version="revision:1"]').waitFor()
      assert.equal(await pia.locator('[data-download-version="revision:1"] button').count(), 2, 'a revision is not offered in both views')
      assert.equal(await pia.locator('[data-download-version^="draft:"] button').first().isVisible(), true)
      await shot(pia, 'downloads-1-list-375')

      // An author downloads Revision 1 as written.
      const revision = await saved(pia, 'Download PDF of Revision 1, original')
      assert.equal(revision.name, 'PIL-0007_intake_Revision-1.pdf')
      assert.equal(revision.bytes.subarray(0, 5).toString('latin1'), '%PDF-')
      const revisionText = await textOf(revision.bytes)
      for (const part of ['Intake and initial assessment', 'PIL-0007', 'Revision 1', 'delay in the supply']) {
        assert.ok(revisionText.includes(part), `the revision PDF lacks "${part}"`)
      }
      assert.ok(!revisionText.includes('Redacted'), 'the original PDF is marked redacted')
      await pia.getByRole('button', { name: 'Download PDF of Revision 1, original' }).waitFor()

      // The same version made in Node from the same data gives the same text.
      const summary = (await rpc(pia, 'GetReport', { reportId })).summary
      const history = await rpc(pia, 'GetHistory', { reportId })
      const list = await rpc(pia, 'GetDownloads', { reportId })
      const version = list.versions.find((item: Json) => item.kind === 'revision' && item.number === 1 && item.view === 'original')
      assert.ok(version !== undefined, 'Revision 1 is not in the downloads')
      const draft = history.revisions.find((item: Json) => item.number === 1).draft
      const { people } = await rpc(pia, 'GetPeople', { reportId, draft })
      const template = (
        await rpc(pia, 'GetTemplateVersion', {
          templateId: summary.templateId,
          version: summary.templateVersion,
          reportId,
        })
      ).template
      const theme = (await rpc(pia, 'GetTheme', null as unknown as Json)).theme
      const sections: Json = {}
      for (const section of [...template.sections, ...(template.conclusion === undefined ? [] : [template.conclusion])]) {
        sections[section.id] = (
          await rpc(pia, 'GetDraftSection', { reportId, draft, sectionId: section.id, view: 'original' })
        ).content
      }
      const job = {
        document: {
          template,
          content: { schemaVersion: 1, templateId: template.id, templateVersion: template.version, sections },
          view: { kind: 'original', people },
          caseFile: { reference: summary.caseFile.reference, unit: '', title: summary.caseFile.title },
          theme,
          version: {
            reportName: summary.templateName,
            versionLabel: version.label,
            date: new Date(version.at).toISOString().slice(0, 10),
          },
          // The report is not concluding: the conclusion appears only with content.
          ...(['concluding', 'archived'].includes(summary.state) ? { includeConclusion: true } : {}),
        },
      }
      writeFileSync(join(local, 'node-job.json'), JSON.stringify(job))
      const rendered = spawnSync(
        'node',
        [join(root, 'packages/pdf/scripts/render.mjs'), join(local, 'node-job.json'), join(local, 'node.pdf')],
        { encoding: 'utf8' },
      )
      assert.equal(rendered.status, 0, rendered.stderr)
      const inBrowser = await extractPages(new Uint8Array(revision.bytes))
      const inNode = await extractPages(new Uint8Array(readFileSync(join(local, 'node.pdf'))))
      assert.deepEqual(inBrowser, inNode, 'the browser and Node PDFs read differently')

      // A report still being drafted has no conclusion: a PDF of it has none
      // (an empty section must not print a heading, and the derived colours
      // of the theme must leave the page readable).
      assert.equal(summary.state === 'concluding' || summary.state === 'archived', false, 'the report is already concluding')
      assert.ok(template.conclusion !== undefined, 'the template has no conclusion to leave out')
      const conclusionContent = await rpc(pia, 'GetDraftSection', { reportId, draft, sectionId: template.conclusion.id, view: 'original' })
      assert.deepEqual(conclusionContent.content.values, {}, 'the conclusion of a drafting report has content')
      assert.ok(!revisionText.includes(template.conclusion.title), 'a drafting report\'s PDF prints the empty conclusion')
      const draftPdf = await saved(pia, `Download PDF of Draft ${draft}, original`)
      assert.ok(!(await textOf(draftPdf.bytes)).includes(template.conclusion.title), 'a drafting report\'s draft PDF prints the empty conclusion')

      // Download all: one zip of every draft and revision, original and redacted.
      const zip = await saved(pia, 'Download all drafts, revisions and approval records as one zip')
      assert.equal(zip.name, 'PIL-0007_intake_all-versions.zip')
      const tested = spawnSync('unzip', ['-tq', zip.path], { encoding: 'utf8' })
      assert.equal(tested.status, 0, tested.stdout + tested.stderr)
      const entries = spawnSync('unzip', ['-Z1', zip.path], { encoding: 'utf8' }).stdout.split('\n').filter(line => line !== '')
      for (const name of [
        'PIL-0007_intake_Draft-1.pdf',
        'PIL-0007_intake_Draft-1_redacted.pdf',
        'PIL-0007_intake_Revision-1.pdf',
        'PIL-0007_intake_Revision-1_redacted.pdf',
      ]) {
        assert.ok(entries.includes(name), `the zip lacks ${name}: ${entries.join(', ')}`)
      }
      assert.ok(entries.every(name => name.endsWith('.pdf')), `the zip holds something else: ${entries.join(', ')}`)
      assert.equal(new Set(entries).size, entries.length, 'the zip repeats a name')
      for (const name of entries) {
        const file = spawnSync('unzip', ['-p', zip.path, name], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
        assert.equal(file.stdout.subarray(0, 5).toString('latin1'), '%PDF-', `${name} is not a PDF`)
      }
      const redactedInZip = spawnSync('unzip', ['-p', zip.path, 'PIL-0007_intake_Revision-1_redacted.pdf'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).stdout
      assert.ok((await textOf(redactedInZip)).includes('Redacted'), 'the redacted PDF in the zip is not marked')
      await noSideScroll(pia)

      // A redacted reviewer gets the redacted PDF and nothing else.
      const rhea = await person(launched)
      await rhea.goto(`${pilotUrl}/r/${reportId}/rev/1`)
      await rhea.getByRole('heading', { name: 'Sign in' }).waitFor()
      await rhea.getByLabel('E-mail').fill('rhea.reviewer@case-desk.test')
      await rhea.getByLabel('Password', { exact: true }).fill(PASSWORD)
      await rhea.getByRole('button', { name: 'Sign in' }).click()
      await rhea.getByRole('heading', { name: 'Revision 1' }).waitFor()
      // NOTE: the heading is also shown while the revision is loading, with no
      // button yet; the button count is only meaningful once it has been read.
      await rhea.locator('[data-reading="true"]').waitFor()
      await rhea.getByRole('button', { name: /^Download PDF/ }).first().waitFor()
      assert.equal(await rhea.getByRole('button', { name: /^Download PDF/ }).count(), 1, 'a reviewer is offered more than one PDF')
      await shot(rhea, 'downloads-2-reviewer-375')
      const redacted = await saved(rhea, 'Download PDF of Revision 1')
      assert.equal(redacted.name, 'PIL-0007_intake_Revision-1_redacted.pdf')
      const redactedText = await textOf(redacted.bytes)
      assert.ok(redactedText.includes('Redacted'), 'the reviewer PDF is not marked redacted')
      assert.ok(redactedText.includes('delay in the supply'), 'the reviewer PDF lacks the text')
      await assert.rejects(
        rpc(rhea, 'GetDraftSection', { reportId, draft, sectionId: 'case-details', view: 'original' }),
        'a reviewer read the original',
      )
      await assert.rejects(rpc(rhea, 'GetDownloads', { reportId }), 'a reviewer listed the downloads')
      await rhea.context().close()

      // The approval record of a decided round.
      await openReport('PIL-0008')
      await pia.getByRole('link', { name: 'Downloads', exact: true }).click()
      await pia.getByRole('heading', { name: 'Downloads' }).waitFor()
      const record = await saved(pia, 'Download the approval record PDF')
      assert.equal(record.name, 'PIL-0008_intake_approval-record.pdf')
      assert.ok((await textOf(record.bytes)).includes('Approval record'), 'the approval record PDF has no title')
      await shot(pia, 'downloads-3-approval-record-375')
    })

    // NOTE: Stage 9, at 1280 px: a template editor copies the intake template,
    // adds a section and a choice with an ending, meets a validation error next
    // to its row, fixes it, previews and publishes after the differences; an
    // author then starts a report from the new version. At 375 px the list
    // opens without sideways scrolling. The pilot script's short run of a
    // published template is covered in stage 10.
    await step('a template editor copies the intake template, adds a section and an ending choice, fixes a validation error, previews and publishes; an author starts a report from the new version', async () => {
      const pia = pilotPage
      assert.ok(pia !== undefined, 'no pilot page')
      await pia.goto(`${pilotUrl}/admin`)
      await pia.getByRole('heading', { name: 'Administration' }).waitFor()
      await pia.getByLabel('E-mail', { exact: true }).fill('pia.pilot@case-desk.test')
      await pia.getByLabel('Name', { exact: true }).fill('Pia Pilot')
      await pia.getByLabel('Capability', { exact: true }).selectOption('template_editor')
      await pia.getByRole('button', { name: 'Give capability' }).click()
      await pia.waitForFunction(() => /Template editor\s*Remove/.test(document.body.innerText))

      await pia.setViewportSize({ width: 1280, height: 900 })
      await pia.goto(`${pilotUrl}/templates`)
      await pia.getByRole('heading', { name: 'Templates', level: 1 }).waitFor()
      await shot(pia, 'templates-1-list-1280')
      await pia.getByLabel('Template to copy', { exact: true }).selectOption({ label: 'Intake and initial assessment' })
      await pia.getByLabel('Name of the copy', { exact: true }).fill('Pilot intake with a screening')
      await pia.getByRole('button', { name: 'Copy into a new draft' }).click()
      await pia.getByRole('link', { name: 'Open the draft' }).click()
      await pia.getByRole('heading', { name: 'Edit Pilot intake with a screening', level: 1 }).waitFor()
      await shot(pia, 'templates-2-editor-1280')

      // A section, left without a title: the problem is shown by its row.
      await pia.getByRole('button', { name: 'Add a section', exact: true }).first().click()
      const section = pia.locator('[data-section-id="section-1"]')
      await section.waitFor()
      await section.locator('[id^="new-item-type-"]').selectOption('select')
      await section.getByRole('button', { name: /^Add an item to/ }).click()
      const item = section.locator('[data-item-id]').last()
      await item.locator('[id^="item-"][id$="-label"]').first().fill('Screening result')
      await item.getByRole('button', { name: /^Add an option to/ }).click()
      await item.locator('[id^="option-"][id$="-label"]').first().fill('Out of scope')
      await item.locator('[id^="option-"][id$="-end"]').first().check()
      await section.locator('[id^="section-"][id$="-title"]').fill('')
      await section.locator('[data-problems="here"]').first().waitFor()
      assert.ok(
        (await pia.getByText(/things? needs? fixing before this can be published/).count()) > 0,
        'no problem count is shown',
      )
      await shot(pia, 'templates-3-problem-1280')
      await pia.getByRole('button', { name: /^Publish version 1$/ }).click()
      assert.equal(await pia.getByRole('region', { name: 'Publish this version' }).count(), 0, 'a template with problems was offered for publishing')

      await section.locator('[id^="section-"][id$="-title"]').fill('Screening')
      await pia.getByText('Nothing is marked: this can be published.').waitFor()
      await pia.getByRole('button', { name: 'Preview', exact: true }).click()
      await pia.getByRole('region', { name: 'Preview of a new report' }).waitFor()
      await pia.getByRole('region', { name: 'Preview of a new report' }).getByText('Screening').first().waitFor()
      await shot(pia, 'templates-4-preview-1280')
      await pia.getByRole('button', { name: 'Back to editing' }).click()

      await pia.getByRole('button', { name: /^Publish version 1$/ }).click()
      const confirm = pia.getByRole('region', { name: 'Publish this version' })
      await confirm.waitFor()
      await confirm.getByRole('list', { name: 'Changes since the previous version' }).waitFor()
      await shot(pia, 'templates-5-confirm-1280')
      await confirm.getByRole('button', { name: 'Publish version 1' }).click()
      await pia.getByText(/Published, version 1\./).first().waitFor()
      await shot(pia, 'templates-6-published-1280')

      // An author starts a report from the new version (Pia is also an author).
      await pia.goto(`${pilotUrl}/reports`)
      await pia.getByRole('heading', { name: 'Start a report' }).waitFor()
      await pia
        .getByLabel('Template', { exact: true })
        .selectOption({ label: 'Pilot intake with a screening (version 1)' })
      await pia.getByLabel('Integrity Line reference', { exact: true }).fill('PIL-0101')
      await pia.getByLabel('Case file title', { exact: true }).fill('Synthetic case file for the new template')
      await pia.getByRole('button', { name: 'Create report' }).click()
      await pia.getByRole('link', { name: 'Open report PIL-0101' }).click()
      await pia.getByRole('heading', { name: 'Pilot intake with a screening', level: 1 }).waitFor()
      await shot(pia, 'templates-7-report-1280')

      // At 375 px the list opens without sideways scrolling.
      await pia.setViewportSize({ width: 375, height: 812 })
      await pia.goto(`${pilotUrl}/templates`)
      await pia.getByRole('heading', { name: 'Templates', level: 1 }).waitFor()
      await pia.getByText('Pilot intake with a screening').first().waitFor()
      await shot(pia, 'templates-8-list-375')
    })

    // NOTE: Stage 9d: an administrator sets the theme. At 375 px: uploads a
    // synthetic logo, types a colour that is unreadable and meets the refusal,
    // fixes it, changes the PDF footer, looks at the sample PDF, saves; the app
    // shows the new organisation name and colour with no reload. At 1280 px the
    // saved theme is read back, and an author downloads a PDF whose text has the
    // new cover texts and which embeds the logo. The intake template sets its own
    // header and footer, which replace the theme's, but not its cover texts, so
    // the theme's cover header and footer are the ones printed on its cover.
    await step('the theme on a phone: a logo, an unreadable colour is refused, the fix and a new footer are saved, the app shows the name and colour, and the next PDF has the footer and the logo', async () => {
      const pia = pilotPage
      assert.ok(pia !== undefined, 'no pilot page')
      await pia.setViewportSize({ width: 375, height: 812 })
      const hasImage = (bytes: Buffer): boolean => /\/Subtype\s*\/Image/.test(bytes.toString('latin1'))
      const textOf = async (bytes: Buffer): Promise<string> =>
        (await extractPages(new Uint8Array(bytes))).join('\n').replace(/\s+/g, ' ')
      let downloads = 0
      const downloadRevision = async (): Promise<Buffer> => {
        const id = reportsByReference['PIL-0007']
        assert.ok(id !== undefined, 'no report PIL-0007')
        await pia.goto(`${pilotUrl}/r/${id}/downloads`)
        await pia.getByRole('heading', { name: 'Downloads' }).waitFor()
        await pia.locator('[data-download-version="revision:1"]').waitFor()
        downloads += 1
        const [file] = await Promise.all([
          pia.waitForEvent('download', { timeout: 180_000 }),
          pia.getByRole('button', { name: 'Download PDF of Revision 1, original' }).click(),
        ])
        const path = join(local, `theme-download-${downloads}.pdf`)
        await file.saveAs(path)
        return readFileSync(path)
      }

      // A PDF made before the theme is set: default footer, no image.
      const before = await downloadRevision()
      assert.ok(!hasImage(before), 'a PDF with no logo embeds an image')
      assert.ok(!(await textOf(before)).includes('Confidential synthetic footer'), 'the footer is there before it is set')

      await pia.goto(`${pilotUrl}/theme`)
      await pia.getByRole('heading', { name: 'Theme', level: 1 }).waitFor()
      await pia.getByLabel('Organisation name', { exact: true }).waitFor()
      await shot(pia, 'theme-1-open-375')

      // The logo: a synthetic picture, prepared and sent by the browser.
      const logoPath = join(local, 'synthetic-logo.png')
      writeFileSync(logoPath, Buffer.from(await syntheticImage(pia, { width: 480, height: 160, kind: 'transparent', quality: 0.9 }), 'base64'))
      await pia.setInputFiles('#theme-logo-file', logoPath)
      await pia.locator('[data-theme-logo]').waitFor({ timeout: 60_000 })
      assert.equal(await pia.getByRole('alert').filter({ hasText: /logo|picture/i }).count(), 0, 'the logo was refused')

      // A low-contrast colour: shown beside the colour, and the save is refused.
      await pia.getByLabel('Organisation name', { exact: true }).fill('Invented Organisation')
      await pia.getByLabel('Text colour', { exact: true }).fill('#cccccc')
      const beside = pia.locator('[data-theme-colour="text"] [data-theme-problem="colors.text"]')
      await beside.waitFor()
      assert.match((await beside.textContent()) ?? '', /contrast/)
      await pia.getByRole('button', { name: 'Save the theme' }).click()
      await pia.getByText(/The theme was not saved: 1 problem/).waitFor()
      await shot(pia, 'theme-2-refused-375')
      const stored = (await rpc(pia, 'GetTheme', null as unknown as Json)).theme
      assert.notEqual(stored.organisationName, 'Invented Organisation', 'an unreadable theme was stored')
      assert.notEqual(stored.colors.text, '#cccccc')
      assert.equal(
        (await pia.evaluate(() => (document.querySelector('#quoroom-root') as HTMLElement | null)?.style.getPropertyValue('--color-msf-black'))) === '#cccccc',
        false,
        'the app applied an unreadable colour',
      )
      // The server refuses it too, whatever the page does.
      await assert.rejects(
        rpc(pia, 'UpdateTheme', { theme: { ...stored, colors: { ...stored.colors, text: '#cccccc' } } }),
        'the server accepted an unreadable theme',
      )

      // The fix, a new primary colour, a font and the PDF texts.
      await pia.getByLabel('Text colour', { exact: true }).fill('#202020')
      await beside.waitFor({ state: 'detached' })
      await pia.getByLabel('Primary colour', { exact: true }).fill('#0b5d3b')
      await pia.getByLabel('Heading font', { exact: true }).selectOption('Source Serif 4')
      await pia.getByLabel('Header text', { exact: true }).fill('STRICTLY CONFIDENTIAL (synthetic)')
      await pia.getByLabel('Footer text', { exact: true }).fill('Confidential synthetic footer {case} page {page} of {pages}')
      await pia.getByLabel('Cover page header text', { exact: true }).fill('COVER HEADER (synthetic)')
      await pia.getByLabel('Cover page footer text', { exact: true }).fill('Cover footer {case} (synthetic)')
      await pia.getByRole('region', { name: 'Preview of an app page' }).getByText('Invented Organisation').waitFor()

      // The sample PDF is made from the theme as typed, lazily.
      await pia.getByRole('button', { name: 'Show a sample PDF' }).click()
      const frame = pia.locator('iframe[data-sample-pdf]')
      await frame.waitFor({ timeout: 120_000 })
      const sample = async (): Promise<Buffer> =>
        Buffer.from(
          await pia.evaluate(async src => Array.from(new Uint8Array(await (await fetch(src)).arrayBuffer())), (await frame.getAttribute('src')) ?? ''),
        )
      const preview = await sample()
      assert.equal(preview.subarray(0, 5).toString('latin1'), '%PDF-')
      assert.ok(hasImage(preview), 'the sample PDF does not show the logo')
      const previewText = await textOf(preview)
      assert.ok(previewText.includes('STRICTLY CONFIDENTIAL (synthetic)'), 'the sample PDF lacks the header')
      assert.ok(previewText.includes('Confidential synthetic footer SAMPLE-0001'), 'the sample PDF lacks the footer')
      await shot(pia, 'theme-3-preview-375')

      // Save: the app takes the name and the colour without a reload.
      await pia.evaluate(() => {
        ;(window as unknown as { __kept: boolean }).__kept = true
      })
      // NOTE: the sample PDF may still be settling and move the button; a click
      // that did not take is made again (saving twice is harmless).
      const savedNotice = pia.getByText('The theme is saved. The app and the next PDF use it.')
      for (let attempt = 0; attempt < 4 && !(await savedNotice.isVisible()); attempt += 1) {
        await pia.getByRole('button', { name: 'Save the theme' }).click()
        await savedNotice.waitFor({ timeout: 8000 }).catch(() => undefined)
      }
      await savedNotice.waitFor({ timeout: 5000 }).catch(async (error: unknown) => {
        await shot(pia, 'theme-save-failed')
        throw error
      })
      assert.equal(await pia.evaluate(() => (window as unknown as { __kept?: boolean }).__kept), true, 'the page was reloaded')
      await pia.getByText('Invented Organisation', { exact: true }).first().waitFor()
      assert.equal(
        await pia.evaluate(() => (document.querySelector('#quoroom-root') as HTMLElement | null)?.style.getPropertyValue('--color-msf-red')),
        '#0b5d3b',
      )
      await pia.getByRole('img', { name: 'Invented Organisation logo' }).waitFor()
      await shot(pia, 'theme-4-saved-375')

      // What the server keeps and serves.
      const saved = (await rpc(pia, 'GetTheme', null as unknown as Json)).theme
      assert.equal(saved.organisationName, 'Invented Organisation')
      assert.equal(saved.pdf.footer, 'Confidential synthetic footer {case} page {page} of {pages}')
      assert.equal(typeof saved.logo, 'string')
      const config = (await (await fetch(`${pilotUrl}/api/config`)).json()) as Json
      assert.equal(config.theme.organisationName, 'Invented Organisation')
      assert.equal(config.theme.colors.primary, '#0b5d3b')
      assert.equal(config.theme.pdf, undefined, 'the PDF texts are public')
      assert.equal(config.logo.id, saved.logo)
      const anonymous = await fetch(`${pilotUrl}/api/images/${saved.logo}/0?context=theme`)
      assert.equal(anonymous.status, 404, 'the logo is served without a session')
      // 1280 px: the saved theme is read back after a reload, with the logo.
      await pia.setViewportSize({ width: 1280, height: 900 })
      await pia.goto(`${pilotUrl}/theme`)
      await pia.getByRole('heading', { name: 'Theme', level: 1 }).waitFor()
      assert.equal(await pia.getByLabel('Organisation name', { exact: true }).inputValue(), 'Invented Organisation')
      assert.equal(await pia.getByLabel('Primary colour', { exact: true }).inputValue(), '#0b5d3b')
      assert.equal(await pia.getByLabel('Footer text', { exact: true }).inputValue(), 'Confidential synthetic footer {case} page {page} of {pages}')
      // NOTE: /api/config is cached for 30 s, so the wordmark of a fresh load may still be the old one for a moment; the screen reads the theme itself.
      await pia.locator('[data-theme-logo]').waitFor({ timeout: 60_000 })
      await shot(pia, 'theme-5-reloaded-1280')

      // The next PDF: the new header and footer in its text, and the logo in it.
      const after = await downloadRevision()
      const afterText = await textOf(after)
      assert.ok(afterText.includes('COVER HEADER (synthetic)'), 'the next PDF lacks the new cover header')
      assert.ok(afterText.includes('Cover footer PIL-0007 (synthetic)'), 'the next PDF lacks the new cover footer')
      assert.ok(hasImage(after), 'the next PDF does not embed the logo')
      await shot(pia, 'theme-6-downloads-1280')
    })
  } finally {
    await browser?.close()
    stop(server)
    stop(pilotServer)
    rmSync(local, { recursive: true, force: true })
  }

  const failed = results.filter(result => !result.ok)
  console.log(`${results.length - failed.length} of ${results.length} steps passed. Screenshots: ${shots}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

await main()
