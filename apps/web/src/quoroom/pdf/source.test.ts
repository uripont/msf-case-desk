import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  DEFAULT_THEME,
  type DownloadVersion,
  INTAKE_TEMPLATE,
  NotFound,
  type ReportState,
  type RevisionOutline,
  type SectionContent,
} from '@case-desk/domain'

import { detailOf } from '../../report.fixtures'
import { recordOf } from '../../templates.fixtures'
import {
  type AuthorClient,
  type Basics,
  type ReviewerClient,
  authorVersion,
  isoDate,
  reviewerVersion,
} from './source'

// NOTE: What the PDF source asks
// the server and what it keeps, with a fake client and invented data.

const EMPTY_SECTION: SectionContent = { values: {}, sections: {} }
const DATE = Date.UTC(2026, 2, 4)
const PERSON_ID = 'person-0123456789'

const withPerson: SectionContent = {
  values: {
    complainant: { type: 'people', personIds: [PERSON_ID] },
  },
  sections: {},
}

const outlineOf = (
  view: 'full' | 'redacted',
  closing: boolean,
): typeof RevisionOutline.Type => ({
  reportId: 'report-1',
  revision: 1,
  label: 'Revision 1',
  caseReference: 'SYN-1',
  caseTitle: 'Synthetic case',
  templateId: INTAKE_TEMPLATE.id,
  templateVersion: INTAKE_TEMPLATE.version,
  view,
  roleId: 'committee',
  canComment: true,
  canVote: true,
  round: { status: 'open', deadline: { at: DATE, timeZone: 'UTC' }, closing },
  closing,
  publishedAt: DATE,
  personLabels: [{ id: PERSON_ID, label: 'Person A' }],
  sections: [{ sectionId: 'case-details', size: 10, notApplicable: false }],
})

const reviewerClient = (
  view: 'full' | 'redacted',
  closing = false,
): ReviewerClient => ({
  GetRevisionOutline: () => Effect.succeed(outlineOf(view, closing)),
  GetTemplateVersion: () => Effect.succeed(recordOf(INTAKE_TEMPLATE)),
  GetTheme: () => Effect.succeed({ theme: DEFAULT_THEME }),
  GetRevisionSection: ({ sectionId }) =>
    Effect.succeed({
      sectionId,
      view,
      content: sectionId === 'case-details' ? withPerson : EMPTY_SECTION,
    }),
})

const textOf = (built: { description: unknown }): string =>
  JSON.stringify(built.description)

describe('reviewer PDFs', () => {
  for (const view of ['redacted', 'full'] as const) {
    test(`print a person's label, never the ID (${view})`, async () => {
      const built = await Effect.runPromise(
        reviewerVersion(reviewerClient(view), 'report-1', 1),
      )
      expect(textOf(built)).toContain('Person A')
      expect(textOf(built)).not.toContain(PERSON_ID)
    })
  }

  test('carry the revision date, never 1970', async () => {
    const built = await Effect.runPromise(
      reviewerVersion(reviewerClient('redacted'), 'report-1', 1),
    )
    expect(built.description.version.date).toBe(isoDate(DATE))
    expect(textOf(built)).not.toContain('1970')
  })
})

const conclusionId = INTAKE_TEMPLATE.conclusion?.id ?? ''

const authorClient = (failOn?: string): AuthorClient => ({
  GetPeople: () => Effect.succeed({ people: [] }),
  GetDraftSection: ({ sectionId }) =>
    sectionId === failOn
      ? Effect.fail(new NotFound())
      : Effect.succeed({
          sectionId,
          view: 'original',
          content: EMPTY_SECTION,
        }),
})

const basics = (state: ReportState): Basics => ({
  reportId: 'report-1',
  summary: detailOf(INTAKE_TEMPLATE, state).summary,
  template: INTAKE_TEMPLATE,
  theme: DEFAULT_THEME,
  history: { drafts: [], revisions: [] },
})

const version: typeof DownloadVersion.Type = {
  kind: 'draft',
  number: 1,
  label: 'Draft 1',
  view: 'original',
  closing: false,
  at: DATE,
}

const conclusionTitle = INTAKE_TEMPLATE.conclusion?.title ?? ''

describe('author PDFs and the conclusion', () => {
  test('a drafting report without a conclusion prints none', async () => {
    const built = await Effect.runPromise(
      authorVersion(authorClient(), basics('drafting'), version),
    )
    expect(conclusionTitle).not.toBe('')
    expect(textOf(built)).not.toContain(conclusionTitle)
  })

  test('a concluding report prints it', async () => {
    const built = await Effect.runPromise(
      authorVersion(authorClient(), basics('concluding'), version),
    )
    expect(textOf(built)).toContain(conclusionTitle)
  })

  test('a failing section fails the file, nothing is swallowed', async () => {
    const result = await Effect.runPromise(
      Effect.flip(
        authorVersion(authorClient(conclusionId), basics('drafting'), version),
      ),
    )
    expect(result).toBeInstanceOf(NotFound)
  })
})
