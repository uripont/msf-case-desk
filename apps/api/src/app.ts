import { type Layer } from 'effect'

import { CONFIG_PATH, type Repository } from '@quoroom/domain'

import { withReferrerPolicy } from './headers'
import { makeConfigHandler } from './quoroom/config'
import { withSink } from './quoroom/cookies'
import {
  QUOROOM_PUBLIC_PATH,
  QUOROOM_RPC_PATH,
  type QuoroomDeps,
  makeQuoroomImageHandler,
  makeQuoroomPublicHandler,
  makeQuoroomRpcHandler,
} from './quoroom/server'

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

// NOTE: `repository` holds the accounts and sessions (the tables shared with
// the frozen iteration 2), `quoroom` the report repository, clock and ID
// services. The app serves the RPC at `/api/q/rpc`, the public procedures at
// `/api/q/public`, the configuration at `/api/config` and the images at
// `/api/images`.
export const makeApp = (
  repository: Layer.Layer<Repository>,
  quoroom: QuoroomDeps,
) => {
  // NOTE: each handler is built on first use, so a request builds only the one
  // RPC server it is routed to (building one is most of the fixed CPU cost of
  // a request; the Worker builds a new app per request).
  const once = <A>(make: () => A): (() => A) => {
    let built: { value: A } | undefined
    return () => {
      built ??= { value: make() }
      return built.value
    }
  }
  const built: Array<{ dispose: () => Promise<void> }> = []
  const tracked = <A extends { dispose: () => Promise<void> }>(
    make: () => A,
  ): (() => A) =>
    once(() => {
      const handler = make()
      built.push(handler)
      return handler
    })
  const config = once(() => makeConfigHandler(quoroom))
  const quoroomRpc = tracked(() => makeQuoroomRpcHandler(repository, quoroom))
  const quoroomPublic = tracked(() =>
    makeQuoroomPublicHandler(repository, quoroom),
  )
  const images = once(() => makeQuoroomImageHandler(repository, quoroom))

  const route = (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url)
    if (pathname === '/api/health') {
      return Promise.resolve(json({ status: 'ok' }))
    }
    if (pathname === CONFIG_PATH) {
      return config()(request)
    }
    // NOTE: the session cookie of the RPC (sign-in, links, sign-out) is set
    // by the handlers through a per-request slot, and the pages that carry a
    // link token send no referrer.
    const served = (
      handler: (request: Request) => Promise<Response>,
      path: string,
    ): Promise<Response> => {
      let target = request
      if (pathname !== path) {
        const url = new URL(request.url)
        url.pathname = path
        target = new Request(url, request)
      }
      return withSink(target, handler).then(response => {
        const headers = new Headers(response.headers)
        headers.set('referrer-policy', 'no-referrer')
        headers.set('cache-control', 'no-store')
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        })
      })
    }
    if (pathname === QUOROOM_RPC_PATH || pathname === `${QUOROOM_RPC_PATH}/`) {
      return served(quoroomRpc().handler, QUOROOM_RPC_PATH)
    }
    if (
      pathname === QUOROOM_PUBLIC_PATH ||
      pathname === `${QUOROOM_PUBLIC_PATH}/`
    ) {
      return served(quoroomPublic().handler, QUOROOM_PUBLIC_PATH)
    }
    if (pathname === '/api/images' || pathname.startsWith('/api/images/')) {
      return images()(request)
    }
    return Promise.resolve(json({ error: 'NotFound' }, 404))
  }

  const handle = (request: Request): Promise<Response> =>
    route(request).then(withReferrerPolicy)

  return {
    handle,
    dispose: async () => {
      await Promise.all(built.map(handler => handler.dispose()))
    },
  }
}
