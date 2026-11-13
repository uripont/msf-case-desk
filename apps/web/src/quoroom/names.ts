import { clsx } from 'clsx'
import { Array, Crypto, Effect, Option, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import {
  type ItemValue,
  type NameSuggestion,
  PeopleList,
  type Person,
  ReportDetail,
  SectionContent,
  type SectionContents,
  Template,
  aliasKey,
  foldedKey,
  nextDefaultLabel,
  peopleListProblems,
  richTextFigures,
  shellOf,
  suggestNames,
} from '@case-desk/domain'
import { BrowserCrypto } from '@effect/platform-browser'

import { AppRoute, pathOf } from '../route'
import { fieldClassName, focusRing, labelClassName } from '../style'
import { withQuoroom } from './api'
import { actionButton } from './entryViews'
import { Failure, failureOf, failureText } from './failure'
import { FormState, formStatus, isSubmitting } from './formState'
import { imageElement } from './images/spec'
import { PageScope, isCurrentPage, pageScopeOf } from './scope'
import { alertText, loadingText, panel, statusText, submitButton } from './ui'
import { LoadState } from './unit'
import './images/figureImage'

// NOTE: People, names and pictures of a report (stage 5), at `/r/:id/names`:
// the people list with their aliases and spellings (saved through
// `SavePeople`, part of the working copy and of every shared draft), the
// suggestions of names that look like people and are not in the list yet
// (`suggestNames`, computed here over the working copy, never on the server),
// and the pictures with the "safe to share" mark (`MarkImageSafe`, the same
// flag the figure's toggle in the editor sets). Errors shown are the fixed
// messages of the domain and never echo a name, an alias or a label.

export type Editing = Readonly<{
  personId: string
  isNew: boolean
  name: string
  label: string
  // NOTE: One alias or spelling per line.
  aliases: string
}>

const EditingSchema = Schema.Struct({
  personId: Schema.String,
  isNew: Schema.Boolean,
  name: Schema.String,
  label: Schema.String,
  aliases: Schema.String,
})

const SuggestionSchema = Schema.Struct({
  text: Schema.String,
  count: Schema.Int,
})

export const Model = Schema.Struct({
  origin: Schema.String,
  reportId: Schema.String,
  generation: Schema.Int,
  load: LoadState,
  maybeDetail: Schema.Option(ReportDetail),
  maybeTemplate: Schema.Option(Template),
  contents: Schema.Record(Schema.String, SectionContent),
  sectionIds: Schema.Array(Schema.String),
  people: PeopleList,
  saveCounter: Schema.Int,
  ownerId: Schema.String,
  maybeEditing: Schema.Option(EditingSchema),
  // NOTE: A name taken from a suggestion that waits for its ID.
  maybePendingName: Schema.Option(Schema.String),
  maybeRemoving: Schema.Option(Schema.String),
  problems: Schema.Array(Schema.String),
  form: FormState,
  maybeNotice: Schema.Option(Schema.String),
  suggestions: Schema.Array(SuggestionSchema),
  // NOTE: Suggestions the author ignored, kept in this browser for this
  // working copy.
  ignored: Schema.Array(Schema.String),
  maybeBusyImage: Schema.Option(Schema.String),
  maybeImageFailure: Schema.Option(Failure),
})
export type Model = typeof Model.Type

export const initialModel = Model.make({
  origin: '',
  reportId: '',
  generation: 0,
  load: LoadState.Loading(),
  maybeDetail: Option.none(),
  maybeTemplate: Option.none(),
  contents: {},
  sectionIds: [],
  people: [],
  saveCounter: 0,
  ownerId: '',
  maybeEditing: Option.none(),
  maybePendingName: Option.none(),
  maybeRemoving: Option.none(),
  problems: [],
  form: FormState.Editing(),
  maybeNotice: Option.none(),
  suggestions: [],
  ignored: [],
  maybeBusyImage: Option.none(),
  maybeImageFailure: Option.none(),
})

export const LoadedNames = Schema.Struct({
  detail: ReportDetail,
  template: Template,
  contents: Schema.Record(Schema.String, SectionContent),
  sectionIds: Schema.Array(Schema.String),
  people: PeopleList,
  saveCounter: Schema.Int,
  ownerId: Schema.String,
})
export type LoadedNames = typeof LoadedNames.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededLoadNames: { scope: PageScope, loaded: LoadedNames },
  FailedLoadNames: { scope: PageScope, failure: Failure },
  ClickedRetryLoad: {},
  SucceededLoadIgnored: {
    scope: PageScope,
    ignored: Schema.Array(Schema.String),
  },
  CompletedSaveIgnored: {},
  ClickedAddPerson: {},
  GeneratedPersonId: { scope: PageScope, personId: Schema.String },
  ClickedEditPerson: { personId: Schema.String },
  TypedName: { value: Schema.String },
  TypedLabel: { value: Schema.String },
  TypedAliases: { value: Schema.String },
  SubmittedPerson: {},
  ClickedCancelEdit: {},
  ClickedRemovePerson: { personId: Schema.String },
  ClickedConfirmRemove: {},
  ClickedKeepPerson: {},
  SucceededSavePeople: {
    scope: PageScope,
    saveCounter: Schema.Int,
    people: PeopleList,
  },
  FailedSavePeople: { scope: PageScope, failure: Failure },
  ClickedSuggestionAsPerson: { text: Schema.String },
  ChoseAliasTarget: { text: Schema.String, personId: Schema.String },
  ClickedIgnoreSuggestion: { text: Schema.String },
  ClickedToggleImage: { imageId: Schema.String, safe: Schema.Boolean },
  SucceededMarkImage: {
    scope: PageScope,
    saveCounter: Schema.Int,
    contents: Schema.Record(Schema.String, SectionContent),
  },
  FailedMarkImage: { scope: PageScope, failure: Failure },
})
export type Message = typeof Message.Type

// COMMAND

export const LoadNames = Command.define('LoadNames', {
  args: { scope: PageScope },
  messages: [Message.SucceededLoadNames, Message.FailedLoadNames],
  execute: ({ scope }) => {
    const { reportId } = scope
    return withQuoroom(client =>
      Effect.gen(function* () {
        const detail = yield* client.GetReport({ reportId })
        const version = yield* client.GetTemplateVersion({
          templateId: detail.summary.templateId,
          version: detail.summary.templateVersion,
          reportId,
        })
        yield* client.StartWorkingCopy({ reportId })
        const outline = yield* client.GetWorkingCopy({ reportId })
        const sections = yield* Effect.forEach(
          outline.sections,
          section =>
            client.GetWorkingCopySection({
              reportId,
              sectionId: section.sectionId,
            }),
          { concurrency: 4 },
        )
        const people = yield* client.GetPeople({ reportId })
        return {
          detail,
          template: version.template,
          contents: Object.fromEntries(
            sections.map(section => [section.sectionId, section.content]),
          ),
          sectionIds: outline.sections.map(section => section.sectionId),
          people: people.people,
          saveCounter: people.saveCounter ?? outline.saveCounter,
          ownerId: outline.ownerId,
        }
      }),
    ).pipe(
      Effect.map(loaded => Message.SucceededLoadNames({ scope, loaded })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedLoadNames({ scope, failure: failureOf(error) }),
        ),
      ),
    )
  },
})

const ignoredKey = (reportId: string, ownerId: string): string =>
  `quoroom.ignored-names.${ownerId}.${reportId}`

// NOTE: The ignored suggestions of a working copy live in this browser. A
// browser that does not keep them (private window, blocked storage) simply
// shows the suggestion again.
export const LoadIgnored = Command.define('LoadIgnored', {
  args: { scope: PageScope, ownerId: Schema.String },
  messages: [Message.SucceededLoadIgnored],
  execute: ({ scope, ownerId }) =>
    Effect.sync(() => {
      try {
        const raw = window.localStorage.getItem(
          ignoredKey(scope.reportId, ownerId),
        )
        const parsed: unknown = raw === null ? [] : JSON.parse(raw)
        return globalThis.Array.isArray(parsed)
          ? parsed.filter((entry): entry is string => typeof entry === 'string')
          : []
      } catch {
        return []
      }
    }).pipe(
      Effect.map(ignored => Message.SucceededLoadIgnored({ scope, ignored })),
    ),
})

export const SaveIgnored = Command.define('SaveIgnored', {
  args: {
    reportId: Schema.String,
    ownerId: Schema.String,
    ignored: Schema.Array(Schema.String),
  },
  messages: [Message.CompletedSaveIgnored],
  execute: ({ reportId, ownerId, ignored }) =>
    Effect.sync(() => {
      try {
        window.localStorage.setItem(
          ignoredKey(reportId, ownerId),
          JSON.stringify(ignored),
        )
      } catch {
        // NOTE: nothing to do; the suggestion is shown again next time.
      }
    }).pipe(Effect.as(Message.CompletedSaveIgnored())),
})

// NOTE: A person's ID is random and chosen here, so two authors who each add
// a person to the same draft never choose the same one.
export const NewPersonId = Command.define('NewPersonId', {
  args: { scope: PageScope },
  messages: [Message.GeneratedPersonId],
  execute: ({ scope }) =>
    Effect.flatMap(Crypto.Crypto, crypto => crypto.randomUUIDv4).pipe(
      Effect.provide(BrowserCrypto.layer),
      Effect.map(uuid =>
        Message.GeneratedPersonId({
          scope,
          personId: uuid.replaceAll('-', '').slice(0, 16),
        }),
      ),
      Effect.catch(() =>
        Effect.succeed(Message.GeneratedPersonId({ scope, personId: '' })),
      ),
    ),
})

export const SavePeople = Command.define('SavePeople', {
  args: { scope: PageScope, saveCounter: Schema.Int, people: PeopleList },
  messages: [Message.SucceededSavePeople, Message.FailedSavePeople],
  execute: ({ scope, saveCounter, people }) =>
    withQuoroom(client =>
      client.SavePeople({ reportId: scope.reportId, saveCounter, people }),
    ).pipe(
      Effect.map(saved =>
        Message.SucceededSavePeople({
          scope,
          saveCounter: saved.saveCounter,
          people,
        }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedSavePeople({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

export const MarkImage = Command.define('MarkImage', {
  args: {
    scope: PageScope,
    imageId: Schema.String,
    safe: Schema.Boolean,
    saveCounter: Schema.Int,
    sectionIds: Schema.Array(Schema.String),
  },
  messages: [Message.SucceededMarkImage, Message.FailedMarkImage],
  execute: ({ scope, imageId, safe, saveCounter, sectionIds }) =>
    withQuoroom(client =>
      Effect.gen(function* () {
        const marked = yield* client.MarkImageSafe({
          reportId: scope.reportId,
          imageId,
          safe,
          saveCounter,
        })
        const sections = yield* Effect.forEach(
          sectionIds,
          sectionId =>
            client.GetWorkingCopySection({
              reportId: scope.reportId,
              sectionId,
            }),
          { concurrency: 4 },
        )
        return {
          saveCounter: marked.saveCounter,
          contents: Object.fromEntries(
            sections.map(section => [section.sectionId, section.content]),
          ),
        }
      }),
    ).pipe(
      Effect.map(({ saveCounter: next, contents }) =>
        Message.SucceededMarkImage({
          scope,
          saveCounter: next,
          contents,
        }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedMarkImage({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

// QUERIES

export type Picture = Readonly<{
  imageId: string
  alt: string
  safe: boolean
}>

const valuePictures = (value: ItemValue): ReadonlyArray<Picture> => {
  if (value.type === 'rich_text') {
    return Array.map(richTextFigures(value.doc), attrs => ({
      imageId: attrs.imageId,
      alt: attrs.alt,
      safe: attrs.safeToShare,
    }))
  }
  if (value.type === 'repeated') {
    return Array.flatMap(value.entries, entry =>
      Array.flatMap(Object.values(entry.values), valuePictures),
    )
  }
  return []
}

const sectionPictures = (section: SectionContent): ReadonlyArray<Picture> => [
  ...Array.flatMap(Object.values(section.values), valuePictures),
  ...Array.flatMap(Object.values(section.sections), sectionPictures),
  ...Array.flatMap(section.entries ?? [], entry => [
    ...Array.flatMap(Object.values(entry.values), valuePictures),
    ...Array.flatMap(Object.values(entry.sections), sectionPictures),
  ]),
]

// NOTE: Every picture of the working copy once, safe only if every figure that
// shows it is marked (the same rule the server applies when it stages a share).
export const picturesOf = (
  contents: SectionContents,
): ReadonlyArray<Picture> => {
  const found = new Map<string, Picture>()
  for (const picture of Array.flatMap(
    Object.values(contents),
    sectionPictures,
  )) {
    const earlier = found.get(picture.imageId)
    found.set(
      picture.imageId,
      earlier === undefined
        ? picture
        : { ...earlier, safe: earlier.safe && picture.safe },
    )
  }
  return globalThis.Array.from(found.values())
}

const isIgnored = (
  ignored: ReadonlyArray<string>,
  suggestion: NameSuggestion,
): boolean =>
  Array.some(ignored, text => foldedKey(text) === foldedKey(suggestion.text))

// NOTE: The suggestions that are not ignored, over the working copy as it is
// now and the list as it is now.
export const suggestionsOf = (
  template: Template,
  contents: SectionContents,
  people: ReadonlyArray<Person>,
  ignored: ReadonlyArray<string>,
): ReadonlyArray<NameSuggestion> =>
  Array.filter(
    suggestNames({ content: shellOf(template, contents), people, template }),
    suggestion => !isIgnored(ignored, suggestion),
  )

const withSuggestions = (model: Model): Model =>
  Option.match(model.maybeTemplate, {
    onNone: () => model,
    onSome: template =>
      modifyFields(model, {
        suggestions: () =>
          suggestionsOf(template, model.contents, model.people, model.ignored),
      }),
  })

// NOTE: The aliases typed one per line, trimmed, without empty lines and
// without repeats.
export const aliasesOfText = (text: string): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const out: Array<string> = []
  for (const line of text.split('\n')) {
    const alias = aliasKey(line)
    const key = foldedKey(alias)
    if (alias !== '' && !seen.has(key)) {
      seen.add(key)
      out.push(alias)
    }
  }
  return out
}

// NOTE: What is wrong with a list, in the domain's fixed words, once each.
export const problemTexts = (
  people: ReadonlyArray<Person>,
): ReadonlyArray<string> =>
  Array.dedupe(
    Array.map(peopleListProblems(people), problem => problem.message),
  )

export const canEditPeople = (model: Model): boolean =>
  Option.match(model.maybeDetail, {
    onNone: () => false,
    onSome: detail =>
      detail.summary.state !== 'archived' &&
      Array.contains(detail.permissions, 'manage_people'),
  })

// INIT

export const enter = (
  origin: string,
  reportId: string,
  generation: number,
): Update.Return<Model, Message> => {
  const fresh = modifyFields(initialModel, {
    origin: () => origin,
    reportId: () => reportId,
    generation: () => generation,
  })
  return { model: fresh, commands: [LoadNames({ scope: pageScopeOf(fresh) })] }
}

export const cleared = (model: Model): Model =>
  modifyFields(initialModel, { generation: () => model.generation + 1 })

// UPDATE

const isBusy = (model: Model): boolean =>
  isSubmitting(model.form) || Option.isSome(model.maybeBusyImage)

const startSave = (
  model: Model,
  people: ReadonlyArray<Person>,
): Update.Return<Model, Message> => ({
  model: modifyFields(model, {
    form: () => FormState.Submitting(),
    problems: () => [],
    maybeNotice: () => Option.none(),
  }),
  commands: [
    SavePeople({
      scope: pageScopeOf(model),
      saveCounter: model.saveCounter,
      people,
    }),
  ],
})

const editingOf = (person: Person): Editing => ({
  personId: person.id,
  isNew: false,
  name: person.name,
  label: person.label,
  aliases: person.aliases.join('\n'),
})

const updateEditing = (
  model: Model,
  change: (editing: Editing) => Editing,
): Model =>
  Option.match(model.maybeEditing, {
    onNone: () => model,
    onSome: editing =>
      modifyFields(model, {
        maybeEditing: () => Option.some(change(editing)),
        problems: () => [],
      }),
  })

const updateCurrent = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededLoadNames: ({ loaded }) => ({
      model: withSuggestions(
        modifyFields(model, {
          load: () => LoadState.Loaded(),
          maybeDetail: () => Option.some(loaded.detail),
          maybeTemplate: () => Option.some(loaded.template),
          contents: () => loaded.contents,
          sectionIds: () => loaded.sectionIds,
          people: () => loaded.people,
          saveCounter: () => loaded.saveCounter,
          ownerId: () => loaded.ownerId,
        }),
      ),
      commands: [
        LoadIgnored({
          scope: pageScopeOf(model),
          ownerId: loaded.ownerId,
        }),
      ],
    }),
    FailedLoadNames: ({ failure }) => ({
      model: modifyFields(model, { load: () => LoadState.Failed({ failure }) }),
    }),
    ClickedRetryLoad: () => ({
      model: modifyFields(model, { load: () => LoadState.Loading() }),
      commands: [LoadNames({ scope: pageScopeOf(model) })],
    }),
    SucceededLoadIgnored: ({ ignored }) => ({
      model: withSuggestions(modifyFields(model, { ignored: () => ignored })),
    }),
    CompletedSaveIgnored: () => ({ model }),
    ClickedAddPerson: () =>
      canEditPeople(model) && !isBusy(model)
        ? {
            model: modifyFields(model, {
              maybePendingName: () => Option.some(''),
            }),
            commands: [NewPersonId({ scope: pageScopeOf(model) })],
          }
        : { model },
    ClickedSuggestionAsPerson: ({ text }) =>
      canEditPeople(model) && !isBusy(model)
        ? {
            model: modifyFields(model, {
              maybePendingName: () => Option.some(text),
            }),
            commands: [NewPersonId({ scope: pageScopeOf(model) })],
          }
        : { model },
    GeneratedPersonId: ({ personId }) =>
      personId === ''
        ? {
            model: modifyFields(model, {
              maybePendingName: () => Option.none(),
              maybeNotice: () => Option.some('Nothing was added. Try again.'),
            }),
          }
        : {
            model: modifyFields(model, {
              maybeEditing: () =>
                Option.some({
                  personId,
                  isNew: true,
                  name: Option.getOrElse(model.maybePendingName, () => ''),
                  label: nextDefaultLabel(model.people),
                  aliases: '',
                }),
              maybePendingName: () => Option.none(),
              maybeRemoving: () => Option.none(),
              problems: () => [],
              form: () => FormState.Editing(),
              maybeNotice: () => Option.none(),
            }),
          },
    ClickedEditPerson: ({ personId }) =>
      canEditPeople(model) && !isBusy(model)
        ? {
            model: modifyFields(model, {
              maybeEditing: () =>
                Option.map(
                  Array.findFirst(
                    model.people,
                    person => person.id === personId,
                  ),
                  editingOf,
                ),
              maybeRemoving: () => Option.none(),
              problems: () => [],
              form: () => FormState.Editing(),
              maybeNotice: () => Option.none(),
            }),
          }
        : { model },
    TypedName: ({ value }) => ({
      model: updateEditing(model, editing => ({ ...editing, name: value })),
    }),
    TypedLabel: ({ value }) => ({
      model: updateEditing(model, editing => ({ ...editing, label: value })),
    }),
    TypedAliases: ({ value }) => ({
      model: updateEditing(model, editing => ({
        ...editing,
        aliases: value,
      })),
    }),
    ClickedCancelEdit: () => ({
      model: modifyFields(model, {
        maybeEditing: () => Option.none(),
        problems: () => [],
        form: () => FormState.Editing(),
      }),
    }),
    SubmittedPerson: () =>
      Option.match(model.maybeEditing, {
        onNone: () => ({ model }),
        onSome: editing => {
          if (isBusy(model)) {
            return { model }
          }
          const name = aliasKey(editing.name)
          const label = editing.label.trim()
          if (name === '' || label === '') {
            return {
              model: modifyFields(model, {
                problems: () => [
                  name === ''
                    ? 'Write the name of the person.'
                    : 'Write the label reviewers will read instead of the name.',
                ],
              }),
            }
          }
          const person: Person = {
            id: editing.personId,
            name,
            label,
            aliases: aliasesOfText(editing.aliases),
          }
          const people = editing.isNew
            ? [...model.people, person]
            : Array.map(model.people, existing =>
                existing.id === person.id ? person : existing,
              )
          const problems = problemTexts(people)
          return Array.isReadonlyArrayEmpty(problems)
            ? startSave(model, people)
            : { model: modifyFields(model, { problems: () => problems }) }
        },
      }),
    ClickedRemovePerson: ({ personId }) =>
      canEditPeople(model) && !isBusy(model)
        ? {
            model: modifyFields(model, {
              maybeRemoving: () => Option.some(personId),
              maybeEditing: () => Option.none(),
              maybeNotice: () => Option.none(),
            }),
          }
        : { model },
    ClickedKeepPerson: () => ({
      model: modifyFields(model, { maybeRemoving: () => Option.none() }),
    }),
    ClickedConfirmRemove: () =>
      Option.match(model.maybeRemoving, {
        onNone: () => ({ model }),
        onSome: personId =>
          isBusy(model)
            ? { model }
            : startSave(
                modifyFields(model, { maybeRemoving: () => Option.none() }),
                Array.filter(model.people, person => person.id !== personId),
              ),
      }),
    SucceededSavePeople: ({ saveCounter, people }) => ({
      model: withSuggestions(
        modifyFields(model, {
          people: () => people,
          saveCounter: () => saveCounter,
          form: () => FormState.Editing(),
          maybeEditing: () => Option.none(),
          maybeNotice: () => Option.some('The list of people is saved.'),
        }),
      ),
    }),
    FailedSavePeople: ({ failure }) => ({
      model: modifyFields(model, {
        form: () => FormState.Failed({ failure }),
      }),
    }),
    ChoseAliasTarget: ({ text, personId }) => {
      if (!canEditPeople(model) || isBusy(model) || personId === '') {
        return { model }
      }
      const people = Array.map(model.people, person =>
        person.id === personId
          ? {
              ...person,
              aliases: Array.some(
                person.aliases,
                alias => foldedKey(alias) === foldedKey(text),
              )
                ? person.aliases
                : [...person.aliases, aliasKey(text)],
            }
          : person,
      )
      const problems = problemTexts(people)
      return Array.isReadonlyArrayEmpty(problems)
        ? startSave(model, people)
        : { model: modifyFields(model, { problems: () => problems }) }
    },
    ClickedIgnoreSuggestion: ({ text }) => {
      const ignored = Array.contains(model.ignored, text)
        ? model.ignored
        : [...model.ignored, text]
      return {
        model: withSuggestions(modifyFields(model, { ignored: () => ignored })),
        commands: [
          SaveIgnored({
            reportId: model.reportId,
            ownerId: model.ownerId,
            ignored,
          }),
        ],
      }
    },
    ClickedToggleImage: ({ imageId, safe }) =>
      canEditPeople(model) && !isBusy(model)
        ? {
            model: modifyFields(model, {
              maybeBusyImage: () => Option.some(imageId),
              maybeImageFailure: () => Option.none(),
            }),
            commands: [
              MarkImage({
                scope: pageScopeOf(model),
                imageId,
                safe,
                saveCounter: model.saveCounter,
                sectionIds: model.sectionIds,
              }),
            ],
          }
        : { model },
    SucceededMarkImage: ({ saveCounter, contents }) => ({
      model: withSuggestions(
        modifyFields(model, {
          contents: () => contents,
          saveCounter: () => saveCounter,
          maybeBusyImage: () => Option.none(),
        }),
      ),
    }),
    FailedMarkImage: ({ failure }) => ({
      model: modifyFields(model, {
        maybeBusyImage: () => Option.none(),
        maybeImageFailure: () => Option.some(failure),
      }),
    }),
  })

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  'scope' in message && !isCurrentPage(model, message.scope)
    ? { model }
    : updateCurrent(model, message)

// VIEW

const shell = (
  h: HtmlBuilder<Message>,
  model: Model,
  children: ReadonlyArray<Html>,
): Html =>
  h.section(
    [
      h.AriaLabel('People, names and pictures'),
      h.Class('flex max-w-3xl flex-col gap-8 pb-14 pt-10 md:pt-14'),
    ],
    [
      h.a(
        [
          h.Href(pathOf(AppRoute.Report({ reportId: model.reportId }))),
          h.Class(
            clsx('self-start text-base text-msf-ink underline', focusRing),
          ),
        ],
        ['Back to the report'],
      ),
      h.h1(
        [
          h.Id('page-heading'),
          h.Class(
            'text-balance text-4xl font-black tracking-[-0.025em] text-msf-black',
          ),
        ],
        ['People, names and pictures'],
      ),
      ...children,
    ],
  )

const problemList = (
  h: HtmlBuilder<Message>,
  problems: ReadonlyArray<string>,
): Html =>
  Array.match(problems, {
    onEmpty: () => h.empty,
    onNonEmpty: list =>
      h.ul(
        [h.Role('alert'), h.Class('flex flex-col gap-1')],
        Array.map(list, text =>
          h.li([h.Class('text-base font-medium text-msf-alert')], [text]),
        ),
      ),
  })

const personForm = (
  h: HtmlBuilder<Message>,
  model: Model,
  editing: Editing,
): Html =>
  h.form(
    [
      h.AriaLabel(editing.isNew ? 'Add a person' : 'Edit a person'),
      h.Class(
        'flex flex-col gap-4 border-l-2 border-msf-ink bg-msf-mist px-4 py-4',
      ),
      h.OnSubmit(Message.SubmittedPerson()),
    ],
    [
      h.h3(
        [h.Class('text-xl font-bold')],
        [editing.isNew ? 'Add a person' : 'Edit this person'],
      ),
      h.div(
        [h.Class('flex flex-col gap-2')],
        [
          h.label([h.Class(labelClassName), h.For('person-name')], ['Name']),
          h.input([
            h.Id('person-name'),
            h.Type('text'),
            h.Value(editing.name),
            h.Autocomplete('off'),
            h.Class(fieldClassName),
            h.OnInput(value => Message.TypedName({ value })),
          ]),
        ],
      ),
      h.div(
        [h.Class('flex flex-col gap-2')],
        [
          h.label(
            [h.Class(labelClassName), h.For('person-aliases')],
            ['Other names and spellings'],
          ),
          h.p(
            [h.Class('-mt-1 text-sm text-msf-grey')],
            [
              'One per line: nicknames, first name alone, spellings and typos. Each one is replaced like the name.',
            ],
          ),
          h.textarea([
            h.Id('person-aliases'),
            h.Value(editing.aliases),
            h.Class(clsx(fieldClassName, 'min-h-28')),
            h.OnInput(value => Message.TypedAliases({ value })),
          ]),
        ],
      ),
      h.div(
        [h.Class('flex flex-col gap-2')],
        [
          h.label(
            [h.Class(labelClassName), h.For('person-label')],
            ['Label reviewers read instead'],
          ),
          h.p(
            [h.Class('-mt-1 text-sm text-msf-grey')],
            ['Each person has their own label, such as "Person 1".'],
          ),
          h.input([
            h.Id('person-label'),
            h.Type('text'),
            h.Value(editing.label),
            h.Autocomplete('off'),
            h.Class(fieldClassName),
            h.OnInput(value => Message.TypedLabel({ value })),
          ]),
        ],
      ),
      problemList(h, model.problems),
      formStatus(h, model.form, 'Saving the list.'),
      h.div(
        [h.Class('flex flex-wrap gap-3')],
        [
          submitButton(
            h,
            editing.isNew ? 'Add this person' : 'Save this person',
            isSubmitting(model.form),
            'Saving…',
          ),
          actionButton(h, 'Cancel', 'Cancel', Message.ClickedCancelEdit()),
        ],
      ),
    ],
  )

const personRow = (
  h: HtmlBuilder<Message>,
  model: Model,
  person: Person,
  canEdit: boolean,
): Html =>
  h.keyed('li')(
    person.id,
    [h.Class('flex flex-col gap-2 py-4'), h.DataAttribute('person', person.id)],
    [
      h.p([h.Class('text-lg font-bold text-msf-black')], [person.name]),
      h.p(
        [h.Class('text-base text-msf-ink')],
        [`Reviewers read: ${person.label}`],
      ),
      h.p(
        [h.Class('text-base text-msf-grey')],
        [
          Array.match(person.aliases, {
            onEmpty: () => 'No other names or spellings.',
            onNonEmpty: aliases => `Also replaced: ${aliases.join(', ')}`,
          }),
        ],
      ),
      canEdit
        ? Option.match(model.maybeRemoving, {
            onSome: removing =>
              removing === person.id
                ? h.div(
                    [
                      h.Role('alertdialog'),
                      h.AriaLabel(`Remove ${person.name}`),
                      h.Class(
                        'flex flex-col gap-3 border-l-2 border-msf-alert bg-msf-mist px-4 py-3',
                      ),
                    ],
                    [
                      h.p(
                        [h.Class('text-base text-msf-ink')],
                        [
                          `Remove ${person.name}? Their name and spellings will no longer be replaced for reviewers of a redacted role, so they would read them as written.`,
                        ],
                      ),
                      h.div(
                        [h.Class('flex flex-wrap gap-2')],
                        [
                          actionButton(
                            h,
                            'Remove this person',
                            `Confirm removing ${person.name}`,
                            Message.ClickedConfirmRemove(),
                          ),
                          actionButton(
                            h,
                            'Keep',
                            `Keep ${person.name}`,
                            Message.ClickedKeepPerson(),
                          ),
                        ],
                      ),
                    ],
                  )
                : h.empty,
            onNone: () =>
              h.div(
                [h.Class('flex flex-wrap gap-2')],
                [
                  actionButton(
                    h,
                    'Edit',
                    `Edit ${person.name}`,
                    Message.ClickedEditPerson({ personId: person.id }),
                  ),
                  actionButton(
                    h,
                    'Remove',
                    `Remove ${person.name}`,
                    Message.ClickedRemovePerson({ personId: person.id }),
                  ),
                ],
              ),
          })
        : h.empty,
    ],
  )

const peoplePanel = (h: HtmlBuilder<Message>, model: Model): Html => {
  const canEdit = canEditPeople(model)
  return panel(
    h,
    'People',
    [
      Array.match(model.people, {
        onEmpty: () =>
          h.p(
            [h.Class('text-lg text-msf-grey')],
            ['No one is in the list yet. Nothing is replaced for reviewers.'],
          ),
        onNonEmpty: people =>
          h.ul(
            [
              h.AriaLabel('People of this report'),
              h.Class(
                'flex flex-col divide-y divide-msf-line border-y border-msf-line',
              ),
            ],
            Array.map(people, person => personRow(h, model, person, canEdit)),
          ),
      }),
      Option.match(model.maybeEditing, {
        onSome: editing => personForm(h, model, editing),
        onNone: () =>
          canEdit
            ? actionButton(
                h,
                'Add a person',
                'Add a person',
                Message.ClickedAddPerson(),
              )
            : h.p(
                [h.Class('text-base text-msf-grey')],
                ['This list cannot be changed now.'],
              ),
      }),
      Option.match(model.maybeEditing, {
        onSome: () => h.empty,
        onNone: () => problemList(h, model.problems),
      }),
      FormState.guards.Failed(model.form) && Option.isNone(model.maybeEditing)
        ? formStatus(h, model.form, 'Saving the list.')
        : h.empty,
      Option.match(model.maybeNotice, {
        onNone: () => h.empty,
        onSome: notice => statusText(h, notice),
      }),
    ],
    Option.some(
      'Every name and spelling here is replaced by its label for reviewers of a redacted role, in every text they can read. Matching ignores capitals and accents.',
    ),
  )
}

const suggestionRow = (
  h: HtmlBuilder<Message>,
  model: Model,
  suggestion: NameSuggestion,
): Html =>
  h.keyed('li')(
    suggestion.text,
    [h.Class('flex flex-col gap-3 py-4'), h.DataAttribute('suggestion', '')],
    [
      h.p(
        [h.Class('text-lg font-bold text-msf-black')],
        [`${suggestion.text} (${suggestion.count}×)`],
      ),
      h.div(
        [h.Class('flex flex-wrap items-center gap-2')],
        [
          actionButton(
            h,
            'Add as a new person',
            `Add ${suggestion.text} as a new person`,
            Message.ClickedSuggestionAsPerson({ text: suggestion.text }),
          ),
          Array.match(model.people, {
            onEmpty: () => h.empty,
            onNonEmpty: people =>
              h.select(
                [
                  h.AriaLabel(`Add ${suggestion.text} as an alias of`),
                  h.Value(''),
                  h.Class(clsx(fieldClassName, 'h-10 w-auto py-0')),
                  h.OnChange(personId =>
                    Message.ChoseAliasTarget({
                      text: suggestion.text,
                      personId,
                    }),
                  ),
                ],
                [
                  h.option(
                    [h.Value(''), h.Selected(true)],
                    ['Add as alias of…'],
                  ),
                  ...Array.map(people, person =>
                    h.option([h.Value(person.id)], [person.name]),
                  ),
                ],
              ),
          }),
          actionButton(
            h,
            'Ignore',
            `Ignore ${suggestion.text}`,
            Message.ClickedIgnoreSuggestion({ text: suggestion.text }),
          ),
        ],
      ),
    ],
  )

const suggestionsPanel = (h: HtmlBuilder<Message>, model: Model): Html =>
  panel(
    h,
    'Names to check',
    [
      Array.match(model.suggestions, {
        onEmpty: () =>
          h.p(
            [h.Class('text-lg text-msf-grey')],
            ['No other name found in the text.'],
          ),
        onNonEmpty: list =>
          h.ul(
            [
              h.AriaLabel('Names found in the text'),
              h.Class(
                'flex flex-col divide-y divide-msf-line border-y border-msf-line',
              ),
            ],
            Array.map(list, suggestion => suggestionRow(h, model, suggestion)),
          ),
      }),
    ],
    Option.some(
      'Words that look like names and are not in the list. This is a guess made in your browser, so also read the redacted version before sharing.',
    ),
  )

const pictureRow = (
  h: HtmlBuilder<Message>,
  model: Model,
  picture: Picture,
  index: number,
): Html => {
  const canEdit = canEditPeople(model)
  const busy = Option.isSome(model.maybeBusyImage)
  const element = imageElement.withMessage(h)
  return h.keyed('li')(
    picture.imageId,
    [
      h.Class('flex flex-col gap-3 py-4'),
      h.DataAttribute('image-id', picture.imageId),
      h.DataAttribute('safe', picture.safe ? 'true' : 'false'),
    ],
    [
      element([
        element.ImageId(picture.imageId),
        element.Report(model.reportId),
        element.Context(''),
        element.Alt(picture.alt),
        h.Class('block max-h-56 max-w-full border border-msf-line bg-msf-mist'),
      ]),
      h.p(
        [h.Class('text-base font-medium text-msf-ink')],
        [
          picture.alt === ''
            ? `Picture ${index + 1}`
            : `Picture ${index + 1}: ${picture.alt}`,
        ],
      ),
      h.p(
        [h.Class('text-base text-msf-grey')],
        [
          picture.safe
            ? 'Marked safe to share. Reviewers of a redacted role can see it. Withdrawing it takes effect at once, in every published revision.'
            : 'Not marked safe to share. Left out for reviewers of a redacted role.',
        ],
      ),
      canEdit
        ? h.button(
            [
              h.Type('button'),
              h.Disabled(busy),
              h.AriaPressed(picture.safe ? 'true' : 'false'),
              h.Class(
                clsx(
                  'inline-flex h-11 cursor-pointer items-center self-start border px-4 text-base font-medium disabled:cursor-not-allowed disabled:opacity-50',
                  picture.safe
                    ? 'border-msf-black bg-msf-black text-white'
                    : 'border-msf-ink text-msf-ink hover:border-msf-red hover:text-msf-red',
                  focusRing,
                ),
              ),
              h.OnClick(
                Message.ClickedToggleImage({
                  imageId: picture.imageId,
                  safe: !picture.safe,
                }),
              ),
            ],
            [
              picture.safe
                ? 'Withdraw now: stop sharing it'
                : 'Mark safe to share',
            ],
          )
        : h.empty,
    ],
  )
}

const picturesPanel = (h: HtmlBuilder<Message>, model: Model): Html => {
  const pictures = picturesOf(model.contents)
  return panel(
    h,
    'Pictures',
    [
      Array.match(pictures, {
        onEmpty: () =>
          h.p(
            [h.Class('text-lg text-msf-grey')],
            ['There are no pictures in this report.'],
          ),
        onNonEmpty: list =>
          h.ul(
            [
              h.AriaLabel('Pictures of this report'),
              h.Class(
                'flex flex-col divide-y divide-msf-line border-y border-msf-line',
              ),
            ],
            Array.map(list, (picture, index) =>
              pictureRow(h, model, picture, index),
            ),
          ),
      }),
      Option.match(model.maybeImageFailure, {
        onNone: () => h.empty,
        onSome: failure => alertText(h, failureText(failure)),
      }),
    ],
    Option.some(
      'A picture is left out of the redacted version until you mark it safe to share. It is the same mark as the one on the picture in the text.',
    ),
  )
}

const redactedLink = (h: HtmlBuilder<Message>, model: Model): Html =>
  h.p(
    [h.Class('text-base text-msf-ink')],
    [
      'To read the text as reviewers will, open ',
      h.a(
        [
          h.Href(pathOf(AppRoute.Report({ reportId: model.reportId }))),
          h.Class(clsx('underline', focusRing)),
        ],
        ['the report and choose the redacted version'],
      ),
      ', or the share page, which shows it before anything is shared.',
    ],
  )

const loadedView = (h: HtmlBuilder<Message>, model: Model): Html =>
  shell(h, model, [
    peoplePanel(h, model),
    suggestionsPanel(h, model),
    picturesPanel(h, model),
    redactedLink(h, model),
  ])

export const view = Submodel.defineView<Model, Message>((model, h) =>
  LoadState.match(model.load, {
    Loading: () => shell(h, model, [loadingText(h, 'Loading.')]),
    Failed: ({ failure }) =>
      shell(h, model, [
        failure._tag === 'NotAllowed'
          ? alertText(h, 'This report is not available to you.')
          : alertText(h, failureText(failure)),
        actionButton(h, 'Try again', 'Try again', Message.ClickedRetryLoad()),
      ]),
    Loaded: () => loadedView(h, model),
  }),
)
