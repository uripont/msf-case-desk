import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  CONFIG_PATH,
  DEFAULT_NOTIFICATION_CONFIG,
  DEFAULT_THEME,
  ReportRepository,
  Repository,
  RPC_PATH,
  type RuntimeMode,
  publicThemeOf,
  readRuntimeMode,
} from '@case-desk/domain'
import {
  makeMemoryReportRepository,
  makeMemoryRepository,
} from '@case-desk/domain/testing/memory'

import { makeApp } from './app'
import { modeOf } from './runtimeMode'
import { QuoroomConfig, makeTestClock, makeTestIds } from './quoroom/core'

const apps: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.dispose()))
})

const world = async (mode: RuntimeMode) => {
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
    mode,
  )
  apps.push(app)
  return { app, reports }
}

const request = (path: string, method = 'GET') =>
  new Request(`https://quoroom.test${path}`, { method })

describe('/api/config', () => {
  test('is public and answers the demo mode and the default theme when nothing is set', async () => {
    const { app } = await world('demo')
    const response = await app.handle(request(CONFIG_PATH))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ mode: 'demo', theme: publicThemeOf(DEFAULT_THEME) })
  })

  test('is cacheable for a short time and carries the referrer policy', async () => {
    const { app } = await world('demo')
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

  test('serves only what the signed-out app needs: no PDF text, no stored logo ID', async () => {
    const { app, reports } = await world('demo')
    const theme = {
      ...DEFAULT_THEME,
      organisationName: 'Invented Organisation',
      logo: 'stored-logo-id',
      pdf: {
        header: 'Confidential header of the invented organisation',
        footer: 'Confidential footer {page}',
        coverHeader: 'Cover header text',
        coverFooter: 'Cover footer text',
      },
    }
    await Effect.runPromise(
      reports.putTheme(
        { settings: JSON.stringify(theme), logoImageId: null, updatedAt: 5, updatedBy: null },
        { at: 5, actorId: null, action: 'theme.updated', meta: '{}' },
      ) as Effect.Effect<void>,
    )
    const text = await (await app.handle(request(CONFIG_PATH))).text()
    for (const secret of ['Confidential', 'Cover header', 'Cover footer', 'stored-logo-id', 'pdf']) {
      expect(text).not.toContain(secret)
    }
    const body = JSON.parse(text) as { theme: Record<string, unknown> } & Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['mode', 'theme'])
    expect(Object.keys(body.theme).sort()).toEqual(['colors', 'fonts', 'organisationName', 'schemaVersion'])
    expect(body.theme['organisationName']).toBe('Invented Organisation')
  })

  test('falls back to the default theme when the stored one is not valid', async () => {
    const { app, reports } = await world('demo')
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
    expect(body.theme).toEqual(publicThemeOf(DEFAULT_THEME))
  })

  test('only reads', async () => {
    const { app } = await world('demo')
    const response = await app.handle(request(CONFIG_PATH, 'POST'))
    expect(response.status).toBe(405)
  })
})

describe('runtime mode', () => {
  test('only demo and pilot are modes; unset or blank is a pilot; anything else is an error', () => {
    expect(readRuntimeMode(undefined)).toEqual({ ok: true, mode: 'pilot' })
    expect(readRuntimeMode('')).toEqual({ ok: true, mode: 'pilot' })
    expect(readRuntimeMode('  ')).toEqual({ ok: true, mode: 'pilot' })
    expect(readRuntimeMode('demo')).toEqual({ ok: true, mode: 'demo' })
    expect(readRuntimeMode(' pilot ')).toEqual({ ok: true, mode: 'pilot' })
    for (const value of ['self-hosted', 'Demo', 'PILOT', 'prod', 'demo,pilot', 'pilott']) {
      expect(readRuntimeMode(value)).toEqual({ ok: false, value })
    }
  })

  test('a Worker with a wrong mode logs it and refuses every API request with 500', async () => {
    const logged: Array<unknown> = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      logged.push(args.join(' '))
    })
    try {
      const refusal = modeOf('demoo')
      expect(refusal.refusal?.status).toBe(500)
      expect(await refusal.refusal?.json()).toEqual({ error: 'MisconfiguredRuntimeMode' })
      expect(String(logged[0])).toContain('RUNTIME_MODE must be "demo" or "pilot"')
      expect(modeOf('demo').mode).toBe('demo')
      expect(modeOf(undefined).mode).toBe('pilot')
    } finally {
      spy.mockRestore()
    }
  })

  test('a pilot has none of the legacy triage routes', async () => {
    const pilot = await world('pilot')
    for (const [path, method] of [['/api/login', 'POST'], ['/api/logout', 'POST'], ['/api/session', 'GET']] as const) {
      expect((await pilot.app.handle(request(path, method))).status).toBe(404)
    }
    const demo = await world('demo')
    expect((await demo.app.handle(request('/api/session'))).status).toBe(200)
  })

  test('the triage RPC refuses in a pilot and is served in the demo', async () => {
    const pilot = await world('pilot')
    expect((await pilot.app.handle(request(RPC_PATH, 'POST'))).status).toBe(404)
    const demo = await world('demo')
    expect((await demo.app.handle(request(RPC_PATH, 'POST'))).status).not.toBe(404)
  })
})
