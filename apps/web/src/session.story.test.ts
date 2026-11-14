import { Option } from 'effect'
import { modifyFields } from 'foldkit/struct'
import { describe, expect, test } from 'vitest'

import { SYNTHETIC_ME, signedInModel, urlOf } from './fixtures'
import { Message, Session, update } from './main'

// NOTE: Stage 10a. A session that ends keeps what the screens hold and asks for
// the password again at the same address; Escape answers an open question.

describe('a session that ends', () => {
  const working = modifyFields(
    update(signedInModel, Message.ChangedUrl({ url: urlOf('/reports') })).model,
    {
      names: names =>
        modifyFields(names, { maybeRemoving: () => Option.some('person-1') }),
    },
  )

  test('shows the sign-in at the same address and keeps the screens', () => {
    const ended = update(working, Message.EndedSession()).model
    expect(ended.session).toEqual(Session.SignedOut())
    expect(ended.route).toEqual(working.route)
    expect(ended.names).toEqual(working.names)
    expect(ended.maybeEndedFor).toEqual(Option.some(SYNTHETIC_ME.id))
    expect(ended.loginForm.email).toBe(SYNTHETIC_ME.email)
  })

  test('the same account signing in again keeps the screens as they are', () => {
    const ended = update(working, Message.EndedSession()).model
    const back = update(ended, Message.SucceededSignIn({ me: SYNTHETIC_ME }))
    expect(back.model.session).toEqual(Session.SignedIn({ me: SYNTHETIC_ME }))
    expect(back.model.names).toEqual(working.names)
    expect(back.model.maybeEndedFor).toEqual(Option.none())
  })

  test('another account signing in starts from empty screens', () => {
    const ended = update(working, Message.EndedSession()).model
    const other = { ...SYNTHETIC_ME, id: 'someone-else' }
    const back = update(ended, Message.SucceededSignIn({ me: other })).model
    expect(back.maybeEndedFor).toEqual(Option.none())
    expect(back.names.maybeRemoving).toEqual(Option.none())
  })

  test('a signed-out app does not end a second time', () => {
    const ended = update(working, Message.EndedSession()).model
    expect(update(ended, Message.EndedSession()).model).toEqual(ended)
  })
})

describe('Escape', () => {
  test('closes the question about leaving a report and stays', () => {
    const asked = modifyFields(signedInModel, {
      maybeLeaving: () =>
        Option.some({ url: urlOf('/reports'), isWaiting: false }),
    })
    const escaped = update(asked, Message.PressedEscape())
    expect(escaped.model.maybeLeaving).toEqual(Option.none())
  })

  test('does nothing when no question is open', () => {
    expect(update(signedInModel, Message.PressedEscape()).model).toEqual(
      signedInModel,
    )
  })
})
