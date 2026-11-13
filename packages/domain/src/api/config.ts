import { Schema } from 'effect'

import { Theme } from '../theme'
import { ImageMime } from './reports'

// NOTE: `/api/config` (D20, D24): public, no session, cached briefly. It tells
// the browser which runtime mode the deployment runs in and what the theme is,
// so the sign-in page already has the organisation's name and colours. One web
// build serves every environment. The logo is only a reference: the image
// route serves it to a signed-in account (D5). Nothing else of the theme is
// public (see `PublicTheme`).
export const CONFIG_PATH = '/api/config'

export const RUNTIME_MODES = ['demo', 'pilot'] as const
export const RuntimeMode = Schema.Literals(RUNTIME_MODES)
export type RuntimeMode = typeof RuntimeMode.Type

// NOTE: fail closed (D20). A deployment with no mode set is a pilot, which is
// what the web app also assumes when it cannot read the configuration. Demo
// must be asked for with `RUNTIME_MODE=demo`.
export const DEFAULT_RUNTIME_MODE: RuntimeMode = 'pilot'

export type RuntimeModeReading =
  | Readonly<{ ok: true; mode: RuntimeMode }>
  | Readonly<{ ok: false; value: string }>

// NOTE: only `demo` and `pilot`, exactly. Unset or blank means the default;
// any other text is a configuration error, never read as one of the two.
export const readRuntimeMode = (
  value: string | undefined,
): RuntimeModeReading => {
  const text = value?.trim() ?? ''
  if (text === '') {
    return { ok: true, mode: DEFAULT_RUNTIME_MODE }
  }
  const mode = RUNTIME_MODES.find(candidate => candidate === text)
  return mode === undefined ? { ok: false, value: text } : { ok: true, mode }
}

export const CONFIG_MAX_AGE_SECONDS = 30

export const ConfigLogo = Schema.Struct({
  id: Schema.String,
  mime: ImageMime,
  chunks: Schema.Int,
})
export type ConfigLogo = typeof ConfigLogo.Type

// NOTE: Only what the signed-out app needs to look right (D24): the
// organisation's name, the colours and the fonts. The PDF header and footer
// text, and the stored logo ID, are not public: a signed-in account reads the
// whole theme with `GetTheme`, and the logo is named in `AppConfig.logo`.
export const PublicTheme = Schema.Struct({
  schemaVersion: Theme.fields.schemaVersion,
  organisationName: Theme.fields.organisationName,
  colors: Theme.fields.colors,
  fonts: Theme.fields.fonts,
})
export type PublicTheme = typeof PublicTheme.Type

export const publicThemeOf = (theme: Theme): PublicTheme => ({
  schemaVersion: theme.schemaVersion,
  organisationName: theme.organisationName,
  colors: theme.colors,
  fonts: theme.fonts,
})

export const AppConfig = Schema.Struct({
  mode: RuntimeMode,
  theme: PublicTheme,
  logo: Schema.optionalKey(ConfigLogo),
})
export type AppConfig = typeof AppConfig.Type
