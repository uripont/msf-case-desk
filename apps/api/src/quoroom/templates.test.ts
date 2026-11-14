import { afterEach, describe, expect, test } from 'vitest'

import { SCENARIOS, type World, makeWorld } from './testkit'

// NOTE: Stage 9: the template editor capability through the real RPC stack.
// All people and data are invented.

const worlds: Array<World> = []
afterEach(async () => {
  await Promise.all(worlds.splice(0).map(world => world.dispose()))
})

const tagOf = (error: unknown): string =>
  (error as { _tag?: string })._tag ?? 'unknown'

describe.each(SCENARIOS)('$name', scenario => {
  const world = async () => {
    const made = await makeWorld(scenario)
    worlds.push(made)
    return made
  }
  const ref = { templateId: scenario.template.id, version: scenario.template.version }

  test('an account without the template editor capability is refused every template procedure', async () => {
    const w = await world()
    for (const who of ['alice', 'adam', 'carol', 'frank'] as const) {
      const refusals = await Promise.all([
        w.refused(who, c => c.ListTemplates()),
        w.refused(who, c => c.GetTemplateVersion(ref)),
        w.refused(who, c => c.CreateTemplateDraft({ copyOf: ref, name: 'A copy' })),
        w.refused(who, c => c.CreateTemplateDraft({ name: 'A blank one' })),
        w.refused(who, c => c.SaveTemplateDraft({ templateId: ref.templateId, version: 1, template: scenario.template })),
        w.refused(who, c => c.PublishTemplateVersion({ templateId: ref.templateId, version: 1 })),
        w.refused(who, c => c.RetireTemplate({ templateId: ref.templateId })),
      ])
      for (const error of refusals) expect(tagOf(error)).toBe('NotPermitted')
    }
  })

  test('a template editor without a report role reads no report', async () => {
    const w = await world()
    const reportId = await w.createReport()
    for (const error of await Promise.all([
      w.refused('tess', c => c.GetReport({ reportId })),
      w.refused('tess', c => c.GetWorkingCopy({ reportId })),
      w.refused('tess', c => c.GetTemplateVersion({ ...ref, reportId })),
    ])) {
      expect(tagOf(error)).toBe('NotFound')
    }
  })

  test('editing a published template makes a new version and leaves existing reports on theirs', async () => {
    const w = await world()
    const reportId = await w.createReport()
    const draft = await w.call('tess', c => c.CreateTemplateDraft({ copyOf: ref, name: 'Edited copy' }))
    const id = draft.templateId
    await w.call('tess', c => c.PublishTemplateVersion({ templateId: id, version: 1 }))
    const next = await w.call('tess', c => c.CreateTemplateDraft({ copyOf: { templateId: id, version: 1 } }))
    expect(next.version).toBe(2)
    await w.call('tess', c =>
      c.SaveTemplateDraft({ templateId: id, version: 2, template: { ...next.template, name: 'Edited copy, second version' } }),
    )
    // NOTE: new reports see the latest published version only after publishing.
    expect((await w.call('alice', c => c.ListPublishedTemplates())).find(t => t.id === id)?.version).toBe(1)
    await w.call('tess', c => c.PublishTemplateVersion({ templateId: id, version: 2 }))
    expect((await w.call('alice', c => c.ListPublishedTemplates())).find(t => t.id === id)?.version).toBe(2)
    // NOTE: the report made earlier keeps its version, and so does the old version's text.
    const kept = await w.call('alice', c => c.GetTemplateVersion({ ...ref, reportId }))
    expect(kept.template).toEqual(scenario.template)
    expect((await w.call('tess', c => c.GetTemplateVersion({ templateId: id, version: 1 }))).template.name).toBe('Edited copy')
  })

  test('a retired template keeps working for its existing reports', async () => {
    const w = await world()
    const reportId = await w.createReport()
    await w.call('tess', c => c.RetireTemplate({ templateId: ref.templateId }))
    expect((await w.call('alice', c => c.GetTemplateVersion({ ...ref, reportId }))).template).toEqual(scenario.template)
    expect((await w.call('alice', c => c.ListPublishedTemplates())).some(t => t.id === ref.templateId)).toBe(false)
  })
})
