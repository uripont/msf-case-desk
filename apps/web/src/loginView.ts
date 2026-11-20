import { clsx } from 'clsx'
import { Option, Redacted } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import { LoginSubmission, Message, type Model } from './main'
import { failureText } from './quoroom/failure'
import { PAGE_HEADING_ID } from './quoroom/ui'
import { fieldClassName, labelClassName, primaryButtonClassName } from './style'

export const loginPage = (model: Model, h: HtmlBuilder<Message>): Html => {
  const { loginForm } = model
  const isSubmitting = LoginSubmission.guards.Submitting(loginForm.submission)

  return h.section(
    [
      h.AriaLabel('Sign in'),
      h.Class('flex max-w-md flex-col gap-8 pb-14 pt-12 md:pb-20 md:pt-16'),
    ],
    [
      h.div(
        [h.Class('flex flex-col gap-3')],
        [
          h.h1(
            [
              h.Id(PAGE_HEADING_ID),
              h.Class(
                'text-4xl font-black leading-[1.05] tracking-[-0.025em] text-brand-ink sm:text-5xl',
              ),
            ],
            ['Sign in'],
          ),
          Option.match(model.maybeEndedFor, {
            onNone: () =>
              h.p(
                [h.Class('text-pretty text-lg font-light text-brand-ink')],
                [
                  'Quoroom is where reports are written, reviewed and approved. Use the account you were given.',
                ],
              ),
            onSome: () =>
              h.p(
                [
                  h.Role('status'),
                  h.Class('text-pretty text-lg font-medium text-brand-ink'),
                ],
                [
                  'Your session has ended. Sign in again to carry on where you were. What you were writing is kept.',
                ],
              ),
          }),
        ],
      ),
      h.form(
        [h.Class('flex flex-col gap-5'), h.OnSubmit(Message.SubmittedLogin())],
        [
          h.label(
            [h.Class(labelClassName), h.For('login-email')],
            [
              'E-mail',
              h.input([
                h.Id('login-email'),
                h.Type('email'),
                h.Name('email'),
                h.Autocomplete('username'),
                h.Required(true),
                h.Value(loginForm.email),
                h.Class(fieldClassName),
                h.OnInput(value => Message.UpdatedLoginEmail({ value })),
              ]),
            ],
          ),
          h.label(
            [h.Class(labelClassName), h.For('login-password')],
            [
              'Password',
              h.input([
                h.Id('login-password'),
                h.Type('password'),
                h.Name('password'),
                h.Autocomplete('current-password'),
                h.Required(true),
                h.Value(Redacted.value(loginForm.password)),
                h.Class(fieldClassName),
                h.OnInput(value =>
                  Message.UpdatedLoginPassword({ value: Redacted.make(value) }),
                ),
              ]),
            ],
          ),
          LoginSubmission.match(loginForm.submission, {
            NotSubmitted: () => h.empty,
            Submitting: () => h.empty,
            Rejected: ({ failure }) =>
              h.p(
                [
                  h.Role('alert'),
                  h.Class('text-base font-medium text-brand-alert'),
                ],
                [failureText(failure)],
              ),
          }),
          h.button(
            [
              h.Type('submit'),
              h.Disabled(isSubmitting),
              h.Class(clsx(primaryButtonClassName, 'self-start')),
            ],
            [isSubmitting ? 'Signing in…' : 'Sign in'],
          ),
        ],
      ),
    ],
  )
}
