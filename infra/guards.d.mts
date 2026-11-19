export const ALLOWED_ALCHEMY_FLAGS: ReadonlyArray<string>
export const ACCOUNT_VARIABLES: ReadonlyArray<string>
export const DEFAULT_PROFILE: string
export function refusedFlag(extra: ReadonlyArray<string>): string | undefined
export function parseDotenv(text: string): Record<string, string>
export function accountProblems(
  processEnv: Readonly<Record<string, string | undefined>>,
  dotenv: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string>
export function readDotenv(root: string): Record<string, string>
export function grantsFileOf(root: string, stage: string): string
export function removeGrantsFile(root: string, stage: string): string | undefined
