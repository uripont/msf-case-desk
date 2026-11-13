import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { UNUSABLE_PASSWORD_HASH } from './links.ts'
import { checkResetTarget } from './workerdAccount.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const world = (
  rows: ReadonlyArray<{ email: string; hash: string; active: number }>,
): string => {
  const root = mkdtempSync(join(tmpdir(), 'reset-check-'))
  roots.push(root)
  const folder = join(root, 'case-desk-local-database')
  mkdirSync(folder)
  const db = new DatabaseSync(join(folder, 'abc123.sqlite'))
  db.exec(
    'CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, password_hash TEXT);' +
      'CREATE TABLE account_profiles (user_id TEXT PRIMARY KEY, active INTEGER NOT NULL);',
  )
  rows.forEach((row, index) => {
    db.prepare('INSERT INTO users VALUES (?, ?, ?)').run(`u${index}`, row.email, row.hash)
    db.prepare('INSERT INTO account_profiles VALUES (?, ?)').run(`u${index}`, row.active)
  })
  db.close()
  return root
}

describe('grant-admin --reset check against the local workerd database', () => {
  const email = 'pia.pilot@case-desk.test'

  it('accepts an active account with a password', () => {
    const root = world([{ email, hash: 'pbkdf2-sha256$1$a$b', active: 1 }])
    expect(checkResetTarget([root], email.toUpperCase())).toBe('ok')
  })

  it('refuses an unknown account, one without a password and a deactivated one', () => {
    expect(checkResetTarget([world([])], email)).toBe('no_account')
    expect(
      checkResetTarget([world([{ email, hash: UNUSABLE_PASSWORD_HASH, active: 1 }])], email),
    ).toBe('no_password')
    expect(
      checkResetTarget([world([{ email, hash: 'pbkdf2-sha256$1$a$b', active: 0 }])], email),
    ).toBe('inactive')
  })

  it('reports no database when there is none', () => {
    expect(checkResetTarget([join(tmpdir(), 'reset-check-missing')], email)).toBe('no_database')
  })
})
