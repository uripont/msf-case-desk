import { Effect, Result } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'

import {
  BUILT_IN_TEMPLATES,
  INVESTIGATION_TEMPLATE,
  PROCEDURES,
  QuoroomPublicRpcs,
  type ReportContent,
  type SectionContent,
  type Section,
  type Template,
  anchorText,
} from '@case-desk/domain'
import { fullContent } from '@case-desk/domain/testing/fixtures'

import { topLevelIds } from './content'
import { peopleOfRevision } from './reviewer'
import { makePng, pngChunk } from './imageFixtures'
import {
  type Client,
  type PersonName,
  SCENARIOS,
  type Scenario,
  type World,
  makeWorld,
} from './testkit'

// NOTE: Stage 5, the leak test of the "done when": for each built-in template
// and the invented panel template, a draft whose people list has aliases in
// every kind of text a report holds, and images not marked safe, is shared and
// published to a `redacted` role. Then every procedure a reviewer can reach is
// called by the reviewers of that role, and not one response, error included,
// may hold an alias or the ID of an image that was not marked safe. The check
// is an independent tokenizer written here, not the redaction code. All names
// are invented.

const worlds: Array<World> = []
afterEach(async () => {
  await Promise.all(worlds.splice(0).map(world => world.dispose()))
})

const FIRST = 'Zorana Veltkamp'
const SECOND = 'Bertil Nwosu'
const PEOPLE = [
  {
    id: 'person-1',
    name: FIRST,
    label: 'Person A',
    aliases: ['Zorana', 'Veltkamp', 'Z. Veltkamp'],
  },
  {
    id: 'person-2',
    name: SECOND,
    label: 'Person B',
    aliases: ['Bertil', 'Nwosu'],
  },
] as const
// NOTE: What no response may contain, as letters only.
const FORBIDDEN_WORDS = ['zorana', 'veltkamp', 'bertil', 'nwosu']
const UNSAFE_IMAGE = 'img-unsafe-q7x'
const SAFE_IMAGE = 'img-safe-m2k'

const both = `${FIRST} and ${SECOND}`

const paragraph = (text: string, marks?: ReadonlyArray<unknown>) => ({
  type: 'paragraph' as const,
  content: [
    { type: 'text' as const, text, ...(marks === undefined ? {} : { marks }) },
  ],
})

// NOTE: One document with every kind of rich text node that can hold a name:
// a heading, bold text, a link (its text, its title and its target), a list,
// a table cell, and two figures (alt text and caption), one of them not
// marked safe.
const plantedDoc = () => ({
  type: 'doc' as const,
  content: [
    {
      type: 'heading' as const,
      attrs: { level: 2 },
      content: [{ type: 'text' as const, text: `Heading about ${FIRST}` }],
    },
    {
      type: 'paragraph' as const,
      content: [
        { type: 'text' as const, text: `Statement of ${both}, ` },
        {
          type: 'text' as const,
          text: `bold ${SECOND}`,
          marks: [{ type: 'bold' as const }],
        },
        {
          type: 'text' as const,
          text: ` link about ${FIRST}`,
          marks: [
            {
              type: 'link' as const,
              attrs: {
                href: 'https://example.org/people/zorana-veltkamp?q=Bertil%20Nwosu',
                title: `Page of ${FIRST}`,
              },
            },
          ],
        },
      ],
    },
    {
      type: 'bulletList' as const,
      content: [{ type: 'listItem' as const, content: [paragraph(`Item ${SECOND}`)] }],
    },
    {
      type: 'table' as const,
      content: [
        {
          type: 'tableRow' as const,
          content: [
            { type: 'tableCell' as const, content: [paragraph(`Cell ${FIRST}`)] },
          ],
        },
      ],
    },
    {
      type: 'figure' as const,
      attrs: { imageId: UNSAFE_IMAGE, alt: `Photo of ${FIRST}`, safeToShare: false },
      content: [{ type: 'text' as const, text: `Caption ${SECOND}` }],
    },
    {
      type: 'figure' as const,
      attrs: { imageId: SAFE_IMAGE, alt: `Plan by ${SECOND}`, safeToShare: true },
      content: [{ type: 'text' as const, text: `Caption ${FIRST}` }],
    },
  ],
})

type Plain = Record<string, unknown>

const plantValue = (value: Plain): Plain => {
  switch (value.type) {
    case 'text':
      return { ...value, text: `Said ${both}` }
    case 'rich_text':
      return { ...value, doc: plantedDoc() }
    case 'signature':
      return { ...value, name: FIRST }
    case 'not_applicable':
      return { ...value, reason: `Because of ${FIRST}` }
    case 'repeated':
      return {
        ...value,
        entries: (value.entries as ReadonlyArray<Plain>).map(entry => ({
          ...entry,
          values: plantValues(entry.values as Plain),
        })),
      }
    default:
      return value
  }
}

const plantValues = (values: Plain): Plain =>
  Object.fromEntries(
    Object.entries(values).map(([id, value]) => [id, plantValue(value as Plain)]),
  )

const plantSections = (sections: Plain): Plain =>
  Object.fromEntries(
    Object.entries(sections).map(([id, section]) => [id, plantSection(section as Plain)]),
  )

// NOTE: Every string a section holds gets a name: values of every type, entry
// titles, the reason a section does not apply, and everything of the nested
// sections and entries.
const plantSection = (section: Plain): Plain => ({
  ...section,
  ...(section.notApplicable === undefined
    ? {}
    : { notApplicable: { reason: `Not applicable because of ${SECOND}` } }),
  values: plantValues(section.values as Plain),
  sections: plantSections(section.sections as Plain),
  ...(section.entries === undefined
    ? {}
    : {
        entries: (section.entries as ReadonlyArray<Plain>).map(entry => ({
          ...entry,
          title: `Entry of ${FIRST}`,
          values: plantValues(entry.values as Plain),
          sections: plantSections(entry.sections as Plain),
        })),
      }),
})

const optionalWithReason = (template: Template): ReadonlyArray<string> => {
  const ids: Array<string> = []
  const walk = (sections: ReadonlyArray<Section>): void => {
    for (const section of sections) {
      if (section.requirement === 'optional_with_reason') ids.push(section.id)
      walk(section.sections)
    }
  }
  walk(template.sections)
  return ids
}

const plantedContent = (template: Template): ReportContent => {
  const base = fullContent(template, {
    notApplicable: optionalWithReason(template),
  })
  return {
    ...base,
    sections: plantSections(base.sections as unknown as Plain) as unknown as ReportContent['sections'],
  }
}

// ---- The independent tokenizer ------------------------------------------------------

// NOTE: Every run of percent-escapes decoded on its own, so one literal `%`
// never stops the others from being read, and decoded again until the text no
// longer changes (a name escaped twice).
const decodeStable = (text: string): string => {
  let current = text
  for (let round = 0; round < 8; round += 1) {
    const next = current.replace(/(?:%[0-9a-fA-F]{2})+/g, run => {
      try {
        return decodeURIComponent(run)
      } catch {
        return run
      }
    })
    if (next === current) break
    current = next
  }
  return current
}

// NOTE: Text reduced to lower-case letters and digits, without accents,
// whatever separated them, so a name cannot hide behind a space, a dot, an
// accent or an escape.
const letters = (text: string): string =>
  `${text}\n${decodeStable(text)}`
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\n]/gu, '')

// NOTE: the bytes of the picture that is not marked safe carry a marker.
const MARKER = 'unsafe-marker-q7x-not-for-reviewers'
const markerBytes = [...MARKER].map(c => c.charCodeAt(0))
const unsafePng = () => makePng([pngChunk('prVt', markerBytes)])
const unsafeBase64 = btoa(String.fromCharCode(...unsafePng()))

// NOTE: any base64-looking run of the text that decodes to bytes holding the
// marker, or the whole picture as base64.
const holdsImageBytes = (text: string): boolean => {
  if (text.includes(unsafeBase64)) return true
  for (const token of text.match(/[A-Za-z0-9+/_-]{16,}={0,2}/g) ?? []) {
    for (const variant of [token, token.replace(/-/g, '+').replace(/_/g, '/')]) {
      for (let drop = 0; drop < 4; drop += 1) {
        const body = variant.slice(drop)
        try {
          const bytes = atob(body.slice(0, body.length - (body.length % 4)))
          if (bytes.includes(MARKER)) return true
        } catch {
          // NOTE: not base64 at this alignment.
        }
      }
    }
  }
  return false
}

const leaks = (text: string): ReadonlyArray<string> => [
  ...FORBIDDEN_WORDS.filter(word => letters(text).includes(word)),
  ...[UNSAFE_IMAGE].filter(id => text.includes(id)),
  ...(holdsImageBytes(text) ? ['image bytes'] : []),
]

// NOTE: no run of three letters of any alias in a quoted text (a selection
// cut inside a name is as bad as the name).
const ALIAS_LETTERS = PEOPLE.flatMap(person =>
  [person.name, ...person.aliases].map(alias => letters(alias).replace(/\n/g, '')),
)
const aliasFragments = (quoted: string): ReadonlyArray<string> => {
  const flat = letters(quoted).replace(/\n/g, '')
  const found: Array<string> = []
  for (const alias of ALIAS_LETTERS) {
    for (let at = 0; at + 3 <= alias.length; at += 1) {
      const gram = alias.slice(at, at + 3)
      if (flat.includes(gram)) found.push(gram)
    }
  }
  return found
}

// ---- Every procedure ------------------------------------------------------------------

type Context = Readonly<{
  reportId: string
  revision: number
  sectionId: string
  itemId: string
  commentId: string
  caseFileId: string
  imageId: string
  template: Template
}>

// NOTE: One request per procedure of `QuoroomRpcs`; the first test fails if a
// procedure of the contract has none.
const R = (c: Context) => ({ reportId: c.reportId })
const REVISION = (c: Context) => ({ reportId: c.reportId, revision: c.revision })
const SECTION = (c: Context) => ({
  reportId: c.reportId,
  revision: c.revision,
  sectionId: c.sectionId,
})
const DEADLINE = { at: Date.UTC(2026, 11, 30), timeZone: 'Europe/Madrid' }

const REQUESTS: Readonly<Record<string, (c: Context) => unknown>> = {
  GetMe: () => ({}),
  SignOut: () => ({}),
  ListPendingReviews: () => ({}),
  SetNotificationPreferences: () => ({ notifyOnApproval: false }),
  ListAccounts: () => ({}),
  IssueReset: () => ({ accountId: 'alice' }),
  GrantCapability: () => ({ email: 'someone@case-desk.test', capability: 'author', unit: 'unit-1' }),
  RevokeCapability: () => ({ accountId: 'alice', capability: 'author', unit: 'unit-1' }),
  ListUnits: () => ({}),
  CreateUnit: () => ({ name: 'Unit Three', code: 'U3' }),
  UpdateUnit: () => ({ unit: 'unit-1', name: 'Unit One' }),
  ListUnitMembers: () => ({ unit: 'unit-1' }),
  InviteToUnit: () => ({ unit: 'unit-1', email: 'new@case-desk.test', name: 'New Author' }),
  ListReviewers: () => ({ unit: 'unit-1' }),
  AddReviewer: () => ({ unit: 'unit-1', name: 'New Reviewer', email: 'nr@case-desk.test', whatsappConsent: false }),
  UpdateReviewer: () => ({ unit: 'unit-1', accountId: 'dan', name: 'Dan Reviewer' }),
  ListCommittees: () => ({ unit: 'unit-1' }),
  CreateCommittee: () => ({ unit: 'unit-1', name: 'Committee', memberIds: [] }),
  UpdateCommittee: () => ({ committeeId: 'none', name: 'Committee' }),
  ListTemplates: () => ({}),
  ListPublishedTemplates: () => ({}),
  GetTemplateVersion: c => ({
    templateId: c.template.id,
    version: c.template.version,
    reportId: c.reportId,
    revision: c.revision,
  }),
  CreateTemplateDraft: () => ({ name: 'Copy' }),
  SaveTemplateDraft: c => ({ templateId: c.template.id, version: 99, template: c.template }),
  PublishTemplateVersion: c => ({ templateId: c.template.id, version: 99 }),
  RetireTemplate: c => ({ templateId: c.template.id }),
  GetTheme: () => ({}),
  UpdateTheme: () => ({ theme: {} }),
  ListCaseFiles: () => ({ unit: 'unit-1' }),
  UpdateCaseFile: c => ({ caseFileId: c.caseFileId, title: 'Another title' }),
  CreateReport: c => ({
    unit: 'unit-1',
    caseFile: { reference: 'REF-X', title: 'Title' },
    templateId: c.template.id,
    templateVersion: c.template.version,
  }),
  ListReports: () => ({}),
  GetReport: R,
  AddCoAuthor: c => ({ ...R(c), accountId: 'bob' }),
  ListDrafting: R,
  StartWorkingCopy: R,
  GetWorkingCopy: R,
  GetWorkingCopySection: c => ({ ...R(c), sectionId: c.sectionId }),
  SaveSection: c => ({
    ...R(c),
    sectionId: c.sectionId,
    saveCounter: 0,
    content: { values: {}, sections: {} },
  }),
  SavePeople: c => ({ ...R(c), saveCounter: 0, people: [] }),
  GetPeople: c => ({ ...R(c), draft: 1 }),
  ShareSection: c => ({ ...R(c), shareId: 'share-x', sectionId: c.sectionId, saveCounter: 0 }),
  FinishShare: c => ({ ...R(c), shareId: 'share-x', saveCounter: 0 }),
  PreviewMerge: R,
  ResolveMerge: c => ({ ...R(c), saveCounter: 0, choices: {} }),
  GetHistory: R,
  GetDraftOutline: c => ({ ...R(c), draft: 1 }),
  GetDraftSection: c => ({ ...R(c), draft: 1, sectionId: c.sectionId, view: 'original' }),
  CompareDrafts: c => ({ ...R(c), from: 0, to: 1 }),
  ConfirmRedaction: c => ({ ...R(c), draft: 1, redactedHash: 'x' }),
  ListImages: R,
  MarkImageSafe: c => ({ ...R(c), imageId: UNSAFE_IMAGE, safe: true, saveCounter: 0 }),
  GetPublishChoices: R,
  PublishRevision: c => ({
    ...R(c),
    draft: 1,
    terms: { deadline: DEADLINE, selections: [], closing: false },
  }),
  GetRound: REVISION,
  ExtendDeadline: c => ({ ...REVISION(c), deadline: DEADLINE }),
  RemoveReviewer: c => ({ ...REVISION(c), accountId: 'dan' }),
  StartConclusion: R,
  ArchiveReport: R,
  ListInbox: () => ({}),
  GetRevisionOutline: REVISION,
  GetRevisionSection: SECTION,
  ListReviewerComments: REVISION,
  AddComment: c => ({
    ...REVISION(c),
    anchor: { kind: 'section', sectionId: c.sectionId },
    body: 'Please clarify this part.',
    visibility: 'committee',
  }),
  UpdatePendingComment: c => ({ ...R(c), commentId: c.commentId, body: 'Edited.' }),
  DeletePendingComment: c => ({ ...R(c), commentId: 'no-such-comment' }),
  GetPendingReview: REVISION,
  SavePendingReview: REVISION,
  SendReview: c => ({ ...REVISION(c), decision: 'comment' }),
  ListDraftComments: c => ({ ...R(c), draft: 1 }),
  AddDraftComment: c => ({
    ...R(c),
    draft: 1,
    anchor: { kind: 'section', sectionId: c.sectionId },
    body: 'Hello.',
  }),
  ListRevisionComments: REVISION,
  ReplyToComment: c => ({ ...R(c), commentId: c.commentId, body: 'Reply.' }),
  ResolveComment: c => ({ ...R(c), commentId: c.commentId, resolved: true }),
  GetGrid: R,
  ListAuditEvents: c => ({ subject: { kind: 'report', reportId: c.reportId }, limit: 50 }),
  ListNotifications: () => ({ limit: 50 }),
  GetUnreadCount: () => ({}),
  MarkNotificationsRead: () => ({ ids: ['1'] }),
  GetWhatsAppLink: c => ({ ...REVISION(c), accountId: 'dan' }),
  RecordWhatsAppOpened: c => ({ ...REVISION(c), accountId: 'dan' }),
  GetDownloads: R,
  GetApprovalRecordData: R,
}
// NOTE: the group of the public procedures is served somewhere else, with no
// session, and carries no report: it is left out here on purpose.
const PUBLIC = new Set<string>([...QuoroomPublicRpcs.requests.keys()])
const SIGNED_IN = Object.keys(PROCEDURES).filter(name => !PUBLIC.has(name))

const LEAK_SCENARIOS: ReadonlyArray<Scenario> = [
  ...SCENARIOS,
  {
    name: 'built-in investigation template, in memory',
    template: INVESTIGATION_TEMPLATE,
    backend: 'memory',
    authorsRole: 'authors',
    redactedRole: 'committee',
    sectionId: 'introduction',
    itemId: 'introduction-text',
  },
]

const pngQuery = (id: string, reportId: string, size: number) =>
  `uploadId=${id}&owner=${reportId}&index=0&chunks=1&mime=image%2Fpng&width=1&height=1&size=${size}`

const call = async (
  w: World,
  who: PersonName,
  name: string,
  payload: unknown,
): Promise<string> => {
  const program = (client: Client) =>
    (client as unknown as Record<string, (p: unknown) => ReturnType<Client['GetMe']>>)[name]?.(payload) as never
  try {
    const result = await w.attempt(who, program)
    return JSON.stringify(result)
  } catch (error) {
    return `defect: ${String(error)}`
  }
}

describe('what a redacted role can reach', () => {
  test('the leak test covers every procedure of the contract', () => {
    const missing = SIGNED_IN.filter(name => REQUESTS[name] === undefined)
    expect(missing).toEqual([])
    expect(SIGNED_IN.length).toBe(Object.keys(PROCEDURES).length - PUBLIC.size)
    // NOTE: the two built-in templates are both covered by a scenario.
    for (const template of BUILT_IN_TEMPLATES) {
      expect(LEAK_SCENARIOS.some(scenario => scenario.template.id === template.id)).toBe(true)
    }
  })

  test('the tokenizer reads escapes safely, repeatedly, and finds image bytes', () => {
    // NOTE: a literal % never stops the scan, and a name escaped twice is read.
    expect(leaks('100% sure %zz and %5A%6Frana%20Veltkamp')).toEqual(['zorana', 'veltkamp'])
    expect(leaks('%255A%256Frana')).toEqual(['zorana'])
    expect(leaks('plain text')).toEqual([])
    expect(leaks(`{"base64":"${unsafeBase64}"}`)).toEqual(['image bytes'])
    expect(leaks(`{"base64":"${btoa(String.fromCharCode(...makePng()))}"}`)).toEqual([])
  })

  test('a revision or draft that cannot be found is refused, never an empty list of names', async () => {
    const found = { getDraft: () => Effect.succeed(null) } as never
    const loaded = {
      record: { id: 'report-1' },
      revisions: [{ number: 1, draftNumber: 1 }],
    } as never
    const missingDraft = await Effect.runPromise(
      Effect.result(peopleOfRevision(found, loaded, 1)),
    )
    expect(Result.isFailure(missingDraft)).toBe(true)
    const missingRevision = await Effect.runPromise(
      Effect.result(peopleOfRevision(found, loaded, 7)),
    )
    expect(Result.isFailure(missingRevision)).toBe(true)
  })

  describe.each(LEAK_SCENARIOS)('$name', scenario => {
    test('no alias and no unmarked image reaches any response a reviewer can get', async () => {
      const w = await makeWorld(scenario)
      worlds.push(w)
      const template = scenario.template
      const planted = plantedContent(template)

      // NOTE: the report, its images, its people and every section, saved by
      // an author.
      const summary = await w.call('alice', c =>
        c.CreateReport({
          unit: 'unit-1',
          caseFile: { reference: `REF-${FIRST}-1`, title: `Case about ${FIRST}` },
          templateId: template.id,
          templateVersion: template.version,
        }),
      )
      const reportId = summary.id
      for (const [id, png] of [
        [UNSAFE_IMAGE, unsafePng()],
        [SAFE_IMAGE, makePng()],
      ] as const) {
        const uploaded = await w.raw('alice', `/api/images?${pngQuery(id, reportId, png.length)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: png,
        })
        expect(uploaded.status).toBe(200)
      }
      const started = await w.call('alice', c => c.StartWorkingCopy({ reportId }))
      let counter = (
        await w.call('alice', c =>
          c.SavePeople({ reportId, saveCounter: started.saveCounter, people: PEOPLE }),
        )
      ).saveCounter
      const conclusionId = template.conclusion?.id
      const ids = topLevelIds(template).filter(id => id !== conclusionId)
      for (const id of ids) {
        const content = planted.sections[id] as SectionContent
        const saved = await w.call('alice', c =>
          c.SaveSection({ reportId, sectionId: id, saveCounter: counter, content }),
        )
        counter = saved.saveCounter
      }

      // NOTE: the control: the author's own view does hold the names, so the
      // scan below is not looking at an empty fixture.
      const mine = JSON.stringify(
        await Promise.all(
          ids.map(id => w.call('alice', c => c.GetWorkingCopySection({ reportId, sectionId: id }))),
        ),
      )
      expect(leaks(mine)).toEqual(expect.arrayContaining(['zorana', 'bertil', UNSAFE_IMAGE]))

      // NOTE: share and publish: the author confirms the preview, then the
      // draft goes to the reviewers of every role.
      const { outcome } = await w.stageAndFinish('alice', reportId, 'share-leak', counter, true)
      if (outcome.kind !== 'shared') throw new Error('not shared')
      const published = await w.publish('alice', reportId, outcome.draft.number)
      const revision = published.revision.number
      const sectionId = ids.find(id => id === scenario.sectionId) ?? (ids[0] as string)
      const itemId = scenario.itemId

      // NOTE: a comment of a reviewer for the committee and the reply of an
      // author with a name in it; and, where the template has a full role, a
      // comment of that reviewer that quotes a name.
      const made = await w.call('carol', c =>
        c.AddComment({
          reportId,
          revision,
          anchor: { kind: 'section', sectionId },
          body: 'Please clarify this part.',
          visibility: 'committee',
        }),
      )
      await w.call('carol', c => c.SendReview({ reportId, revision, decision: 'comment' }))
      await w.call('alice', c =>
        c.ReplyToComment({
          reportId,
          commentId: made.id,
          body: `Thank you, ${FIRST} and ${SECOND} will be asked.`,
        }),
      )
      if (scenario.fullRole !== undefined) {
        const full = await w.call('erin', c =>
          c.GetRevisionSection({ reportId, revision, sectionId }),
        )
        expect(JSON.stringify(full)).toContain('Zorana')
        const text = JSON.stringify(full)
        void text
        // NOTE: selections of the full reviewer that start or end inside a
        // name, over the text of the item as the anchor scheme counts it;
        // every one is shared with the committee.
        const itemText = anchorText(plantedDoc() as never)
        const selections: Array<readonly [number, number]> = [[0, 9]]
        for (const name of [FIRST, SECOND, 'Zorana', 'Veltkamp', 'Bertil', 'Nwosu']) {
          let at = itemText.indexOf(name)
          while (at !== -1 && selections.length < 40) {
            selections.push(
              [at + 2, at + name.length - 2],
              [at - 4, at + 3],
              [at + 3, at + name.length + 5],
              [at + 1, at + 4],
              [at + name.length - 3, at + name.length],
            )
            at = itemText.indexOf(name, at + 1)
          }
        }
        for (const [from, to] of selections) {
          const low = Math.max(0, from)
          await w.call('erin', c =>
            c.AddComment({
              reportId,
              revision,
              anchor: {
                kind: 'text',
                sectionId,
                itemId,
                from: low,
                to,
                quoted: itemText.slice(low, to),
              },
              body: `${FIRST} should be asked again.`,
              visibility: 'committee',
            }),
          )
        }
        await w.call('erin', c => c.SendReview({ reportId, revision, decision: 'comment' }))
      }
      // NOTE: the case file is retitled after the share: still nothing new
      // reaches a redacted role.
      const files = await w.call('alice', c => c.ListCaseFiles({ unit: 'unit-1' }))
      const caseFileId = files[0]?.id ?? ''
      await w.call('alice', c => c.UpdateCaseFile({ caseFileId, title: `Later: ${SECOND}` }))

      const context: Context = {
        reportId,
        revision,
        sectionId,
        itemId,
        commentId: made.id,
        caseFileId,
        imageId: UNSAFE_IMAGE,
        template,
      }
      const readers: ReadonlyArray<PersonName> = [
        'carol',
        'dan',
        ...(scenario.observerRole === undefined ? [] : (['ivy'] as const)),
      ]
      const seen: Array<string> = []
      for (const who of readers) {
        const outline = await w.call(who, c => c.GetRevisionOutline({ reportId, revision }))
        expect(outline.view).toBe('redacted')
        for (const name of SIGNED_IN.filter(entry => entry !== 'SignOut')) {
          const build = REQUESTS[name]
          if (build === undefined) throw new Error(`no request for ${name}`)
          const text = await call(w, who, name, build(context))
          seen.push(`${who} ${name}: ${text}`)
          expect(leaks(text), `${who} ${name}`).toEqual([])
        }
        // NOTE: every top-level section, as a reviewer reads it (nested
        // sections and entries are inside the content of their section).
        for (const id of topLevelIds(template)) {
          const text = await call(w, who, 'GetRevisionSection', { reportId, revision, sectionId: id })
          seen.push(`${who} GetRevisionSection ${id}: ${text}`)
          expect(leaks(text), `${who} section ${id}`).toEqual([])
        }
        // NOTE: a valid pending comment of the reviewer's own, edited and
        // deleted: the answers of both are scanned too.
        const pending = await w.call(who, c =>
          c.AddComment({
            reportId,
            revision,
            anchor: { kind: 'text', sectionId, itemId, from: 0, to: 6, quoted: 'Person' },
            body: 'A note of mine.',
            visibility: 'authors',
          }),
        )
        for (const [name, request] of [
          ['GetPendingReview', REVISION(context)],
          ['UpdatePendingComment', { reportId, commentId: pending.id, body: 'Edited note.', visibility: 'committee' }],
          ['GetPendingReview', REVISION(context)],
          ['DeletePendingComment', { reportId, commentId: pending.id }],
        ] as const) {
          const text = await call(w, who, name, request)
          seen.push(`${who} ${name} (own pending): ${text}`)
          expect(leaks(text), `${who} ${name} own pending comment`).toEqual([])
          expect(text).not.toContain('defect')
        }
        // NOTE: what a quoted text may hold: no run of three letters of any
        // alias, whatever the selection of the full reviewer was.
        const listed = (await w.call(who, c => c.ListReviewerComments({ reportId, revision }))) as ReadonlyArray<{
          anchor: { quoted?: string }
        }>
        let quotes = 0
        for (const comment of listed) {
          if (comment.anchor.quoted === undefined) continue
          quotes += 1
          expect(aliasFragments(comment.anchor.quoted), `${who} quoted ${comment.anchor.quoted}`).toEqual([])
        }
        if (scenario.fullRole !== undefined) expect(quotes).toBeGreaterThan(0)
        // NOTE: the image route, in every context a reviewer can name. The
        // picture that was not marked safe is never served and its answer
        // names nothing.
        const unsafe = [
          `context=revision&revision=${revision}`,
          'context=draft&draft=1',
          'context=working_copy',
        ]
        for (const read of unsafe) {
          const response = await w.raw(who, `/api/images/${UNSAFE_IMAGE}/0?report=${reportId}&${read}`)
          expect(response.status).toBe(404)
          expect(leaks(await response.text())).toEqual([])
        }
        const safe = await w.raw(
          who,
          `/api/images/${SAFE_IMAGE}/0?report=${reportId}&context=revision&revision=${revision}`,
        )
        expect(safe.status).toBe(200)
      }

      // NOTE: the scan was not empty: the reviewers read the labels, and the
      // withheld image is the placeholder.
      const joined = seen.join('\n')
      expect(joined).toContain('Person A')
      expect(joined).toContain('Image withheld')
      expect(joined).not.toContain(UNSAFE_IMAGE)
      for (const who of readers) {
        await call(w, who, 'SignOut', {})
      }
    })
  })
})
