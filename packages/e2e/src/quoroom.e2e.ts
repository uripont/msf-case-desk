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
  return context.newPage()
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

const main = async (): Promise<void> => {
  mkdirSync(shots, { recursive: true })
  const local = mkdtempSync(join(tmpdir(), 'quoroom-e2e-'))
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  let server: ChildProcess | undefined
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
    server = spawn(
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
        `data=${join(local, 'data')}`,
        '--socket-addr',
        `http=127.0.0.1:${port}`,
        '--experimental',
      ],
      { cwd: root, stdio: 'ignore' },
    )
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
      await admin.getByRole('button', { name: 'Administration' }).click()
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
        ana.getByRole('button', { name: 'Administration' }).waitFor({ timeout: 500 }),
      )
      await ana.getByRole('button', { name: 'My unit' }).click()
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
      await rae.getByRole('button', { name: 'My account' }).click()
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
      await ben.getByRole('button', { name: 'My account' }).click()
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
  } finally {
    await browser?.close()
    server?.kill('SIGTERM')
    rmSync(local, { recursive: true, force: true })
  }

  const failed = results.filter(result => !result.ok)
  console.log(`${results.length - failed.length} of ${results.length} steps passed. Screenshots: ${shots}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

await main()
