import { Effect } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'

import { SCENARIOS, PEOPLE, SECRET, TEXT, type World, makeWorld, richContent, withFigure } from './testkit'
import { DEFAULT_THEME, INTAKE_TEMPLATE } from '@case-desk/domain'
import { sha256Hex } from './content'
import { cleanupStale } from './core'
import { makePng } from './imageFixtures'

// NOTE: Stage 2c: the Quoroom RPC through the real handler stack (the app, the
// RPC server, the middleware that reads the session cookie), on the in-memory
// repository and on the real SQL one, with the built-in intake template and the
// invented panel template. Accounts, grants, units and reports are invented.

const worlds: Array<World> = []
afterEach(async () => {
  await Promise.all(worlds.splice(0).map(world => world.dispose()))
})

const tagOf = (error: unknown): string =>
  (error as { _tag?: string })._tag ?? 'unknown'

describe.each(SCENARIOS)('$name', scenario => {
  const world = async () => {
    const made = await makeWorld(scenario)
    worlds.push(made)
    return made
  }
  const { sectionId, itemId } = scenario

  test('a redacted role reads stored redacted text and nothing of the author side', async () => {
    const w = await world()
    const { reportId } = await w.published()

    const outline = await w.call('carol', c =>
      c.GetRevisionOutline({ reportId, revision: 1 }),
    )
    expect(outline.view).toBe('redacted')
    expect(outline.roleId).toBe(scenario.redactedRole)
    expect(outline.caseTitle).not.toContain(SECRET)
    const section = await w.call('carol', c =>
      c.GetRevisionSection({ reportId, revision: 1, sectionId }),
    )
    expect(section.view).toBe('redacted')
    expect(JSON.stringify(section)).not.toContain(SECRET)
    expect(JSON.stringify(section)).toContain('Person A')
    expect(JSON.stringify(outline)).not.toContain(SECRET)

    // NOTE: the author's side is `NotFound` for a reviewer, whatever the
    // numbers they guess.
    const refusals = [
      w.refused('carol', c => c.GetReport({ reportId })),
      w.refused('carol', c => c.GetWorkingCopy({ reportId })),
      w.refused('carol', c => c.GetWorkingCopySection({ reportId, sectionId })),
      w.refused('carol', c => c.GetPeople({ reportId })),
      w.refused('carol', c => c.GetPeople({ reportId, draft: 1 })),
      w.refused('carol', c => c.GetHistory({ reportId })),
      w.refused('carol', c => c.ListDrafting({ reportId })),
      w.refused('carol', c => c.StartWorkingCopy({ reportId })),
      w.refused('carol', c => c.ListImages({ reportId })),
      w.refused('carol', c => c.GetRound({ reportId, revision: 1 })),
      w.refused('carol', c => c.ListDraftComments({ reportId, draft: 1 })),
      ...[0, 1, 2, 7].flatMap(draft => [
        w.refused('carol', c => c.GetDraftOutline({ reportId, draft })),
        w.refused('carol', c =>
          c.GetDraftSection({ reportId, draft, sectionId, view: 'original' }),
        ),
        w.refused('carol', c =>
          c.GetDraftSection({ reportId, draft, sectionId, view: 'redacted' }),
        ),
      ]),
    ]
    for (const error of await Promise.all(refusals)) {
      expect(tagOf(error)).toBe('NotFound')
    }
  })

  test('a revision that was not sent to an account is not found, nor are other reports', async () => {
    const w = await world()
    const { reportId } = await w.published()
    const other = await w.createReport('gina', 'unit-2')

    // NOTE: not a participant, a revision that does not exist, an author of
    // another unit and a reviewer asking for a report they are not in.
    const answers = await Promise.all([
      w.refused('frank', c => c.GetRevisionSection({ reportId, revision: 1, sectionId })),
      w.refused('frank', c => c.GetRevisionOutline({ reportId, revision: 1 })),
      w.refused('carol', c => c.GetRevisionSection({ reportId, revision: 2, sectionId })),
      w.refused('carol', c => c.GetRevisionOutline({ reportId, revision: 99 })),
      w.refused('gina', c => c.GetReport({ reportId })),
      w.refused('gina', c => c.GetDraftSection({ reportId, draft: 1, sectionId, view: 'original' })),
      w.refused('gina', c => c.StartWorkingCopy({ reportId })),
      w.refused('gina', c => c.GetHistory({ reportId })),
      w.refused('carol', c => c.GetReport({ reportId: other })),
      w.refused('carol', c => c.GetRevisionSection({ reportId: other, revision: 1, sectionId })),
      w.refused('alice', c => c.GetReport({ reportId: other })),
      w.refused('alice', c => c.GetHistory({ reportId: other })),
    ])
    for (const error of answers) expect(tagOf(error)).toBe('NotFound')
    // NOTE: and a report of their own unit is theirs.
    expect((await w.call('gina', c => c.GetReport({ reportId: other }))).summary.id).toBe(other)
  })

  test('forbidden and does not exist give the same answer', async () => {
    const w = await world()
    const { reportId } = await w.published()
    const forbidden = await w.refused('carol', c =>
      c.GetDraftSection({ reportId, draft: 1, sectionId, view: 'original' }),
    )
    const missing = await w.refused('carol', c =>
      c.GetDraftSection({ reportId: 'no-such-report', draft: 1, sectionId, view: 'original' }),
    )
    const stranger = await w.refused('frank', c =>
      c.GetDraftSection({ reportId, draft: 1, sectionId, view: 'original' }),
    )
    const strangerMissing = await w.refused('frank', c =>
      c.GetDraftSection({ reportId: 'no-such-report', draft: 1, sectionId, view: 'original' }),
    )
    expect(JSON.stringify(forbidden)).toBe(JSON.stringify(missing))
    expect(JSON.stringify(stranger)).toBe(JSON.stringify(strangerMissing))
    expect(JSON.stringify(forbidden)).toBe(JSON.stringify(stranger))
    expect(tagOf(forbidden)).toBe('NotFound')
  })

  test('an author reads the drafts and the working copy as written', async () => {
    const w = await world()
    const { reportId, draft } = await w.published()
    const original = await w.call('alice', c =>
      c.GetDraftSection({ reportId, draft: draft.number, sectionId, view: 'original' }),
    )
    expect(JSON.stringify(original)).toContain(SECRET)
    const redacted = await w.call('alice', c =>
      c.GetDraftSection({ reportId, draft: draft.number, sectionId, view: 'redacted' }),
    )
    expect(JSON.stringify(redacted)).not.toContain(SECRET)
    const people = await w.call('alice', c => c.GetPeople({ reportId, draft: draft.number }))
    expect(people.people).toEqual(PEOPLE)
    const history = await w.call('alice', c => c.GetHistory({ reportId }))
    expect(history.drafts.map(d => d.number)).toEqual([0, 1])
    expect(history.revisions.map(r => r.number)).toEqual([1])
    // NOTE: an author's co-author has no access to the other's working copy,
    // only to their own.
    expect(tagOf(await w.refused('bob', c => c.GetWorkingCopy({ reportId })))).toBe('NotFound')
    const comparison = await w.call('alice', c =>
      c.CompareDrafts({ reportId, from: 0, to: draft.number }),
    )
    expect(comparison.peopleChanged).toBe(true)
    expect(comparison.changes.some(change => change.sectionId === sectionId)).toBe(true)
  })

  if (scenario.fullRole !== undefined) {
    test('a full role reads the original revision but no draft, working copy or people list', async () => {
      const w = await world()
      const { reportId } = await w.published()
      const outline = await w.call('erin', c =>
        c.GetRevisionOutline({ reportId, revision: 1 }),
      )
      expect(outline.view).toBe('full')
      expect(outline.caseTitle).toContain(SECRET)
      const section = await w.call('erin', c =>
        c.GetRevisionSection({ reportId, revision: 1, sectionId }),
      )
      expect(section.view).toBe('full')
      expect(JSON.stringify(section)).toContain(SECRET)
      const refusals = await Promise.all([
        w.refused('erin', c => c.GetDraftOutline({ reportId, draft: 1 })),
        w.refused('erin', c =>
          c.GetDraftSection({ reportId, draft: 1, sectionId, view: 'original' }),
        ),
        w.refused('erin', c => c.GetWorkingCopy({ reportId })),
        w.refused('erin', c => c.GetWorkingCopySection({ reportId, sectionId })),
        w.refused('erin', c => c.GetPeople({ reportId })),
        w.refused('erin', c => c.GetPeople({ reportId, draft: 1 })),
        w.refused('erin', c => c.GetHistory({ reportId })),
        w.refused('erin', c => c.StartWorkingCopy({ reportId })),
        w.refused('erin', c => c.GetReport({ reportId })),
      ])
      for (const error of refusals) expect(tagOf(error)).toBe('NotFound')
    })

    test('a comment of a full reviewer reaches a redacted reader as a note on the section', async () => {
      const w = await world()
      const { reportId } = await w.published()
      await w.call('erin', c =>
        c.AddComment({
          reportId,
          revision: 1,
          anchor: { kind: 'text', sectionId, itemId, from: 0, to: 10, quoted: 'Ana Garcia' },
          body: 'Ana Garcia should be asked again.',
          visibility: 'committee',
        }),
      )
      const own = await w.call('erin', c => c.ListReviewerComments({ reportId, revision: 1 }))
      expect(own[0]?.anchor.kind).toBe('text')
      await w.sendReview('erin', reportId, 1, 'approve')
      const seen = await w.call('carol', c => c.ListReviewerComments({ reportId, revision: 1 }))
      expect(seen).toHaveLength(1)
      expect(seen[0]?.anchor.kind).toBe('section_note')
      expect(JSON.stringify(seen)).not.toContain(SECRET)
      expect(JSON.stringify(seen)).toContain('Person A')
      expect(JSON.stringify(seen)).not.toMatch(/\bAna\b/)
      expect(JSON.stringify(seen)).not.toContain('Garcia')
      const authors = await w.call('alice', c => c.ListRevisionComments({ reportId, revision: 1 }))
      expect(authors[0]?.body).toContain(SECRET)
      expect(authors[0]?.redactedBody).not.toContain(SECRET)
    })
  }

  test('the people list is fixed for the whole share: a change in between refuses the finish, and the confirmed hash covers it', async () => {
    const w = await world()
    const reportId = await w.createReport()
    const started = await w.call('alice', c => c.StartWorkingCopy({ reportId }))
    const withPeople = await w.call('alice', c =>
      c.SavePeople({ reportId, saveCounter: started.saveCounter, people: PEOPLE }),
    )
    const saved = await w.call('alice', c =>
      c.SaveSection({ reportId, sectionId, saveCounter: withPeople.saveCounter, content: richContent(itemId, TEXT) }),
    )
    const staged = await w.call('alice', c =>
      c.ShareSection({ reportId, shareId: 'share-p', sectionId, saveCounter: saved.saveCounter }),
    )
    expect(staged.peopleHash).not.toBe('')
    // NOTE: the author empties the people list while the share is staged.
    const changed = await w.call('alice', c =>
      c.SavePeople({ reportId, saveCounter: saved.saveCounter, people: [] }),
    )
    const refused = await w.refused('alice', c =>
      c.FinishShare({ reportId, shareId: 'share-p', saveCounter: changed.saveCounter }),
    )
    expect(['Conflict', 'Validation']).toContain(tagOf(refused))
    // NOTE: the hash seen before the change no longer confirms anything.
    const seen = await sha256Hex(`${staged.redactedHash}|${staged.peopleHash}`)
    const confirmed = await w.refused('alice', c =>
      c.FinishShare({ reportId, shareId: 'share-p', saveCounter: changed.saveCounter, redactionHash: seen }),
    )
    expect(['Conflict', 'Validation']).toContain(tagOf(confirmed))
    // NOTE: sharing again as a whole works, with the people as they are now.
    const again = await w.stageAndFinish('alice', reportId, 'share-q', changed.saveCounter, true)
    expect(again.outcome.kind).toBe('shared')
  })

  test('an account outside the unit registry in a publish selection is a validation error, not a storage failure', async () => {
    const w = await world()
    const reportId = await w.createReport()
    const { outcome } = await w.share('alice', reportId, { shareId: 'share-u', people: PEOPLE, confirm: true })
    if (outcome.kind !== 'shared') throw new Error('not shared')
    const refused = await w.refused('alice', c =>
      c.PublishRevision({
        reportId,
        draft: outcome.draft.number,
        terms: {
          deadline: w.deadline(),
          selections: [{ roleId: scenario.redactedRole, sources: [{ kind: 'account', accountId: 'frank' }] }],
          closing: false,
        },
      }),
    )
    expect(tagOf(refused)).toBe('Validation')
    expect(JSON.stringify(refused)).toContain('unknown_person')
  })

  test('the cleanup for the notification pass removes an unreferenced image after a day, and nothing a draft uses', async () => {
    const w = await world()
    const reportId = await w.createReport()
    const png = makePng()
    const query = (id: string) =>
      `uploadId=${id}&owner=${reportId}&index=0&chunks=1&mime=image%2Fpng&width=1&height=1&size=${png.length}`
    expect((await w.raw('alice', `/api/images?${query('img-stray')}`, { method: 'POST', body: png })).status).toBe(200)
    const run = () =>
      Effect.runPromise(
        cleanupStale().pipe(Effect.provide(w.deps)) as Effect.Effect<{ images: number; staged: number }>,
      )
    expect(await run()).toEqual({ images: 0, staged: 0 })
    w.clock.advance(25 * 3_600_000)
    expect((await run()).images).toBe(1)
    expect((await w.raw('alice', '/api/images/img-stray/0?context=working_copy')).status).toBe(404)
  })

  test('a replaced theme logo is cleaned up after a day, the current one never', async () => {
    const w = await world()
    const png = makePng()
    const upload = async (id: string) => {
      const query = `uploadId=${id}&owner=theme&index=0&chunks=1&mime=image%2Fpng&width=1&height=1&size=${png.length}`
      expect((await w.raw('adam', `/api/images?${query}`, { method: 'POST', body: png })).status).toBe(200)
    }
    await upload('logo-old')
    await w.call('adam', c => c.UpdateTheme({ theme: { ...DEFAULT_THEME, logo: 'logo-old' } }))
    await upload('logo-new')
    await w.call('adam', c => c.UpdateTheme({ theme: { ...DEFAULT_THEME, logo: 'logo-new' } }))
    w.clock.advance(25 * 3_600_000)
    const cleaned = await Effect.runPromise(
      cleanupStale().pipe(Effect.provide(w.deps)) as Effect.Effect<{ images: number; staged: number }>,
    )
    expect(cleaned.images).toBe(1)
    expect((await w.raw('alice', '/api/images/logo-old/0?context=theme')).status).toBe(404)
    expect((await w.raw('alice', '/api/images/logo-new/0?context=theme')).status).toBe(200)
  })

  test('a malformed percent-encoding in an image path is a bad request, and a retried chunk upload is idempotent', async () => {
    const w = await world()
    const reportId = await w.createReport()
    const bad = await w.raw('alice', '/api/images/%E0%A4%A/0?context=working_copy')
    expect(bad.status).toBe(400)
    const png = makePng()
    const query = `uploadId=img-1&owner=${reportId}&index=0&chunks=1&mime=image%2Fpng&width=1&height=1&size=${png.length}`
    const first = await w.raw('alice', `/api/images?${query}`, { method: 'POST', body: png })
    const retry = await w.raw('alice', `/api/images?${query}`, { method: 'POST', body: png })
    expect(first.status).toBe(200)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ uploadId: 'img-1', complete: true })
  })

  test('an image not marked safe is never served to a redacted role', async () => {
    const w = await world()
    const reportId = await w.createReport()
    const png = makePng()
    const query = `uploadId=img-1&owner=${reportId}&index=0&chunks=1&mime=image%2Fpng&width=1&height=1&size=${png.length}`
    const uploaded = await w.raw('alice', `/api/images?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: png,
    })
    expect(uploaded.status).toBe(200)
    expect(await uploaded.json()).toMatchObject({ uploadId: 'img-1', complete: true })
    // NOTE: not a picture, too big, and not the author's: refused.
    const notPng = await w.raw('alice', `/api/images?${query.replace('img-1', 'img-2')}`, {
      method: 'POST',
      body: new Uint8Array(50),
    })
    expect(notPng.status).toBe(415)
    const stranger = await w.raw('carol', `/api/images?${query.replace('img-1', 'img-3')}`, {
      method: 'POST',
      body: png,
    })
    expect(stranger.status).toBe(404)

    const first = await w.share('alice', reportId, {
      shareId: 'share-1',
      people: PEOPLE,
      content: withFigure(itemId, TEXT, 'img-1', false) as unknown as ReturnType<typeof richContent>,
    })
    if (first.outcome.kind !== 'shared') throw new Error('not shared')
    await w.publish('alice', reportId, first.outcome.draft.number)

    const read = (who: 'alice' | 'carol' | 'erin' | 'frank', context: string) =>
      w.raw(who, `/api/images/img-1/0?report=${reportId}&${context}`)
    expect((await read('carol', 'context=revision&revision=1')).status).toBe(404)
    expect((await read('carol', 'context=draft&draft=1')).status).toBe(404)
    expect((await read('carol', 'context=working_copy')).status).toBe(404)
    expect((await read('frank', 'context=revision&revision=1')).status).toBe(404)
    expect((await read('alice', 'context=working_copy')).status).toBe(200)
    expect((await read('alice', 'context=draft&draft=1')).status).toBe(200)
    if (scenario.fullRole !== undefined) {
      expect((await read('erin', 'context=revision&revision=1')).status).toBe(200)
    }
    const text = await w.call('carol', c =>
      c.GetRevisionSection({ reportId, revision: 1, sectionId }),
    )
    expect(JSON.stringify(text)).not.toContain('img-1')

    // NOTE: once the author marks it safe and sends a new draft, the next
    // revision serves it to the redacted role; the first never does.
    const copy = await w.call('alice', c => c.GetWorkingCopy({ reportId }))
    const images = await w.call('alice', c => c.ListImages({ reportId }))
    expect(images.images[0]).toMatchObject({ id: 'img-1', safeToShare: false })
    const marked = await w.call('alice', c =>
      c.MarkImageSafe({ reportId, imageId: 'img-1', safe: true, saveCounter: copy.saveCounter }),
    )
    expect(marked.sections).toEqual([sectionId])
    const second = await w.stageAndFinish('alice', reportId, 'share-2', marked.saveCounter)
    if (second.outcome.kind !== 'shared') throw new Error('not shared')
    await w.publish('alice', reportId, second.outcome.draft.number)
    expect((await read('carol', 'context=revision&revision=2')).status).toBe(200)
    expect((await read('carol', 'context=revision&revision=1')).status).toBe(404)
    const served = (await (await read('carol', 'context=revision&revision=2')).json()) as {
      base64: string
    }
    expect(served.base64.length).toBeGreaterThan(0)

    // NOTE: unmarking is the same single flag: the picture is listed as not
    // safe and the next revision no longer serves it to the redacted role.
    const again = await w.call('alice', c => c.GetWorkingCopy({ reportId }))
    const unmarked = await w.call('alice', c =>
      c.MarkImageSafe({ reportId, imageId: 'img-1', safe: false, saveCounter: again.saveCounter }),
    )
    expect(unmarked.sections).toEqual([sectionId])
    const after = await w.call('alice', c => c.ListImages({ reportId }))
    expect(after.images[0]).toMatchObject({ id: 'img-1', safeToShare: false })
    // NOTE: withdrawing is immediate, with no new share: a redacted reviewer
    // of the revision that served it a moment ago gets 404 at once.
    expect((await read('carol', 'context=revision&revision=2')).status).toBe(404)
    const third = await w.stageAndFinish('alice', reportId, 'share-3', unmarked.saveCounter)
    if (third.outcome.kind !== 'shared') throw new Error('not shared')
    await w.publish('alice', reportId, third.outcome.draft.number)
    expect((await read('carol', 'context=revision&revision=3')).status).toBe(404)
    // NOTE: a published revision is immutable, but serving an image to a
    // redacted role needs the picture marked safe in that revision's draft AND
    // in the latest draft: withdrawn later, revision 2 no longer serves it.
    expect((await read('carol', 'context=revision&revision=2')).status).toBe(404)
    // NOTE: the original view of the full role is unaffected by the flag.
    if (scenario.fullRole !== undefined) {
      expect((await read('erin', 'context=revision&revision=2')).status).toBe(200)
    }
  })

  test('a case title changed after the preview is not the share the author confirmed', async () => {
    const w = await world()
    const reportId = await w.createReport()
    const started = await w.call('alice', c => c.StartWorkingCopy({ reportId }))
    const people = await w.call('alice', c =>
      c.SavePeople({ reportId, saveCounter: started.saveCounter, people: PEOPLE }),
    )
    const saved = await w.call('alice', c =>
      c.SaveSection({
        reportId,
        sectionId,
        saveCounter: people.saveCounter,
        content: richContent(itemId, TEXT),
      }),
    )
    const stage = async () => {
      const outline = await w.call('alice', c => c.GetWorkingCopy({ reportId }))
      const hashes: Array<string> = []
      let peopleHash = ''
      let caseHash = ''
      for (const section of outline.sections) {
        const staged = await w.call('alice', c =>
          c.ShareSection({ reportId, shareId: 'share-case', sectionId: section.sectionId, saveCounter: saved.saveCounter }),
        )
        hashes.push(staged.redactedHash)
        peopleHash = staged.peopleHash
        caseHash = staged.caseHash
      }
      return sha256Hex(`${hashes.join(',')}|${peopleHash}|${caseHash}`)
    }
    const seen = await stage()
    const files = await w.call('alice', c => c.ListCaseFiles({ unit: 'unit-1' }))
    const caseFileId = files[0]?.id ?? ''
    await w.call('alice', c => c.UpdateCaseFile({ caseFileId, title: 'Another title entirely' }))
    const refused = await w.refused('alice', c =>
      c.FinishShare({ reportId, shareId: 'share-case', saveCounter: saved.saveCounter, redactionHash: seen }),
    )
    expect(JSON.stringify(refused)).toContain('redaction_not_confirmed')
    // NOTE: staged again with the new title, the confirmation covers it.
    const again = await stage()
    const outcome = await w.call('alice', c =>
      c.FinishShare({ reportId, shareId: 'share-case', saveCounter: saved.saveCounter, redactionHash: again }),
    )
    expect(outcome.kind).toBe('shared')
  })

  test('sharing refuses a people list with a problem, however it got into the working copy', async () => {
    const w = await world()
    const reportId = await w.createReport()
    const started = await w.call('alice', c => c.StartWorkingCopy({ reportId }))
    const bad = JSON.stringify([
      { id: 'a', name: 'Ana Garcia', label: 'Person A', aliases: [] },
      { id: 'b', name: 'Bo Mensah', label: 'Person A', aliases: [] },
    ])
    const saved = await Effect.runPromise(
      w.repository.saveWorkingCopy({
        reportId,
        userId: 'alice',
        expectedCounter: started.saveCounter,
        sections: [],
        people: bad,
        now: 5,
      }) as Effect.Effect<{ _tag: string; saveCounter: number }>,
    )
    expect(saved._tag).toBe('Saved')
    const refusedStage = await w.refused('alice', c =>
      c.ShareSection({ reportId, shareId: 'share-bad', sectionId, saveCounter: saved.saveCounter }),
    )
    expect(tagOf(refusedStage)).toBe('Validation')
    const refusedFinish = await w.refused('alice', c =>
      c.FinishShare({ reportId, shareId: 'share-bad', saveCounter: saved.saveCounter }),
    )
    expect(tagOf(refusedFinish)).toBe('Validation')
  })

  test('two concurrent shares on the same base give one draft and one comparison', async () => {
    const w = await world()
    const reportId = await w.createReport()
    // NOTE: adding a co-author is a later stage's procedure; the repository
    // does it here.
    const added = await Effect.runPromise(
      w.repository.addMember({
        reportId,
        userId: 'bob',
        roleId: scenario.authorsRole,
        addedBy: 'alice',
        now: 1,
        audit: { at: 1, actorId: 'alice', action: 'report.member_added', reportId },
      }) as Effect.Effect<{ _tag: string }>,
    )
    expect(added._tag).toBe('Added')
    const prepare = async (who: 'alice' | 'bob', text: string, shareId: string) => {
      const started = await w.call(who, c => c.StartWorkingCopy({ reportId }))
      const saved = await w.call(who, c =>
        c.SaveSection({
          reportId,
          sectionId,
          saveCounter: started.saveCounter,
          content: richContent(itemId, text),
        }),
      )
      const outline = await w.call(who, c => c.GetWorkingCopy({ reportId }))
      for (const section of outline.sections) {
        await w.call(who, c =>
          c.ShareSection({ reportId, shareId, sectionId: section.sectionId, saveCounter: saved.saveCounter }),
        )
      }
      return saved.saveCounter
    }
    const aliceCounter = await prepare('alice', 'Alice wrote this.', 'share-a')
    const bobCounter = await prepare('bob', 'Bob wrote this.', 'share-b')
    w.measure(false)
    const [fromAlice, fromBob] = await Promise.all([
      w.call('alice', c => c.FinishShare({ reportId, shareId: 'share-a', saveCounter: aliceCounter })),
      w.call('bob', c => c.FinishShare({ reportId, shareId: 'share-b', saveCounter: bobCounter })),
    ])
    w.measure(true)
    expect([fromAlice.kind, fromBob.kind].sort()).toEqual(['shared', 'stale_base'])
    const loser = fromAlice.kind === 'stale_base' ? 'alice' : 'bob'
    const stale = fromAlice.kind === 'stale_base' ? fromAlice : fromBob
    if (stale.kind !== 'stale_base') throw new Error('unreachable')
    expect(stale.latestDraft).toBe(1)
    expect(stale.comparison.baseDraft).toBe(0)
    expect(stale.comparison.theirsDraft).toBe(1)
    expect(stale.comparison.conflicts.length).toBeGreaterThan(0)
    // NOTE: both changed the same item, so nothing was taken without a choice.
    expect(stale.comparison.automatic).toEqual([])

    const history = await w.call('alice', c => c.GetHistory({ reportId }))
    expect(history.drafts.map(d => d.number)).toEqual([0, 1])

    // NOTE: the one who lost compares, chooses and shares again: Draft 2.
    const preview = await w.call(loser, c => c.PreviewMerge({ reportId }))
    expect(preview.conflicts.map(entry => entry.key)).toEqual(
      stale.comparison.conflicts.map(entry => entry.key),
    )
    const copy = await w.call(loser, c => c.GetWorkingCopy({ reportId }))
    expect(copy.behind).toBe(true)
    const resolved = await w.call(loser, c =>
      c.ResolveMerge({
        reportId,
        saveCounter: copy.saveCounter,
        choices: Object.fromEntries(preview.conflicts.map(entry => [entry.key, 'ours' as const])),
      }),
    )
    expect(resolved.baseDraft).toBe(1)
    expect(resolved.behind).toBe(false)
    const again = await w.stageAndFinish(loser, reportId, 'share-c', resolved.saveCounter)
    expect(again.outcome.kind).toBe('shared')
    const after = await w.call('alice', c => c.GetHistory({ reportId }))
    expect(after.drafts.map(d => d.number)).toEqual([0, 1, 2])
  })

  test('comments are seen by their visibility, and only after the review is sent', async () => {
    const w = await world()
    const { reportId } = await w.published()
    const anchor = { kind: 'section' as const, sectionId }
    await w.call('carol', c =>
      c.AddComment({ reportId, revision: 1, anchor, body: 'Only for the authors.', visibility: 'authors' }),
    )
    const shared = await w.call('carol', c =>
      c.AddComment({ reportId, revision: 1, anchor, body: 'For the committee.', visibility: 'committee' }),
    )
    // NOTE: pending: only the writer sees anything.
    expect(await w.call('dan', c => c.ListReviewerComments({ reportId, revision: 1 }))).toEqual([])
    expect(await w.call('alice', c => c.ListRevisionComments({ reportId, revision: 1 }))).toEqual([])
    const own = await w.call('carol', c => c.ListReviewerComments({ reportId, revision: 1 }))
    expect(own.map(entry => entry.body).sort()).toEqual(['For the committee.', 'Only for the authors.'])
    expect(own.every(entry => entry.sent === false && entry.mine)).toBe(true)
    expect(tagOf(await w.refused('dan', c => c.UpdatePendingComment({ reportId, commentId: shared.id, body: 'Mine now.' })))).toBe('NotFound')
    expect(tagOf(await w.refused('alice', c => c.AddComment({ reportId, revision: 1, anchor, body: 'An author.', visibility: 'authors' })))).toBe('NotPermitted')

    const edited = await w.call('carol', c =>
      c.UpdatePendingComment({ reportId, commentId: shared.id, body: 'For the committee, edited.' }),
    )
    expect(edited.body).toBe('For the committee, edited.')
    const result = await w.sendReview('carol', reportId, 1, 'comment')
    expect(result.commentsSent).toBe(2)

    const seenByDan = await w.call('dan', c => c.ListReviewerComments({ reportId, revision: 1 }))
    expect(seenByDan.map(entry => entry.body)).toEqual(['For the committee, edited.'])
    expect(seenByDan[0]).toMatchObject({ mine: false, sent: true, authorName: 'Carol Reviewer' })
    const seenByAuthors = await w.call('alice', c => c.ListRevisionComments({ reportId, revision: 1 }))
    expect(seenByAuthors).toHaveLength(2)
    expect(await w.refused('frank', c => c.ListReviewerComments({ reportId, revision: 1 }))).toMatchObject({ _tag: 'NotFound' })
    expect(tagOf(await w.refused('carol', c => c.UpdatePendingComment({ reportId, commentId: shared.id, body: 'Too late.' })))).toBe('Conflict')

    // NOTE: an author replies; the reply follows its comment.
    const reply = await w.call('alice', c =>
      c.ReplyToComment({ reportId, commentId: shared.id, body: 'Thank you, Ana Garcia will be asked.' }),
    )
    expect(reply.replies).toHaveLength(1)
    const dansView = await w.call('dan', c => c.ListReviewerComments({ reportId, revision: 1 }))
    expect(dansView[0]?.replies).toHaveLength(1)
    expect(JSON.stringify(dansView)).not.toContain(SECRET)
    const resolved = await w.call('alice', c =>
      c.ResolveComment({ reportId, commentId: shared.id, resolved: true }),
    )
    expect(resolved.resolved).toBe(true)
  })

  test('authors comment on a draft, reply and resolve among themselves; no reviewer sees or touches them', async () => {
    const w = await world()
    const { reportId, draft } = await w.published()
    await w.call('alice', c => c.AddCoAuthor({ reportId, accountId: 'bob' }))
    const quoted = TEXT.slice(0, 4)
    const anchor = { kind: 'text' as const, sectionId, itemId, from: 0, to: quoted.length, quoted }
    const mayComment = scenario.template.roles
      .find(role => role.id === scenario.authorsRole)
      ?.permissions.includes('comment_drafts')
    // NOTE: the built-in template gives its drafting role `comment_drafts`, the
    // invented panel template leaves it out. Asserted, so a change to either
    // template fails here instead of silently taking the other branch.
    expect(mayComment).toBe(scenario.template.id === INTAKE_TEMPLATE.id)
    if (mayComment !== true) {
      expect(
        tagOf(await w.refused('bob', c => c.AddDraftComment({ reportId, draft: draft.number, anchor, body: 'No.' }))),
      ).toBe('NotPermitted')
      return
    }
    const made = await w.call('bob', c =>
      c.AddDraftComment({ reportId, draft: draft.number, anchor, body: 'Please check this phrase.' }),
    )
    expect(made).toMatchObject({ authorName: 'Bob Author', resolved: false, visibility: 'authors', anchor: { quoted } })
    const seen = await w.call('alice', c => c.ListDraftComments({ reportId, draft: draft.number }))
    expect(seen.map(entry => entry.id)).toEqual([made.id])
    const section = await w.call('alice', c =>
      c.AddDraftComment({ reportId, draft: draft.number, anchor: { kind: 'section', sectionId }, body: 'A note on the whole section.' }),
    )
    expect(section.anchor).toEqual({ kind: 'section', sectionId })

    const replied = await w.call('alice', c =>
      c.ReplyToComment({ reportId, commentId: made.id, body: 'Done, thank you.' }),
    )
    expect(replied.replies.map(reply => reply.authorName)).toEqual(['Alice Author'])
    const resolved = await w.call('alice', c =>
      c.ResolveComment({ reportId, commentId: made.id, resolved: true }),
    )
    expect(resolved.resolved).toBe(true)
    expect(
      (await w.call('bob', c => c.ListDraftComments({ reportId, draft: draft.number }))).find(entry => entry.id === made.id)
        ?.resolved,
    ).toBe(true)
    const reopened = await w.call('bob', c => c.ResolveComment({ reportId, commentId: made.id, resolved: false }))
    expect(reopened.resolved).toBe(false)

    // NOTE: a reviewer (and a stranger) is told nothing: the comments of a
    // draft answer exactly like a draft that does not exist.
    for (const who of ['carol', 'frank'] as const) {
      const answers = await Promise.all([
        w.refused(who, c => c.ListDraftComments({ reportId, draft: draft.number })),
        w.refused(who, c => c.AddDraftComment({ reportId, draft: draft.number, anchor, body: 'Hello.' })),
        w.refused(who, c => c.ResolveComment({ reportId, commentId: made.id, resolved: true })),
        w.refused(who, c => c.ReplyToComment({ reportId, commentId: made.id, body: 'Hello.' })),
      ])
      for (const error of answers) expect(tagOf(error)).toBe('NotFound')
    }
    const reviewerSide = await w.call('carol', c => c.ListReviewerComments({ reportId, revision: 1 }))
    expect(JSON.stringify(reviewerSide)).not.toContain('Please check this phrase')
    expect((await w.call('alice', c => c.ListDraftComments({ reportId, draft: draft.number }))).find(entry => entry.id === made.id)?.resolved).toBe(false)
  })

  test('deadlines are settled on every read and refuse late writes', async () => {
    const w = await world()
    const { reportId } = await w.published()
    expect((await w.call('alice', c => c.GetReport({ reportId }))).summary.state).toBe('in_review')
    w.clock.advance(8 * 24 * 3_600_000)
    const late = await Promise.all([
      w.refused('carol', c =>
        c.AddComment({ reportId, revision: 1, anchor: { kind: 'section', sectionId }, body: 'Late.', visibility: 'authors' }),
      ),
      w.refused('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' })),
    ])
    expect(late[0]).toMatchObject({ _tag: 'DeadlinePassed' })
    expect(late[1]).toMatchObject({ _tag: 'NotAllowedInState', state: 'decided' })
    const round = await w.call('alice', c => c.GetRound({ reportId, revision: 1 }))
    expect(round).toMatchObject({ status: 'decided', decidedBy: 'deadline' })
    expect((await w.call('alice', c => c.GetReport({ reportId }))).summary.state).toBe('decided')
  })

  test('the report list holds only the caller’s reports, and the inbox only their rounds', async () => {
    const w = await world()
    const { reportId } = await w.published()
    const other = await w.createReport('gina', 'unit-2')
    expect((await w.call('alice', c => c.ListReports({}))).map(r => r.id)).toEqual([reportId])
    expect((await w.call('gina', c => c.ListReports({}))).map(r => r.id)).toEqual([other])
    expect(await w.call('carol', c => c.ListReports({}))).toEqual([])
    expect(await w.call('frank', c => c.ListInbox({}))).toEqual({ items: [] })
    const { items: inbox } = await w.call('carol', c => c.ListInbox({}))
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({ reportId, revision: 1, status: 'open', hasPending: false })
    expect(JSON.stringify(inbox)).not.toContain(SECRET)
    expect(tagOf(await w.refused('carol', c => c.ListCaseFiles({ unit: 'unit-1' })))).toBe('NotPermitted')
    expect(tagOf(await w.refused('gina', c => c.ListCaseFiles({ unit: 'unit-1' })))).toBe('NotPermitted')
    expect(await w.call('alice', c => c.ListCaseFiles({ unit: 'unit-1' }))).toHaveLength(1)
  })

  test('saving checks the counter, the section and the content', async () => {
    const w = await world()
    const reportId = await w.createReport()
    const started = await w.call('alice', c => c.StartWorkingCopy({ reportId }))
    expect(started).toMatchObject({ baseDraft: 0, behind: false, saveCounter: 0 })
    const saved = await w.call('alice', c =>
      c.SaveSection({ reportId, sectionId, saveCounter: 0, content: richContent(itemId, TEXT) }),
    )
    expect(saved.saveCounter).toBe(1)
    // NOTE: a second tab with the old counter does not overwrite the first.
    expect(await w.refused('alice', c =>
      c.SaveSection({ reportId, sectionId, saveCounter: 0, content: richContent(itemId, 'Other.') }),
    )).toMatchObject({ _tag: 'Conflict', reason: 'stale_save' })
    expect(tagOf(await w.refused('alice', c =>
      c.SaveSection({ reportId, sectionId: 'no-such-section', saveCounter: 1, content: richContent(itemId, 'x') }),
    ))).toMatch(/NotAllowedInState|NotFound/)
    expect(tagOf(await w.refused('alice', c =>
      c.SaveSection({ reportId, sectionId, saveCounter: 1, content: richContent('no-such-item', 'x') }),
    ))).toBe('Validation')
    const read = await w.call('alice', c => c.GetWorkingCopySection({ reportId, sectionId }))
    expect(JSON.stringify(read.content)).toContain(SECRET)
  })

  if (scenario.conclusion !== undefined) {
    const conclusion = scenario.conclusion
    test('while concluding only the conclusion may differ from the revision being closed', async () => {
      const w = await world()
      const { reportId } = await w.published()
      await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
      await w.call('dan', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
      expect((await w.call('alice', c => c.GetReport({ reportId }))).summary.state).toBe('decided')

      // NOTE: an edit of another section, made before concluding, stays unshared.
      const copy = await w.call('alice', c => c.GetWorkingCopy({ reportId }))
      const edited = await w.call('alice', c =>
        c.SaveSection({ reportId, sectionId, saveCounter: copy.saveCounter, content: richContent(itemId, 'Changed after the round.') }),
      )
      const concluding = await w.call('alice', c => c.StartConclusion({ reportId }))
      expect(concluding.state).toBe('concluding')
      expect(tagOf(await w.refused('alice', c =>
        c.SaveSection({ reportId, sectionId, saveCounter: edited.saveCounter, content: richContent(itemId, 'No.') }),
      ))).toBe('NotAllowedInState')
      expect(tagOf(await w.refused('alice', c =>
        c.SavePeople({ reportId, saveCounter: edited.saveCounter, people: PEOPLE }),
      ))).toBe('NotAllowedInState')
      const saved = await w.call('alice', c =>
        c.SaveSection({
          reportId,
          sectionId: conclusion.sectionId,
          saveCounter: edited.saveCounter,
          content: richContent(conclusion.itemId, 'The committee decided.'),
        }),
      )
      const stage = async (shareId: string, counter: number) => {
        const outline = await w.call('alice', c => c.GetWorkingCopy({ reportId }))
        const hashes: Array<string> = []
        let peopleHash = ''
        let caseHash = ''
        for (const section of outline.sections) {
          const staged = await w.call('alice', c =>
            c.ShareSection({ reportId, shareId, sectionId: section.sectionId, saveCounter: counter }),
          )
          hashes.push(staged.redactedHash)
          peopleHash = staged.peopleHash
          caseHash = staged.caseHash
        }
        return sha256Hex(`${hashes.join(',')}|${peopleHash}|${caseHash}`)
      }
      await stage('share-2', saved.saveCounter)
      const refused = await w.refused('alice', c =>
        c.FinishShare({ reportId, shareId: 'share-2', saveCounter: saved.saveCounter }),
      )
      expect(refused).toMatchObject({ _tag: 'Validation' })
      expect(JSON.stringify(refused)).toContain('other_sections_changed')

      // NOTE: starting the working copy again from the latest draft drops the
      // other edit; the conclusion is written again and the share goes through
      // and closes the report in one batch ("share and publish").
      await w.call('alice', c => c.StartWorkingCopy({ reportId, replace: true }))
      const fresh = await w.call('alice', c => c.GetWorkingCopy({ reportId }))
      const reverted = await w.call('alice', c =>
        c.SaveSection({
          reportId,
          sectionId: conclusion.sectionId,
          saveCounter: fresh.saveCounter,
          content: richContent(conclusion.itemId, 'The committee decided.'),
        }),
      )
      const seen = await stage('share-3', reverted.saveCounter)
      const outcome = await w.call('alice', c =>
        c.FinishShare({
          reportId,
          shareId: 'share-3',
          saveCounter: reverted.saveCounter,
          redactionHash: seen,
          publish: { deadline: w.deadline(), selections: w.selections(), closing: true },
        }),
      )
      if (outcome.kind !== 'shared') throw new Error('not shared')
      expect(outcome.draft.number).toBe(2)
      expect(outcome.revision).toMatchObject({ number: 2, closing: true, status: 'open' })
      expect((await w.call('alice', c => c.GetReport({ reportId }))).summary.state).toBe('concluding')
      const closing = await w.call('carol', c => c.GetRevisionOutline({ reportId, revision: 2 }))
      expect(closing.closing).toBe(true)
      expect(JSON.stringify(closing)).not.toContain(SECRET)
    })
  }

  if (scenario.backend === 'sqlite') {
    test('list procedures run a constant number of queries, however many reports there are', async () => {
      const w = await world()
      const { reportId } = await w.published()
      for (let i = 0; i < 4; i += 1) await w.createReport('alice')
      const cost = async <A>(run: () => Promise<A>) => {
        const before = w.queries()
        await run()
        return w.queries() - before
      }
      const lists: Record<string, () => Promise<unknown>> = {
        ListReports: () => w.call('alice', c => c.ListReports({})),
        ListCaseFiles: () => w.call('alice', c => c.ListCaseFiles({ unit: 'unit-1' })),
        ListNotifications: () => w.call('carol', c => c.ListNotifications({ limit: 20 })),
        ListInbox: () => w.call('carol', c => c.ListInbox({})),
        ListPendingReviews: () => w.call('carol', c => c.ListPendingReviews()),
        ListPublishedTemplates: () => w.call('alice', c => c.ListPublishedTemplates()),
        ListTemplates: () => w.call('tess', c => c.ListTemplates({})),
        ListReviewers: () => w.call('alice', c => c.ListReviewers({ unit: 'unit-1' })),
        ListUnitMembers: () => w.call('alice', c => c.ListUnitMembers({ unit: 'unit-1' })),
        ListCommittees: () => w.call('alice', c => c.ListCommittees({ unit: 'unit-1' })),
        ListUnits: () => w.call('adam', c => c.ListUnits()),
        ListAccounts: () => w.call('adam', c => c.ListAccounts()),
        GetGrid: () => w.call('alice', c => c.GetGrid({ reportId })),
        ListWhatsAppLinks: () => w.call('alice', c => c.ListWhatsAppLinks({ reportId, revision: 1 })),
        RecordWhatsAppOpened: () =>
          w.call('alice', c => c.RecordWhatsAppOpened({ reportId, revision: 1, accountId: 'carol' }).pipe(Effect.ignore)),
        ListAuditEventsOfKind: () =>
          w.call('alice', c =>
            c.ListAuditEvents({ subject: { kind: 'report', reportId }, kind: 'revision', limit: 20 }),
          ),
        ListAuditEvents: () =>
          w.call('alice', c => c.ListAuditEvents({ subject: { kind: 'report', reportId }, limit: 20 })),
      }
      const few: Record<string, number> = {}
      for (const [name, run] of Object.entries(lists)) few[name] = await cost(run)
      for (let i = 0; i < 56; i += 1) await w.createReport('alice')
      expect(await w.call('alice', c => c.ListReports({}))).toHaveLength(40)
      for (const [name, run] of Object.entries(lists)) {
        const many = await cost(run)
        expect(many, name).toBe(few[name])
        expect(many, name).toBeLessThanOrEqual(50)
      }
      // NOTE: adding a co-author is a fixed number of queries too.
      expect(await cost(() => w.call('alice', c => c.AddCoAuthor({ reportId, accountId: 'bob' })))).toBeLessThanOrEqual(50)
    })

    test('every request stays within the 50 queries of a Workers Free invocation', async () => {
      const w = await world()
      const { reportId } = await w.published()
      await w.call('alice', c => c.GetHistory({ reportId }))
      await w.call('alice', c => c.GetDraftOutline({ reportId, draft: 1 }))
      await w.call('alice', c => c.GetWorkingCopy({ reportId }))
      await w.call('carol', c => c.GetRevisionOutline({ reportId, revision: 1 }))
      await w.call('carol', c => c.ListInbox({}))
      await w.call('carol', c =>
        c.AddComment({ reportId, revision: 1, anchor: { kind: 'section', sectionId }, body: 'Budget.', visibility: 'committee' }),
      )
      await w.sendReview('carol', reportId, 1, 'approve')
      await w.call('dan', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
      expect(w.worstRequest()).toBeGreaterThan(0)
      expect(w.worstRequest()).toBeLessThanOrEqual(50)
    })
  }
})
