import { Effect, Result } from 'effect'
import type { RpcGroup } from 'effect/rpc'

import {
  type Person,
  type RichTextDoc,
  type QuoroomRpcs,
  type ReviewDecision,
  type StoreCommentRecord,
  CurrentUser,
  DeadlinePassed,
  NotAllowedInState,
  NotFound,
  Conflict,
  anchorText,
  applyEvent,
  canSeeComment,
  redactedQuote,
  redactorFor,
  reviewerRoleFor,
  revisionTitle,
  templateNodes,
} from '@quoroom/domain'

import { EMPTY_SECTION, parseSection, topLevelIds } from './content'
import {
  type Loaded,
  type Store,
  QuoroomClock,
  QuoroomConfig,
  flowFailure,
  idOf,
  jobsFor,
  loadReport,
  loadTemplates,
  requireReviewer,
  roundOf,
  store,
  validation,
} from './core'
import { auditOf, member } from './support'
import { roundSummaryOf, storedSectionRefsOf } from './views'

// NOTE: The reviewer side. Reviewer procedures are for participants only: an
// author of the report gets `NotFound` here, as for any report they are not a
// reviewer of. The view a reviewer reads (original or redacted) is taken from
// `authorize` (the role of the template), never from the request, and every
// response carries one `content` or `body` that is already the right version.

type AllHandlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof QuoroomRpcs>>

type RoleView = 'full' | 'redacted'

const roleViewOf = (view: 'original' | 'redacted' | undefined): RoleView =>
  view === 'original' ? 'full' : 'redacted'

// NOTE: the anchor of a comment as stored. An entry path travels in the item
// ID, outermost first, joined with `/`.
const encodeItem = (anchor: {
  itemId: string
  entryPath?: ReadonlyArray<string> | undefined
}): string => [...(anchor.entryPath ?? []), anchor.itemId].join('/')

const anchorOf = (comment: StoreCommentRecord) => {
  if (
    comment.itemId === null ||
    comment.rangeFrom === null ||
    comment.rangeTo === null ||
    comment.quoted === null
  ) {
    return { kind: 'section' as const, sectionId: comment.sectionId }
  }
  const parts = comment.itemId.split('/')
  const itemId = parts[parts.length - 1] ?? comment.itemId
  const entryPath = parts.slice(0, -1)
  return {
    kind: 'text' as const,
    sectionId: comment.sectionId,
    itemId,
    ...(entryPath.length === 0 ? {} : { entryPath }),
    from: comment.rangeFrom,
    to: comment.rangeTo,
    quoted: comment.quoted,
  }
}

export const sectionKnown = (template: Loaded['template'], sectionId: string) =>
  templateNodes(template).some(
    entry => entry.kind === 'section' && entry.node.id === sectionId,
  )

const standingOf = (
  loaded: Loaded,
  roundId: string,
  reviewerId: string,
): ReviewDecision | undefined => {
  const sent = loaded.reviews
    .filter(
      review =>
        review.roundId === roundId &&
        review.reviewerId === reviewerId &&
        review.decision !== 'comment',
    )
    .sort((a, b) => a.sentAt - b.sentAt)
  return sent[sent.length - 1]?.decision
}

// NOTE: the people list of the draft a revision was made from, for the
// redaction of text a redacted reader is shown.
//
// NOTE: fails closed. A revision or draft that cannot be found must never mean
// "no names to redact": the caller is refused (`NotFound`) instead.
export const peopleOfRevision = (
  db: Pick<Store, 'getDraft'>,
  loaded: Pick<Loaded, 'revisions' | 'record'>,
  revision: number,
) =>
  Effect.gen(function* () {
    const published = loaded.revisions.find(entry => entry.number === revision)
    if (published === undefined) return yield* Effect.fail(new NotFound())
    const draft = yield* db.getDraft(loaded.record.id, published.draftNumber)
    if (draft === null) return yield* Effect.fail(new NotFound())
    return yield* readPeople(draft.people)
  })

// NOTE: a stored people list that cannot be read is `NotFound` too, never an
// empty list.
const readPeople = (text: string) =>
  Effect.gen(function* () {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return yield* Effect.fail(new NotFound())
    }
    if (!Array.isArray(parsed)) return yield* Effect.fail(new NotFound())
    return parsed as ReadonlyArray<Person>
  })

export const peopleOfDraft = (
  db: Pick<Store, 'getDraft'>,
  reportId: string,
  draft: number,
) =>
  Effect.gen(function* () {
    const found = yield* db.getDraft(reportId, draft)
    if (found === null) return yield* Effect.fail(new NotFound())
    return yield* readPeople(found.people)
  })

// NOTE: the case reference as the role may read it: the original for a `full`
// role, the redacted twin stored with the draft otherwise, and the twin also
// when the role or its template cannot be found.
const referenceFor = (
  template: Loaded['template'] | undefined,
  row: Readonly<{
    roleId: string
    caseReference: string
    caseReferenceRedacted: string
  }>,
): string =>
  template?.roles.find(role => role.id === row.roleId)?.view === 'full'
    ? row.caseReference
    : row.caseReferenceRedacted

// NOTE: every text a section holds as the anchor scheme counts it: the anchor
// text of each rich text value and each plain text value, nested sections and
// entries included.
const anchorTexts = (value: unknown, out: Array<string> = []): Array<string> => {
  if (Array.isArray(value)) {
    for (const item of value) anchorTexts(item, out)
    return out
  }
  if (value === null || typeof value !== 'object') return out
  const record = value as Record<string, unknown>
  if (record['type'] === 'rich_text' && record['doc'] !== undefined) {
    try {
      out.push(anchorText(record['doc'] as RichTextDoc))
    } catch {
      // NOTE: a document that cannot be read has no text to quote from.
    }
    return out
  }
  if (record['type'] === 'text' && typeof record['text'] === 'string') {
    out.push(record['text'])
    return out
  }
  for (const inner of Object.values(record)) anchorTexts(inner, out)
  return out
}

// NOTE: the quoted text of a selection for a redacted reader, derived from the
// text the selection was made on: the selection is located in a text of the
// section (it must read exactly `quoted` at `from..to`), widened to whole
// names and words and only then redacted (`redactedQuote`). A quote that
// cannot be located is not shown; it is never cut out of a name.
const quoteIn = (
  texts: ReadonlyArray<string>,
  people: ReadonlyArray<Person>,
  anchor: Readonly<{ from: number; to: number; quoted: string }>,
): string | undefined => {
  const text = texts.find(
    candidate =>
      anchor.from >= 0 &&
      anchor.from <= anchor.to &&
      anchor.to <= candidate.length &&
      candidate.slice(anchor.from, anchor.to) === anchor.quoted,
  )
  return text === undefined
    ? undefined
    : redactedQuote(people, text, anchor.from, anchor.to)
}

// NOTE: why a round takes no more reviews or comments.
const roundClosed = (loaded: Loaded, revision: number) => {
  const entry = roundOf(loaded, revision)
  if (entry === undefined) return new NotFound()
  return entry.round.deadlineAt <= loaded.now
    ? new DeadlinePassed({ deadline: entry.round.deadlineAt })
    : new NotAllowedInState({
        state: loaded.record.state,
        code: 'round_not_open',
      })
}

const reviewerStanding = (
  db: Store,
  roundId: string,
  reviewerId: string,
) => db.getPendingReview(roundId, reviewerId)

const pendingView = (
  loaded: Loaded,
  revision: number,
  userName: string,
  comments: ReadonlyArray<StoreCommentRecord>,
  decision: ReviewDecision | null,
) => ({
  revision,
  comments: comments.map(comment => ({
    id: comment.id,
    revision,
    authorName: userName,
    mine: true as const,
    body: comment.body,
    visibility: comment.visibility,
    sent: false,
    resolved: comment.resolved,
    createdAt: comment.createdAt,
    replies: [],
    anchor: anchorOf(comment),
  })),
  ...(decision === null ? {} : { decision }),
})

export const reviewerHandlers: Pick<
  AllHandlers,
  | 'ListInbox'
  | 'ListPendingReviews'
  | 'GetRevisionOutline'
  | 'GetRevisionSection'
  | 'ListReviewerComments'
  | 'AddComment'
  | 'UpdatePendingComment'
  | 'DeletePendingComment'
  | 'GetPendingReview'
  | 'SavePendingReview'
  | 'SendReview'
> = {
  // NOTE: one line per round the caller takes part in, newest deadline first,
  // in one query per page (`listReviewerRounds`) plus the template names. The
  // status of an open round past its deadline reads `decided`: the round is
  // settled for real the next time the report is loaded. A page holds at most
  // `limit` rounds (default 10); `next` is the offset of the following one.
  ListInbox: ({ offset, limit }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const db = yield* store
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const start = offset ?? 0
      const size = limit ?? 10
      const rows = yield* db.listReviewerRounds(user.id, {
        offset: start,
        limit: size + 1,
        openOnly: false,
        pendingOnly: false,
      })
      const templates = yield* loadTemplates(
        db,
        rows.slice(0, size).map(row => ({
          templateId: row.templateId,
          version: row.templateVersion,
        })),
      )
      const items = []
      for (const row of rows.slice(0, size)) {
        const template = templates.get(`${row.templateId}@${row.templateVersion}`)
        if (template === undefined) continue
        items.push({
          reportId: row.reportId,
          revision: row.revision,
          label: revisionTitle(row.revision, row.closing),
          caseReference: referenceFor(template, row),
          reportName: template.name,
          deadline: { at: row.deadlineAt, timeZone: row.deadlineZone },
          status:
            row.roundState === 'open' && row.deadlineAt <= now
              ? ('decided' as const)
              : row.roundState,
          sentAt: row.publishedAt,
          ...(row.decision === null ? {} : { myDecision: row.decision }),
          hasPending: row.pendingDecision !== null || row.pendingComments > 0,
        })
      }
      return {
        items,
        ...(rows.length > size ? { next: start + size } : {}),
      }
    }),

  // NOTE: the reviews the caller has begun and not sent, in open rounds.
  ListPendingReviews: () =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const db = yield* store
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const rows = yield* db.listReviewerRounds(user.id, {
        offset: 0,
        limit: 50,
        openOnly: true,
        pendingOnly: true,
      })
      const templates = yield* loadTemplates(
        db,
        rows.map(row => ({
          templateId: row.templateId,
          version: row.templateVersion,
        })),
      )
      return rows
        .filter(row => row.deadlineAt > now)
        .map(row => ({
          reportId: row.reportId,
          revision: row.revision,
          label: revisionTitle(row.revision, row.closing),
          caseReference: referenceFor(
            templates.get(`${row.templateId}@${row.templateVersion}`),
            row,
          ),
          deadline: { at: row.deadlineAt, timeZone: row.deadlineZone },
          commentCount: row.pendingComments,
          ...(row.pendingDecision === null
            ? {}
            : { decision: row.pendingDecision }),
        }))
    }),

  GetRevisionOutline: ({ reportId, revision }) =>
    Effect.gen(function* () {
      const { user, loaded, allowed, db } = yield* member(reportId, {
        type: 'read_revision',
        revision,
      })
      yield* requireReviewer(loaded, user)
      const role = reviewerRoleFor(
        { id: user.id, grants: [] },
        loaded.access,
        revision,
      )
      const entry = roundOf(loaded, revision)
      const published = loaded.revisions.find(item => item.number === revision)
      const summary = roundSummaryOf(loaded, revision)
      if (
        role === undefined ||
        entry === undefined ||
        published === undefined ||
        summary === undefined
      ) {
        return yield* Effect.fail(new NotFound())
      }
      // NOTE: the view is the role's, from `authorize`; the draft number is the
      // revision's own, never one from the request.
      const view = allowed.view === 'original' ? 'original' : 'redacted'
      // NOTE: the draft and the outline of its sections in the role's view,
      // in one round trip and without reading the texts out.
      const { draft, sections } = yield* db.getDraftOutline(
        reportId,
        published.draftNumber,
        view,
      )
      if (draft === null) return yield* Effect.fail(new NotFound())
      // NOTE: the labels (never names or aliases) of the people of the
      // revision, so a people item prints a label and never an ID, in the
      // reviewer's PDF too.
      const labelled = yield* readPeople(draft.people)
      const clock = yield* QuoroomClock
      yield* db.recordEvent({
        reportId,
        kind: 'read',
        accountId: user.id,
        revisionNumber: revision,
        at: yield* clock.now,
      })
      const decision = standingOf(loaded, entry.round.id, user.id)
      return {
        reportId,
        revision,
        label: revisionTitle(revision, entry.round.closing),
        caseReference:
          view === 'original'
            ? loaded.record.caseFile.reference
            : draft.caseReferenceRedacted,
        caseTitle:
          view === 'original'
            ? loaded.record.caseFile.title
            : draft.caseTitleRedacted,
        templateId: loaded.record.templateId,
        templateVersion: loaded.record.templateVersion,
        view: roleViewOf(allowed.view),
        roleId: role.id,
        canComment: role.permissions.includes('comment'),
        canVote: role.permissions.includes('vote'),
        round: summary,
        ...(decision === undefined ? {} : { myDecision: decision }),
        closing: entry.round.closing,
        publishedAt: published.publishedAt,
        personLabels: labelled.map(person => ({
          id: person.id,
          label: person.label,
        })),
        sections: storedSectionRefsOf(sections),
      }
    }),

  GetRevisionSection: ({ reportId, revision, sectionId }) =>
    Effect.gen(function* () {
      const { user, loaded, allowed, db } = yield* member(reportId, {
        type: 'read_revision',
        revision,
      })
      yield* requireReviewer(loaded, user)
      if (!topLevelIds(loaded.template).includes(sectionId)) {
        return yield* Effect.fail(new NotFound())
      }
      const view = allowed.view === 'original' ? 'original' : 'redacted'
      const text = yield* db.getRevisionSection(
        reportId,
        revision,
        sectionId,
        view,
      )
      return {
        sectionId,
        view: roleViewOf(allowed.view),
        content: text === null ? EMPTY_SECTION : parseSection(text),
      }
    }),

  ListReviewerComments: ({ reportId, revision }) =>
    Effect.gen(function* () {
      const { user, loaded, allowed, db } = yield* member(reportId, {
        type: 'read_comments',
        revision,
      })
      yield* requireReviewer(loaded, user)
      const readerView = roleViewOf(allowed.view)
      const listed = yield* db.listComments({
        reportId,
        kind: 'revision',
        number: revision,
        audience: { kind: 'reviewer', userId: user.id },
      })
      const people = yield* peopleOfRevision(db, loaded, revision)
      const redactor = redactorFor(people)
      // NOTE: the texts of a section as the anchors of its comments count
      // them, read once per section and view (original for the quotes of a
      // `full` reviewer, redacted for a redacted reader's own).
      const texts = new Map<string, ReadonlyArray<string>>()
      const textsOf = (sectionId: string, view: 'original' | 'redacted') =>
        Effect.gen(function* () {
          const key = `${view}:${sectionId}`
          const known = texts.get(key)
          if (known !== undefined) return known
          const stored = yield* db.getRevisionSection(
            reportId,
            revision,
            sectionId,
            view,
          )
          const found = stored === null ? [] : anchorTexts(parseSection(stored))
          texts.set(key, found)
          return found
        })
      const out = []
      for (const comment of listed.comments) {
        // NOTE: the same rule as `canSeeComment`, checked again here.
        if (
          !canSeeComment({ id: user.id, grants: [] }, loaded.access, {
            authorId: comment.authorId,
            scope: { kind: 'revision', revision },
            visibility: comment.visibility,
            sent: comment.reviewId !== null,
          })
        ) {
          continue
        }
        // NOTE: a comment with a redacted twin was written in the original
        // view; any other was written in the redacted one.
        const writtenFull = comment.redactedBody !== null
        const mine = comment.authorId === user.id
        const body =
          readerView === 'full'
            ? comment.body
            : redactor.text(comment.redactedBody ?? comment.body)
        const replies = listed.replies
          .filter(reply => reply.commentId === comment.id)
          .map(reply => ({
            id: reply.id,
            authorName:
              readerView === 'full'
                ? reply.authorName
                : redactor.text(reply.authorName),
            body:
              readerView === 'full'
                ? reply.body
                : redactor.text(reply.redactedBody ?? reply.body),
            createdAt: reply.createdAt,
          }))
        const common = {
          id: comment.id,
          revision,
          authorName:
            readerView === 'full'
              ? comment.authorName
              : redactor.text(comment.authorName),
          mine,
          body,
          visibility: comment.visibility,
          sent: comment.reviewId !== null,
          resolved: comment.resolved,
          createdAt: comment.createdAt,
          replies,
        }
        const sameView = mine || writtenFull === (readerView === 'full')
        if (sameView) {
          // NOTE: a redacted reader's own words go through the redaction
          // too, so no alias comes back to anyone however it got in (D14).
          const anchor = anchorOf(comment)
          if (readerView === 'redacted' && anchor.kind === 'text') {
            const located = quoteIn(
              yield* textsOf(comment.sectionId, 'redacted'),
              people,
              anchor,
            )
            out.push({
              ...common,
              anchor: { ...anchor, quoted: located ?? redactor.text(anchor.quoted) },
            })
          } else {
            out.push({ ...common, anchor })
          }
        } else {
          // NOTE: positions point into a text this reader does not have, so
          // the comment sits on the section, with its quoted text in the
          // reader's own view (D14).
          // NOTE: for a redacted reader the quote of a `full` reviewer is
          // derived from the original text it was selected in, widened to
          // whole names, then redacted; one that cannot be located is left out.
          const anchor = anchorOf(comment)
          const quoted =
            anchor.kind !== 'text'
              ? undefined
              : readerView === 'redacted'
                ? quoteIn(
                    yield* textsOf(comment.sectionId, 'original'),
                    people,
                    anchor,
                  )
                : comment.quoted ?? undefined
          out.push({
            ...common,
            anchor: {
              kind: 'section_note' as const,
              sectionId: comment.sectionId,
              ...(quoted === undefined ? {} : { quoted }),
            },
          })
        }
      }
      return out
    }),

  AddComment: ({ reportId, revision, anchor, body, visibility }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, {
        type: 'write_comment',
        revision,
      })
      yield* requireReviewer(loaded, user)
      const entry = roundOf(loaded, revision)
      if (entry === undefined) return yield* Effect.fail(new NotFound())
      if (entry.round.state !== 'open' || entry.round.deadlineAt <= loaded.now) {
        return yield* Effect.fail(roundClosed(loaded, revision))
      }
      if (!sectionKnown(loaded.template, anchor.sectionId)) {
        return yield* Effect.fail(
          validation('input', 'unknown_section', [anchor.sectionId]),
        )
      }
      const role = reviewerRoleFor(
        { id: user.id, grants: [] },
        loaded.access,
        revision,
      )
      const full = role?.view === 'full'
      // NOTE: a `full` reviewer's comment is stored with its redacted twin,
      // made now, on the server, from the people list of the revision's draft.
      const redactor = redactorFor(
        full ? yield* peopleOfRevision(db, loaded, revision) : [],
      )
      const id = yield* idOf('comment')
      const stored = {
        id,
        sectionId: anchor.sectionId,
        itemId: anchor.kind === 'text' ? encodeItem(anchor) : null,
        rangeFrom: anchor.kind === 'text' ? anchor.from : null,
        rangeTo: anchor.kind === 'text' ? anchor.to : null,
        quoted: anchor.kind === 'text' ? anchor.quoted : null,
        body,
        redactedBody: full ? redactor.text(body) : null,
        visibility,
        now: loaded.now,
      }
      const outcome = yield* db.addPendingComment({
        ...stored,
        roundId: entry.round.id,
        reviewerId: user.id,
        revision,
      })
      if (outcome._tag !== 'Added') {
        return yield* Effect.fail(roundClosed(loaded, revision))
      }
      return {
        id,
        revision,
        authorName: user.name,
        mine: true,
        body,
        visibility,
        sent: false,
        resolved: false,
        createdAt: loaded.now,
        replies: [],
        anchor,
      }
    }),

  UpdatePendingComment: ({ reportId, commentId, body, visibility }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const db = yield* store
      const comment = yield* db.getComment(reportId, commentId)
      if (
        comment === null ||
        comment.authorId !== user.id ||
        comment.targetKind !== 'revision'
      ) {
        return yield* Effect.fail(new NotFound())
      }
      const { loaded } = yield* member(reportId, {
        type: 'write_comment',
        revision: comment.targetNumber,
      })
      yield* requireReviewer(loaded, user)
      const entry = roundOf(loaded, comment.targetNumber)
      if (entry === undefined) return yield* Effect.fail(new NotFound())
      if (entry.round.state !== 'open' || entry.round.deadlineAt <= loaded.now) {
        return yield* Effect.fail(roundClosed(loaded, comment.targetNumber))
      }
      if (comment.reviewId !== null) {
        return yield* Effect.fail(new Conflict({ reason: 'already_sent' }))
      }
      const nextBody = body ?? comment.body
      const redactor = redactorFor(
        comment.redactedBody === null
          ? []
          : yield* peopleOfRevision(db, loaded, comment.targetNumber),
      )
      const updated = yield* db.updatePendingComment({
        id: commentId,
        reviewerId: user.id,
        body: nextBody,
        redactedBody:
          comment.redactedBody === null ? null : redactor.text(nextBody),
        visibility: visibility ?? comment.visibility,
      })
      if (!updated) {
        return yield* Effect.fail(new Conflict({ reason: 'already_sent' }))
      }
      return {
        id: commentId,
        revision: comment.targetNumber,
        authorName: user.name,
        mine: true,
        body: nextBody,
        visibility: visibility ?? comment.visibility,
        sent: false,
        resolved: comment.resolved,
        createdAt: comment.createdAt,
        replies: [],
        anchor: anchorOf(comment),
      }
    }),

  DeletePendingComment: ({ reportId, commentId }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const db = yield* store
      const comment = yield* db.getComment(reportId, commentId)
      if (
        comment === null ||
        comment.authorId !== user.id ||
        comment.targetKind !== 'revision'
      ) {
        return yield* Effect.fail(new NotFound())
      }
      const { loaded } = yield* member(reportId, {
        type: 'write_comment',
        revision: comment.targetNumber,
      })
      yield* requireReviewer(loaded, user)
      const entry = roundOf(loaded, comment.targetNumber)
      if (entry === undefined) return yield* Effect.fail(new NotFound())
      if (entry.round.state !== 'open' || entry.round.deadlineAt <= loaded.now) {
        return yield* Effect.fail(roundClosed(loaded, comment.targetNumber))
      }
      const deleted = yield* db.deletePendingComment(commentId, user.id)
      if (!deleted) {
        return yield* Effect.fail(new Conflict({ reason: 'already_sent' }))
      }
    }),

  GetPendingReview: ({ reportId, revision }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, {
        type: 'write_comment',
        revision,
      })
      yield* requireReviewer(loaded, user)
      const entry = roundOf(loaded, revision)
      if (entry === undefined) return yield* Effect.fail(new NotFound())
      const pending = yield* reviewerStanding(db, entry.round.id, user.id)
      return pendingView(
        loaded,
        revision,
        user.name,
        pending.comments,
        pending.decision,
      )
    }),

  SavePendingReview: ({ reportId, revision, decision }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, {
        type: 'write_comment',
        revision,
      })
      yield* requireReviewer(loaded, user)
      const entry = roundOf(loaded, revision)
      if (entry === undefined) return yield* Effect.fail(new NotFound())
      if (entry.round.state !== 'open' || entry.round.deadlineAt <= loaded.now) {
        return yield* Effect.fail(roundClosed(loaded, revision))
      }
      const saved = yield* db.savePendingReview({
        roundId: entry.round.id,
        reviewerId: user.id,
        decision: decision ?? null,
        now: loaded.now,
      })
      if (saved._tag !== 'Saved') {
        return yield* Effect.fail(roundClosed(loaded, revision))
      }
      const pending = yield* reviewerStanding(db, entry.round.id, user.id)
      return pendingView(
        loaded,
        revision,
        user.name,
        pending.comments,
        pending.decision,
      )
    }),

  SendReview: ({ reportId, revision, decision, commentIds }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, {
        type: 'submit_review',
        revision,
        decision,
      })
      yield* requireReviewer(loaded, user)
      const entry = roundOf(loaded, revision)
      if (entry === undefined) return yield* Effect.fail(new NotFound())
      const config = yield* QuoroomConfig
      const applied = applyEvent(
        { template: loaded.template, authors: loaded.authors, now: loaded.now },
        loaded.flow,
        {
          type: 'submit_review',
          revision,
          reviewerId: user.id,
          decision,
        },
      )
      if (Result.isFailure(applied)) {
        return yield* Effect.fail(
          flowFailure(applied.failure, entry.round.deadlineAt),
        )
      }
      const pending = yield* reviewerStanding(db, entry.round.id, user.id)
      // NOTE: exactly the comments the reviewer saw are sent, nothing else.
      const seen = new Set(commentIds)
      if (
        seen.size !== commentIds.length ||
        seen.size !== pending.comments.length ||
        pending.comments.some(comment => !seen.has(comment.id))
      ) {
        return yield* Effect.fail(new Conflict({ reason: 'pending_changed' }))
      }
      const reviewId = yield* idOf('review')
      const sentComments = pending.comments.length
      const jobs = yield* jobsFor(db, config, {
        template: loaded.template,
        flow: applied.success,
        authors: loaded.authors,
        approvalWatchers: new Set(
          (yield* db.listProfiles(loaded.authors))
            .filter(profile => profile.notifyOnApproval)
            .map(profile => profile.userId),
        ),
        revisions: loaded.revisions,
        rounds: loaded.rounds,
        reviews: loaded.reviews,
        extraEvents: [
          {
            type: 'review',
            id: reviewId,
            reviewerId: user.id,
            revision,
            decision,
            hasComments: sentComments > 0,
            at: loaded.now,
          },
        ],
        reportId,
        now: loaded.now,
      })
      const outcome = yield* db.sendReview({
        reviewId,
        roundId: entry.round.id,
        reportId,
        reviewerId: user.id,
        decision,
        jobs,
        now: loaded.now,
        audit: auditOf(loaded.now, user.id, 'review.sent', reportId, {
          revisionNumber: revision,
          meta: JSON.stringify({ decision }),
        }),
      })
      if (outcome._tag !== 'Sent') {
        return yield* Effect.fail(roundClosed(loaded, revision))
      }
      // NOTE: the review that completes the rule decides the round: loading
      // the report settles it and stores the decision.
      const after = yield* loadReport(reportId)
      const round =
        after === undefined ? undefined : roundSummaryOf(after, revision)
      if (round === undefined) return yield* Effect.fail(new NotFound())
      return {
        reviewId,
        decision,
        sentAt: loaded.now,
        commentsSent: sentComments,
        round,
      }
    }),
}
