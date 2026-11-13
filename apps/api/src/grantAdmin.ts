import { LINK_TTL_MS, UNUSABLE_PASSWORD_HASH } from './links.ts'

// NOTE: D21. The SQL `pnpm grant-admin` appends to the per-environment file
// that the stack imports (`importFiles`, or embedded in the workerd build).
// The whole file is applied again whenever it changes, so every statement is
// idempotent: the account is inserted only if its email is absent, the grants
// look the account up by email, and the link is inserted once (its token hash
// is unique) and only for an account that has no password yet. No password is
// ever written or printed, and an existing account's hash is never touched.

export type GrantAdminInput = Readonly<{
  email: string
  name: string
  now: number
  accountId: string
  invitationId: string
  tokenHash: string
  mode: 'activate' | 'reset'
}>

const quote = (text: string): string => `'${text.replaceAll("'", "''")}'`

export const environmentFile = (environment: string): string =>
  `grants-${environment}.sql`

export const isEnvironment = (value: string): boolean =>
  /^(demo|pilot|workerd|test-[0-9]+)$/.test(value)

export const grantAdminSql = (input: GrantAdminInput): string => {
  const email = quote(input.email.trim().toLowerCase())
  const now = input.now
  const expiresAt = now + LINK_TTL_MS
  const account = `SELECT id FROM users WHERE email = ${email}`
  const unusable = quote(UNUSABLE_PASSWORD_HASH)
  const link = [
    `INSERT INTO invitations (id, token_hash, user_id, purpose, expires_at, used_at, issued_by, created_at)`,
    `SELECT ${quote(input.invitationId)}, ${quote(input.tokenHash)}, id, ${quote(input.mode)}, ${expiresAt}, NULL, NULL, ${now}`,
    `FROM users WHERE email = ${email}`,
    // NOTE: an activation link is only for an account that has no password
    // yet; a reset is for an account that has one.
    input.mode === 'activate'
      ? `AND password_hash = ${unusable}`
      : `AND password_hash <> ${unusable}`,
    `ON CONFLICT (token_hash) DO NOTHING;`,
  ].join(' ')
  const audit = [
    `INSERT INTO audit_events (at, actor_id, action, meta)`,
    `SELECT ${now}, NULL, ${quote(input.mode === 'activate' ? 'account.operator_activation_issued' : 'account.operator_reset_issued')}, ${quote(JSON.stringify({ invitationId: input.invitationId }))}`,
    `WHERE EXISTS (SELECT 1 FROM invitations WHERE token_hash = ${quote(input.tokenHash)})`,
    `AND NOT EXISTS (SELECT 1 FROM audit_events WHERE meta = ${quote(JSON.stringify({ invitationId: input.invitationId }))});`,
  ].join(' ')
  if (input.mode === 'reset') {
    return `${link}\n${audit}\n`
  }
  const grant = (capability: string): string =>
    `INSERT INTO capability_grants (user_id, capability, unit_id, granted_by, granted_at) SELECT id, ${quote(capability)}, '', NULL, ${now} FROM users WHERE email = ${email} ON CONFLICT (user_id, capability, unit_id) DO NOTHING;`
  return [
    `INSERT INTO users (id, email, name, password_hash) VALUES (${quote(input.accountId)}, ${email}, ${quote(input.name.trim())}, ${unusable}) ON CONFLICT (email) DO NOTHING;`,
    `INSERT INTO account_profiles (user_id, whatsapp_consent, notify_on_approval, active, created_at) ${account.replace('SELECT id', `SELECT id, 0, 0, 1, ${now}`)} ON CONFLICT (user_id) DO NOTHING;`,
    grant('admin'),
    grant('template_editor'),
    link,
    audit,
    '',
  ].join('\n')
}
