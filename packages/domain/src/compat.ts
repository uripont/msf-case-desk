import { Effect, Schema, SchemaGetter } from 'effect'

export const UNKNOWN = 'Unknown'
export type Unknown = typeof UNKNOWN

export const Tolerant = <const L extends ReadonlyArray<string>>(
  literals: Schema.Literals<L>,
) => {
  const isKnown = Schema.is(literals)
  return Schema.String.pipe(
    Schema.decodeTo(Schema.Union([literals, Schema.Literal(UNKNOWN)]), {
      decode: SchemaGetter.transform(value =>
        isKnown(value) ? value : UNKNOWN,
      ),
      encode: SchemaGetter.transform(value => value),
    }),
  )
}

export const Col = <S extends Schema.Top>(schema: S, fallback: S['Type']) =>
  Schema.NullOr(schema).pipe(
    Schema.decodeTo(Schema.toType(schema), {
      decode: SchemaGetter.transform(value => value ?? fallback),
      encode: SchemaGetter.transform(value => value),
    }),
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  )
