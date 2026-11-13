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

import { PILOT_CONFIG, SYNTHETIC_ME, configuredAt } from './fixtures'
import { LoadDesk, Message, SignIn, update } from './main'
import { ADMIN_ME } from './quoroom.fixtures'
import { view } from './view'

const signedOutAt = (path: string) =>
  update(configuredAt(path), Message.FailedCheckSession()).model

describe('a deep link opened signed out', () => {
  test('asks to sign in, then shows the screen of the link', () => {
    scene(
      { update, view },
      given(signedOutAt('/r/rep-1/rev/2')),
      expect(role('heading', { name: 'Sign in' })).toExist(),
      expect(role('heading', { name: 'Revision' })).toBeAbsent(),
      type(role('textbox', { name: 'E-mail' }), SYNTHETIC_ME.email),
      type(role('textbox', { name: 'Password' }), 'synthetic-password'),
      submit(role('form')),
      Command.resolve(SignIn, Message.SucceededSignIn({ me: SYNTHETIC_ME })),
      Command.resolve(
        LoadDesk,
        Message.SucceededLoadDesk({ cases: [], ruleSets: [] }),
      ),
      expect(role('heading', { name: 'Sign in' })).toBeAbsent(),
      expect(role('heading', { name: 'Revision' })).toExist(),
      expect(text('Revision 2 of report rep-1', { exact: false })).toExist(),
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
      expect(role('link', { name: 'Cases' })).toHaveAttr('href', '/'),
      expect(role('link', { name: 'New case' })).toHaveAttr(
        'href',
        '/new-case',
      ),
      expect(role('link', { name: 'Rules' })).toHaveAttr('href', '/rules'),
      expect(role('link', { name: 'Administration' })).toHaveAttr(
        'href',
        '/admin',
      ),
      expect(role('link', { name: 'My account' })).toHaveAttr(
        'href',
        '/account',
      ),
      expect(role('link', { name: 'Cases' })).toHaveAttr(
        'aria-current',
        'page',
      ),
    )
  })
})

describe('the pilot', () => {
  const pilotAt = (path: string) =>
    update(
      configuredAt(path, PILOT_CONFIG),
      Message.SucceededCheckSession({ me: ADMIN_ME }),
    ).model

  test('hides the triage screens from the navigation', () => {
    scene(
      { update, view },
      given(pilotAt('/')),
      expect(role('link', { name: 'Home' })).toExist(),
      expect(role('link', { name: 'Cases' })).toBeAbsent(),
      expect(role('link', { name: 'New case' })).toBeAbsent(),
      expect(role('link', { name: 'Rules' })).toBeAbsent(),
      expect(role('link', { name: 'Administration' })).toExist(),
      expect(role('heading', { name: 'Welcome to Quoroom' })).toExist(),
      expect(role('navigation', { name: 'Operational centre' })).toBeAbsent(),
    )
  })

  test('answers a triage address with a page that is not available', () => {
    scene(
      { update, view },
      given(pilotAt('/new-case')),
      expect(role('heading', { name: 'This page is not available' })).toExist(),
      expect(role('heading', { name: 'New case' })).toBeAbsent(),
    )
  })
})
