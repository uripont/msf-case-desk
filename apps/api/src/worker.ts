import { DEFAULT_RULES } from '@case-desk/domain'

export type Env = {
  readonly ASSETS: Fetcher
}

const API_PREFIX = '/api/'

const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  })

export const handleApi = (request: Request): Response => {
  const { pathname } = new URL(request.url)
  if (pathname === '/api/health') {
    return json({ status: 'ok', rulesVersion: DEFAULT_RULES.version })
  }
  return json({ error: 'NotFound' }, 404)
}

export default {
  fetch: (request, env) =>
    new URL(request.url).pathname.startsWith(API_PREFIX)
      ? Promise.resolve(handleApi(request))
      : env.ASSETS.fetch(request),
} satisfies ExportedHandler<Env>
