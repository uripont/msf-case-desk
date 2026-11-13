import { Option, Redacted } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'

import { SYNTHETIC_ME } from './fixtures'
import {
  FocusElement,
  LoadDesk,
  Message,
  Place,
  ReadLocation,
  ReturnToRoot,
  Session,
  init,
  initialModel,
  update,
} from './main'
import {
  ADMIN_ME,
  AUTHOR_ME,
  SYNTHETIC_TOKEN,
  SYNTHETIC_UNIT,
  adminModel,
  authorModel,
  linkPageModel,
} from './quoroom.fixtures'
import * as Account from './quoroom/account'
import * as Admin from './quoroom/admin'
import { Failure } from './quoroom/failure'
import * as Link from './quoroom/link'
import * as Unit from './quoroom/unit'

const linkPlace = (maybeToken: Option.Option<Redacted.Redacted<string>>) =>
  Place.LinkPage({ maybeToken })

const strongPassword = Redacted.make('a-long-synthetic-password')

type Step = ReturnType<typeof update>

const namesOf = (step: Step): ReadonlyArray<string> =>
  (step.commands ?? []).map(command => command.name)

const run = (
  start: typeof initialModel,
  messages: ReadonlyArray<Message>,
): Step =>
  messages.reduce<Step>((previous, next) => update(previous.model, next), {
    model: start,
  })

const linkMessage = (message: Link.Message) =>
  Message.GotLinkMessage({ message })
const adminMessage = (message: Admin.Message) =>
  Message.GotAdminMessage({ message })
const unitMessage = (message: Unit.Message) =>
  Message.GotUnitMessage({ message })

const inspectedAs = (purpose: 'activate' | 'reset') =>
  run(linkPageModel(linkPlace(Option.some(SYNTHETIC_TOKEN))), [
    linkMessage(
      Link.Message.SucceededInspectLink({
        info: {
          purpose,
          name: SYNTHETIC_ME.name,
          email: SYNTHETIC_ME.email,
          expiresAt: 1_000,
        },
      }),
    ),
  ]).model

describe('opening a link', () => {
  test('starting the app also reads the address', () => {
    expect(init().commands?.map(command => command.name)).toContain(
      ReadLocation.name,
    )
  })

  test('an ordinary address leaves the link screen closed', () => {
    const opened = update(
      initialModel,
      Message.CompletedReadLocation({
        origin: 'https://quoroom.test',
        place: Place.Elsewhere(),
      }),
    )
    expect(Option.isNone(opened.model.maybeLink)).toBe(true)
    expect(opened.model.origin).toBe('https://quoroom.test')
  })

  test('a link address opens the link screen and checks the token', () => {
    const opened = update(
      initialModel,
      Message.CompletedReadLocation({
        origin: 'https://quoroom.test',
        place: linkPlace(Option.some(SYNTHETIC_TOKEN)),
      }),
    )
    expect(Option.isSome(opened.model.maybeLink)).toBe(true)
    expect(namesOf(opened)).toEqual([Link.InspectLink.name])
  })

  test('a link address without a token reads as an unusable link', () => {
    const opened = linkPageModel(linkPlace(Option.none()))
    expect(Option.map(opened.maybeLink, link => link.state._tag)).toEqual(
      Option.some('Unusable'),
    )
  })

  test('the token is never held as plain text', () => {
    const opened = linkPageModel(linkPlace(Option.some(SYNTHETIC_TOKEN)))
    expect(JSON.stringify(opened)).not.toContain(
      Redacted.value(SYNTHETIC_TOKEN),
    )
  })

  test('a used or expired link is reported as unusable', () => {
    const failed = run(linkPageModel(linkPlace(Option.some(SYNTHETIC_TOKEN))), [
      linkMessage(
        Link.Message.FailedInspectLink({ failure: Failure.LinkInvalid() }),
      ),
    ])
    expect(Option.map(failed.model.maybeLink, link => link.state)).toEqual(
      Option.some(Link.LinkState.Unusable({ failure: Failure.LinkInvalid() })),
    )
  })

  test('setting a password signs in, loads the desk and clears the address', () => {
    story(
      update,
      given(inspectedAs('activate')),
      message(
        linkMessage(Link.Message.UpdatedPassword({ value: strongPassword })),
      ),
      message(
        linkMessage(
          Link.Message.UpdatedConfirmation({ value: strongPassword }),
        ),
      ),
      message(linkMessage(Link.Message.SubmittedPassword())),
      Command.resolve(
        Link.ConsumeLink,
        Link.Message.SucceededConsumeLink({ me: SYNTHETIC_ME }),
      ),
      model(next => {
        expect(next.session).toEqual(Session.SignedIn({ me: SYNTHETIC_ME }))
        expect(Option.isNone(next.maybeLink)).toBe(true)
      }),
      Command.expectHas(LoadDesk()),
      Command.expectHas(ReturnToRoot()),
      Command.resolve(
        LoadDesk,
        Message.SucceededLoadDesk({ cases: [], ruleSets: [] }),
      ),
      Command.resolve(ReturnToRoot, Message.CompletedReturnToRoot()),
    )
  })

  test('a password that does not match is refused before it is sent', () => {
    const typed = run(inspectedAs('reset'), [
      linkMessage(Link.Message.UpdatedPassword({ value: strongPassword })),
      linkMessage(
        Link.Message.UpdatedConfirmation({
          value: Redacted.make('a-different-password'),
        }),
      ),
      linkMessage(Link.Message.SubmittedPassword()),
    ])
    expect(namesOf(typed)).toEqual([])
    expect(
      Option.map(typed.model.maybeLink, link => link.submission._tag),
    ).toEqual(Option.some('Invalid'))
  })

  test('a link that fails when the password is sent is reported', () => {
    const failed = run(inspectedAs('activate'), [
      linkMessage(
        Link.Message.FailedConsumeLink({ failure: Failure.LinkInvalid() }),
      ),
    ])
    expect(Option.map(failed.model.maybeLink, link => link.submission)).toEqual(
      Option.some(Link.Submission.Rejected({ failure: Failure.LinkInvalid() })),
    )
  })
})

describe('the new pages load when entered', () => {
  test('the account page loads the account', () => {
    expect(
      namesOf(update(adminModel, Message.ClickedPage({ page: 'Account' }))),
    ).toEqual(
      expect.arrayContaining([Account.LoadAccount.name, FocusElement.name]),
    )
  })

  test('the administration page loads units and accounts', () => {
    expect(
      namesOf(update(adminModel, Message.ClickedPage({ page: 'Admin' }))),
    ).toContain(Admin.LoadAdmin.name)
  })

  test('the unit page loads the units of the author', () => {
    expect(
      namesOf(update(authorModel, Message.ClickedPage({ page: 'Unit' }))),
    ).toContain(Unit.LoadUnits.name)
  })

  test('signing out forgets the new pages', () => {
    const entered = run(adminModel, [
      Message.ClickedPage({ page: 'Admin' }),
      adminMessage(
        Admin.Message.SucceededLoadAdmin({
          units: [SYNTHETIC_UNIT],
          accounts: [],
        }),
      ),
      Message.ClickedSignOut(),
    ]).model
    expect(entered.admin).toEqual(Admin.initialModel)
    expect(entered.unit).toEqual(Unit.initialModel)
    expect(entered.account).toEqual(Account.initialModel)
  })
})

const adminLoaded = run(adminModel, [
  Message.ClickedPage({ page: 'Admin' }),
  adminMessage(
    Admin.Message.SucceededLoadAdmin({ units: [SYNTHETIC_UNIT], accounts: [] }),
  ),
]).model

const activationLink = {
  purpose: 'activate',
  token: Redacted.value(SYNTHETIC_TOKEN),
  expiresAt: 5_000,
} as const

describe('the administrator', () => {
  test('a unit with no name is refused before it is sent', () => {
    const submitted = run(adminLoaded, [
      adminMessage(Admin.Message.SubmittedUnit()),
    ])
    expect(namesOf(submitted)).toEqual([])
    expect(submitted.model.admin.unitForm._tag).toBe('Invalid')
  })

  test('creating a unit adds it to the list', () => {
    story(
      update,
      given(adminLoaded),
      message(
        adminMessage(Admin.Message.UpdatedUnitName({ value: 'Second Unit' })),
      ),
      message(adminMessage(Admin.Message.UpdatedUnitCode({ value: 'SEC' }))),
      message(adminMessage(Admin.Message.SubmittedUnit())),
      Command.resolve(
        Admin.CreateUnit,
        Admin.Message.SucceededCreateUnit({
          unit: { id: 'unit-2', name: 'Second Unit', code: 'SEC' },
        }),
      ),
      model(next => {
        expect(next.admin.units.map(unit => unit.code)).toEqual(['SYN', 'SEC'])
      }),
    )
  })

  test('granting to a new person shows the link once and never stores it as text', () => {
    story(
      update,
      given(adminLoaded),
      message(
        adminMessage(
          Admin.Message.UpdatedGrantEmail({ value: 'new@case-desk.test' }),
        ),
      ),
      message(
        adminMessage(Admin.Message.UpdatedGrantName({ value: 'New Author' })),
      ),
      message(adminMessage(Admin.Message.SubmittedGrant())),
      Command.resolve(
        Admin.GrantCapability,
        Admin.Message.SucceededGrantCapability({
          result: {
            account: {
              id: 'account-9',
              email: 'new@case-desk.test',
              name: 'New Author',
              active: true,
              grants: [{ capability: 'author', unit: SYNTHETIC_UNIT.id }],
            },
            link: activationLink,
          },
        }),
      ),
      model(next => {
        expect(Option.isSome(next.admin.maybeLink)).toBe(true)
        expect(JSON.stringify(next)).not.toContain(
          Redacted.value(SYNTHETIC_TOKEN),
        )
      }),
    )
  })

  test('granting to someone who has an account makes no link', () => {
    const granted = run(adminLoaded, [
      adminMessage(
        Admin.Message.SucceededGrantCapability({
          result: {
            account: {
              id: 'account-9',
              email: 'known@case-desk.test',
              name: 'Known Person',
              active: true,
              grants: [{ capability: 'admin' }],
            },
          },
        }),
      ),
    ]).model
    expect(Option.isNone(granted.admin.maybeLink)).toBe(true)
    expect(Option.isSome(granted.admin.maybeNotice)).toBe(true)
  })

  test('issuing a reset link shows it for copying', () => {
    const issued = run(adminLoaded, [
      adminMessage(
        Admin.Message.SucceededIssueReset({
          name: 'Known Person',
          link: { ...activationLink, purpose: 'reset' },
        }),
      ),
    ]).model
    expect(Option.map(issued.admin.maybeLink, link => link.purpose)).toEqual(
      Option.some('reset'),
    )
  })
})

const unitLoaded = run(authorModel, [
  Message.ClickedPage({ page: 'Unit' }),
  unitMessage(Unit.Message.SucceededLoadUnits({ units: [SYNTHETIC_UNIT] })),
]).model

const typedReviewer = (extra: ReadonlyArray<Unit.Message>): Step =>
  run(unitLoaded, [
    ...[
      Unit.Message.UpdatedReviewerName({ value: 'Rae Viewer' }),
      Unit.Message.UpdatedReviewerEmail({ value: 'rae@case-desk.test' }),
      ...extra,
      Unit.Message.SubmittedReviewer(),
    ].map(unitMessage),
  ])

describe('the author', () => {
  test('the first unit is chosen and its people are loaded', () => {
    const chosen = update(
      update(authorModel, Message.ClickedPage({ page: 'Unit' })).model,
      unitMessage(Unit.Message.SucceededLoadUnits({ units: [SYNTHETIC_UNIT] })),
    )
    expect(chosen.model.unit.selectedUnit).toBe(SYNTHETIC_UNIT.id)
    expect(namesOf(chosen)).toEqual([Unit.LoadUnitData.name])
  })

  test('inviting a new person shows the link and reloads the unit', () => {
    const invited = run(unitLoaded, [
      unitMessage(Unit.Message.UpdatedInviteName({ value: 'Second Author' })),
      unitMessage(
        Unit.Message.UpdatedInviteEmail({ value: 'second@case-desk.test' }),
      ),
      unitMessage(Unit.Message.SubmittedInvite()),
    ])
    expect(namesOf(invited)).toEqual([Unit.InviteToUnit.name])
    const accepted = update(
      invited.model,
      unitMessage(
        Unit.Message.SucceededInviteToUnit({
          name: 'Second Author',
          result: {
            account: { id: 'account-8', name: 'Second Author' },
            link: activationLink,
          },
        }),
      ),
    )
    expect(Option.isSome(accepted.model.unit.maybeLink)).toBe(true)
    expect(namesOf(accepted)).toEqual([Unit.LoadUnitData.name])
  })

  test('inviting an existing e-mail gives no link, only a notice', () => {
    const invited = run(unitLoaded, [
      unitMessage(
        Unit.Message.SucceededInviteToUnit({
          name: 'Known Person',
          result: { account: { id: 'account-7', name: 'Known Person' } },
        }),
      ),
    ]).model
    expect(Option.isNone(invited.unit.maybeLink)).toBe(true)
    expect(Option.isSome(invited.unit.maybeNotice)).toBe(true)
  })

  test('a number needs its country code', () => {
    const typed = typedReviewer([
      Unit.Message.UpdatedReviewerPhone({ value: '600 000 000' }),
    ])
    expect(namesOf(typed)).toEqual([])
    expect(typed.model.unit.reviewerForm._tag).toBe('Invalid')
  })

  test('asking for consent needs a number', () => {
    const typed = typedReviewer([Unit.Message.ToggledReviewerConsent()])
    expect(namesOf(typed)).toEqual([])
    expect(typed.model.unit.reviewerForm._tag).toBe('Invalid')
  })

  test('registering a reviewer sends the number and the consent request', () => {
    const typed = typedReviewer([
      Unit.Message.UpdatedReviewerPhone({ value: '+34 600 000 000' }),
      Unit.Message.ToggledReviewerConsent(),
    ])
    expect(typed.model.unit.reviewerForm._tag).toBe('Submitting')
    expect(namesOf(typed)).toEqual([Unit.AddReviewer.name])
    expect(typed.commands?.[0]?.args).toEqual({
      unit: SYNTHETIC_UNIT.id,
      name: 'Rae Viewer',
      email: 'rae@case-desk.test',
      phone: Option.some('+34600000000'),
      whatsappConsent: true,
    })
  })

  test('a committee member can be toggled', () => {
    const committee = {
      id: 'committee-1',
      unit: SYNTHETIC_UNIT.id,
      name: 'Synthetic Committee',
      memberIds: ['account-3'],
      retired: false,
    }
    const toggled = run(unitLoaded, [
      unitMessage(Unit.Message.SucceededCreateCommittee({ committee })),
      unitMessage(
        Unit.Message.ToggledCommitteeMember({
          committeeId: committee.id,
          accountId: 'account-4',
        }),
      ),
    ])
    expect(namesOf(toggled)).toEqual([Unit.UpdateCommittee.name])
    expect(toggled.commands?.[0]?.args).toEqual({
      committeeId: committee.id,
      memberIds: Option.some(['account-3', 'account-4']),
      retired: Option.none(),
    })
  })
})

describe('the person', () => {
  test('consent stays off until the person turns it on', () => {
    const loaded = run(adminModel, [
      Message.GotAccountMessage({
        message: Account.Message.SucceededLoadAccount({ me: ADMIN_ME }),
      }),
    ]).model
    expect(loaded.account.whatsappConsent).toBe(false)
    expect(AUTHOR_ME.profile.whatsappConsent).toBe(false)
  })
})
