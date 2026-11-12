import type { ReviewDecision } from './approval'
import {
  type Block,
  type CaseFileInfo,
  type DocumentDescription,
  type Part,
  type TableCell,
  furnitureOf,
  formatDate,
  formatInstant,
  styleOf,
} from './document'
import { type RevisionRow, buildGrid } from './grid'
import type { Person } from './people'
import { redactFileName } from './redaction'
import type { ReportFlow } from './report-flow'
import { type VersionRef, draftLabel, versionSlug } from './report-numbering'
import type { ReportEvent } from './round-events'
import type { Template } from './template'
import type { Theme } from './theme'

// NOTE: The approval record (D4): who decided what on which revision, and
// when. A separate PDF, never part of the content PDF, generated on request
// for the drafting role (names are shown in full). It uses the same
// renderer-neutral description as the content: a cover and a body with one
// heading per revision, a table of the people of its round and the list of
// every review. Times are shown in UTC; the deadline's own time zone is not
// stored in the flow.

export type ApprovalRecordInput = Readonly<{
  template: Template
  flow: ReportFlow
  events: ReadonlyArray<ReportEvent>
  authors: ReadonlyArray<string>
  // NOTE: Display names by account ID.
  accountNames: Readonly<Record<string, string>>
  caseFile: CaseFileInfo
  theme: Theme
  reportName: string
  // NOTE: `YYYY-MM-DD`.
  date: string
}>

export const DECISION_LABELS: Readonly<Record<ReviewDecision, string>> = {
  approve: 'Approved',
  request_changes: 'Requested changes',
  comment: 'Comment only',
}

const paragraph = (text: string, bold = false): Block => ({
  type: 'paragraph',
  runs: [{ text, ...(bold ? { bold: true as const } : {}) }],
})

const cell = (text: string, header = false): TableCell => ({
  header,
  colspan: 1,
  rowspan: 1,
  colwidth: undefined,
  blocks: [paragraph(text, header)],
})

const statusText = (row: RevisionRow): string => {
  if (row.status === 'superseded') {
    return row.replacedBy === undefined
      ? 'Replaced by a newer revision'
      : `Replaced by Revision ${row.replacedBy}`
  }
  if (row.status === 'open') return 'Open'
  const how =
    row.decidedBy === 'rule_met'
      ? 'the approval rule was met'
      : 'the deadline passed'
  return row.decidedAt === undefined
    ? `Decided: ${how}`
    : `Decided ${formatInstant(row.decidedAt)}: ${how}`
}

const revisionBlocks = (
  row: RevisionRow,
  nameOf: (id: string) => string,
): ReadonlyArray<Block> => {
  const header: ReadonlyArray<TableCell> = [
    cell('Reviewer', true),
    cell('Role', true),
    cell('Decision', true),
    cell('Time', true),
  ]
  const rows = row.cells.map((entry): ReadonlyArray<TableCell> => [
    cell(
      entry.removed
        ? `${nameOf(entry.accountId)} (removed)`
        : nameOf(entry.accountId),
    ),
    cell(entry.roleName),
    cell(
      entry.decision === undefined
        ? 'No decision'
        : DECISION_LABELS[entry.decision.decision],
    ),
    cell(entry.decision === undefined ? '' : formatInstant(entry.decision.at)),
  ])
  const reviews = row.cells.flatMap(entry =>
    entry.reviews.map(review => ({ entry, review })),
  )
  reviews.sort((a, b) => a.review.at - b.review.at)
  const blocks: Array<Block> = [
    {
      type: 'heading',
      id: `revision-${row.revision}`,
      level: 1,
      number: undefined,
      title: row.label,
      text: row.label,
      inContents: false,
    },
    paragraph(`Based on ${draftLabel(row.draft)}`),
    paragraph(
      row.publishedAt === undefined
        ? 'Publication time not recorded'
        : `Published ${formatInstant(row.publishedAt)}`,
    ),
    paragraph(`Deadline ${formatInstant(row.deadline)}`),
    paragraph(statusText(row)),
    { type: 'table', rows: [header, ...rows] },
  ]
  if (reviews.length > 0) {
    blocks.push({
      type: 'list',
      ordered: false,
      start: 1,
      items: reviews.map(({ entry, review }) => [
        paragraph(
          `${nameOf(entry.accountId)}: ${DECISION_LABELS[review.decision]}, ${formatInstant(review.at)}${review.hasComments ? ', with comments' : ''}${review.standing ? ' (standing decision)' : ''}`,
        ),
      ]),
    })
  }
  return blocks
}

export const approvalRecordDescription = (
  input: ApprovalRecordInput,
): DocumentDescription => {
  const { template, theme, caseFile } = input
  const nameOf = (id: string): string => input.accountNames[id] ?? id
  const grid = buildGrid({
    template,
    flow: input.flow,
    authors: input.authors,
    events: input.events,
  })
  const cover: Array<Block> = []
  if (theme.logo !== undefined) {
    cover.push({ type: 'logo', imageId: theme.logo })
  }
  cover.push(
    { type: 'cover_line', emphasis: 'normal', text: theme.organisationName },
    { type: 'cover_line', emphasis: 'title', text: 'Approval record' },
    { type: 'cover_line', emphasis: 'subtitle', text: input.reportName },
    {
      type: 'cover_line',
      emphasis: 'normal',
      text: `${template.caseReferenceLabel}: ${caseFile.reference}`,
    },
    { type: 'cover_line', emphasis: 'normal', text: formatDate(input.date) },
  )
  const body: ReadonlyArray<Block> =
    grid.revisions.length === 0
      ? [paragraph('No revision has been published yet.')]
      : grid.revisions.flatMap(row => revisionBlocks(row, nameOf))
  const numbering = {
    group: 'all' as const,
    style: 'arabic' as const,
  }
  const parts: ReadonlyArray<Part> = [
    { kind: 'cover', numbering: { ...numbering, restartAt: 1 }, blocks: cover },
    {
      kind: 'body',
      numbering: { ...numbering, restartAt: undefined },
      blocks: body,
    },
  ]
  return {
    info: {
      title: `Approval record - ${input.reportName}`,
      subject: caseFile.reference,
      author: theme.organisationName,
    },
    version: {
      reportName: input.reportName,
      versionLabel: 'Approval record',
      date: input.date,
      redacted: false,
    },
    redactionLabel: undefined,
    style: styleOf(theme),
    // NOTE: The theme's furniture only: the record is not a template's report.
    furniture: furnitureOf(undefined, theme, {
      case: caseFile.reference,
      title: input.reportName,
    }),
    parts,
    imageIds: theme.logo === undefined ? [] : [theme.logo],
  }
}

// ---- File names (D10) ------------------------------------------------------------------

export type FileNameInput = Readonly<{
  caseReference: string
  templateShortName: string
  version: VersionRef
  redacted: boolean
  // NOTE: The report's people; used only to keep names out of a redacted
  // file name.
  people: ReadonlyArray<Person>
}>

// NOTE: Only letters, digits, dot, dash and underscore; everything else
// becomes a dash, runs of dashes collapse, and the ends are trimmed.
const safePart = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')

// NOTE: `<case reference>_<template short name>_Revision-2_redacted.pdf` or
// `<case reference>_<…>_Draft-5.pdf`. The case file's reference, never its
// title. For a redacted version the whole name passes through
// `redactFileName`, so no alias of the report's people stays in it.
export const pdfFileName = (input: FileNameInput): string => {
  const reference = safePart(input.caseReference)
  const raw = [
    reference === '' ? 'case' : reference,
    input.templateShortName,
    versionSlug(input.version),
    ...(input.redacted ? ['redacted'] : []),
  ].join('_')
  const name = `${raw}.pdf`
  return input.redacted
    ? `${safePart(redactFileName(input.people, name).replace(/\.pdf$/, ''))}.pdf`
    : name
}

// NOTE: The approval record is for the drafting role, so its name needs no
// redaction.
export const approvalRecordFileName = (
  input: Pick<FileNameInput, 'caseReference' | 'templateShortName'>,
): string => {
  const reference = safePart(input.caseReference)
  return `${reference === '' ? 'case' : reference}_${input.templateShortName}_approval-record.pdf`
}
