import { type Case, DEMO_START, SEED_CASES } from '@case-desk/domain'

export const DEMO_ACCOUNT_EMAIL = 'demo@case-desk.test'

const quote = (text: string): string => `'${text.replaceAll("'", "''")}'`

// NOTE: times are written relative to the moment the file is imported, so
// the demo cases look as fresh as the seed cases did at DEMO_START. Running
// the import again resets them.
const receivedAtSql = (triageCase: Case): string =>
  `CAST(strftime('%s', 'now') AS INTEGER) * 1000 - ${DEMO_START - triageCase.receivedAt}`

const insertOf = (triageCase: Case): string =>
  [
    'INSERT INTO cases (id, centre, received_at, summary, scope, risk, urgency, fast_track_signals, channel, entered_at, entered_by, schema_version)',
    `VALUES (${[
      quote(triageCase.id.replace('SYN', 'DEMO')),
      quote(triageCase.centre),
      receivedAtSql(triageCase),
      quote(triageCase.summary),
      quote(triageCase.scope),
      quote(triageCase.risk),
      quote(triageCase.urgency),
      quote(JSON.stringify(triageCase.fastTrackSignals)),
      quote(triageCase.channel),
      receivedAtSql(triageCase),
      `(SELECT id FROM users WHERE email = ${quote(DEMO_ACCOUNT_EMAIL)})`,
      '1',
    ].join(', ')})`,
    'ON CONFLICT (id) DO UPDATE SET received_at = excluded.received_at, entered_at = excluded.entered_at;',
  ].join('\n')

export const demoSeedSql = (refreshedOn: string): string =>
  [
    '-- Synthetic demo cases, generated from packages/domain/src/seed.ts.',
    '-- Regenerate with: pnpm --filter @case-desk/api demo:seed',
    `-- Refreshed: ${refreshedOn}`,
    '',
    ...SEED_CASES.map(insertOf),
    '',
  ].join('\n')
