import { Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  DEFAULT_RULES,
  Repository,
  UserId,
  makeMemoryRepository,
} from '@case-desk/domain'

import { makeApp } from './app'
import { hashPassword } from './password'
import { SESSION_COOKIE } from './session'

const PASSWORD = 'synthetic-password'

// NOTE: one repository instance for all requests, as with D1.
const makeTestApp = async () =>
  makeApp(
    await memoryLayer({
      users: [
        {
          id: UserId.make('user-1'),
          email: 'tester@case-desk.test',
          name: 'Synthetic Tester',
          passwordHash: await hashPassword(PASSWORD, 1_000),
        },
      ],
    }),
  )

const memoryLayer = async (seed: Parameters<typeof makeMemoryRepository>[0]) =>
  Layer.succeed(Repository, await Effect.runPromise(makeMemoryRepository(seed)))

const post = (path: string, body: unknown, cookie?: string) =>
  new Request(`https://desk.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  })

const get = (path: string, cookie?: string) =>
  new Request(`https://desk.test${path}`, {
    headers: cookie === undefined ? {} : { cookie },
  })

const cookieFrom = (response: Response): string =>
  (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

describe('API routes', () => {
  test('the health check answers with the rules version', async () => {
    const app = await makeTestApp()
    const response = await app.handle(get('/api/health'))
    expect(await response.json()).toEqual({
      status: 'ok',
      rulesVersion: DEFAULT_RULES.version,
    })
  })

  test('the RPC path answers with or without a trailing slash', async () => {
    const app = await makeTestApp()
    const bodies = await Promise.all(
      ['/api/rpc', '/api/rpc/'].map(path =>
        app
          .handle(
            post(path, {
              _tag: 'Request',
              id: '1',
              tag: 'ListCases',
              payload: null,
              headers: [],
            }),
          )
          .then(response => response.text()),
      ),
    )
    bodies.forEach(body => {
      expect(body).toContain('Unauthorised')
    })
  })

  test('unknown API paths answer 404', async () => {
    const app = await makeTestApp()
    expect((await app.handle(get('/api/nothing'))).status).toBe(404)
  })
})

describe('sign-in', () => {
  test('signing in sets a session cookie that identifies the user', async () => {
    const app = await makeTestApp()
    const login = await app.handle(
      post('/api/login', {
        email: 'Tester@case-desk.test',
        password: PASSWORD,
      }),
    )
    expect(login.status).toBe(200)
    const setCookie = login.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(`${SESSION_COOKIE}=`)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('SameSite=Strict')

    const session = await app.handle(get('/api/session', cookieFrom(login)))
    expect(session.status).toBe(200)
    expect(await session.json()).toEqual({
      user: {
        id: 'user-1',
        email: 'tester@case-desk.test',
        name: 'Synthetic Tester',
      },
    })
  })

  test('a wrong password or unknown e-mail is refused the same way', async () => {
    const app = await makeTestApp()
    const wrongPassword = await app.handle(
      post('/api/login', { email: 'tester@case-desk.test', password: 'nope' }),
    )
    const unknownEmail = await app.handle(
      post('/api/login', {
        email: 'nobody@case-desk.test',
        password: PASSWORD,
      }),
    )
    expect(wrongPassword.status).toBe(401)
    expect(unknownEmail.status).toBe(401)
    expect(await wrongPassword.json()).toEqual(await unknownEmail.json())
  })

  test('sign-in only accepts a JSON post', async () => {
    const app = await makeTestApp()
    const form = await app.handle(
      new Request('https://desk.test/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `email=tester@case-desk.test&password=${PASSWORD}`,
      }),
    )
    expect(form.status).toBe(400)
  })

  test('signing out ends the session', async () => {
    const app = await makeTestApp()
    const login = await app.handle(
      post('/api/login', {
        email: 'tester@case-desk.test',
        password: PASSWORD,
      }),
    )
    const cookie = cookieFrom(login)
    const logout = await app.handle(post('/api/logout', {}, cookie))
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(
      await (await app.handle(get('/api/session', cookie))).json(),
    ).toEqual({
      user: null,
    })
  })

  test('a made-up session token is refused', async () => {
    const app = await makeTestApp()
    const response = await app.handle(
      get('/api/session', `${SESSION_COOKIE}=${'a'.repeat(64)}`),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ user: null })
  })
})
