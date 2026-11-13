import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'

import type { NotificationJob } from '../notifications'
import {
  type AuditInput,
  type ImageChunkInput,
  type PublishInput,
  type ReportRepositoryApi,
} from '../report-repository'
import type { RepositoryError } from '../repository'

// NOTE: one contract for every ReportRepository: the in-memory twin, the SQL
// implementation on Node SQLite, on the D1 batch model and on workerd's
// Durable Object SQLite. All data is synthetic.

export interface ReportHarness {
  readonly repository: ReportRepositoryApi
  // NOTE: sessions live in the iteration-1 `sessions` table; the contract
  // only needs to put some in and count them (consumeInvitation ends them).
  readonly seedSession: (tokenHash: string, userId: string) => Promise<void>
  readonly countSessions: (userId: string) => Promise<number>
}

export interface HarnessOptions {
  // NOTE: bytes already counted against the 400 MB guard.
  readonly initialImageBytes?: number
}

export type HarnessFactory = (
  options?: HarnessOptions,
) => ReportHarness | Promise<ReportHarness>

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// NOTE: no `toBase64` on older Node, and the domain has no Buffer.
export const toBase64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += BASE64_ALPHABET[(triple >> 18) & 63]
    out += BASE64_ALPHABET[(triple >> 12) & 63]
    out += b === undefined ? '=' : BASE64_ALPHABET[(triple >> 6) & 63]
    out += c === undefined ? '=' : BASE64_ALPHABET[triple & 63]
  }
  return out
}

export const syntheticBytes = (length: number, seed: number): Uint8Array => {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed * 7 + (i >> 8)) & 255
  return out
}

const CHUNK = 700_000

const ALICE = 'u-alice'
const BOB = 'u-bob'
const CAROL = 'u-carol'
const DAN = 'u-dan'
const UNIT = 'unit-1'
const TEMPLATE = 'tpl-a'
const REPORT = 'rep-1'

const audit = (
  action: string,
  actorId: string | null = ALICE,
  at = 1,
): AuditInput => ({
  at,
  actorId,
  action,
})

const job = (
  key: string,
  recipient: string | null,
  kind: NotificationJob['kind'],
  dueAt: number,
  channel: NotificationJob['channel'] = 'inbox',
): NotificationJob => ({
  key,
  kind,
  recipient,
  revision: 1,
  dueAt,
  deadline: null,
  subject: null,
  channel,
})

const publishInput = (
  overrides: Partial<PublishInput> & { revision: number; roundId: string },
): PublishInput => ({
  closing: false,
  deadlineAt: 10_000,
  deadlineZone: 'Europe/Madrid',
  participants: [
    { userId: CAROL, roleId: 'reviewer' },
    { userId: DAN, roleId: 'reviewer' },
  ],
  fromStates: ['drafting', 'in_review'],
  toState: 'in_review',
  jobs: [],
  publishedBy: ALICE,
  now: 100,
  audit: audit('revision.publish', ALICE, 100),
  ...overrides,
})

export const reportRepositoryContract = (
  name: string,
  makeHarness: HarnessFactory,
): void => {
  const run = <A>(effect: Effect.Effect<A, RepositoryError>): Promise<A> =>
    Effect.runPromise(effect)

  // NOTE: a unit, four accounts (alice and bob author, carol and dan review),
  // one built-in template and one report of alice's, with draft 0.
  const setup = async (options?: HarnessOptions) => {
    const harness = await makeHarness(options)
    const r = harness.repository
    await run(
      r.createUnit({ id: UNIT, name: 'Unit One', code: 'U1', createdAt: 1 }),
    )
    for (const [id, who] of [
      [ALICE, 'Alice Author'],
      [BOB, 'Bob Author'],
      [CAROL, 'Carol Reviewer'],
      [DAN, 'Dan Reviewer'],
    ] as const) {
      const created = await run(
        r.createAccount({
          id,
          email: `${who.split(' ')[0]?.toLowerCase()}@case-desk.test`,
          name: who,
          passwordHash: 'not-a-real-hash',
          profile: {
            phone: null,
            whatsappConsent: false,
            whatsappConsentAt: null,
            notifyOnApproval: false,
            active: true,
          },
          createdBy: null,
          now: 1,
        }),
      )
      expect(created).toEqual({ _tag: 'Created' })
    }
    await run(
      r.importBuiltInTemplates(
        [
          {
            templateId: TEMPLATE,
            version: 1,
            name: 'Template A',
            shortName: 'A',
            definition: '{"sections":[]}',
          },
        ],
        1,
      ),
    )
    const created = await run(
      r.createReport({
        caseFile: {
          kind: 'new',
          id: 'cf-1',
          reference: 'REF-1',
          title: 'Case One',
        },
        unitId: UNIT,
        reportId: REPORT,
        templateId: TEMPLATE,
        templateVersion: 1,
        createdBy: ALICE,
        draftingRoleId: 'author',
        now: 2,
        audit: audit('report.create', ALICE, 2),
      }),
    )
    expect(created).toEqual({ _tag: 'Created' })
    return { harness, r }
  }

  type Setup = Awaited<ReturnType<typeof setup>>

  // NOTE: a whole share by one author: save, stage each section, finish.
  const share = async (
    { r }: Setup,
    options: {
      userId?: string
      baseDraft: number
      shareId: string
      sections: ReadonlyArray<{ id: string; content: string; images?: string }>
      publish?: PublishInput
      now?: number
    },
  ) => {
    const userId = options.userId ?? ALICE
    const now = options.now ?? 50
    const started = await run(
      r.startWorkingCopy({
        reportId: REPORT,
        userId,
        fromDraft: options.baseDraft,
        now,
      }),
    )
    const copy = started as NonNullable<typeof started>
    const saved = await run(
      r.saveWorkingCopy({
        reportId: REPORT,
        userId,
        expectedCounter: copy.saveCounter,
        sections: options.sections.map((s, index) => ({
          sectionId: s.id,
          ordinal: index,
          content: s.content,
        })),
        now,
      }),
    )
    expect(saved._tag).toBe('Saved')
    for (const section of options.sections) {
      const read = await run(
        r.getWorkingCopySection(REPORT, userId, section.id),
      )
      const staged = await run(
        r.stageShareSection({
          shareId: options.shareId,
          reportId: REPORT,
          userId,
          sectionId: section.id,
          sectionVersion: (read as NonNullable<typeof read>).version,
          redactedContent: `redacted:${section.content}`,
          redactedHash: `hash:${section.content}`,
          imageRefs: section.images ?? '[]',
          now,
        }),
      )
      expect(staged).toEqual({ _tag: 'Staged' })
    }
    return {
      finish: () =>
        run(
          r.finishShare({
            shareId: options.shareId,
            reportId: REPORT,
            userId,
            baseDraft: options.baseDraft,
            expectedSections: options.sections.length,
            redactedCaseTitle: 'Case [redacted]',
            now,
            audit: audit('draft.share', userId, now),
            ...(options.publish === undefined
              ? {}
              : { publish: options.publish }),
          }),
        ),
    }
  }

  const shareDraft1 = async (s: Setup) =>
    (
      await share(s, {
        baseDraft: 0,
        shareId: 'share-1',
        sections: [
          { id: 'sec-a', content: '{"a":"original A"}' },
          { id: 'sec-b', content: '{"b":"original B"}' },
        ],
      })
    ).finish()

  const chunkInput = (
    overrides: Partial<ImageChunkInput> & { imageId: string },
  ): ImageChunkInput => ({
    owner: { kind: 'report', reportId: REPORT },
    uploadedBy: ALICE,
    mime: 'image/png',
    width: 10,
    height: 10,
    size: 1000,
    hash: 'sha-synthetic',
    chunkCount: 1,
    index: 0,
    data: toBase64(syntheticBytes(1000, 1)),
    now: 5,
    ...overrides,
  })

  describe(`${name} report repository`, () => {
    // ---- accounts -----------------------------------------------------------------
    test('an account with a grant, a unit link and an invitation is created whole', async () => {
      const { r } = await setup()
      const created = await run(
        r.createAccount({
          id: 'u-erin',
          email: 'Erin@Case-Desk.test',
          name: 'Erin',
          passwordHash: 'not-a-real-hash',
          profile: {
            phone: '+000000001',
            whatsappConsent: true,
            whatsappConsentAt: 3,
            notifyOnApproval: true,
            active: true,
          },
          grant: { capability: 'author', unitId: UNIT },
          reviewerOfUnit: UNIT,
          invitation: {
            id: 'inv-1',
            tokenHash: 'token-1',
            userId: 'u-erin',
            purpose: 'activate',
            expiresAt: 1000,
            issuedBy: ALICE,
            createdAt: 3,
          },
          createdBy: ALICE,
          now: 3,
          audit: audit('account.create', ALICE, 3),
        }),
      )
      expect(created).toEqual({ _tag: 'Created' })
      expect(await run(r.listGrants('u-erin'))).toEqual([
        expect.objectContaining({ capability: 'author', unitId: UNIT }),
      ])
      expect((await run(r.listUnitReviewers(UNIT))).map(a => a.id)).toContain(
        'u-erin',
      )
      expect(await run(r.findInvitation('token-1'))).toEqual(
        expect.objectContaining({ userId: 'u-erin', usedAt: null }),
      )
      expect(await run(r.getProfile('u-erin'))).toEqual(
        expect.objectContaining({ phone: '+000000001', passwordSetAt: null }),
      )
    })

    test('a taken email, or a missing unit, creates nothing', async () => {
      const { r } = await setup()
      const profile = {
        phone: null,
        whatsappConsent: false,
        whatsappConsentAt: null,
        notifyOnApproval: false,
        active: true,
      }
      expect(
        await run(
          r.createAccount({
            id: 'u-x',
            email: 'ALICE@case-desk.test',
            name: 'X',
            passwordHash: 'h',
            profile,
            createdBy: null,
            now: 3,
          }),
        ),
      ).toEqual({ _tag: 'Refused', reason: 'email_taken' })
      expect(
        await run(
          r.createAccount({
            id: 'u-y',
            email: 'y@case-desk.test',
            name: 'Y',
            passwordHash: 'h',
            profile,
            reviewerOfUnit: 'no-such-unit',
            createdBy: null,
            now: 3,
          }),
        ),
      ).toEqual({ _tag: 'Refused', reason: 'no_unit' })
      const accounts = await run(r.listAccounts())
      expect(accounts.map(a => a.id)).not.toContain('u-x')
      expect(accounts.map(a => a.id)).not.toContain('u-y')
      expect(await run(r.getProfile('u-y'))).toBeNull()
    })

    test('capability grants: an author grant needs its unit, repeats are reported, revoke removes', async () => {
      const { r } = await setup()
      const grant = (
        capability: 'admin' | 'author',
        unitId: string | null,
      ) => ({
        userId: BOB,
        capability,
        unitId,
        grantedBy: ALICE,
        grantedAt: 4,
      })
      expect(await run(r.grantCapability(grant('author', 'nope')))).toBe(
        'no_unit',
      )
      expect(await run(r.grantCapability(grant('author', UNIT)))).toBe(
        'granted',
      )
      expect(await run(r.grantCapability(grant('author', UNIT)))).toBe('exists')
      expect(await run(r.grantCapability(grant('admin', null)))).toBe('granted')
      expect(await run(r.listGrants(BOB))).toHaveLength(2)
      expect(await run(r.revokeCapability(BOB, 'admin', null))).toBe(true)
      expect(await run(r.revokeCapability(BOB, 'admin', null))).toBe(false)
      expect(await run(r.listGrants(BOB))).toHaveLength(1)
    })

    test('linking a reviewer reports a repeat and a missing unit', async () => {
      const { r } = await setup()
      expect(
        await run(r.linkReviewer(UNIT, CAROL, ALICE, 5, audit('link'))),
      ).toBe('linked')
      expect(
        await run(r.linkReviewer(UNIT, CAROL, ALICE, 5, audit('link'))),
      ).toBe('exists')
      expect(
        await run(r.linkReviewer('nope', CAROL, ALICE, 5, audit('link'))),
      ).toBe('no_unit')
      expect((await run(r.listUnitReviewers(UNIT))).map(a => a.id)).toEqual([
        CAROL,
      ])
    })

    test('an invitation sets the password once, ends sessions and cannot be reused or used late', async () => {
      const { r, harness } = await setup()
      await harness.seedSession('session-1', CAROL)
      await harness.seedSession('session-2', CAROL)
      await harness.seedSession('session-3', DAN)
      await run(
        r.createInvitation(
          {
            id: 'inv-2',
            tokenHash: 'tok-2',
            userId: CAROL,
            purpose: 'reset',
            expiresAt: 500,
            issuedBy: ALICE,
            createdAt: 10,
          },
          audit('invitation.create', ALICE, 10),
        ),
      )
      expect(
        await run(
          r.consumeInvitation('tok-2', 'hash-new', 600, audit('x', CAROL)),
        ),
      ).toEqual({
        _tag: 'Refused',
        reason: 'invalid',
      })
      expect(await harness.countSessions(CAROL)).toBe(2)
      expect(
        await run(
          r.consumeInvitation(
            'tok-2',
            'hash-new',
            400,
            audit('invitation.use', CAROL, 400),
          ),
        ),
      ).toEqual({ _tag: 'Consumed', userId: CAROL, purpose: 'reset' })
      expect(await harness.countSessions(CAROL)).toBe(0)
      expect(await harness.countSessions(DAN)).toBe(1)
      expect(await run(r.getProfile(CAROL))).toEqual(
        expect.objectContaining({ passwordSetAt: 400 }),
      )
      expect(await run(r.findInvitation('tok-2'))).toEqual(
        expect.objectContaining({ usedAt: 400 }),
      )
      expect(
        await run(
          r.consumeInvitation(
            'tok-2',
            'hash-other',
            401,
            audit('again', CAROL, 401),
          ),
        ),
      ).toEqual({ _tag: 'Refused', reason: 'invalid' })
      expect(
        await run(r.consumeInvitation('nope', 'h', 1, audit('z', CAROL))),
      ).toEqual({
        _tag: 'Refused',
        reason: 'invalid',
      })
      const actions = (await run(r.listAudit({ limit: 50 }))).map(a => a.action)
      expect(actions.filter(a => a === 'invitation.use')).toHaveLength(1)
    })

    test('signing a user out everywhere ends only their sessions', async () => {
      const { r, harness } = await setup()
      await harness.seedSession('s-1', CAROL)
      await harness.seedSession('s-2', DAN)
      await run(r.deleteSessionsOfUser(CAROL))
      expect(await harness.countSessions(CAROL)).toBe(0)
      expect(await harness.countSessions(DAN)).toBe(1)
    })

    test('sign-in attempts are summarised per email and per address', async () => {
      const { r } = await setup()
      await run(
        r.recordSignInAttempt('a@case-desk.test', '10.0.0.1', 10, false),
      )
      await run(
        r.recordSignInAttempt('a@case-desk.test', '10.0.0.2', 20, false),
      )
      await run(r.recordSignInAttempt('a@case-desk.test', '10.0.0.1', 30, true))
      await run(
        r.recordSignInAttempt('b@case-desk.test', '10.0.0.1', 40, false),
      )
      await run(r.recordSignInAttempt('a@case-desk.test', '10.0.0.1', 1, false))
      expect(
        await run(r.signInSummary('a@case-desk.test', '10.0.0.1', 5)),
      ).toEqual({
        failuresByEmail: 2,
        lastFailureByEmail: 20,
        failuresByIp: 2,
        lastFailureByIp: 40,
      })
    })

    test('the theme and the profile round-trip', async () => {
      const { r } = await setup()
      expect(await run(r.getTheme())).toBeNull()
      await run(
        r.putTheme(
          {
            settings: '{"accent":"#123456"}',
            logoImageId: null,
            updatedAt: 7,
            updatedBy: ALICE,
          },
          audit('theme.update', ALICE, 7),
        ),
      )
      await run(
        r.putTheme(
          {
            settings: '{"accent":"#654321"}',
            logoImageId: null,
            updatedAt: 8,
            updatedBy: ALICE,
          },
          audit('theme.update', ALICE, 8),
        ),
      )
      expect(await run(r.getTheme())).toEqual(
        expect.objectContaining({
          settings: '{"accent":"#654321"}',
          updatedAt: 8,
        }),
      )
      await run(
        r.putProfile(
          BOB,
          {
            phone: '+000000002',
            whatsappConsent: true,
            whatsappConsentAt: 9,
            notifyOnApproval: true,
            active: true,
          },
          9,
        ),
      )
      expect(await run(r.getProfile(BOB))).toEqual(
        expect.objectContaining({ phone: '+000000002', whatsappConsent: true }),
      )
    })

    test('units and committees', async () => {
      const { r } = await setup()
      expect(
        await run(
          r.createUnit({ id: UNIT, name: 'Dup', code: 'U1', createdAt: 5 }),
        ),
      ).toEqual({
        _tag: 'Refused',
        reason: 'duplicate',
      })
      expect(await run(r.updateUnit(UNIT, 'Unit Renamed', 6))).toEqual(
        expect.objectContaining({ name: 'Unit Renamed' }),
      )
      expect(await run(r.updateUnit('nope', 'x', 6))).toBeNull()
      expect(await run(r.listUnits())).toEqual([
        { id: UNIT, name: 'Unit Renamed', code: 'U1', createdAt: 1 },
      ])
      const committee = {
        id: 'cm-1',
        unitId: UNIT,
        name: 'Committee One',
        memberIds: [CAROL, DAN],
        createdBy: ALICE,
        now: 6,
        audit: audit('committee.create', ALICE, 6),
      }
      expect(await run(r.createCommittee(committee))).toEqual({
        _tag: 'Created',
      })
      expect(
        await run(r.createCommittee({ ...committee, id: 'cm-2' })),
      ).toEqual({
        _tag: 'Refused',
        reason: 'duplicate',
      })
      expect(
        await run(
          r.createCommittee({ ...committee, id: 'cm-3', unitId: 'nope' }),
        ),
      ).toEqual({
        _tag: 'Refused',
        reason: 'no_unit',
      })
      expect(
        await run(
          r.updateCommittee({
            id: 'cm-1',
            name: 'Committee Renamed',
            memberIds: [DAN],
            now: 7,
            audit: audit('committee.update', ALICE, 7),
          }),
        ),
      ).toBe(true)
      expect(
        await run(
          r.updateCommittee({
            id: 'nope',
            name: 'x',
            now: 7,
            audit: audit('u'),
          }),
        ),
      ).toBe(false)
      expect(await run(r.listCommittees(UNIT))).toEqual([
        expect.objectContaining({
          id: 'cm-1',
          name: 'Committee Renamed',
          memberIds: [DAN],
        }),
      ])
    })

    // ---- templates -----------------------------------------------------------------
    test('built-in templates import insert-if-absent and never overwrite', async () => {
      const { r } = await setup()
      const second = {
        templateId: TEMPLATE,
        version: 2,
        name: 'Template A v2',
        shortName: 'A2',
        definition: '{"sections":[1]}',
      }
      const again = {
        templateId: TEMPLATE,
        version: 1,
        name: 'CHANGED',
        shortName: 'CH',
        definition: '{"changed":true}',
      }
      expect(await run(r.importBuiltInTemplates([again, second], 20))).toBe(1)
      expect(await run(r.importBuiltInTemplates([again, second], 30))).toBe(0)
      expect(await run(r.getTemplateVersion(TEMPLATE, 1))).toEqual(
        expect.objectContaining({
          name: 'Template A',
          definition: '{"sections":[]}',
          builtin: true,
          state: 'published',
          createdAt: 1,
        }),
      )
      expect(await run(r.getTemplateVersion(TEMPLATE, 2))).toEqual(
        expect.objectContaining({ name: 'Template A v2', createdAt: 20 }),
      )
      expect((await run(r.listTemplates())).map(t => t.version)).toEqual([1, 2])
      expect(await run(r.importBuiltInTemplates([], 40))).toBe(0)
    })

    test('a retired built-in version stays retired when the import runs again', async () => {
      const { r } = await setup()
      expect(
        await run(
          r.retireTemplate(TEMPLATE, 25, audit('template.retire', ALICE, 25)),
        ),
      ).toEqual({
        _tag: 'Retired',
      })
      await run(
        r.importBuiltInTemplates(
          [
            {
              templateId: TEMPLATE,
              version: 1,
              name: 'Template A',
              shortName: 'A',
              definition: '{"sections":[]}',
            },
          ],
          26,
        ),
      )
      expect(await run(r.getTemplateVersion(TEMPLATE, 1))).toEqual(
        expect.objectContaining({ state: 'retired', retiredAt: 25 }),
      )
      expect(await run(r.retireTemplate(TEMPLATE, 27, audit('again')))).toEqual(
        {
          _tag: 'Refused',
          reason: 'not_published',
        },
      )
    })

    test('template versions: one draft at a time, immutable once published', async () => {
      const { r } = await setup()
      const draft = {
        templateId: 'tpl-custom',
        version: 1,
        name: 'Custom',
        shortName: 'C',
        definition: '{"v":1}',
        createdBy: ALICE,
        now: 30,
        audit: audit('template.create', ALICE, 30),
      }
      expect(
        await run(r.createTemplateDraft({ ...draft, version: 2 })),
      ).toEqual({
        _tag: 'Refused',
        reason: 'wrong_version',
      })
      expect(await run(r.createTemplateDraft(draft))).toEqual({
        _tag: 'Created',
      })
      expect(
        await run(r.createTemplateDraft({ ...draft, version: 2 })),
      ).toEqual({
        _tag: 'Refused',
        reason: 'draft_exists',
      })
      expect(
        await run(
          r.saveTemplateDraft({
            templateId: 'tpl-custom',
            version: 1,
            name: 'Custom edited',
            shortName: 'C',
            definition: '{"v":1,"edited":true}',
          }),
        ),
      ).toEqual({ _tag: 'Saved' })
      expect(
        await run(
          r.publishTemplateVersion({
            templateId: 'tpl-custom',
            version: 1,
            changes: 'First version',
            publishedBy: ALICE,
            now: 31,
            audit: audit('template.publish', ALICE, 31),
          }),
        ),
      ).toEqual({ _tag: 'Published' })
      expect(
        await run(
          r.saveTemplateDraft({
            templateId: 'tpl-custom',
            version: 1,
            name: 'Tampered',
            shortName: 'T',
            definition: '{"tampered":true}',
          }),
        ),
      ).toEqual({ _tag: 'Refused', reason: 'not_a_draft' })
      expect(
        await run(
          r.publishTemplateVersion({
            templateId: 'tpl-custom',
            version: 1,
            changes: 'again',
            publishedBy: ALICE,
            now: 32,
            audit: audit('template.publish', ALICE, 32),
          }),
        ),
      ).toEqual({ _tag: 'Refused', reason: 'not_a_draft' })
      expect(await run(r.getTemplateVersion('tpl-custom', 1))).toEqual(
        expect.objectContaining({
          name: 'Custom edited',
          definition: '{"v":1,"edited":true}',
          state: 'published',
          changes: 'First version',
          builtin: false,
        }),
      )
      expect(
        await run(r.createTemplateDraft({ ...draft, version: 2, now: 33 })),
      ).toEqual({
        _tag: 'Created',
      })
    })

    // ---- reports -------------------------------------------------------------------
    test('a report is created with its case file, member, draft 0 and audit row', async () => {
      const { r } = await setup()
      const report = await run(r.getReport(REPORT))
      expect(report).toEqual(
        expect.objectContaining({
          id: REPORT,
          state: 'drafting',
          templateId: TEMPLATE,
          templateVersion: 1,
          latestDraft: 0,
          latestRevision: null,
          caseFile: expect.objectContaining({
            reference: 'REF-1',
            unitId: UNIT,
          }),
        }),
      )
      expect(await run(r.getMembership(REPORT, ALICE))).toEqual({
        roleId: 'author',
      })
      expect(await run(r.getMembership(REPORT, BOB))).toBeNull()
      expect((await run(r.listReportsForMember(ALICE))).map(x => x.id)).toEqual(
        [REPORT],
      )
      expect(await run(r.listReportsForMember(BOB))).toEqual([])
      expect((await run(r.listDrafts(REPORT)))[0]).toEqual(
        expect.objectContaining({ number: 0, baseNumber: null }),
      )
      expect(await run(r.listAudit({ reportId: REPORT, limit: 10 }))).toEqual([
        expect.objectContaining({
          action: 'report.create',
          reportId: REPORT,
          draftNumber: 0,
        }),
      ])
    })

    test('a duplicate case reference or a missing case file creates nothing', async () => {
      const { r } = await setup()
      const base = {
        unitId: UNIT,
        templateId: TEMPLATE,
        templateVersion: 1,
        createdBy: ALICE,
        draftingRoleId: 'author',
        now: 9,
      }
      expect(
        await run(
          r.createReport({
            ...base,
            caseFile: {
              kind: 'new',
              id: 'cf-2',
              reference: 'REF-1',
              title: 'Dup',
            },
            reportId: 'rep-2',
            audit: audit('report.create', ALICE, 9),
          }),
        ),
      ).toEqual({ _tag: 'Refused', reason: 'duplicate_reference' })
      expect(
        await run(
          r.createReport({
            ...base,
            caseFile: { kind: 'existing', id: 'cf-none' },
            reportId: 'rep-3',
            audit: audit('report.create', ALICE, 9),
          }),
        ),
      ).toEqual({ _tag: 'Refused', reason: 'no_case_file' })
      expect(await run(r.getReport('rep-2'))).toBeNull()
      expect(await run(r.getReport('rep-3'))).toBeNull()
      expect(await run(r.listCaseFiles(UNIT))).toHaveLength(1)
      expect(
        await run(
          r.createReport({
            ...base,
            caseFile: { kind: 'existing', id: 'cf-1' },
            reportId: 'rep-4',
            audit: audit('report.create', ALICE, 9),
          }),
        ),
      ).toEqual({ _tag: 'Created' })
      expect(
        await run(r.updateCaseFile('cf-1', { title: 'Renamed' }, 10)),
      ).toEqual(expect.objectContaining({ title: 'Renamed', updatedAt: 10 }))
      expect(
        await run(r.updateCaseFile('cf-none', { title: 'x' }, 10)),
      ).toBeNull()
    })

    test('members join once, report moves are guarded by the state', async () => {
      const { r } = await setup()
      const add = (userId: string) =>
        run(
          r.addMember({
            reportId: REPORT,
            userId,
            roleId: 'author',
            addedBy: ALICE,
            now: 11,
            audit: audit('member.add', ALICE, 11),
          }),
        )
      expect(await add(BOB)).toEqual({ _tag: 'Added' })
      expect(await add(BOB)).toEqual({
        _tag: 'Refused',
        reason: 'already_member',
      })
      expect(
        (await run(r.listMembers(REPORT))).map(m => m.userId).sort(),
      ).toEqual([ALICE, BOB])
      expect(
        await run(
          r.moveReport({
            reportId: REPORT,
            from: 'in_review',
            to: 'concluding',
            now: 12,
            audit: audit('m'),
          }),
        ),
      ).toEqual({ _tag: 'Refused', reason: 'wrong_state' })
      expect(
        await run(
          r.moveReport({
            reportId: REPORT,
            from: 'drafting',
            to: 'archived',
            now: 12,
            audit: audit('m'),
          }),
        ),
      ).toEqual({ _tag: 'Moved' })
      expect(await add(CAROL)).toEqual({ _tag: 'Refused', reason: 'archived' })
    })

    // ---- working copies ----------------------------------------------------------------
    test('a working copy starts from draft 0, saves with a version guard and keeps others apart', async () => {
      const { r } = await setup()
      expect(
        await run(
          r.startWorkingCopy({
            reportId: REPORT,
            userId: BOB,
            fromDraft: 0,
            now: 5,
          }),
        ),
      ).toBeNull()
      const copy = await run(
        r.startWorkingCopy({
          reportId: REPORT,
          userId: ALICE,
          fromDraft: 0,
          now: 5,
        }),
      )
      expect(copy).toEqual(
        expect.objectContaining({ baseDraft: 0, saveCounter: 0 }),
      )
      const again = await run(
        r.startWorkingCopy({
          reportId: REPORT,
          userId: ALICE,
          fromDraft: 0,
          now: 99,
        }),
      )
      expect(again).toEqual(expect.objectContaining({ startedAt: 5 }))
      const save = (expectedCounter: number, content: string) =>
        run(
          r.saveWorkingCopy({
            reportId: REPORT,
            userId: ALICE,
            expectedCounter,
            sections: [{ sectionId: 'sec-a', ordinal: 0, content }],
            now: 6,
          }),
        )
      expect(await save(0, '{"a":1}')).toEqual({
        _tag: 'Saved',
        saveCounter: 1,
      })
      expect(await save(0, '{"a":"stale"}')).toEqual({
        _tag: 'Refused',
        reason: 'stale_save',
      })
      expect(await save(1, '{"a":2}')).toEqual({
        _tag: 'Saved',
        saveCounter: 2,
      })
      expect(
        await run(r.getWorkingCopySection(REPORT, ALICE, 'sec-a')),
      ).toEqual({
        content: '{"a":2}',
        version: 2,
      })
      expect(await run(r.listWorkingCopySections(REPORT, ALICE))).toEqual([
        { sectionId: 'sec-a', ordinal: 0, bytes: 7, version: 2 },
      ])
      expect(
        await run(r.getWorkingCopySection(REPORT, BOB, 'sec-a')),
      ).toBeNull()
      expect((await run(r.listDrafting(REPORT))).map(d => d.userId)).toEqual([
        ALICE,
      ])
    })

    // ---- sharing -----------------------------------------------------------------------
    test('a share makes draft 1 with the original and the redacted text stored side by side', async () => {
      const s = await setup()
      const { r } = s
      expect(await shareDraft1(s)).toEqual({
        _tag: 'Shared',
        number: 1,
        revision: null,
      })
      expect(await run(r.getDraft(REPORT, 1))).toEqual(
        expect.objectContaining({
          baseNumber: 0,
          authorId: ALICE,
          authorName: 'Alice Author',
          shareId: 'share-1',
          caseTitleRedacted: 'Case [redacted]',
          redactionConfirmedAt: null,
          revisions: [],
        }),
      )
      expect(await run(r.getDraftSection(REPORT, 1, 'sec-a', 'original'))).toBe(
        '{"a":"original A"}',
      )
      expect(await run(r.getDraftSection(REPORT, 1, 'sec-a', 'redacted'))).toBe(
        'redacted:{"a":"original A"}',
      )
      expect(
        await run(r.getDraftSection(REPORT, 1, 'sec-z', 'original')),
      ).toBeNull()
      expect(
        (await run(r.listDraftSections(REPORT, 1))).map(x => x.sectionId),
      ).toEqual(['sec-a', 'sec-b'])
      expect((await run(r.getWorkingCopy(REPORT, ALICE)))?.baseDraft).toBe(1)
      expect((await run(r.getReport(REPORT)))?.latestDraft).toBe(1)
    })

    test('finishing the same share again answers with the draft it made', async () => {
      const s = await setup()
      const staged = await share(s, {
        baseDraft: 0,
        shareId: 'share-1',
        sections: [{ id: 'sec-a', content: '{"a":1}' }],
      })
      expect(await staged.finish()).toEqual({
        _tag: 'Shared',
        number: 1,
        revision: null,
      })
      expect(await staged.finish()).toEqual({
        _tag: 'AlreadyShared',
        number: 1,
      })
      expect(await s.r.listDrafts(REPORT).pipe(run)).toHaveLength(2)
    })

    test('a draft never changes after the working copy does', async () => {
      const s = await setup()
      await shareDraft1(s)
      const copy = (await run(
        s.r.getWorkingCopy(REPORT, ALICE),
      )) as NonNullable<unknown> & {
        saveCounter: number
      }
      await run(
        s.r.saveWorkingCopy({
          reportId: REPORT,
          userId: ALICE,
          expectedCounter: copy.saveCounter,
          sections: [
            { sectionId: 'sec-a', ordinal: 0, content: '{"a":"later"}' },
          ],
          now: 60,
        }),
      )
      expect(
        await run(s.r.getDraftSection(REPORT, 1, 'sec-a', 'original')),
      ).toBe('{"a":"original A"}')
      expect(
        await run(s.r.getDraftSection(REPORT, 1, 'sec-a', 'redacted')),
      ).toBe('redacted:{"a":"original A"}')
    })

    test('a section edited after it was read is not staged', async () => {
      const s = await setup()
      const staged = await share(s, {
        baseDraft: 0,
        shareId: 'share-1',
        sections: [{ id: 'sec-a', content: '{"a":1}' }],
      })
      void staged
      const copy = (await run(s.r.getWorkingCopy(REPORT, ALICE))) as {
        saveCounter: number
      } | null
      await run(
        s.r.saveWorkingCopy({
          reportId: REPORT,
          userId: ALICE,
          expectedCounter: copy?.saveCounter ?? 0,
          sections: [{ sectionId: 'sec-a', ordinal: 0, content: '{"a":2}' }],
          now: 60,
        }),
      )
      expect(
        await run(
          s.r.stageShareSection({
            shareId: 'share-2',
            reportId: REPORT,
            userId: ALICE,
            sectionId: 'sec-a',
            sectionVersion: 1,
            redactedContent: 'x',
            redactedHash: 'x',
            imageRefs: '[]',
            now: 61,
          }),
        ),
      ).toEqual({ _tag: 'Refused', reason: 'changed' })
    })

    test('a share with a missing staged section is refused and makes no draft', async () => {
      const s = await setup()
      const staged = await share(s, {
        baseDraft: 0,
        shareId: 'share-1',
        sections: [{ id: 'sec-a', content: '{"a":1}' }],
      })
      void staged
      expect(
        await run(
          s.r.finishShare({
            shareId: 'share-1',
            reportId: REPORT,
            userId: ALICE,
            baseDraft: 0,
            expectedSections: 2,
            redactedCaseTitle: 't',
            now: 70,
            audit: audit('draft.share', ALICE, 70),
          }),
        ),
      ).toEqual({ _tag: 'Refused', reason: 'share_incomplete' })
      expect(await run(s.r.listDrafts(REPORT))).toHaveLength(1)
    })

    test('two authors sharing from the same base: exactly one draft, the other is told it is stale', async () => {
      const s = await setup()
      await run(
        s.r.addMember({
          reportId: REPORT,
          userId: BOB,
          roleId: 'author',
          addedBy: ALICE,
          now: 4,
          audit: audit('member.add', ALICE, 4),
        }),
      )
      const a = await share(s, {
        userId: ALICE,
        baseDraft: 0,
        shareId: 'share-a',
        sections: [{ id: 'sec-a', content: '{"a":"alice"}' }],
      })
      const b = await share(s, {
        userId: BOB,
        baseDraft: 0,
        shareId: 'share-b',
        sections: [{ id: 'sec-a', content: '{"a":"bob"}' }],
      })
      const [first, second] = await Promise.all([a.finish(), b.finish()])
      const outcomes = [first, second]
      expect(outcomes.filter(o => o._tag === 'Shared')).toHaveLength(1)
      expect(outcomes.filter(o => o._tag === 'Refused')).toEqual([
        { _tag: 'Refused', reason: 'stale_base', latest: 1 },
      ])
      const drafts = await run(s.r.listDrafts(REPORT))
      expect(drafts.map(d => d.number)).toEqual([0, 1])
      const loser = first._tag === 'Shared' ? BOB : ALICE
      expect((await run(s.r.getWorkingCopy(REPORT, loser)))?.baseDraft).toBe(0)
      expect(
        await run(
          s.r
            .listAudit({ reportId: REPORT, limit: 50 })
            .pipe(Effect.map(l => l.filter(x => x.action === 'draft.share'))),
        ),
      ).toHaveLength(1)
    })

    test('two shares by the same author from the same base make one draft', async () => {
      const s = await setup()
      const a = await share(s, {
        baseDraft: 0,
        shareId: 'share-a',
        sections: [{ id: 'sec-a', content: '{"a":1}' }],
      })
      const b = await share(s, {
        baseDraft: 0,
        shareId: 'share-b',
        sections: [{ id: 'sec-a', content: '{"a":1}' }],
      })
      const outcomes = await Promise.all([a.finish(), b.finish()])
      expect(outcomes.filter(o => o._tag === 'Shared')).toHaveLength(1)
      expect((await run(s.r.listDrafts(REPORT))).map(d => d.number)).toEqual([
        0, 1,
      ])
    })

    test('redaction confirmation is recorded once', async () => {
      const s = await setup()
      await shareDraft1(s)
      const confirm = (draftNumber: number, now: number) =>
        run(
          s.r.confirmRedaction({
            reportId: REPORT,
            draftNumber,
            confirmedBy: ALICE,
            now,
            audit: {
              ...audit('redaction.confirm', ALICE, now),
              reportId: REPORT,
            },
          }),
        )
      expect(await confirm(1, 80)).toBe(true)
      expect(await confirm(1, 81)).toBe(true)
      expect(await confirm(9, 82)).toBe(false)
      expect((await run(s.r.getDraft(REPORT, 1)))?.redactionConfirmedAt).toBe(
        80,
      )
      const confirmations = (
        await run(s.r.listAudit({ reportId: REPORT, limit: 50 }))
      ).filter(a => a.action === 'redaction.confirm')
      expect(confirmations).toHaveLength(1)
    })

    // ---- publishing ---------------------------------------------------------------------
    test('publishing makes revision 1, an open round, its participants and its jobs', async () => {
      const s = await setup()
      await shareDraft1(s)
      const outcome = await run(
        s.r.publishRevision({
          reportId: REPORT,
          draft: 1,
          ...publishInput({
            revision: 1,
            roundId: 'round-1',
            jobs: [
              job('review_request:carol', CAROL, 'review_request', 100),
              job('review_request:dan', DAN, 'review_request', 100),
              job('deadline', null, 'deadline', 10_000),
            ],
          }),
        }),
      )
      expect(outcome).toEqual({
        _tag: 'Published',
        revision: 1,
        roundId: 'round-1',
      })
      expect(await run(s.r.getRevision(REPORT, 1))).toEqual(
        expect.objectContaining({
          draftNumber: 1,
          closing: false,
          publishedBy: ALICE,
        }),
      )
      expect(await run(s.r.getReport(REPORT))).toEqual(
        expect.objectContaining({
          state: 'in_review',
          deadlineAt: 10_000,
          latestRevision: 1,
        }),
      )
      const round = await run(s.r.getOpenRound(REPORT))
      expect(round?.round).toEqual(
        expect.objectContaining({ id: 'round-1', revision: 1, state: 'open' }),
      )
      expect(round?.participants.map(p => p.userId).sort()).toEqual([
        CAROL,
        DAN,
      ])
      expect([...(await run(s.r.listJobKeys(REPORT)))].sort()).toEqual([
        'deadline',
        'review_request:carol',
        'review_request:dan',
      ])
      expect((await run(s.r.getDraft(REPORT, 1)))?.revisions).toEqual([1])
      expect(
        await run(s.r.getRevisionSection(REPORT, 1, 'sec-a', 'redacted')),
      ).toBe('redacted:{"a":"original A"}')
      expect(
        (await run(s.r.listRevisionSections(REPORT, 1))).map(x => x.sectionId),
      ).toEqual(['sec-a', 'sec-b'])
      expect(await run(s.r.getParticipation(REPORT, 1, CAROL))).toEqual(
        expect.objectContaining({
          roleId: 'reviewer',
          draftNumber: 1,
          removedAt: null,
        }),
      )
      expect(await run(s.r.getParticipation(REPORT, 1, BOB))).toBeNull()
      expect(await run(s.r.listAssignments(CAROL))).toEqual([
        expect.objectContaining({
          reportId: REPORT,
          revision: 1,
          roundId: 'round-1',
          roundState: 'open',
        }),
      ])
    })

    test('publishing again supersedes the old round and skips its reminders', async () => {
      const s = await setup()
      await shareDraft1(s)
      await run(
        s.r.publishRevision({
          reportId: REPORT,
          draft: 1,
          ...publishInput({
            revision: 1,
            roundId: 'round-1',
            jobs: [
              job('r1:carol', CAROL, 'reminder_first', 500),
              job('r1:replaced', CAROL, 'revision_replaced', 500),
            ],
          }),
        }),
      )
      const second = await share(s, {
        baseDraft: 1,
        shareId: 'share-2',
        sections: [{ id: 'sec-a', content: '{"a":"v2"}' }],
      })
      expect(await second.finish()).toEqual({
        _tag: 'Shared',
        number: 2,
        revision: null,
      })
      expect(
        await run(
          s.r.publishRevision({
            reportId: REPORT,
            draft: 2,
            ...publishInput({
              revision: 2,
              roundId: 'round-2',
              now: 200,
              jobs: [job('r2:carol', CAROL, 'review_request', 200)],
            }),
          }),
        ),
      ).toEqual({ _tag: 'Published', revision: 2, roundId: 'round-2' })
      const rounds = await run(s.r.listRounds(REPORT))
      expect(rounds.map(x => [x.round.revision, x.round.state])).toEqual([
        [1, 'superseded'],
        [2, 'open'],
      ])
      const claimed = await run(
        s.r.claimDueJobs({
          now: 1000,
          limit: 10,
          leaseMs: 60_000,
          claimedBy: 'w1',
        }),
      )
      expect(claimed.map(j => j.key).sort()).toEqual([
        'r1:replaced',
        'r2:carol',
      ])
    })

    test('publishing is refused for a stale draft, the wrong state, a gap and an author as reviewer', async () => {
      const s = await setup()
      await shareDraft1(s)
      const publish = (
        extra: Partial<PublishInput> & { revision?: number; roundId?: string },
        draft = 1,
      ) =>
        run(
          s.r.publishRevision({
            reportId: REPORT,
            draft,
            ...publishInput({ revision: 1, roundId: 'round-x', ...extra }),
          }),
        )
      expect(
        await publish({
          participants: [{ userId: ALICE, roleId: 'reviewer' }],
        }),
      ).toEqual({
        _tag: 'Refused',
        reason: 'participant_is_author',
      })
      expect(await publish({ revision: 3 })).toEqual({
        _tag: 'Refused',
        reason: 'revision_number',
      })
      expect(await publish({}, 0)).toEqual({
        _tag: 'Refused',
        reason: 'not_latest',
      })
      expect(await publish({ fromStates: ['concluding'] })).toEqual({
        _tag: 'Refused',
        reason: 'wrong_state',
      })
      expect(await run(s.r.listRevisions(REPORT))).toEqual([])
      expect(await run(s.r.getOpenRound(REPORT))).toBeNull()
      expect((await run(s.r.getReport(REPORT)))?.state).toBe('drafting')
      expect(await publish({ roundId: 'round-1' })).toEqual({
        _tag: 'Published',
        revision: 1,
        roundId: 'round-1',
      })
      expect(await publish({ roundId: 'round-1b' })).toEqual({
        _tag: 'Refused',
        reason: 'revision_number',
      })
    })

    test('share and publish is one step: refused, it leaves no draft', async () => {
      const s = await setup()
      const refused = await share(s, {
        baseDraft: 0,
        shareId: 'share-1',
        sections: [{ id: 'sec-a', content: '{"a":1}' }],
        publish: publishInput({
          revision: 1,
          roundId: 'round-1',
          participants: [{ userId: ALICE, roleId: 'reviewer' }],
        }),
      })
      expect(await refused.finish()).toEqual({
        _tag: 'Refused',
        reason: 'participant_is_author',
      })
      expect(await run(s.r.listDrafts(REPORT))).toHaveLength(1)
      expect((await run(s.r.getWorkingCopy(REPORT, ALICE)))?.baseDraft).toBe(0)
      const ok = await share(s, {
        baseDraft: 0,
        shareId: 'share-2',
        sections: [{ id: 'sec-a', content: '{"a":1}' }],
        publish: publishInput({
          revision: 1,
          roundId: 'round-1',
          jobs: [job('k', CAROL, 'review_request', 1)],
        }),
      })
      expect(await ok.finish()).toEqual({
        _tag: 'Shared',
        number: 1,
        revision: 1,
      })
      expect(await run(s.r.getRevision(REPORT, 1))).toEqual(
        expect.objectContaining({ draftNumber: 1 }),
      )
      expect((await run(s.r.getReport(REPORT)))?.state).toBe('in_review')
      expect(await run(s.r.listJobKeys(REPORT))).toEqual(['k'])
    })

    // ---- rounds, reviews and comments -----------------------------------------------------
    const published = async (options: { deadlineAt?: number } = {}) => {
      const s = await setup()
      await shareDraft1(s)
      await run(
        s.r.publishRevision({
          reportId: REPORT,
          draft: 1,
          ...publishInput({
            revision: 1,
            roundId: 'round-1',
            deadlineAt: options.deadlineAt ?? 10_000,
            jobs: [
              job('rr:carol', CAROL, 'reminder_first', 500),
              job('rr:dan', DAN, 'reminder_first', 500),
            ],
          }),
        }),
      )
      return s
    }

    const comment = (
      id: string,
      visibility: 'authors' | 'committee',
      body: string,
    ) => ({
      id,
      roundId: 'round-1',
      reviewerId: CAROL,
      revision: 1,
      sectionId: 'sec-a',
      itemId: null,
      rangeFrom: 0,
      rangeTo: 5,
      quoted: 'orig',
      body,
      redactedBody: `redacted:${body}`,
      visibility,
      now: 150,
    })

    test('pending comments are private to the reviewer and attach to the review when sent', async () => {
      const s = await published()
      const { r } = s
      expect(
        await run(
          r.savePendingReview({
            roundId: 'round-1',
            reviewerId: CAROL,
            decision: 'approve',
            now: 140,
          }),
        ),
      ).toEqual({ _tag: 'Saved' })
      expect(
        await run(
          r.savePendingReview({
            roundId: 'round-1',
            reviewerId: BOB,
            decision: 'approve',
            now: 140,
          }),
        ),
      ).toEqual({ _tag: 'Refused', reason: 'not_open' })
      expect(
        await run(
          r.addPendingComment(comment('c-1', 'authors', 'For authors')),
        ),
      ).toEqual({ _tag: 'Added' })
      expect(
        await run(r.addPendingComment(comment('c-2', 'committee', 'For all'))),
      ).toEqual({ _tag: 'Added' })
      expect(
        await run(
          r.addPendingComment({
            ...comment('c-3', 'authors', 'x'),
            reviewerId: BOB,
          }),
        ),
      ).toEqual({ _tag: 'Refused', reason: 'not_open' })
      expect(
        await run(
          r.updatePendingComment({
            id: 'c-1',
            reviewerId: CAROL,
            body: 'Edited',
            visibility: 'authors',
          }),
        ),
      ).toBe(true)
      expect(
        await run(
          r.updatePendingComment({
            id: 'c-1',
            reviewerId: DAN,
            body: 'Hijack',
            visibility: 'authors',
          }),
        ),
      ).toBe(false)
      expect(await run(r.deletePendingComment('c-2', DAN))).toBe(false)
      const pending = await run(r.getPendingReview('round-1', CAROL))
      expect(pending.decision).toBe('approve')
      expect(pending.comments.map(c => [c.id, c.body, c.reviewId])).toEqual([
        ['c-1', 'Edited', null],
        ['c-2', 'For all', null],
      ])
      const listFor = (
        audience: { kind: 'authors' } | { kind: 'reviewer'; userId: string },
      ) =>
        run(
          r.listComments({
            reportId: REPORT,
            kind: 'revision',
            number: 1,
            audience,
          }),
        )
      expect((await listFor({ kind: 'authors' })).comments).toEqual([])
      expect(
        (await listFor({ kind: 'reviewer', userId: DAN })).comments,
      ).toEqual([])
      expect(
        (await listFor({ kind: 'reviewer', userId: CAROL })).comments,
      ).toHaveLength(2)
      expect(await run(r.deletePendingComment('c-2', CAROL))).toBe(true)
      await run(
        r.addPendingComment(comment('c-4', 'committee', 'For all again')),
      )

      const sent = await run(
        r.sendReview({
          reviewId: 'rv-1',
          roundId: 'round-1',
          reportId: REPORT,
          reviewerId: CAROL,
          decision: 'approve',
          jobs: [job('review_received:rv-1', ALICE, 'review_received', 160)],
          now: 160,
          audit: audit('review.send', CAROL, 160),
        }),
      )
      expect(sent).toEqual({ _tag: 'Sent', hasComments: true })
      expect(
        (await run(r.getPendingReview('round-1', CAROL))).comments,
      ).toEqual([])
      expect(
        (await run(r.getPendingReview('round-1', CAROL))).decision,
      ).toBeNull()
      expect(
        (await listFor({ kind: 'authors' })).comments.map(c => c.id).sort(),
      ).toEqual(['c-1', 'c-4'])
      expect(
        (await listFor({ kind: 'reviewer', userId: DAN })).comments.map(
          c => c.id,
        ),
      ).toEqual(['c-4'])
      expect(
        (await listFor({ kind: 'reviewer', userId: CAROL })).comments
          .map(c => c.id)
          .sort(),
      ).toEqual(['c-1', 'c-4'])
      expect(await run(r.listReviews(REPORT))).toEqual([
        expect.objectContaining({
          id: 'rv-1',
          reviewerId: CAROL,
          revision: 1,
          decision: 'approve',
          hasComments: true,
          sentAt: 160,
        }),
      ])
      expect(
        await run(
          r.sendReview({
            reviewId: 'rv-2',
            roundId: 'round-1',
            reportId: REPORT,
            reviewerId: BOB,
            decision: 'approve',
            jobs: [],
            now: 161,
            audit: audit('x', BOB),
          }),
        ),
      ).toEqual({ _tag: 'Refused', reason: 'not_open' })
    })

    test('a review is not accepted after the deadline, nor after the round is decided', async () => {
      const s = await published({ deadlineAt: 300 })
      const { r } = s
      const send = (reviewId: string, reviewerId: string, now: number) =>
        run(
          r.sendReview({
            reviewId,
            roundId: 'round-1',
            reportId: REPORT,
            reviewerId,
            decision: 'approve',
            jobs: [],
            now,
            audit: audit('review.send', reviewerId, now),
          }),
        )
      expect(await send('rv-late', CAROL, 300)).toEqual({
        _tag: 'Refused',
        reason: 'not_open',
      })
      expect(await send('rv-ok', CAROL, 299)).toEqual({
        _tag: 'Sent',
        hasComments: false,
      })
      expect(
        await run(
          r.decideRound({
            roundId: 'round-1',
            reportId: REPORT,
            decidedBy: 'rule_met',
            toState: 'concluding',
            jobs: [job('decided', ALICE, 'round_decided', 310)],
            now: 310,
            audit: audit('round.decide', null, 310),
          }),
        ),
      ).toEqual({ _tag: 'Decided' })
      expect(await send('rv-after', DAN, 311)).toEqual({
        _tag: 'Refused',
        reason: 'not_open',
      })
      expect(
        await run(
          r.decideRound({
            roundId: 'round-1',
            reportId: REPORT,
            decidedBy: 'deadline',
            toState: 'drafting',
            jobs: [],
            now: 312,
            audit: audit('again', null, 312),
          }),
        ),
      ).toEqual({ _tag: 'Refused', reason: 'not_open' })
      expect(await run(r.getRound(REPORT, 1))).toEqual(
        expect.objectContaining({
          round: expect.objectContaining({
            state: 'decided',
            decidedBy: 'rule_met',
            decidedAt: 310,
          }),
        }),
      )
      expect((await run(r.getReport(REPORT)))?.state).toBe('concluding')
      const claimed = await run(
        r.claimDueJobs({ now: 1000, limit: 10, leaseMs: 1000, claimedBy: 'w' }),
      )
      expect(claimed.map(j => j.key)).toEqual(['decided'])
    })

    test('a deadline can only move later, and a removed reviewer loses their reminders', async () => {
      const s = await published()
      const { r } = s
      const extend = (deadlineAt: number) =>
        run(
          r.extendDeadline({
            roundId: 'round-1',
            reportId: REPORT,
            deadlineAt,
            deadlineZone: 'Europe/Madrid',
            jobs: [job('deadline:later', null, 'deadline', deadlineAt)],
            now: 120,
            audit: audit('round.extend', ALICE, 120),
          }),
        )
      expect(await extend(9_000)).toEqual({
        _tag: 'Refused',
        reason: 'not_later',
      })
      expect(await extend(20_000)).toEqual({ _tag: 'Extended' })
      expect((await run(r.getReport(REPORT)))?.deadlineAt).toBe(20_000)
      expect((await run(r.getOpenRound(REPORT)))?.round.deadlineAt).toBe(20_000)
      expect(
        await run(
          r.removeParticipant({
            roundId: 'round-1',
            userId: BOB,
            removedBy: ALICE,
            now: 130,
            audit: audit('x'),
          }),
        ),
      ).toEqual({ _tag: 'Refused', reason: 'not_a_participant' })
      expect(
        await run(
          r.removeParticipant({
            roundId: 'round-1',
            userId: DAN,
            removedBy: ALICE,
            now: 130,
            audit: audit('round.remove', ALICE, 130),
          }),
        ),
      ).toEqual({ _tag: 'Removed' })
      expect(
        await run(
          r.removeParticipant({
            roundId: 'round-1',
            userId: DAN,
            removedBy: ALICE,
            now: 131,
            audit: audit('x'),
          }),
        ),
      ).toEqual({ _tag: 'Refused', reason: 'not_a_participant' })
      expect((await run(r.getParticipation(REPORT, 1, DAN)))?.removedAt).toBe(
        130,
      )
      expect(
        await run(
          r.savePendingReview({
            roundId: 'round-1',
            reviewerId: DAN,
            decision: 'approve',
            now: 140,
          }),
        ),
      ).toEqual({ _tag: 'Refused', reason: 'not_open' })
      const claimed = await run(
        r.claimDueJobs({
          now: 1_000_000,
          limit: 10,
          leaseMs: 1000,
          claimedBy: 'w',
        }),
      )
      expect(claimed.map(j => j.key).sort()).toEqual([
        'deadline:later',
        'rr:carol',
      ])
    })

    test('draft comments and replies, and resolving', async () => {
      const s = await published()
      const { r } = s
      const draftComment = (authorId: string) => ({
        id: `dc-${authorId}`,
        reportId: REPORT,
        draftNumber: 1,
        authorId,
        sectionId: 'sec-a',
        itemId: null,
        rangeFrom: null,
        rangeTo: null,
        quoted: null,
        body: 'Note to self',
        redactedBody: null,
        visibility: 'authors' as const,
        now: 170,
      })
      expect(await run(r.addDraftComment(draftComment(ALICE)))).toEqual({
        _tag: 'Added',
      })
      expect(await run(r.addDraftComment(draftComment(CAROL)))).toEqual({
        _tag: 'Refused',
        reason: 'not_found',
      })
      expect(
        await run(
          r.addDraftComment({
            ...draftComment(ALICE),
            id: 'dc-x',
            draftNumber: 7,
          }),
        ),
      ).toEqual({ _tag: 'Refused', reason: 'not_found' })
      expect(
        await run(
          r.addReply({
            id: 'rp-1',
            commentId: 'dc-u-alice',
            authorId: ALICE,
            body: 'Reply',
            redactedBody: null,
            now: 171,
          }),
        ),
      ).toBe(true)
      expect(
        await run(
          r.addReply({
            id: 'rp-2',
            commentId: 'nope',
            authorId: ALICE,
            body: 'Reply',
            redactedBody: null,
            now: 171,
          }),
        ),
      ).toBe(false)
      expect(await run(r.setCommentResolved('dc-u-alice', true))).toBe(true)
      expect(await run(r.setCommentResolved('nope', true))).toBe(false)
      const listed = await run(
        r.listComments({
          reportId: REPORT,
          kind: 'draft',
          number: 1,
          audience: { kind: 'authors' },
        }),
      )
      expect(listed.comments).toEqual([
        expect.objectContaining({
          id: 'dc-u-alice',
          resolved: true,
          authorName: 'Alice Author',
        }),
      ])
      expect(listed.replies).toEqual([
        expect.objectContaining({
          id: 'rp-1',
          commentId: 'dc-u-alice',
          authorName: 'Alice Author',
        }),
      ])
      const hidden = await run(
        r.listComments({
          reportId: REPORT,
          kind: 'draft',
          number: 1,
          audience: { kind: 'reviewer', userId: CAROL },
        }),
      )
      expect(hidden.comments).toEqual([])
      expect(hidden.replies).toEqual([])
    })

    // ---- jobs, inbox, events, audit -----------------------------------------------------------
    test('jobs are claimed once, leased, finished and read from the inbox', async () => {
      const s = await published()
      const { r } = s
      const extra = await run(
        r.extendDeadline({
          roundId: 'round-1',
          reportId: REPORT,
          deadlineAt: 20_000,
          deadlineZone: 'Europe/Madrid',
          jobs: [
            job('n1', CAROL, 'review_request', 100),
            job('n2', CAROL, 'review_request', 200),
            job('n1', CAROL, 'review_request', 100),
          ],
          now: 120,
          audit: audit('round.extend', ALICE, 120),
        }),
      )
      expect(extra).toEqual({ _tag: 'Extended' })
      expect(
        (await run(r.listJobKeys(REPORT))).filter(k => k.startsWith('n')),
      ).toEqual(['n1', 'n2'])
      const first = await run(
        r.claimDueJobs({ now: 150, limit: 1, leaseMs: 100, claimedBy: 'w1' }),
      )
      expect(first).toHaveLength(1)
      expect(first[0]).toEqual(
        expect.objectContaining({
          key: 'n1',
          state: 'claimed',
          claimedBy: 'w1',
          leaseUntil: 250,
          attempts: 1,
        }),
      )
      const second = await run(
        r.claimDueJobs({ now: 150, limit: 10, leaseMs: 100, claimedBy: 'w2' }),
      )
      expect(second.map(j => j.key)).toEqual([])
      const retaken = await run(
        r.claimDueJobs({ now: 300, limit: 10, leaseMs: 100, claimedBy: 'w2' }),
      )
      expect(retaken.map(j => [j.key, j.attempts]).sort()).toEqual([
        ['n1', 2],
        ['n2', 1],
      ])
      const n1 = retaken.find(j => j.key === 'n1') as NonNullable<
        (typeof retaken)[number]
      >
      const n2 = retaken.find(j => j.key === 'n2') as NonNullable<
        (typeof retaken)[number]
      >
      await run(
        r.finishJobs({ claimedBy: 'w1', done: [n1.id], skipped: [], now: 310 }),
      )
      expect(await run(r.listInbox(CAROL, 10))).toEqual([])
      await run(
        r.finishJobs({
          claimedBy: 'w2',
          done: [n1.id, n2.id],
          skipped: [],
          now: 311,
        }),
      )
      const inbox = await run(r.listInbox(CAROL, 10))
      expect(inbox.map(j => j.key)).toEqual(['n2', 'n1'])
      expect(inbox.every(j => j.state === 'done' && j.readAt === null)).toBe(
        true,
      )
      expect(await run(r.markInboxRead(DAN, [n1.id], 320))).toBe(0)
      expect(await run(r.markInboxRead(CAROL, [n1.id], 320))).toBe(1)
      expect(await run(r.markInboxRead(CAROL, [n1.id], 321))).toBe(0)
      expect(await run(r.markInboxRead(CAROL, [], 321))).toBe(0)
      expect((await run(r.listInbox(CAROL, 1))).map(j => j.key)).toEqual(['n2'])
    })

    test('a read event is recorded once', async () => {
      const s = await published()
      const { r } = s
      const event = (kind: 'draft_read' | 'notified', at: number) =>
        run(
          r.recordEvent({
            reportId: REPORT,
            kind,
            accountId: CAROL,
            draftNumber: 1,
            at,
          }),
        )
      await event('draft_read', 1)
      await event('draft_read', 2)
      await event('notified', 3)
      await event('notified', 4)
      expect(
        (await run(r.listEvents(REPORT))).map(e => [e.kind, e.at]),
      ).toEqual([
        ['draft_read', 1],
        ['notified', 3],
        ['notified', 4],
      ])
    })

    test('the audit log lists newest first, by report and by template', async () => {
      const { r } = await setup()
      await run(
        r.appendAudit({
          at: 5,
          actorId: ALICE,
          action: 'one',
          templateId: TEMPLATE,
        }),
      )
      await run(
        r.appendAudit({
          at: 6,
          actorId: null,
          action: 'two',
          reportId: REPORT,
          meta: '{"k":1}',
        }),
      )
      expect(
        (await run(r.listAudit({ templateId: TEMPLATE, limit: 10 }))).map(
          a => a.action,
        ),
      ).toEqual(['one'])
      const mine = await run(r.listAudit({ reportId: REPORT, limit: 1 }))
      expect(mine).toEqual([
        expect.objectContaining({
          action: 'two',
          meta: '{"k":1}',
          actorId: null,
        }),
      ])
    })

    // ---- images --------------------------------------------------------------------------
    test('a one-chunk image reads back byte for byte', async () => {
      const { r } = await setup()
      const data = toBase64(syntheticBytes(1000, 3))
      const stored = await run(
        r.putImageChunk(chunkInput({ imageId: 'img-1', data })),
      )
      expect(stored).toEqual(
        expect.objectContaining({
          _tag: 'Stored',
          received: 1,
          complete: true,
          image: expect.objectContaining({
            id: 'img-1',
            size: 1000,
            complete: true,
            referenced: false,
          }),
        }),
      )
      expect(await run(r.readImageChunk('img-1', 0))).toBe(data)
      expect(await run(r.readImageChunk('img-1', 1))).toBeNull()
      expect(await run(r.getImage('img-1'))).toEqual(
        expect.objectContaining({
          hash: 'sha-synthetic',
          owner: { kind: 'report', reportId: REPORT },
        }),
      )
      expect(await run(r.getImage('nope'))).toBeNull()
      expect((await run(r.listReportImages(REPORT))).map(i => i.id)).toEqual([
        'img-1',
      ])
    })

    test('a 1 MB image comes back in two chunks, identical', async () => {
      const { r } = await setup()
      const bytes = syntheticBytes(1_000_000, 5)
      const parts = [bytes.subarray(0, CHUNK), bytes.subarray(CHUNK)]
      const base = {
        imageId: 'img-big',
        size: 1_000_000,
        chunkCount: 2,
        width: 1000,
        height: 1000,
      }
      const second = await run(
        r.putImageChunk(
          chunkInput({
            ...base,
            index: 1,
            data: toBase64(parts[1] as Uint8Array),
          }),
        ),
      )
      expect(second).toEqual(
        expect.objectContaining({
          _tag: 'Stored',
          received: 1,
          complete: false,
          image: null,
        }),
      )
      expect(await run(r.readImageChunk('img-big', 1))).toBeNull()
      const first = await run(
        r.putImageChunk(
          chunkInput({
            ...base,
            index: 0,
            data: toBase64(parts[0] as Uint8Array),
          }),
        ),
      )
      expect(first).toEqual(
        expect.objectContaining({
          _tag: 'Stored',
          received: 2,
          complete: true,
        }),
      )
      expect(await run(r.readImageChunk('img-big', 0))).toBe(
        toBase64(parts[0] as Uint8Array),
      )
      expect(await run(r.readImageChunk('img-big', 1))).toBe(
        toBase64(parts[1] as Uint8Array),
      )
      const stats = await run(r.imageStats(REPORT))
      expect(stats.databaseBytes).toBe(
        toBase64(parts[0] as Uint8Array).length +
          toBase64(parts[1] as Uint8Array).length,
      )
      expect(stats.reportBytes).toBe(1_000_000)
    })

    test('a bad chunk, a repeated chunk and a changed description are refused', async () => {
      const { r } = await setup()
      const put = (o: Partial<ImageChunkInput>) =>
        run(r.putImageChunk(chunkInput({ imageId: 'img-1', ...o })))
      expect(await put({ size: 1_000_001, chunkCount: 2 })).toEqual({
        _tag: 'Refused',
        reason: 'bad_chunk',
      })
      expect(await put({ data: 'not base64!' })).toEqual({
        _tag: 'Refused',
        reason: 'bad_chunk',
      })
      expect(await put({ data: toBase64(syntheticBytes(999, 1)) })).toEqual({
        _tag: 'Refused',
        reason: 'bad_chunk',
      })
      expect(await put({ index: 1 })).toEqual({
        _tag: 'Refused',
        reason: 'bad_chunk',
      })
      expect(await put({ width: 1601 })).toEqual({
        _tag: 'Refused',
        reason: 'bad_chunk',
      })
      expect(await run(r.getImage('img-1'))).toBeNull()
      const big = {
        size: 1_000_000,
        chunkCount: 2,
        data: toBase64(syntheticBytes(CHUNK, 2)),
      }
      expect((await put(big))._tag).toBe('Stored')
      expect(await put(big)).toEqual({ _tag: 'Refused', reason: 'duplicate' })
      expect(
        await put({
          ...big,
          size: 900_000,
          data: toBase64(syntheticBytes(CHUNK, 2)),
        }),
      ).toEqual({ _tag: 'Refused', reason: 'mismatch' })
      expect(await put({ ...big, uploadedBy: BOB })).toEqual({
        _tag: 'Refused',
        reason: 'mismatch',
      })
      expect(await put({ ...big, owner: { kind: 'theme' } })).toEqual({
        _tag: 'Refused',
        reason: 'mismatch',
      })
      expect((await run(r.getImage('img-1')))?.chunksReceived).toBe(1)
    })

    test('a report holds at most 20 MB of images', async () => {
      const { r } = await setup()
      const piece = toBase64(syntheticBytes(CHUNK, 4))
      for (let i = 0; i < 20; i++) {
        const stored = await run(
          r.putImageChunk(
            chunkInput({
              imageId: `img-${i}`,
              size: 1_000_000,
              chunkCount: 2,
              index: 0,
              data: piece,
            }),
          ),
        )
        expect(stored._tag).toBe('Stored')
      }
      expect(
        await run(
          r.putImageChunk(
            chunkInput({
              imageId: 'img-over',
              size: 1_000_000,
              chunkCount: 2,
              index: 0,
              data: piece,
            }),
          ),
        ),
      ).toEqual({
        _tag: 'Refused',
        reason: 'report_limit',
      })
      expect(await run(r.getImage('img-over'))).toBeNull()
      expect((await run(r.imageStats(REPORT))).reportBytes).toBe(20_000_000)
      expect(
        (
          await run(
            r.putImageChunk(
              chunkInput({
                imageId: 'img-small',
                index: 0,
                owner: { kind: 'theme' },
              }),
            ),
          )
        )._tag,
      ).toBe('Stored')
    }, 120_000)

    test('the 400 MB database guard refuses a chunk that would pass it, and nothing is stored', async () => {
      const piece = toBase64(syntheticBytes(1000, 9))
      const { r } = await setup({
        initialImageBytes: 400_000_000 - piece.length + 1,
      })
      expect(
        await run(
          r.putImageChunk(chunkInput({ imageId: 'img-full', data: piece })),
        ),
      ).toEqual({
        _tag: 'Refused',
        reason: 'database_full',
      })
      expect(await run(r.getImage('img-full'))).toBeNull()
      expect(await run(r.imageStats(REPORT))).toEqual(
        expect.objectContaining({
          databaseBytes: 400_000_000 - piece.length + 1,
          databaseLimitBytes: 400_000_000,
        }),
      )
      const { r: ok } = await setup({
        initialImageBytes: 400_000_000 - piece.length,
      })
      expect(
        (
          await run(
            ok.putImageChunk(chunkInput({ imageId: 'img-last', data: piece })),
          )
        )._tag,
      ).toBe('Stored')
      expect((await run(ok.imageStats(null))).databaseBytes).toBe(400_000_000)
    })

    test('a shared draft references its images; unreferenced ones can be deleted and free their bytes', async () => {
      const s = await setup()
      const { r } = s
      const png = toBase64(syntheticBytes(1000, 1))
      await run(r.putImageChunk(chunkInput({ imageId: 'img-safe', data: png })))
      await run(
        r.putImageChunk(chunkInput({ imageId: 'img-unsafe', data: png })),
      )
      await run(
        r.putImageChunk(chunkInput({ imageId: 'img-loose', data: png })),
      )
      const before = await run(r.imageStats(REPORT))
      const staged = await share(s, {
        baseDraft: 0,
        shareId: 'share-1',
        sections: [
          {
            id: 'sec-a',
            content: '{"a":1}',
            images:
              '[{"id":"img-safe","safe":true},{"id":"img-unsafe","safe":false}]',
          },
          {
            id: 'sec-b',
            content: '{"b":1}',
            images: '[{"id":"img-safe","safe":false}]',
          },
        ],
      })
      expect(await staged.finish()).toEqual({
        _tag: 'Shared',
        number: 1,
        revision: null,
      })
      const read = (safeOnly: boolean, imageId: string) =>
        run(
          r.readDraftImageChunk({
            reportId: REPORT,
            draftNumber: 1,
            imageId,
            index: 0,
            safeOnly,
          }),
        )
      expect(await read(false, 'img-safe')).toBe(png)
      expect(await read(true, 'img-safe')).toBeNull()
      expect(await read(false, 'img-unsafe')).toBe(png)
      expect(await read(true, 'img-unsafe')).toBeNull()
      expect(await read(false, 'img-loose')).toBeNull()
      expect(
        await run(
          r.readDraftImageChunk({
            reportId: REPORT,
            draftNumber: 0,
            imageId: 'img-safe',
            index: 0,
            safeOnly: false,
          }),
        ),
      ).toBeNull()
      await run(
        r.publishRevision({
          reportId: REPORT,
          draft: 1,
          ...publishInput({ revision: 1, roundId: 'round-1' }),
        }),
      )
      expect(
        await run(
          r.readRevisionImageChunk({
            reportId: REPORT,
            revision: 1,
            imageId: 'img-unsafe',
            index: 0,
            safeOnly: false,
          }),
        ),
      ).toBe(png)
      expect(
        await run(
          r.readRevisionImageChunk({
            reportId: REPORT,
            revision: 1,
            imageId: 'img-unsafe',
            index: 0,
            safeOnly: true,
          }),
        ),
      ).toBeNull()
      expect((await run(r.getImage('img-safe')))?.referenced).toBe(true)
      expect(await run(r.deleteUnreferencedImage('img-safe'))).toEqual({
        _tag: 'Refused',
        reason: 'referenced',
      })
      expect(await run(r.deleteUnreferencedImage('nope'))).toEqual({
        _tag: 'Refused',
        reason: 'not_found',
      })
      expect(await run(r.deleteUnreferencedImage('img-loose'))).toEqual({
        _tag: 'Deleted',
      })
      expect(await run(r.getImage('img-loose'))).toBeNull()
      expect(await run(r.readImageChunk('img-loose', 0))).toBeNull()
      const after = await run(r.imageStats(REPORT))
      expect(after.databaseBytes).toBe(before.databaseBytes - png.length)
      expect(after.reportBytes).toBe(before.reportBytes - 1000)
    })
  })
}
