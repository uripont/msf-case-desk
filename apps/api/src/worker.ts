import { makeApp } from './app'
import { layerSql } from './d1Repository'

export type Env = {
  readonly ASSETS: Fetcher
  readonly DB: D1Database
}

const API_PREFIX = '/api/'

// NOTE: bindings do not change within an isolate, so the API is built once
// on the first request and reused.
let app: ReturnType<typeof makeApp> | undefined

const appFor = (env: Env) => {
  app ??= makeApp(layerSql(env.DB))
  return app
}

export default {
  fetch: (request, env) =>
    new URL(request.url).pathname.startsWith(API_PREFIX)
      ? appFor(env).handle(request)
      : env.ASSETS.fetch(request),
} satisfies ExportedHandler<Env>
