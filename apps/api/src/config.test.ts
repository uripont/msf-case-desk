import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'

import {
  CONFIG_PATH,
  DEFAULT_NOTIFICATION_CONFIG,
  DEFAULT_THEME,
  ReportRepository,
  Repository,
  RPC_PATH,
  type RuntimeMode,
  runtimeModeOf,
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

const world = async (mode?: RuntimeMode) => {
  const reports = await Effect.runPromise(makeMemoryReportRepository())
  const users = await Effect.runPromise(makeMemoryRepository())
  const app = makeApp(
    Layer.succeed(Repository, users),
    Layer.mergeAll(
      Layer.succeed(ReportRepository, reports),
      makeTestClock(Date.UTC(2026, 10, 12, 9, 0, 0)).layer,
      makeTestIds(),
      Layer.succeed(QuoroomConfig, DEFAULT_NOTIFICATION_CONFIG),
    ),
    ...(mode === undefined ? [] : [mode]),
  )
  apps.push(app)
  return { app, reports }
}

const request = (path: string, method = 'GET') =>
  new Request(`https://quoroom.test${path}`, { method })

describe('/api/config', () => {
  test('is public and answers the demo mode and the default theme when nothing is set', async () => {
    const { app } = await world()
    const response = await app.handle(request(CONFIG_PATH))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ mode: 'demo', theme: DEFAULT_THEME })
  })

  test('is cacheable for a short time and carries the referrer policy', async () => {
    const { app } = await world()
    const response = await app.handle(request(CONFIG_PATH))
    expect(response.headers.get('cache-control')).toBe('public, max-age=30')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  test('serves the stored theme and the mode of the deployment', async () => {
    const { app, reports } = await world('pilot')
    const theme = {
      ...DEFAULT_THEME,
      organisationName: 'Invented Organisation',
      colors: { ...DEFAULT_THEME.colors, primary: '#0b5d3b' },
    }
    await Effect.runPromise(
      reports.putTheme(
        {
          settings: JSON.stringify(theme),
          logoImageId: null,
          updatedAt: 5,
          updatedBy: null,
        },
        {
          at: 5,
          actorId: null,
          action: 'theme.updated',
          meta: '{}',
        },
      ) as Effect.Effect<void>,
    )
    const body = (await (await app.handle(request(CONFIG_PATH))).json()) as {
      mode: string
      theme: { organisationName: string; colors: { primary: string } }
    }
    expect(body.mode).toBe('pilot')
    expect(body.theme.organisationName).toBe('Invented Organisation')
    expect(body.theme.colors.primary).toBe('#0b5d3b')
  })

  test('falls back to the default theme when the stored one is not valid', async () => {
    const { app, reports } = await world()
    await Effect.runPromise(
      reports.putTheme(
        { settings: '{"nonsense":true}', logoImageId: null, updatedAt: 5, updatedBy: null },
        {
          at: 5,
          actorId: null,
          action: 'theme.updated',
          meta: '{}',
        },
      ) as Effect.Effect<void>,
    )
    const body = (await (await app.handle(request(CONFIG_PATH))).json()) as {
      theme: unknown
    }
    expect(body.theme).toEqual(DEFAULT_THEME)
  })

  test('only reads', async () => {
    const { app } = await world()
    const response = await app.handle(request(CONFIG_PATH, 'POST'))
    expect(response.status).toBe(405)
  })
})

describe('runtime mode', () => {
  test('anything but pilot is demo', () => {
    expect(runtimeModeOf(undefined)).toBe('demo')
    expect(runtimeModeOf('')).toBe('demo')
    expect(runtimeModeOf('self-hosted')).toBe('demo')
    expect(runtimeModeOf(' Pilot ')).toBe('pilot')
  })

  test('the triage RPC refuses in a pilot and is served in the demo', async () => {
    const pilot = await world('pilot')
    expect((await pilot.app.handle(request(RPC_PATH, 'POST'))).status).toBe(404)
    const demo = await world('demo')
    expect((await demo.app.handle(request(RPC_PATH, 'POST'))).status).not.toBe(404)
  })
})
