import { clsx } from 'clsx'
import { Match, Redacted } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import { type SignInRejection } from './api'
import { LoginSubmission, Message, type Model } from './main'
import { fieldClassName, labelClassName, primaryButtonClassName } from './style'

const rejectionText = (rejection: SignInRejection): string =>
  Match.value(rejection).pipe(
    Match.when(
      'InvalidCredentials',
      () => 'That e-mail and password do not match an account.',
    ),
    Match.when(
      'Unavailable',
      () => 'The case desk did not answer. Try again in a moment.',
    ),
    Match.exhaustive,
  )

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
              h.Class(
                'text-4xl font-black leading-[1.05] tracking-[-0.025em] text-msf-black sm:text-5xl',
              ),
            ],
            ['Sign in'],
          ),
          h.p(
            [h.Class('text-pretty text-lg font-light text-msf-ink')],
            [
              'Case Desk is for the people who assess and decide cases. Use the account the team gave you.',
            ],
          ),
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
            Rejected: ({ rejection }) =>
              h.p(
                [
                  h.Role('alert'),
                  h.Class('text-base font-medium text-msf-red'),
                ],
                [rejectionText(rejection)],
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
