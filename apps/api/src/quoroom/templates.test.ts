import { afterEach, describe, expect, test } from 'vitest'

import { SCENARIOS, type World, makeWorld } from './testkit'

// NOTE: The template editor capability through the real RPC stack.
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
        w.refused(who, c => c.ListTemplates({})),
        w.refused(who, c => c.GetTemplateVersion(ref)),
        w.refused(who, c => c.CreateTemplateDraft({ copyOf: ref, name: 'A copy' })),
        w.refused(who, c => c.CreateTemplateDraft({ name: 'A blank one' })),
        w.refused(who, c => c.SaveTemplateDraft({ templateId: ref.templateId, version: 1, draftRevision: 0, template: scenario.template })),
        w.refused(who, c => c.PublishTemplateVersion({ templateId: ref.templateId, version: 1, draftRevision: 0 })),
        w.refused(who, c => c.RestoreTemplate({ templateId: ref.templateId })),
        w.refused(who, c => c.DiscardTemplateDraft({ templateId: ref.templateId, version: 1 })),
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
    await w.call('tess', c => c.PublishTemplateVersion({ templateId: id, version: 1, draftRevision: draft.draftRevision }))
    const next = await w.call('tess', c => c.CreateTemplateDraft({ copyOf: { templateId: id, version: 1 } }))
    expect(next.version).toBe(2)
    const saved = await w.call('tess', c =>
      c.SaveTemplateDraft({ templateId: id, version: 2, draftRevision: next.draftRevision, template: { ...next.template, name: 'Edited copy, second version' } }),
    )
    // NOTE: new reports see the latest published version only after publishing.
    expect((await w.call('alice', c => c.ListPublishedTemplates())).find(t => t.id === id)?.version).toBe(1)
    await w.call('tess', c => c.PublishTemplateVersion({ templateId: id, version: 2, draftRevision: saved.record.draftRevision }))
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

  test('a stale save or publish of a template draft is refused (draft revision)', async () => {
    const w = await world()
    const draft = await w.call('tess', c => c.CreateTemplateDraft({ name: 'Concurrent' }))
    const id = draft.templateId
    const first = await w.call('tess', c =>
      c.SaveTemplateDraft({ templateId: id, version: 1, draftRevision: draft.draftRevision, template: { ...draft.template, name: 'First edit' } }),
    )
    expect(first.record.draftRevision).toBe(draft.draftRevision + 1)
    const stale = await w.refused('tess', c =>
      c.SaveTemplateDraft({ templateId: id, version: 1, draftRevision: draft.draftRevision, template: { ...draft.template, name: 'Lost edit' } }),
    )
    expect(stale).toMatchObject({ _tag: 'Conflict', reason: 'stale_save' })
    const stalePublish = await w.refused('tess', c =>
      c.PublishTemplateVersion({ templateId: id, version: 1, draftRevision: draft.draftRevision }),
    )
    expect(stalePublish).toMatchObject({ _tag: 'Conflict', reason: 'stale_save' })
    expect((await w.call('tess', c => c.GetTemplateVersion({ templateId: id, version: 1 }))).template.name).toBe('First edit')
  })

  test('a retired template gets no new version until it is restored', async () => {
    const w = await world()
    const draft = await w.call('tess', c => c.CreateTemplateDraft({ name: 'Sticky' }))
    const id = draft.templateId
    await w.call('tess', c => c.PublishTemplateVersion({ templateId: id, version: 1, draftRevision: draft.draftRevision }))
    await w.call('tess', c => c.RetireTemplate({ templateId: id }))
    const next = await w.call('tess', c => c.CreateTemplateDraft({ copyOf: { templateId: id, version: 1 } }))
    const refused = await w.refused('tess', c =>
      c.PublishTemplateVersion({ templateId: id, version: 2, draftRevision: next.draftRevision }),
    )
    expect(refused).toMatchObject({ _tag: 'Validation' })
    const restored = await w.call('tess', c => c.RestoreTemplate({ templateId: id }))
    expect(restored).toMatchObject({ retired: false, publishedVersion: 1 })
    const published = await w.call('tess', c =>
      c.PublishTemplateVersion({ templateId: id, version: 2, draftRevision: next.draftRevision }),
    )
    expect(published.record.state).toBe('published')
  })

  test('a built-in template can only be copied, and a draft that cannot be opened can be discarded', async () => {
    const w = await world()
    const builtIn = await w.refused('tess', c => c.CreateTemplateDraft({ copyOf: ref }))
    expect(builtIn).toMatchObject({ _tag: 'Validation' })
    const copy = await w.call('tess', c => c.CreateTemplateDraft({ copyOf: ref, name: '2024 copy of a built-in' }))
    expect(copy.template.shortName).toMatch(/^[a-z][a-z0-9-]{0,23}$/)
    await w.call('tess', c => c.DiscardTemplateDraft({ templateId: copy.templateId, version: 1 }))
    expect((await w.call('tess', c => c.ListTemplates({}))).templates.some(entry => entry.id === copy.templateId)).toBe(false)
    expect(tagOf(await w.refused('tess', c => c.DiscardTemplateDraft({ templateId: ref.templateId, version: ref.version })))).toBe('NotFound')
  })

  test('the template list shows the published name apart from the draft name, and pages', async () => {
    const w = await world()
    const draft = await w.call('tess', c => c.CreateTemplateDraft({ name: 'Listed one' }))
    const id = draft.templateId
    await w.call('tess', c => c.PublishTemplateVersion({ templateId: id, version: 1, draftRevision: draft.draftRevision }))
    const next = await w.call('tess', c => c.CreateTemplateDraft({ copyOf: { templateId: id, version: 1 } }))
    await w.call('tess', c =>
      c.SaveTemplateDraft({ templateId: id, version: 2, draftRevision: next.draftRevision, template: { ...next.template, name: 'Renamed in draft' } }),
    )
    const all = (await w.call('tess', c => c.ListTemplates({}))).templates
    expect(all.find(entry => entry.id === id)).toMatchObject({ name: 'Listed one', draftName: 'Renamed in draft', draftVersion: 2, publishedVersion: 1 })
    const first = await w.call('tess', c => c.ListTemplates({ limit: 1 }))
    expect(first.templates).toHaveLength(1)
    expect(first.next).toBe(1)
    const rest = await w.call('tess', c => c.ListTemplates({ offset: first.next ?? 0, limit: 100 }))
    expect(rest.next).toBeUndefined()
    expect(first.templates.length + rest.templates.length).toBe(all.length)
  })
})
