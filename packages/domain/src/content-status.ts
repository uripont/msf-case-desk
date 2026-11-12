import { endState } from './branching'
import {
  type ItemEntry,
  type ItemValue,
  type ItemValues,
  type ReportContent,
  type SectionContent,
  type SectionContents,
  groupKey,
  instanceKey,
} from './content'
import { isRichTextEmpty } from './richtext'
import { type Item, type Section, type Template } from './template'

// NOTE: Section states (D23, section 5), derived from the content and the
// template, never stored:
//
// - `not_applicable`: the author marked it, with a reason (only sections that
//   are *optional with a not applicable reason* can be);
// - `ended`: not applicable (ended) by branching, see branching.ts;
// - otherwise `empty` when nothing in it is filled in, `complete` when every
//   required item is filled and every required subsection is complete (or not
//   applicable, or ended), and `in_progress` between the two.
//
// "Filled" is `isItemFilled`. An optional item, including one that is optional
// with a reason, never holds a section back. A required repeatable subsection
// is complete when it has at least its minimum of entries and each entry is.

export type SectionState =
  | 'empty'
  | 'in_progress'
  | 'complete'
  | 'not_applicable'
  | 'ended'

const entryOk = (item: Item, entry: ItemEntry): boolean =>
  item.type === 'repeated' &&
  item.items.every(
    child =>
      child.requirement !== 'required' ||
      isItemFilled(child, entry.values[child.id]),
  )

// NOTE: A value counts as filled when the author gave it content: text that
// is not blank, a date, one answer or more, one person or more, a document
// with text or an image, a signature with a name and a date, a repeated item
// with its minimum of entries each complete. A case-file value is always
// filled, as it is read-only.
export const isItemFilled = (
  item: Item,
  value: ItemValue | undefined,
): boolean => {
  if (item.type === 'case_value') {
    return true
  }
  if (
    value === undefined ||
    value.type === 'not_applicable' ||
    value.type !== item.type
  ) {
    return false
  }
  switch (value.type) {
    case 'text':
      return value.text.trim() !== ''
    case 'date':
      return value.date !== ''
    case 'select':
      return value.optionIds.length > 0
    case 'people':
      return value.personIds.length > 0
    case 'rich_text':
      return !isRichTextEmpty(value.doc)
    case 'signature':
      return value.name.trim() !== '' && value.date !== undefined
    case 'repeated':
      return (
        value.entries.length > 0 &&
        value.entries.length >= (item.type === 'repeated' ? item.min : 0) &&
        value.entries.every(entry => entryOk(item, entry))
      )
  }
}

// NOTE: An item has been started when there is something in it, or the author
// marked it not applicable.
const isItemTouched = (item: Item, value: ItemValue | undefined): boolean => {
  if (item.type === 'case_value' || value === undefined) {
    return false
  }
  if (value.type === 'not_applicable') {
    return true
  }
  if (value.type !== item.type) {
    return false
  }
  if (value.type === 'repeated') {
    return value.entries.length > 0
  }
  if (value.type === 'signature') {
    return value.name.trim() !== '' || value.date !== undefined
  }
  return isItemFilled(item, value)
}

type Scope = Readonly<{ values: ItemValues; sections: SectionContents }>

const isDone = (state: SectionState): boolean =>
  state === 'complete' || state === 'not_applicable' || state === 'ended'

const isStarted = (state: SectionState): boolean =>
  state === 'in_progress' || state === 'complete' || state === 'not_applicable'

type Evaluation = Readonly<{
  ended: ReadonlySet<string>
  states: Map<string, SectionState>
}>

// NOTE: Evaluates one scope: its items and its direct subsections. Returns
// whether it is started and whether its requirements are met.
const evaluateScope = (
  evaluation: Evaluation,
  items: ReadonlyArray<Item>,
  subsections: ReadonlyArray<Section>,
  scope: Scope,
  key: string,
): Readonly<{ started: boolean; ok: boolean }> => {
  const groupStates = subsections.map(
    child =>
      [
        child,
        evaluateSection(evaluation, child, scope.sections[child.id], key),
      ] as const,
  )
  const itemsOk = items.every(
    item =>
      item.requirement !== 'required' ||
      isItemFilled(item, scope.values[item.id]),
  )
  const childrenOk = groupStates.every(
    ([child, state]) => child.requirement !== 'required' || isDone(state),
  )
  const started =
    items.some(item => isItemTouched(item, scope.values[item.id])) ||
    groupStates.some(([, state]) => isStarted(state))
  return { started, ok: itemsOk && childrenOk }
}

const stateOf = (started: boolean, ok: boolean): SectionState =>
  !started ? 'empty' : ok ? 'complete' : 'in_progress'

// NOTE: Evaluates a section and writes the state of each of its instances into
// `states`. Returns the state of the section as a whole (for a repeatable
// section, its entries together), which is what its parent looks at.
const evaluateSection = (
  evaluation: Evaluation,
  section: Section,
  content: SectionContent | undefined,
  parentKey: string,
): SectionState => {
  const isEnded = evaluation.ended.has(section.id)
  const notApplicable = !isEnded && content?.notApplicable !== undefined
  const finish = (state: SectionState): SectionState => {
    evaluation.states.set(groupKey(parentKey, section.id), state)
    return state
  }
  const override: SectionState | undefined = isEnded
    ? 'ended'
    : notApplicable
      ? 'not_applicable'
      : undefined

  if (section.repeat === undefined) {
    const key = instanceKey(parentKey, section.id)
    const scope = evaluateScope(
      evaluation,
      section.items,
      section.sections,
      content ?? { values: {}, sections: {} },
      key,
    )
    return finish(override ?? stateOf(scope.started, scope.ok))
  }

  const entries = content?.entries ?? []
  const results = entries.map(entry => {
    const key = instanceKey(parentKey, section.id, entry.id)
    const scope = evaluateScope(
      evaluation,
      section.items,
      section.sections,
      entry,
      key,
    )
    evaluation.states.set(key, override ?? stateOf(scope.started, scope.ok))
    return scope
  })
  if (override !== undefined) {
    return finish(override)
  }
  const ok =
    entries.length >= section.repeat.min && results.every(result => result.ok)
  return finish(stateOf(entries.length > 0, ok))
}

// NOTE: The state of every section of a report, by the keys of
// `numberSections` (`instanceKey`). A repeatable section also has one state
// for the whole group, under its `groupKey`.
export const sectionStates = (
  template: Template,
  content: Pick<ReportContent, 'sections'>,
): ReadonlyMap<string, SectionState> => {
  const evaluation: Evaluation = {
    ended: endState(template, content).endedSectionIds,
    states: new Map(),
  }
  const top =
    template.conclusion === undefined
      ? template.sections
      : [...template.sections, template.conclusion]
  for (const section of top) {
    evaluateSection(evaluation, section, content.sections[section.id], '')
  }
  return evaluation.states
}
