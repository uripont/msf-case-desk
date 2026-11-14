import { describe, expect, test, vi } from 'vitest'

import { DEFAULT_NOTIFICATION_CONFIG, HOUR, MINUTE } from '@case-desk/domain'

import {
  type TickEnv,
  TICK_PATH,
  constantTimeEqual,
  handleTick,
  notificationConfigFrom,
  runNotificationPass,
} from './tick'
import { makeNodeSqlite } from './testing/nodeSqlite'

// NOTE: `/api/tick` and the settings the stack gives the pass.

const database = async () => makeNodeSqlite()

const tick = (headers: Record<string, string> = {}, method = 'POST') =>
  new Request(`https://desk.test${TICK_PATH}`, { method, headers })

describe('/api/tick', () => {
  test('does not exist without TICK_SECRET', async () => {
    const store = await database()
    expect((await handleTick(tick(), {}, store)).status).toBe(404)
    expect((await handleTick(tick({ authorization: 'Bearer ' }), { TICK_SECRET: '' }, store)).status).toBe(404)
  })

  test('does not exist when the host gives the binding as null (workerd)', async () => {
    const store = await database()
    const env: TickEnv = JSON.parse(
      '{"TICK_SECRET":null,"NOTIFY_REQUEST_DELAY_MINUTES":null}',
    )
    expect((await handleTick(tick(), env, store)).status).toBe(404)
    expect(notificationConfigFrom(env)).toEqual(DEFAULT_NOTIFICATION_CONFIG)
  })

  test('is a 404 for every request that does not carry the secret, whatever the method, and tells nothing else', async () => {
    const store = await database()
    const env = { TICK_SECRET: 'a-long-invented-secret' }
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH']) {
      for (const headers of [
        {},
        { authorization: 'Bearer nope' },
        { authorization: env.TICK_SECRET },
        { authorization: 'Bearer ' },
      ]) {
        const response = await handleTick(tick(headers, method), env, store)
        expect(response.status).toBe(404)
        expect(await response.text()).toBe('')
        expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      }
    }
    // The right secret with a method that is not POST is a 404 as well.
    const right = { authorization: `Bearer ${env.TICK_SECRET}` }
    expect((await handleTick(tick(right, 'GET'), env, store)).status).toBe(404)
    expect((await handleTick(tick(right, 'PUT'), env, store)).status).toBe(404)
  })

  test('runs one pass and answers with counts only', async () => {
    const store = await database()
    const env = { TICK_SECRET: 'a-long-invented-secret' }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const response = await handleTick(
        tick({ authorization: `Bearer ${env.TICK_SECRET}` }),
        env,
        store,
        Date.UTC(2026, 10, 12, 9, 0),
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toMatchObject({
        claimed: 0,
        sent: 0,
        skipped: 0,
        failed: 0,
        released: 0,
        decided: 0,
      })
      expect(log).toHaveBeenCalledOnce()
      expect(String(log.mock.calls[0]?.[0])).toContain('notification_pass')
    } finally {
      log.mockRestore()
    }
  })
})

describe('an idle run', () => {
  test('is one query and builds no layers when nothing is due and it is not the first minute of the hour', async () => {
    const store = await database()
    const summary = await runNotificationPass(
      store,
      DEFAULT_NOTIFICATION_CONFIG,
      Date.UTC(2026, 10, 12, 9, 17),
    )
    expect(summary.queries).toBe(1)
    expect(summary.claimed).toBe(0)
  })

  test('does the housekeeping in the first minute of the hour', async () => {
    const store = await database()
    const summary = await runNotificationPass(
      store,
      DEFAULT_NOTIFICATION_CONFIG,
      Date.UTC(2026, 10, 12, 9, 0),
    )
    expect(summary.queries).toBeGreaterThan(1)
    expect(summary.queries).toBeLessThanOrEqual(10)
  })
})

describe('constantTimeEqual', () => {
  test('equal strings match and any difference, of any length, does not', async () => {
    expect(await constantTimeEqual('secret', 'secret')).toBe(true)
    expect(await constantTimeEqual('secret', 'secreT')).toBe(false)
    expect(await constantTimeEqual('secret', 'secret ')).toBe(false)
    expect(await constantTimeEqual('', 'secret')).toBe(false)
    expect(await constantTimeEqual('', '')).toBe(true)
  })
})

describe('the timings of the stack (D12)', () => {
  test('is parsed once per isolate: the same settings give the same object, and a complaint is logged once', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const env = { NOTIFY_FIRST_REMINDER_MINUTES: 'soon-again' }
      const first = notificationConfigFrom(env)
      for (let index = 0; index < 5; index += 1) {
        expect(notificationConfigFrom(env)).toBe(first)
      }
      expect(error).toHaveBeenCalledTimes(1)
    } finally {
      error.mockRestore()
    }
  })

  test('unset means the production values', () => {
    expect(notificationConfigFrom({})).toEqual(DEFAULT_NOTIFICATION_CONFIG)
  })

  test('minutes are read from the variables', () => {
    expect(
      notificationConfigFrom({
        NOTIFY_REQUEST_DELAY_MINUTES: '0',
        NOTIFY_FIRST_REMINDER_MINUTES: '10',
        NOTIFY_FINAL_REMINDER_MINUTES: '3',
      }),
    ).toEqual({
      requestDelay: 0,
      firstReminderBefore: 10 * MINUTE,
      finalReminderBefore: 3 * MINUTE,
    })
    expect(notificationConfigFrom({ NOTIFY_FIRST_REMINDER_MINUTES: '2880' }).firstReminderBefore).toBe(48 * HOUR)
  })

  test('a value that is not a number of minutes keeps its default', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(
        notificationConfigFrom({
          NOTIFY_FIRST_REMINDER_MINUTES: 'soon',
          NOTIFY_FINAL_REMINDER_MINUTES: '-5',
        }),
      ).toEqual(DEFAULT_NOTIFICATION_CONFIG)
      expect(error).toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })
})
