// NOTE: no imports on purpose. `pnpm grant-admin` runs this file under plain
// Node (type stripping, no bundler), so it can only import files that name
// their imports with extensions; the Worker reads the same values from here.

export const LINK_TTL_MS = 72 * 3_600_000

// NOTE: a stored hash that no password can match (`verifyPassword` refuses an
// iteration count of 0): the account has no password until its link is used.
export const UNUSABLE_PASSWORD_HASH = 'pbkdf2-sha256$0$!$!'

// NOTE: the same value as `LINK_PATH` in the domain package (a test checks it).
export const LINK_PATH = '/link'

// NOTE: the SHA-256 of a token, as hex: the only form in which a link or a
// session token is stored (the same as `hashToken` in session.ts).
export const sha256Hex = async (token: string): Promise<string> =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
    ),
    byte => byte.toString(16).padStart(2, '0'),
  ).join('')
