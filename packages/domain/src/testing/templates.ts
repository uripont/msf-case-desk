import fc from 'fast-check'

import {
  DRAFTING_PERMISSIONS,
  DRAFTING_REQUIRED_PERMISSIONS,
  ITEM_TYPES,
  MAX_ATLEAST_VOTERS,
  type ApprovalRule,
  type CoverPart,
  type Item,
  type NumberingLevel,
  type Permission,
  type Requirement,
  type Role,
  type Section,
  type Template,
  TEMPLATE_SCHEMA_VERSION,
} from '../template'
import {
  dateItem,
  draftingRole,
  option,
  repeatedItem,
  reviewingRole,
  richTextItem,
  section,
  selectItem,
  textItem,
} from '../template-builders'

// NOTE: Test support for every later stage: an invented template with a
// different role set, and a generator of valid templates.

// An invented panel template, neither of the two built-in ones: an observer
// who comments and does not vote, a chair with the full view and a majority
// rule, panel members who need two approvals, and no conclusion.
export const PANEL_TEMPLATE: Template = {
  schemaVersion: TEMPLATE_SCHEMA_VERSION,
  id: 'test-panel',
  version: 1,
  name: 'Panel review note',
  shortName: 'panel',
  description: 'An invented template for tests, with three reviewing roles.',
  caseReferenceLabel: 'Panel reference',
  numbering: [
    { style: 'roman', letterCase: 'lower', suffix: ')' },
    { style: 'letters', letterCase: 'lower', suffix: '.' },
  ],
  roles: [
    draftingRole('drafters', 'Drafters', [
      'edit',
      'share',
      'publish',
      'manage_people',
      'reply',
    ]),
    reviewingRole('chair', 'Chair', 'full', ['comment', 'vote'], {
      kind: 'majority',
    }),
    reviewingRole('members', 'Panel members', 'redacted', ['comment', 'vote'], {
      kind: 'at_least',
      count: 2,
    }),
    reviewingRole('observer', 'Observer', 'redacted', ['comment']),
  ],
  sections: [
    section('overview', 'Overview', [
      richTextItem('overview-text', 'Overview'),
      textItem('panel-topic', 'Topic'),
    ]),
    section(
      'items-reviewed',
      'Items reviewed',
      [
        repeatedItem(
          'finding-list',
          'Findings',
          'Finding',
          [
            textItem('finding-title', 'Title'),
            richTextItem('finding-body', 'Details', {
              requirement: 'optional',
            }),
          ],
          { min: 1 },
        ),
      ],
      {
        sections: [
          section(
            'remarks',
            'Remarks',
            [richTextItem('remarks-text', 'Remarks')],
            { requirement: 'optional' },
          ),
        ],
      },
    ),
    section(
      'outcome',
      'Outcome',
      [
        selectItem(
          'outcome-choice',
          'Outcome',
          [
            option('accept', 'Accept'),
            option('rework', 'Rework'),
            option('decline', 'Decline'),
          ],
          { multiple: false },
        ),
        dateItem('outcome-date', 'Date', { precision: 'month' }),
      ],
      { numbered: false },
    ),
  ],
  contentsDepth: 2,
  pageNumbering: 'continuous',
  furniture: { header: '{title}', footer: '{case} - {page} of {pages}' },
}

// ---- Generator of valid templates -----------------------------------------

const WORDS = [
  'review',
  'note',
  'scope',
  'facts',
  'finding',
  'summary',
  'équipe',
  'résumé',
  'naïve',
  'detail',
  'record',
  'plan',
  'basis',
  'outcome',
  'context',
  'Ödön',
]

const words = (max: number) =>
  fc
    .array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: max })
    .map(list => list.join(' '))

const optionalWords = fc.option(words(8), { nil: undefined })

const requirements: ReadonlyArray<Requirement> = [
  'required',
  'optional',
  'optional_with_reason',
]
const requirement = fc.constantFrom(...requirements)

const LEAF_TYPES: ReadonlyArray<Item['type']> = ITEM_TYPES.filter(
  type => type !== 'repeated',
)

type ItemSkeleton = Readonly<{
  type: Item['type']
  label: string
  instruction: string | undefined
  requirement: Requirement
  flag: boolean
  precision: 'day' | 'month'
  field: 'reference' | 'unit' | 'title'
  options: ReadonlyArray<Readonly<{ label: string; coded: boolean }>>
  endIndex: number | undefined
  min: number
  max: number | undefined
  items: ReadonlyArray<ItemSkeleton>
}>

const itemSkeleton = (depth: number): fc.Arbitrary<ItemSkeleton> =>
  fc.record({
    type: fc.constantFrom(...(depth > 0 ? ITEM_TYPES : LEAF_TYPES)),
    label: words(4),
    instruction: optionalWords,
    requirement,
    flag: fc.boolean(),
    precision: fc.constantFrom('day', 'month'),
    field: fc.constantFrom('reference', 'unit', 'title'),
    options: fc.array(fc.record({ label: words(3), coded: fc.boolean() }), {
      minLength: 1,
      maxLength: 4,
    }),
    endIndex: fc.option(fc.nat(3), { nil: undefined }),
    min: fc.nat(2),
    max: fc.option(fc.integer({ min: 1, max: 6 }), { nil: undefined }),
    items:
      depth > 0
        ? fc.array(itemSkeleton(depth - 1), { minLength: 1, maxLength: 3 })
        : fc.constant([]),
  })

type SectionSkeleton = Readonly<{
  title: string
  instruction: string | undefined
  requirement: Requirement
  numbered: boolean
  repeatable: boolean
  min: number
  max: number | undefined
  items: ReadonlyArray<ItemSkeleton>
  sections: ReadonlyArray<SectionSkeleton>
}>

const sectionSkeleton = (depth: number): fc.Arbitrary<SectionSkeleton> =>
  fc.record({
    title: words(4),
    instruction: optionalWords,
    requirement,
    numbered: fc.boolean(),
    repeatable: fc.boolean(),
    min: fc.nat(2),
    max: fc.option(fc.integer({ min: 1, max: 6 }), { nil: undefined }),
    items: fc.array(itemSkeleton(1), { minLength: 1, maxLength: 3 }),
    sections:
      depth > 0
        ? fc.array(sectionSkeleton(depth - 1), { maxLength: 2 })
        : fc.constant([]),
  })

type Ids = { next: number }
const nextId = (ids: Ids, prefix: string): string => `${prefix}${++ids.next}`

// A repeat range that satisfies its own requirement.
const rangeOf = (
  requirementOf: Requirement,
  min: number,
  max: number | undefined,
): { min: number; max?: number } => {
  const low = requirementOf === 'required' ? Math.max(1, min) : min
  return max === undefined
    ? { min: low }
    : { min: low, max: Math.max(max, low, 1) }
}

type Built = {
  selects: Array<string>
  ends: number
  eligible: Array<string>
  sectionIds: Array<string>
}

const buildItem = (
  sk: ItemSkeleton,
  ids: Ids,
  inRepeat: boolean,
  inBody: boolean,
  built: Built,
): Item => {
  const id = nextId(ids, 'i')
  const base = {
    id,
    label: sk.label,
    requirement: sk.requirement,
    ...(sk.instruction === undefined ? {} : { instruction: sk.instruction }),
  }
  if (!inRepeat && inBody && ['text', 'date', 'select'].includes(sk.type)) {
    built.eligible.push(id)
  }
  switch (sk.type) {
    case 'text':
      return { ...base, type: 'text' }
    case 'rich_text':
      return { ...base, type: 'rich_text' }
    case 'signature':
      return { ...base, type: 'signature' }
    case 'people':
      return { ...base, type: 'people', multiple: sk.flag }
    case 'date':
      return { ...base, type: 'date', precision: sk.precision }
    case 'case_value':
      return { ...base, type: 'case_value', field: sk.field }
    case 'select': {
      const options = sk.options.map((o, index) => ({
        id: nextId(ids, 'o'),
        label: o.label,
        ...(o.coded ? { code: `C${index + 1}` } : {}),
      }))
      const end =
        sk.endIndex !== undefined && !inRepeat && inBody
          ? options[sk.endIndex % options.length]
          : undefined
      if (end !== undefined) {
        built.ends += 1
      }
      return {
        ...base,
        type: 'select',
        multiple: sk.flag,
        options,
        ...(end === undefined ? {} : { endOptionId: end.id }),
      }
    }
    case 'repeated':
      return {
        ...base,
        type: 'repeated',
        entryLabel: sk.label,
        ...rangeOf(sk.requirement, sk.min, sk.max),
        items: sk.items.map(child =>
          buildItem(child, ids, true, inBody, built),
        ),
      }
  }
}

const buildSection = (
  sk: SectionSkeleton,
  ids: Ids,
  level: number,
  inRepeat: boolean,
  inBody: boolean,
  built: Built,
): Section => {
  const id = nextId(ids, 's')
  if (inBody) {
    built.sectionIds.push(id)
  }
  const repeats = level > 1 && sk.repeatable
  return {
    id,
    title: sk.title,
    ...(sk.instruction === undefined ? {} : { instruction: sk.instruction }),
    requirement: sk.requirement,
    frontMatter: false,
    numbered: sk.numbered,
    ...(repeats ? { repeat: rangeOf(sk.requirement, sk.min, sk.max) } : {}),
    items: sk.items.map(item =>
      buildItem(item, ids, inRepeat || repeats, inBody, built),
    ),
    sections: sk.sections.map(child =>
      buildSection(child, ids, level + 1, inRepeat || repeats, inBody, built),
    ),
  }
}

const approvalRule: fc.Arbitrary<ApprovalRule> = fc.oneof(
  fc.constant<ApprovalRule>({ kind: 'all' }),
  fc.constant<ApprovalRule>({ kind: 'majority' }),
  fc
    .integer({ min: 1, max: MAX_ATLEAST_VOTERS })
    .map((count): ApprovalRule => ({ kind: 'at_least', count })),
)

const reviewingRoleSkeleton = fc.record({
  name: words(2),
  view: fc.constantFrom<Role['view']>('full', 'redacted'),
  comment: fc.boolean(),
  vote: fc.boolean(),
  rule: approvalRule,
})

const numberingLevel: fc.Arbitrary<NumberingLevel> = fc.oneof(
  fc
    .constantFrom<'.' | ')' | ''>('.', ')', '')
    .map((suffix): NumberingLevel => ({ style: 'arabic', suffix })),
  // NOTE: fast-check records have no prototype; plain objects compare strictly.
  fc
    .record({
      style: fc.constantFrom<'roman' | 'letters'>('roman', 'letters'),
      letterCase: fc.constantFrom<'upper' | 'lower'>('upper', 'lower'),
      suffix: fc.constantFrom<'.' | ')' | ''>('.', ')', ''),
    })
    .map((level): NumberingLevel => ({ ...level })),
)

const furnitureText = fc
  .array(
    fc.constantFrom(
      '{page}',
      '{pages}',
      '{case}',
      '{title}',
      'Confidential',
      'draft',
    ),
    { minLength: 1, maxLength: 4 },
  )
  .map(list => list.join(' '))

const coverPartSkeleton = fc.record({
  kind: fc.constantFrom<CoverPart['kind']>('text', 'item', 'case_value'),
  text: words(3),
  field: fc.constantFrom<'reference' | 'unit' | 'title'>(
    'reference',
    'unit',
    'title',
  ),
  pick: fc.nat(1000),
})

const skeletonOf = fc.record({
  id: fc.nat(9999),
  version: fc.integer({ min: 1, max: 20 }),
  name: words(4),
  shortName: fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/),
  description: optionalWords,
  caseReferenceLabel: words(3),
  numbering: fc.array(numberingLevel, { minLength: 4, maxLength: 5 }),
  draftingExtras: fc.subarray(
    DRAFTING_PERMISSIONS.filter(
      p => !DRAFTING_REQUIRED_PERMISSIONS.includes(p),
    ) as Array<Permission>,
  ),
  firstReviewer: reviewingRoleSkeleton,
  moreReviewers: fc.array(reviewingRoleSkeleton, { maxLength: 2 }),
  sections: fc.array(sectionSkeleton(2), { minLength: 1, maxLength: 4 }),
  conclusion: fc.option(sectionSkeleton(0), { nil: undefined }),
  frontCount: fc.nat(3),
  restart: fc.boolean(),
  endingText: words(8),
  staysPicks: fc.array(fc.nat(1000), { maxLength: 3 }),
  cover: fc.option(
    fc.array(
      fc.record({
        emphasis: fc.constantFrom<'title' | 'subtitle' | 'normal'>(
          'title',
          'subtitle',
          'normal',
        ),
        parts: fc.array(coverPartSkeleton, { minLength: 1, maxLength: 3 }),
      }),
      { minLength: 1, maxLength: 3 },
    ),
    { nil: undefined },
  ),
  contentsDepth: fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }),
  furniture: fc.record({
    header: fc.option(furnitureText, { nil: undefined }),
    footer: fc.option(furnitureText, { nil: undefined }),
    coverHeader: fc.option(furnitureText, { nil: undefined }),
    coverFooter: fc.option(furnitureText, { nil: undefined }),
  }),
})

// A valid template, by construction: the generator makes the roles, ranges,
// end answers, front matter and cover agree with the validation rules, so a
// failing property points at the code, not at the generator.
export const validTemplateArbitrary: fc.Arbitrary<Template> = skeletonOf.map(
  sk => {
    const ids: Ids = { next: 0 }
    const built: Built = { selects: [], ends: 0, eligible: [], sectionIds: [] }
    const sections = sk.sections.map((s, index) => ({
      ...buildSection(s, ids, 1, false, true, built),
      frontMatter: index < Math.min(sk.frontCount, sk.sections.length - 1),
    }))
    const frontCount = sections.filter(s => s.frontMatter).length
    const conclusion =
      sk.conclusion === undefined
        ? undefined
        : buildSection(sk.conclusion, ids, 1, false, false, built)

    const drafting = draftingRole('authors', 'Authors', [
      ...DRAFTING_REQUIRED_PERMISSIONS,
      ...sk.draftingExtras.filter(p => p !== 'write_conclusion'),
      ...(conclusion !== undefined ||
      sk.draftingExtras.includes('write_conclusion')
        ? (['write_conclusion'] as const)
        : []),
    ])
    const reviewers = [sk.firstReviewer, ...sk.moreReviewers].map(
      (r, index): Role => {
        const votes = index === 0 || r.vote
        const permissions: Array<Permission> = [
          ...(r.comment ? (['comment'] as const) : []),
          ...(votes ? (['vote'] as const) : []),
        ]
        return reviewingRole(
          `reviewer-${index + 1}`,
          r.name,
          r.view,
          permissions,
          votes ? r.rule : undefined,
        )
      },
    )

    const eligible = built.eligible
    const cover = sk.cover?.map(line => ({
      emphasis: line.emphasis,
      parts: line.parts.map((part): CoverPart => {
        if (part.kind === 'item' && eligible.length > 0) {
          return {
            kind: 'item',
            itemId: eligible[part.pick % eligible.length] ?? '',
          }
        }
        return part.kind === 'case_value'
          ? { kind: 'case_value', field: part.field }
          : { kind: 'text', text: part.text }
      }),
    }))

    return {
      schemaVersion: TEMPLATE_SCHEMA_VERSION,
      id: `tpl-${sk.id}`,
      version: sk.version,
      name: sk.name,
      shortName: sk.shortName,
      ...(sk.description === undefined ? {} : { description: sk.description }),
      caseReferenceLabel: sk.caseReferenceLabel,
      numbering: sk.numbering,
      roles: [drafting, ...reviewers],
      sections,
      ...(conclusion === undefined ? {} : { conclusion }),
      ...(built.ends > 0
        ? {
            ending: {
              outcomeText: sk.endingText,
              staysInForce: [
                ...new Set(
                  sk.staysPicks.map(
                    pick =>
                      built.sectionIds[pick % built.sectionIds.length] ?? '',
                  ),
                ),
              ],
            },
          }
        : {}),
      ...(cover === undefined ? {} : { cover: { lines: cover } }),
      ...(sk.contentsDepth === undefined
        ? {}
        : { contentsDepth: sk.contentsDepth }),
      pageNumbering:
        sk.restart && frontCount > 0
          ? 'restart_after_front_matter'
          : 'continuous',
      furniture: {
        ...(sk.furniture.header === undefined
          ? {}
          : { header: sk.furniture.header }),
        ...(sk.furniture.footer === undefined
          ? {}
          : { footer: sk.furniture.footer }),
        ...(sk.furniture.coverHeader === undefined
          ? {}
          : { coverHeader: sk.furniture.coverHeader }),
        ...(sk.furniture.coverFooter === undefined
          ? {}
          : { coverFooter: sk.furniture.coverFooter }),
      },
    }
  },
)
