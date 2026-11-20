import { Crypto, Effect } from 'effect'

import { BrowserCrypto } from '@effect/platform-browser'

// NOTE: The identifier of an upload, which becomes the image's ID. Chosen by
// the browser and the same for every chunk of one image (`ImageChunkQueryFromStrings`),
// so a retried chunk is recognised. A random UUID from the platform Crypto
// service (the lint rules forbid calling `crypto` directly).
export const newUploadId = (): Promise<string> =>
  Effect.runPromise(
    Effect.flatMap(Crypto.Crypto, crypto => crypto.randomUUIDv4).pipe(
      Effect.provide(BrowserCrypto.layer),
    ),
  )
