import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  type EditorFacts,
  TOOLBAR_GROUPS,
  blockStyleOfValue,
  blockStyleValue,
  buttonState,
  isAllowedLinkUrl,
  normaliseLinkUrl,
  toolbarState,
  visibleGroups,
} from './toolbar'

const FACTS: EditorFacts = {
  isEditable: true,
  bold: false,
  italic: false,
  underline: false,
  link: false,
  bulletList: false,
  orderedList: false,
  blockStyle: 'paragraph',
  inTable: false,
  canInsertTable: true,
  hasLinkTarget: false,
  canUndo: false,
  canRedo: false,
  canInsertImage: false,
}

describe('toolbar state', () => {
  test('a mark is pressed when it is on at the caret', () => {
    expect(buttonState('bold', { ...FACTS, bold: true })).toEqual({
      pressed: true,
      disabled: false,
    })
    expect(buttonState('bold', FACTS).pressed).toBe(false)
  })

  test('undo and redo follow the history', () => {
    expect(buttonState('undo', FACTS).disabled).toBe(true)
    expect(buttonState('undo', { ...FACTS, canUndo: true }).disabled).toBe(
      false,
    )
    expect(buttonState('redo', { ...FACTS, canRedo: true }).disabled).toBe(
      false,
    )
  })

  test('a link needs a selection or a link under the caret', () => {
    expect(buttonState('link', FACTS).disabled).toBe(true)
    expect(
      buttonState('link', { ...FACTS, hasLinkTarget: true }).disabled,
    ).toBe(false)
  })

  test('table tools work only inside a table, and a table is not inserted into one', () => {
    expect(buttonState('addRowAfter', FACTS).disabled).toBe(true)
    expect(
      buttonState('addRowAfter', { ...FACTS, inTable: true }).disabled,
    ).toBe(false)
    expect(
      buttonState('insertTable', { ...FACTS, canInsertTable: false }).disabled,
    ).toBe(true)
    expect(visibleGroups(FACTS).some(group => group.isTableGroup)).toBe(false)
    expect(
      visibleGroups({ ...FACTS, inTable: true }).some(
        group => group.isTableGroup,
      ),
    ).toBe(true)
  })

  test('the image button follows whether a picture can be added now', () => {
    expect(buttonState('insertImage', FACTS).disabled).toBe(true)
    expect(
      buttonState('insertImage', { ...FACTS, canInsertImage: true }).disabled,
    ).toBe(false)
  })

  test('widening and narrowing a column are table buttons, usable only in a table', () => {
    const tableGroup = TOOLBAR_GROUPS.find(group => group.isTableGroup)
    expect(tableGroup?.buttons).toContain('widenColumn')
    expect(tableGroup?.buttons).toContain('narrowColumn')
    expect(buttonState('widenColumn', FACTS).disabled).toBe(true)
    expect(buttonState('narrowColumn', FACTS).disabled).toBe(true)
    expect(
      buttonState('widenColumn', { ...FACTS, inTable: true }).disabled,
    ).toBe(false)
  })

  test('a read-only editor disables every button', () => {
    const states = toolbarState({
      ...FACTS,
      isEditable: false,
      inTable: true,
      bold: true,
    })
    expect(
      Object.values(states).every(state => state.disabled && !state.pressed),
    ).toBe(true)
  })

  test('every button appears in exactly one group', () => {
    const ids = TOOLBAR_GROUPS.flatMap(group => group.buttons)
    expect(new Set(ids).size).toBe(ids.length)
    expect(Object.keys(toolbarState(FACTS)).length).toBe(ids.length)
  })

  test('block styles map to select values and back', () => {
    expect(blockStyleValue(3)).toBe('3')
    expect(blockStyleValue('other')).toBe('paragraph')
    expect(blockStyleOfValue('2')).toEqual(Option.some(2))
    expect(blockStyleOfValue('9')).toEqual(Option.none())
  })
})

describe('links', () => {
  test.each([
    ['https://example.org', 'https://example.org'],
    ['  http://example.org/a?b=1#c ', 'http://example.org/a?b=1#c'],
    ['mailto:ana@example.org', 'mailto:ana@example.org'],
    ['tel:+33123456789', 'tel:+33123456789'],
    ['example.org', 'https://example.org'],
    ['example.org/path', 'https://example.org/path'],
    ['ana@example.org', 'mailto:ana@example.org'],
  ])('%s is accepted', (typed, stored) => {
    expect(normaliseLinkUrl(typed)).toEqual(Option.some(stored))
  })

  test.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,hi',
    'ftp://example.org',
    'two words',
    '',
    'https://exa mple.org',
    `https://example.org/${'a'.repeat(2000)}`,
  ])('%s is refused', typed => {
    expect(normaliseLinkUrl(typed)).toEqual(Option.none())
  })

  test('what is stored is checked again against the same rule', () => {
    expect(isAllowedLinkUrl('https://example.org')).toBe(true)
    expect(isAllowedLinkUrl('javascript:alert(1)')).toBe(false)
  })
})
