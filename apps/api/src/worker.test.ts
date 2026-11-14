import { describe, expect, test } from 'vitest'

import { withSequence } from './worker'

// NOTE: the request numbering of the stage 10 CPU measurements: only a stack
// that sets REQUEST_SEQUENCE=1 (a test stage with invocation logs) gets it.
describe('request numbering', () => {
  test('is off unless REQUEST_SEQUENCE is "1"', () => {
    for (const env of [{}, { REQUEST_SEQUENCE: '0' }, { REQUEST_SEQUENCE: 'true' }]) {
      const response = withSequence(env, new Response('x', { headers: { a: 'b' } }))
      expect(response.headers.get('x-seq')).toBeNull()
      expect(response.headers.get('x-isolate')).toBeNull()
      expect(response.headers.get('a')).toBe('b')
    }
  })

  test('numbers the requests of the isolate in order, with one isolate name', async () => {
    const env = { REQUEST_SEQUENCE: '1' }
    const first = withSequence(env, new Response('one', { status: 201 }))
    const second = withSequence(env, new Response('two'))
    expect(Number(second.headers.get('x-seq'))).toBe(Number(first.headers.get('x-seq')) + 1)
    expect(first.headers.get('x-isolate')).toMatch(/^[0-9a-f]{8}$/)
    expect(second.headers.get('x-isolate')).toBe(first.headers.get('x-isolate'))
    expect(first.status).toBe(201)
    expect(await first.text()).toBe('one')
  })
})
