import { makeApp } from './app'
import { layerSql } from './d1Repository'

export type Env = {
  readonly ASSETS: Fetcher
  readonly DB: D1Database
}

const API_PREFIX = '/api/'

// NOTE: the API is built for each request and disposed after it. Workers do
// not let one request's I/O run inside fibers started by another request,
// so the RPC server cannot be shared across requests.
const handleApi = async (
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> => {
  const app = makeApp(layerSql(env.DB))
  try {
    return await app.handle(request)
  } finally {
    context.waitUntil(app.dispose())
  }
}

export default {
  fetch: (request, env, context) =>
    new URL(request.url).pathname.startsWith(API_PREFIX)
      ? handleApi(request, env, context)
      : env.ASSETS.fetch(request),
} satisfies ExportedHandler<Env>
