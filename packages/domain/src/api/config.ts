import { Schema } from 'effect'

import { Theme } from '../theme'
import { ImageMime } from './reports'

// NOTE: `/api/config` (D20, D24): public, no session, cached briefly. It tells
// the browser which runtime mode the deployment runs in and what the theme is,
// so the sign-in page already has the organisation's name and colours. One web
// build serves every environment. The logo is only a reference: the image
// route serves it to a signed-in account (D5).
export const CONFIG_PATH = '/api/config'

export const RUNTIME_MODES = ['demo', 'pilot'] as const
export const RuntimeMode = Schema.Literals(RUNTIME_MODES)
export type RuntimeMode = typeof RuntimeMode.Type

// NOTE: A Worker with no mode set is a demo deployment, as every one was
// before the mode existed.
export const DEFAULT_RUNTIME_MODE: RuntimeMode = 'demo'

export const runtimeModeOf = (value: string | undefined): RuntimeMode =>
  value?.trim().toLowerCase() === 'pilot' ? 'pilot' : DEFAULT_RUNTIME_MODE

export const CONFIG_MAX_AGE_SECONDS = 30

export const ConfigLogo = Schema.Struct({
  id: Schema.String,
  mime: ImageMime,
  chunks: Schema.Int,
})
export type ConfigLogo = typeof ConfigLogo.Type

export const AppConfig = Schema.Struct({
  mode: RuntimeMode,
  theme: Theme,
  logo: Schema.optionalKey(ConfigLogo),
})
export type AppConfig = typeof AppConfig.Type
