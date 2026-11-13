import { Option } from 'effect'
import { expect, given, role, scene, selector, text } from 'foldkit/scene'
import { expect as check, describe, test } from 'vitest'

import { type AppConfig, DEFAULT_THEME } from '@case-desk/domain'

import { SYNTHETIC_ME, configuredAt, openedAt } from './fixtures'
import { LoadLogo, Message, themeOf, update } from './main'
import { defaultThemeStyle, themeStyle } from './theme'
import { view } from './view'

const INVENTED: AppConfig = {
  mode: 'demo',
  theme: {
    ...DEFAULT_THEME,
    organisationName: 'Invented Organisation',
    colors: {
      primary: '#0b5d3b',
      accent: '#7a1f5c',
      text: '#101820',
      background: '#fafaf5',
    },
    fonts: { heading: 'Source Serif 4', body: 'Noto Sans' },
  },
}

const signedIn = (config: AppConfig) =>
  update(
    configuredAt('/', config),
    Message.SucceededCheckSession({ me: SYNTHETIC_ME }),
  ).model

describe('the theme as custom properties', () => {
  test('colours and fonts become the properties the views draw with', () => {
    check(themeStyle(INVENTED.theme)).toEqual({
      '--color-msf-red': '#0b5d3b',
      '--color-msf-black': '#101820',
      '--color-msf-ink': '#101820',
      '--color-msf-paper': '#fafaf5',
      '--color-msf-accent': '#7a1f5c',
      '--font-sans': "'Noto Sans', 'Helvetica Neue', Arial, sans-serif",
      '--font-heading': "'Source Serif 4', Georgia, 'Times New Roman', serif",
    })
  })

  test('the default theme is the neutral Quoroom one from the domain', () => {
    check(themeOf(openedAt('/').model)).toEqual(DEFAULT_THEME)
    check(defaultThemeStyle['--color-msf-red']).toBe(
      DEFAULT_THEME.colors.primary,
    )
  })
})

describe('the theme in the app', () => {
  test('the colours of /api/config are applied to the page', () => {
    scene(
      { update, view },
      given(signedIn(INVENTED)),
      expect(selector('#quoroom-root')).toHaveStyle(
        '--color-msf-red',
        '#0b5d3b',
      ),
      expect(selector('#quoroom-root')).toHaveStyle(
        '--color-msf-accent',
        '#7a1f5c',
      ),
      expect(selector('#quoroom-root')).toHaveStyle(
        '--font-heading',
        "'Source Serif 4', Georgia, 'Times New Roman', serif",
      ),
    )
  })

  test('the name of the organisation is shown beside the product name', () => {
    scene(
      { update, view },
      given(signedIn(INVENTED)),
      expect(text('Invented Organisation')).toExist(),
      expect(
        text('Quoroom, a reporting system for Invented Organisation.'),
      ).toExist(),
    )
  })

  test('the default theme applies before the settings arrive, and on the sign-in page', () => {
    scene(
      { update, view },
      given(openedAt('/').model),
      expect(selector('#quoroom-root')).toHaveStyle(
        '--color-msf-red',
        DEFAULT_THEME.colors.primary,
      ),
      expect(role('heading', { name: 'Opening Quoroom' })).toExist(),
    )
    scene(
      { update, view },
      given(
        update(configuredAt('/', INVENTED), Message.FailedCheckSession()).model,
      ),
      expect(role('heading', { name: 'Sign in' })).toExist(),
      expect(text('Invented Organisation')).toExist(),
      expect(selector('#quoroom-root')).toHaveStyle(
        '--color-msf-red',
        '#0b5d3b',
      ),
    )
  })

  test('settings that cannot be loaded leave the default theme', () => {
    const failed = update(openedAt('/').model, Message.FailedLoadConfig()).model
    scene(
      { update, view },
      given(update(failed, Message.FailedCheckSession()).model),
      expect(selector('#quoroom-root')).toHaveStyle(
        '--color-msf-red',
        DEFAULT_THEME.colors.primary,
      ),
      expect(text('Your organisation')).toExist(),
    )
  })

  test('the logo, once loaded, is shown with the organisation as its name', () => {
    const withLogo = update(
      signedIn(INVENTED),
      Message.SucceededLoadLogo({ src: 'blob:synthetic-logo' }),
    ).model
    scene(
      { update, view },
      given(withLogo),
      expect(role('img', { name: 'Invented Organisation logo' })).toHaveAttr(
        'src',
        'blob:synthetic-logo',
      ),
    )
  })

  test('there is no logo until one is set', () => {
    scene(
      { update, view },
      given(signedIn(INVENTED)),
      expect(role('img')).toBeAbsent(),
    )
  })
})

describe('loading the logo', () => {
  const config: AppConfig = {
    ...INVENTED,
    logo: { id: 'logo-1', mime: 'image/png', chunks: 1 },
  }

  test('starts once, when someone is signed in', () => {
    const opened = update(
      configuredAt('/', config),
      Message.SucceededCheckSession({ me: SYNTHETIC_ME }),
    )
    check(opened.commands?.map(command => command.name)).toContain(
      LoadLogo.name,
    )
    const signedOut = update(
      configuredAt('/', config),
      Message.FailedCheckSession(),
    )
    check(signedOut.commands).toBeUndefined()
  })

  test('is not repeated once the logo is there', () => {
    const loaded = update(
      signedIn(config),
      Message.SucceededLoadLogo({ src: 'blob:x' }),
    ).model
    const again = update(
      loaded,
      Message.SucceededCheckSession({ me: SYNTHETIC_ME }),
    )
    check(again.commands?.map(command => command.name) ?? []).not.toContain(
      LoadLogo.name,
    )
    check(Option.isSome(loaded.maybeLogoSrc)).toBe(true)
  })

  test('a failed load keeps the page without a logo', () => {
    const failed = update(signedIn(config), Message.FailedLoadLogo()).model
    check(Option.isNone(failed.maybeLogoSrc)).toBe(true)
  })
})
