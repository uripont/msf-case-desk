import { Result } from 'effect'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import {
  BUILT_IN_TEMPLATES,
  DRAFTING_REQUIRED_PERMISSIONS,
  INTAKE_TEMPLATE,
  INVESTIGATION_TEMPLATE,
  type Role,
  type Template,
  type TemplateProblemCode,
  TEMPLATE_SCHEMA_VERSION,
  draftingRoleOf,
  templateFromForm,
  templateNodes,
  templateToForm,
  validateTemplate,
} from './index'
import { PANEL_TEMPLATE, validTemplateArbitrary } from './testing/templates'

const ALL_TEMPLATES: ReadonlyArray<Template> = [
  ...BUILT_IN_TEMPLATES,
  PANEL_TEMPLATE,
]

const codesOf = (input: unknown): ReadonlyArray<TemplateProblemCode> => {
  const result = validateTemplate(input)
  return Result.isFailure(result) ? result.failure.map(p => p.code) : []
}

const problemsOf = (input: unknown) => {
  const result = validateTemplate(input)
  return Result.isFailure(result) ? result.failure : []
}

const mapRoles = (
  template: Template,
  change: (role: Role) => Role,
): Template => ({ ...template, roles: template.roles.map(change) })

describe('template validation accepts', () => {
  test.each(ALL_TEMPLATES.map(t => [t.id, t] as const))(
    '%s',
    (_id, template) => {
      const result = validateTemplate(template)
      expect(Result.isSuccess(result)).toBe(true)
      expect(Result.getOrThrow(result)).toStrictEqual(template)
    },
  )

  test.each(ALL_TEMPLATES.map(t => [t.id, t] as const))(
    '%s after it was stored as JSON',
    (_id, template) => {
      const stored: unknown = JSON.parse(JSON.stringify(template))
      expect(Result.getOrThrow(validateTemplate(stored))).toStrictEqual(
        template,
      )
    },
  )

  test('the built-in templates have the shapes the inventory describes', () => {
    expect(INTAKE_TEMPLATE.conclusion?.id).toBe('committee-conclusion')
    expect(INVESTIGATION_TEMPLATE.conclusion).toBeUndefined()
    expect(INTAKE_TEMPLATE.ending?.staysInForce).toEqual(['sign-off'])
    expect(INVESTIGATION_TEMPLATE.numbering).toHaveLength(4)
    expect(INVESTIGATION_TEMPLATE.contentsDepth).toBe(3)
    const frontMatter = INVESTIGATION_TEMPLATE.sections.filter(
      s => s.frontMatter,
    )
    expect(frontMatter.map(s => s.id)).toEqual([
      'report-details',
      'executive-summary',
    ])
    expect(PANEL_TEMPLATE.conclusion).toBeUndefined()
    expect(PANEL_TEMPLATE.roles.map(r => r.id)).toEqual([
      'drafters',
      'chair',
      'members',
      'observer',
    ])
  })

  test('every ID in a template is unique and every end answer is an option', () => {
    ALL_TEMPLATES.forEach(template => {
      const ids = templateNodes(template).map(({ node }) => node.id)
      expect(new Set(ids).size).toBe(ids.length)
    })
  })
})

describe('template validation refuses', () => {
  test('data that is not a template, with the path of each fault', () => {
    expect(codesOf(null)).toEqual(['schema'])
    const bad = {
      ...INTAKE_TEMPLATE,
      schemaVersion: 2,
      id: '',
      shortName: 'Has Space',
    }
    const paths = problemsOf(bad).map(p => p.path.join('.'))
    expect(paths).toEqual(
      expect.arrayContaining(['schemaVersion', 'id', 'shortName']),
    )
    expect(TEMPLATE_SCHEMA_VERSION).toBe(1)
  })

  test('an ID used twice, among sections and items', () => {
    const first = INTAKE_TEMPLATE.sections[0]
    const second = INTAKE_TEMPLATE.sections[1]
    if (first === undefined || second === undefined) throw new Error('fixture')
    const template: Template = {
      ...INTAKE_TEMPLATE,
      sections: [
        first,
        { ...second, id: first.id },
        ...INTAKE_TEMPLATE.sections.slice(2),
      ],
    }
    const found = problemsOf(template).filter(p => p.code === 'duplicate-id')
    expect(found).toHaveLength(1)
    expect(found[0]?.path).toEqual(['sections', 1])
    expect(found[0]?.message).toContain(first.id)
  })

  test('an item whose ID is a section ID, and a duplicate role ID', () => {
    const [authors, committee] = INTAKE_TEMPLATE.roles
    if (authors === undefined || committee === undefined)
      throw new Error('fixture')
    expect(
      codesOf({
        ...INTAKE_TEMPLATE,
        roles: [authors, { ...committee, id: authors.id }],
      }),
    ).toContain('duplicate-id')
    const nodes = templateNodes(INTAKE_TEMPLATE)
    const item = nodes.find(n => n.kind === 'item')
    expect(item).toBeDefined()
    const renamed = JSON.parse(
      JSON.stringify(INTAKE_TEMPLATE).replace(
        `"id":"${item?.node.id}"`,
        '"id":"summary"',
      ),
    ) as unknown
    expect(codesOf(renamed)).toContain('duplicate-id')
  })

  test('duplicate option IDs and codes in a select, and a select without options', () => {
    const recommendation = JSON.stringify(INTAKE_TEMPLATE)
    const sameId = recommendation.replace(
      '"id":"close","label":"Close after',
      '"id":"investigate","label":"Close after',
    )
    expect(codesOf(JSON.parse(sameId))).toContain('duplicate-option-id')
    const sameCode = recommendation.replace('"code":"B"', '"code":"A"')
    expect(codesOf(JSON.parse(sameCode))).toContain('duplicate-option-code')
    const noOptions = JSON.stringify(PANEL_TEMPLATE).replace(
      /"options":\[[^\]]*\]/,
      '"options":[]',
    )
    expect(codesOf(JSON.parse(noOptions))).toContain('select-without-options')
  })

  test('no drafting role, two drafting roles, and a drafting role without full view', () => {
    const reviewing = INTAKE_TEMPLATE.roles.filter(r => r.kind === 'reviewing')
    expect(codesOf({ ...INTAKE_TEMPLATE, roles: reviewing })).toContain(
      'no-drafting-role',
    )
    const authors = draftingRoleOf(INTAKE_TEMPLATE)
    if (authors === undefined) throw new Error('fixture')
    expect(
      codesOf({
        ...INTAKE_TEMPLATE,
        roles: [...INTAKE_TEMPLATE.roles, { ...authors, id: 'second' }],
      }),
    ).toContain('several-drafting-roles')
    expect(
      codesOf(
        mapRoles(INTAKE_TEMPLATE, r =>
          r.kind === 'drafting' ? { ...r, view: 'redacted' } : r,
        ),
      ),
    ).toContain('drafting-view-not-full')
  })

  test.each(DRAFTING_REQUIRED_PERMISSIONS.map(p => [p] as const))(
    'a drafting role without the permission %s',
    permission => {
      const template = mapRoles(INTAKE_TEMPLATE, r =>
        r.kind === 'drafting'
          ? { ...r, permissions: r.permissions.filter(p => p !== permission) }
          : r,
      )
      const found = problemsOf(template).filter(
        p => p.code === 'drafting-permission-missing',
      )
      expect(found).toHaveLength(1)
      expect(found[0]?.message).toContain(permission)
    },
  )

  test('a conclusion nobody may write, and permissions a role cannot have', () => {
    const template = mapRoles(INTAKE_TEMPLATE, r =>
      r.kind === 'drafting'
        ? {
            ...r,
            permissions: r.permissions.filter(p => p !== 'write_conclusion'),
          }
        : r,
    )
    expect(codesOf(template)).toEqual(['conclusion-permission-missing'])
    expect(
      codesOf(
        mapRoles(INTAKE_TEMPLATE, r =>
          r.kind === 'reviewing'
            ? { ...r, permissions: ['comment', 'vote', 'publish'] }
            : r,
        ),
      ),
    ).toContain('permission-not-allowed')
    expect(
      codesOf(
        mapRoles(INTAKE_TEMPLATE, r =>
          r.kind === 'drafting'
            ? { ...r, permissions: [...r.permissions, 'vote'] }
            : r,
        ),
      ),
    ).toContain('permission-not-allowed')
  })

  test('approval rules that cannot be met by construction', () => {
    const withRule = (approval: NonNullable<Role['approval']>) =>
      mapRoles(INTAKE_TEMPLATE, r =>
        r.kind === 'reviewing'
          ? {
              ...r,
              approval,
            }
          : r,
      )
    expect(codesOf(withRule({ kind: 'at_least', count: 0 }))).toEqual([
      'rule-cannot-be-met',
    ])
    expect(codesOf(withRule({ kind: 'at_least', count: 51 }))).toEqual([
      'rule-cannot-be-met',
    ])
    expect(codesOf(withRule({ kind: 'at_least', count: 3 }))).toEqual([])
    // A voting role without a rule, and a rule on a role that does not vote.
    const noRule = {
      ...INTAKE_TEMPLATE,
      roles: INTAKE_TEMPLATE.roles.map(({ approval: _drop, ...r }) => r),
    } as unknown
    expect(codesOf(noRule)).toContain('vote-without-rule')
    expect(
      codesOf(
        mapRoles(INTAKE_TEMPLATE, r =>
          r.kind === 'reviewing' ? { ...r, permissions: ['comment'] } : r,
        ),
      ),
    ).toEqual(expect.arrayContaining(['rule-without-vote', 'no-voting-role']))
  })

  test('branches that point to unknown sections or options', () => {
    expect(
      codesOf({
        ...INTAKE_TEMPLATE,
        ending: {
          outcomeText: 'Ended.',
          staysInForce: ['sign-off', 'nowhere'],
        },
      }),
    ).toEqual(['unknown-section'])
    // The conclusion is not part of the body, so an ending cannot keep it.
    expect(
      codesOf({
        ...INTAKE_TEMPLATE,
        ending: {
          outcomeText: 'Ended.',
          staysInForce: ['committee-conclusion'],
        },
      }),
    ).toEqual(['unknown-section'])
    const unknownOption = JSON.stringify(INTAKE_TEMPLATE).replace(
      '"endOptionId":"no"',
      '"endOptionId":"maybe"',
    )
    expect(codesOf(JSON.parse(unknownOption))).toContain('unknown-option')
  })

  test('an end answer without an ending, and an ending nothing can trigger', () => {
    const { ending: _ending, ...withoutEnding } = INTAKE_TEMPLATE
    expect(codesOf(withoutEnding)).toEqual(['ending-missing'])
    expect(
      codesOf({
        ...INVESTIGATION_TEMPLATE,
        ending: { outcomeText: 'Ended.', staysInForce: [] },
      }),
    ).toEqual(['ending-unreachable'])
  })

  test('an end answer inside a repeated entry', () => {
    const endInRepeat = JSON.stringify(INTAKE_TEMPLATE).replace(
      '"type":"select","multiple":false,"options":[{"id":"investigate","label":"Investigate","code":"A"}',
      '"type":"select","multiple":false,"endOptionId":"investigate","options":[{"id":"investigate","label":"Investigate","code":"A"}',
    )
    expect(codesOf(JSON.parse(endInRepeat))).toContain('end-answer-misplaced')
  })

  test('invalid numbering configuration', () => {
    const level = (extra: object) => ({
      ...INVESTIGATION_TEMPLATE,
      numbering: [extra, ...INVESTIGATION_TEMPLATE.numbering.slice(1)],
    })
    expect(
      codesOf(level({ style: 'arabic', letterCase: 'upper', suffix: '.' })),
    ).toEqual(['numbering-invalid'])
    expect(codesOf(level({ style: 'roman', suffix: '.' }))).toEqual([
      'numbering-invalid',
    ])
    expect(codesOf(level({ style: 'greek', suffix: '.' }))).toEqual(['schema'])
    expect(codesOf(level({ style: 'arabic', suffix: ':' }))).toEqual(['schema'])
    // Numbered sections down to level 3 need three levels.
    const missing = {
      ...INVESTIGATION_TEMPLATE,
      numbering: INVESTIGATION_TEMPLATE.numbering.slice(0, 2),
    }
    expect(codesOf(missing)).toEqual(['numbering-level-missing'])
    const tooMany = {
      ...INVESTIGATION_TEMPLATE,
      numbering: [
        ...INVESTIGATION_TEMPLATE.numbering,
        ...INVESTIGATION_TEMPLATE.numbering,
      ],
    }
    expect(codesOf(tooMany)).toEqual(['numbering-invalid'])
  })

  test('repeat ranges, empty sections and a repeating top-level section', () => {
    const text = JSON.stringify(INVESTIGATION_TEMPLATE)
    const maxBelowMin = text.replace(
      '"repeat":{"min":1}',
      '"repeat":{"min":3,"max":2}',
    )
    expect(codesOf(JSON.parse(maxBelowMin))).toContain('repeat-invalid')
    const requiredNoMin = text.replace(
      '"repeat":{"min":1}',
      '"repeat":{"min":0}',
    )
    expect(codesOf(JSON.parse(requiredNoMin))).toContain('repeat-invalid')
    const emptied = text.replace(
      '"items":[{"id":"introduction-text"',
      '"items":[],"x":[{"id":"introduction-text"',
    )
    expect(codesOf(JSON.parse(emptied))).toContain('empty-section')
    const topRepeat = text.replace(
      '"id":"overall-findings","title":"Overall findings"',
      '"id":"overall-findings","repeat":{"min":0},"title":"Overall findings"',
    )
    expect(codesOf(JSON.parse(topRepeat))).toContain('repeat-on-top-level')
  })

  test('front matter after the body, nested front matter, and a restart without any', () => {
    const [first, second, ...rest] = INVESTIGATION_TEMPLATE.sections
    if (first === undefined || second === undefined) throw new Error('fixture')
    expect(
      codesOf({
        ...INVESTIGATION_TEMPLATE,
        sections: [first, ...rest, second],
      }),
    ).toEqual(['front-matter-invalid'])
    const nested = {
      ...second,
      sections: second.sections.map((s, i) =>
        i === 0 ? { ...s, frontMatter: true } : s,
      ),
    }
    expect(
      codesOf({
        ...INVESTIGATION_TEMPLATE,
        sections: [first, nested, ...rest],
      }),
    ).toEqual(['front-matter-invalid'])
    expect(
      codesOf({
        ...PANEL_TEMPLATE,
        pageNumbering: 'restart_after_front_matter',
      }),
    ).toEqual(['page-restart-without-front-matter'])
  })

  test('cover lines that use unknown or repeated items, and unknown header tokens', () => {
    const cover = (itemId: string) => ({
      ...INVESTIGATION_TEMPLATE,
      cover: {
        lines: [{ emphasis: 'title', parts: [{ kind: 'item', itemId }] }],
      },
    })
    expect(codesOf(cover('missing'))).toEqual(['unknown-item'])
    expect(codesOf(cover('scope-issue'))).toEqual(['cover-item-misplaced'])
    expect(codesOf(cover('introduction-text'))).toEqual([
      'cover-item-misplaced',
    ])
    expect(
      codesOf({
        ...PANEL_TEMPLATE,
        furniture: { header: '{title} {pagenumber}' },
      }),
    ).toEqual(['unknown-token'])
  })

  test('problems carry readable messages', () => {
    problemsOf(
      mapRoles(INTAKE_TEMPLATE, r => ({ ...r, permissions: [] })),
    ).forEach(p => {
      expect(p.message.length).toBeGreaterThan(10)
    })
  })
})

describe('generated templates', () => {
  test('every generated template is valid and survives JSON', () => {
    fc.assert(
      fc.property(validTemplateArbitrary, template => {
        expect(problemsOf(template)).toEqual([])
        const stored: unknown = JSON.parse(JSON.stringify(template))
        expect(Result.getOrThrow(validateTemplate(stored))).toStrictEqual(
          template,
        )
      }),
      { numRuns: 300 },
    )
  })

  test('the generator covers conclusions, endings, front matter and covers', () => {
    const samples = fc.sample(validTemplateArbitrary, 300)
    const some = (f: (t: Template) => boolean) => samples.some(f)
    expect(some(t => t.conclusion !== undefined)).toBe(true)
    expect(some(t => t.ending !== undefined)).toBe(true)
    expect(some(t => t.sections.some(s => s.frontMatter))).toBe(true)
    expect(some(t => t.pageNumbering === 'restart_after_front_matter')).toBe(
      true,
    )
    expect(some(t => t.cover !== undefined)).toBe(true)
    expect(some(t => templateNodes(t).some(n => 'repeat' in n.node))).toBe(true)
    expect(
      some(t =>
        templateNodes(t).some(
          n => 'type' in n.node && n.node.type === 'repeated',
        ),
      ),
    ).toBe(true)
    expect(some(t => t.roles.some(r => r.approval?.kind === 'at_least'))).toBe(
      true,
    )
  })

  test('a drafting role missing any required permission is refused', () => {
    fc.assert(
      fc.property(
        validTemplateArbitrary,
        fc.subarray([...DRAFTING_REQUIRED_PERMISSIONS], { minLength: 1 }),
        (template, removed) => {
          const broken = mapRoles(template, r =>
            r.kind === 'drafting'
              ? {
                  ...r,
                  permissions: r.permissions.filter(p => !removed.includes(p)),
                }
              : r,
          )
          const found = problemsOf(broken).filter(
            p => p.code === 'drafting-permission-missing',
          )
          expect(found).toHaveLength(removed.length)
        },
      ),
      { numRuns: 200 },
    )
  })

  test('a reused ID is refused', () => {
    fc.assert(
      fc.property(
        validTemplateArbitrary,
        fc.nat(),
        fc.nat(),
        (template, a, b) => {
          const nodes = templateNodes(template)
          const from = nodes[a % nodes.length]
          const to = nodes[b % nodes.length]
          if (
            from === undefined ||
            to === undefined ||
            from.node.id === to.node.id
          ) {
            return
          }
          const text = JSON.stringify(template)
            .split(`"id":"${to.node.id}"`)
            .join(`"id":"${from.node.id}"`)
          expect(codesOf(JSON.parse(text))).toContain('duplicate-id')
        },
      ),
      { numRuns: 200 },
    )
  })

  test('an approval rule that cannot be met is refused', () => {
    fc.assert(
      fc.property(
        validTemplateArbitrary,
        fc.constantFrom(0, -3, 51, 500),
        (template, count) => {
          const broken = mapRoles(template, r =>
            r.permissions.includes('vote')
              ? { ...r, approval: { kind: 'at_least', count } }
              : r,
          )
          expect(codesOf(broken)).toContain('rule-cannot-be-met')
        },
      ),
      { numRuns: 100 },
    )
  })
})

describe('form model', () => {
  test.each(ALL_TEMPLATES.map(t => [t.id, t] as const))(
    '%s survives template -> form -> template unchanged',
    (_id, template) => {
      const back = templateFromForm(templateToForm(template))
      expect(Result.getOrThrow(back)).toStrictEqual(template)
    },
  )

  test('a generated template survives the round trip, also through JSON', () => {
    fc.assert(
      fc.property(validTemplateArbitrary, template => {
        const form = templateToForm(template)
        expect(Result.getOrThrow(templateFromForm(form))).toStrictEqual(
          template,
        )
        const stored = JSON.parse(JSON.stringify(form)) as typeof form
        expect(stored).toStrictEqual(form)
        expect(Result.getOrThrow(templateFromForm(stored))).toStrictEqual(
          template,
        )
      }),
      { numRuns: 300 },
    )
  })

  test('the form is flat: rows of primitives, with parents by ID', () => {
    const form = templateToForm(INVESTIGATION_TEMPLATE)
    const isFlat = (row: object) =>
      Object.values(row).every(
        v =>
          v === null ||
          ['string', 'number', 'boolean'].includes(typeof v) ||
          (Array.isArray(v) && v.every(x => typeof x === 'string')),
      )
    ;[
      form.sections,
      form.items,
      form.options,
      form.coverParts,
      form.roles,
    ].forEach(rows => rows.forEach(row => expect(isFlat(row)).toBe(true)))
    const ids = new Set([...form.sections, ...form.items].map(r => r.id))
    form.items.forEach(item => expect(ids.has(item.parentId)).toBe(true))
    expect(form.sections.filter(s => s.parentId === null)).toHaveLength(
      INVESTIGATION_TEMPLATE.sections.length,
    )
  })

  test('an edit of the form shows in the template, and a bad edit is reported', () => {
    const form = templateToForm(PANEL_TEMPLATE)
    const edited = {
      ...form,
      name: 'Renamed',
      sections: form.sections.map(s =>
        s.id === 'overview' ? { ...s, title: 'Start' } : s,
      ),
    }
    const template = Result.getOrThrow(templateFromForm(edited))
    expect(template.name).toBe('Renamed')
    expect(template.sections[0]?.title).toBe('Start')

    const orphan = {
      ...form,
      items: [
        ...form.items,
        { ...form.items[0]!, id: 'stray', parentId: 'nowhere' },
      ],
    }
    const orphaned = templateFromForm(orphan)
    expect(Result.isFailure(orphaned) && orphaned.failure[0]?.code).toBe(
      'form-invalid',
    )

    const removedRole = {
      ...form,
      roles: form.roles.filter(r => r.kind !== 'drafting'),
    }
    const refused = templateFromForm(removedRole)
    expect(
      Result.isFailure(refused) && refused.failure.map(p => p.code),
    ).toContain('no-drafting-role')

    const twoConclusions = {
      ...form,
      sections: [
        ...form.sections,
        { ...form.sections[0]!, id: 'c1', isConclusion: true },
        { ...form.sections[0]!, id: 'c2', isConclusion: true },
      ],
    }
    expect(Result.isFailure(templateFromForm(twoConclusions))).toBe(true)
  })

  test('a form without cover lines or ending text has neither', () => {
    const template = Result.getOrThrow(
      templateFromForm(templateToForm(PANEL_TEMPLATE)),
    )
    expect(template.cover).toBeUndefined()
    expect(template.ending).toBeUndefined()
  })
})
