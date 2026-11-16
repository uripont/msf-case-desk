import { Arbitrary, Effect, Result, Schema, SchemaAST } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { compareDrafts } from '../compare'
import { draftTripleArbitrary } from '../testing/drafts'
import { templateWithContentArbitrary } from '../testing/content'
import { validTemplateArbitrary } from '../testing/templates'
import { buildGrid } from '../grid'
import { DEFAULT_THEME } from '../theme'
import { SectionContent, emptyContent } from '../content'
import { BUILT_IN_TEMPLATES } from '../builtin-templates'
import { initialFlow } from '../report-flow'
import { INTAKE_TEMPLATE } from '../builtin-templates'
import { type Account, type Action, type ReportAccess, authorize } from '../permissions'
import { reportAccessOf } from '../testing/reports'
import {
  ALL_RPCS,
  Comparison,
  DraftConflictSchema,
  GridSchema,
  IMAGE_CHUNK_BYTES,
  IMAGE_ERROR_CODES,
  IMAGE_ERROR_STATUS,
  ImageChunkQueryFromStrings,
  ImageChunkResult,
  PROCEDURE_NAMES,
  PROCEDURES,
  type ProcedureName,
  NotFound,
  NotPermitted,
  ReadError,
  StateError,
  TimedError,
  WriteError,
  refusalToError,
  REVIEWER_PROCEDURES,
  QuoroomPublicRpcs,
  QuoroomRpcs,
  ShareOutcome,
  TemplateVersionRecord,
  ThemeRecord,
  WorkingCopySection,
} from './index'

// NOTE: Contract tests. Round trips use values generated from the Schemas
// themselves (so every field of every request and response is exercised)
// and, where the domain has generators, domain values.

const SAMPLES = 25

const sample = <S extends Schema.Top>(schema: S, count = SAMPLES) =>
  Effect.runPromise(
    Arbitrary.sampleEffect(Arbitrary.schema(schema as never), {
      count,
      seed: 7,
    }),
  ) as Promise<ReadonlyArray<S['Type']>>

const roundTrip = <S extends Schema.Top>(schema: S, value: S['Type']) => {
  const encoded = Schema.encodeSync(schema as never)(value as never)
  // NOTE: Through JSON, as on the wire.
  const wire = JSON.parse(JSON.stringify(encoded))
  const decoded = Schema.decodeUnknownSync(schema as never)(wire)
  // NOTE: Compared as JSON, where -0 and 0 are one number and undefined is absent.
  expect(JSON.parse(JSON.stringify(decoded))).toEqual(JSON.parse(JSON.stringify(value)))
}

const procedures = ALL_RPCS.map(rpc => [rpc._tag, rpc] as const)

describe('procedure table', () => {
  it('has exactly one row per procedure of the signed-in group', () => {
    const tags = [...QuoroomRpcs.requests.keys()].sort()
    expect([...PROCEDURE_NAMES].sort()).toEqual(
      [...tags, ...QuoroomPublicRpcs.requests.keys()]
        .filter(tag => tag in PROCEDURES)
        .sort(),
    )
    for (const tag of tags) expect(PROCEDURES).toHaveProperty(tag)
    for (const tag of QuoroomPublicRpcs.requests.keys()) {
      expect(PROCEDURES).toHaveProperty(tag)
    }
  })

  it('has no duplicate tags across the groups', () => {
    expect(new Set(ALL_RPCS.map(rpc => rpc._tag)).size).toBe(ALL_RPCS.length)
  })

  it('never lets a public procedure name an authorize action', () => {
    for (const [name, row] of Object.entries(PROCEDURES)) {
      if (row.audience === 'public') {
        expect(row.actions, name).toEqual([])
      }
    }
  })
})

describe('errors', () => {
  it('declares an error schema for every procedure', () => {
    for (const [tag, rpc] of procedures) {
      expect(SchemaAST.isNever(rpc.errorSchema.ast), tag).toBe(false)
    }
  })

  it('answers forbidden and missing with the same value', () => {
    const decode = Schema.decodeUnknownSync(
      QuoroomRpcs.requests.get('GetReport')!.errorSchema as never,
    )
    expect(decode({ _tag: 'NotFound' })).toEqual(decode({ _tag: 'NotFound' }))
    // NotFound carries no field that could tell the two apart.
    expect(Object.keys(decode({ _tag: 'NotFound' }) as object)).toEqual([
      '_tag',
    ])
  })

  it('declares the refusals the plan names', () => {
    const accepts = (name: string, error: unknown): boolean => {
      const rpc = QuoroomRpcs.requests.get(name) ?? QuoroomPublicRpcs.requests.get(name)
      return Result.isSuccess(
        Schema.decodeUnknownResult(rpc!.errorSchema as never)(error),
      )
    }
    const notFound = { _tag: 'NotFound' }
    const deadline = { _tag: 'DeadlinePassed', deadline: 1 }
    const state = { _tag: 'NotAllowedInState', state: 'archived', code: 'x' }
    const conflict = { _tag: 'Conflict', reason: 'stale_save' }
    for (const error of [notFound, deadline, state, conflict]) {
      expect(accepts('SendReview', error), JSON.stringify(error)).toBe(true)
    }
    expect(accepts('SignIn', { _tag: 'Throttled', retryAfterSeconds: 30 })).toBe(true)
    expect(accepts('SignIn', { _tag: 'InvalidCredentials' })).toBe(true)
    expect(accepts('ConsumeLink', { _tag: 'LinkInvalid' })).toBe(true)
    expect(accepts('SaveSection', conflict)).toBe(true)
    expect(accepts('SaveSection', { _tag: 'Validation', problems: [] })).toBe(true)
    // A read cannot fail with a conflict or a deadline.
    expect(accepts('GetReport', conflict)).toBe(false)
    expect(accepts('GetReport', deadline)).toBe(false)
  })
})

describe('Schema round trips', () => {
  for (const [tag, rpc] of procedures) {
    for (const part of ['payloadSchema', 'successSchema', 'errorSchema'] as const) {
      const schema = rpc[part] as Schema.Top
      if (SchemaAST.isVoid(schema.ast) || SchemaAST.isNever(schema.ast)) continue
      // NOTE: Generating rich text from its Schema discards too much; these
      // two are covered with the domain's content generators below.
      if (tag === 'SaveSection' || tag === 'GetWorkingCopySection') continue
      it(`${tag} ${part}`, async () => {
        for (const value of await sample(schema)) roundTrip(schema, value)
      })
    }
  }
})

describe('Schema round trips with domain generators', () => {
  it('section content from generated templates', () => {
    fc.assert(
      fc.property(templateWithContentArbitrary, ({ content }) => {
        for (const [sectionId, section] of Object.entries(content.sections)) {
          roundTrip(WorkingCopySection, {
            sectionId,
            saveCounter: 3,
            content: section,
          })
          roundTrip(SectionContent, section)
        }
      }),
      { numRuns: 40 },
    )
  })

  it('template records from generated templates', () => {
    fc.assert(
      fc.property(validTemplateArbitrary, template => {
        roundTrip(TemplateVersionRecord, {
          templateId: template.id,
          version: template.version,
          state: 'draft',
          draftRevision: 0,
          template,
          createdBy: 'a1',
          createdAt: 1,
        })
      }),
      { numRuns: 40 },
    )
  })

  it('the stale-base comparison from real merges', () => {
    fc.assert(
      fc.property(draftTripleArbitrary, triple => {
        const merge = compareDrafts(triple.template, {
          base: triple.base,
          ours: triple.ours,
          theirs: triple.theirs,
        })
        const comparison = {
          baseDraft: 1,
          theirsDraft: 2,
          conflicts: merge.conflicts,
          problems: merge.problems.map(p => ({
            source: 'merge' as const,
            code: p.code,
            path: p.path,
            message: p.message,
          })),
        }
        roundTrip(Comparison, comparison)
        roundTrip(ShareOutcome, {
          kind: 'stale_base',
          latestDraft: 2,
          comparison,
        })
        for (const conflict of merge.conflicts) {
          roundTrip(DraftConflictSchema, conflict)
        }
      }),
      { numRuns: 40 },
    )
  })

  it('the grid and the theme', () => {
    const template = BUILT_IN_TEMPLATES[0]!
    const grid = buildGrid({
      template,
      flow: initialFlow,
      authors: ['a1'],
      events: [],
    })
    roundTrip(GridSchema, grid)
    roundTrip(ThemeRecord, { theme: DEFAULT_THEME })
    expect(emptyContent(template).sections).toEqual({})
  })
})

describe('/api/images', () => {
  it('keeps a chunk under the spike limit', () => {
    expect(IMAGE_CHUNK_BYTES).toBe(700_000)
  })

  it('decodes a query string and refuses out-of-range values', () => {
    const decode = Schema.decodeUnknownSync(ImageChunkQueryFromStrings)
    const query = {
      uploadId: 'u1',
      owner: 'theme',
      index: '1',
      chunks: '2',
      mime: 'image/png',
      width: '800',
      height: '600',
      size: '900000',
    }
    expect(decode(query)).toMatchObject({ index: 1, chunks: 2, width: 800 })
    expect(() => decode({ ...query, width: '5000' })).toThrow()
    expect(() => decode({ ...query, size: '2000000' })).toThrow()
    expect(() => decode({ ...query, index: '1.5' })).toThrow()
    expect(() => decode({ ...query, mime: 'image/gif' })).toThrow()
  })

  it('round trips its responses and gives every error a status', async () => {
    for (const value of await sample(ImageChunkResult)) {
      roundTrip(ImageChunkResult, value)
    }
    for (const code of IMAGE_ERROR_CODES) {
      expect(IMAGE_ERROR_STATUS[code]).toBeGreaterThanOrEqual(400)
    }
  })
})

// ---- Structural rules for reviewer-facing procedures ------------------------------------------

// NOTE: Names no reviewer response or request may carry: they belong to the
// authors' side of the report (working copies, drafts, people, aliases, the
// redacted twin of a body, and a caller's choice of view).
const AUTHOR_ONLY_FIELDS = [
  'people',
  'aliases',
  'alias',
  'workingCopy',
  'baseDraft',
  'saveCounter',
  'draft',
  'redactedBody',
  'redactedHash',
  'redactionConfirmed',
  'participants',
  'removed',
  'authors',
  'events',
  'flow',
  'grid',
]

const fieldNames = (schema: Schema.Top): ReadonlySet<string> => {
  const names = new Set<string>()
  const seen = new Set<SchemaAST.AST>()
  const visit = (node: SchemaAST.AST): void => {
    if (seen.has(node)) return
    seen.add(node)
    if (SchemaAST.isObjects(node)) {
      for (const property of node.propertySignatures) {
        names.add(String(property.name))
        visit(property.type)
      }
      for (const index of node.indexSignatures) visit(index.type)
    } else if (SchemaAST.isUnion(node)) {
      node.types.forEach(visit)
    } else if (SchemaAST.isArrays(node)) {
      node.elements.forEach(visit)
      node.rest.forEach(visit)
    } else if (SchemaAST.isSuspend(node)) {
      visit(node.thunk())
    }
  }
  visit(schema.ast)
  return names
}

// NOTE: The type of a schema as a short string, so a test can compare shapes
// and not only names: `{kind:"section_note",sectionId:string,quoted?:string}`.
// Checks (length, pattern) are not part of it.
const describeAst = (node: SchemaAST.AST): string => {
  if (SchemaAST.isObjects(node)) {
    const fields = node.propertySignatures
      .map(
        property =>
          `${String(property.name)}${property.type.context?.isOptional === true ? '?' : ''}:${describeAst(property.type)}`,
      )
      .sort()
    return `{${fields.join(',')}}`
  }
  if (SchemaAST.isUnion(node)) return node.types.map(describeAst).sort().join('|')
  if (SchemaAST.isArrays(node)) return `Array<${node.rest.map(describeAst).join(',')}>`
  if (node._tag === 'Literal') return JSON.stringify((node as { literal: unknown }).literal)
  return node._tag.toLowerCase()
}

// NOTE: The structs a schema is made of, through unions and arrays.
const structsOfAst = (root: SchemaAST.AST): ReadonlyArray<SchemaAST.Objects> => {
  const out: Array<SchemaAST.Objects> = []
  const visit = (node: SchemaAST.AST): void => {
    if (SchemaAST.isObjects(node)) out.push(node)
    else if (SchemaAST.isUnion(node)) node.types.forEach(visit)
    else if (SchemaAST.isArrays(node)) node.rest.forEach(visit)
  }
  visit(root)
  return out
}
const structsOf = (schema: Schema.Top): ReadonlyArray<SchemaAST.Objects> =>
  structsOfAst(schema.ast)
const propertyOf = (node: SchemaAST.Objects, name: string) =>
  node.propertySignatures.find(property => String(property.name) === name)

describe('regression: refusals reach members as NotPermitted, everyone else as NotFound', () => {
  const report = (state: 'in_review' | 'archived') =>
    reportAccessOf(
      INTAKE_TEMPLATE,
      {
        state,
        draftCount: 1,
        rounds: [
          {
            revision: 1,
            draft: 1,
            closing: false,
            deadline: 1000,
            participants: [{ accountId: 'r1', roleId: 'committee' }],
            removed: [],
            reviews: [],
            status: state === 'archived' ? 'decided' : 'open',
          },
        ],
      },
      ['author-1'],
    )
  const who = (id: string): Account => ({ id, grants: [] })
  const errorFor = (account: Account, access: ReportAccess | undefined, action: Action) => {
    const result = authorize(account, access, action)
    return result.allowed ? 'allowed' : refusalToError(result)
  }

  it('maps each refusal to one error', () => {
    expect(refusalToError({ allowed: false, reason: 'not_found' })).toBeInstanceOf(NotFound)
    expect(refusalToError({ allowed: false, reason: 'not_permitted' })).toMatchObject({
      _tag: 'NotPermitted',
      reason: 'not_permitted',
    })
    expect(refusalToError({ allowed: false, reason: 'read_only' })).toMatchObject({
      _tag: 'NotPermitted',
      reason: 'read_only',
    })
  })

  it('a member without the permission, or on an archived report, gets NotPermitted', () => {
    // A reviewer of a role that may not comment would; here: an author on an
    // archived report writing, and an author acting as a reviewer.
    expect(errorFor(who('author-1'), report('archived'), { type: 'share_draft' })).toMatchObject({
      _tag: 'NotPermitted',
      reason: 'read_only',
    })
    expect(
      errorFor(who('author-1'), report('in_review'), {
        type: 'submit_review',
        revision: 1,
        decision: 'approve',
      }),
    ).toMatchObject({ _tag: 'NotPermitted', reason: 'not_permitted' })
    expect(
      errorFor(who('x'), undefined, { type: 'set_theme' }),
    ).toMatchObject({ _tag: 'NotPermitted' })
  })

  it('a non-member always gets NotFound, whether the report exists or not', () => {
    const actions: ReadonlyArray<Action> = [
      { type: 'view_report' },
      { type: 'share_draft' },
      { type: 'read_grid' },
      { type: 'read_template_version', revision: 1 },
      { type: 'read_revision', revision: 1 },
      { type: 'submit_review', revision: 1, decision: 'approve' },
      { type: 'publish_revision' },
    ]
    for (const action of actions) {
      for (const access of [report('in_review'), report('archived'), undefined]) {
        expect(errorFor(who('stranger'), access, action), action.type).toBeInstanceOf(NotFound)
      }
    }
  })

  it('every set of errors a procedure can declare has both', () => {
    for (const set of [ReadError, WriteError, StateError, TimedError]) {
      expect(set.members.includes(NotPermitted)).toBe(true)
      expect(set.members.includes(NotFound)).toBe(true)
    }
    // The ones that declare only a storage error never call `authorize`.
    for (const name of ['GetMe', 'GetTheme', 'ListInbox', 'ListUnits', 'SignOut']) {
      expect(PROCEDURES[name as ProcedureName].actions, name).toEqual([])
    }
  })
})

describe('regression: inviting and adding never discloses an existing account (D13)', () => {
  const success = (name: string) =>
    QuoroomRpcs.requests.get(name)!.successSchema as Schema.Top
  const top = (name: string) => structsOf(success(name))[0]!

  it('an invitation has one shape: the caller\'s name, and a link only for a new account', () => {
    const invite = top('InviteToUnit')
    expect(invite.propertySignatures.map(p => String(p.name)).sort()).toEqual(['account', 'link'])
    expect(propertyOf(invite, 'link')!.type.context?.isOptional).toBe(true)
    const account = structsOfAst(propertyOf(invite, 'account')!.type)[0]!
    expect(account.propertySignatures.map(p => String(p.name)).sort()).toEqual(['id', 'name'])
  })

  it('has nothing that says whether the email had an account', () => {
    for (const name of ['InviteToUnit', 'AddReviewer']) {
      const found = fieldNames(success(name))
      for (const field of ['existing', 'active', 'passwordSetAt', 'grants']) {
        expect(found.has(field), `${name} carries ${field}`).toBe(false)
      }
    }
  })

  it('AddReviewer returns what the caller supplied, and nothing stored', () => {
    const added = top('AddReviewer')
    const payload = fieldNames(QuoroomRpcs.requests.get('AddReviewer')!.payloadSchema as Schema.Top)
    const returned = added.propertySignatures.map(p => String(p.name))
    for (const field of returned) {
      expect(['accountId', 'link', ...payload].includes(field), field).toBe(true)
    }
    expect(returned).not.toContain('reviewer')
  })
})

describe('reviewer comments: shapes, not only names', () => {
  const comments = QuoroomRpcs.requests.get('ListReviewerComments')!
    .successSchema as Schema.Top
  const views = structsOf(comments)

  it('are an anchored view and a section note, and nothing else', () => {
    expect(views).toHaveLength(2)
    const anchors = views.map(view => describeAst(propertyOf(view, 'anchor')!.type))
    expect(anchors.some(a => a.includes('"section_note"'))).toBe(true)
    expect(anchors.some(a => a.includes('"text"') && a.includes('"section"'))).toBe(true)
  })

  it('give a redacted reader a section and redacted text, never positions', () => {
    const note = views.find(view =>
      describeAst(propertyOf(view, 'anchor')!.type).includes('"section_note"'),
    )!
    expect(describeAst(propertyOf(note, 'anchor')!.type)).toBe(
      '{kind:"section_note",quoted?:string,sectionId:string}',
    )
    // Nothing in the note points into a text: no item, entry path or offsets.
    const reachable = structsOfAst(propertyOf(note, 'anchor')!.type).flatMap(
      struct => struct.propertySignatures.map(p => String(p.name)),
    )
    for (const field of ['itemId', 'entryPath', 'from', 'to']) {
      expect(reachable.includes(field), field).toBe(false)
    }
  })

  it('have one body of one type, and a named author of type string', () => {
    for (const view of views) {
      expect(describeAst(propertyOf(view, 'body')!.type)).toBe('string')
      expect(describeAst(propertyOf(view, 'authorName')!.type)).toBe('string')
      expect(propertyOf(view, 'redactedBody')).toBeUndefined()
      expect(propertyOf(view, 'authorId')).toBeUndefined()
    }
  })

  it('the reviewer pending review and a new comment are always anchored', () => {
    for (const name of ['GetPendingReview', 'AddComment', 'UpdatePendingComment']) {
      const found = structsOf(QuoroomRpcs.requests.get(name)!.successSchema as Schema.Top)
      const all = found.flatMap(struct => [
        struct,
        ...struct.propertySignatures.flatMap(p => structsOfAst(p.type)),
      ])
      expect(
        all.some(struct => describeAst(struct).includes('section_note')),
        name,
      ).toBe(false)
    }
  })

  it('a round summary names nobody: only a status, a rule outcome, times and a flag', () => {
    const outline = QuoroomRpcs.requests.get('GetRevisionOutline')!.successSchema as Schema.Top
    const round = propertyOf(structsOf(outline)[0]!, 'round')!.type as SchemaAST.Objects
    expect(round.propertySignatures.map(p => String(p.name)).sort()).toEqual([
      'closing',
      'deadline',
      'decidedBy',
      'status',
    ])
    expect(describeAst(propertyOf(round, 'closing')!.type)).toBe('boolean')
  })
})

describe('reviewer-facing procedures', () => {
  it('are the ones the table says', () => {
    expect([...REVIEWER_PROCEDURES].sort()).toEqual(
      [
        'AddComment',
        'DeletePendingComment',
        'GetPendingReview',
        'GetRevisionOutline',
        'GetRevisionSection',
        'ListInbox',
        'ListPendingReviews',
        'ListReviewerComments',
        'SavePendingReview',
        'SendReview',
        'UpdatePendingComment',
      ].sort(),
    )
  })

  for (const name of REVIEWER_PROCEDURES) {
    const rpc = QuoroomRpcs.requests.get(name)!
    it(`${name} responses carry no author-only field`, () => {
      const found = fieldNames(rpc.successSchema as Schema.Top)
      for (const field of AUTHOR_ONLY_FIELDS) {
        expect(found.has(field), `${name} carries ${field}`).toBe(false)
      }
    })
    it(`${name} requests never let the caller choose a view`, () => {
      const found = fieldNames(rpc.payloadSchema as Schema.Top)
      for (const field of ['view', 'redacted', 'original', 'people']) {
        expect(found.has(field), `${name} accepts ${field}`).toBe(false)
      }
    })
  }

  it('reads sections as one content in the view the server chose', () => {
    const fields = fieldNames(QuoroomRpcs.requests.get('GetRevisionSection')!.successSchema as Schema.Top)
    expect(fields.has('content')).toBe(true)
    expect(fields.has('view')).toBe(true)
    // One body only on a reviewer's comment; the redacted twin is the authors'.
    const comment = fieldNames(QuoroomRpcs.requests.get('ListReviewerComments')!.successSchema as Schema.Top)
    expect(comment.has('body')).toBe(true)
    const authors = fieldNames(QuoroomRpcs.requests.get('ListRevisionComments')!.successSchema as Schema.Top)
    expect(authors.has('redactedBody')).toBe(true)
  })

  it('keep authors-only procedures out of the reviewer audience', () => {
    const authorOnly = [
      'GetWorkingCopy',
      'GetWorkingCopySection',
      'GetPeople',
      'GetDraftSection',
      'GetDraftOutline',
      'GetGrid',
      'ListDrafting',
      'ListAuditEvents',
      'ListRevisionComments',
      'GetDownloads',
    ] as const
    for (const name of authorOnly) {
      expect(PROCEDURES[name].audience, name).toBe('report_author')
    }
  })
})
