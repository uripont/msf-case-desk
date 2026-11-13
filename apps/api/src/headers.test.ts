import { describe, expect, test } from 'vitest'

import { withReferrerPolicy } from './headers'

describe('Referrer-Policy', () => {
  test('is added to a response whose headers are immutable', () => {
    const asset = Response.redirect('https://desk.test/', 302)
    const out = withReferrerPolicy(asset)
    expect(out.headers.get('referrer-policy')).toBe('no-referrer')
    expect(out.status).toBe(302)
  })

  test('keeps the body and status', async () => {
    const out = withReferrerPolicy(new Response('hello', { status: 201 }))
    expect(out.status).toBe(201)
    expect(await out.text()).toBe('hello')
  })
})
