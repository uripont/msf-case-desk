import { clsx } from 'clsx'
import { Array, Match, Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import {
  RULE_SET_SCOPES,
  type RuleSetScope,
  priorityLabel,
} from '@case-desk/domain'

import { type ApiFailure } from './api'
import { formatInstant } from './format'
import { Message, type Model } from './main'
import {
  type RulesErrors,
  type RulesField,
  RulesSubmission,
  ownRuleSetOf,
  previewOfRules,
  rulesErrorsOf,
} from './rulesForm'
import {
  fieldClassName,
  focusRing,
  labelClassName,
  primaryButtonClassName,
  textButtonClassName,
} from './style'

const scopeLabel = (scope: RuleSetScope): string =>
  scope === 'Default' ? 'Default' : scope

const failureText = (failure: ApiFailure): string =>
  Match.value(failure).pipe(
    Match.when(
      'SignInRequired',
      () => 'Your session has ended. Sign in again.',
    ),
    Match.when('Unavailable', () => 'The rules could not be saved. Try again.'),
    Match.exhaustive,
  )

const scopeTab = (
  model: Model,
  scope: RuleSetScope,
  h: HtmlBuilder<Message>,
): Html => {
  const isActive = model.rulesForm.scope === scope
  return h.button(
    [
      h.Class(
        clsx(
          'relative inline-flex h-11 shrink-0 cursor-pointer items-center whitespace-nowrap text-base transition-colors after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-msf-ink',
          isActive
            ? 'font-medium text-msf-ink after:bg-msf-red'
            : 'text-msf-grey after:bg-transparent hover:text-msf-ink hover:after:bg-msf-line',
        ),
      ),
      h.AriaPressed(isActive ? 'true' : 'false'),
      h.OnClick(Message.SelectedRulesScope({ scope })),
    ],
    [scopeLabel(scope)],
  )
}

const numberField = (
  model: Model,
  errors: RulesErrors,
  field: RulesField,
  label: string,
  suffix: string,
  h: HtmlBuilder<Message>,
): Html => {
  const id = `rules-${field}`
  const errorId = `${id}-error`
  const maybeError = Option.fromNullishOr(errors[field])
  return h.div(
    [h.Class('flex flex-col gap-2')],
    [
      h.label([h.Class(labelClassName), h.For(id)], [label]),
      h.div(
        [h.Class('flex items-center gap-3')],
        [
          h.input([
            h.Id(id),
            h.Type('number'),
            h.Min('1'),
            h.Value(model.rulesForm[field]),
            h.Class(clsx(fieldClassName, 'max-w-32 tabular-nums')),
            ...Option.match(maybeError, {
              onNone: () => [h.AriaInvalid(false)],
              onSome: () => [h.AriaInvalid(true), h.AriaDescribedBy(errorId)],
            }),
            h.OnInput(value => Message.UpdatedRulesField({ field, value })),
          ]),
          h.span([h.Class('text-base text-msf-grey')], [suffix]),
        ],
      ),
      Option.match(maybeError, {
        onNone: () => h.empty,
        onSome: error =>
          h.p(
            [h.Id(errorId), h.Class('text-base font-medium text-msf-red')],
            [error],
          ),
      }),
    ],
  )
}

const preview = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.aside(
    [
      h.AriaLabel('Effect on open cases'),
      h.AriaLive('polite'),
      h.Class(
        'flex flex-col gap-4 border-t-2 border-msf-ink pt-4 lg:sticky lg:top-10 lg:self-start',
      ),
    ],
    Option.match(previewOfRules(model.rulesForm, model.ruleSets, model.cases), {
      onNone: () => [
        h.p(
          [h.Class('text-base text-msf-grey')],
          [
            'Fix the highlighted fields to see how these rules would group the open cases.',
          ],
        ),
      ],
      onSome: ({ affectedCases, groups, moved }) => [
        h.p(
          [h.Class('text-base text-msf-grey')],
          [
            `These rules decide ${affectedCases} open ${affectedCases === 1 ? 'case' : 'cases'}. Now and with your changes:`,
          ],
        ),
        h.table(
          [h.Class('w-full border-collapse text-left text-base tabular-nums')],
          [
            h.thead(
              [],
              [
                h.tr(
                  [h.Class('border-b border-msf-line text-msf-grey')],
                  [
                    h.th([h.Class('py-2 font-normal')], ['Group']),
                    h.th([h.Class('py-2 text-right font-normal')], ['Now']),
                    h.th(
                      [h.Class('py-2 text-right font-normal')],
                      ['With changes'],
                    ),
                  ],
                ),
              ],
            ),
            h.tbody(
              [],
              Array.map(groups, ({ priority, before, after }) =>
                h.tr(
                  [h.Class('border-b border-msf-line')],
                  [
                    h.th(
                      [h.Class('py-2 font-medium capitalize')],
                      [priorityLabel(priority)],
                    ),
                    h.td([h.Class('py-2 text-right')], [String(before)]),
                    h.td(
                      [
                        h.Class(
                          clsx(
                            'py-2 text-right',
                            before !== after && 'font-medium text-msf-red',
                          ),
                        ),
                      ],
                      [String(after)],
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
        Array.match(moved, {
          onEmpty: () =>
            h.p(
              [h.Class('text-base text-msf-grey')],
              ['No case changes group.'],
            ),
          onNonEmpty: rows =>
            h.ul(
              [h.Class('m-0 flex list-none flex-col gap-2 p-0 text-base')],
              Array.map(rows, ({ triageCase, before, after }) =>
                h.li(
                  [],
                  [
                    h.span(
                      [h.Class('tabular-nums text-msf-grey')],
                      [`${triageCase.id} `],
                    ),
                    `moves from ${priorityLabel(before)} to ${priorityLabel(after)}`,
                  ],
                ),
              ),
            ),
        }),
      ],
    }),
  )

export const rulesPage = (model: Model, h: HtmlBuilder<Message>): Html => {
  const form = model.rulesForm
  const errors = form.isShowingErrors
    ? rulesErrorsOf(form)
    : rulesErrorsOf(form)
  const isSaving = RulesSubmission.guards.Saving(form.submission)
  const versionError = Option.fromNullishOr(errors.version)

  return h.section(
    [
      h.AriaLabel('Triage rules'),
      h.Class('flex flex-col gap-10 pb-14 pt-12 md:pt-16'),
    ],
    [
      h.div(
        [h.Class('flex flex-col gap-3')],
        [
          h.h1(
            [
              h.Class(
                'text-4xl font-black leading-[1.05] tracking-[-0.025em] text-msf-black sm:text-5xl',
              ),
            ],
            ['Triage rules'],
          ),
          h.p(
            [h.Class('max-w-2xl text-pretty text-lg font-light text-msf-ink')],
            [
              'Each operational centre can set its own thresholds and targets. Centres without their own rules use the default ones. The points for each factor stay the same.',
            ],
          ),
        ],
      ),
      h.nav(
        [
          h.AriaLabel('Rule set'),
          h.Class(
            '-mx-5 flex gap-x-6 overflow-x-auto border-b border-msf-line px-5 [scrollbar-width:none] sm:mx-0 sm:px-0 md:gap-x-7',
          ),
        ],
        Array.map(RULE_SET_SCOPES, scope => scopeTab(model, scope, h)),
      ),
      h.p(
        [h.Class('text-base text-msf-grey')],
        [
          Option.match(ownRuleSetOf(model.ruleSets, form.scope), {
            onNone: () =>
              form.scope === 'Default'
                ? 'The default rules have not been changed yet.'
                : `${form.scope} uses the default rules. Saving creates its own.`,
            onSome: ruleSet =>
              `Last changed ${formatInstant(ruleSet.updatedAt)}${ruleSet.updatedByName === '' ? '' : ` by ${ruleSet.updatedByName}`}.`,
          }),
        ],
      ),
      h.div(
        [
          h.Class(
            'grid gap-12 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:gap-20',
          ),
        ],
        [
          h.form(
            [
              h.Class('flex flex-col gap-8'),
              h.OnSubmit(Message.SubmittedRules()),
            ],
            [
              h.fieldset(
                [h.Class('flex flex-col gap-5 border-0 p-0')],
                [
                  h.legend([h.Class('pb-2 text-xl font-medium')], ['Groups']),
                  numberField(
                    model,
                    errors,
                    'p1MinScore',
                    'Urgent from',
                    'points of 10',
                    h,
                  ),
                  numberField(
                    model,
                    errors,
                    'p2MinScore',
                    'Medium from',
                    'points of 10',
                    h,
                  ),
                ],
              ),
              h.fieldset(
                [h.Class('flex flex-col gap-5 border-0 p-0')],
                [
                  h.legend(
                    [h.Class('pb-2 text-xl font-medium')],
                    ['Time to assess'],
                  ),
                  numberField(
                    model,
                    errors,
                    'fastTrackHours',
                    'Fast-track',
                    'hours',
                    h,
                  ),
                  numberField(model, errors, 'targetP1', 'Urgent', 'hours', h),
                  numberField(model, errors, 'targetP2', 'Medium', 'hours', h),
                  numberField(
                    model,
                    errors,
                    'targetP3',
                    'Standard',
                    'hours',
                    h,
                  ),
                ],
              ),
              h.div(
                [h.Class('flex flex-col gap-2')],
                [
                  h.label(
                    [h.Class(labelClassName), h.For('rules-version')],
                    ['Version name'],
                  ),
                  h.input([
                    h.Id('rules-version'),
                    h.Type('text'),
                    h.Value(form.version),
                    h.Class(clsx(fieldClassName, 'max-w-sm')),
                    h.AriaInvalid(Option.isSome(versionError)),
                    h.OnInput(value =>
                      Message.UpdatedRulesField({ field: 'version', value }),
                    ),
                  ]),
                  Option.match(versionError, {
                    onNone: () => h.empty,
                    onSome: error =>
                      h.p(
                        [h.Class('text-base font-medium text-msf-red')],
                        [error],
                      ),
                  }),
                ],
              ),
              RulesSubmission.match(form.submission, {
                Editing: () => h.empty,
                Saving: () => h.empty,
                Saved: () =>
                  h.p(
                    [
                      h.Role('status'),
                      h.Class('text-base font-medium text-msf-ink'),
                    ],
                    [
                      `Saved. New and existing ${form.scope === 'Default' ? '' : `${form.scope} `}cases now use these rules.`,
                    ],
                  ),
                Failed: ({ failure }) =>
                  h.p(
                    [
                      h.Role('alert'),
                      h.Class('text-base font-medium text-msf-red'),
                    ],
                    [failureText(failure)],
                  ),
              }),
              h.div(
                [h.Class('flex flex-wrap items-center gap-6')],
                [
                  h.button(
                    [
                      h.Type('submit'),
                      h.Disabled(isSaving),
                      h.Class(primaryButtonClassName),
                    ],
                    [
                      isSaving
                        ? 'Saving…'
                        : `Save ${scopeLabel(form.scope)} rules`,
                    ],
                  ),
                  h.button(
                    [
                      h.Type('button'),
                      h.Class(
                        clsx('text-base', textButtonClassName, focusRing),
                      ),
                      h.OnClick(Message.ClickedDiscardRules()),
                    ],
                    ['Discard changes'],
                  ),
                ],
              ),
            ],
          ),
          preview(model, h),
        ],
      ),
    ],
  )
}
