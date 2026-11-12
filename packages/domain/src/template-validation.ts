import { Result, Schema, SchemaIssue } from 'effect'

import {
  DRAFTING_PERMISSIONS,
  DRAFTING_REQUIRED_PERMISSIONS,
  MAX_ATLEAST_VOTERS,
  MAX_SECTION_DEPTH,
  PAGE_TOKENS,
  REVIEWING_PERMISSIONS,
  type Permission,
  type Role,
  Template,
  type TemplateNode,
  templateNodes,
} from './template'

export type TemplateProblemCode =
  | 'schema'
  | 'duplicate-id'
  | 'duplicate-option-id'
  | 'duplicate-option-code'
  | 'no-drafting-role'
  | 'several-drafting-roles'
  | 'drafting-view-not-full'
  | 'drafting-permission-missing'
  | 'permission-not-allowed'
  | 'conclusion-permission-missing'
  | 'vote-without-rule'
  | 'rule-without-vote'
  | 'rule-cannot-be-met'
  | 'no-voting-role'
  | 'numbering-invalid'
  | 'numbering-level-missing'
  | 'section-too-deep'
  | 'empty-section'
  | 'repeat-invalid'
  | 'repeat-on-top-level'
  | 'front-matter-invalid'
  | 'page-restart-without-front-matter'
  | 'select-without-options'
  | 'unknown-option'
  | 'end-answer-misplaced'
  | 'ending-missing'
  | 'ending-unreachable'
  | 'unknown-section'
  | 'unknown-item'
  | 'cover-item-misplaced'
  | 'unknown-token'
  | 'form-invalid'

export type TemplateProblem = Readonly<{
  code: TemplateProblemCode
  path: ReadonlyArray<string | number>
  message: string
}>

const problem = (
  code: TemplateProblemCode,
  path: ReadonlyArray<string | number>,
  message: string,
): TemplateProblem => ({ code, path, message })

const duplicatesOf = <A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
): ReadonlyArray<readonly [A, number]> => {
  const seen = new Set<string>()
  const out: Array<readonly [A, number]> = []
  values.forEach((value, index) => {
    const k = key(value)
    if (seen.has(k)) {
      out.push([value, index])
    }
    seen.add(k)
  })
  return out
}

const idProblems = (
  nodes: ReadonlyArray<TemplateNode>,
): ReadonlyArray<TemplateProblem> => {
  const duplicates = duplicatesOf(nodes, ({ node }) => node.id).map(
    ([{ node, path }]) =>
      problem(
        'duplicate-id',
        path,
        `The ID "${node.id}" is used more than once`,
      ),
  )
  const options = nodes.flatMap(({ node, path }) =>
    'type' in node && node.type === 'select' ? selectProblems(node, path) : [],
  )
  return [...duplicates, ...options]
}

const selectProblems = (
  item: Extract<TemplateNode['node'], { type: 'select' }>,
  path: ReadonlyArray<string | number>,
): ReadonlyArray<TemplateProblem> => [
  ...(item.options.length === 0
    ? [
        problem(
          'select-without-options',
          [...path, 'options'],
          `The select "${item.id}" has no options`,
        ),
      ]
    : []),
  ...duplicatesOf(item.options, option => option.id).map(([option, index]) =>
    problem(
      'duplicate-option-id',
      [...path, 'options', index, 'id'],
      `The option ID "${option.id}" is used twice in "${item.id}"`,
    ),
  ),
  ...duplicatesOf(
    item.options.filter(option => option.code !== undefined),
    option => option.code ?? '',
  ).map(([option]) =>
    problem(
      'duplicate-option-code',
      [...path, 'options'],
      `The option code "${option.code}" is used twice in "${item.id}"`,
    ),
  ),
  ...(item.endOptionId !== undefined &&
  !item.options.some(option => option.id === item.endOptionId)
    ? [
        problem(
          'unknown-option',
          [...path, 'endOptionId'],
          `The end answer "${item.endOptionId}" is not an option of "${item.id}"`,
        ),
      ]
    : []),
]

const roleProblems = (template: Template): ReadonlyArray<TemplateProblem> => {
  const out: Array<TemplateProblem> = []
  duplicatesOf(template.roles, role => role.id).forEach(([role, index]) =>
    out.push(
      problem(
        'duplicate-id',
        ['roles', index, 'id'],
        `The role ID "${role.id}" is used more than once`,
      ),
    ),
  )
  const drafting = template.roles
    .map((role, index) => [role, index] as const)
    .filter(([role]) => role.kind === 'drafting')
  if (drafting.length === 0) {
    out.push(
      problem(
        'no-drafting-role',
        ['roles'],
        'A template needs one drafting role',
      ),
    )
  }
  drafting
    .slice(1)
    .forEach(([role, index]) =>
      out.push(
        problem(
          'several-drafting-roles',
          ['roles', index],
          `The role "${role.id}" is a second drafting role; there is exactly one`,
        ),
      ),
    )
  template.roles.forEach((role, index) =>
    out.push(...onePermissionSet(template, role, ['roles', index])),
  )
  const voters = template.roles.filter(role =>
    role.permissions.includes('vote'),
  )
  if (voters.length === 0) {
    out.push(
      problem(
        'no-voting-role',
        ['roles'],
        'No role can vote, so no round could ever meet its approval rule',
      ),
    )
  }
  return out
}

const onePermissionSet = (
  template: Template,
  role: Role,
  path: ReadonlyArray<string | number>,
): ReadonlyArray<TemplateProblem> => {
  const out: Array<TemplateProblem> = []
  const has = (permission: Permission) => role.permissions.includes(permission)
  const allowed =
    role.kind === 'drafting' ? DRAFTING_PERMISSIONS : REVIEWING_PERMISSIONS
  duplicatesOf(role.permissions, permission => permission).forEach(
    ([permission]) =>
      out.push(
        problem(
          'permission-not-allowed',
          [...path, 'permissions'],
          `The permission "${permission}" is listed twice for "${role.id}"`,
        ),
      ),
  )
  role.permissions
    .filter(permission => !allowed.includes(permission))
    .forEach(permission =>
      out.push(
        problem(
          'permission-not-allowed',
          [...path, 'permissions'],
          `A ${role.kind} role cannot have the permission "${permission}"`,
        ),
      ),
    )
  if (role.kind === 'drafting') {
    if (role.view !== 'full') {
      out.push(
        problem(
          'drafting-view-not-full',
          [...path, 'view'],
          `The drafting role "${role.id}" must have the full view`,
        ),
      )
    }
    DRAFTING_REQUIRED_PERMISSIONS.filter(
      permission => !has(permission),
    ).forEach(permission =>
      out.push(
        problem(
          'drafting-permission-missing',
          [...path, 'permissions'],
          `The drafting role "${role.id}" must have the permission "${permission}"`,
        ),
      ),
    )
    if (template.conclusion !== undefined && !has('write_conclusion')) {
      out.push(
        problem(
          'conclusion-permission-missing',
          [...path, 'permissions'],
          `The template has a conclusion, so "${role.id}" must be able to write it`,
        ),
      )
    }
    if (role.approval !== undefined) {
      out.push(
        problem(
          'rule-without-vote',
          [...path, 'approval'],
          `The drafting role "${role.id}" does not vote, so it has no approval rule`,
        ),
      )
    }
    return out
  }
  if (has('vote') && role.approval === undefined) {
    out.push(
      problem(
        'vote-without-rule',
        [...path, 'approval'],
        `The role "${role.id}" votes, so it needs an approval rule`,
      ),
    )
  }
  if (!has('vote') && role.approval !== undefined) {
    out.push(
      problem(
        'rule-without-vote',
        [...path, 'approval'],
        `The role "${role.id}" does not vote, so its approval rule could never be met`,
      ),
    )
  }
  if (
    role.approval?.kind === 'at_least' &&
    (role.approval.count < 1 || role.approval.count > MAX_ATLEAST_VOTERS)
  ) {
    out.push(
      problem(
        'rule-cannot-be-met',
        [...path, 'approval', 'count'],
        `"At least ${role.approval.count}" cannot be met by construction; use 1 to ${MAX_ATLEAST_VOTERS}`,
      ),
    )
  }
  return out
}

const numberingProblems = (
  template: Template,
  nodes: ReadonlyArray<TemplateNode>,
): ReadonlyArray<TemplateProblem> => {
  const out: Array<TemplateProblem> = []
  if (template.numbering.length > MAX_SECTION_DEPTH) {
    out.push(
      problem(
        'numbering-invalid',
        ['numbering'],
        `At most ${MAX_SECTION_DEPTH} numbering levels are allowed`,
      ),
    )
  }
  template.numbering.forEach((level, index) => {
    if (level.style === 'arabic' && level.letterCase !== undefined) {
      out.push(
        problem(
          'numbering-invalid',
          ['numbering', index, 'letterCase'],
          `Level ${index + 1} is arabic, which has no upper or lower case`,
        ),
      )
    }
    if (level.style !== 'arabic' && level.letterCase === undefined) {
      out.push(
        problem(
          'numbering-invalid',
          ['numbering', index, 'letterCase'],
          `Level ${index + 1} is ${level.style}, so it needs upper or lower case`,
        ),
      )
    }
  })
  const numbered = nodes.filter(
    ({ node, kind }) =>
      kind === 'section' && 'numbered' in node && node.numbered,
  )
  const deepest = numbered.reduce((max, { depth }) => Math.max(max, depth), 0)
  const missing = numbered.find(
    ({ depth }) => depth > template.numbering.length,
  )
  if (missing !== undefined) {
    out.push(
      problem(
        'numbering-level-missing',
        missing.path,
        `A numbered section at level ${deepest} needs ${deepest} numbering levels, and the template has ${template.numbering.length}`,
      ),
    )
  }
  return out
}

const structureProblems = (
  template: Template,
  nodes: ReadonlyArray<TemplateNode>,
): ReadonlyArray<TemplateProblem> => {
  const out: Array<TemplateProblem> = []
  const checkRange = (
    id: string,
    requirement: string,
    range: { min: number; max?: number } | undefined,
    path: ReadonlyArray<string | number>,
  ) => {
    if (range === undefined) {
      return
    }
    if (range.max !== undefined && range.max < range.min) {
      out.push(
        problem(
          'repeat-invalid',
          path,
          `"${id}" allows at most ${range.max} entries but needs at least ${range.min}`,
        ),
      )
    }
    if (range.max === 0) {
      out.push(
        problem('repeat-invalid', path, `"${id}" allows no entry at all`),
      )
    }
    if (requirement === 'required' && range.min < 1) {
      out.push(
        problem(
          'repeat-invalid',
          path,
          `"${id}" is required but can have no entry; a required repeat needs a minimum of 1`,
        ),
      )
    }
  }
  nodes.forEach(({ node, kind, path, depth }) => {
    if (kind === 'section' && 'sections' in node) {
      if (depth > MAX_SECTION_DEPTH) {
        out.push(
          problem(
            'section-too-deep',
            path,
            `The section "${node.id}" is nested deeper than ${MAX_SECTION_DEPTH} levels`,
          ),
        )
      }
      if (node.items.length === 0 && node.sections.length === 0) {
        out.push(
          problem('empty-section', path, `The section "${node.id}" is empty`),
        )
      }
      if (node.repeat !== undefined && depth === 1) {
        out.push(
          problem(
            'repeat-on-top-level',
            [...path, 'repeat'],
            `The top-level section "${node.id}" cannot repeat; only subsections can`,
          ),
        )
      }
      checkRange(node.id, node.requirement, node.repeat, [...path, 'repeat'])
    }
    if (kind === 'item' && 'type' in node && node.type === 'repeated') {
      if (node.items.length === 0) {
        out.push(
          problem(
            'empty-section',
            path,
            `The repeated entry "${node.id}" holds no item`,
          ),
        )
      }
      checkRange(node.id, node.requirement, node, path)
    }
  })
  return out
}

const frontMatterProblems = (
  template: Template,
  nodes: ReadonlyArray<TemplateNode>,
): ReadonlyArray<TemplateProblem> => {
  const out: Array<TemplateProblem> = []
  nodes.forEach(({ node, kind, path, depth }) => {
    if (
      kind === 'section' &&
      'frontMatter' in node &&
      node.frontMatter &&
      (depth > 1 || path[0] === 'conclusion')
    ) {
      out.push(
        problem(
          'front-matter-invalid',
          [...path, 'frontMatter'],
          `Only top-level sections of the body can be front matter, not "${node.id}"`,
        ),
      )
    }
  })
  const flags = template.sections.map(section => section.frontMatter)
  const firstBody = flags.indexOf(false)
  if (firstBody >= 0 && flags.indexOf(true, firstBody) >= 0) {
    out.push(
      problem(
        'front-matter-invalid',
        ['sections', flags.indexOf(true, firstBody), 'frontMatter'],
        'Front matter sections must come before every other section',
      ),
    )
  }
  if (
    template.pageNumbering === 'restart_after_front_matter' &&
    !flags.includes(true)
  ) {
    out.push(
      problem(
        'page-restart-without-front-matter',
        ['pageNumbering'],
        'Page numbers restart after the front matter, but no section is front matter',
      ),
    )
  }
  return out
}

const branchingProblems = (
  template: Template,
  nodes: ReadonlyArray<TemplateNode>,
): ReadonlyArray<TemplateProblem> => {
  const out: Array<TemplateProblem> = []
  const enders = nodes.filter(
    ({ node }) =>
      'type' in node &&
      node.type === 'select' &&
      node.endOptionId !== undefined,
  )
  enders.forEach(({ node, path, repeated }) => {
    if (repeated || path[0] === 'conclusion') {
      out.push(
        problem(
          'end-answer-misplaced',
          [...path, 'endOptionId'],
          `The end answer of "${node.id}" must be in a fixed item of the body, not in a repeat or the conclusion`,
        ),
      )
    }
  })
  const ending = template.ending
  if (enders.length > 0 && ending === undefined) {
    out.push(
      problem(
        'ending-missing',
        ['ending'],
        'A select has an end answer, so the template needs an ending with its outcome text',
      ),
    )
  }
  if (enders.length === 0 && ending !== undefined) {
    out.push(
      problem(
        'ending-unreachable',
        ['ending'],
        'The template has an ending, but no select has an end answer',
      ),
    )
  }
  const bodySections = new Set(
    nodes
      .filter(({ kind, path }) => kind === 'section' && path[0] === 'sections')
      .map(({ node }) => node.id),
  )
  ending?.staysInForce.forEach((id, index) => {
    if (!bodySections.has(id)) {
      out.push(
        problem(
          'unknown-section',
          ['ending', 'staysInForce', index],
          `The ending keeps "${id}" in force, but there is no such section in the body`,
        ),
      )
    }
  })
  return out
}

const coverProblems = (
  template: Template,
  nodes: ReadonlyArray<TemplateNode>,
): ReadonlyArray<TemplateProblem> => {
  const out: Array<TemplateProblem> = []
  const items = new Map(
    nodes
      .filter(({ kind }) => kind === 'item')
      .map(entry => [entry.node.id, entry]),
  )
  template.cover?.lines.forEach((line, lineIndex) =>
    line.parts.forEach((part, partIndex) => {
      if (part.kind !== 'item') {
        return
      }
      const path = ['cover', 'lines', lineIndex, 'parts', partIndex, 'itemId']
      const found = items.get(part.itemId)
      if (found === undefined) {
        out.push(
          problem(
            'unknown-item',
            path,
            `The cover uses "${part.itemId}", but there is no such item`,
          ),
        )
        return
      }
      const type = 'type' in found.node ? found.node.type : ''
      if (
        found.repeated ||
        found.path[0] === 'conclusion' ||
        !['text', 'date', 'select'].includes(type)
      ) {
        out.push(
          problem(
            'cover-item-misplaced',
            path,
            `The cover can only show a text, date or select item of the body that is not repeated, not "${part.itemId}"`,
          ),
        )
      }
    }),
  )
  return out
}

const furnitureProblems = (
  template: Template,
): ReadonlyArray<TemplateProblem> =>
  Object.entries(template.furniture).flatMap(([key, text]) =>
    (text.match(/\{[^{}]*\}/g) ?? [])
      .filter(token => !(PAGE_TOKENS as ReadonlyArray<string>).includes(token))
      .map(token =>
        problem(
          'unknown-token',
          ['furniture', key],
          `The token ${token} is unknown; use ${PAGE_TOKENS.join(', ')}`,
        ),
      ),
  )

// NOTE: The checks that a structure alone cannot express. They assume the
// template already has the right shape.
export const templateProblems = (
  template: Template,
): ReadonlyArray<TemplateProblem> => {
  const nodes = templateNodes(template)
  return [
    ...idProblems(nodes),
    ...roleProblems(template),
    ...numberingProblems(template, nodes),
    ...structureProblems(template, nodes),
    ...frontMatterProblems(template, nodes),
    ...branchingProblems(template, nodes),
    ...coverProblems(template, nodes),
    ...furnitureProblems(template),
  ]
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

const decodeShape = Schema.decodeUnknownResult(Template)

// NOTE: Decodes unknown data as a template and checks it all, returning every
// problem found, each with the path of the element it is about.
export const validateTemplate = (
  input: unknown,
): Result.Result<Template, ReadonlyArray<TemplateProblem>> => {
  const decoded = decodeShape(input, { errors: 'all' })
  if (Result.isFailure(decoded)) {
    const result = formatIssues(decoded.failure.issue)
    return Result.fail(
      ('issues' in result ? result.issues : []).map(issue =>
        problem(
          'schema',
          (issue.path ?? []).map(key =>
            typeof key === 'object'
              ? (key.key as string | number)
              : (key as string | number),
          ),
          issue.message,
        ),
      ),
    )
  }
  const problems = templateProblems(decoded.success)
  return problems.length === 0
    ? Result.succeed(decoded.success)
    : Result.fail(problems)
}
