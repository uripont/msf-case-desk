import { Option, Redacted } from 'effect'
import {
  Command,
  click,
  expect,
  given,
  role,
  scene,
  text,
  type,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import { SYNTHETIC_ME, atPage } from './fixtures'
import { Message, update } from './main'
import {
  SYNTHETIC_TOKEN,
  SYNTHETIC_UNIT,
  adminModel,
  authorModel,
  linkPageModel,
  signedInAs,
  withGrants,
} from './quoroom.fixtures'
import * as Account from './quoroom/account'
import { Failure } from './quoroom/failure'
import { givenLinkOf } from './quoroom/issuedLink'
import * as Link from './quoroom/link'
import * as People from './quoroom/people'
import * as Unit from './quoroom/unit'
import { view } from './view'

const openedLink = linkPageModel(Option.some(SYNTHETIC_TOKEN))

const activationInfo = {
  purpose: 'activate',
  name: SYNTHETIC_ME.name,
  email: SYNTHETIC_ME.email,
  expiresAt: 1_000,
} as const

const readyLink = update(
  openedLink,
  Message.GotLinkMessage({
    message: Link.Message.SucceededInspectLink({ info: activationInfo }),
  }),
).model

const unusableLink = update(
  openedLink,
  Message.GotLinkMessage({
    message: Link.Message.FailedInspectLink({ failure: Failure.LinkInvalid() }),
  }),
).model

const enteredPage = (
  start: typeof adminModel,
  page: Parameters<typeof atPage>[1],
  messages: ReadonlyArray<Message>,
) =>
  messages.reduce(
    (model, next) => update(model, next).model,
    atPage(start, page),
  )

describe('link scene', () => {
  test('a link that works asks for a password, with no sign-in form', () => {
    scene(
      { update, view },
      given(readyLink),
      expect(role('heading', { name: 'Set your password' })).toExist(),
      expect(role('textbox', { name: 'E-mail' })).toBeAbsent(),
      expect(role('button', { name: 'Set password and sign in' })).toExist(),
    )
  })

  test('a link that is used, expired or unknown says so', () => {
    scene(
      { update, view },
      given(unusableLink),
      expect(role('heading', { name: 'This link does not work' })).toExist(),
      expect(role('alert')).toContainText('used, has expired or is not valid'),
    )
  })

  test('two different passwords are refused', () => {
    scene(
      { update, view },
      given(readyLink),
      type(
        role('textbox', { name: 'New password' }),
        'a-long-synthetic-password',
      ),
      type(role('textbox', { name: 'Type it again' }), 'another-synthetic-one'),
      click(role('button', { name: 'Set password and sign in' })),
      expect(role('alert')).toExist(),
    )
  })
})

describe('navigation scene', () => {
  test('each permission is a tab, and the name opens the account', () => {
    scene(
      { update, view },
      given(adminModel),
      expect(role('link', { name: 'Home' })).toExist(),
      expect(role('link', { name: 'People' })).toExist(),
      expect(role('link', { name: 'Theme' })).toExist(),
      expect(role('link', { name: 'Templates' })).toExist(),
      expect(role('link', { name: 'Reports' })).toBeAbsent(),
      expect(
        role('link', { name: `${SYNTHETIC_ME.name}, my account` }),
      ).toHaveAttr('href', '/account'),
    )
    scene(
      { update, view },
      given(authorModel),
      expect(role('link', { name: 'Reports' })).toExist(),
      expect(role('link', { name: 'People' })).toBeAbsent(),
      expect(role('link', { name: 'Your reports' })).toExist(),
    )
  })

  test('a reviewer sees only Home, with the inbox and the notifications', () => {
    scene(
      { update, view },
      given(signedInAs(withGrants([]))),
      expect(role('link', { name: 'Home' })).toExist(),
      expect(role('link', { name: 'Reports' })).toBeAbsent(),
      expect(role('link', { name: 'Templates' })).toBeAbsent(),
      expect(role('link', { name: 'People' })).toBeAbsent(),
      expect(role('link', { name: 'Theme' })).toBeAbsent(),
      expect(role('heading', { name: 'Inbox' })).toExist(),
      expect(role('heading', { name: 'Notifications' })).toExist(),
    )
  })
})

const PERSON = {
  id: 'account-2',
  email: 'ana@case-desk.test',
  name: 'Ana Example',
  active: true,
  passwordSetAt: 1_000,
  grants: [{ capability: 'author' as const, unit: SYNTHETIC_UNIT.id }],
  reviewerIn: [],
}

const REVIEWER = {
  id: 'account-3',
  email: 'rui@case-desk.test',
  name: 'Rui Reviewer',
  active: true,
  grants: [],
  reviewerIn: [SYNTHETIC_UNIT.id],
}

const peoplePage = (accounts: ReadonlyArray<typeof PERSON | typeof REVIEWER>) =>
  enteredPage(adminModel, 'People', [
    Message.GotPeopleMessage({
      message: People.Message.SucceededLoadPeople({
        units: [SYNTHETIC_UNIT],
        accounts,
      }),
    }),
  ])

describe('people scene', () => {
  test('a unit folder holds its authors and, greyed, its reviewers', () => {
    scene(
      { update, view },
      given(peoplePage([PERSON, REVIEWER])),
      expect(role('heading', { name: 'People', level: 1 })).toExist(),
      expect(
        role('checkbox', { name: 'Reports in Synthetic Unit for Ana Example' }),
      ).toBeChecked(),
      expect(role('checkbox', { name: 'People for Ana Example', checked: false })).toExist(),
      expect(text('Reviewer')).toExist(),
      expect(role('checkbox', { name: 'People for Rui Reviewer' })).toBeAbsent(),
      expect(text('Invited, not activated yet')).toExist(),
      click(role('button', { name: /Synthetic Unit/ })),
      expect(role('checkbox', { name: 'People for Ana Example' })).toBeAbsent(),
    )
  })

  test('a toggle saves at once, and goes back when the save fails', () => {
    scene(
      { update, view },
      given(peoplePage([PERSON])),
      click(role('checkbox', { name: 'Theme for Ana Example' })),
      expect(role('checkbox', { name: 'Theme for Ana Example' })).toBeDisabled(),
      expect(role('checkbox', { name: 'Theme for Ana Example' })).toBeChecked(),
      Command.resolve(
        People.ChangeCapability,
        People.Message.FailedChangeCapability({
          key: People.toggleKey(PERSON.id, 'theme', Option.none()),
          failure: Failure.NotAllowed(),
        }),
      ),
      expect(role('checkbox', { name: 'Theme for Ana Example', checked: false })).toExist(),
      expect(role('alert')).toExist(),
    )
  })

  test('a new unit is created on the same page', () => {
    scene(
      { update, view },
      given(peoplePage([])),
      type(role('textbox', { name: 'Unit name' }), 'Synthetic Unit'),
      type(role('textbox', { name: 'Unit code' }), 'SYN'),
      click(role('button', { name: 'Create unit' })),
      Command.resolve(
        People.CreateUnit,
        People.Message.SucceededCreateUnit({ unit: SYNTHETIC_UNIT }),
      ),
      expect(text('Synthetic Unit (SYN)')).toExist(),
    )
  })

  test('an added person comes with a one-time link', () => {
    scene(
      { update, view },
      given(peoplePage([])),
      type(role('textbox', { name: 'E-mail' }), PERSON.email),
      type(role('textbox', { name: 'Name' }), PERSON.name),
      click(role('checkbox', { name: 'Templates' })),
      click(role('button', { name: 'Add person' })),
      Command.resolve(
        People.AddPerson,
        People.Message.SucceededAddPerson({
          account: PERSON,
          link: Option.some(
            givenLinkOf({
              purpose: 'activate',
              token: Redacted.value(SYNTHETIC_TOKEN),
              expiresAt: 5_000,
            }),
          ),
        }),
      ),
      expect(role('heading', { name: 'One-time link' })).toExist(),
      expect(role('textbox', { name: 'Link' })).toHaveValue(
        `https://quoroom.test/link#${Redacted.value(SYNTHETIC_TOKEN)}`,
      ),
    )
  })
})

describe('unit scene', () => {
  test('inviting someone who has an account says so, with no link', () => {
    scene(
      { update, view },
      given(
        enteredPage(authorModel, 'Unit', [
          Message.GotUnitMessage({
            message: Unit.Message.SucceededLoadUnits({
              units: [SYNTHETIC_UNIT],
            }),
          }),
          Message.GotUnitMessage({
            message: Unit.Message.SucceededLoadUnitData({
              unit: SYNTHETIC_UNIT.id,
              members: [],
              reviewers: [],
              committees: [],
            }),
          }),
        ]),
      ),
      type(role('textbox', { name: 'Name' }), 'Known Person'),
      type(role('textbox', { name: 'E-mail' }), 'known@case-desk.test'),
      click(role('button', { name: 'Invite' })),
      Command.resolve(
        Unit.InviteToUnit,
        Unit.Message.SucceededInviteToUnit({
          name: 'Known Person',
          link: Option.none(),
        }),
      ),
      Command.resolve(
        Unit.LoadUnitData,
        Unit.Message.SucceededLoadUnitData({
          unit: SYNTHETIC_UNIT.id,
          members: [],
          reviewers: [],
          committees: [],
        }),
      ),
      expect(role('status')).toContainText('already has an account'),
      expect(role('heading', { name: 'One-time link' })).toBeAbsent(),
    )
  })

  test('a reviewer is registered with a number and a consent request', () => {
    scene(
      { update, view },
      given(
        enteredPage(authorModel, 'Unit', [
          Message.GotUnitMessage({
            message: Unit.Message.SucceededLoadUnits({
              units: [SYNTHETIC_UNIT],
            }),
          }),
          Message.GotUnitMessage({
            message: Unit.Message.SucceededLoadUnitData({
              unit: SYNTHETIC_UNIT.id,
              members: [],
              reviewers: [],
              committees: [],
            }),
          }),
        ]),
      ),
      type(role('textbox', { name: 'Reviewer name' }), 'Rae Viewer'),
      type(role('textbox', { name: 'Reviewer e-mail' }), 'rae@case-desk.test'),
      type(
        role('textbox', { name: 'Reviewer phone number' }),
        '+34 600 000 000',
      ),
      click(role('checkbox', { name: 'Ask for WhatsApp consent' })),
      click(role('button', { name: 'Register reviewer' })),
      Command.resolve(
        Unit.AddReviewer,
        Unit.Message.SucceededAddReviewer({
          name: 'Rae Viewer',
          link: Option.none(),
        }),
      ),
      Command.resolve(
        Unit.LoadUnitData,
        Unit.Message.SucceededLoadUnitData({
          unit: SYNTHETIC_UNIT.id,
          members: [],
          reviewers: [
            {
              accountId: 'account-6',
              unit: SYNTHETIC_UNIT.id,
              name: 'Rae Viewer',
              email: 'rae@case-desk.test',
              phone: '+34600000000',
              consentRequested: true,
              active: true,
            },
          ],
          committees: [],
        }),
      ),
      expect(text('Rae Viewer', { exact: false })).toExist(),
    )
  })
})

describe('account scene', () => {
  test('consent needs a number, and only the person can give it', () => {
    scene(
      { update, view },
      given(
        enteredPage(authorModel, 'Account', [
          Message.GotAccountMessage({
            message: Account.Message.SucceededLoadAccount({ me: SYNTHETIC_ME }),
          }),
        ]),
      ),
      click(
        role('checkbox', {
          name: 'I agree to receive messages from Quoroom on WhatsApp at this number',
        }),
      ),
      click(role('button', { name: 'Save preferences' })),
      expect(role('alert')).toExist(),
    )
  })

  test('the approval notice is off until chosen', () => {
    scene(
      { update, view },
      given(
        enteredPage(authorModel, 'Account', [
          Message.GotAccountMessage({
            message: Account.Message.SucceededLoadAccount({ me: SYNTHETIC_ME }),
          }),
        ]),
      ),
      expect(
        role('checkbox', {
          name: 'Tell me about each single approval of my reports',
        }),
      ).not.toBeChecked(),
    )
  })
})
