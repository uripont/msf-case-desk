import { Effect } from 'effect'

import {
  type ReportSummary,
  type RevisionHeader,
  type RoundView,
  type SectionContentRow,
  type Template,
  RoundSummary as RoundSummarySchema,
  SectionRef as SectionRefSchema,
  revisionTitle,
  tallyRound,
} from '@case-desk/domain'

import { type Loaded, flowOf } from './core'
import { parseSection, sha256Hex, utf8Length } from './content'

// NOTE: builders for the views the handlers return. Authors' views only:
// reviewers get their own, smaller ones (`reviewer.ts`).

export const summaryOf = (
  loaded: Loaded,
  template: Template = loaded.template,
): ReportSummary => ({
  id: loaded.record.id,
  caseFile: {
    id: loaded.record.caseFile.id,
    unit: loaded.record.caseFile.unitId,
    reference: loaded.record.caseFile.reference,
    title: loaded.record.caseFile.title,
  },
  templateId: loaded.record.templateId,
  templateVersion: loaded.record.templateVersion,
  templateName: template.name,
  state: loaded.record.state,
  latestDraft: loaded.record.latestDraft,
  ...(loaded.record.latestRevision === null
    ? {}
    : { latestRevision: loaded.record.latestRevision }),
  ...(loaded.record.deadlineAt === null || loaded.record.deadlineZone === null
    ? {}
    : {
        deadline: {
          at: loaded.record.deadlineAt,
          timeZone: loaded.record.deadlineZone,
        },
      }),
  createdAt: loaded.record.createdAt,
})

export const summaryOfRecord = (
  record: Loaded['record'],
  template: Template,
): ReportSummary => ({
  ...summaryOf(
    {
      record,
      template,
    } as unknown as Loaded,
    template,
  ),
})

// NOTE: a hash over a draft's per-section redacted hashes, so one value tells
// the author what they are confirming (D14).
export const hashOfSections = (
  sections: ReadonlyArray<{ version: number | string }>,
): Promise<string> => sha256Hex(sections.map(s => String(s.version)).join(','))

// NOTE: the same, from what the store measured without reading the texts out
// (`getDraftOutline`).
export const storedSectionRefsOf = (
  refs: ReadonlyArray<Readonly<{ sectionId: string; bytes: number; notApplicable: boolean }>>,
): ReadonlyArray<typeof SectionRefSchema.Type> =>
  refs.map(ref => ({
    sectionId: ref.sectionId,
    size: ref.bytes,
    notApplicable: ref.notApplicable,
  }))

export const sectionRefsOf = (
  rows: ReadonlyArray<SectionContentRow>,
): ReadonlyArray<typeof SectionRefSchema.Type> =>
  rows.map(row => ({
    sectionId: row.sectionId,
    size: utf8Length(row.content),
    notApplicable: parseSection(row.content).notApplicable !== undefined,
  }))

export const revisionHeaderOf = (
  loaded: Loaded,
  number: number,
): RevisionHeader | undefined => {
  const revision = loaded.revisions.find(entry => entry.number === number)
  const entry = loaded.rounds.find(e => e.round.revision === number)
  if (revision === undefined || entry === undefined) return undefined
  const next = loaded.rounds.find(e => e.round.revision === number + 1)
  const status =
    loaded.flow.rounds.find(round => round.revision === number)?.status ??
    entry.round.state
  return {
    number,
    label: revisionTitle(number, revision.closing),
    draft: revision.draftNumber,
    closing: revision.closing,
    publishedAt: revision.publishedAt,
    deadline: {
      at: entry.round.deadlineAt,
      timeZone: entry.round.deadlineZone,
    },
    status,
    ...(entry.round.decidedBy === null
      ? {}
      : { decidedBy: entry.round.decidedBy }),
    ...(status === 'superseded' && next !== undefined
      ? { replacedBy: next.round.revision }
      : {}),
  }
}

export const roundSummaryOf = (
  loaded: Loaded,
  revision: number,
): typeof RoundSummarySchema.Type | undefined => {
  const entry = loaded.rounds.find(e => e.round.revision === revision)
  if (entry === undefined) return undefined
  const status =
    loaded.flow.rounds.find(round => round.revision === revision)?.status ??
    entry.round.state
  return {
    status,
    ...(entry.round.decidedBy === null
      ? {}
      : { decidedBy: entry.round.decidedBy }),
    deadline: {
      at: entry.round.deadlineAt,
      timeZone: entry.round.deadlineZone,
    },
    closing: entry.round.closing,
  }
}

export const roundViewOf = (
  loaded: Loaded,
  revision: number,
): RoundView | undefined => {
  const entry = loaded.rounds.find(e => e.round.revision === revision)
  const flowRound = loaded.flow.rounds.find(r => r.revision === revision)
  const published = loaded.revisions.find(r => r.number === revision)
  if (entry === undefined || flowRound === undefined || published === undefined) {
    return undefined
  }
  const standing = new Map<string, 'approve' | 'request_changes'>()
  for (const review of loaded.reviews
    .filter(r => r.roundId === entry.round.id)
    .sort((a, b) => a.sentAt - b.sentAt)) {
    if (review.decision !== 'comment') {
      standing.set(review.reviewerId, review.decision)
    }
  }
  return {
    revision,
    draft: published.draftNumber,
    closing: entry.round.closing,
    status: flowRound.status,
    ...(entry.round.decidedBy === null
      ? {}
      : { decidedBy: entry.round.decidedBy }),
    ...(entry.round.decidedAt === null
      ? {}
      : { decidedAt: entry.round.decidedAt }),
    deadline: {
      at: entry.round.deadlineAt,
      timeZone: entry.round.deadlineZone,
    },
    participants: entry.participants.map(p => ({
      accountId: p.userId,
      name: p.name,
      roleId: p.roleId,
      roleName:
        loaded.template.roles.find(role => role.id === p.roleId)?.name ??
        p.roleId,
      removed: p.removedAt !== null,
      ...(standing.has(p.userId)
        ? { decision: standing.get(p.userId) as 'approve' | 'request_changes' }
        : {}),
    })),
    tally: tallyRound(loaded.template, flowRound),
  }
}

export { flowOf, Effect }
