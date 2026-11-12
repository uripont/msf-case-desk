import { Schema } from 'effect'

import { EntryId } from './content'
import { foldedKey, makeMatcher } from './redaction'

// NOTE: The people of a report and their aliases (D14, section 5). The list is
// edited in working copies like content and copied into every shared draft. A
// person has a stable ID, the name as it appears in the report and the aliases
// that replace it for redacted roles (redaction itself is stage 1e).

export const PersonId = EntryId

const PersonName = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
)
const Label = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(200))
const Alias = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(200))

export const Person = Schema.Struct({
  id: PersonId,
  name: PersonName,
  // The replacement shown to redacted roles. Stored, so it stays the same when
  // the list is reordered. Unique in the list and never an alias (see
  // `peopleListProblems`).
  label: Label,
  aliases: Schema.Array(Alias).check(Schema.isMaxLength(50)),
})
export type Person = typeof Person.Type

export const PeopleList = Schema.Array(Person).check(Schema.isMaxLength(500))
export type PeopleList = typeof PeopleList.Type

// NOTE: What makes two aliases the same for comparison: the text without
// surrounding or repeated white space, in Unicode normal form.
export const aliasKey = (alias: string): string =>
  alias.normalize('NFC').trim().replace(/\s+/g, ' ')

export type PeopleProblemCode =
  | 'duplicate-id'
  | 'invalid-label'
  | 'duplicate-label'
  | 'label-matches-alias'

export type PeopleProblem = Readonly<{
  code: PeopleProblemCode
  // The person's ID and the field.
  path: ReadonlyArray<string>
  message: string
}>

// NOTE: What makes a people list unfit for redaction: an ID used twice, a label
// that is empty, untrimmed or too long, two people with the same label (case-
// and accent-insensitive), or a label that matches a name or alias of anyone in
// the list (the redacted text would then be changed again, or be ambiguous).
// A list with no problems can be used by `redactContent`.
export const peopleListProblems = (
  people: ReadonlyArray<Person>,
): ReadonlyArray<PeopleProblem> => {
  const out: Array<PeopleProblem> = []
  const ids = new Set<string>()
  const labels = new Map<string, string>()
  const matcher = makeMatcher(people)
  for (const person of people) {
    if (ids.has(person.id)) {
      out.push({
        code: 'duplicate-id',
        path: [person.id],
        message: `The person "${person.id}" is listed twice`,
      })
    }
    ids.add(person.id)
    const label = person.label
    if (label === '' || label !== label.trim() || label.length > 200) {
      out.push({
        code: 'invalid-label',
        path: [person.id, 'label'],
        message: 'A label is 1 to 200 characters, with no space at either end',
      })
      continue
    }
    const key = foldedKey(label)
    const other = labels.get(key)
    if (other !== undefined) {
      out.push({
        code: 'duplicate-label',
        path: [person.id, 'label'],
        message: `"${label}" is already the label of "${other}"`,
      })
    } else {
      labels.set(key, person.id)
    }
    if (matcher.matches(label).length > 0) {
      out.push({
        code: 'label-matches-alias',
        path: [person.id, 'label'],
        message: `"${label}" holds a name or alias of someone in the list`,
      })
    }
  }
  return out
}

// NOTE: The label for a person being added: the first "Person N" (N = 1, 2, ...)
// no one has, whatever the case or accents.
export const nextDefaultLabel = (people: ReadonlyArray<Person>): string => {
  const used = new Set(people.map(person => foldedKey(person.label)))
  for (let n = 1; ; n++) {
    const label = `Person ${n}`
    if (!used.has(foldedKey(label))) {
      return label
    }
  }
}
