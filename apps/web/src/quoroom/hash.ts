// NOTE: SHA-256 as lower-case hex, the same text the server makes
// (`sha256Hex`, apps/api), for the redaction confirmation (D14): the browser
// hashes the redacted text it showed and compares it with the hash the server
// stored, then confirms with the hash of the staged hashes and the people list.
const toHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('')

export const sha256Hex = async (text: string): Promise<string> =>
  toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

// NOTE: The confirmation of a share: the hashes of the staged redacted
// sections in section order, a bar, the people hash, a bar and the hash of the
// redacted case title and reference (docs/api.md, `FinishShare.redactionHash`).
export const redactionHashOf = (
  stagedHashes: ReadonlyArray<string>,
  peopleHash: string,
  caseHash: string,
): Promise<string> =>
  sha256Hex(`${stagedHashes.join(',')}|${peopleHash}|${caseHash}`)
