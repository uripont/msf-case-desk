import { Array, Effect, Layer, Option, Result, Schema, pipe } from 'effect'

import {
  Case,
  type CaseId,
  type CasePatch,
  FAST_TRACK_SIGNALS,
  type NewCase,
  Repository,
  RepositoryError,
  type RuleSet,
  RuleSetScope,
  type TriageRules,
  Tolerant,
  type User,
  type UserId,
  UserRecord,
  normaliseEmail,
} from '@case-desk/domain'

import { type SqlDatabase, type SqlValue } from './sql'

const query = <A>(
  operation: string,
  run: () => Promise<A>,
): Effect.Effect<A, RepositoryError> =>
  Effect.tryPromise({
    try: run,
    catch: error =>
      new RepositoryError({
        message: `${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
  })

const decodeCase = Schema.decodeUnknownResult(Case)
const decodeUser = Schema.decodeUnknownOption(UserRecord)
const decodeScope = Schema.decodeUnknownSync(Tolerant(RuleSetScope))

const parseJsonArray = (text: unknown): ReadonlyArray<unknown> => {
  if (typeof text !== 'string') {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const CASE_SELECT = `SELECT c.id, c.centre, c.received_at, c.summary, c.scope,
  c.risk, c.urgency, c.fast_track_signals, c.channel, c.details, c.location,
  c.reference, c.entered_at, c.schema_version, u.name AS entered_by_name
  FROM cases c LEFT JOIN users u ON u.id = c.entered_by`

type CaseRow = Record<string, unknown>

const caseFromRow = (row: CaseRow): Result.Result<Case, unknown> =>
  decodeCase({
    id: row['id'],
    centre: row['centre'],
    receivedAt: row['received_at'],
    summary: row['summary'],
    scope: row['scope'],
    risk: row['risk'],
    urgency: row['urgency'],
    fastTrackSignals: parseJsonArray(row['fast_track_signals']),
    channel: row['channel'],
    details: row['details'],
    location: row['location'],
    reference: row['reference'],
    enteredAt: row['entered_at'],
    enteredByName: row['entered_by_name'],
    schemaVersion: row['schema_version'],
  })

const CASE_COLUMNS: Record<keyof CasePatch, string> = {
  summary: 'summary',
  scope: 'scope',
  risk: 'risk',
  urgency: 'urgency',
  fastTrackSignals: 'fast_track_signals',
  channel: 'channel',
  details: 'details',
  location: 'location',
  reference: 'reference',
}

const isKnownSignal = (value: unknown): boolean =>
  typeof value === 'string' && FAST_TRACK_SIGNALS.some(known => known === value)

// NOTE: signals this version does not know were written by a newer one.
// They are kept, so editing the list here never drops them.
const mergeSignals = (stored: unknown, next: ReadonlyArray<string>): string =>
  JSON.stringify([
    ...next,
    ...Array.filter(parseJsonArray(stored), value => !isKnownSignal(value)),
  ])

type RuleSetRow = Record<string, unknown>

const ruleSetFromRow = (row: RuleSetRow): RuleSet => ({
  scope: decodeScope(String(row['scope'])),
  rules: {
    version: String(row['version']),
    p1MinScore: Number(row['p1_min_score']),
    p2MinScore: Number(row['p2_min_score']),
    fastTrackHours: Number(row['fast_track_hours']),
    targetHours: {
      P1: Number(row['target_hours_p1']),
      P2: Number(row['target_hours_p2']),
      P3: Number(row['target_hours_p3']),
    },
  },
  updatedAt: Number(row['updated_at']),
  updatedByName:
    typeof row['updated_by_name'] === 'string' ? row['updated_by_name'] : '',
})

const RULE_SET_SELECT = `SELECT r.*, u.name AS updated_by_name
  FROM rule_sets r LEFT JOIN users u ON u.id = r.updated_by`

const userFromRow = (row: Record<string, unknown> | null) =>
  pipe(
    Option.fromNullishOr(row),
    Option.flatMap(present =>
      decodeUser({
        id: present['id'],
        email: present['email'],
        name: present['name'],
        passwordHash: present['password_hash'],
      }),
    ),
  )

const toUser = ({ id, email, name }: UserRecord): User => ({ id, email, name })

export const makeSqlRepository = (db: SqlDatabase): Repository['Service'] => {
  const getCase = (id: CaseId) =>
    query('Reading a case', () =>
      db.prepare(`${CASE_SELECT} WHERE c.id = ?`).bind(id).first<CaseRow>(),
    ).pipe(
      Effect.map(row =>
        pipe(
          Option.fromNullishOr(row),
          Option.flatMap(present => Result.getSuccess(caseFromRow(present))),
        ),
      ),
    )

  const getCaseOrFail = (id: CaseId) =>
    Effect.flatMap(getCase(id), maybeCase =>
      Option.match(maybeCase, {
        onNone: () =>
          Effect.fail(
            new RepositoryError({ message: `Case ${id} is missing` }),
          ),
        onSome: Effect.succeed,
      }),
    )

  const getRuleSet = (scope: string) =>
    query('Reading a rule set', () =>
      db
        .prepare(`${RULE_SET_SELECT} WHERE r.scope = ?`)
        .bind(scope)
        .first<RuleSetRow>(),
    ).pipe(
      Effect.flatMap(row =>
        row === null
          ? Effect.fail(
              new RepositoryError({ message: `Rule set ${scope} is missing` }),
            )
          : Effect.succeed(ruleSetFromRow(row)),
      ),
    )

  const patchValues = (
    patch: CasePatch,
    storedSignals: unknown,
  ): ReadonlyArray<readonly [string, SqlValue]> =>
    Array.filterMap(
      Object.entries(CASE_COLUMNS),
      ([field, column]): Result.Result<readonly [string, SqlValue], void> => {
        if (field === 'fastTrackSignals') {
          return patch.fastTrackSignals === undefined
            ? Result.failVoid
            : Result.succeed([
                column,
                mergeSignals(storedSignals, patch.fastTrackSignals),
              ])
        }
        const value = Object.entries(patch).find(([key]) => key === field)?.[1]
        return typeof value === 'string'
          ? Result.succeed([column, value])
          : Result.failVoid
      },
    )

  return Repository.of({
    listCases: () =>
      query('Listing cases', () =>
        db
          .prepare(`${CASE_SELECT} ORDER BY c.received_at, c.id`)
          .all<CaseRow>(),
      ).pipe(
        Effect.map(({ results }) =>
          Array.filterMap(results, row =>
            Result.mapError(caseFromRow(row), () => undefined),
          ),
        ),
      ),
    getCase,
    createCase: (newCase: NewCase) =>
      query('Creating a case', () =>
        db
          .prepare(
            `INSERT INTO cases (id, centre, received_at, summary, scope, risk,
              urgency, fast_track_signals, channel, details, location,
              reference, entered_at, entered_by, schema_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            newCase.id,
            newCase.entry.centre,
            newCase.entry.receivedAt,
            newCase.entry.summary,
            newCase.entry.scope,
            newCase.entry.risk,
            newCase.entry.urgency,
            JSON.stringify(newCase.entry.fastTrackSignals),
            newCase.entry.channel,
            newCase.entry.details ?? null,
            newCase.entry.location ?? null,
            newCase.entry.reference ?? null,
            newCase.enteredAt,
            newCase.enteredBy,
            1,
          )
          .run(),
      ).pipe(Effect.andThen(getCaseOrFail(newCase.id))),
    updateCase: (id, patch) =>
      Effect.gen(function* () {
        const stored = yield* query('Reading a case for update', () =>
          db
            .prepare('SELECT fast_track_signals FROM cases WHERE id = ?')
            .bind(id)
            .first<{ fast_track_signals: unknown }>(),
        )
        if (stored === null) {
          return Option.none()
        }
        const values = patchValues(patch, stored.fast_track_signals)
        if (Array.isReadonlyArrayNonEmpty(values)) {
          const assignments = values
            .map(([column]) => `${column} = ?`)
            .join(', ')
          yield* query('Updating a case', () =>
            db
              .prepare(`UPDATE cases SET ${assignments} WHERE id = ?`)
              .bind(...values.map(([, value]) => value), id)
              .run(),
          )
        }
        return yield* getCase(id)
      }),
    listRuleSets: () =>
      query('Listing rule sets', () =>
        db.prepare(`${RULE_SET_SELECT} ORDER BY r.scope`).all<RuleSetRow>(),
      ).pipe(Effect.map(({ results }) => Array.map(results, ruleSetFromRow))),
    putRuleSet: (scope, rules: TriageRules, updatedAt, updatedBy: UserId) =>
      query('Saving a rule set', () =>
        db
          .prepare(
            `INSERT INTO rule_sets (scope, version, p1_min_score, p2_min_score,
              fast_track_hours, target_hours_p1, target_hours_p2,
              target_hours_p3, updated_at, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (scope) DO UPDATE SET
              version = excluded.version,
              p1_min_score = excluded.p1_min_score,
              p2_min_score = excluded.p2_min_score,
              fast_track_hours = excluded.fast_track_hours,
              target_hours_p1 = excluded.target_hours_p1,
              target_hours_p2 = excluded.target_hours_p2,
              target_hours_p3 = excluded.target_hours_p3,
              updated_at = excluded.updated_at,
              updated_by = excluded.updated_by`,
          )
          .bind(
            scope,
            rules.version,
            rules.p1MinScore,
            rules.p2MinScore,
            rules.fastTrackHours,
            rules.targetHours.P1,
            rules.targetHours.P2,
            rules.targetHours.P3,
            updatedAt,
            updatedBy,
          )
          .run(),
      ).pipe(Effect.andThen(getRuleSet(scope))),
    findUserByEmail: email =>
      query('Finding a user', () =>
        db
          .prepare('SELECT * FROM users WHERE email = ?')
          .bind(normaliseEmail(email))
          .first(),
      ).pipe(Effect.map(userFromRow)),
    createUser: user =>
      query('Creating a user', () =>
        db
          .prepare(
            'INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)',
          )
          .bind(
            user.id,
            normaliseEmail(user.email),
            user.name,
            user.passwordHash,
          )
          .run(),
      ).pipe(Effect.as(toUser({ ...user, email: normaliseEmail(user.email) }))),
    createSession: session =>
      query('Creating a session', () =>
        db
          .prepare(
            'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
          )
          .bind(
            session.tokenHash,
            session.userId,
            session.createdAt,
            session.expiresAt,
          )
          .run(),
      ).pipe(Effect.asVoid),
    findSessionUser: (tokenHash, now) =>
      query('Finding a session', () =>
        db
          .prepare(
            `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND s.expires_at > ?`,
          )
          .bind(tokenHash, now)
          .first(),
      ).pipe(Effect.map(row => Option.map(userFromRow(row), toUser))),
    deleteSession: tokenHash =>
      query('Deleting a session', () =>
        db
          .prepare('DELETE FROM sessions WHERE token_hash = ?')
          .bind(tokenHash)
          .run(),
      ).pipe(Effect.asVoid),
  })
}

export const layerSql = (db: SqlDatabase): Layer.Layer<Repository> =>
  Layer.succeed(Repository, makeSqlRepository(db))
