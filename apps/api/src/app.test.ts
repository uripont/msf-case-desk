import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'

import {
  DEFAULT_NOTIFICATION_CONFIG,
  ReportRepository,
  Repository,
} from '@case-desk/domain'
import {
  makeMemoryReportRepository,
  makeMemoryRepository,
} from '@case-desk/domain/testing/memory'

import { makeApp } from './app'
import { QuoroomConfig, makeTestClock, makeTestIds } from './quoroom/core'

const apps: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.dispose()))
})

const makeTestApp = async () => {
  const app = makeApp(
    Layer.succeed(Repository, await Effect.runPromise(makeMemoryRepository())),
    Layer.mergeAll(
      Layer.succeed(
        ReportRepository,
        await Effect.runPromise(makeMemoryReportRepository()),
      ),
      makeTestClock(Date.UTC(2026, 10, 12, 9, 0, 0)).layer,
      makeTestIds(),
      Layer.succeed(QuoroomConfig, DEFAULT_NOTIFICATION_CONFIG),
    ),
  )
  apps.push(app)
  return app
}

const request = (path: string, method = 'GET') =>
  new Request(`https://quoroom.test${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: '{}' } : {}),
  })

describe('API routes', () => {
  test('every API response carries Referrer-Policy: no-referrer', async () => {
    const app = await makeTestApp()
    const responses = await Promise.all(
      ['/api/health', '/api/config', '/api/nothing-here'].map(path =>
        app.handle(request(path)),
      ),
    )
    expect(responses.map(r => r.headers.get('referrer-policy'))).toEqual([
      'no-referrer',
      'no-referrer',
      'no-referrer',
    ])
  })

  test('the health check answers ok', async () => {
    const app = await makeTestApp()
    const response = await app.handle(request('/api/health'))
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  test('unknown API paths answer 404', async () => {
    const app = await makeTestApp()
    expect((await app.handle(request('/api/nothing'))).status).toBe(404)
  })

  // NOTE: the triage desk of iterations 1 and 2 runs only in its own frozen
  // Workers; this one serves none of its routes.
  test('the routes of the triage desk are not served', async () => {
    const app = await makeTestApp()
    for (const [path, method] of [
      ['/api/login', 'POST'],
      ['/api/logout', 'POST'],
      ['/api/session', 'GET'],
      ['/api/rpc', 'POST'],
      ['/api/rpc/', 'POST'],
    ] as const) {
      expect((await app.handle(request(path, method))).status, path).toBe(404)
    }
  })
})
