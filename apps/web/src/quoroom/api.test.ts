import { Effect, Redacted } from 'effect'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { QUOROOM_PUBLIC_PATH, QUOROOM_RPC_PATH } from '@case-desk/domain'

import { withPublic, withQuoroom } from './api'

type Captured = Readonly<{ url: string; body: string }>

// NOTE: Effect keeps the first `fetch` it finds, so the stand-in is installed
// once for the whole file and each test reads what it sent.
const captured: Array<Captured> = []

vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input)
  const body =
    input instanceof Request
      ? await input.clone().text()
      : String(init?.body ?? '')
  captured.push({ url, body })
  return new Response('[]', { status: 200 })
})

beforeEach(() => {
  captured.length = 0
})

const pathOf = (captures: ReadonlyArray<Captured>): string =>
  new URL(captures[0]?.url ?? '', 'http://localhost').pathname.replace(
    /\/$/,
    '',
  )

const SYNTHETIC_TOKEN = Redacted.make('fedcba9876543210fedcba9876543210')

describe('Quoroom RPC clients', () => {
  test('the public client posts to its own path, with the token in the body only', async () => {
    await Effect.runPromise(
      withPublic(client =>
        client.InspectLink({ token: Redacted.value(SYNTHETIC_TOKEN) }),
      ).pipe(Effect.ignore),
    )
    expect(captured).toHaveLength(1)
    const [request] = captured
    expect(pathOf(captured)).toBe(QUOROOM_PUBLIC_PATH)
    expect(request?.url).not.toContain('?')
    expect(request?.url).not.toContain(Redacted.value(SYNTHETIC_TOKEN))
    expect(request?.body).toContain(Redacted.value(SYNTHETIC_TOKEN))
  })

  test('the signed-in client posts to the signed-in path', async () => {
    await Effect.runPromise(
      withQuoroom(client => client.GetMe()).pipe(Effect.ignore),
    )
    expect(captured).toHaveLength(1)
    expect(pathOf(captured)).toBe(QUOROOM_RPC_PATH)
  })

  test('the password of a sign-in goes in the body and never in the address', async () => {
    await Effect.runPromise(
      withPublic(client =>
        client.SignIn({
          email: 'tester@case-desk.test',
          password: 'synthetic-password-1',
        }),
      ).pipe(Effect.ignore),
    )
    expect(captured[0]?.url ?? '').not.toContain('synthetic-password-1')
    expect(captured[0]?.body).toContain('synthetic-password-1')
  })
})
