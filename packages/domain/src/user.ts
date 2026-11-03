import { Schema } from 'effect'

export const UserId = Schema.NonEmptyString.pipe(Schema.brand('UserId'))
export type UserId = typeof UserId.Type

export const Email = Schema.Trimmed.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^[^\s@]+@[^\s@]+$/),
)

export const User = Schema.Struct({
  id: UserId,
  email: Schema.String,
  name: Schema.String,
})
export type User = typeof User.Type

export const UserRecord = Schema.Struct({
  ...User.fields,
  passwordHash: Schema.String,
})
export type UserRecord = typeof UserRecord.Type

export const normaliseEmail = (email: string): string =>
  email.trim().toLowerCase()
