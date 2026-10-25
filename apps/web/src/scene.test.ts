import {
  click,
  expect,
  given,
  inside,
  keydown,
  role,
  scene,
  text,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import { initialModel, update } from './main'
import { view } from './view'

describe('scene', () => {
  test('the home screen leads with what needs attention', () => {
    scene(
      { update, view },
      given(initialModel),
      expect(role('heading', { name: '1 case is due soon' })).toExist(),
      expect(role('region', { name: 'Urgent' })).toExist(),
      expect(role('region', { name: 'Standard' })).toExist(),
      expect(role('heading', { name: 'Why this is urgent' })).toExist(),
    )
  })

  test('picking another case explains its priority', () => {
    scene(
      { update, view },
      given(initialModel),
      click(role('button', { name: /Question about whether a gift/ })),
      expect(role('heading', { name: 'Why this is standard' })).toExist(),
    )
  })

  test('choosing an operational centre narrows the queue', () => {
    scene(
      { update, view },
      given(initialModel),
      click(role('button', { name: 'OCG' })),
      expect(text('SYN-001', { exact: false })).toExist(),
      expect(text('SYN-002', { exact: false })).toBeAbsent(),
    )
  })

  test('advancing the clock turns due cases into overdue ones', () => {
    scene(
      { update, view },
      given(initialModel),
      expect(text('Mon 2 Nov, 09:00 UTC', { exact: false })).toBeAbsent(),
      click(role('button', { name: 'Demo controls' })),
      expect(text('Mon 2 Nov, 09:00 UTC', { exact: false })).toExist(),
      click(role('button', { name: '+24 h' })),
      expect(role('heading', { name: '3 cases are overdue' })).toExist(),
      click(role('button', { name: 'Reset' })),
      expect(role('heading', { name: '1 case is due soon' })).toExist(),
    )
  })

  test('every case on the time axis is a named button', () => {
    scene(
      { update, view },
      given(initialModel),
      inside(
        role('group', { name: 'Cases on the time axis' }),
        expect(
          role('button', {
            name: 'SYN-002, urgent, fast-track, 16 hours left',
          }),
        ).toExist(),
      ),
      inside(
        role('group', { name: 'Cases on the timeline' }),
        expect(
          role('button', {
            name: 'SYN-001, urgent, fast-track, due soon, 4 hours left',
          }),
        ).toExist(),
      ),
    )
  })

  test('tapping a case on the timeline opens it', () => {
    scene(
      { update, view },
      given(initialModel),
      inside(
        role('group', { name: 'Cases on the timeline' }),
        click(role('button', { name: /^SYN-005,/ })),
      ),
      expect(role('heading', { name: /Concern about a colleague/ })).toExist(),
      expect(role('button', { name: '← Back to cases' })).toExist(),
    )
  })

  test('the axis is one tab stop and arrow keys move between cases', () => {
    scene(
      { update, view },
      given(initialModel),
      inside(
        role('group', { name: 'Cases on the timeline' }),
        expect(role('button', { name: /^SYN-001,/ })).toHaveAttr(
          'tabIndex',
          '0',
        ),
        expect(role('button', { name: /^SYN-002,/ })).toHaveAttr(
          'tabIndex',
          '-1',
        ),
        keydown(role('button', { name: /^SYN-001,/ }), 'ArrowDown'),
        expect(role('button', { name: /^SYN-002,/ })).toHaveAttr(
          'tabIndex',
          '0',
        ),
        expect(role('button', { name: /^SYN-001,/ })).toHaveAttr(
          'tabIndex',
          '-1',
        ),
      ),
    )
  })

  test('the footer shows the MSF logo and where the prototype comes from', () => {
    scene(
      { update, view },
      given(initialModel),
      expect(role('img', { name: 'Metges Sense Fronteres' })).toExist(),
      expect(
        text('developed at Universitat Pompeu Fabra', { exact: false }),
      ).toExist(),
    )
  })
})
