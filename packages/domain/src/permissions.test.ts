import { Result } from 'effect'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import {
  INTAKE_TEMPLATE,
  NOT_FOUND,
  type Account,
  type Action,
  type Capability,
  type CommentRecord,
  type Participant,
  type Permission,
  type ReportAccess,
  type ReportFlow,
  type ReportState,
  type Round,
  type Template,
  authorize,
  canSeeComment,
  checkNewAuthor,
} from './index'
import {
  TEST_UNIT,
  flowTemplateArbitrary,
  reportAccessOf,
} from './testing/reports'
import { PANEL_TEMPLATE } from './testing/templates'

const account = (
  id: string,
  ...grants: ReadonlyArray<Capability | readonly [Capability, string]>
): Account => ({
  id,
  grants: grants.map(g =>
    typeof g === 'string'
      ? { capability: g }
      : { capability: g[0], unit: g[1] },
  ),
})

const round = (
  revision: number,
  participants: ReadonlyArray<Participant>,
  status: Round['status'] = 'open',
): Round => ({
  revision,
  draft: revision,
  closing: false,
  deadline: 1000,
  participants,
  removed: [],
  reviews: [],
  status,
})

const flowOf = (
  state: ReportState,
  rounds: ReadonlyArray<Round>,
  draftCount = 3,
): ReportFlow => ({ state, draftCount, rounds })

const committee = (...ids: ReadonlyArray<string>): ReadonlyArray<Participant> =>
  ids.map(accountId => ({ accountId, roleId: 'committee' }))

const intakeReport = (
  rounds: ReadonlyArray<Round> = [round(1, committee('r1', 'r2'))],
  state: ReportState = 'in_review',
  authors: ReadonlyArray<string> = ['author-1', 'author-2'],
): ReportAccess =>
  reportAccessOf(INTAKE_TEMPLATE, flowOf(state, rounds), authors)

const panelReport = (): ReportAccess =>
  reportAccessOf(
    PANEL_TEMPLATE,
    flowOf('in_review', [
      round(1, [
        { accountId: 'chair-1', roleId: 'chair' },
        { accountId: 'member-1', roleId: 'members' },
        { accountId: 'member-2', roleId: 'members' },
        { accountId: 'observer-1', roleId: 'observer' },
      ]),
    ]),
    ['author-1'],
  )

const author1 = account('author-1', ['author', TEST_UNIT])
const reviewer1 = account('r1')

// Every action that concerns a report, with arguments that exist.
const REPORT_ACTIONS: ReadonlyArray<Action> = [
  { type: 'view_report' },
  { type: 'read_working_copy', ownerId: 'author-1' },
  { type: 'start_working_copy' },
  { type: 'save_section', sectionId: INTAKE_TEMPLATE.sections[0]!.id },
  { type: 'save_people' },
  { type: 'read_draft', number: 1 },
  { type: 'read_people' },
  { type: 'share_draft' },
  { type: 'comment_on_draft' },
  { type: 'read_draft_comments' },
  { type: 'publish_revision' },
  { type: 'add_co_author' },
  { type: 'reply', revision: 1 },
  { type: 'read_grid' },
  { type: 'read_audit' },
  { type: 'extend_deadline' },
  { type: 'remove_reviewer' },
  { type: 'start_conclusion' },
  { type: 'read_revision', revision: 1 },
  { type: 'read_comments', revision: 1 },
  { type: 'write_comment', revision: 1 },
  { type: 'submit_review', revision: 1, decision: 'approve' },
]

describe('capabilities', () => {
  const REQUIRED: ReadonlyArray<readonly [Action, Capability]> = [
    [{ type: 'set_theme' }, 'admin'],
    [{ type: 'manage_units' }, 'admin'],
    [{ type: 'manage_grants' }, 'admin'],
    [{ type: 'issue_reset' }, 'admin'],
    [{ type: 'create_template' }, 'template_editor'],
    [{ type: 'edit_template' }, 'template_editor'],
    [{ type: 'copy_template' }, 'template_editor'],
    [{ type: 'publish_template' }, 'template_editor'],
    [{ type: 'retire_template' }, 'template_editor'],
    [{ type: 'preview_template' }, 'template_editor'],
    [{ type: 'grant_first_admin' }, 'operator'],
    [{ type: 'deploy' }, 'operator'],
    [{ type: 'backup' }, 'operator'],
  ]
  const CAPABILITIES: ReadonlyArray<Capability> = [
    'admin',
    'template_editor',
    'author',
    'operator',
  ]

  test('each deployment action needs exactly its capability', () => {
    for (const [action, needed] of REQUIRED) {
      for (const capability of CAPABILITIES) {
        const result = authorize(
          account('x', capability === 'author' ? ['author', 'u1'] : capability),
          undefined,
          action,
        )
        expect(result.allowed).toBe(capability === needed)
      }
      expect(authorize(account('nobody'), undefined, action).allowed).toBe(
        false,
      )
    }
  })

  test('an author grant is for one unit', () => {
    const a = account('a', ['author', 'unit-a'])
    for (const type of [
      'create_report',
      'manage_committees',
      'invite_to_unit',
    ] as const) {
      expect(authorize(a, undefined, { type, unit: 'unit-a' }).allowed).toBe(
        true,
      )
      expect(authorize(a, undefined, { type, unit: 'unit-b' }).allowed).toBe(
        false,
      )
    }
    expect(
      authorize(account('admin', 'admin'), undefined, {
        type: 'create_report',
        unit: 'unit-a',
      }).allowed,
    ).toBe(false)
  })

  test('the administrator, a template editor and the operator get no report access', () => {
    const report = intakeReport()
    for (const who of [
      account('author-1x', 'admin', 'template_editor', 'operator'),
      account('te', 'template_editor'),
      account('adm', 'admin'),
    ]) {
      for (const action of REPORT_ACTIONS) {
        expect(authorize(who, report, action)).toEqual(NOT_FOUND)
      }
    }
  })

  test('an author of the unit who is not on the report cannot see it', () => {
    const outsider = account('author-9', ['author', TEST_UNIT])
    for (const action of REPORT_ACTIONS) {
      expect(authorize(outsider, intakeReport(), action)).toEqual(NOT_FOUND)
    }
  })

  test('forbidden and does not exist are indistinguishable', () => {
    const strangers = [
      account('s1'),
      account('s2', 'admin'),
      account('s3', ['author', 'unit-b']),
    ]
    for (const who of strangers) {
      for (const action of REPORT_ACTIONS) {
        expect(authorize(who, intakeReport(), action)).toEqual(
          authorize(who, undefined, action),
        )
      }
    }
    // Even a member gets the same answer for what is not theirs to know.
    expect(
      authorize(reviewer1, intakeReport(), { type: 'read_draft', number: 1 }),
    ).toEqual(NOT_FOUND)
  })
})

describe('what authors see', () => {
  test('content, their own working copy, drafts that exist, the people list', () => {
    const report = intakeReport()
    expect(
      authorize(author1, report, {
        type: 'read_working_copy',
        ownerId: 'author-1',
      }),
    ).toEqual({
      allowed: true,
      view: 'original',
    })
    expect(
      authorize(author1, report, { type: 'read_draft', number: 0 }),
    ).toEqual({
      allowed: true,
      view: 'original',
    })
    expect(
      authorize(author1, report, { type: 'read_draft', number: 3 }).allowed,
    ).toBe(true)
    for (const type of [
      'read_people',
      'read_grid',
      'read_audit',
      'view_report',
    ] as const) {
      expect(authorize(author1, report, { type }).allowed).toBe(true)
    }
    expect(
      authorize(author1, report, { type: 'read_revision', revision: 1 }),
    ).toEqual({
      allowed: true,
      view: 'original',
    })
  })

  test('nobody else sees a working copy, not even another author', () => {
    const report = intakeReport()
    expect(
      authorize(account('author-2'), report, {
        type: 'read_working_copy',
        ownerId: 'author-1',
      }),
    ).toEqual(NOT_FOUND)
  })

  test('a draft or revision that does not exist is not found', () => {
    const report = intakeReport()
    expect(
      authorize(author1, report, { type: 'read_draft', number: 4 }),
    ).toEqual(NOT_FOUND)
    expect(
      authorize(author1, report, { type: 'read_draft', number: -1 }),
    ).toEqual(NOT_FOUND)
    expect(
      authorize(author1, report, { type: 'read_revision', revision: 2 }),
    ).toEqual(NOT_FOUND)
    expect(
      authorize(author1, report, { type: 'read_revision', revision: 0 }),
    ).toEqual(NOT_FOUND)
  })

  test('an author is never a reviewer', () => {
    const report = intakeReport()
    expect(
      authorize(author1, report, {
        type: 'submit_review',
        revision: 1,
        decision: 'approve',
      }),
    ).toMatchObject({ allowed: false })
    expect(
      authorize(author1, report, { type: 'write_comment', revision: 1 })
        .allowed,
    ).toBe(false)
  })
})

describe('what reviewers see', () => {
  test('a redacted role reads redacted revisions sent to it, and nothing else', () => {
    const report = intakeReport()
    expect(
      authorize(reviewer1, report, { type: 'read_revision', revision: 1 }),
    ).toEqual({
      allowed: true,
      view: 'redacted',
    })
    expect(authorize(reviewer1, report, { type: 'view_report' }).allowed).toBe(
      true,
    )
    const hidden = REPORT_ACTIONS.filter(
      a =>
        ![
          'view_report',
          'read_revision',
          'read_comments',
          'write_comment',
          'submit_review',
        ].includes(a.type),
    )
    for (const action of hidden) {
      expect(authorize(reviewer1, report, action)).toEqual(NOT_FOUND)
    }
  })

  test('a full role reads the original revision, but no draft, working copy or people list', () => {
    const report = panelReport()
    const chair = account('chair-1')
    expect(
      authorize(chair, report, { type: 'read_revision', revision: 1 }),
    ).toEqual({
      allowed: true,
      view: 'original',
    })
    expect(
      authorize(account('member-1'), report, {
        type: 'read_revision',
        revision: 1,
      }),
    ).toEqual({
      allowed: true,
      view: 'redacted',
    })
    for (const action of [
      { type: 'read_draft', number: 1 },
      { type: 'read_working_copy', ownerId: 'chair-1' },
      { type: 'read_people' },
      { type: 'read_draft_comments' },
      { type: 'read_grid' },
      { type: 'read_audit' },
    ] as const) {
      expect(authorize(chair, report, action)).toEqual(NOT_FOUND)
    }
  })

  test('a revision not sent to a reviewer, or after removal, is not found', () => {
    const report = intakeReport([
      round(1, committee('r1', 'r2'), 'superseded'),
      round(2, committee('r2')),
    ])
    expect(
      authorize(reviewer1, report, { type: 'read_revision', revision: 1 })
        .allowed,
    ).toBe(true)
    expect(
      authorize(reviewer1, report, { type: 'read_revision', revision: 2 }),
    ).toEqual(NOT_FOUND)
    expect(
      authorize(reviewer1, report, { type: 'read_comments', revision: 2 }),
    ).toEqual(NOT_FOUND)
    expect(
      authorize(account('r2'), report, { type: 'read_revision', revision: 2 })
        .allowed,
    ).toBe(true)
    expect(authorize(account('r3'), report, { type: 'view_report' })).toEqual(
      NOT_FOUND,
    )
  })

  test('a reviewer sees the revision sent to them whatever the round became', () => {
    for (const status of ['superseded', 'decided'] as const) {
      const report = intakeReport(
        [round(1, committee('r1'), status)],
        'decided',
      )
      expect(
        authorize(reviewer1, report, { type: 'read_revision', revision: 1 })
          .allowed,
      ).toBe(true)
    }
  })
})

describe('a role without a permission is refused that action', () => {
  const AUTHOR_NEEDS: ReadonlyArray<readonly [Action, Permission]> = [
    [{ type: 'start_working_copy' }, 'edit'],
    [
      { type: 'save_section', sectionId: INTAKE_TEMPLATE.sections[0]!.id },
      'edit',
    ],
    [
      { type: 'save_section', sectionId: INTAKE_TEMPLATE.conclusion!.id },
      'write_conclusion',
    ],
    [{ type: 'save_people' }, 'manage_people'],
    [{ type: 'share_draft' }, 'share'],
    [{ type: 'comment_on_draft' }, 'comment_drafts'],
    [{ type: 'publish_revision' }, 'publish'],
    [{ type: 'add_co_author' }, 'manage_people'],
    [{ type: 'reply', revision: 1 }, 'reply'],
    [{ type: 'extend_deadline' }, 'publish'],
    [{ type: 'remove_reviewer' }, 'publish'],
    [{ type: 'start_conclusion' }, 'write_conclusion'],
  ]
  const ALL_DRAFTING: ReadonlyArray<Permission> = [
    'edit',
    'share',
    'publish',
    'manage_people',
    'comment_drafts',
    'reply',
    'write_conclusion',
  ]

  const withDraftingPermissions = (
    template: Template,
    permissions: ReadonlyArray<Permission>,
  ): Template => ({
    ...template,
    roles: template.roles.map(role =>
      role.kind === 'drafting' ? { ...role, permissions } : role,
    ),
  })

  test('property: an author action is allowed exactly when the drafting role has its permission', () => {
    fc.assert(
      fc.property(fc.subarray([...ALL_DRAFTING]), granted => {
        const template = withDraftingPermissions(INTAKE_TEMPLATE, granted)
        const report = reportAccessOf(
          template,
          flowOf('in_review', [round(1, committee('r1'))]),
          ['author-1'],
        )
        for (const [action, permission] of AUTHOR_NEEDS) {
          const result = authorize(author1, report, action)
          expect(result.allowed).toBe(granted.includes(permission))
          if (!result.allowed) expect(result.reason).toBe('not_permitted')
        }
      }),
      { numRuns: 200 },
    )
  })

  test('property: the same on generated templates, for every drafting role they have', () => {
    fc.assert(
      fc.property(
        flowTemplateArbitrary,
        fc.subarray([...ALL_DRAFTING]),
        (template, granted) => {
          const modified = withDraftingPermissions(template, granted)
          const report = reportAccessOf(
            modified,
            flowOf('in_review', [
              round(1, [
                {
                  accountId: 'r1',
                  roleId: modified.roles.find(r => r.kind === 'reviewing')!.id,
                },
              ]),
            ]),
            ['author-1'],
          )
          const checks: ReadonlyArray<readonly [Action, Permission]> = [
            [{ type: 'start_working_copy' }, 'edit'],
            [{ type: 'share_draft' }, 'share'],
            [{ type: 'publish_revision' }, 'publish'],
            [{ type: 'save_people' }, 'manage_people'],
            [{ type: 'comment_on_draft' }, 'comment_drafts'],
            [{ type: 'start_conclusion' }, 'write_conclusion'],
          ]
          for (const [action, permission] of checks) {
            expect(authorize(author1, report, action).allowed).toBe(
              granted.includes(permission),
            )
          }
          if (modified.conclusion !== undefined) {
            expect(
              authorize(author1, report, {
                type: 'save_section',
                sectionId: modified.conclusion.id,
              }).allowed,
            ).toBe(granted.includes('write_conclusion'))
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  test('property: a reviewer may comment or vote exactly as the role allows', () => {
    fc.assert(
      fc.property(
        fc.subarray<Permission>(['comment', 'vote']),
        fc.constantFrom<'full' | 'redacted'>('full', 'redacted'),
        (granted, view) => {
          const template: Template = {
            ...INTAKE_TEMPLATE,
            roles: INTAKE_TEMPLATE.roles.map(role =>
              role.kind === 'reviewing'
                ? { ...role, permissions: granted, view }
                : role,
            ),
          }
          const report = reportAccessOf(
            template,
            flowOf('in_review', [round(1, committee('r1'))]),
            ['author-1'],
          )
          const may = (action: Action) => authorize(reviewer1, report, action)
          expect(may({ type: 'write_comment', revision: 1 }).allowed).toBe(
            granted.includes('comment'),
          )
          expect(
            may({ type: 'submit_review', revision: 1, decision: 'comment' })
              .allowed,
          ).toBe(granted.includes('comment'))
          for (const decision of ['approve', 'request_changes'] as const) {
            expect(
              may({ type: 'submit_review', revision: 1, decision }).allowed,
            ).toBe(granted.includes('vote'))
          }
          expect(may({ type: 'read_revision', revision: 1 })).toEqual({
            allowed: true,
            view: view === 'full' ? 'original' : 'redacted',
          })
        },
      ),
      { numRuns: 100 },
    )
  })

  test('the observer comments but cannot vote', () => {
    const report = panelReport()
    const observer = account('observer-1')
    expect(
      authorize(observer, report, { type: 'write_comment', revision: 1 })
        .allowed,
    ).toBe(true)
    expect(
      authorize(observer, report, {
        type: 'submit_review',
        revision: 1,
        decision: 'approve',
      }),
    ).toEqual({ allowed: false, reason: 'not_permitted' })
    expect(
      authorize(observer, report, {
        type: 'submit_review',
        revision: 1,
        decision: 'comment',
      }).allowed,
    ).toBe(true)
  })

  test('in a template without a conclusion every section needs only the edit permission', () => {
    expect(
      authorize(author1, panelReport(), {
        type: 'save_section',
        sectionId: 'nope',
      }).allowed,
    ).toBe(true)
  })
})

describe('an archived report is read-only', () => {
  test('writes are refused with read_only, reads still work, strangers still see nothing', () => {
    const report = intakeReport(
      [round(1, committee('r1'), 'decided')],
      'archived',
    )
    const writes: ReadonlyArray<Action> = [
      { type: 'start_working_copy' },
      { type: 'save_section', sectionId: INTAKE_TEMPLATE.sections[0]!.id },
      { type: 'share_draft' },
      { type: 'publish_revision' },
      { type: 'comment_on_draft' },
      { type: 'add_co_author' },
      { type: 'reply', revision: 1 },
      { type: 'extend_deadline' },
      { type: 'remove_reviewer' },
      { type: 'start_conclusion' },
    ]
    for (const action of writes) {
      expect(authorize(author1, report, action)).toEqual({
        allowed: false,
        reason: 'read_only',
      })
    }
    expect(
      authorize(reviewer1, report, { type: 'write_comment', revision: 1 }),
    ).toEqual({ allowed: false, reason: 'read_only' })
    expect(
      authorize(author1, report, { type: 'read_draft', number: 1 }).allowed,
    ).toBe(true)
    expect(
      authorize(reviewer1, report, { type: 'read_revision', revision: 1 })
        .allowed,
    ).toBe(true)
    expect(authorize(account('s'), report, { type: 'share_draft' })).toEqual(
      NOT_FOUND,
    )
  })
})

describe('adding a co-author', () => {
  test('only an existing author may add one', () => {
    const report = intakeReport()
    expect(authorize(author1, report, { type: 'add_co_author' }).allowed).toBe(
      true,
    )
    expect(authorize(reviewer1, report, { type: 'add_co_author' })).toEqual(
      NOT_FOUND,
    )
    expect(
      authorize(account('author-9', ['author', TEST_UNIT]), report, {
        type: 'add_co_author',
      }),
    ).toEqual(NOT_FOUND)
  })

  test('a reviewer of an open round cannot be added until removed from it', () => {
    const open = intakeReport()
    expect(Result.isFailure(checkNewAuthor(open, 'r1'))).toBe(true)
    expect(Result.isSuccess(checkNewAuthor(open, 'someone-else'))).toBe(true)
    const decided = intakeReport(
      [round(1, committee('r1', 'r2'), 'decided')],
      'decided',
    )
    expect(Result.isSuccess(checkNewAuthor(decided, 'r1'))).toBe(true)
    const removed = intakeReport([
      { ...round(1, committee('r2')), removed: committee('r1') },
    ])
    expect(Result.isSuccess(checkNewAuthor(removed, 'r1'))).toBe(true)
  })
})

describe('comments', () => {
  const report = intakeReport(
    [
      round(1, committee('r1', 'r2', 'r3'), 'superseded'),
      round(2, committee('r1', 'r2')),
    ],
    'in_review',
  )
  const mine = (
    visibility: 'authors' | 'committee',
    sent: boolean,
  ): CommentRecord => ({
    authorId: 'r1',
    scope: { kind: 'revision', revision: 1 },
    visibility,
    sent,
  })
  const sees = (id: string, comment: CommentRecord) =>
    canSeeComment(account(id), report, comment)

  test('a comment for the authors only is seen by its writer and the authors', () => {
    const comment = mine('authors', true)
    expect(sees('r1', comment)).toBe(true)
    expect(sees('author-1', comment)).toBe(true)
    expect(sees('r2', comment)).toBe(false)
    expect(sees('r3', comment)).toBe(false)
  })

  test('a comment for the whole committee is seen by the reviewers of that revision, once sent', () => {
    const sent = mine('committee', true)
    expect(sees('r1', sent)).toBe(true)
    expect(sees('r2', sent)).toBe(true)
    expect(sees('r3', sent)).toBe(true)
    expect(sees('author-2', sent)).toBe(true)
    // Revision 1 was sent to r3, but not Revision 2.
    expect(
      canSeeComment(account('r3'), report, {
        ...sent,
        scope: { kind: 'revision', revision: 2 },
      }),
    ).toBe(false)
    // Someone outside the report sees nothing.
    expect(sees('outsider', sent)).toBe(false)
  })

  test('before the review is sent, only its writer sees a comment, whatever its visibility', () => {
    for (const visibility of ['authors', 'committee'] as const) {
      const pending = mine(visibility, false)
      expect(sees('r1', pending)).toBe(true)
      expect(sees('r2', pending)).toBe(false)
      expect(sees('author-1', pending)).toBe(false)
    }
  })

  test('comments on drafts are for the authors only', () => {
    const onDraft: CommentRecord = {
      authorId: 'author-1',
      scope: { kind: 'draft', draft: 2 },
      visibility: 'authors',
      sent: true,
    }
    expect(sees('author-2', onDraft)).toBe(true)
    expect(sees('author-1', onDraft)).toBe(true)
    expect(sees('r1', onDraft)).toBe(false)
    expect(sees('r1', { ...onDraft, visibility: 'committee' })).toBe(false)
  })

  test('a reviewer removed from the round sees none of its comments', () => {
    const removedReport = intakeReport([
      { ...round(1, committee('r2')), removed: committee('r1') },
    ])
    const own: CommentRecord = mine('committee', true)
    expect(canSeeComment(account('r1'), removedReport, own)).toBe(false)
    expect(canSeeComment(account('r2'), removedReport, own)).toBe(true)
  })

  test('property: visibility follows the rules, for any comment and any person', () => {
    const comments = fc.record({
      authorId: fc.constantFrom('r1', 'r2', 'r3', 'author-1'),
      scope: fc.oneof(
        fc.record({
          kind: fc.constant('draft' as const),
          draft: fc.integer({ min: 0, max: 3 }),
        }),
        fc.record({
          kind: fc.constant('revision' as const),
          revision: fc.integer({ min: 1, max: 2 }),
        }),
      ),
      visibility: fc.constantFrom('authors', 'committee'),
      sent: fc.boolean(),
    })
    const viewers = fc.constantFrom(
      'author-1',
      'author-2',
      'r1',
      'r2',
      'r3',
      'outsider',
    )
    const sentTo: Readonly<Record<number, ReadonlyArray<string>>> = {
      1: ['r1', 'r2', 'r3'],
      2: ['r1', 'r2'],
    }
    fc.assert(
      fc.property(comments, viewers, (comment, viewer) => {
        const c = comment as CommentRecord
        const isAuthor = viewer.startsWith('author')
        let expected: boolean
        if (c.scope.kind === 'draft') {
          expected = isAuthor
        } else if (isAuthor) {
          expected = c.sent
        } else if (!(sentTo[c.scope.revision] ?? []).includes(viewer)) {
          expected = false
        } else {
          expected =
            c.authorId === viewer || (c.sent && c.visibility === 'committee')
        }
        expect(canSeeComment(account(viewer), report, c)).toBe(expected)
      }),
      { numRuns: 500 },
    )
  })
})
