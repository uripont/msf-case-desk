import type { ReportContent, SectionContents } from './content'
import { type Section, type Template } from './template'

// NOTE: Branching (D23). A select item can have an end answer. When one of
// them has that answer chosen, the report ends early:
//
// - every *required* section after the section that holds the select, in
//   document order (its own subsections included), is not in force: its state
//   is "not applicable (ended)";
// - except the sections the template lists in `ending.staysInForce` (a
//   sign-off, say) and their subsections;
// - a subsection of a section that is not in force is not in force either,
//   even if the template lists it;
// - optional sections, and the conclusion section, are never ended;
// - the template's fixed outcome text is shown.
//
// Nothing is deleted. The answer is an ordinary item. When it changes, the
// sections are in force again, with whatever they held, and as nothing in the
// numbering depends on this, the numbers never moved.

export type EndTrigger = Readonly<{
  sectionId: string
  itemId: string
  optionId: string
}>

export type EndState = Readonly<{
  ended: boolean
  triggers: ReadonlyArray<EndTrigger>
  // NOTE: Template section IDs, which apply to every entry of a repeat.
  endedSectionIds: ReadonlySet<string>
  outcomeText: string | undefined
}>

const collectTriggers = (
  sections: ReadonlyArray<Section>,
  contents: SectionContents,
  out: Array<EndTrigger>,
): void => {
  for (const section of sections) {
    // NOTE: Validation keeps end answers out of repeats.
    if (section.repeat !== undefined) {
      continue
    }
    const content = contents[section.id]
    // NOTE: A section marked not applicable keeps its content but takes no part.
    if (content?.notApplicable !== undefined) {
      continue
    }
    for (const item of section.items) {
      if (item.type !== 'select' || item.endOptionId === undefined) {
        continue
      }
      const value = content?.values[item.id]
      if (
        value?.type === 'select' &&
        value.optionIds.includes(item.endOptionId)
      ) {
        out.push({
          sectionId: section.id,
          itemId: item.id,
          optionId: item.endOptionId,
        })
      }
    }
    collectTriggers(section.sections, content?.sections ?? {}, out)
  }
}

type Flat = Readonly<{ section: Section; parentId: string | undefined }>

const flatten = (
  sections: ReadonlyArray<Section>,
  parentId: string | undefined,
  out: Array<Flat>,
): void => {
  for (const section of sections) {
    out.push({ section, parentId })
    flatten(section.sections, section.id, out)
  }
}

export const endState = (
  template: Template,
  content: Pick<ReportContent, 'sections'>,
): EndState => {
  const triggers: Array<EndTrigger> = []
  collectTriggers(template.sections, content.sections, triggers)
  const ended = new Set<string>()
  if (triggers.length === 0 || template.ending === undefined) {
    return {
      ended: false,
      triggers: [],
      endedSectionIds: ended,
      outcomeText: undefined,
    }
  }
  const flat: Array<Flat> = []
  flatten(template.sections, undefined, flat)
  const indexOf = new Map(flat.map((entry, index) => [entry.section.id, index]))
  const parentOf = new Map(
    flat.map(entry => [entry.section.id, entry.parentId]),
  )
  const stays = new Set(template.ending.staysInForce)
  const kept = (id: string): boolean => {
    for (
      let current: string | undefined = id;
      current !== undefined;
      current = parentOf.get(current)
    ) {
      if (stays.has(current)) {
        return true
      }
    }
    return false
  }
  const first = Math.min(
    ...triggers.map(trigger => indexOf.get(trigger.sectionId) ?? Infinity),
  )
  flat.forEach(({ section, parentId }, index) => {
    if (parentId !== undefined && ended.has(parentId)) {
      ended.add(section.id)
    } else if (
      index > first &&
      section.requirement === 'required' &&
      !kept(section.id)
    ) {
      ended.add(section.id)
    }
  })
  return {
    ended: true,
    triggers,
    endedSectionIds: ended,
    outcomeText: template.ending.outcomeText,
  }
}
