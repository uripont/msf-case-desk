import fc from 'fast-check'
import { Result, Schema } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  type Person,
  Person as PersonSchema,
  nextDefaultLabel,
  peopleListProblems,
  redactText,
} from './index'

const p = (
  id: string,
  name: string,
  label: string,
  aliases: ReadonlyArray<string> = [],
): Person => ({ id, name, label, aliases })

const codes = (people: ReadonlyArray<Person>) =>
  peopleListProblems(people).map(problem => problem.code)

describe('people labels', () => {
  test('a valid list has no problems', () => {
    expect(
      codes([p('a', 'Ana', 'Person 1', ['A.']), p('b', 'Bo', 'Person 2')]),
    ).toEqual([])
  })
  test('labels are non-empty and trimmed in the schema', () => {
    const decode = Schema.decodeUnknownResult(PersonSchema)
    const ok = { id: 'a', name: 'Ana', label: 'Person 1', aliases: [] }
    expect(Result.isSuccess(decode(ok))).toBe(true)
    expect(Result.isFailure(decode({ ...ok, label: '' }))).toBe(true)
    expect(Result.isFailure(decode({ ...ok, label: ' x ' }))).toBe(true)
    expect(Result.isFailure(decode({ ...ok, label: 'x'.repeat(201) }))).toBe(
      true,
    )
    const { label: _label, ...without } = ok
    expect(Result.isFailure(decode(without))).toBe(true)
  })
  test('duplicate labels are refused, case- and accent-insensitive', () => {
    expect(
      codes([p('a', 'Ana', 'Person 3'), p('b', 'Bo', 'person 3')]),
    ).toEqual(['duplicate-label'])
    expect(codes([p('a', 'Ana', 'Témoin'), p('b', 'Bo', 'TEMOIN')])).toEqual([
      'duplicate-label',
    ])
  })
  test('a label that matches a name or alias is refused', () => {
    expect(codes([p('a', 'Ana', 'Person 1', ['Person'])])).toEqual([
      'label-matches-alias',
    ])
    expect(codes([p('a', 'Ana', 'Bo'), p('b', 'Bo', 'Person 2')])).toEqual([
      'label-matches-alias',
    ])
    expect(codes([p('a', 'Ana', 'Ana'), p('b', 'Bo', 'Person 2')])).toEqual([
      'label-matches-alias',
    ])
  })
  test('invalid labels and repeated IDs are reported', () => {
    expect(codes([p('a', 'Ana', '')])).toEqual(['invalid-label'])
    expect(codes([p('a', 'Ana', ' x')])).toEqual(['invalid-label'])
    expect(
      codes([p('a', 'Ana', 'Person 1'), p('a', 'Bo', 'Person 2')]),
    ).toEqual(['duplicate-id'])
  })
  test('nextDefaultLabel is the first unused "Person N"', () => {
    expect(nextDefaultLabel([])).toBe('Person 1')
    expect(
      nextDefaultLabel([p('a', 'Ana', 'Person 1'), p('c', 'Cy', 'Person 3')]),
    ).toBe('Person 2')
    expect(nextDefaultLabel([p('a', 'Ana', 'PERSON 1')])).toBe('Person 2')
    expect(nextDefaultLabel([p('a', 'Ana', 'Witness')])).toBe('Person 1')
  })
  test('reordering the list never changes a label', () => {
    const list = [p('a', 'Ana', 'Person 2'), p('b', 'Bo', 'Person 1')]
    const reversed = [...list].reverse()
    expect(redactText(list, 'Ana met Bo')).toBe('Person 2 met Person 1')
    expect(redactText(reversed, 'Ana met Bo')).toBe('Person 2 met Person 1')
  })
})

describe('regression: problems never repeat what the list holds', () => {
  const SECRET = 'Zq7Secret'
  test('messages and paths carry codes and positions only', () => {
    const list = [
      p('a', `${SECRET} Name`, `${SECRET} Label`, [`${SECRET} Alias`]),
      p('a', 'Other', `${SECRET} label`),
      p('c', 'Third', ` ${SECRET} padded `, []),
      p('d', 'Fourth', `Person about ${SECRET} Alias`),
    ]
    const problems = peopleListProblems(list)
    expect(new Set(problems.map(problem => problem.code))).toEqual(
      new Set(['duplicate-id', 'duplicate-label', 'invalid-label', 'label-matches-alias']),
    )
    for (const problem of problems) {
      expect(problem.message).not.toContain(SECRET)
      expect(JSON.stringify(problem.path)).not.toContain(SECRET)
      expect(problem.path[0]).toBeTypeOf('number')
    }
    expect(problems.find(problem => problem.code === 'duplicate-label')?.path).toEqual([1, 'label'])
  })

  test('property: no label, name or alias is ever in a problem', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.constantFrom('a', 'b', 'c'),
            name: fc.constantFrom('Aq1 Nm', 'Bq2'),
            label: fc.constantFrom('Lbq1', 'lbq1', ' Lbq2', 'Aq1', ''),
            aliases: fc.array(fc.constantFrom('Aq1', 'Lbq1', 'Zq3'), { maxLength: 2 }),
          }),
          { maxLength: 6 },
        ),
        list => {
          for (const problem of peopleListProblems(list)) {
            const text = JSON.stringify([problem.message, problem.path])
            expect(text).not.toMatch(/q1|q2|q3/i)
          }
        },
      ),
      { numRuns: 200 },
    )
  })
})
