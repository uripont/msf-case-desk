import {
  Command,
  expect,
  given,
  role,
  scene,
  submit,
  text,
  type,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import { SYNTHETIC_ME, configuredAt } from './fixtures'
import { Message, SignIn, update } from './main'
import { ADMIN_ME } from './quoroom.fixtures'
import { Failure } from './quoroom/failure'
import * as Review from './quoroom/review'
import { view } from './view'

const signedOutAt = (path: string) =>
  update(configuredAt(path), Message.FailedCheckSession()).model

describe('a deep link opened signed out', () => {
  test('asks to sign in, then shows the screen of the link', () => {
    scene(
      { update, view },
      given(signedOutAt('/r/rep-1/rev/2')),
      expect(role('heading', { name: 'Sign in' })).toExist(),
      expect(role('heading', { name: 'Revision 2' })).toBeAbsent(),
      type(role('textbox', { name: 'E-mail' }), SYNTHETIC_ME.email),
      type(role('textbox', { name: 'Password' }), 'synthetic-password'),
      submit(role('form')),
      Command.resolve(SignIn, Message.SucceededSignIn({ me: SYNTHETIC_ME })),
      expect(role('heading', { name: 'Sign in' })).toBeAbsent(),
      expect(role('heading', { name: 'Revision 2' })).toExist(),
      Command.resolve(
        Review.LoadReview,
        Review.Message.FailedLoadReview({
          scope: { reportId: 'rep-1', generation: 2 },
          failure: Failure.NotAllowed(),
        }),
      ),
      expect(
        text('This revision is not available to you.', { exact: false }),
      ).toExist(),
    )
  })

  test('an address with no screen says so after sign-in', () => {
    scene(
      { update, view },
      given(
        update(
          configuredAt('/nowhere'),
          Message.SucceededCheckSession({ me: SYNTHETIC_ME }),
        ).model,
      ),
      expect(role('heading', { name: 'Page not found' })).toExist(),
    )
  })
})

describe('navigation', () => {
  test('each entry is a real link to its address', () => {
    scene(
      { update, view },
      given(
        update(
          configuredAt('/'),
          Message.SucceededCheckSession({ me: ADMIN_ME }),
        ).model,
      ),
      expect(role('link', { name: 'Home' })).toHaveAttr('href', '/'),
      expect(role('link', { name: 'Administration' })).toHaveAttr(
        'href',
        '/admin',
      ),
      expect(role('link', { name: 'My account' })).toHaveAttr(
        'href',
        '/account',
      ),
      expect(role('link', { name: 'Home' })).toHaveAttr(
        'aria-current',
        'page',
      ),
    )
  })
})
