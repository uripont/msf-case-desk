import { Schema } from 'effect'

import { EntryId } from './content'

// NOTE: The people of a report and their aliases (D14, section 5). The list is
// edited in working copies like content and copied into every shared draft. A
// person has a stable ID, the name as it appears in the report and the aliases
// that replace it for redacted roles (redaction itself is stage 1e).

export const PersonId = EntryId

const PersonName = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
)
const Alias = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(200))

export const Person = Schema.Struct({
  id: PersonId,
  name: PersonName,
  aliases: Schema.Array(Alias).check(Schema.isMaxLength(50)),
})
export type Person = typeof Person.Type

export const PeopleList = Schema.Array(Person).check(Schema.isMaxLength(500))
export type PeopleList = typeof PeopleList.Type

// NOTE: What makes two aliases the same for comparison: the text without
// surrounding or repeated white space, in Unicode normal form.
export const aliasKey = (alias: string): string =>
  alias.normalize('NFC').trim().replace(/\s+/g, ' ')
