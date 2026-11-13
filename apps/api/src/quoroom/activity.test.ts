import { Effect } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'

import { DEFAULT_THEME, INTAKE_TEMPLATE } from '@case-desk/domain'

import { PEOPLE, SCENARIOS, SECRET, type World, makeWorld } from './testkit'

// NOTE: The rest of stage 2c through the real RPC stack: templates and the
// theme, the capabilities that have no part in a report, the grid and the
// audit log, the notification inbox, WhatsApp link data, downloads and the
// report extras. All people and data are invented.

const worlds: Array<World> = []
afterEach(async () => {
  await Promise.all(worlds.splice(0).map(world => world.dispose()))
})

const tagOf = (error: unknown): string =>
  (error as { _tag?: string })._tag ?? 'unknown'

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect as Effect.Effect<A>)

describe.each(SCENARIOS)('$name', scenario => {
  const world = async () => {
    const made = await makeWorld(scenario)
    worlds.push(made)
    return made
  }
  const ref = { templateId: scenario.template.id, version: scenario.template.version }

  test('an administrator and a template editor are NotFound on every report procedure', async () => {
    const w = await world()
    const { reportId } = await w.published()
    for (const who of ['adam', 'tess'] as const) {
      const refusals = await Promise.all([
        w.refused(who, c => c.GetReport({ reportId })),
        w.refused(who, c => c.GetGrid({ reportId })),
        w.refused(who, c => c.GetDownloads({ reportId })),
        w.refused(who, c => c.GetApprovalRecordData({ reportId })),
        w.refused(who, c => c.GetRound({ reportId, revision: 1 })),
        w.refused(who, c => c.GetWorkingCopy({ reportId })),
        w.refused(who, c => c.GetRevisionOutline({ reportId, revision: 1 })),
        w.refused(who, c => c.ListAuditEvents({ subject: { kind: 'report', reportId }, limit: 10 })),
        w.refused(who, c => c.GetTemplateVersion({ ...ref, reportId })),
        w.refused(who, c => c.AddCoAuthor({ reportId, accountId: 'bob' })),
        w.refused(who, c =>
          c.ExtendDeadline({ reportId, revision: 1, deadline: { at: w.clock.now() + 99 * 24 * 3_600_000, timeZone: 'Europe/Madrid' } }),
        ),
        w.refused(who, c => c.RemoveReviewer({ reportId, revision: 1, accountId: 'carol' })),
        w.refused(who, c => c.GetWhatsAppLink({ reportId, revision: 1, accountId: 'carol' })),
      ])
      for (const error of refusals) expect(tagOf(error)).toBe('NotFound')
    }
    // NOTE: and the other way round: an author has no deployment capability.
    expect(tagOf(await w.refused('alice', c => c.ListTemplates()))).toBe('NotPermitted')
    expect(tagOf(await w.refused('alice', c => c.GetTheme().pipe(Effect.flatMap(() => c.UpdateTheme({ theme: DEFAULT_THEME })))))).toBe('NotPermitted')
    expect(tagOf(await w.refused('tess', c => c.UpdateTheme({ theme: DEFAULT_THEME })))).toBe('NotPermitted')
    expect(tagOf(await w.refused('adam', c => c.ListTemplates()))).toBe('NotPermitted')
  })

  test('a template is drafted, refused while invalid, published as an immutable version with its diff logged', async () => {
    const w = await world()
    const draft = await w.call('tess', c => c.CreateTemplateDraft({ copyOf: ref, name: 'Copy of a template' }))
    expect(draft).toMatchObject({ version: 1, state: 'draft' })
    const id = draft.templateId
    expect(id).not.toBe(ref.templateId)

    // NOTE: a duplicate ID is saved (a draft only has to fit the schema) but
    // reported, and cannot be published.
    const first = draft.template.sections[0]
    if (first === undefined) throw new Error('no section')
    const broken = { ...draft.template, sections: [...draft.template.sections, first] }
    const saved = await w.call('tess', c => c.SaveTemplateDraft({ templateId: id, version: 1, template: broken }))
    expect(saved.problems.some(problem => problem.code === 'duplicate-id')).toBe(true)
    const refusal = await w.refused('tess', c => c.PublishTemplateVersion({ templateId: id, version: 1 }))
    expect(tagOf(refusal)).toBe('Validation')
    expect((await w.call('tess', c => c.GetTemplateVersion({ templateId: id, version: 1 }))).state).toBe('draft')

    // NOTE: fixed, it publishes, and the first version's diff is all additions.
    const fixed = await w.call('tess', c => c.SaveTemplateDraft({ templateId: id, version: 1, template: draft.template }))
    expect(fixed.problems).toEqual([])
    const published = await w.call('tess', c => c.PublishTemplateVersion({ templateId: id, version: 1 }))
    expect(published.record.state).toBe('published')
    expect(published.changes.length).toBeGreaterThan(0)
    expect(published.changes.every(change => change.change === 'added')).toBe(true)

    // NOTE: immutable: nothing saves, publishes or retires-and-rewrites it.
    expect(tagOf(await w.refused('tess', c => c.SaveTemplateDraft({ templateId: id, version: 1, template: { ...draft.template, name: 'Changed' } })))).toBe('Conflict')
    expect(tagOf(await w.refused('tess', c => c.PublishTemplateVersion({ templateId: id, version: 1 })))).toBe('Conflict')

    // NOTE: the next version is a draft of the same template, one at a time.
    const next = await w.call('tess', c => c.CreateTemplateDraft({ copyOf: { templateId: id, version: 1 } }))
    expect(next).toMatchObject({ templateId: id, version: 2, state: 'draft' })
    expect(tagOf(await w.refused('tess', c => c.CreateTemplateDraft({ copyOf: { templateId: id, version: 1 } })))).toBe('Conflict')
    const extra = {
      ...next.template,
      sections: [
        ...next.template.sections,
        { id: 'added-section', title: 'An added section', requirement: 'optional' as const, frontMatter: false, numbered: true, items: [{ id: 'added-text', label: 'Added text', requirement: 'optional' as const, type: 'text' as const }], sections: [] },
      ],
    }
    await w.call('tess', c => c.SaveTemplateDraft({ templateId: id, version: 2, template: extra }))
    const second = await w.call('tess', c => c.PublishTemplateVersion({ templateId: id, version: 2 }))
    expect(second.changes.map(change => `${change.change}:${change.id}`)).toContain('added:added-section')
    expect((await w.call('tess', c => c.GetTemplateVersion({ templateId: id, version: 1 }))).template.name).toBe('Copy of a template')

    // NOTE: the log has both publications, newest first, with small metadata.
    const log = await w.call('tess', c => c.ListAuditEvents({ subject: { kind: 'template', templateId: id }, limit: 20 }))
    const actions = log.events.map(event => event.action)
    expect(actions.indexOf('template.published')).toBeLessThan(actions.lastIndexOf('template.published'))
    expect(actions).toContain('template.draft_created')
    expect(log.events.find(event => event.action === 'template.published')?.meta).toMatchObject({ version: 2, added: 2 })
    expect(log.events[0]?.actor?.name).toBe('Tess Template Editor')
    // NOTE: authors cannot read a template's log.
    expect(tagOf(await w.refused('alice', c => c.ListAuditEvents({ subject: { kind: 'template', templateId: id }, limit: 5 })))).toBe('NotPermitted')

    // NOTE: authors choose from the published ones; a retired template leaves.
    const choices = await w.call('alice', c => c.ListPublishedTemplates())
    expect(choices.find(choice => choice.id === id)?.version).toBe(2)
    const summary = await w.call('tess', c => c.RetireTemplate({ templateId: id }))
    expect(summary.retired).toBe(true)
    expect((await w.call('alice', c => c.ListPublishedTemplates())).some(choice => choice.id === id)).toBe(false)
    expect(tagOf(await w.refused('frank', c => c.ListPublishedTemplates()))).toBe('NotPermitted')
  })

  test('a blank template can be created and published', async () => {
    const w = await world()
    const draft = await w.call('tess', c => c.CreateTemplateDraft({ name: 'Blank one' }))
    expect((await w.call('tess', c => c.SaveTemplateDraft({ templateId: draft.templateId, version: 1, template: draft.template }))).problems).toEqual([])
    const published = await w.call('tess', c => c.PublishTemplateVersion({ templateId: draft.templateId, version: 1 }))
    expect(published.record.state).toBe('published')
    expect(published.record.createdBy).toBeDefined()
    const listed = await w.call('tess', c => c.ListTemplates())
    expect(listed.find(entry => entry.id === draft.templateId)).toMatchObject({ publishedVersion: 1, hasDraft: false })
    expect(listed.find(entry => entry.id === INTAKE_TEMPLATE.id || entry.id === ref.templateId)?.builtIn).toBeDefined()
  })

  test('the theme is refused when its text would be unreadable, and its log is for administrators', async () => {
    const w = await world()
    expect((await w.call('alice', c => c.GetTheme())).theme).toEqual(DEFAULT_THEME)
    const faint = { ...DEFAULT_THEME, colors: { ...DEFAULT_THEME.colors, text: '#cccccc' } }
    const refusal = await w.refused('adam', c => c.UpdateTheme({ theme: faint }))
    expect(tagOf(refusal)).toBe('Validation')
    expect((await w.call('alice', c => c.GetTheme())).theme).toEqual(DEFAULT_THEME)
    expect(tagOf(await w.refused('adam', c => c.UpdateTheme({ theme: { ...DEFAULT_THEME, logo: 'img-unknown' } })))).toBe('Validation')

    const better = { ...DEFAULT_THEME, organisationName: 'Invented Organisation' }
    const saved = await w.call('adam', c => c.UpdateTheme({ theme: better }))
    expect(saved).toMatchObject({ theme: better, updatedBy: 'adam' })
    expect((await w.call('alice', c => c.GetTheme())).theme.organisationName).toBe('Invented Organisation')
    const log = await w.call('adam', c => c.ListAuditEvents({ subject: { kind: 'theme' }, limit: 10 }))
    expect(log.events.map(event => event.action)).toEqual(['theme.updated'])
    expect(tagOf(await w.refused('tess', c => c.ListAuditEvents({ subject: { kind: 'theme' }, limit: 10 })))).toBe('NotPermitted')
  })

  test('the grid and the audit log reflect what happened, in order', async () => {
    const w = await world()
    const { reportId } = await w.published()
    w.clock.advance(60_000)
    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    w.clock.advance(60_000)
    await w.call('dan', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'request_changes' }))

    const view = await w.call('alice', c => c.GetGrid({ reportId }))
    expect(view.grid.authors).toContain('alice')
    expect(view.grid.drafts.map(row => row.draft)).toEqual([0, 1])
    expect(view.grid.drafts[1]?.sharedBy).toBe('alice')
    const row = view.grid.revisions[0]
    expect(row?.revision).toBe(1)
    const carol = row?.cells.find(cell => cell.accountId === 'carol')
    const dan = row?.cells.find(cell => cell.accountId === 'dan')
    expect(carol?.decision?.decision).toBe('approve')
    expect(dan?.decision?.decision).toBe('request_changes')
    expect((carol?.decision?.at ?? 0) < (dan?.decision?.at ?? 0)).toBe(true)
    expect(view.names.find(name => name.id === 'carol')?.name).toBe('Carol Reviewer')

    // NOTE: reading by a reviewer is recorded as an event the grid shows.
    expect(tagOf(await w.refused('carol', c => c.GetGrid({ reportId })))).toBe('NotFound')

    const log = await w.call('alice', c =>
      c.ListAuditEvents({ subject: { kind: 'report', reportId }, limit: 50 }),
    )
    const times = log.events.map(event => event.at)
    expect([...times].sort((a, b) => b - a)).toEqual(times)
    const actions = log.events.map(event => event.action)
    expect(actions).toContain('report.created')
    expect(actions.some(action => action.includes('publish'))).toBe(true)
    expect(JSON.stringify(log)).not.toContain(SECRET)

    // NOTE: paging: a page of one, then the rest, with nothing twice.
    const pages: Array<string> = []
    let before: string | undefined
    for (let i = 0; i < 100; i += 1) {
      const page = await w.call('alice', c =>
        c.ListAuditEvents({ subject: { kind: 'report', reportId }, limit: 2, ...(before === undefined ? {} : { before }) }),
      )
      pages.push(...page.events.map(event => event.id))
      before = page.next
      if (before === undefined) break
    }
    expect(pages).toEqual(log.events.map(event => event.id))
    // NOTE: a reviewer reads no log.
    expect(tagOf(await w.refused('carol', c => c.ListAuditEvents({ subject: { kind: 'report', reportId }, limit: 5 })))).toBe('NotFound')
  })

  test('notification jobs are written with their cause, and the inbox pages, reads and counts', async () => {
    const w = await world()
    const reportId = await w.createReport()
    const { outcome } = await w.share('alice', reportId, { shareId: 'share-1' })
    if (outcome.kind !== 'shared') throw new Error('not shared')
    expect(await run(w.repository.listJobKeys(reportId))).toEqual([])
    await w.publish('alice', reportId, outcome.draft.number)
    // NOTE: the request to each participant and the job that decides the
    // round exist as soon as the revision does: same batch.
    const keys = await run(w.repository.listJobKeys(reportId))
    expect(keys.filter(key => key.includes('review_request'))).toHaveLength(scenario.fullRole === undefined ? 2 : 3 + (scenario.observerRole === undefined ? 0 : 1))
    expect(keys.some(key => key.includes('deadline'))).toBe(true)

    // NOTE: a review that comes with a decision tells the authors in the
    // same batch as the review.
    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'request_changes' }))
    const after = await run(w.repository.listJobKeys(reportId))
    expect(after.some(key => key.includes('review_received'))).toBe(true)

    // NOTE: the pass that sends them (stage 3) is stood in for here.
    const claimed = await run(w.repository.claimDueJobs({ now: w.clock.now() + 1, limit: 100, leaseMs: 60_000, claimedBy: 'test' }))
    await run(w.repository.finishJobs({ claimedBy: 'test', done: claimed.map(job => job.id), skipped: [], now: w.clock.now() + 2 }))

    const first = await w.call('alice', c => c.ListNotifications({ limit: 1 }))
    expect(first.items).toHaveLength(1)
    expect(first.items[0]?.kind).toBe('review_received')
    expect(first.items[0]?.reportId).toBe(reportId)
    expect(first.unread).toBe(1)
    expect(JSON.stringify(first)).not.toContain(SECRET)

    const requests = await w.call('dan', c => c.ListNotifications({ limit: 10 }))
    expect(requests.items.map(item => item.kind)).toContain('review_request')
    expect(requests.items[0]?.caseReference).toMatch(/^REF-/)
    expect(requests.next).toBeUndefined()

    // NOTE: paging by cursor gives every notification once.
    const seen: Array<string> = []
    let cursor: number | undefined
    for (let i = 0; i < 20; i += 1) {
      const page = await w.call('dan', c => c.ListNotifications({ limit: 1, ...(cursor === undefined ? {} : { before: cursor }) }))
      seen.push(...page.items.map(item => item.id))
      cursor = page.next
      if (cursor === undefined) break
    }
    expect(seen).toEqual(requests.items.map(item => item.id))

    // NOTE: marking read touches only the caller's own.
    const unread = await w.call('dan', c => c.GetUnreadCount())
    expect(unread.unread).toBe(requests.unread)
    const foreign = first.items.map(item => item.id)
    expect((await w.call('dan', c => c.MarkNotificationsRead({ ids: foreign }))).unread).toBe(unread.unread)
    expect((await w.call('dan', c => c.MarkNotificationsRead({ ids: seen.length === 0 ? ['0'] : seen }))).unread).toBe(0)
    expect((await w.call('alice', c => c.GetUnreadCount())).unread).toBe(1)
    expect(w.worstRequest()).toBeLessThanOrEqual(50)
  })

  test('the deadline extends, a reviewer is removed, and new reminders are written with the change', async () => {
    const w = await world()
    const { reportId } = await w.published()
    const before = await run(w.repository.listJobKeys(reportId))
    const later = { at: w.clock.now() + 14 * 24 * 3_600_000, timeZone: 'Europe/Madrid' }
    const round = await w.call('alice', c => c.ExtendDeadline({ reportId, revision: 1, deadline: later }))
    expect(round.deadline).toEqual(later)
    const after = await run(w.repository.listJobKeys(reportId))
    expect(after.length).toBeGreaterThan(before.length)
    // NOTE: not earlier, not in the past, and not by a reviewer.
    const earlier = await w.refused('alice', c => c.ExtendDeadline({ reportId, revision: 1, deadline: { at: later.at - 1000, timeZone: 'Europe/Madrid' } }))
    expect(earlier).toMatchObject({ _tag: 'NotAllowedInState', state: 'in_review', code: 'deadline_not_extended' })
    const zone = await w.refused('alice', c => c.ExtendDeadline({ reportId, revision: 1, deadline: { at: later.at + 1000, timeZone: 'Not/AZone' } }))
    expect(zone).toMatchObject({ _tag: 'Validation' })
    expect(JSON.stringify(zone)).toContain('unknown_time_zone')
    const stored = await run(w.repository.getRound(reportId, 1))
    expect(stored?.round.deadlineAt).toBe(later.at)
    expect(tagOf(await w.refused('carol', c => c.ExtendDeadline({ reportId, revision: 1, deadline: later })))).toBe('NotFound')

    // NOTE: a removal that leaves the rule unmeetable is refused.
    const target = scenario.observerRole === undefined ? 'dan' : 'ivy'
    if (scenario.observerRole !== undefined) {
      expect(tagOf(await w.refused('alice', c => c.RemoveReviewer({ reportId, revision: 1, accountId: 'dan' })))).toBe('Validation')
    }
    const removed = await w.call('alice', c => c.RemoveReviewer({ reportId, revision: 1, accountId: target }))
    expect(removed.participants.find(p => p.accountId === target)?.removed).toBe(true)
    expect(tagOf(await w.refused(target, c => c.GetRevisionOutline({ reportId, revision: 1 })))).toBe('NotFound')
    expect(tagOf(await w.refused('alice', c => c.RemoveReviewer({ reportId, revision: 1, accountId: 'frank' })))).toBe('NotFound')
    const log = await w.call('alice', c => c.ListAuditEvents({ subject: { kind: 'report', reportId }, limit: 50 }))
    expect(log.events.map(event => event.action)).toEqual(expect.arrayContaining(['round.deadline_extended', 'round.reviewer_removed']))
  })

  test('WhatsApp link data needs a number and consent, names no case, and opening it is recorded', async () => {
    const w = await world()
    const { reportId } = await w.published()
    expect(tagOf(await w.refused('alice', c => c.GetWhatsAppLink({ reportId, revision: 1, accountId: 'carol' })))).toBe('Validation')
    await run(
      w.repository.putProfile(
        'carol',
        { phone: '+34600000001', whatsappConsent: true, whatsappConsentAt: 1, notifyOnApproval: false, active: true },
        1,
      ),
    )
    const link = await w.call('alice', c => c.GetWhatsAppLink({ reportId, revision: 1, accountId: 'carol' }))
    expect(link).toMatchObject({ accountId: 'carol', name: 'Carol Reviewer', number: '34600000001' })
    expect(link.url.startsWith('https://wa.me/34600000001?text=')).toBe(true)
    expect(decodeURIComponent(link.url.split('?text=')[1] ?? '')).toBe(link.text)
    expect(link.text).toMatch(/due \d{1,2} [A-Z][a-z]{2}, \d\d:\d\d Madrid time/)
    expect(link.text).not.toContain(SECRET)
    expect(link.text).not.toContain('REF-')
    expect(link.url).not.toContain('%2B')

    // NOTE: only people of the round.
    expect(tagOf(await w.refused('alice', c => c.GetWhatsAppLink({ reportId, revision: 1, accountId: 'frank' })))).toBe('NotFound')
    expect(tagOf(await w.refused('carol', c => c.GetWhatsAppLink({ reportId, revision: 1, accountId: 'carol' })))).toBe('NotFound')

    await w.call('alice', c => c.RecordWhatsAppOpened({ reportId, revision: 1, accountId: 'carol' }))
    const grid = await w.call('alice', c => c.GetGrid({ reportId }))
    const cell = grid.grid.revisions[0]?.cells.find(entry => entry.accountId === 'carol')
    expect(cell?.whatsappOpened?.at).toBe(w.clock.now())
  })

  test('the WhatsApp list says who can be sent a link, with no number, and a repeated tap is recorded once', async () => {
    const w = await world()
    const { reportId } = await w.published()
    await run(
      w.repository.putProfile(
        'carol',
        { phone: '+34600000001', whatsappConsent: true, whatsappConsentAt: 1, notifyOnApproval: false, active: true },
        1,
      ),
    )
    const list = await w.call('alice', c => c.ListWhatsAppLinks({ reportId, revision: 1 }))
    expect(list.find(entry => entry.accountId === 'carol')).toEqual({ accountId: 'carol', ready: true })
    expect(list.find(entry => entry.accountId === 'dan')).toEqual({ accountId: 'dan', ready: false })
    expect(JSON.stringify(list)).not.toContain('34600000001')
    expect(tagOf(await w.refused('carol', c => c.ListWhatsAppLinks({ reportId, revision: 1 })))).toBe('NotFound')

    const first = w.clock.now()
    await w.call('alice', c => c.RecordWhatsAppOpened({ reportId, revision: 1, accountId: 'carol' }))
    w.clock.advance(60_000)
    await w.call('alice', c => c.RecordWhatsAppOpened({ reportId, revision: 1, accountId: 'carol' }))
    const taps = (await run(w.repository.listEvents(reportId, 100))).filter(
      event => event.kind === 'whatsapp_opened',
    )
    expect(taps).toHaveLength(1)
    const grid = await w.call('alice', c => c.GetGrid({ reportId }))
    expect(grid.grid.revisions[0]?.cells.find(entry => entry.accountId === 'carol')?.whatsappOpened?.at).toBe(first)
  })

  test('the audit kind filter is applied before the page is cut, and only the actors of the page are read', async () => {
    const w = await world()
    const { reportId } = await w.published()
    const second = await w.share('alice', reportId, { shareId: 'share-2', people: PEOPLE, confirm: true })
    if (second.outcome.kind !== 'shared') throw new Error('not shared')
    await w.publish('alice', reportId, second.outcome.draft.number)
    const everything = await w.call('alice', c =>
      c.ListAuditEvents({ subject: { kind: 'report', reportId }, limit: 100 }),
    )
    const revisions = everything.events.filter(event => event.action.startsWith('revision.'))
    expect(revisions).toHaveLength(2)
    expect(everything.events.length).toBeGreaterThan(revisions.length)
    // NOTE: a page of one holds one revision event, and the next page the other.
    const one = await w.call('alice', c =>
      c.ListAuditEvents({ subject: { kind: 'report', reportId }, kind: 'revision', limit: 1 }),
    )
    expect(one.events.map(event => event.action)).toEqual(['revision.published'])
    expect(one.next).toBeDefined()
    const rest = await w.call('alice', c =>
      c.ListAuditEvents({
        subject: { kind: 'report', reportId },
        kind: 'revision',
        limit: 1,
        ...(one.next === undefined ? {} : { before: one.next }),
      }),
    )
    expect(rest.events.map(event => event.action)).toEqual(['revision.published'])
    expect(rest.events[0]?.revision).not.toBe(one.events[0]?.revision)
    expect(rest.next).toBeUndefined()
    expect(one.events[0]?.actor?.name).toBe('Alice Author')
  })

  test('downloads metadata and approval record data come from the stored report', async () => {
    const w = await world()
    const { reportId } = await w.published()
    const downloads = await w.call('alice', c => c.GetDownloads({ reportId }))
    expect(downloads.versions.filter(version => version.kind === 'draft').map(version => version.number)).toEqual([1])
    expect(downloads.versions.filter(version => version.kind === 'revision').map(version => version.view).sort()).toEqual(['original', 'redacted'])
    expect(downloads.approvalRecord).toBe(false)

    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    await w.call('dan', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    if (scenario.fullRole !== undefined) {
      await w.call('erin', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    }
    const data = await w.call('alice', c => c.GetApprovalRecordData({ reportId }))
    expect(data.caseFile.unit).toBe('Unit One')
    expect(data.flow.rounds[0]?.reviews.length).toBeGreaterThan(0)
    expect(data.accountNames['carol']).toBe('Carol Reviewer')
    expect(data.events.some(event => event.type === 'revision_published')).toBe(true)
    expect(data.events.some(event => event.type === 'review')).toBe(true)
    expect((await w.call('alice', c => c.GetDownloads({ reportId }))).approvalRecord).toBe(data.flow.rounds.some(round => round.status === 'decided'))
  })

  test('a case file title is changed by an author of its unit only; co-authors are chosen by ID from the authors of the unit', async () => {
    const w = await world()
    const reportId = await w.createReport()
    const report = await w.call('alice', c => c.GetReport({ reportId }))
    const caseFileId = report.summary.caseFile.id
    const renamed = await w.call('alice', c => c.UpdateCaseFile({ caseFileId, title: 'A new invented title' }))
    expect(renamed).toMatchObject({ id: caseFileId, unit: 'unit-1', title: 'A new invented title' })
    expect(tagOf(await w.refused('gina', c => c.UpdateCaseFile({ caseFileId, title: 'Not mine' })))).toBe('NotFound')
    expect(tagOf(await w.refused('frank', c => c.UpdateCaseFile({ caseFileId, title: 'Not mine' })))).toBe('NotFound')
    // NOTE: an author of the unit who is on no report of the case file may not
    // retitle it, and the audit row of the change names the report.
    expect(tagOf(await w.refused('bob', c => c.UpdateCaseFile({ caseFileId, title: 'Not mine' })))).toBe('NotFound')
    const events = await w.call('alice', c => c.ListAuditEvents({ subject: { kind: 'report', reportId }, limit: 50 }))
    expect(JSON.stringify(events)).toContain('case_file.updated')

    // NOTE: a co-author is an existing author of the report's unit, chosen by
    // account ID. Nothing is created or granted, and everything else gets one
    // refusal, whether or not the account exists.
    const accountsBefore = await w.call('adam', c => c.ListAccounts())
    const refusals = await Promise.all(
      ['nobody-at-all', 'frank', 'gina', 'carol', 'adam'].map(accountId =>
        w.refused('alice', c => c.AddCoAuthor({ reportId, accountId })),
      ),
    )
    for (const refusal of refusals) {
      expect(refusal).toMatchObject({ _tag: 'Validation' })
      expect(JSON.stringify(refusal)).toBe(JSON.stringify(refusals[0]))
    }
    expect(await w.call('adam', c => c.ListAccounts())).toEqual(accountsBefore)

    expect(await w.call('alice', c => c.ListDrafting({ reportId }))).toEqual([])
    await w.call('alice', c => c.StartWorkingCopy({ reportId }))
    expect((await w.call('alice', c => c.ListDrafting({ reportId }))).map(entry => entry.accountId)).toEqual(['alice'])

    const added = await w.call('alice', c => c.AddCoAuthor({ reportId, accountId: 'bob' }))
    expect(added).toEqual({ account: { id: 'bob', name: 'Bob Author' } })
    expect(tagOf(await w.refused('alice', c => c.AddCoAuthor({ reportId, accountId: 'bob' })))).toBe('Conflict')
    expect((await w.call('bob', c => c.GetReport({ reportId }))).authors.map(author => author.id).sort()).toEqual(['alice', 'bob'])
    // NOTE: the grants did not change either.
    expect(await w.call('adam', c => c.ListAccounts())).toEqual(accountsBefore)
  })

  test('a removal that makes the rule met decides the round in the same step, by the rule, with the actor', async () => {
    if (scenario.observerRole !== undefined) return
    const w = await world()
    const { reportId } = await w.published()
    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    expect((await run(w.repository.getRound(reportId, 1)))?.round.state).toBe('open')
    await w.call('alice', c => c.RemoveReviewer({ reportId, revision: 1, accountId: 'dan' }))
    // NOTE: stored at once, before any later read settles it.
    const stored = await run(w.repository.getRound(reportId, 1))
    expect(stored?.round).toMatchObject({ state: 'decided', decidedBy: 'rule_met' })
    expect(stored?.round.decidedAt).not.toBeNull()
    expect((await run(w.repository.getReport(reportId)))?.state).not.toBe('in_review')
    const audit = await run(w.repository.listAudit({ actionPrefix: 'round.', limit: 20 }))
    const removal = audit.find(a => a.action === 'round.reviewer_removed')
    const decision = audit.filter(a => a.action === 'round.decided')
    expect(decision).toHaveLength(1)
    expect(decision[0]?.at).toBe(removal?.at)
    expect(decision[0]?.actorId).toBe(removal?.actorId)
    expect(decision[0]?.reportId).toBe(reportId)
  })

  test('a unit author who reviews in the open round cannot be added as a co-author', async () => {
    const w = await world()
    const { reportId } = await w.published()
    const target = scenario.observerRole === undefined ? 'dan' : 'ivy'
    await w.call('adam', c => c.GrantCapability({ email: `${target}@case-desk.test`, capability: 'author', unit: 'unit-1' }))
    const refusal = await w.refused('alice', c => c.AddCoAuthor({ reportId, accountId: target }))
    expect(refusal).toMatchObject({ _tag: 'Validation' })
    expect(JSON.stringify(refusal)).toContain('reviewer_in_open_round')
    await w.call('alice', c => c.RemoveReviewer({ reportId, revision: 1, accountId: target }))
    expect((await w.call('alice', c => c.AddCoAuthor({ reportId, accountId: target }))).account.id).toBe(target)
  })
})
