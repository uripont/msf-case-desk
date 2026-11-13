import { Array, Option, Result, Schema, pipe } from 'effect'
import { Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import {
  type ApprovalRule,
  PublishChoices,
  type PublishTerms,
  type Selection,
  type Template,
  chooseParticipants,
  deadlineTooFar,
} from '@case-desk/domain'

import { fieldClassName, labelClassName } from '../style'
import { checkboxField, selectField } from './ui'
import { dateTextIn, zoneChoices, zonedTimeToEpoch } from './zoned'

// NOTE: The terms of a publication (D6, D12, D23): a deadline as a date, a
// time and a time zone, and for every reviewing role of the template either
// committees of the unit or individual people of its registry. The form is
// shared by the publishing screen and the share screen ("share and publish"),
// which load the choices and own the Command that sends the terms. The same
// rules the server applies (`chooseParticipants`) run here before anything is
// sent, so a choice that cannot meet an approval rule is refused with the
// reason in plain words; the server refuses it again.

const DAY_MS = 86_400_000
const DEFAULT_DEADLINE_DAYS = 7
const DEFAULT_DEADLINE_TIME = '18:00'

export const RoleSelection = Schema.Struct({
  committeeIds: Schema.Array(Schema.String),
  accountIds: Schema.Array(Schema.String),
})
export type RoleSelection = typeof RoleSelection.Type

export const Model = Schema.Struct({
  date: Schema.String,
  time: Schema.String,
  timeZone: Schema.String,
  selections: Schema.Record(Schema.String, RoleSelection),
})
export type Model = typeof Model.Type

export const initialModel = Model.make({
  date: '',
  time: DEFAULT_DEADLINE_TIME,
  timeZone: '',
  selections: {},
})

// NOTE: A week from now, at 18:00 on the author's own wall clock, in the
// author's own zone. The time and the zone are values the Command read.
export const defaultsFor = (nowMs: number, timeZone: string): Model =>
  Model.make({
    date: dateTextIn(nowMs + DEFAULT_DEADLINE_DAYS * DAY_MS, timeZone),
    time: DEFAULT_DEADLINE_TIME,
    timeZone,
    selections: {},
  })

export const Message = defineMessageUnion({
  TypedDate: { value: Schema.String },
  TypedTime: { value: Schema.String },
  ChoseTimeZone: { value: Schema.String },
  ToggledCommittee: { roleId: Schema.String, committeeId: Schema.String },
  ToggledPerson: { roleId: Schema.String, accountId: Schema.String },
})
export type Message = typeof Message.Type

const EMPTY_SELECTION: RoleSelection = { committeeIds: [], accountIds: [] }

const selectionOf = (model: Model, roleId: string): RoleSelection =>
  model.selections[roleId] ?? EMPTY_SELECTION

const toggled = (
  list: ReadonlyArray<string>,
  id: string,
): ReadonlyArray<string> =>
  Array.contains(list, id)
    ? Array.filter(list, other => other !== id)
    : [...list, id]

const withSelection = (
  model: Model,
  roleId: string,
  next: RoleSelection,
): Model =>
  modifyFields(model, { selections: all => ({ ...all, [roleId]: next }) })

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    TypedDate: ({ value }) => ({
      model: modifyFields(model, { date: () => value }),
    }),
    TypedTime: ({ value }) => ({
      model: modifyFields(model, { time: () => value }),
    }),
    ChoseTimeZone: ({ value }) => ({
      model: modifyFields(model, { timeZone: () => value }),
    }),
    ToggledCommittee: ({ roleId, committeeId }) => {
      const current = selectionOf(model, roleId)
      return {
        model: withSelection(
          model,
          roleId,
          modifyFields(current, {
            committeeIds: ids => toggled(ids, committeeId),
          }),
        ),
      }
    },
    ToggledPerson: ({ roleId, accountId }) => {
      const current = selectionOf(model, roleId)
      return {
        model: withSelection(
          model,
          roleId,
          modifyFields(current, { accountIds: ids => toggled(ids, accountId) }),
        ),
      }
    },
  })

// QUERIES

export type FormContext = Readonly<{
  template: Template
  unit: string
  authors: ReadonlyArray<string>
  choices: typeof PublishChoices.Type
  nowMs: number
}>

export const peopleChosenFor = (
  model: Model,
  context: FormContext,
  roleId: string,
): ReadonlyArray<string> => {
  const selection = selectionOf(model, roleId)
  const fromCommittees = Array.flatMap(selection.committeeIds, committeeId =>
    pipe(
      Array.findFirst(context.choices.committees, c => c.id === committeeId),
      Option.match({
        onNone: () => [],
        onSome: committee => Array.map(committee.members, member => member.id),
      }),
    ),
  )
  return Array.dedupe([...fromCommittees, ...selection.accountIds])
}

const selectionsOf = (
  model: Model,
  context: FormContext,
): ReadonlyArray<Selection> =>
  Array.map(context.choices.roles, role => {
    const selection = selectionOf(model, role.roleId)
    return {
      roleId: role.roleId,
      sources: [
        ...Array.map(selection.committeeIds, committeeId => ({
          kind: 'committee' as const,
          committeeId,
        })),
        ...Array.map(selection.accountIds, accountId => ({
          kind: 'account' as const,
          accountId,
        })),
      ],
    }
  })

const roleName = (context: FormContext, roleId: string | undefined): string =>
  pipe(
    Array.findFirst(context.choices.roles, role => role.roleId === roleId),
    Option.match({ onNone: () => '', onSome: role => `${role.name}: ` }),
  )

// NOTE: Why the choices cannot be published yet, in the words of the domain,
// each with the role it is about. Empty when the choices meet every rule.
export const choiceProblems = (
  model: Model,
  context: FormContext,
): ReadonlyArray<string> =>
  Result.match(
    chooseParticipants(
      {
        template: context.template,
        unit: context.unit,
        authors: context.authors,
        registry: Array.map(context.choices.reviewers, person => person.id),
        committees: Array.map(context.choices.committees, committee => ({
          id: committee.id,
          unit: context.unit,
          members: Array.map(committee.members, member => member.id),
        })),
      },
      selectionsOf(model, context),
    ),
    {
      onSuccess: () => [],
      onFailure: problems =>
        Array.map(
          problems,
          problem => `${roleName(context, problem.roleId)}${problem.message}`,
        ),
    },
  )

export const needsRedactionPreview = (
  model: Model,
  context: FormContext,
): boolean =>
  Array.some(
    context.choices.roles,
    role =>
      role.view === 'redacted' &&
      Array.isReadonlyArrayNonEmpty(
        peopleChosenFor(model, context, role.roleId),
      ),
  )

// NOTE: The terms to send, or the reasons there are none yet.
export const termsOf = (
  model: Model,
  context: FormContext,
): Result.Result<PublishTerms, ReadonlyArray<string>> => {
  const deadline = zonedTimeToEpoch(model.date, model.time, model.timeZone)
  if (Option.isNone(deadline)) {
    return Result.fail<ReadonlyArray<string>>([
      'Enter the deadline as a date, a time and a time zone.',
    ])
  }
  if (deadline.value <= context.nowMs) {
    return Result.fail<ReadonlyArray<string>>([
      'The deadline must be in the future.',
    ])
  }
  if (deadlineTooFar(deadline.value, context.nowMs)) {
    return Result.fail<ReadonlyArray<string>>([
      'The deadline can be at most one year ahead.',
    ])
  }
  const problems = choiceProblems(model, context)
  return Array.isReadonlyArrayNonEmpty(problems)
    ? Result.fail<ReadonlyArray<string>>(problems)
    : Result.succeed<PublishTerms>({
        deadline: { at: deadline.value, timeZone: model.timeZone },
        selections: selectionsOf(model, context),
        closing: context.choices.closingRequired,
      })
}

// VIEW

export const ruleText = (rule: ApprovalRule | undefined): string =>
  rule === undefined
    ? 'This role comments but does not vote.'
    : rule.kind === 'all'
      ? 'Approval rule: every person chosen must approve.'
      : rule.kind === 'majority'
        ? 'Approval rule: more than half of the people chosen must approve.'
        : `Approval rule: at least ${rule.count} of the people chosen must approve.`

const viewText = (view: 'full' | 'redacted'): string =>
  view === 'full'
    ? 'Reads the original text, with the real names.'
    : 'Reads only the redacted text, with the names replaced.'

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`

const deadlineFields = <M>(
  h: HtmlBuilder<M>,
  model: Model,
  toMessage: (message: Message) => M,
): Html =>
  h.fieldset(
    [h.Class('flex flex-col gap-4')],
    [
      h.legend([h.Class('text-xl font-black text-msf-black')], ['Deadline']),
      h.div(
        [h.Class('grid grid-cols-1 gap-4 sm:grid-cols-2')],
        [
          h.div(
            [h.Class('flex flex-col gap-2')],
            [
              h.label(
                [h.Class(labelClassName), h.For('publish-date')],
                ['Date'],
              ),
              h.input([
                h.Id('publish-date'),
                h.Type('date'),
                h.Value(model.date),
                h.Class(fieldClassName),
                h.OnInput(value => toMessage(Message.TypedDate({ value }))),
              ]),
            ],
          ),
          h.div(
            [h.Class('flex flex-col gap-2')],
            [
              h.label(
                [h.Class(labelClassName), h.For('publish-time')],
                ['Time'],
              ),
              h.input([
                h.Id('publish-time'),
                h.Type('time'),
                h.Value(model.time),
                h.Class(fieldClassName),
                h.OnInput(value => toMessage(Message.TypedTime({ value }))),
              ]),
            ],
          ),
        ],
      ),
      selectField(
        h,
        'publish-zone',
        'Time zone',
        model.timeZone,
        Array.map(zoneChoices(model.timeZone), zone => ({
          value: zone,
          label: zone,
        })),
        value => toMessage(Message.ChoseTimeZone({ value })),
      ),
      h.p(
        [h.Class('text-base text-msf-grey')],
        [
          'Reviewers see the deadline on their own clock. The message sent on WhatsApp names the deadline in this time zone.',
        ],
      ),
    ],
  )

const roleSection = <M>(
  h: HtmlBuilder<M>,
  model: Model,
  context: FormContext,
  role: (typeof PublishChoices.Type)['roles'][number],
  toMessage: (message: Message) => M,
): Html => {
  const selection = selectionOf(model, role.roleId)
  const chosen = peopleChosenFor(model, context, role.roleId)
  return h.fieldset(
    [
      h.Class('flex flex-col gap-3 border-t-2 border-msf-ink pt-4'),
      h.DataAttribute('role-id', role.roleId),
    ],
    [
      h.legend([h.Class('text-xl font-black text-msf-black')], [role.name]),
      h.p([h.Class('text-base text-msf-ink')], [viewText(role.view)]),
      h.p([h.Class('text-base text-msf-ink')], [ruleText(role.rule)]),
      Array.match(context.choices.committees, {
        onEmpty: () => h.empty,
        onNonEmpty: committees =>
          h.div(
            [h.Class('flex flex-col gap-2')],
            [
              h.p(
                [h.Class('text-base font-medium text-msf-grey')],
                ['Committees'],
              ),
              ...Array.map(committees, committee =>
                checkboxField(
                  h,
                  `publish-${role.roleId}-c-${committee.id}`,
                  committee.name,
                  Array.contains(selection.committeeIds, committee.id),
                  toMessage(
                    Message.ToggledCommittee({
                      roleId: role.roleId,
                      committeeId: committee.id,
                    }),
                  ),
                  Option.some(
                    plural(committee.members.length, 'person', 'people'),
                  ),
                ),
              ),
            ],
          ),
      }),
      Array.match(context.choices.reviewers, {
        onEmpty: () =>
          h.p(
            [h.Class('text-base text-msf-grey')],
            ['The unit has no registered reviewers yet.'],
          ),
        onNonEmpty: people =>
          h.div(
            [h.Class('flex flex-col gap-2')],
            [
              h.p([h.Class('text-base font-medium text-msf-grey')], ['People']),
              ...Array.map(people, person =>
                checkboxField(
                  h,
                  `publish-${role.roleId}-p-${person.id}`,
                  person.name,
                  Array.contains(selection.accountIds, person.id),
                  toMessage(
                    Message.ToggledPerson({
                      roleId: role.roleId,
                      accountId: person.id,
                    }),
                  ),
                ),
              ),
            ],
          ),
      }),
      h.p(
        [
          h.Role('status'),
          h.Class('text-base font-medium text-msf-ink'),
          h.DataAttribute('chosen', String(chosen.length)),
        ],
        [`${plural(chosen.length, 'person', 'people')} chosen.`],
      ),
    ],
  )
}

export const view = <M>(
  h: HtmlBuilder<M>,
  model: Model,
  context: FormContext,
  toMessage: (message: Message) => M,
): Html =>
  h.div(
    [h.Class('flex min-w-0 flex-col gap-6')],
    [
      deadlineFields(h, model, toMessage),
      ...Array.map(context.choices.roles, role =>
        roleSection(h, model, context, role, toMessage),
      ),
    ],
  )
