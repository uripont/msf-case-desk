import { expect, given, role, scene, text } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { signedInModel } from './fixtures'
import { initialModel, update } from './main'
import { view } from './view'

describe('scene', () => {
  test('the home screen welcomes a signed-in account', () => {
    scene(
      { update, view },
      given(signedInModel),
      expect(role('heading', { name: 'Welcome to Quoroom' })).toExist(),
      expect(role('link', { name: 'Home' })).toHaveAttr('href', '/'),
    )
  })

  test('the footer names the product and the organisation of the theme', () => {
    scene(
      { update, view },
      given(signedInModel),
      expect(
        text('Quoroom, a reporting system for Your organisation.'),
      ).toExist(),
      expect(
        text('developed at Universitat Pompeu Fabra', { exact: false }),
      ).toExist(),
      expect(role('img')).toBeAbsent(),
    )
  })

  test('the session check shows a quiet opening state', () => {
    scene(
      { update, view },
      given(initialModel),
      expect(role('heading', { name: 'Opening Quoroom' })).toExist(),
      expect(role('heading', { name: 'Sign in' })).toBeAbsent(),
    )
  })
})
