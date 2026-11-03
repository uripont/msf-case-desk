import { DEFAULT_RULES, RPC_PATH } from '@case-desk/domain'

import { layerSql } from './d1Repository'
import { makeRpcHandler } from './server'

export type Env = {
  readonly ASSETS: Fetcher
  readonly DB: D1Database
}

const API_PREFIX = '/api/'

const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  })

// NOTE: bindings do not change within an isolate, so the RPC server is
// built once on the first request and reused.
let rpcServer: ReturnType<typeof makeRpcHandler> | undefined

const rpcServerFor = (env: Env) => {
  rpcServer ??= makeRpcHandler(layerSql(env.DB))
  return rpcServer
}

export const handleApi = (request: Request, env: Env): Promise<Response> => {
  const { pathname } = new URL(request.url)
  if (pathname === '/api/health') {
    return Promise.resolve(
      json({ status: 'ok', rulesVersion: DEFAULT_RULES.version }),
    )
  }
  if (pathname === RPC_PATH) {
    return rpcServerFor(env).handler(request)
  }
  return Promise.resolve(json({ error: 'NotFound' }, 404))
}

export default {
  fetch: (request, env) =>
    new URL(request.url).pathname.startsWith(API_PREFIX)
      ? handleApi(request, env)
      : env.ASSETS.fetch(request),
} satisfies ExportedHandler<Env>
