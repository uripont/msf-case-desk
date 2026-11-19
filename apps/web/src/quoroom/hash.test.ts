import { describe, expect, test } from 'vitest'

import { redactionHashOf, sha256Hex } from './hash'

// NOTE: the confirmation is the hash of the staged hashes, the people hash and
// the case hash, in the text the server builds (docs/api.md).
describe('redactionHashOf', () => {
  test('is the hash of the staged hashes, the people hash and the case hash', async () => {
    expect(await redactionHashOf(['a', 'b'], 'p', 'c')).toBe(await sha256Hex('a,b|p|c'))
  })

  test('changes with the case hash, so a retitled case file is another share', async () => {
    expect(await redactionHashOf(['a'], 'p', 'c1')).not.toBe(await redactionHashOf(['a'], 'p', 'c2'))
  })
})
