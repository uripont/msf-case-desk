// Adds or updates a Case Desk account in .local/users.sql, which the
// deployment imports into the shared database. The file holds password
// hashes, never passwords, and is git-ignored.
//
//   pnpm users:add --email name@example.org --name "Full Name" [--password ...]
//
// Without --password a random one is generated and printed once.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'

import { hashPassword } from '../src/password.ts'

export const USERS_SQL = join(import.meta.dirname, '../../../.local/users.sql')

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    password: { type: 'string' },
    file: { type: 'string' },
  },
})

const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
  throw new Error(message)
}

const email = values.email?.trim().toLowerCase() ?? ''
const name = values.name?.trim() ?? ''

if (!/^[^\s@]+@[^\s@]+$/.test(email) || name === '') {
  fail(
    'Usage: pnpm users:add --email <email> --name "<name>" [--password <password>]',
  )
}

const generated = values.password === undefined
const password =
  values.password ??
  Array.from(crypto.getRandomValues(new Uint8Array(12)), byte =>
    byte.toString(36).padStart(2, '0'),
  )
    .join('')
    .slice(0, 16)

if (password.length < 10) {
  fail('Use a password of at least 10 characters.')
}

const quote = (text: string): string => `'${text.replaceAll("'", "''")}'`
const id = `user-${crypto.randomUUID().slice(0, 8)}`
const hash = await hashPassword(password)
const file = values.file ?? USERS_SQL

mkdirSync(dirname(file), { recursive: true })
appendFileSync(
  file,
  `INSERT INTO users (id, email, name, password_hash) VALUES (${quote(id)}, ${quote(email)}, ${quote(name)}, ${quote(hash)}) ON CONFLICT (email) DO UPDATE SET name = excluded.name, password_hash = excluded.password_hash;\n`,
)

console.log(`Saved ${email} in ${file}.`)
if (generated) {
  console.log(`Password (shown once): ${password}`)
}
console.log('Deploy (pnpm infra:deploy) or restart the local run to load it.')
