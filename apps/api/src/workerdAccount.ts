import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { UNUSABLE_PASSWORD_HASH } from './links.ts'

// NOTE: What `pnpm grant-admin --reset --env workerd` checks before it prints a
// link: that the account is in the database of the local workerd, has a
// password and is active. workerd keeps its database as SQLite files of a
// Durable Object under `<data folder>/case-desk-local-database/`; they are only
// read here, never written. A link for an account that is missing, has no
// password yet (it needs an activation link) or is deactivated would do
// nothing, so the script refuses instead of printing it.
export type ResetCheck =
  | 'ok'
  | 'no_database'
  | 'no_account'
  | 'no_password'
  | 'inactive'

const DATABASE_FOLDER = 'case-desk-local-database'

const databaseFiles = (dataDirectory: string): ReadonlyArray<string> => {
  const folder = join(dataDirectory, DATABASE_FOLDER)
  return existsSync(folder)
    ? readdirSync(folder)
        .filter(name => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
        .map(name => join(folder, name))
    : []
}

const checkOne = (file: string, email: string): ResetCheck => {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const row = db
      .prepare(
        `SELECT u.password_hash AS hash, p.active AS active
           FROM users u LEFT JOIN account_profiles p ON p.user_id = u.id
          WHERE u.email = ?`,
      )
      .get(email.trim().toLowerCase())
    if (row === undefined) return 'no_account'
    if (row['hash'] === UNUSABLE_PASSWORD_HASH) return 'no_password'
    return row['active'] === 0 ? 'inactive' : 'ok'
  } catch {
    // NOTE: a file with no `users` table is not the application's database.
    return 'no_database'
  } finally {
    db.close()
  }
}

// NOTE: the demo and the pilot builds keep separate data folders and share one
// grants file, so the account may be in either; one database where it is fine
// is enough.
export const checkResetTarget = (
  dataDirectories: ReadonlyArray<string>,
  email: string,
): ResetCheck => {
  const results = dataDirectories
    .flatMap(databaseFiles)
    .map(file => checkOne(file, email))
    .filter(result => result !== 'no_database')
  if (results.length === 0) return 'no_database'
  if (results.includes('ok')) return 'ok'
  return (
    results.find(result => result !== 'no_account') ?? 'no_account'
  )
}

export const resetProblemText = (check: Exclude<ResetCheck, 'ok'>): string => {
  switch (check) {
    case 'no_database':
      return 'No local workerd database was found. Start `pnpm workerd` once (and load the account) first.'
    case 'no_account':
      return 'No account with that e-mail is in the local workerd database.'
    case 'no_password':
      return 'That account has no password yet: it needs an activation link. Run the command without --reset.'
    case 'inactive':
      return 'That account is deactivated, so a new password would not let it sign in.'
  }
}
