// The checks of scripts/pilot-stack.mjs, apart from it so they can be tested
// without running Alchemy.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// NOTE: flags passed on to alchemy are an allowlist. Anything else is refused,
// which includes --stage, --config, --env-file, --profile and -p (they choose
// the stack, the stage or the account), and positional arguments.
export const ALLOWED_ALCHEMY_FLAGS = ['--yes', '-y', '--dry-run', '--detailed']

export const refusedFlag = extra =>
  extra.find(flag => !ALLOWED_ALCHEMY_FLAGS.includes(flag))

// NOTE: the account is the one in the Alchemy profile `default`. Environment
// variables that Alchemy honours to pick another profile, account or
// credentials are refused when set to anything but that default (unset, or
// ALCHEMY_PROFILE=default), in the process environment or in `.env`.
export const DEFAULT_PROFILE = 'default'
export const ACCOUNT_VARIABLES = [
  'ALCHEMY_PROFILE',
  'ALCHEMY_HOME',
  'CLOUDFLARE_ACCOUNT_ID',
  'ALCHEMY_CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_EMAIL',
  'CLOUDFLARE_ACCOUNT_EMAIL',
  'CLOUDFLARE_AUTH_PROVIDER_NAME',
]

// NOTE: KEY=value lines, as Alchemy reads them: optional `export`, quotes
// around the value, `#` comments. Only the names matter here.
export const parseDotenv = text =>
  Object.fromEntries(
    text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('#'))
      .map(line => /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line))
      .filter(match => match !== null)
      .map(match => [
        match[1],
        match[2].replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2').trim(),
      ]),
  )

// NOTE: returns the refusal messages (names only, never values).
export const accountProblems = (processEnv, dotenv) => {
  const problems = []
  for (const [where, values] of [
    ['the environment', processEnv],
    ['.env', dotenv],
  ]) {
    for (const name of ACCOUNT_VARIABLES) {
      const value = (values[name] ?? '').trim()
      if (value === '') continue
      if (name === 'ALCHEMY_PROFILE' && value === DEFAULT_PROFILE) continue
      problems.push(`${name} is set in ${where}`)
    }
  }
  return problems
}

export const readDotenv = root => {
  const file = join(root, '.env')
  return existsSync(file) ? parseDotenv(readFileSync(file, 'utf8')) : {}
}

// NOTE: `.local/grants-test-<name>.sql` belongs to the test environment
// `test_<name>`: removed when the environment is destroyed, so a later
// environment of the same name does not start with an old administrator.
export const grantsFileOf = (root, stage) =>
  join(root, '.local', `grants-test-${stage.slice('test_'.length)}.sql`)

export const removeGrantsFile = (root, stage) => {
  const file = grantsFileOf(root, stage)
  if (!existsSync(file)) return undefined
  rmSync(file)
  return file
}
