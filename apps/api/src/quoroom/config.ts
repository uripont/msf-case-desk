import { Effect, Layer, Schema } from 'effect'

import {
  type AppConfig,
  CONFIG_MAX_AGE_SECONDS,
  DEFAULT_THEME,
  Theme,
  publicThemeOf,
} from '@case-desk/domain'

import { type QuoroomDeps } from './server'
import { store } from './core'

const decodeTheme = Schema.decodeUnknownSync(Theme)

// NOTE: the theme as stored, or the neutral default when none is stored or
// the stored text is not a valid theme. The logo is only named when its image
// is complete.
export const readConfig =
  Effect.gen(function* () {
    const db = yield* store
    const stored = yield* db.getTheme()
    const theme = (() => {
      if (stored === null) {
        return DEFAULT_THEME
      }
      try {
        return decodeTheme(JSON.parse(stored.settings))
      } catch {
        return DEFAULT_THEME
      }
    })()
    const logoId = stored?.logoImageId ?? null
    const image = logoId === null ? null : yield* db.getImage(logoId)
    const config: AppConfig =
      image !== null && image.complete && image.owner.kind === 'theme'
        ? {
            theme: publicThemeOf(theme),
            logo: { id: image.id, mime: image.mime, chunks: image.chunkCount },
          }
        : { theme: publicThemeOf(theme) }
    return config
  })

export const makeConfigHandler =
  (deps: QuoroomDeps) =>
  (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return Promise.resolve(
        Response.json(
          { error: 'MethodNotAllowed' },
          { status: 405, headers: { allow: 'GET, HEAD' } },
        ),
      )
    }
    return Effect.runPromise(
      readConfig.pipe(
        Effect.map(config =>
          Response.json(config, {
            headers: {
              'cache-control': `public, max-age=${CONFIG_MAX_AGE_SECONDS}`,
            },
          }),
        ),
        Effect.catch(() =>
          Effect.succeed(
            Response.json(
              { error: 'StorageUnavailable' },
              { status: 503, headers: { 'cache-control': 'no-store' } },
            ),
          ),
        ),
        Effect.provide(Layer.mergeAll(deps)),
      ) as Effect.Effect<Response>,
    )
  }
