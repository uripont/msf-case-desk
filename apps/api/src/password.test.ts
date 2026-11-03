import { describe, expect, test } from 'vitest'

import { DUMMY_HASH, hashPassword, verifyPassword } from './password'

// NOTE: written by this version. Every later version must still accept it,
// because accounts live in the database all versions share.
const FROZEN_HASH =
  'pbkdf2-sha256$100000$/w4jMrvuIj+zCENFxaNV3A==$wLJcFNmANE8uUieV102+oYr/tWeLRrV7jh5Ksy9HHYo='

describe('passwords', () => {
  test('a stored hash from this version stays valid', async () => {
    expect(await verifyPassword('synthetic-password-1', FROZEN_HASH)).toBe(true)
    expect(await verifyPassword('synthetic-password-2', FROZEN_HASH)).toBe(
      false,
    )
  })

  test('a new hash verifies and uses the stored format', async () => {
    const hash = await hashPassword('another synthetic one', 1_000)
    expect(hash).toMatch(
      /^pbkdf2-sha256\$1000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/,
    )
    expect(await verifyPassword('another synthetic one', hash)).toBe(true)
    expect(await verifyPassword('another synthetic two', hash)).toBe(false)
  })

  test('malformed hashes never verify', async () => {
    const malformed = [
      '',
      'plain-text',
      'pbkdf2-sha256$abc$AA==$AA==',
      'pbkdf2-sha256$100001$AA==$AA==',
      'md5$1$AA==$AA==',
      DUMMY_HASH,
    ]
    const results = await Promise.all(
      malformed.map(hash => verifyPassword('anything', hash)),
    )
    expect(results.every(result => !result)).toBe(true)
  })
})
