import { Option } from 'effect'
import {
  Command,
  click,
  expect,
  given,
  role,
  scene,
  selector,
  text,
  type,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import { type AuthorCommentView, INTAKE_TEMPLATE } from '@case-desk/domain'

import { clickedLinkTo } from './fixtures'
import { Message, update } from './main'
import { revision } from './publish.fixtures'
import { authorModel } from './quoroom.fixtures'
import * as Comments from './quoroom/comments'
import * as Review from './quoroom/review'
import { REPORT_ID, detailOf } from './report.fixtures'
import {
  FROM,
  PHRASE,
  SCOPE,
  authorComment,
  loaded,
  noteComment,
  outlineOf,
  replyOf,
  textComment,
} from './review.fixtures'
import { view } from './view'

// NOTE: Stages 6b and 6c: the reading view, selection to comment, the pending
// review, the send dialog and the authors' list of comments. The text is the
// read-only view; width is a matter of the grid classes, checked in the
// browser test at 375 px and at desktop width.

export const reviewScreen = (options: Parameters<typeof loaded>[0] = {}) =>
  [
    clickedLinkTo(`/r/${REPORT_ID}/rev/2`),
    Message.GotReviewMessage({
      message: Review.Message.SucceededLoadReview({
        scope: SCOPE,
        loaded: loaded(options),
      }),
    }),
  ].reduce((model, message) => update(model, message).model, authorModel)

export const withReviewMessages = (
  model: ReturnType<typeof reviewScreen>,
  ...messages: ReadonlyArray<Review.Message>
) =>
  messages.reduce(
    (current, message) =>
      update(current, Message.GotReviewMessage({ message })).model,
    model,
  )

export const commentsScreen = (
  comments: ReadonlyArray<AuthorCommentView>,
  permissions: Parameters<typeof detailOf>[2] = ['reply'],
) =>
  [
    clickedLinkTo(`/r/${REPORT_ID}/comments`),
    Message.GotCommentsMessage({
      message: Comments.Message.SucceededLoadComments({
        scope: SCOPE,
        loaded: {
          detail: detailOf(INTAKE_TEMPLATE, 'in_review', permissions),
          template: INTAKE_TEMPLATE,
          groups: [{ revision: revision(2, 'open'), comments }],
        },
      }),
    }),
  ].reduce((model, message) => update(model, message).model, authorModel)


const selection = {
  sectionId: 'summary',
  itemId: 'summary-text',
  entryPath: [],
  from: FROM,
  to: FROM + PHRASE.length,
  quoted: PHRASE,
}

describe('the reading view', () => {
  test('shows the revision, the section text, the deadline and no editor', () => {
    scene(
      { update, view },
      given(reviewScreen()),
      expect(role('heading', { name: 'Revision 2' })).toExist(),
      expect(text('The unit reported', { exact: false })).toExist(),
      expect(text('Due', { exact: false })).toExist(),
      expect(selector('quoroom-editor')).toBeAbsent(),
      expect(role('button', { name: 'Comment on this section' })).toExist(),
    )
  })

  test('a comment on text highlights the phrase and sits in the comments', () => {
    scene(
      { update, view },
      given(reviewScreen({ comments: [textComment('c1')] })),
      expect(selector('[data-comment-highlight="c1"]')).toExist(),
      expect(text('Please say how long.')).toExist(),
      expect(text('Authors only · Not sent yet')).toExist(),
      expect(role('button', { name: /Edit comment/ })).toExist(),
    )
  })

  test('a section note of a full reviewer is listed with the section', () => {
    scene(
      { update, view },
      given(
        reviewScreen({
          comments: [
            noteComment('c2'),
          ],
        }),
      ),
      expect(text('Chair Person', { exact: false })).toExist(),
      expect(selector('[data-comment-highlight]')).toBeAbsent(),
    )
  })

  test('a superseded revision links to the new one and takes no comments', () => {
    scene(
      { update, view },
      given(reviewScreen({ status: 'superseded' })),
      expect(selector('[data-banner="superseded"]')).toExist(),
      expect(role('link', { name: 'Read Revision 3' })).toHaveAttr(
        'href',
        '/r/report-1/rev/3',
      ),
      expect(role('button', { name: 'Comment on this section' })).toBeAbsent(),
      expect(role('button', { name: 'Send your review' })).toBeAbsent(),
    )
  })

  test('a decided round is read-only', () => {
    scene(
      { update, view },
      given(reviewScreen({ status: 'decided' })),
      expect(selector('[data-banner="decided"]')).toExist(),
      expect(role('button', { name: 'Comment on this section' })).toBeAbsent(),
    )
  })
})

describe('commenting', () => {
  test('selected text opens a comment that is for the authors unless changed', () => {
    scene(
      { update, view },
      given(
        withReviewMessages(
          reviewScreen(),
          Review.Message.ChangedSelection({
            maybeSelection: Option.some(selection),
          }),
        ),
      ),
      expect(selector('[data-selection-bar]')).toExist(),
      click(role('button', { name: 'Comment on the selected text' })),
      Command.resolve(
        Review.FocusComposer,
        Review.Message.CompletedFocusComposer(),
      ),
      expect(role('radio', { name: /Authors only/ })).toBeChecked(),
      type(role('textbox', { name: 'Your comment' }), 'Please say how long.'),
      click(role('radio', { name: /The whole committee/ })),
      click(role('button', { name: 'Add comment' })),
      Command.resolve(
        Review.AddReviewComment,
        Review.Message.SucceededAddComment({
          scope: SCOPE,
          comment: textComment('c1', { visibility: 'committee' }),
        }),
      ),
      expect(text('The whole committee · Not sent yet')).toExist(),
      expect(selector('[data-comment-highlight="c1"]')).toExist(),
    )
  })

  test('a whole section can be commented on without a selection', () => {
    scene(
      { update, view },
      given(reviewScreen()),
      click(role('button', { name: 'Comment on this section' })),
      Command.resolve(
        Review.FocusComposer,
        Review.Message.CompletedFocusComposer(),
      ),
      expect(role('textbox', { name: 'Your comment' })).toExist(),
      expect(role('button', { name: 'Add comment' })).toBeDisabled(),
    )
  })

  test('a pending comment can be edited and deleted', () => {
    scene(
      { update, view },
      given(reviewScreen({ comments: [textComment('c1')] })),
      click(role('button', { name: /Edit comment/ })),
      type(role('textbox', { name: 'Edit your comment' }), ' And why.'),
      click(role('button', { name: 'Save changes' })),
      Command.resolve(
        Review.UpdateReviewComment,
        Review.Message.SucceededUpdateComment({
          scope: SCOPE,
          comment: textComment('c1', {
            body: 'Please say how long. And why.',
          }),
        }),
      ),
      expect(text('Please say how long. And why.')).toExist(),
      click(role('button', { name: /Delete comment/ })),
      Command.resolve(
        Review.DeleteReviewComment,
        Review.Message.SucceededDeleteComment({
          scope: SCOPE,
          commentId: 'c1',
        }),
      ),
      expect(text('No comments here yet.')).toExist(),
    )
  })
})

describe('the pending review and sending', () => {
  test('the pending panel counts what is waiting', () => {
    scene(
      { update, view },
      given(
        reviewScreen({
          comments: [
            textComment('c1'),
            textComment('c2', { visibility: 'committee' }),
          ],
        }),
      ),
      expect(selector('[data-pending-count="2"]')).toExist(),
    )
  })

  test('the send dialog summarises, asks for a decision and confirms', () => {
    scene(
      { update, view },
      given(
        reviewScreen({
          comments: [
            textComment('c1'),
            textComment('c2', { visibility: 'committee' }),
          ],
        }),
      ),
      click(role('button', { name: 'Send your review' })),
      expect(
        text('2 comments are sent: 1 to the authors only, 1 to the whole committee.'),
      ).toExist(),
      expect(
        role('button', { name: 'Confirm and send review' }),
      ).toBeDisabled(),
      click(role('radio', { name: /Request changes/ })),
      click(role('button', { name: 'Confirm and send review' })),
      Command.resolve(
        Review.SendReview,
        Review.Message.SucceededSendReview({
          scope: SCOPE,
          result: {
            reviewId: 'review-1',
            decision: 'request_changes',
            sentAt: 0,
            commentsSent: 2,
            round: {
              status: 'open',
              deadline: { at: 0, timeZone: 'Europe/Madrid' },
              closing: false,
            },
          },
        }),
      ),
      Command.resolve(
        Review.RefreshReview,
        Review.Message.SucceededRefreshReview({
          scope: SCOPE,
          outline: outlineOf(),
          comments: [
            textComment('c1', { sent: true }),
            textComment('c2', { sent: true, visibility: 'committee' }),
          ],
        }),
      ),
      expect(selector('[data-review-sent="request_changes"]')).toExist(),
      expect(text('Authors only · Sent')).toExist(),
    )
  })

  test('a reviewer who cannot vote is only offered comment only', () => {
    scene(
      { update, view },
      given(reviewScreen({ canVote: false })),
      click(role('button', { name: 'Send your review' })),
      expect(role('radio', { name: /Comment only/ })).toExist(),
      expect(role('radio', { name: /Approve/ })).toBeAbsent(),
    )
  })

  test('an ended session says that the comments are kept', () => {
    scene(
      { update, view },
      given(
        withReviewMessages(
          reviewScreen(),
          Review.Message.FailedAddComment({
            scope: SCOPE,
            failure: { _tag: 'SignInRequired' },
          }),
        ),
      ),
      expect(
        text('Your session has ended', { exact: false }),
      ).toExist(),
    )
  })
})

describe('the comments of the authors', () => {
  test('lists each comment with its replies and the twin text of a full reviewer', () => {
    scene(
      { update, view },
      given(
        commentsScreen([
          authorComment('c1', {
            redactedBody: 'Please say how long, Person A.',
            replies: [replyOf('r1', 'Two weeks.')],
          }),
        ]),
      ),
      expect(role('heading', { name: 'Comments on Revision 2' })).toExist(),
      expect(text('Please say how long.')).toExist(),
      expect(selector('[data-redacted-twin]')).toExist(),
      expect(text('Two weeks.')).toExist(),
    )
  })

  test('an author replies and resolves', () => {
    scene(
      { update, view },
      given(commentsScreen([authorComment('c1')])),
      type(role('textbox', { name: 'Reply' }), 'Two weeks.'),
      click(role('button', { name: 'Send reply to this comment' })),
      Command.resolve(
        Comments.ReplyToRevisionComment,
        Comments.Message.SucceededReply({
          scope: SCOPE,
          comment: authorComment('c1', {
            replies: [replyOf('r1', 'Two weeks.')],
          }),
        }),
      ),
      expect(selector('[data-reply="r1"]')).toExist(),
      click(role('button', { name: 'Resolve this comment' })),
      Command.resolve(
        Comments.SetRevisionCommentResolved,
        Comments.Message.SucceededResolve({
          scope: SCOPE,
          comment: authorComment('c1', { resolved: true }),
        }),
      ),
      expect(selector('[data-resolved="true"]')).toExist(),
    )
  })

  test('someone who may not reply sees the comments without the form', () => {
    scene(
      { update, view },
      given(commentsScreen([authorComment('c1')], [])),
      expect(text('Please say how long.')).toExist(),
      expect(role('textbox', { name: 'Reply' })).toBeAbsent(),
    )
  })
})
