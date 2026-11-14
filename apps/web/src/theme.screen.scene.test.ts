import { expect, given, role, scene, selector, text, type } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { update } from './main'
import { authorModel } from './quoroom.fixtures'
import * as ThemeScreen from './quoroom/themeScreen'
import {
  LOGO_PREVIEW,
  SAVED_THEME,
  UPLOADED,
  openThemeScreen,
  sendToTheme,
} from './theme.screen.fixtures'
import { view } from './view'

// NOTE: As seen on the page: the contrast problem is beside the
// colour, the refusal is stated, a good theme is saved, the page applies it.

describe('the theme screen', () => {
  test('the fields, the contrast of each colour and both previews are shown', () => {
    scene(
      { update, view },
      given(openThemeScreen()),
      expect(role('heading', { name: 'Theme', level: 1 })).toExist(),
      expect(role('textbox', { name: 'Organisation name' })).toHaveValue(
        'Invented Organisation',
      ),
      expect(role('textbox', { name: 'Footer text' })).toHaveValue(
        'Page {page} of {pages}',
      ),
      expect(role('combobox', { name: 'Heading font' })).toExist(),
      expect(role('region', { name: 'Preview of an app page' })).toExist(),
      expect(role('region', { name: 'Preview of a PDF' })).toExist(),
      expect(role('button', { name: 'Show a sample PDF' })).toExist(),
      expect(selector('[data-theme-ratio="text"]')).toExist(),
      expect(selector('[data-theme-problem]')).toBeAbsent(),
    )
  })

  test('an unreadable colour shows its problem beside it, and saving is refused with a reason', () => {
    scene(
      { update, view },
      given(openThemeScreen()),
      type(role('textbox', { name: 'Text colour' }), '#cccccc'),
      expect(selector('[data-theme-problem="colors.text"]')).toExist(),
      expect(text(/has a contrast of/)).toExist(),
      expect(
        text(
          'Some text would be hard to read. A theme like this cannot be saved.',
        ),
      ).toExist(),
      expect(role('button', { name: 'Save the theme' })).toExist(),
    )
  })

  test('a colour fixed again clears the problem', () => {
    scene(
      { update, view },
      given(openThemeScreen()),
      type(role('textbox', { name: 'Text colour' }), '#cccccc'),
      type(role('textbox', { name: 'Text colour' }), '#202020'),
      expect(selector('[data-theme-problem]')).toBeAbsent(),
    )
  })

  test('the logo preview and the remove button appear once a logo is set', () => {
    const withLogo = sendToTheme(
      sendToTheme(
        openThemeScreen(),
        ThemeScreen.Message.SucceededUploadLogo(UPLOADED),
      ).model,
      ThemeScreen.Message.SucceededLoadLogoPreview({ preview: LOGO_PREVIEW }),
    ).model
    scene(
      { update, view },
      given(withLogo),
      expect(selector('[data-theme-logo]')).toExist(),
      expect(role('button', { name: 'Remove the logo' })).toExist(),
    )
  })

  test('after saving, the page uses the saved name and colour', () => {
    const saved = sendToTheme(
      openThemeScreen(),
      ThemeScreen.Message.SucceededSaveTheme({
        record: {
          theme: {
            ...SAVED_THEME,
            organisationName: 'Renamed Organisation',
            colors: { ...SAVED_THEME.colors, primary: '#0b5d3b' },
          },
        },
      }),
    ).model
    scene(
      { update, view },
      given(saved),
      expect(selector('#quoroom-root')).toHaveStyle(
        '--color-msf-red',
        '#0b5d3b',
      ),
      expect(text('Renamed Organisation')).toExist(),
    )
  })

  test('an author has no link to the theme screen', () => {
    scene(
      { update, view },
      given(authorModel),
      expect(role('link', { name: 'Theme' })).toBeAbsent(),
    )
  })
})
