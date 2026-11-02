import { describe, expect, test } from 'vitest'

import { DEFAULT_RULES } from '@case-desk/domain'

import { handleApi } from './worker'

describe('handleApi', () => {
  test('the health check answers with the rules version', async () => {
    const response = handleApi(new Request('https://desk.test/api/health'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'ok',
      rulesVersion: DEFAULT_RULES.version,
    })
  })

  test('unknown API paths answer 404', () => {
    const response = handleApi(new Request('https://desk.test/api/nothing'))
    expect(response.status).toBe(404)
  })
})
