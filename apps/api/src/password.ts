// NOTE: the stored format is shared by every deployed version, so it must
// stay readable forever: pbkdf2-sha256$<iterations>$<salt>$<hash>, with the
// salt and hash in base64. Web Crypto in Workers allows at most 100,000
// iterations, and each version reads the count from the stored hash.

export const PBKDF2_ITERATIONS = 100_000
const SCHEME = 'pbkdf2-sha256'
const HASH_BITS = 256

const encoder = new TextEncoder()

const toBase64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))

const fromBase64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), character => character.charCodeAt(0))

const derive = async (
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    HASH_BITS,
  )
  return new Uint8Array(bits)
}

export const hashPassword = async (
  password: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<string> => {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(password, salt, iterations)
  return [SCHEME, iterations, toBase64(salt), toBase64(hash)].join('$')
}

const equalInConstantTime = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.reduce(
    (difference, byte, index) => difference | (byte ^ (right[index] ?? 0)),
    0,
  ) === 0

export const verifyPassword = async (
  password: string,
  stored: string,
): Promise<boolean> => {
  const [scheme, iterationsText, saltText, hashText] = stored.split('$')
  const iterations = Number(iterationsText)
  if (
    scheme !== SCHEME ||
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > PBKDF2_ITERATIONS ||
    saltText === undefined ||
    hashText === undefined
  ) {
    return false
  }
  try {
    const expected = fromBase64(hashText)
    const actual = await derive(password, fromBase64(saltText), iterations)
    return equalInConstantTime(actual, expected)
  } catch {
    return false
  }
}

// NOTE: used when no account matches, so a failed sign-in takes as long
// whether or not the e-mail exists.
export const DUMMY_HASH = `${SCHEME}$${PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`
