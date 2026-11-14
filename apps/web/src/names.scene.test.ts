import { Option } from 'effect'
import {
  Command,
  click,
  expect,
  given,
  role,
  scene,
  selector,
  text,
  type,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import { INTAKE_TEMPLATE } from '@case-desk/domain'

import { clickedLinkTo } from './fixtures'
import { Message, OpenDialogFocus, update } from './main'
import { authorModel } from './quoroom.fixtures'
import * as Names from './quoroom/names'
import * as Report from './quoroom/report'
import { REPORT_ID, SCOPE, detailOf, loadedReport } from './report.fixtures'
import { view } from './view'

// NOTE: Stage 5: the original and redacted views on the drafting screen, and
// the people and names screen. Names are invented.

const PEOPLE = [
  {
    id: 'p-1',
    name: 'Zorana Veltkamp',
    label: 'Person 1',
    aliases: ['Zora'],
  },
]

const draftingScreen = () =>
  [
    clickedLinkTo(`/r/${REPORT_ID}`),
    Message.GotReportMessage({
      message: Report.Message.SucceededLoadReport({
        scope: SCOPE,
        loaded: {
          ...loadedReport(INTAKE_TEMPLATE, {
            permissions: ['edit', 'share', 'manage_people'],
            contents: {
              'case-details': {
                values: {
                  investigator: {
                    type: 'text',
                    text: 'Zorana Veltkamp interviewed the witness',
                  },
                },
                sections: {},
              },
            },
          }),
          people: PEOPLE,
        },
      }),
    }),
  ].reduce((model, message) => update(model, message).model, authorModel)

describe('the original and the redacted view while drafting', () => {
  test('the redacted view shows the label, highlighted, and never the name', () => {
    scene(
      { update, view },
      given(draftingScreen()),
      expect(role('button', { name: 'Redacted' })).toExist(),
      expect(selector('[data-redaction="replaced"]')).toBeAbsent(),
      click(role('button', { name: 'Redacted' })),
      expect(selector('[data-redaction="replaced"]')).toExist(),
      expect(text(/Veltkamp/)).toBeAbsent(),
      click(role('button', { name: 'Original' })),
      expect(selector('[data-redaction="replaced"]')).toBeAbsent(),
    )
  })

  test('the people link says how many people there are', () => {
    scene(
      { update, view },
      given(draftingScreen()),
      expect(role('link', { name: 'People and names (1)' })).toExist(),
    )
  })
})

const namesScreen = (permissions: ReadonlyArray<'edit' | 'manage_people'>) =>
  [
    clickedLinkTo(`/r/${REPORT_ID}/names`),
    Message.GotNamesMessage({
      message: Names.Message.SucceededLoadNames({
        scope: { reportId: REPORT_ID, generation: 1 },
        loaded: {
          detail: detailOf(INTAKE_TEMPLATE, 'drafting', permissions),
          template: INTAKE_TEMPLATE,
          contents: {
            'case-details': {
              values: {
                investigator: {
                  type: 'text',
                  text: 'Zorana Veltkamp met Bertil Nwosu. Bertil Nwosu left.',
                },
              },
              sections: {},
            },
          },
          sectionIds: ['case-details'],
          people: PEOPLE,
          saveCounter: 2,
          ownerId: 'owner-1',
        },
      }),
    }),
  ].reduce((model, message) => update(model, message).model, authorModel)

describe('the people and names screen', () => {
  test('lists people with their aliases and offers changes to an author', () => {
    scene(
      { update, view },
      given(namesScreen(['edit', 'manage_people'])),
      expect(role('heading', { name: 'People, names and pictures' })).toExist(),
      expect(text('Zorana Veltkamp')).toExist(),
      expect(text('Reviewers read: Person 1')).toExist(),
      expect(text('Also replaced: Zora')).toExist(),
      expect(role('button', { name: 'Add a person' })).toExist(),
      expect(role('button', { name: 'Remove Zorana Veltkamp' })).toExist(),
    )
  })

  test('adding a person offers the next label and refuses an empty name in plain words', () => {
    scene(
      { update, view },
      given(namesScreen(['edit', 'manage_people'])),
      click(role('button', { name: 'Add a person' })),
      Command.resolve(
        Names.NewPersonId,
        Names.Message.GeneratedPersonId({
          scope: { reportId: REPORT_ID, generation: 1 },
          personId: 'p-2',
        }),
      ),
      expect(role('heading', { name: 'Add a person' })).toExist(),
      expect(selector('#person-label[value="Person 2"]')).toExist(),
      type(selector('#person-name'), 'Ingrid Falk'),
      expect(role('button', { name: 'Add this person' })).toExist(),
    )
  })

  test('removing a person asks for confirmation first', () => {
    scene(
      { update, view },
      given(namesScreen(['edit', 'manage_people'])),
      click(role('button', { name: 'Remove Zorana Veltkamp' })),
      Command.resolve(OpenDialogFocus, Message.CompletedOpenDialogFocus({ maybeReturnTo: Option.none() })),
      expect(role('alertdialog')).toExist(),
      expect(role('button', { name: 'Keep Zorana Veltkamp' })).toExist(),
      click(role('button', { name: 'Keep Zorana Veltkamp' })),
      expect(role('alertdialog')).toBeAbsent(),
    )
  })

  test('a name that looks like a person is suggested and can be ignored', () => {
    scene(
      { update, view },
      given(namesScreen(['edit', 'manage_people'])),
      expect(selector('[data-suggestion]')).toExist(),
      expect(
        role('button', { name: /^Add Bertil Nwosu as a new person$/ }),
      ).toExist(),
      click(role('button', { name: /^Ignore Bertil Nwosu$/ })),
      Command.resolve(Names.SaveIgnored, Names.Message.CompletedSaveIgnored()),
      expect(role('button', { name: /^Ignore Bertil Nwosu$/ })).toBeAbsent(),
    )
  })

  test('someone who cannot manage people sees the list and no changes', () => {
    scene(
      { update, view },
      given(namesScreen(['edit'])),
      expect(text('Zorana Veltkamp')).toExist(),
      expect(role('button', { name: 'Add a person' })).toBeAbsent(),
      expect(role('button', { name: 'Remove Zorana Veltkamp' })).toBeAbsent(),
    )
  })
})
