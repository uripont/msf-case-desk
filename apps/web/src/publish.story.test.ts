import { describe, expect, test } from 'vitest'

import { clickedLinkTo } from './fixtures'
import { Message, update } from './main'
import { CHOICES, SCOPE, loaded, revision } from './publish.fixtures'
import { authorModel } from './quoroom.fixtures'
import * as Publish from './quoroom/publish'
import * as PublishForm from './quoroom/publishForm'
import { REPORT_ID } from './report.fixtures'

const publishScreen = (options: Parameters<typeof loaded>[0] = {}) =>
  [
    clickedLinkTo(`/r/${REPORT_ID}/publish`),
    Message.GotPublishMessage({
      message: Publish.Message.SucceededLoadPublish({
        scope: SCOPE,
        loaded: loaded(options),
      }),
    }),
  ].reduce((model, message) => update(model, message).model, authorModel)

// NOTE: What the publishing screen sends and refuses, in Messages
// and Commands. The server refuses the same things again.

type Step = ReturnType<typeof update>
type Screen = ReturnType<typeof publishScreen>

const publishMessage = (message: Publish.Message) =>
  Message.GotPublishMessage({ message })

const formMessage = (message: PublishForm.Message) =>
  publishMessage(Publish.Message.GotFormMessage({ message }))

const send = (model: Screen, ...messages: ReadonlyArray<Message>): Step =>
  messages.reduce<Step>((current, next) => update(current.model, next), {
    model,
    commands: [],
  })

const names = (step: Step): ReadonlyArray<string> =>
  (step.commands ?? []).map(command => command.name)

const chooseCommittee = formMessage(
  PublishForm.Message.ToggledCommittee({
    roleId: 'committee',
    committeeId: 'committee-1',
  }),
)

const click = publishMessage(Publish.Message.ClickedPublish())

describe('publishing', () => {
  test('with nobody chosen it gives problems and sends nothing', () => {
    const step = send(publishScreen(), click)
    expect(names(step)).toEqual([])
  })

  test('choosing the committee sends one PublishRevision for the latest draft with the zone', () => {
    const step = send(publishScreen(), chooseCommittee, click)
    expect(names(step)).toEqual(['PublishRevision'])
    const args = JSON.stringify(step.commands)
    expect(args).toContain('Europe/Madrid')
    expect(args).toContain('committee-1')
  })

  test('a second click while publishing sends nothing more', () => {
    const first = send(publishScreen(), chooseCommittee, click)
    expect(names(update(first.model, click))).toEqual([])
  })

  test('a redacted role without a confirmed preview is refused before sending', () => {
    const step = send(
      publishScreen({ choices: { ...CHOICES, redactionConfirmed: false } }),
      chooseCommittee,
      click,
    )
    expect(names(step)).toEqual([])
  })

  test('a deadline in the past is refused before sending', () => {
    const step = send(
      publishScreen(),
      chooseCommittee,
      formMessage(PublishForm.Message.TypedDate({ value: '2020-01-01' })),
      click,
    )
    expect(names(step)).toEqual([])
  })

  test('a deadline more than a year ahead is refused before sending', () => {
    const step = send(
      publishScreen(),
      chooseCommittee,
      formMessage(PublishForm.Message.TypedDate({ value: '2030-01-01' })),
      click,
    )
    expect(names(step)).toEqual([])
  })

  test('a deadline just inside the year is sent', () => {
    const step = send(
      publishScreen(),
      chooseCommittee,
      formMessage(PublishForm.Message.TypedDate({ value: '2027-11-01' })),
      click,
    )
    expect(names(step)).toEqual(['PublishRevision'])
  })

  test('a published revision reloads the screen', () => {
    const step = send(
      publishScreen(),
      publishMessage(
        Publish.Message.SucceededPublishRevision({
          scope: SCOPE,
          revision: revision(1, 'open'),
        }),
      ),
    )
    expect(names(step)).toEqual(['LoadPublish'])
  })

  test('a message from a page that was left is dropped', () => {
    const model = publishScreen()
    const step = update(
      model,
      publishMessage(
        Publish.Message.SucceededPublishRevision({
          scope: { ...SCOPE, generation: 99 },
          revision: revision(1, 'open'),
        }),
      ),
    )
    expect(names(step)).toEqual([])
  })
})
