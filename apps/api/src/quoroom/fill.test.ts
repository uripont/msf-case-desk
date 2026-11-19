import { afterEach, describe, expect, test } from 'vitest'

import {
  fullContent,
  instructionTexts,
} from '@quoroom/domain/testing/fixtures'

import { SCENARIOS, type World, makeWorld } from './testkit'

// NOTE: A report that fills every item of the template, entries and
// nested entries included, is stored exactly as sent, section by section, and
// holds none of the template's instruction texts. This covers the invented
// panel template, which the browser check (built-in templates only) cannot
// reach, on the in-memory and the SQL repository.

const worlds: Array<World> = []
afterEach(async () => {
  await Promise.all(worlds.splice(0).map(world => world.dispose()))
})

describe.each(SCENARIOS)('$name', scenario => {
  test('every item of every top-level section is stored as sent', async () => {
    const w = await makeWorld(scenario)
    worlds.push(w)
    const reportId = await w.createReport()
    const started = await w.call('alice', c => c.StartWorkingCopy({ reportId }))
    const expected = fullContent(scenario.template)
    let saveCounter = started.saveCounter
    for (const section of scenario.template.sections) {
      const content = expected.sections[section.id]
      if (content === undefined) {
        throw new Error(`no fixture for ${section.id}`)
      }
      const saved = await w.call('alice', c =>
        c.SaveSection({
          reportId,
          sectionId: section.id,
          saveCounter,
          content,
        }),
      )
      saveCounter = saved.saveCounter
    }
    const stored: Record<string, unknown> = {}
    for (const section of scenario.template.sections) {
      const read = await w.call('alice', c =>
        c.GetWorkingCopySection({ reportId, sectionId: section.id }),
      )
      stored[section.id] = read.content
      expect(read.content, section.id).toEqual(expected.sections[section.id])
    }
    const text = JSON.stringify(stored)
    for (const instruction of instructionTexts(scenario.template)) {
      expect(text.includes(instruction), instruction).toBe(false)
    }
  })
})
