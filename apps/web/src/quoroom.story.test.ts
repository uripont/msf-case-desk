import { Option, Redacted } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'

import { SYNTHETIC_ME, clickedPage, openedAt } from './fixtures'
import {
  FocusElement,
  LoadConfig,
  Message,
  ReplaceUrl,
  Session,
  initialModel,
  update,
} from './main'
import {
  ADMIN_ME,
  SYNTHETIC_TOKEN,
  SYNTHETIC_UNIT,
  adminModel,
  authorModel,
  linkPageModel,
} from './quoroom.fixtures'
import * as Account from './quoroom/account'
import { Failure } from './quoroom/failure'
import * as Inbox from './quoroom/inbox'
import { givenLinkOf } from './quoroom/issuedLink'
import * as Link from './quoroom/link'
import * as Notifications from './quoroom/notifications'
import * as People from './quoroom/people'
import * as Unit from './quoroom/unit'

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
const peopleMessage = (message: People.Message) =>
  Message.GotPeopleMessage({ message })
const unitMessage = (message: Unit.Message) =>
  Message.GotUnitMessage({ message })

const inspectedAs = (purpose: 'activate' | 'reset') =>
  run(linkPageModel(Option.some(SYNTHETIC_TOKEN)), [
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
  test('an ordinary address leaves the link screen closed', () => {
    const opened = openedAt('/')
    expect(Option.isNone(opened.model.maybeLink)).toBe(true)
    expect(opened.model.origin).toBe('https://quoroom.test')
  })

  test('a link address opens the link screen, checks the token and removes the fragment', () => {
    const opened = openedAt(`/link#${Redacted.value(SYNTHETIC_TOKEN)}`)
    expect(Option.isSome(opened.model.maybeLink)).toBe(true)
    expect(namesOf(opened)).toEqual(
      expect.arrayContaining([
        Link.InspectLink.name,
        ReplaceUrl.name,
        LoadConfig.name,
      ]),
    )
    expect(
      opened.commands?.find(c => c.name === ReplaceUrl.name)?.args,
    ).toEqual({
      url: '/link',
    })
  })

  test('a link address without a token reads as an unusable link', () => {
    const opened = linkPageModel(Option.none())
    expect(Option.map(opened.maybeLink, link => link.state._tag)).toEqual(
      Option.some('Unusable'),
    )
  })

  test('the token is never held as plain text', () => {
    const opened = linkPageModel(Option.some(SYNTHETIC_TOKEN))
    expect(JSON.stringify(opened)).not.toContain(
      Redacted.value(SYNTHETIC_TOKEN),
    )
  })

  test('a used or expired link is reported as unusable', () => {
    const failed = run(linkPageModel(Option.some(SYNTHETIC_TOKEN)), [
      linkMessage(
        Link.Message.FailedInspectLink({ failure: Failure.LinkInvalid() }),
      ),
    ])
    expect(Option.map(failed.model.maybeLink, link => link.state)).toEqual(
      Option.some(Link.LinkState.Unusable({ failure: Failure.LinkInvalid() })),
    )
  })

  test('setting a password signs in and clears the address', () => {
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
      Command.expectHas(ReplaceUrl({ url: '/' })),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
      Command.resolve(
        Inbox.LoadInbox,
        Inbox.Message.SucceededLoadInbox({
          scope: { reportId: '', generation: 1 },
          page: { items: [] },
          zone: 'Europe/Madrid',
          nowMs: 0,
        }),
      ),
      Command.resolve(
        Notifications.LoadNotifications,
        Notifications.Message.SucceededLoadNotifications({
          scope: { reportId: '', generation: 1 },
          page: { items: [], unread: 0 },
          zone: 'Europe/Madrid',
          nowMs: 0,
        }),
      ),
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
    expect(namesOf(update(adminModel, clickedPage('Account')))).toEqual(
      expect.arrayContaining([Account.LoadAccount.name, FocusElement.name]),
    )
  })

  test('the People page loads units and accounts', () => {
    expect(namesOf(update(adminModel, clickedPage('People')))).toContain(
      People.LoadPeople.name,
    )
  })

  test('the unit page loads the units of the author', () => {
    expect(namesOf(update(authorModel, clickedPage('Unit')))).toContain(
      Unit.LoadUnits.name,
    )
  })

  test('signing out forgets the new pages', () => {
    const entered = run(adminModel, [
      clickedPage('People'),
      peopleMessage(
        People.Message.SucceededLoadPeople({
          units: [SYNTHETIC_UNIT],
          accounts: [],
        }),
      ),
      Message.ClickedSignOut(),
    ]).model
    expect(entered.people).toEqual(People.initialModel)
    expect(entered.unit).toEqual(Unit.initialModel)
    expect(entered.account).toEqual(Account.initialModel)
  })
})

const KNOWN = {
  id: 'account-9',
  email: 'known@case-desk.test',
  name: 'Known Person',
  active: true,
  grants: [{ capability: 'people' as const }],
  reviewerIn: [],
}

const peopleLoaded = run(adminModel, [
  clickedPage('People'),
  peopleMessage(
    People.Message.SucceededLoadPeople({
      units: [SYNTHETIC_UNIT],
      accounts: [KNOWN],
    }),
  ),
]).model

const activationLink = {
  purpose: 'activate',
  token: Redacted.value(SYNTHETIC_TOKEN),
  expiresAt: 5_000,
} as const

describe('link tokens in Messages', () => {
  const token = Redacted.value(SYNTHETIC_TOKEN)

  test('a link the server issued is Redacted in every Message that carries one', () => {
    const given = givenLinkOf(activationLink)
    const reset = People.Message.SucceededIssueReset({
      name: 'Known Person',
      link: given,
    })
    const messages = [
      reset,
      People.Message.SucceededAddPerson({
        account: KNOWN,
        link: Option.some(given),
      }),
      Unit.Message.SucceededInviteToUnit({
        name: 'Second Author',
        link: Option.some(given),
      }),
      Unit.Message.SucceededAddReviewer({
        name: 'Second Reviewer',
        link: Option.some(given),
      }),
    ]
    for (const message of messages) {
      expect(JSON.stringify(message)).not.toContain(token)
      expect(String(message)).not.toContain(token)
    }
    expect(JSON.stringify(given)).not.toContain(token)
    // NOTE: the Model still gets the usable link, Redacted too.
    const issued = run(peopleLoaded, [peopleMessage(reset)]).model
    expect(
      Option.map(issued.people.maybeLink, link => Redacted.value(link.url)),
    ).toEqual(Option.some(`https://quoroom.test/link#${token}`))
    expect(JSON.stringify(issued.people.maybeLink)).not.toContain(token)
  })
})

describe('the People screen', () => {
  test('a unit with no name is refused before it is sent', () => {
    const submitted = run(peopleLoaded, [
      peopleMessage(People.Message.SubmittedUnit()),
    ])
    expect(namesOf(submitted)).toEqual([])
    expect(submitted.model.people.unitForm._tag).toBe('Invalid')
  })

  test('creating a unit adds it to the list', () => {
    story(
      update,
      given(peopleLoaded),
      message(
        peopleMessage(People.Message.UpdatedUnitName({ value: 'Second Unit' })),
      ),
      message(peopleMessage(People.Message.UpdatedUnitCode({ value: 'SEC' }))),
      message(peopleMessage(People.Message.SubmittedUnit())),
      Command.resolve(
        People.CreateUnit,
        People.Message.SucceededCreateUnit({
          unit: { id: 'unit-2', name: 'Second Unit', code: 'SEC' },
        }),
      ),
      model(next => {
        expect(next.people.units.map(unit => unit.code)).toEqual([
          'SYN',
          'SEC',
        ])
      }),
    )
  })

  test('a person needs a unit or a permission before they are added', () => {
    const submitted = run(peopleLoaded, [
      peopleMessage(
        People.Message.UpdatedPersonEmail({ value: 'new@case-desk.test' }),
      ),
      peopleMessage(People.Message.SubmittedPerson()),
    ])
    expect(namesOf(submitted)).toEqual([])
    expect(submitted.model.people.personForm._tag).toBe('Invalid')
  })

  test('adding a new person shows the link once and never stores it as text', () => {
    story(
      update,
      given(peopleLoaded),
      message(
        peopleMessage(
          People.Message.UpdatedPersonEmail({ value: 'new@case-desk.test' }),
        ),
      ),
      message(
        peopleMessage(People.Message.UpdatedPersonName({ value: 'New Author' })),
      ),
      message(
        peopleMessage(
          People.Message.SelectedPersonUnit({ value: SYNTHETIC_UNIT.id }),
        ),
      ),
      message(peopleMessage(People.Message.SubmittedPerson())),
      Command.resolve(
        People.AddPerson,
        People.Message.SucceededAddPerson({
          account: {
            id: 'account-10',
            email: 'new@case-desk.test',
            name: 'New Author',
            active: true,
            grants: [{ capability: 'author', unit: SYNTHETIC_UNIT.id }],
            reviewerIn: [],
          },
          link: Option.some(givenLinkOf(activationLink)),
        }),
      ),
      model(next => {
        expect(Option.isSome(next.people.maybeLink)).toBe(true)
        expect(next.people.accounts.map(account => account.name)).toEqual([
          'Known Person',
          'New Author',
        ])
        expect(JSON.stringify(next)).not.toContain(
          Redacted.value(SYNTHETIC_TOKEN),
        )
      }),
    )
  })

  test('adding someone who has an account makes no link', () => {
    const granted = run(peopleLoaded, [
      peopleMessage(
        People.Message.SucceededAddPerson({
          account: KNOWN,
          link: Option.none(),
        }),
      ),
    ]).model
    expect(Option.isNone(granted.people.maybeLink)).toBe(true)
    expect(Option.isSome(granted.people.maybeNotice)).toBe(true)
  })

  test('a toggle grants what is not held and revokes what is', () => {
    const granting = run(peopleLoaded, [
      peopleMessage(
        People.Message.ClickedToggle({
          accountId: KNOWN.id,
          capability: 'theme',
          unit: Option.none(),
        }),
      ),
    ])
    expect(namesOf(granting)).toEqual([People.ChangeCapability.name])
    expect(granting.model.people.pending).toEqual([
      People.toggleKey(KNOWN.id, 'theme', Option.none()),
    ])
    const again = run(granting.model, [
      peopleMessage(
        People.Message.ClickedToggle({
          accountId: KNOWN.id,
          capability: 'theme',
          unit: Option.none(),
        }),
      ),
    ])
    expect(namesOf(again)).toEqual([])
    story(
      update,
      given(peopleLoaded),
      message(
        peopleMessage(
          People.Message.ClickedToggle({
            accountId: KNOWN.id,
            capability: 'people',
            unit: Option.none(),
          }),
        ),
      ),
      Command.resolve(
        People.ChangeCapability,
        People.Message.SucceededChangeCapability({
          key: People.toggleKey(KNOWN.id, 'people', Option.none()),
          account: { ...KNOWN, grants: [] },
        }),
      ),
      model(next => {
        expect(next.people.pending).toEqual([])
        expect(next.people.accounts[0]?.grants).toEqual([])
      }),
    )
  })

  test('issuing a reset link shows it for copying', () => {
    const issued = run(peopleLoaded, [
      peopleMessage(
        People.Message.SucceededIssueReset({
          name: 'Known Person',
          link: givenLinkOf({ ...activationLink, purpose: 'reset' }),
        }),
      ),
    ]).model
    expect(Option.map(issued.people.maybeLink, link => link.purpose)).toEqual(
      Option.some('reset'),
    )
  })
})

describe('the folders of the People screen', () => {
  test('a unit holds its authors and its reviewers; the rest have no unit', () => {
    const folders = People.foldersOf({
      ...People.initialModel,
      units: [SYNTHETIC_UNIT],
      accounts: [
        KNOWN,
        {
          ...KNOWN,
          id: 'a-1',
          name: 'Ana Author',
          grants: [{ capability: 'author', unit: SYNTHETIC_UNIT.id }],
        },
        { ...KNOWN, id: 'r-1', name: 'Rui Reviewer', grants: [], reviewerIn: [SYNTHETIC_UNIT.id] },
      ],
    })
    expect(
      folders.map(folder => [
        folder.heading,
        folder.accounts.map(account => account.name),
      ]),
    ).toEqual([
      ['Synthetic Unit (SYN)', ['Ana Author', 'Rui Reviewer']],
      ['No unit', ['Known Person']],
    ])
  })
})

const unitLoaded = run(authorModel, [
  clickedPage('Unit'),
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
      update(authorModel, clickedPage('Unit')).model,
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
          link: Option.some(givenLinkOf(activationLink)),
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
          link: Option.none(),
        }),
      ),
    ]).model
    expect(Option.isNone(invited.unit.maybeLink)).toBe(true)
    expect(Option.isSome(invited.unit.maybeNotice)).toBe(true)
  })

  test('registering a reviewer sends the name and the e-mail', () => {
    const typed = typedReviewer([])
    expect(typed.model.unit.reviewerForm._tag).toBe('Submitting')
    expect(namesOf(typed)).toEqual([Unit.AddReviewer.name])
    expect(typed.commands?.[0]?.args).toEqual({
      unit: SYNTHETIC_UNIT.id,
      name: 'Rae Viewer',
      email: 'rae@case-desk.test',
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
      maybeAdd: Option.some('account-4'),
      maybeRemove: Option.none(),
      retired: Option.none(),
    })
  })

  test('two quick toggles each send their own operation, never a whole list', () => {
    const committee = {
      id: 'committee-1',
      unit: SYNTHETIC_UNIT.id,
      name: 'Synthetic Committee',
      memberIds: ['account-3'],
      retired: false,
    }
    const toggle = (accountId: string) =>
      unitMessage(
        Unit.Message.ToggledCommitteeMember({ committeeId: committee.id, accountId }),
      )
    const first = run(unitLoaded, [
      unitMessage(Unit.Message.SucceededCreateCommittee({ committee })),
      toggle('account-4'),
    ])
    const second = run(unitLoaded, [
      unitMessage(Unit.Message.SucceededCreateCommittee({ committee })),
      toggle('account-4'),
      toggle('account-5'),
    ])
    expect(first.commands?.[0]?.args).toMatchObject({ maybeAdd: Option.some('account-4') })
    expect(second.commands?.[0]?.args).toMatchObject({
      maybeAdd: Option.some('account-5'),
      maybeRemove: Option.none(),
    })
    const removed = run(unitLoaded, [
      unitMessage(Unit.Message.SucceededCreateCommittee({ committee })),
      toggle('account-3'),
    ])
    expect(removed.commands?.[0]?.args).toMatchObject({
      maybeAdd: Option.none(),
      maybeRemove: Option.some('account-3'),
    })
  })
})

describe('the person', () => {
  test('the approval preference is read from the account and saved as it is', () => {
    const toggled = run(adminModel, [
      Message.GotAccountMessage({
        message: Account.Message.SucceededLoadAccount({ me: ADMIN_ME }),
      }),
      Message.GotAccountMessage({
        message: Account.Message.ToggledNotifyOnApproval(),
      }),
      Message.GotAccountMessage({
        message: Account.Message.SubmittedPreferences(),
      }),
    ])
    expect(toggled.model.account.notifyOnApproval).toBe(
      !ADMIN_ME.profile.notifyOnApproval,
    )
    expect(toggled.commands?.[0]?.args).toEqual({
      notifyOnApproval: !ADMIN_ME.profile.notifyOnApproval,
    })
  })
})
