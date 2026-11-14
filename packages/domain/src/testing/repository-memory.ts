import { Array, Effect, Layer, Option, Ref, pipe } from 'effect'

import { type NewSession, Repository } from '../repository'
import { type User, type UserRecord, normaliseEmail } from '../user'

// NOTE: the in-memory twin of the accounts `Repository`, for tests only.
// It is not exported from the package index, so no app bundles it.

type StoredSession = NewSession

type MemoryState = Readonly<{
  users: ReadonlyArray<UserRecord>
  sessions: ReadonlyArray<StoredSession>
}>

const toUser = ({ id, email, name }: UserRecord): User => ({ id, email, name })

export const makeMemoryRepository = (
  seed: Partial<MemoryState> = {},
): Effect.Effect<Repository['Service']> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<MemoryState>({
      users: seed.users ?? [],
      sessions: seed.sessions ?? [],
    })

    return Repository.of({
      findUserByEmail: email =>
        Effect.map(Ref.get(state), current =>
          Array.findFirst(
            current.users,
            user => user.email === normaliseEmail(email),
          ),
        ),
      createUser: user =>
        Ref.modify(state, current => [
          toUser(user),
          {
            ...current,
            users: [
              ...current.users,
              { ...user, email: normaliseEmail(user.email) },
            ],
          },
        ]),
      createSession: session =>
        Ref.update(state, current => ({
          ...current,
          sessions: [...current.sessions, session],
        })),
      findSessionUser: (tokenHash, now) =>
        Effect.map(Ref.get(state), current =>
          pipe(
            Array.findFirst(
              current.sessions,
              session =>
                session.tokenHash === tokenHash && session.expiresAt > now,
            ),
            Option.flatMap(session =>
              Array.findFirst(
                current.users,
                user => user.id === session.userId,
              ),
            ),
            Option.map(toUser),
          ),
        ),
      deleteSession: tokenHash =>
        Ref.update(state, current => ({
          ...current,
          sessions: Array.filter(
            current.sessions,
            session => session.tokenHash !== tokenHash,
          ),
        })),
    })
  })

export const layerMemory = (
  seed: Partial<MemoryState> = {},
): Layer.Layer<Repository> =>
  Layer.effect(Repository, makeMemoryRepository(seed))
