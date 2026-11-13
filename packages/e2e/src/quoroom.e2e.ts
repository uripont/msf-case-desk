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
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type Browser, type Page, chromium } from 'playwright-core'

const root = join(import.meta.dirname, '../../..')
const shots = process.env.E2E_SHOTS ?? '/tmp/quoroom-e2e-screens'
const chromePath = process.env.E2E_CHROMIUM ?? '/usr/bin/chromium'
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
      await member.click()
      for (let attempt = 0; attempt < 40 && !(await member.isChecked()); attempt += 1) {
        await ana.waitForTimeout(250)
      }
      assert.ok(await member.isChecked(), 'the member was not added')
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
      await visitor.getByText('Revision 2 of report syn-1').waitFor()
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
      pilotServer = startWorkerd(pilotPort, pilotData, { RUNTIME_MODE: 'pilot' })
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
