import { Option } from 'effect'

import {
  type AnchoredCommentView,
  type AuthorCommentView,
  INTAKE_TEMPLATE,
  type RevisionOutline,
  type SectionNoteCommentView,
} from '@case-desk/domain'

import { NOW, revision } from './publish.fixtures'
import type * as Review from './quoroom/review'
import { REPORT_ID, detailOf } from './report.fixtures'

// NOTE: Synthetic data for the reading view (stage 6b and 6c): one revision of
// the intake template with a single rich-text paragraph, read by an invented
// reviewer who may comment and vote.

export const SCOPE = { reportId: REPORT_ID, generation: 1 }

export const PARAGRAPH = 'The unit reported a delay in the supply of tents.'

export const PHRASE = 'delay in the supply'

export const FROM = PARAGRAPH.indexOf(PHRASE)

const SUMMARY_CONTENT = {
  values: {
    'summary-text': {
      type: 'rich_text' as const,
      doc: {
        type: 'doc' as const,
        content: [
          {
            type: 'paragraph' as const,
            content: [{ type: 'text' as const, text: PARAGRAPH }],
          },
        ],
      },
    },
  },
  sections: {},
}

export const outlineOf = (
  options: Readonly<{
    status?: 'open' | 'decided' | 'superseded'
    canComment?: boolean
    canVote?: boolean
  }> = {},
): typeof RevisionOutline.Type => ({
  reportId: REPORT_ID,
  revision: 2,
  label: 'Revision 2',
  caseReference: 'SYN-2026-001',
  caseTitle: 'Synthetic supply delay',
  templateId: detailOf(INTAKE_TEMPLATE).summary.templateId,
  templateVersion: detailOf(INTAKE_TEMPLATE).summary.templateVersion,
  view: 'redacted',
  roleId: 'committee',
  canComment: options.canComment ?? true,
  canVote: options.canVote ?? true,
  round: {
    status: options.status ?? 'open',
    deadline: revision(2, 'open').deadline,
    closing: false,
  },
  closing: false,
  publishedAt: 1_700_000_000_000,
  personLabels: [],
  sections: [{ sectionId: 'summary', size: 120, notApplicable: false }],
})

export const textComment = (
  id: string,
  overrides: Partial<AnchoredCommentView> = {},
): AnchoredCommentView => ({
    id,
    revision: 2,
    authorName: 'Reviewer One',
    mine: true,
    body: 'Please say how long.',
    visibility: 'authors',
    sent: false,
    resolved: false,
    createdAt: NOW,
    replies: [],
    anchor: {
      kind: 'text',
      sectionId: 'summary',
      itemId: 'summary-text',
      from: FROM,
      to: FROM + PHRASE.length,
      quoted: PHRASE,
    },
  ...overrides,
})

export const noteComment = (
  id: string,
  overrides: Partial<SectionNoteCommentView> = {},
): SectionNoteCommentView => ({
  id,
  revision: 2,
  authorName: 'Chair Person',
  mine: false,
  body: 'Please say how long.',
  visibility: 'committee',
  sent: true,
  resolved: false,
  createdAt: NOW,
  replies: [],
  anchor: { kind: 'section_note', sectionId: 'summary' },
  ...overrides,
})

export const loaded = (
  options: Readonly<{
    status?: 'open' | 'decided' | 'superseded'
    canVote?: boolean
    comments?: ReadonlyArray<AnchoredCommentView | SectionNoteCommentView>
  }> = {},
): Review.LoadedReview => ({
  outline: outlineOf(options),
  template: INTAKE_TEMPLATE,
  sectionId: 'summary',
  maybeSection: Option.some(SUMMARY_CONTENT),
  comments: options.comments ?? [],
  zone: 'Europe/Madrid',
})

export const authorComment = (
  id: string,
  overrides: Partial<AuthorCommentView> = {},
): AuthorCommentView => ({
    id,
    scope: { kind: 'revision', revision: 2 },
    anchor: {
      kind: 'text',
      sectionId: 'summary',
      itemId: 'summary-text',
      from: FROM,
      to: FROM + PHRASE.length,
      quoted: PHRASE,
    },
    authorId: 'reviewer-1',
    authorName: 'Reviewer One',
    body: 'Please say how long.',
    visibility: 'committee',
    sent: true,
    resolved: false,
    createdAt: NOW,
    replies: [],
  ...overrides,
})

export const replyOf = (id: string, body: string) => ({
  id,
  authorId: 'author-1',
  authorName: 'Synthetic Author',
  body,
  redactedBody: body,
  createdAt: 0,
})
