// Grants the first account of an environment (D21). It never writes or
// prints a password: it appends idempotent SQL to .local/grants-<env>.sql,
// which the environment's stack imports (importFiles) or the workerd build
// embeds, and prints the one-time link (72 hours) once.
//
//   pnpm grant-admin --env demo --email sam@example.org --name "Sam Synthetic"
//   pnpm grant-admin --env workerd --email sam@example.org --reset
//
// --env is demo, pilot, workerd or test-<name>. --origin is the address the app
// is served from, to print a complete link. The account gets the People, Theme
// and Templates capabilities; author is granted in the app, per unit.
// Run it again for the same email to get a fresh activation link. --reset
// issues a reset link for an account that already has a password. For
// `--env workerd` it first checks, in the local database, that the account
// exists, has a password and is active, and refuses otherwise. For the other
// environments the database is on Cloudflare and cannot be read from here: the
// generated SQL only makes the link when the account is there, and the script
// says so.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'

import {
  environmentFile,
  grantAdminSql,
  isEnvironment,
} from '../src/grantAdmin.ts'
import { LINK_PATH, LINK_TTL_MS, sha256Hex } from '../src/links.ts'
import { checkResetTarget, resetProblemText } from '../src/workerdAccount.ts'

const { values } = parseArgs({
  options: {
    env: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
    reset: { type: 'boolean', default: false },
    origin: { type: 'string' },
    dir: { type: 'string' },
  },
})

const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
  throw new Error(message)
}

const environment = values.env ?? ''
const email = values.email?.trim().toLowerCase() ?? ''
const name = values.name?.trim() ?? ''
const reset = values.reset === true

if (
  !isEnvironment(environment) ||
  !/^[^\s@]+@[^\s@]+$/.test(email) ||
  (!reset && name === '')
) {
  fail(
    'Usage: pnpm grant-admin --env <demo|pilot|workerd|test-NAME> --email <email> --name "<name>" [--origin <address>]\n       pnpm grant-admin --env <...> --email <email> --reset',
  )
}

// NOTE: workerd's database is a local file, so a reset can be verified there.
const localDirectory = join(import.meta.dirname, '../../../.local')
if (reset && environment === 'workerd') {
  const check = checkResetTarget(
    [join(localDirectory, 'workerd-data'), join(localDirectory, 'workerd-data-pilot')],
    email,
  )
  if (check !== 'ok') {
    fail(`No reset link was made for ${email}. ${resetProblemText(check)}`)
  }
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

const token = hex(crypto.getRandomValues(new Uint8Array(32)))
const now = Date.now()
const sql = grantAdminSql({
  email,
  name,
  now,
  accountId: `acc-${crypto.randomUUID().slice(0, 8)}`,
  invitationId: `inv-${crypto.randomUUID().slice(0, 8)}`,
  importId: `imp-${crypto.randomUUID()}`,
  tokenHash: await sha256Hex(token),
  mode: reset ? 'reset' : 'activate',
})

const directory = values.dir ?? localDirectory
const file = join(directory, environmentFile(environment))
mkdirSync(dirname(file), { recursive: true })
appendFileSync(file, sql)

const origin =
  values.origin ??
  (environment === 'workerd' ? 'http://127.0.0.1:8787' : '<address of the app>')

console.log(`Saved ${email} in ${file}.`)
console.log(
  `One-time ${reset ? 'reset' : 'activation'} link, valid until ${new Date(now + LINK_TTL_MS).toISOString()} (shown once, nothing else holds the token):`,
)
console.log(`${origin.replace(/\/$/, '')}${LINK_PATH}#${token}`)
console.log(
  environment === 'workerd'
    ? 'Restart `pnpm workerd` to load it.'
    : 'Deploy the environment (it imports the file) before opening the link.',
)
if (!reset) {
  console.log(
    'If the account already has a password, the link does nothing: use --reset.',
  )
} else if (environment !== 'workerd') {
  console.log(
    `This reset link works only if ${email} exists in that environment's database, has a password and is active; this script cannot check that from here, and otherwise the link does nothing (the page says it does not work).`,
  )
}
