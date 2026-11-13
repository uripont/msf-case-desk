import { Effect, Result } from 'effect'
import type { RpcGroup } from 'effect/rpc'

import {
  type Person,
  type QuoroomRpcs,
  type ReplyRecord,
  type StoreCommentRecord,
  Conflict,
  CurrentUser,
  NotAllowedInState,
  NotFound,
  applyEvent,
  canSeeComment,
  redactorFor,
  templateNodes,
} from '@case-desk/domain'

import { mapSectionDocs, parseSection, sectionFigures } from './content'
import {
  type Loaded,
  type Store,
  allow,
  flowFailure,
  idOf,
  QuoroomClock,
  validation,
} from './core'
import { auditOf, member, peopleOf } from './support'
import { roundViewOf, summaryOf } from './views'

// NOTE: Author-side procedures for comments, rounds and images.

type AllHandlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof QuoroomRpcs>>

const sectionKnown = (template: Loaded['template'], sectionId: string) =>
  templateNodes(template).some(
    entry => entry.kind === 'section' && entry.node.id === sectionId,
  )

// NOTE: events without a deadline cannot fail on one.
const stateFailure = (
  failure: Parameters<typeof flowFailure>[0],
  state: Loaded['record']['state'],
) => {
  const error = flowFailure(failure, undefined)
  return error._tag === 'DeadlinePassed'
    ? new NotAllowedInState({ state, code: 'deadline_not_in_future' })
    : error
}

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
  const entryPath = parts.slice(0, -1)
  return {
    kind: 'text' as const,
    sectionId: comment.sectionId,
    itemId: parts[parts.length - 1] ?? comment.itemId,
    ...(entryPath.length === 0 ? {} : { entryPath }),
    from: comment.rangeFrom,
    to: comment.rangeTo,
    quoted: comment.quoted,
  }
}

const viewOfComment = (
  comment: StoreCommentRecord,
  replies: ReadonlyArray<ReplyRecord>,
) => ({
  id: comment.id,
  scope:
    comment.targetKind === 'draft'
      ? { kind: 'draft' as const, draft: comment.targetNumber }
      : { kind: 'revision' as const, revision: comment.targetNumber },
  anchor: anchorOf(comment),
  authorId: comment.authorId,
  authorName: comment.authorName,
  body: comment.body,
  ...(comment.redactedBody === null ? {} : { redactedBody: comment.redactedBody }),
  visibility: comment.visibility,
  sent: comment.targetKind === 'draft' || comment.reviewId !== null,
  resolved: comment.resolved,
  createdAt: comment.createdAt,
  replies: replies
    .filter(reply => reply.commentId === comment.id)
    .map(reply => ({
      id: reply.id,
      authorId: reply.authorId,
      authorName: reply.authorName,
      body: reply.body,
      redactedBody: reply.redactedBody ?? '',
      createdAt: reply.createdAt,
    })),
})

const listFor = (
  db: Store,
  loaded: Loaded,
  userId: string,
  kind: 'draft' | 'revision',
  number: number,
) =>
  Effect.gen(function* () {
    const listed = yield* db.listComments({
      reportId: loaded.record.id,
      kind,
      number,
      audience: { kind: 'authors' },
    })
    return listed.comments
      .filter(comment =>
        canSeeComment({ id: userId, grants: [] }, loaded.access, {
          authorId: comment.authorId,
          scope:
            kind === 'draft'
              ? { kind: 'draft', draft: number }
              : { kind: 'revision', revision: number },
          visibility: comment.visibility,
          sent: kind === 'draft' || comment.reviewId !== null,
        }),
      )
      .map(comment => viewOfComment(comment, listed.replies))
  })

const peopleOfRevision = (db: Store, loaded: Loaded, revision: number) =>
  Effect.gen(function* () {
    const published = loaded.revisions.find(entry => entry.number === revision)
    if (published === undefined) return [] as ReadonlyArray<Person>
    const draft = yield* db.getDraft(loaded.record.id, published.draftNumber)
    return draft === null ? [] : peopleOf(draft.people)
  })

// NOTE: sets `safeToShare` on every figure of one image, anywhere in a
// section (rich text documents are plain JSON trees).
const flagFigures = (node: unknown, imageId: string, safe: boolean): unknown => {
  if (Array.isArray(node)) return node.map(item => flagFigures(item, imageId, safe))
  if (node === null || typeof node !== 'object') return node
  const record = node as Record<string, unknown>
  const mapped = Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      flagFigures(value, imageId, safe),
    ]),
  )
  const attrs = record['attrs'] as Record<string, unknown> | undefined
  if (record['type'] === 'figure' && attrs?.['imageId'] === imageId) {
    return { ...mapped, attrs: { ...attrs, safeToShare: safe } }
  }
  return mapped
}

export const authorExtraHandlers: Pick<
  AllHandlers,
  | 'GetRound'
  | 'StartConclusion'
  | 'ArchiveReport'
  | 'ListImages'
  | 'MarkImageSafe'
  | 'ListDraftComments'
  | 'AddDraftComment'
  | 'ListRevisionComments'
  | 'ReplyToComment'
  | 'ResolveComment'
> = {
  GetRound: ({ reportId, revision }) =>
    Effect.gen(function* () {
      const { loaded } = yield* member(reportId, { type: 'read_grid' })
      const view = roundViewOf(loaded, revision)
      if (view === undefined) return yield* Effect.fail(new NotFound())
      return view
    }),

  StartConclusion: ({ reportId }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, {
        type: 'start_conclusion',
      })
      const applied = applyEvent(
        { template: loaded.template, authors: loaded.authors, now: loaded.now },
        loaded.flow,
        { type: 'start_conclusion' },
      )
      if (Result.isFailure(applied)) {
        return yield* Effect.fail(stateFailure(applied.failure, loaded.record.state))
      }
      const moved = yield* db.moveReport({
        reportId,
        from: loaded.record.state,
        to: applied.success.state,
        now: loaded.now,
        audit: auditOf(loaded.now, user.id, 'report.conclusion_started', reportId),
      })
      if (moved._tag !== 'Moved') {
        return yield* Effect.fail(new Conflict({ reason: 'changed_meanwhile' }))
      }
      return summaryOf({
        ...loaded,
        record: { ...loaded.record, state: applied.success.state },
      })
    }),

  ArchiveReport: ({ reportId }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, {
        type: 'publish_revision',
      })
      const applied = applyEvent(
        { template: loaded.template, authors: loaded.authors, now: loaded.now },
        loaded.flow,
        { type: 'archive' },
      )
      if (Result.isFailure(applied)) {
        return yield* Effect.fail(stateFailure(applied.failure, loaded.record.state))
      }
      const moved = yield* db.moveReport({
        reportId,
        from: loaded.record.state,
        to: applied.success.state,
        now: loaded.now,
        audit: auditOf(loaded.now, user.id, 'report.archived', reportId),
      })
      if (moved._tag !== 'Moved') {
        return yield* Effect.fail(new Conflict({ reason: 'changed_meanwhile' }))
      }
      return summaryOf({
        ...loaded,
        record: { ...loaded.record, state: applied.success.state },
      })
    }),

  ListImages: ({ reportId }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const { db } = yield* member(reportId, {
        type: 'read_working_copy',
        ownerId: user.id,
      })
      const images = yield* db.listReportImages(reportId)
      const stats = yield* db.imageStats(reportId)
      const rows = yield* db.getWorkingCopyContents(reportId, user.id)
      const flags = new Map<string, boolean>()
      for (const row of rows) {
        for (const figure of sectionFigures(parseSection(row.content))) {
          flags.set(
            figure.imageId,
            (flags.get(figure.imageId) ?? true) && figure.safe,
          )
        }
      }
      return {
        images: images.map(image => ({
          id: image.id,
          owner: image.owner,
          mime: image.mime,
          width: image.width,
          height: image.height,
          size: image.size,
          hash: image.hash,
          uploadedBy: image.uploadedBy,
          uploadedAt: image.createdAt,
          referenced: image.referenced,
          safeToShare: flags.get(image.id) ?? false,
        })),
        referencedBytes: stats.reportBytes,
        limitBytes: stats.reportLimitBytes,
      }
    }),

  MarkImageSafe: ({ reportId, imageId, safe, saveCounter }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, {
        type: 'save_section',
        sectionId: '',
      })
      const image = yield* db.getImage(imageId)
      if (
        image === null ||
        image.owner.kind !== 'report' ||
        image.owner.reportId !== reportId
      ) {
        return yield* Effect.fail(new NotFound())
      }
      const copy = yield* db.getWorkingCopy(reportId, user.id)
      if (copy === null) {
        return yield* Effect.fail(validation('input', 'no_working_copy'))
      }
      if (copy.saveCounter !== saveCounter) {
        return yield* Effect.fail(new Conflict({ reason: 'stale_save' }))
      }
      const rows = yield* db.getWorkingCopyContents(reportId, user.id)
      const touched = rows.filter(row =>
        sectionFigures(parseSection(row.content)).some(
          figure => figure.imageId === imageId,
        ),
      )
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      if (touched.length === 0) {
        return { saveCounter: copy.saveCounter, savedAt: copy.lastSavedAt, sections: [] }
      }
      const outcome = yield* db.saveWorkingCopy({
        reportId,
        userId: user.id,
        expectedCounter: saveCounter,
        sections: touched.map(row => ({
          sectionId: row.sectionId,
          ordinal: row.ordinal,
          content: JSON.stringify(
            flagFigures(parseSection(row.content), imageId, safe),
          ),
        })),
        now,
      })
      if (outcome._tag !== 'Saved') {
        return yield* Effect.fail(new Conflict({ reason: 'stale_save' }))
      }
      void loaded
      return {
        saveCounter: outcome.saveCounter,
        savedAt: now,
        sections: touched.map(row => row.sectionId),
      }
    }),

  ListDraftComments: ({ reportId, draft }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, {
        type: 'read_draft_comments',
      })
      yield* allow(loaded, user, { type: 'read_draft', number: draft })
      return yield* listFor(db, loaded, user.id, 'draft', draft)
    }),

  AddDraftComment: ({ reportId, draft, anchor, body }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, {
        type: 'comment_on_draft',
      })
      yield* allow(loaded, user, { type: 'read_draft', number: draft })
      if (!sectionKnown(loaded.template, anchor.sectionId)) {
        return yield* Effect.fail(
          validation('input', 'unknown_section', [anchor.sectionId]),
        )
      }
      const id = yield* idOf('comment')
      const outcome = yield* db.addDraftComment({
        id,
        reportId,
        draftNumber: draft,
        authorId: user.id,
        sectionId: anchor.sectionId,
        itemId:
          anchor.kind === 'text'
            ? [...(anchor.entryPath ?? []), anchor.itemId].join('/')
            : null,
        rangeFrom: anchor.kind === 'text' ? anchor.from : null,
        rangeTo: anchor.kind === 'text' ? anchor.to : null,
        quoted: anchor.kind === 'text' ? anchor.quoted : null,
        body,
        redactedBody: null,
        visibility: 'authors',
        now: loaded.now,
      })
      if (outcome._tag !== 'Added') return yield* Effect.fail(new NotFound())
      const listed = yield* listFor(db, loaded, user.id, 'draft', draft)
      const made = listed.find(entry => entry.id === id)
      if (made === undefined) return yield* Effect.fail(new NotFound())
      return made
    }),

  ListRevisionComments: ({ reportId, revision }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, {
        type: 'read_comments',
        revision,
      })
      return yield* listFor(db, loaded, user.id, 'revision', revision)
    }),

  ReplyToComment: ({ reportId, commentId, body }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, {
        type: 'read_draft_comments',
      })
      const comment = yield* db.getComment(reportId, commentId)
      if (
        comment === null ||
        comment.targetKind !== 'revision' ||
        comment.reviewId === null
      ) {
        return yield* Effect.fail(new NotFound())
      }
      yield* allow(loaded, user, { type: 'reply', revision: comment.targetNumber })
      const redactor = redactorFor(
        yield* peopleOfRevision(db, loaded, comment.targetNumber),
      )
      const added = yield* db.addReply({
        id: yield* idOf('reply'),
        commentId,
        authorId: user.id,
        body,
        redactedBody: redactor.text(body),
        now: loaded.now,
      })
      if (!added) return yield* Effect.fail(new NotFound())
      const listed = yield* listFor(
        db,
        loaded,
        user.id,
        'revision',
        comment.targetNumber,
      )
      const made = listed.find(entry => entry.id === commentId)
      if (made === undefined) return yield* Effect.fail(new NotFound())
      return made
    }),

  ResolveComment: ({ reportId, commentId, resolved }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, {
        type: 'read_draft_comments',
      })
      const comment = yield* db.getComment(reportId, commentId)
      if (comment === null) return yield* Effect.fail(new NotFound())
      if (comment.targetKind === 'revision') {
        if (comment.reviewId === null) return yield* Effect.fail(new NotFound())
        yield* allow(loaded, user, {
          type: 'reply',
          revision: comment.targetNumber,
        })
      }
      const done = yield* db.setCommentResolved(commentId, resolved)
      if (!done) return yield* Effect.fail(new NotFound())
      const listed = yield* listFor(
        db,
        loaded,
        user.id,
        comment.targetKind,
        comment.targetNumber,
      )
      const made = listed.find(entry => entry.id === commentId)
      if (made === undefined) return yield* Effect.fail(new NotFound())
      return made
    }),
}

export { NotAllowedInState, mapSectionDocs }
