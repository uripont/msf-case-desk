import { Option } from 'effect'
import { modifyFields } from 'foldkit/struct'
import { describe, expect, test } from 'vitest'

import { INTAKE_TEMPLATE, type SectionContent } from '@quoroom/domain'

import { Failure } from './failure'
import * as Names from './names'
import { LoadState } from './unit'

const SECTION = INTAKE_TEMPLATE.sections[0]
const SECTION_ID = SECTION?.id ?? ''
const ITEM_ID = SECTION?.items[0]?.id ?? ''

const contentWith = (text: string): Record<string, SectionContent> => ({
  [SECTION_ID]: {
    values: { [ITEM_ID]: { type: 'text', text } },
    sections: {},
  },
})

const SCOPE = { reportId: 'report-1', generation: 0 }

const detail = {
  summary: {
    id: 'report-1',
    caseFile: {
      id: 'cf',
      unit: 'u',
      reference: 'SYN-1',
      title: 'Synthetic case file',
    },
    templateId: INTAKE_TEMPLATE.id,
    templateVersion: INTAKE_TEMPLATE.version,
    templateName: INTAKE_TEMPLATE.name,
    state: 'drafting' as const,
    latestDraft: 0,
    createdAt: 1,
  },
  myRoleId: 'authors',
  permissions: ['edit' as const, 'manage_people' as const],
  authors: [],
}

const ready = (
  people: Names.Model['people'] = [],
  text = 'Zorana Veltkamp saw it. Zorana Veltkamp left.',
): Names.Model =>
  Names.update(
    modifyFields(Names.initialModel, { reportId: () => 'report-1' }),
    Names.Message.SucceededLoadNames({
      scope: SCOPE,
      loaded: {
        detail,
        template: INTAKE_TEMPLATE,
        contents: contentWith(text),
        sectionIds: [SECTION_ID],
        people,
        saveCounter: 3,
        ownerId: 'owner-1',
      },
    }),
  ).model

const commandNames = (step: { commands?: ReadonlyArray<{ name: string }> }) =>
  (step.commands ?? []).map(command => command.name)

const run = (model: Names.Model, ...messages: Array<Names.Message>) =>
  messages.reduce(
    (current, message) => Names.update(current, message).model,
    model,
  )

describe('the people panel', () => {
  test('loading shows the screen and asks for the ignored names', () => {
    const step = Names.update(
      modifyFields(Names.initialModel, { reportId: () => 'report-1' }),
      Names.Message.SucceededLoadNames({
        scope: SCOPE,
        loaded: {
          detail,
          template: INTAKE_TEMPLATE,
          contents: {},
          sectionIds: [],
          people: [],
          saveCounter: 0,
          ownerId: 'o',
        },
      }),
    )
    expect(step.model.load).toEqual(LoadState.Loaded())
    expect(commandNames(step)).toEqual([Names.LoadIgnored.name])
  })

  test('adding a person offers the next default label and saves the list', () => {
    const asked = Names.update(ready(), Names.Message.ClickedAddPerson())
    expect(commandNames(asked)).toEqual([Names.NewPersonId.name])
    const editing = run(
      asked.model,
      Names.Message.GeneratedPersonId({ scope: SCOPE, personId: 'p-1' }),
    )
    expect(Option.getOrThrow(editing.maybeEditing).label).toBe('Person 1')
    const typed = run(
      editing,
      Names.Message.TypedName({ value: ' Zorana Veltkamp ' }),
      Names.Message.TypedAliases({ value: 'Zorana\n\n zorana \nZ. Veltkamp' }),
    )
    const saved = Names.update(typed, Names.Message.SubmittedPerson())
    expect(commandNames(saved)).toEqual([Names.SavePeople.name])
    const done = Names.update(
      saved.model,
      Names.Message.SucceededSavePeople({
        scope: SCOPE,
        saveCounter: 4,
        people: [
          {
            id: 'p-1',
            name: 'Zorana Veltkamp',
            label: 'Person 1',
            aliases: ['Zorana', 'Z. Veltkamp'],
          },
        ],
      }),
    ).model
    expect(done.people).toHaveLength(1)
    expect(done.saveCounter).toBe(4)
    expect(Option.isNone(done.maybeEditing)).toBe(true)
  })

  test('an empty name or a clashing label is refused without a request', () => {
    const editing = run(
      ready(),
      Names.Message.ClickedAddPerson(),
      Names.Message.GeneratedPersonId({ scope: SCOPE, personId: 'p-1' }),
    )
    const empty = Names.update(editing, Names.Message.SubmittedPerson())
    expect(commandNames(empty)).toEqual([])
    expect(empty.model.problems.length).toBe(1)

    const people = [
      { id: 'p-0', name: 'Aaa Bbb', label: 'Person 1', aliases: [] },
    ]
    const clash = run(
      ready(people),
      Names.Message.ClickedAddPerson(),
      Names.Message.GeneratedPersonId({ scope: SCOPE, personId: 'p-1' }),
      Names.Message.TypedName({ value: 'Ccc Ddd' }),
      Names.Message.TypedLabel({ value: 'Person 1' }),
    )
    const refused = Names.update(clash, Names.Message.SubmittedPerson())
    expect(commandNames(refused)).toEqual([])
    expect(refused.model.problems.length).toBeGreaterThan(0)
    expect(JSON.stringify(refused.model.problems)).not.toContain('Ccc')
  })

  test('removing a person asks first', () => {
    const people = [
      { id: 'p-0', name: 'Aaa Bbb', label: 'Person 1', aliases: [] },
    ]
    const asked = Names.update(
      ready(people),
      Names.Message.ClickedRemovePerson({ personId: 'p-0' }),
    )
    expect(commandNames(asked)).toEqual([])
    expect(Option.getOrNull(asked.model.maybeRemoving)).toBe('p-0')
    const confirmed = Names.update(
      asked.model,
      Names.Message.ClickedConfirmRemove(),
    )
    expect(commandNames(confirmed)).toEqual([Names.SavePeople.name])
    const kept = run(asked.model, Names.Message.ClickedKeepPerson())
    expect(Option.isNone(kept.maybeRemoving)).toBe(true)
  })

  test('a failed save keeps the list and shows the failure', () => {
    const people = [
      { id: 'p-0', name: 'Aaa Bbb', label: 'Person 1', aliases: [] },
    ]
    const model = run(
      ready(people),
      Names.Message.ClickedRemovePerson({ personId: 'p-0' }),
      Names.Message.ClickedConfirmRemove(),
      Names.Message.FailedSavePeople({
        scope: SCOPE,
        failure: Failure.Unavailable(),
      }),
    )
    expect(model.people).toEqual(people)
  })

  test('an answer of another page is dropped', () => {
    const model = ready()
    const late = Names.update(
      model,
      Names.Message.SucceededSavePeople({
        scope: { reportId: 'report-1', generation: 5 },
        saveCounter: 9,
        people: [],
      }),
    )
    expect(late.model).toBe(model)
  })
})

describe('name suggestions', () => {
  test('names that are not in the list are suggested and ignoring one hides it', () => {
    const model = ready()
    const found = model.suggestions.map(suggestion => suggestion.text)
    expect(found.some(text => text.includes('Veltkamp'))).toBe(true)
    const target = found.find(text => text.includes('Veltkamp')) ?? 'Veltkamp'
    const step = Names.update(
      model,
      Names.Message.ClickedIgnoreSuggestion({ text: target }),
    )
    expect(commandNames(step)).toEqual([Names.SaveIgnored.name])
    expect(
      step.model.suggestions.map(suggestion => suggestion.text),
    ).not.toContain(target)
  })

  test('adding as an alias of a person saves the list with the alias', () => {
    const people = [
      { id: 'p-0', name: 'Zorana Veltkamp', label: 'Person 1', aliases: [] },
    ]
    const model = ready(people, 'Zora met Zora twice. Zora.')
    const step = Names.update(
      model,
      Names.Message.ChoseAliasTarget({ text: 'Zora', personId: 'p-0' }),
    )
    expect(commandNames(step)).toEqual([Names.SavePeople.name])
  })

  test('a suggestion taken as a new person fills the name', () => {
    const model = run(
      ready(),
      Names.Message.ClickedSuggestionAsPerson({ text: 'Veltkamp' }),
      Names.Message.GeneratedPersonId({ scope: SCOPE, personId: 'p-9' }),
    )
    expect(Option.getOrThrow(model.maybeEditing).name).toBe('Veltkamp')
  })
})

describe('the pictures', () => {
  test('marking sends the mark with the save counter and then reads again', () => {
    const step = Names.update(
      ready(),
      Names.Message.ClickedToggleImage({ imageId: 'img-1', safe: true }),
    )
    expect(commandNames(step)).toEqual([Names.MarkImage.name])
    expect(Option.getOrNull(step.model.maybeBusyImage)).toBe('img-1')
    const done = Names.update(
      step.model,
      Names.Message.SucceededMarkImage({
        scope: SCOPE,
        saveCounter: 4,
        contents: contentWith('Nothing.'),
      }),
    ).model
    expect(done.saveCounter).toBe(4)
    expect(Option.isNone(done.maybeBusyImage)).toBe(true)
  })

  test('a person who cannot manage people cannot mark', () => {
    const model = modifyFields(ready(), {
      maybeDetail: () =>
        Option.some({ ...detail, permissions: ['edit' as const] }),
    })
    const step = Names.update(
      model,
      Names.Message.ClickedToggleImage({ imageId: 'img-1', safe: true }),
    )
    expect(commandNames(step)).toEqual([])
  })
})
