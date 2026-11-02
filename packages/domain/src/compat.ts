import { Effect, Option, Schema, SchemaGetter } from 'effect'

export const UNKNOWN = 'Unknown'
export type Unknown = typeof UNKNOWN

export const Tolerant = <const L extends ReadonlyArray<string>>(
  literals: Schema.Literals<L>,
) =>
  Schema.Union([literals, Schema.Literal(UNKNOWN)]).pipe(
    Schema.catchDecoding(() => Effect.succeed(Option.some(UNKNOWN))),
  )

export const Col = <S extends Schema.Top>(schema: S, fallback: S['Type']) =>
  Schema.NullOr(schema).pipe(
    Schema.decodeTo(Schema.toType(schema), {
      decode: SchemaGetter.transform(value => value ?? fallback),
      encode: SchemaGetter.transform(value => value),
    }),
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  )
