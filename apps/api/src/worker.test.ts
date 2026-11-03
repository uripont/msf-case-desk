import { describe, expect, test } from 'vitest'

import { DEFAULT_RULES } from '@case-desk/domain'

import { type Env, handleApi } from './worker'

const env = {} as Env

describe('handleApi', () => {
  test('the health check answers with the rules version', async () => {
    const response = await handleApi(
      new Request('https://desk.test/api/health'),
      env,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'ok',
      rulesVersion: DEFAULT_RULES.version,
    })
  })

  test('unknown API paths answer 404', async () => {
    const response = await handleApi(
      new Request('https://desk.test/api/nothing'),
      env,
    )
    expect(response.status).toBe(404)
  })
})
