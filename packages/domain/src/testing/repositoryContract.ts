import { Effect, Layer, Option } from 'effect'
import { describe, expect, test } from 'vitest'

import { CaseId } from '../case'
import { type CaseEntry } from '../entry'
import { Repository } from '../repository'
import { DEFAULT_RULES } from '../rules'
import { UserId, type UserRecord } from '../user'

export const SYNTHETIC_USER: UserRecord = {
  id: UserId.make('user-1'),
  email: 'tester@case-desk.test',
  name: 'Synthetic Tester',
  passwordHash: 'not-a-real-hash',
}

export const SYNTHETIC_ENTRY: CaseEntry = {
  centre: 'OCG',
  receivedAt: 1_000,
  summary: 'Synthetic report for the repository contract.',
  scope: 'Team',
  risk: 'Medium',
  urgency: 'Elevated',
  fastTrackSignals: ['Retaliation'],
  channel: 'Email',
}

// NOTE: every Repository implementation runs this same suite, so the
// in-memory Layer used in tests and the D1 Layer behave alike.
export const repositoryContract = (
  name: string,
  makeLayer: () => Layer.Layer<Repository, unknown>,
): void => {
  const run = <A>(program: Effect.Effect<A, unknown, Repository>): Promise<A> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* Repository
        yield* repository.createUser(SYNTHETIC_USER)
        return yield* program
      }).pipe(Effect.provide(makeLayer())),
    )

  describe(`${name} repository`, () => {
    test('a created case can be listed and read back', async () => {
      const id = CaseId.make('CD-1')
      const [created, listed, read] = await run(
        Effect.gen(function* () {
          const repository = yield* Repository
          const created = yield* repository.createCase({
            id,
            entry: SYNTHETIC_ENTRY,
            enteredAt: 2_000,
            enteredBy: SYNTHETIC_USER.id,
          })
          return [
            created,
            yield* repository.listCases(),
            yield* repository.getCase(id),
          ] as const
        }),
      )
      expect(created).toMatchObject({
        ...SYNTHETIC_ENTRY,
        id,
        enteredAt: 2_000,
        enteredByName: SYNTHETIC_USER.name,
        details: '',
        schemaVersion: 1,
      })
      expect(listed).toEqual([created])
      expect(read).toEqual(Option.some(created))
    })

    test('an update changes only the fields it names', async () => {
      const id = CaseId.make('CD-2')
      const updated = await run(
        Effect.gen(function* () {
          const repository = yield* Repository
          yield* repository.createCase({
            id,
            entry: { ...SYNTHETIC_ENTRY, details: 'Kept as it was.' },
            enteredAt: 2_000,
            enteredBy: SYNTHETIC_USER.id,
          })
          return yield* repository.updateCase(id, {
            risk: 'High',
            fastTrackSignals: [],
          })
        }),
      )
      expect(updated).toEqual(
        Option.some(
          expect.objectContaining({
            risk: 'High',
            fastTrackSignals: [],
            urgency: 'Elevated',
            details: 'Kept as it was.',
          }),
        ),
      )
    })

    test('updating a missing case finds nothing', async () => {
      const updated = await run(
        Effect.flatMap(Repository, repository =>
          repository.updateCase(CaseId.make('CD-404'), { risk: 'Low' }),
        ),
      )
      expect(updated).toEqual(Option.none())
    })

    test('a rule set replaces the previous one for its scope', async () => {
      const ruleSets = await run(
        Effect.gen(function* () {
          const repository = yield* Repository
          yield* repository.putRuleSet(
            'OCG',
            DEFAULT_RULES,
            1,
            SYNTHETIC_USER.id,
          )
          yield* repository.putRuleSet(
            'OCG',
            { ...DEFAULT_RULES, version: 'ocg-2', p1MinScore: 6 },
            2,
            SYNTHETIC_USER.id,
          )
          yield* repository.putRuleSet(
            'Default',
            DEFAULT_RULES,
            3,
            SYNTHETIC_USER.id,
          )
          return yield* repository.listRuleSets()
        }),
      )
      expect(ruleSets).toHaveLength(2)
      expect(ruleSets).toContainEqual({
        scope: 'OCG',
        rules: { ...DEFAULT_RULES, version: 'ocg-2', p1MinScore: 6 },
        updatedAt: 2,
        updatedByName: SYNTHETIC_USER.name,
      })
    })

    test('users are found by e-mail in any letter case', async () => {
      const found = await run(
        Effect.flatMap(Repository, repository =>
          repository.findUserByEmail('  Tester@Case-Desk.TEST '),
        ),
      )
      expect(found).toEqual(Option.some(SYNTHETIC_USER))
    })

    test('a session finds its user until it expires or is deleted', async () => {
      const [active, expired, deleted] = await run(
        Effect.gen(function* () {
          const repository = yield* Repository
          yield* repository.createSession({
            tokenHash: 'hash-1',
            userId: SYNTHETIC_USER.id,
            createdAt: 0,
            expiresAt: 100,
          })
          const active = yield* repository.findSessionUser('hash-1', 50)
          const expired = yield* repository.findSessionUser('hash-1', 100)
          yield* repository.deleteSession('hash-1')
          const deleted = yield* repository.findSessionUser('hash-1', 50)
          return [active, expired, deleted] as const
        }),
      )
      expect(active).toEqual(
        Option.some({
          id: SYNTHETIC_USER.id,
          email: SYNTHETIC_USER.email,
          name: SYNTHETIC_USER.name,
        }),
      )
      expect(expired).toEqual(Option.none())
      expect(deleted).toEqual(Option.none())
    })
  })
}
