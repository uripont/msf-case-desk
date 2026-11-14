// The pilot script (docs/pilot.md, section 3, steps 1 to 11) as a
// real user runs it: only through the web UI, in Chromium, with seven invented
// people, the reviewers at phone width. Run it against a fresh pilot target
// whose first administrator was granted with `pnpm grant-admin` (docs/pilot.md):
//
//   pnpm rehearsal <base> --admin-link-file <file> [--tick-secret-file <file>]
//
// <base> is a local workerd (`pnpm workerd --mode pilot`) or a test Worker of
// the pilot stack (https://test-<name>-pilot.<subdomain>.workers.dev), never
// anything else. With --tick-secret-file the script calls /api/tick to move
// notifications along (workerd); without it, it waits for the Cron Trigger.
// Reminders need short timings: `--fast` on a test environment, or
// NOTIFY_FIRST_REMINDER_MINUTES=10 NOTIFY_FINAL_REMINDER_MINUTES=3 on workerd.
// It takes about 25 minutes, mostly waiting for reminders and a deadline.
// Screenshots go to E2E_SHOTS (default /tmp/quoroom-rehearsal). Everything is
// synthetic; the link and the secret are read from files and never printed.
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { type Page, chromium } from 'playwright-core'

import {
  activate,
  copiedLink,
  ensureChecked,
  noSideScroll,
  openIn,
  person,
  reportIdOf,
  results,
  selectPhrase,
  settled,
  shot,
  step,
  syntheticImage,
} from './helpers.ts'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    'admin-link-file': { type: 'string' },
    'tick-secret-file': { type: 'string' },
  },
})
const base = (positionals[0] ?? '').replace(/\/$/, '')
if (
  !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base) &&
  !/^https:\/\/test-[a-z0-9]+-pilot\.[a-z0-9-]+\.workers\.dev$/.test(base)
) {
  console.error('Usage: pnpm rehearsal <local workerd or test Worker address> --admin-link-file <file> [--tick-secret-file <file>]')
  process.exit(2)
}
const adminLink = (readFileSync(values['admin-link-file'] ?? '', 'utf8').split('\n').find(line => line.includes('/link#')) ?? '').trim()
assert.ok(adminLink.startsWith(`${base}/link#`), 'the link file has no activation link for this address')
const tickSecret = values['tick-secret-file'] === undefined ? undefined : readFileSync(values['tick-secret-file'], 'utf8').trim()
process.env.E2E_SHOTS ??= '/tmp/quoroom-rehearsal'
mkdirSync(process.env.E2E_SHOTS, { recursive: true })
const downloads = mkdtempSync(join(tmpdir(), 'quoroom-rehearsal-'))

// NOTE: invented people, one browser context each.
const at = (name: string) => `${name.toLowerCase().replace(' ', '.')}@example.org`
const A = 'Alma Ortega'
const B = 'Bruno Keller'
const R1 = 'Rosa Lind'
const R2 = 'Ravi Moreau'
const R3 = 'Rina Tal'
const OB = 'Oskar Vale'
const CH = 'Chiara Neri'
const COMMITTEE = 'Ethics Committee'
const START = Date.now()
const elapsed = () => `${Math.round((Date.now() - START) / 60_000)} min`

// ---- Small actions of a person --------------------------------------------

const go = async (page: Page, path: string, heading: string | RegExp): Promise<void> => {
  await page.goto(`${base}${path}`)
  await page.getByRole('heading', { name: heading }).first().waitFor()
}

const tick = async (): Promise<void> => {
  if (tickSecret === undefined) return
  for (let pass = 0; pass < 6; pass += 1) {
    const answer: Response = await fetch(`${base}/api/tick`, { method: 'POST', headers: { authorization: `Bearer ${tickSecret}` } })
    assert.equal(answer.status, 200, 'the tick was refused')
    if (((await answer.json()) as { sent: number }).sent === 0) return
  }
}

// NOTE: a person's notifications of one kind about one report, read from the
// Notifications screen. The cron (or a tick) delivers them; the first cron of
// a new Worker can take several minutes.
const notifications = async (page: Page, kind: string, reportId: string): Promise<number> => {
  await tick()
  await go(page, '/notifications', 'Notifications')
  await page.getByRole('button', { name: 'Mark all notifications as read' }).or(page.getByText('You have read everything.')).or(page.getByText(/^Nothing yet\./)).first().waitFor()
  return page.locator(`[data-kind="${kind}"]:has(a[href^="/r/${reportId}"])`).count()
}
const waitForNotice = async (page: Page, kind: string, reportId: string, minutes = 12): Promise<void> => {
  const until = Date.now() + minutes * 60_000
  while ((await notifications(page, kind, reportId)) === 0) {
    assert.ok(Date.now() < until, `no ${kind} notification after ${minutes} min`)
    await page.waitForTimeout(20_000)
  }
}

const newReport = async (page: Page, template: string, reference: string, title: string): Promise<string> => {
  await go(page, '/reports', 'Start a report')
  await page.getByLabel('Template', { exact: true }).selectOption({ label: template })
  await page.getByLabel(/reference/i).first().fill(reference)
  await page.getByLabel('Case file title', { exact: true }).fill(title)
  await page.getByRole('button', { name: 'Create report' }).click()
  await page.getByRole('link', { name: `Open report ${reference}` }).click()
  await page.getByRole('heading', { level: 1 }).first().waitFor()
  await page.getByText(/Saved at \d\d:\d\d|Your working copy/).first().waitFor()
  return reportIdOf(page)
}

const typeIn = async (page: Page, label: string, text: string): Promise<void> => {
  await page.getByRole('textbox', { name: label, exact: true }).first().fill(text)
  await settled(page)
}

// NOTE: the deadline is typed as the reviewer's own clock shows it, in the
// browser's zone (the form's default).
const setDeadline = async (page: Page, minutes: number): Promise<void> => {
  const { date, time } = await page.evaluate(ahead => {
    const d = new Date(Date.now() + ahead * 60_000)
    const two = (n: number) => String(n).padStart(2, '0')
    return { date: `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`, time: `${two(d.getHours())}:${two(d.getMinutes())}` }
  }, minutes)
  await page.locator('#publish-date').fill(date)
  await page.locator('#publish-time').fill(time)
}

// NOTE: share the working copy as a draft and publish it to the committee
// (or to the people given per role), on the share screen.
const shareAndPublish = async (
  page: Page,
  reportId: string,
  revision: number,
  minutes: number,
  choose: (page: Page) => Promise<void> = p => p.getByRole('checkbox', { name: new RegExp(`^${COMMITTEE}`) }).check(),
): Promise<void> => {
  await page.goto(`${base}/r/${reportId}/share`)
  await page.locator('[data-preview="redacted"]').first().waitFor()
  await page.getByLabel('Publish this draft for review as soon as it is shared').check()
  await choose(page)
  await setDeadline(page, minutes)
  await shot(page, `publish-${reportId.slice(0, 6)}-rev${revision}`)
  await page.getByRole('button', { name: /^Confirm the redacted version, share as Draft \d+ and publish/ }).click()
  await page.locator(`[data-published="${revision}"]`).waitFor()
}

const review = async (page: Page, reportId: string, revision: number, decision: RegExp, sent: string): Promise<void> => {
  await go(page, `/r/${reportId}/rev/${revision}`, new RegExp(`^Revision ${revision}`))
  await page.locator('[data-reading="true"]').waitFor()
  await page.getByRole('button', { name: 'Send your review' }).click()
  await page.getByRole('radio', { name: decision }).check()
  await page.getByRole('button', { name: 'Confirm and send review' }).click()
  await page.locator(`[data-review-sent="${sent}"]`).waitFor()
}

const commentOnSection = async (page: Page, text: string, toCommittee: boolean): Promise<void> => {
  await page.getByRole('button', { name: 'Comment on this section' }).first().click()
  await page.getByRole('textbox', { name: 'Your comment' }).fill(text)
  if (toCommittee) await page.getByRole('radio', { name: /The whole committee/ }).check()
  await page.getByRole('button', { name: 'Add comment' }).click()
  await page.getByText(text).first().waitFor()
}

const download = async (page: Page, button: string | RegExp): Promise<string> => {
  const [file] = await Promise.all([page.waitForEvent('download', { timeout: 180_000 }), page.getByRole('button', { name: button }).click()])
  const path = join(downloads, file.suggestedFilename())
  await file.saveAs(path)
  return path
}

// ---- The script --------------------------------------------------------------

const main = async (): Promise<void> => {
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? '/usr/bin/chromium', args: ['--no-sandbox'] })
  const links: Record<string, string> = {}
  const pages: Record<string, Page> = {}
  const who = (name: string): Page => {
    const page = pages[name]
    assert.ok(page !== undefined, `${name} has no browser`)
    return page
  }
  const ids = { intake: '', investigation: '', deadline: '', panel: '', rev2At: 0 }
  const a = await person(browser, 1280)
  const steps: Array<[string, () => Promise<void>]> = [
    ['1. A activates, sets the theme, creates a unit, grants author to A and B', async () => {
      await activate(a, adminLink, 'a')
      await go(a, '/theme', 'Theme')
      await a.getByLabel('Organisation name', { exact: true }).fill('Invented Relief Network')
      await a.setInputFiles('#theme-logo-file', {
        name: 'invented-logo.png',
        mimeType: 'image/png',
        buffer: Buffer.from(await syntheticImage(a, { width: 480, height: 160, kind: 'transparent', quality: 0.9 }), 'base64'),
      })
      await a.locator('[data-theme-logo]').waitFor({ timeout: 60_000 })
      await a.getByLabel('Primary colour', { exact: true }).fill('#1b5e4a')
      await a.getByLabel('Accent colour', { exact: true }).fill('#8a3b12')
      await a.getByRole('button', { name: 'Save the theme' }).click()
      await a.getByText('The theme is saved. The app and the next PDF use it.').waitFor()
      await a.getByRole('img', { name: 'Invented Relief Network logo' }).waitFor()
      await shot(a, 'step1-theme')
      await go(a, '/admin', 'Administration')
      await a.getByLabel('Unit name').fill('Invented Ethics Unit')
      await a.getByLabel('Unit code').fill('IEU')
      await a.getByRole('button', { name: 'Create unit' }).click()
      await a.getByRole('list', { name: 'Units' }).getByText('Invented Ethics Unit').waitFor()
      for (const name of [A, B]) {
        await a.getByLabel('E-mail', { exact: true }).fill(at(name))
        await a.getByLabel('Name', { exact: true }).fill(name)
        await a.getByLabel('Capability', { exact: true }).selectOption('author')
        await a.getByLabel('Unit', { exact: true }).selectOption({ label: 'Invented Ethics Unit (IEU)' })
        await a.getByRole('button', { name: 'Give capability' }).click()
        if (name === B) links[B] = await copiedLink(a)
        else await a.getByText(`${A} already had an account, so no link was made.`).waitFor()
      }
      await a.getByText('Author in Invented Ethics Unit').nth(1).waitFor()
      await shot(a, 'step1-admin')
    }],
    ['2. A registers R1 and R2 in a committee; B, R1 and R2 activate (R1 at phone width)', async () => {
      await go(a, '/unit', 'My unit')
      for (const [name, phone] of [[R1, '+34 600 111 222'], [R2, '']] as const) {
        await a.getByLabel('Reviewer name').fill(name)
        await a.getByLabel('Reviewer e-mail').fill(at(name))
        if (phone !== '') {
          await a.getByLabel('Reviewer phone number').fill(phone)
          await a.getByLabel('Ask for WhatsApp consent').check()
        }
        await a.getByRole('button', { name: 'Register reviewer' }).click()
        links[name] = await copiedLink(a)
      }
      await a.getByLabel('Committee name').fill(COMMITTEE)
      await a.getByRole('button', { name: 'Create committee' }).click()
      await a.getByRole('heading', { name: COMMITTEE }).waitFor()
      for (const name of [R1, R2]) await ensureChecked(a.getByLabel(`${name} in ${COMMITTEE}`), `${name} was not added`)
      await shot(a, 'step2-unit')
      for (const name of [B, R1, R2]) {
        pages[name] = await person(browser, name === R1 ? 375 : 1280)
        await activate(who(name), links[name] ?? '', name.split(' ')[0]?.toLowerCase() ?? '')
      }
      const r1 = who(R1)
      await go(r1, '/account', 'Your account')
      await r1.getByLabel('Phone number').fill('+34 600 111 222')
      await r1.getByLabel('I agree to receive messages from Quoroom on WhatsApp at this number').check()
      await r1.getByRole('button', { name: 'Save preferences' }).click()
      await r1.getByText('Saved.').waitFor()
      await shot(r1, 'step2-r1-consent')
    }],
    ['3. A creates a case file and an intake report, adds B; each starts a working copy and sees the other', async () => {
      const b = who(B)
      ids.intake = await newReport(a, 'Intake and initial assessment (version 1)', 'IEU-2026-001', 'Invented intake case file')
      await a.locator('#co-author-choice').selectOption({ label: B })
      await a.getByRole('button', { name: 'Add co-author' }).click()
      await a.getByText(B).first().waitFor()
      await go(b, `/r/${ids.intake}`, 'Intake and initial assessment')
      await b.getByText(/Saved at \d\d:\d\d|Your working copy/).first().waitFor()
      await a.reload()
      await a.getByText(new RegExp(`${B} is working from Draft 0`)).waitFor()
      await b.reload()
      await b.getByText(new RegExp(`${A} is working from Draft 0`)).waitFor()
      await shot(b, 'step3-b-sees-a')
    }],
    ['4. A writes (table, image, not applicable, allegation) and shares Draft 1; B merges, resolves, comments, shares Draft 2', async () => {
      const b = who(B)
      await typeIn(a, 'Investigator', 'Zorana Veltkamp, with the field coordinator')
      await openIn(a, /Summary of the complaint/)
      const summary = a.getByRole('textbox', { name: 'Summary' })
      await summary.click()
      await a.keyboard.type('Bertil Nwosu reported a delay in the supply of water at the invented camp.')
      await a.keyboard.press('Enter')
      await a.getByRole('button', { name: 'Insert table', exact: true }).click()
      for (const cell of ['Date', 'Event', 'Source', '3 March', 'Report filed']) {
        await a.keyboard.type(cell)
        await a.keyboard.press('Tab')
      }
      const [chooser] = await Promise.all([a.waitForEvent('filechooser'), a.getByRole('button', { name: 'Insert image', exact: true }).click()])
      await chooser.setFiles({ name: 'invented-photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(await syntheticImage(a, { width: 800, height: 600, kind: 'photo', quality: 0.85 }), 'base64') })
      await a.getByText('Picture added.').waitFor()
      await settled(a)
      await openIn(a, /Context and risks, /)
      await a.getByRole('navigation', { name: 'Subsections' }).getByRole('button', { name: /Technical issues, / }).click()
      await a.getByRole('button', { name: 'Mark Technical issues as not applicable' }).click()
      await a.getByRole('textbox', { name: 'Why is this not applicable?' }).fill('No expert is needed.')
      await a.getByRole('button', { name: 'Mark as not applicable' }).click()
      await settled(a)
      const addAllegation = async (page: Page, text: string): Promise<void> => {
        await openIn(page, /Allegations and regulatory framework, /)
        await page.getByRole('button', { name: 'Add allegation' }).click()
        await page.getByLabel('Type of allegation', { exact: true }).last().fill(text)
        await settled(page)
      }
      await addAllegation(a, 'Abuse of power (invented)')
      await shot(a, 'step4-a-written')
      // B writes before A shares: another allegation and the same field.
      await addAllegation(b, 'Harassment (invented)')
      await openIn(b, /Case details/)
      await typeIn(b, 'Investigator', 'Zorana Veltkamp, with the medical coordinator')
      await a.getByRole('link', { name: 'Share as Draft 1' }).click()
      await a.getByRole('button', { name: /share as Draft 1$/i }).click()
      await a.getByText('Shared as Draft 1.').waitFor()
      await b.goto(`${base}/r/${ids.intake}/share`)
      const go2 = b.getByRole('button', { name: 'Share as Draft 2' })
      const compare = b.getByRole('heading', { name: 'Compare with Draft 1' })
      await go2.or(compare).first().waitFor()
      if (await go2.isVisible()) await go2.click()
      await compare.waitFor()
      assert.match(await b.getByRole('list', { name: 'Changes taken automatically' }).innerText(), /llegation/)
      await shot(b, 'step4-b-compare')
      await b.getByRole('button', { name: /^Keep my version of/ }).click()
      await b.getByText('Chosen: mine.').waitFor()
      await b.getByRole('button', { name: /^Resolve and review Draft 2/ }).click()
      await b.getByRole('button', { name: /share as Draft 2$/ }).click()
      await b.getByText('Shared as Draft 2.').waitFor()
      await go(b, `/r/${ids.intake}/drafts/1`, /Draft 1/)
      await b.locator('[data-comment-item="investigator"]').waitFor()
      await selectPhrase(b, 'investigator', 'field coordinator')
      await b.getByRole('button', { name: 'Comment on the selected text' }).click()
      await b.getByLabel('Your comment').fill('Name the medical coordinator too.')
      await b.getByRole('button', { name: 'Add comment' }).click()
      await b.getByText('Name the medical coordinator too.').waitFor()
      await shot(b, 'step4-b-comment')
      await go(a, `/r/${ids.intake}/drafts/1`, /Draft 1/)
      await a.getByText('Name the medical coordinator too.').waitFor()
    }],
    ['5. A accepts two names, adds an alias, marks the image safe, checks the redaction, shares and publishes Revision 1; R1 and R2 are notified; WhatsApp for R1', async () => {
      await go(a, `/r/${ids.intake}`, 'Intake and initial assessment')
      await a.getByRole('button', { name: 'Start again from the latest shared draft' }).click()
      await a.getByRole('alertdialog').getByRole('button', { name: 'Discard and start again' }).click()
      await a.getByText('Your working copy starts from the latest shared draft.').waitFor()
      await a.getByRole('link', { name: /^People and names/ }).click()
      await a.getByRole('heading', { name: 'People, names and pictures' }).waitFor()
      for (const name of [/Veltkamp/, /Nwosu/]) {
        await a.getByRole('button', { name: new RegExp(`^Add .*${name.source}.* as a new person$`) }).first().click()
        if (name.source === 'Veltkamp') await a.locator('#person-aliases').fill('Zora')
        await a.getByRole('button', { name: 'Add this person' }).click()
        await a.getByText('The list of people is saved.').waitFor()
      }
      await a.getByText('Reviewers read: Person 2').waitFor()
      await a.locator('[data-image-id]').first().getByRole('button', { name: 'Mark safe to share' }).click()
      await a.locator('[data-image-id][data-safe="true"]').waitFor()
      await shot(a, 'step5-names')
      await a.getByRole('link', { name: 'Back to the report' }).click()
      await a.getByRole('button', { name: 'Redacted', exact: true }).click()
      await openIn(a, /Case details/)
      await a.locator('[data-redaction="replaced"]').first().waitFor()
      assert.ok(!/Veltkamp|Nwosu/.test(await a.locator('main').innerText()), 'a name is in the redacted view')
      await a.getByRole('button', { name: 'Original', exact: true }).click()
      await shareAndPublish(a, ids.intake, 1, 3 * 24 * 60)
      for (const name of [R1, R2]) {
        await go(who(name), '/inbox', 'Inbox')
        await who(name).locator(`[data-inbox-item="${ids.intake}/1"]`).waitFor()
      }
      await shot(who(R1), 'step5-r1-inbox')
      await a.getByRole('link', { name: 'Review round, deadline and WhatsApp requests' }).click()
      await a.getByRole('button', { name: `Prepare the WhatsApp message for ${R1}` }).click()
      const wa = (await a.getByRole('link', { name: `Send on WhatsApp to ${R1}` }).getAttribute('href')) ?? ''
      assert.ok(wa.startsWith('https://wa.me/34600111222?text='), 'no WhatsApp link for R1')
      assert.ok(!/Veltkamp|Nwosu|water/.test(decodeURIComponent(wa)), 'report content in the WhatsApp text')
      assert.equal(await a.getByRole('button', { name: `Prepare the WhatsApp message for ${R2}` }).count(), 0, 'WhatsApp offered without consent')
      await shot(a, 'step5-round')
      for (const name of [R1, R2]) await waitForNotice(who(name), 'review_request', ids.intake)
      await shot(who(R1), 'step5-r1-notified')
    }],
    ['6. R1 on a phone comments on a phrase and, for the committee, a section, and requests changes; R2 sees only the shared one and approves; A and B are told', async () => {
      const [r1, r2] = [who(R1), who(R2)]
      await go(r1, '/inbox', 'Inbox')
      await r1.locator(`[data-inbox-item="${ids.intake}/1"] a`).first().click()
      await r1.getByRole('heading', { name: /^Revision 1/ }).waitFor()
      await r1.locator('[data-reading="true"]').waitFor()
      assert.ok(!/Veltkamp|Nwosu/.test(await r1.locator('main').innerText()), 'R1 reads a real name')
      await openIn(r1, /Summary of the complaint/)
      await selectPhrase(r1, 'summary-text', 'delay in the supply')
      assert.equal(await r1.getByText(/safe to share/).count(), 0, 'a reviewer is told how an image was marked')
      await r1.getByRole('button', { name: 'Comment on the selected text' }).click()
      await r1.getByRole('textbox', { name: 'Your comment' }).fill('How long was the delay?')
      await r1.getByRole('button', { name: 'Add comment' }).click()
      await r1.locator('[data-comment][data-visibility="authors"]').waitFor()
      await commentOnSection(r1, 'The committee should see the table.', true)
      await noSideScroll(r1)
      await shot(r1, 'step6-r1-comments')
      await r1.getByRole('button', { name: 'Send your review' }).click()
      await r1.getByRole('radio', { name: /Request changes/ }).check()
      await r1.getByRole('button', { name: 'Confirm and send review' }).click()
      await r1.locator('[data-review-sent="request_changes"]').waitFor()
      await shot(r1, 'step6-r1-sent')
      await go(r2, `/r/${ids.intake}/rev/1`, /^Revision 1/)
      await openIn(r2, /Summary of the complaint/)
      await r2.getByText('The committee should see the table.').waitFor()
      assert.equal(await r2.getByText('How long was the delay?').count(), 0, 'R2 sees an authors-only comment')
      await review(r2, ids.intake, 1, /Approve/, 'approve')
      for (const page of [a, who(B)]) await waitForNotice(page, 'review_received', ids.intake, 5)
      assert.equal(await notifications(a, 'approval_received', ids.intake), 0, 'A was told of an approval by default')
    }],
    ['7. A answers, shares Draft 4, publishes Revision 2; both are asked again; R2’s approval stays history; a late review of Revision 1 is refused', async () => {
      await go(a, `/r/${ids.intake}/comments`, 'Comments from reviewers')
      for (const [comment, reply] of [['How long was the delay?', 'About a week (invented).'], ['The committee should see the table.', 'The table is now complete.']] as const) {
        const box = a.locator('[data-comment]', { hasText: comment })
        await box.getByRole('textbox', { name: 'Reply' }).fill(reply)
        await box.getByRole('button', { name: 'Send reply to this comment' }).click()
        await box.locator('[data-reply]').waitFor()
      }
      await shot(a, 'step7-replies')
      await go(a, `/r/${ids.intake}`, 'Intake and initial assessment')
      await openIn(a, /Case details/)
      await typeIn(a, 'How the complaint was reported', 'Through the invented integrity line, a week later')
      await shareAndPublish(a, ids.intake, 2, 12)
      ids.rev2At = Date.now()
      for (const name of [R1, R2]) await waitForNotice(who(name), 'revision_replaced', ids.intake, 5)
      const r2 = who(R2)
      await go(r2, `/r/${ids.intake}/rev/1`, /^Revision 1/)
      await r2.locator('[data-banner="superseded"]').waitFor()
      assert.equal(await r2.getByRole('button', { name: 'Send your review' }).count(), 0, 'a late review is offered')
      await go(a, `/r/${ids.intake}/grid`, 'Status grid')
      await a.getByRole('heading', { name: 'Revision 1, from Draft 3' }).waitFor()
      assert.ok((await a.getByText(/^Approved, \d/).count()) >= 1, 'R2’s approval of Revision 1 is not in the grid')
      await shot(a, 'step7-grid')
    }],
    ['8. A reminder reaches R1; R1 and R2 approve Revision 2; the round is decided and the authors are told', async () => {
      await waitForNotice(who(R1), 'reminder_first', ids.intake, 8)
      await shot(who(R1), 'step8-r1-reminder')
      await review(who(R1), ids.intake, 2, /Approve/, 'approve')
      await review(who(R2), ids.intake, 2, /Approve/, 'approve')
      await go(a, `/r/${ids.intake}`, 'Intake and initial assessment')
      await a.getByRole('heading', { name: 'Revision 2 was approved' }).waitFor()
      for (const page of [a, who(B)]) await waitForNotice(page, 'round_decided', ids.intake, 5)
    }],
    ['9. A starts the conclusion (only it can be edited), shares Draft 5 as the closing Revision 3; R1 and R2 approve; archived', async () => {
      await go(a, `/r/${ids.intake}`, 'Intake and initial assessment')
      await a.getByRole('button', { name: 'Start the conclusion' }).click()
      await a.getByRole('alertdialog', { name: 'Start the conclusion?' }).getByRole('button', { name: 'Start the conclusion' }).click()
      await a.getByRole('heading', { name: 'The conclusion is being written' }).waitFor()
      await openIn(a, /^Case details/)
      await a.getByText('The report is concluding. Only the conclusion can be edited now.').first().waitFor()
      await openIn(a, /Behaviour committee conclusion/)
      await a.getByRole('textbox', { name: 'Decision', exact: true }).click()
      await a.keyboard.type('The committee closes the invented case with a referral.')
      await settled(a)
      await shot(a, 'step9-conclusion')
      await shareAndPublish(a, ids.intake, 3, 60)
      await review(who(R1), ids.intake, 3, /Approve/, 'approve')
      await review(who(R2), ids.intake, 3, /Approve/, 'approve')
      await go(a, `/r/${ids.intake}`, 'Intake and initial assessment')
      await a.getByRole('heading', { name: 'This report is archived' }).waitFor()
      await shot(a, 'step9-archived')
    }],
    ['10. A downloads everything and the approval record; the grid and the audit log tell the story; reminders stopped', async () => {
      await go(a, `/r/${ids.intake}/downloads`, 'Downloads')
      const zip = await download(a, 'Download all drafts, revisions and approval records as one zip')
      assert.equal(spawnSync('unzip', ['-tq', zip]).status, 0, 'the zip is broken')
      const entries = spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
      for (const name of ['Draft-5.pdf', 'Draft-5_redacted.pdf', 'Revision-3.pdf', 'Revision-3_redacted.pdf']) {
        assert.ok(entries.some(entry => entry.endsWith(name)), `the zip lacks ${name}`)
      }
      const record = await download(a, 'Download the approval record PDF')
      assert.equal(readFileSync(record).subarray(0, 5).toString('latin1'), '%PDF-')
      await shot(a, 'step10-downloads')
      await go(a, `/r/${ids.intake}/grid`, 'Status grid')
      await a.getByRole('heading', { name: 'Revision 3 (closing), from Draft 5' }).waitFor()
      await shot(a, 'step10-grid')
      await go(a, `/r/${ids.intake}/audit`, 'Audit log')
      await a.locator('[data-audit="revision.published"]').nth(2).waitFor()
      assert.equal(await a.locator('[data-audit="revision.published"]').count(), 3, 'not three revisions in the audit log')
      assert.ok((await a.locator('[data-audit="round.decided"]').count()) >= 2, 'the decided rounds are not in the audit log')
      await shot(a, 'step10-audit')
      // Revision 2's last reminder would be due 9 minutes after it was published.
      const finalDue = ids.rev2At + 9 * 60_000 + 90_000
      while (Date.now() < finalDue) await a.waitForTimeout(15_000)
      for (const name of [R1, R2]) {
        assert.equal(await notifications(who(name), 'reminder_final', ids.intake), 0, `${name} got a last reminder after deciding`)
      }
    }],
    ['11a. An investigation report is archived on approval', async () => {
      ids.investigation = await newReport(a, 'Investigation report (version 1)', 'IEU-2026-002', 'Invented investigation case file')
      await typeIn(a, 'The allegations in brief', 'Misuse of invented project funds')
      await shareAndPublish(a, ids.investigation, 1, 60)
      await review(who(R1), ids.investigation, 1, /Approve/, 'approve')
      await review(who(R2), ids.investigation, 1, /Approve/, 'approve')
      await go(a, `/r/${ids.investigation}`, 'Investigation report')
      await a.getByRole('heading', { name: 'This report is archived' }).waitFor()
      await shot(a, 'step11a-archived')
    }],
    ['11b. A round passes its deadline with R1 silent, is decided by the deadline, and is answered with Revision 2', async () => {
      ids.deadline = await newReport(a, 'Intake and initial assessment (version 1)', 'IEU-2026-003', 'Invented deadline case file')
      await typeIn(a, 'Investigator', 'An invented investigator')
      await shareAndPublish(a, ids.deadline, 1, 3)
      const due = Date.now() + 3 * 60_000
      await review(who(R2), ids.deadline, 1, /Approve/, 'approve')
      while (Date.now() < due + 30_000) await a.waitForTimeout(15_000)
      await waitForNotice(a, 'round_decided', ids.deadline, 5)
      await go(a, `/r/${ids.deadline}`, 'Intake and initial assessment')
      await a.getByRole('heading', { name: 'Revision 1 reached its deadline' }).waitFor()
      await shot(a, 'step11b-deadline')
      await openIn(a, /Case details/)
      await typeIn(a, 'Investigator', 'An invented investigator, after the deadline')
      await shareAndPublish(a, ids.deadline, 2, 60)
      await go(who(R1), `/r/${ids.deadline}/rev/2`, /^Revision 2/)
      await who(R1).getByRole('button', { name: 'Send your review' }).waitFor()
    }],
    ['11c. A template from the editor: decided by majority, an observer who comments but cannot vote, a chair who reads the original', async () => {
      await go(a, '/templates', 'Templates')
      await a.getByLabel('Template to copy', { exact: true }).selectOption({ label: 'Intake and initial assessment' })
      await a.getByLabel('Name of the copy', { exact: true }).fill('Invented panel review')
      await a.getByRole('button', { name: 'Copy into a new draft' }).click()
      await a.getByRole('link', { name: 'Open the draft' }).click()
      await a.getByRole('heading', { name: 'Edit Invented panel review', level: 1 }).waitFor()
      const roles = a.getByRole('region', { name: 'Roles and approval' })
      if ((await roles.getByRole('list', { name: 'Roles' }).count()) === 0) {
        await roles.getByRole('button', { name: /Roles and approval/ }).click()
      }
      await a.locator('#role-committee-approval').selectOption('majority')
      for (const [name, view, votes] of [['Observer', 'redacted', false], ['Chair', 'full', true]] as const) {
        const cards = roles.locator('li[data-role-id]')
        const before = await cards.count()
        await roles.getByRole('button', { name: 'Add a reviewing role' }).click()
        await cards.nth(before).waitFor()
        const card = cards.nth(before)
        await card.getByLabel('Role name').fill(name)
        await card.getByLabel('Sees').selectOption(view)
        const vote = card.getByLabel('Vote', { exact: true })
        if ((await vote.isChecked()) !== votes) await vote.click()
      }
      await shot(a, 'step11c-roles')
      await a.getByRole('button', { name: /^Publish version 1$/ }).click()
      await a.getByRole('region', { name: 'Publish this version' }).getByRole('button', { name: 'Publish version 1' }).click()
      await a.getByText(/Published, version 1\./).first().waitFor()
      // The panel: R1, R2 and a new R3 vote by majority, with an observer and a chair.
      await go(a, '/unit', 'My unit')
      for (const name of [R3, OB, CH]) {
        await a.getByLabel('Reviewer name').fill(name)
        await a.getByLabel('Reviewer e-mail').fill(at(name))
        await a.getByRole('button', { name: 'Register reviewer' }).click()
        links[name] = await copiedLink(a)
        pages[name] = await person(browser)
        await activate(who(name), links[name] ?? '', name.split(' ')[0]?.toLowerCase() ?? '')
      }
      ids.panel = await newReport(a, 'Invented panel review (version 1)', 'IEU-2026-004', 'Invented panel case file')
      await typeIn(a, 'Investigator', 'Halvard Quist')
      await a.getByRole('link', { name: /^People and names/ }).click()
      await a.getByRole('button', { name: /^Add .*Quist.* as a new person$/ }).first().click()
      await a.getByRole('button', { name: 'Add this person' }).click()
      await a.getByText('The list of people is saved.').waitFor()
      await shareAndPublish(a, ids.panel, 1, 60, async page => {
        const pick = async (role: string, names: ReadonlyArray<string>) => {
          const box = page.locator(`fieldset[data-role-id="${role}"]`)
          for (const name of names) await box.getByRole('checkbox', { name, exact: true }).check()
        }
        await pick('committee', [R1, R2, R3])
        const [observer, chair] = await page.locator('fieldset[data-role-id]').evaluateAll(sets => sets.map(set => set.getAttribute('data-role-id') ?? '').slice(-2))
        await pick(observer ?? '', [OB])
        await pick(chair ?? '', [CH])
      })
      const ob = who(OB)
      await go(ob, `/r/${ids.panel}/rev/1`, /^Revision 1/)
      await ob.locator('[data-reading="true"]').waitFor()
      await commentOnSection(ob, 'An observer’s note (invented).', false)
      await ob.getByRole('button', { name: 'Send your review' }).click()
      assert.equal(await ob.getByRole('radio', { name: /Approve/ }).count(), 0, 'an observer can vote')
      await ob.getByRole('radio', { name: /Comment only/ }).check()
      await ob.getByRole('button', { name: 'Confirm and send review' }).click()
      await ob.locator('[data-review-sent="comment"]').waitFor()
      await shot(ob, 'step11c-observer')
      const ch = who(CH)
      await go(ch, `/r/${ids.panel}/rev/1`, /^Revision 1/)
      await ch.getByText('Halvard Quist').first().waitFor()
      await go(who(R1), `/r/${ids.panel}/rev/1`, /^Revision 1/)
      await who(R1).locator('[data-reading="true"]').waitFor()
      assert.ok(!(await who(R1).locator('main').innerText()).includes('Quist'), 'a committee member reads the name')
      await review(ch, ids.panel, 1, /Approve/, 'approve')
      await review(who(R1), ids.panel, 1, /Approve/, 'approve')
      await review(who(R2), ids.panel, 1, /Approve/, 'approve')
      await go(a, `/r/${ids.panel}`, 'Invented panel review')
      await a.getByRole('heading', { name: 'Revision 1 was approved' }).waitFor()
      await shot(a, 'step11c-decided')
    }],
  ]

  try {
    // NOTE: REHEARSAL_STEPS=1,2,11c runs only those steps (for fixing one).
    const only = process.env.REHEARSAL_STEPS?.split(',')
    for (const [name, body] of steps.filter(([name]) => only === undefined || only.includes(name.split('.')[0] ?? ''))) {
      console.log(`--   ${elapsed()}`)
      await step(name, body)
      if (results.at(-1)?.ok !== true) {
        // NOTE: what each person saw when the step failed.
        for (const [name, page] of Object.entries({ [A]: a, ...pages })) {
          await page.screenshot({ path: join(process.env.E2E_SHOTS ?? '', `failed-${name.split(' ')[0]}.png`), fullPage: true }).catch(() => undefined)
        }
        break
      }
    }
  } finally {
    await browser.close()
    rmSync(downloads, { recursive: true, force: true })
  }
  const passed = results.filter(result => result.ok).length
  console.log(`${passed} of ${results.length} steps passed in ${elapsed()}. Screenshots: ${process.env.E2E_SHOTS}`)
  process.exit(passed === results.length && results.length > 0 ? 0 : 1)
}

await main()
