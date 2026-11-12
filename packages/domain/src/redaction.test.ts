import { Result } from 'effect'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import {
  CONTENT_SCHEMA_VERSION,
  IMAGE_WITHHELD_TEXT,
  type ParagraphNode,
  type Person,
  type ReportContent,
  type RichTextDoc,
  containsAlias,
  canonicalRichText,
  decodeRichText,
  personLabel,
  redactContent,
  redactDraft,
  redactFileName,
  redactRichText,
  redactText,
  redactorFor,
  validateContent,
} from './index'
import { MINI_TEMPLATE, templateWithContentArbitrary } from './testing/content'
import { withImageFlags } from './testing/drafts'

const person = (
  id: string,
  name: string,
  aliases: ReadonlyArray<string> = [],
  label = 'Person 1',
): Person => ({ id, name, label, aliases })

const ANA = person('p1', 'Ana Garcia', ['Ana', 'Anita'])

const doc = (...blocks: RichTextDoc['content']): RichTextDoc => ({
  type: 'doc',
  content: blocks,
})
const para = (...texts: ReadonlyArray<string>): ParagraphNode => ({
  type: 'paragraph',
  content: texts.map(text => ({ type: 'text' as const, text })),
})

const contentWith = (
  values: Record<string, ReportContent['sections'][string]['values'][string]>,
): ReportContent => ({
  schemaVersion: CONTENT_SCHEMA_VERSION,
  templateId: MINI_TEMPLATE.id,
  templateVersion: MINI_TEMPLATE.version,
  sections: { details: { values, sections: {} } },
})

describe('redactText: matching', () => {
  const r = (text: string, people: ReadonlyArray<Person> = [ANA]) =>
    redactText(people, text)

  test('names and aliases become the label of the person', () => {
    expect(r('Ana Garcia met Anita and ana.')).toBe(
      'Person 1 met Person 1 and Person 1.',
    )
  })
  test('labels follow the position in the list', () => {
    const people = [
      person('a', 'Zed', [], 'Person 1'),
      person('b', 'Yan', [], 'Person 2'),
    ]
    expect(r('Yan and Zed', people)).toBe('Person 2 and Person 1')
    expect(personLabel(people, 'b')).toBe('Person 2')
    expect(personLabel(people, 'nobody')).toBeUndefined()
  })
  test('possessives', () => {
    expect(r("Ana's report, Ana’s notes, Anita's")).toBe(
      "Person 1's report, Person 1’s notes, Person 1's",
    )
  })
  test('case', () => {
    expect(r('ANA, aNa and ana')).toBe('Person 1, Person 1 and Person 1')
  })
  test('accents match both ways', () => {
    const jose = [person('j', 'José')]
    expect(r('Jose and JOSÉ and José', jose)).toBe(
      'Person 1 and Person 1 and Person 1',
    )
    const plain = [person('j', 'Jose')]
    expect(r('José, Jose, Josè', plain)).toBe('Person 1, Person 1, Person 1')
    // A decomposed accent (e + combining acute).
    expect(r('José said', plain)).toBe('Person 1 said')
    expect(r('José said', [person('j', 'José')])).toBe('Person 1 said')
  })
  test('letters that do not decompose are folded by hand', () => {
    expect(r('Søren, Soren and Strasse', [person('s', 'Søren')])).toBe(
      'Person 1, Person 1 and Strasse',
    )
    expect(r('Strasse', [person('s', 'Straße')])).toBe('Person 1')
  })
  test('longest alias first, and overlapping aliases are replaced as one', () => {
    expect(r('Ana Garcia Lopez')).toBe('Person 1 Lopez')
    const two = [
      person('a', 'Ana Maria', [], 'Person 1'),
      person('b', 'Maria Lopez', [], 'Person 2'),
      person('c', 'Ana Maria Lopez Ruiz', [], 'Person 3'),
    ]
    expect(r('Ana Maria Lopez Ruiz', two)).toBe('Person 3')
    expect(r('Ana Maria Lopez', two.slice(0, 2))).toBe('Person 1 / Person 2')
  })
  test('an alias is never replaced inside another word', () => {
    expect(r('Banana, Anabel, Anan and Ana')).toBe(
      'Banana, Anabel, Anan and Person 1',
    )
    expect(r('Ana2 and 2Ana and Ana_x')).toBe('Ana2 and 2Ana and Person 1_x')
  })
  test('punctuation is a boundary', () => {
    expect(r('(Ana), "Ana"; Ana! Ana? Ana-Maria, ana/Anita')).toBe(
      '(Person 1), "Person 1"; Person 1! Person 1? Person 1-Maria, Person 1/Person 1',
    )
    expect(r('Dr. Okafor said', [person('o', 'Dr. Okafor')])).toBe(
      'Person 1 said',
    )
  })
  test('Unicode boundaries and scripts', () => {
    expect(r('Anaé and éAna and Ana é', [ANA])).toBe(
      'Anaé and éAna and Person 1 é',
    )
    const cyr = [person('c', 'Анна')]
    expect(r("Анна's and Аннамария and Ανα", cyr)).toBe(
      "Person 1's and Аннамария and Ανα",
    )
    const greek = [person('g', 'Άννα')]
    expect(r('ΑΝΝΑ and Αννα', greek)).toBe('Person 1 and Person 1')
    const han = [person('h', '王明')]
    // Han has no word boundaries: a name inside a run of Han letters is found.
    expect(r('王明说', han)).toBe('Person 1说')
  })
  test('white space runs and apostrophe variants are equal', () => {
    expect(r('Ana   \nGarcia')).toBe('Person 1')
    expect(r("O’Brien and O'Brien", [person('o', "O'Brien")])).toBe(
      'Person 1 and Person 1',
    )
    expect(r('Jean–Pierre', [person('j', 'Jean-Pierre')])).toBe('Person 1')
  })
  test('zero-width characters inside a name do not hide it', () => {
    expect(r('An​a', [ANA])).toBe('Person 1')
    expect(r('A­na', [ANA])).toBe('Person 1')
  })
  test('regression: names in scripts written without spaces are found', () => {
    expect(r('田中さんは来た', [person('t', '田中')])).toBe('Person 1さんは来た')
    expect(r('昨日、山田太郎が来た', [person('y', '山田太郎')])).toBe(
      '昨日、Person 1が来た',
    )
    // Katakana, Thai, Khmer, Lao and Myanmar.
    expect(r('これはタナカです', [person('k', 'タナカ')])).toBe(
      'これはPerson 1です',
    )
    expect(r('วันนี้สมชายไปตลาด', [person('t', 'สมชาย')])).toBe(
      'วันนี้Person 1ไปตลาด',
    )
    expect(r('សួស្តីសុខា។', [person('k', 'សុខា')])).toBe('សួស្តីPerson 1។')
    expect(r('ສະບາຍດີສົມຊາຍ', [person('l', 'ສົມຊາຍ')])).toBe('ສະບາຍດີPerson 1')
    expect(r('မင်္ဂလာပါမောင်မောင်', [person('m', 'မောင်မောင်')])).toBe(
      'မင်္ဂလာပါPerson 1',
    )
    // A name in a spaced script next to one without spaces is still a name.
    expect(r('Ana田中', [ANA, person('t', '田中', [], 'Person 2')])).toBe(
      'Person 1Person 2',
    )
    // Spaced scripts keep their boundaries.
    expect(r('Banana Anaé', [ANA])).toBe('Banana Anaé')
  })
  test('regression: format characters are separators, and offsets stay right', () => {
    for (const cf of ['\u200b', '\u200c', '\u200d', '\u2060', '\u00ad', '\u200e', '\ufeff']) {
      expect(r(`Ana${cf}Garcia`, [ANA])).toBe('Person 1')
      expect(r(`x Ana${cf}Garcia y`, [ANA])).toBe('x Person 1 y')
      expect(r(`Ana${cf}`, [ANA])).toBe('Person 1')
      expect(r(`Anita${cf}Garcia`, [ANA])).toBe("Person 1Garcia")
    }
    // Inside a word they hide nothing either.
    expect(r('A\u200bn\u200ba', [ANA])).toBe('Person 1')
    // The text around the match is kept as it was, format characters too.
    expect(r('a\u200b Ana\u200bGarcia \u200bb', [ANA])).toBe(
      'a\u200b Person 1 \u200bb',
    )
    // Across text nodes.
    const out = redactRichText(
      [ANA],
      doc({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Ana\u200b', marks: [{ type: 'bold' }] },
          { type: 'text', text: 'Garcia came' },
        ],
      }),
    )
    expect(JSON.stringify(out)).not.toMatch(/Ana|Garcia/)
  })
  test('two people with one alias: the earlier wins', () => {
    expect(
      r('Sam', [person('a', 'Sam'), person('b', 'Sam', [], 'Person 2')]),
    ).toBe('Person 1')
  })
  test('no people, or nothing to find, changes nothing', () => {
    expect(r('Ana', [])).toBe('Ana')
    expect(r('Nobody here')).toBe('Nobody here')
    expect(r('')).toBe('')
    expect(containsAlias([ANA], 'x Ana y')).toBe(true)
    expect(containsAlias([ANA], 'Banana')).toBe(false)
  })
  test('file names and metadata strings', () => {
    expect(r('Report - Ana Garcia (final).pdf')).toBe(
      'Report - Person 1 (final).pdf',
    )
    expect(redactFileName([ANA], 'ana_garcia.pdf')).toBe('Person 1.pdf')
    expect(redactFileName([ANA], 'Banana-Ana.Garcia.v2.pdf')).toBe(
      'Banana-Person 1.v2.pdf',
    )
    expect(r('Ana_x')).toBe('Person 1_x')
  })
  test('redacting a redacted text changes nothing', () => {
    const once = r("Ana Garcia, Anita's and Ana")
    expect(r(once)).toBe(once)
  })
})

describe('redactRichText', () => {
  test('a name split across text nodes with different marks', () => {
    const out = redactRichText(
      [ANA],
      doc({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Met ' },
          { type: 'text', text: 'Ana', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' Garcia', marks: [{ type: 'italic' }] },
          { type: 'text', text: ' today' },
        ],
      }),
    )
    expect(out).toEqual(
      doc({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Met ' },
          { type: 'text', text: 'Person 1', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' today' },
        ],
      }),
    )
  })
  test('a name over a line break', () => {
    const out = redactRichText(
      [ANA],
      doc({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Ana' },
          { type: 'hardBreak' },
          { type: 'text', text: 'Garcia left' },
        ],
      }),
    )
    expect(out).toEqual(doc(para('Person 1 left')))
  })
  test('headings, lists, table cells and captions', () => {
    const input = doc(
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'About Ana' }],
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [para('Anita said')],
          },
        ],
      },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [para('Who')] },
              { type: 'tableCell', content: [para('Ana Garcia')] },
            ],
          },
        ],
      },
      {
        type: 'figure',
        attrs: { imageId: 'img-1', alt: 'Photo of Ana', safeToShare: true },
        content: [{ type: 'text', text: "Ana's desk" }],
      },
    )
    const out = redactRichText([ANA], input)
    expect(JSON.stringify(out)).not.toMatch(/ana|garcia|anita/i)
    expect(JSON.stringify(out)).toContain('About Person 1')
    expect(JSON.stringify(out)).toContain('Photo of Person 1')
    expect(Result.isSuccess(decodeRichText(out))).toBe(true)
  })
  test('link text, link title and link targets', () => {
    const link = (href: string, title?: string) => ({
      type: 'link' as const,
      attrs: title === undefined ? { href } : { href, title },
    })
    const out = redactRichText(
      [ANA],
      doc({
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Ana',
            marks: [link('https://example.org/x', 'About Ana')],
          },
          {
            type: 'text',
            text: ' a',
            marks: [link('https://example.org/ana-garcia')],
          },
          {
            type: 'text',
            text: ' b',
            marks: [link('mailto:ana.garcia@example.org')],
          },
          {
            type: 'text',
            text: ' c',
            marks: [link('https://example.org/%41na')],
          },
          {
            type: 'text',
            text: ' d',
            marks: [link('https://example.org/Anita?x=1')],
          },
          {
            type: 'text',
            text: ' e',
            marks: [link('https://example.org/banana')],
          },
        ],
      }),
    )
    const nodes = (
      out.content[0] as {
        content: ReadonlyArray<{
          text: string
          marks?: ReadonlyArray<{
            type: string
            attrs?: { href: string; title?: string }
          }>
        }>
      }
    ).content
    expect(nodes[0]?.text).toBe('Person 1')
    expect(nodes[0]?.marks?.[0]?.attrs).toEqual({
      href: 'https://example.org/x',
      title: 'About Person 1',
    })
    const hrefs = nodes.flatMap(n => n.marks?.map(m => m.attrs?.href) ?? [])
    expect(hrefs).toEqual([
      'https://example.org/x',
      'https://example.org/banana',
    ])
    expect(JSON.stringify(out)).not.toMatch(/garcia|anita|%41na/i)
  })
  test('an image that is not marked safe leaves no trace', () => {
    const out = redactRichText(
      [],
      doc(para('before'), {
        type: 'figure',
        attrs: { imageId: 'secret-img', alt: 'a face', safeToShare: false },
        content: [{ type: 'text', text: 'caption' }],
      }),
    )
    const text = JSON.stringify(out)
    expect(text).not.toContain('secret-img')
    expect(text).not.toContain('a face')
    expect(text).not.toContain('caption')
    expect(text).toContain(IMAGE_WITHHELD_TEXT)
    expect(out.content.some(b => b.type === 'figure')).toBe(false)
    expect(Result.isSuccess(decodeRichText(out))).toBe(true)
  })
  test('a document of only withheld images stays a valid document', () => {
    const out = redactRichText(
      [],
      doc({
        type: 'figure',
        attrs: { imageId: 'i', alt: '', safeToShare: false },
      }),
    )
    expect(out.content.length).toBe(1)
    expect(Result.isSuccess(decodeRichText(out))).toBe(true)
  })
  test('a safe image is kept with its ID', () => {
    const input = doc({
      type: 'figure',
      attrs: { imageId: 'img-ok', alt: 'a chart', safeToShare: true },
    })
    expect(redactRichText([ANA], input)).toEqual(input)
  })
  test('a document with no match is rebuilt in canonical form, never returned as it came', () => {
    const noisy = doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    })
    const out = redactRichText([ANA], noisy)
    expect(out).not.toBe(noisy)
    expect(out).toEqual(canonicalRichText(noisy))
    expect(redactRichText([], noisy)).not.toBe(noisy)
  })
})

describe('regression: link attributes carry no free text', () => {
  const linkDoc = (attrs: Record<string, unknown>) => ({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'hello',
            marks: [
              { type: 'link', attrs: { href: 'https://example.org/a', ...attrs } },
            ],
          },
        ],
      },
    ],
  })
  test('the schema refuses a class, and a rel or target that is free text', () => {
    for (const attrs of [
      { class: 'Ana Garcia' },
      { rel: 'ana garcia' },
      { target: 'Ana Garcia' },
    ]) {
      expect(Result.isFailure(decodeRichText(linkDoc(attrs)))).toBe(true)
    }
    for (const attrs of [
      { class: null, rel: 'noopener noreferrer nofollow', target: '_blank' },
      { rel: null, target: null },
    ]) {
      expect(Result.isSuccess(decodeRichText(linkDoc(attrs)))).toBe(true)
    }
  })
  test('redaction rebuilds the document, so no attribute can get through', () => {
    const hostile = linkDoc({
      class: 'Ana Garcia',
      rel: 'ana garcia',
      target: 'Ana',
      extra: 'Anita',
    }) as unknown as RichTextDoc
    const out = redactRichText([ANA], hostile)
    expect(out).not.toBe(hostile)
    expect(JSON.stringify(out)).not.toMatch(/ana|garcia|anita/i)
    expect(out.content[0]).toMatchObject({
      content: [
        { text: 'hello', marks: [{ attrs: { href: 'https://example.org/a' } }] },
      ],
    })
  })
})

describe('redactContent', () => {
  test('every string field a redacted role can receive', () => {
    const content: ReportContent = {
      schemaVersion: CONTENT_SCHEMA_VERSION,
      templateId: MINI_TEMPLATE.id,
      templateVersion: MINI_TEMPLATE.version,
      sections: {
        details: {
          values: {
            name: { type: 'text', text: 'Ana Garcia' },
            when: { type: 'date', date: '2026-01-02' },
            proceed: { type: 'select', optionIds: ['yes'] },
          },
          sections: {},
        },
        extras: {
          notApplicable: { reason: "Ana's request" },
          values: {
            'extras-text': { type: 'rich_text', doc: doc(para('Ana')) },
          },
          sections: {},
        },
        things: {
          values: {},
          sections: {
            thing: {
              values: {},
              sections: {},
              entries: [
                {
                  id: 'e1',
                  title: 'Ana in the kitchen',
                  values: {
                    'thing-title': { type: 'text', text: 'Anita' },
                    'thing-refs': {
                      type: 'repeated',
                      entries: [
                        {
                          id: 'r1',
                          title: 'Ref Ana',
                          values: {
                            'ref-text': { type: 'text', text: 'see Ana' },
                          },
                        },
                      ],
                    },
                  },
                  sections: {
                    'thing-facts': {
                      values: {
                        'thing-facts-text': {
                          type: 'rich_text',
                          doc: doc(para('Facts about Ana')),
                        },
                      },
                      sections: {},
                    },
                  },
                },
              ],
            },
          },
        },
        sign: {
          values: {
            signature: {
              type: 'signature',
              name: 'Ana Garcia',
              date: '2026-01-02',
            },
          },
          sections: {},
        },
      },
    }
    expect(Result.isSuccess(validateContent(MINI_TEMPLATE, content))).toBe(true)
    const out = redactContent([ANA], content)
    expect(JSON.stringify(out)).not.toMatch(/ana|garcia/i)
    expect(Result.isSuccess(validateContent(MINI_TEMPLATE, out))).toBe(true)
    // Dates, options and IDs are untouched.
    expect(out.sections.details?.values.when).toEqual({
      type: 'date',
      date: '2026-01-02',
    })
    expect(out.sections.details?.values.proceed).toEqual({
      type: 'select',
      optionIds: ['yes'],
    })
    expect(out.sections.things?.sections.thing?.entries?.[0]?.id).toBe('e1')
  })

  test('with no people it is the same content', () => {
    const content = contentWith({ name: { type: 'text', text: 'Ana Garcia' } })
    expect(redactContent([], content)).toEqual(content)
  })

  test('with no people images that are not safe are still withheld', () => {
    const content = contentWith({
      nick: {
        type: 'rich_text',
        doc: doc({
          type: 'figure',
          attrs: { imageId: 'img-9', alt: '', safeToShare: false },
        }),
      },
    })
    expect(JSON.stringify(redactContent([], content))).not.toContain('img-9')
  })

  test('results are cut to the schema limits', () => {
    const people = [person('x', 'X')]
    const content = contentWith({
      nick: { type: 'not_applicable', reason: 'X '.repeat(240).trim() },
    })
    const out = redactContent(people, content)
    const reason = (out.sections.details?.values.nick as { reason: string })
      .reason
    expect(reason.length).toBeLessThanOrEqual(500)
    expect(reason).toBe(reason.trim())
    const titled = {
      ...content,
      sections: {
        things: {
          values: {},
          sections: {
            thing: {
              values: {},
              sections: {},
              entries: [
                {
                  id: 'e1',
                  title: 'X '.repeat(100).trim(),
                  values: {},
                  sections: {},
                },
              ],
            },
          },
        },
      },
    }
    const title = redactContent(people, titled).sections.things?.sections.thing
      ?.entries?.[0]?.title
    expect((title ?? '').length).toBeLessThanOrEqual(200)
  })

  test('the redactor is reusable and the draft carries labels, not names', () => {
    const content = contentWith({ name: { type: 'text', text: 'Ana Garcia' } })
    const redactor = redactorFor([ANA])
    expect(redactor.text('Ana')).toBe('Person 1')
    const draft = redactDraft({
      content,
      people: [ANA, person('p2', 'Bo', ['B'], 'Person 2')],
    })
    expect(draft.people).toEqual([
      { id: 'p1', name: 'Person 1', label: 'Person 1', aliases: [] },
      { id: 'p2', name: 'Person 2', label: 'Person 2', aliases: [] },
    ])
    expect(JSON.stringify(draft)).not.toMatch(/ana|garcia|bo\b/i)
  })
})

// ---- The independent check -----------------------------------------------------------------
//
// This tokenizer shares no code with the production matcher: it lower-cases,
// strips combining marks and cuts on everything that is not a letter or a
// number, then looks for the tokens of an alias as a run in the tokens of a
// text.

const tokens = (text: string): ReadonlyArray<string> =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(token => token !== '')

// NOTE: Written for this test and not shared with the production matcher. A
// name leaks if, in either reading of the format characters (as nothing, or as
// a space), its tokens appear as a run, or, for a script without spaces, its
// letters appear as a substring.
const NO_SPACES = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Khmer}\p{sc=Lao}\p{sc=Myanmar}]/u
const FORMAT_CHARS = /\p{Cf}/gu
const leaks = (text: string, alias: string): boolean => {
  const readings = [text.replace(FORMAT_CHARS, ''), text.replace(FORMAT_CHARS, ' ')]
  const name = alias.replace(FORMAT_CHARS, '')
  return readings.some(reading =>
    NO_SPACES.test(name)
      ? stripAccents(reading.toLowerCase())
          .replace(/\s+/g, '')
          .includes(stripAccents(name.toLowerCase()).replace(/\s+/g, ''))
      : hasRun(tokens(reading), tokens(name)),
  )
}

const hasRun = (
  haystack: ReadonlyArray<string>,
  needle: ReadonlyArray<string>,
) => {
  if (needle.length === 0) {
    return false
  }
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((token, k) => haystack[i + k] === token)) {
      return true
    }
  }
  return false
}

// Keys whose strings are structure, not text.
const STRUCTURE = new Set([
  'type',
  'id',
  'imageId',
  'templateId',
  'optionIds',
  'personIds',
  'date',
  'schemaVersion',
  'templateVersion',
])

const textLeaves = (
  value: unknown,
  key: string | undefined,
  out: Array<string>,
) => {
  if (typeof value === 'string') {
    if (key === undefined || !STRUCTURE.has(key)) {
      out.push(value)
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      textLeaves(entry, key, out)
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [k, entry] of Object.entries(value)) {
      textLeaves(entry, k, out)
    }
  }
}

const allTextOf = (value: unknown): ReadonlyArray<string> => {
  const out: Array<string> = []
  textLeaves(value, undefined, out)
  return out
}

// NOTE: Redaction rebuilds every rich text in canonical form, so "unchanged"
// means unchanged up to that.
const canonicalContent = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalContent)
  }
  if (value !== null && typeof value === 'object') {
    const node = value as { type?: unknown; content?: unknown }
    if (node.type === 'doc') {
      return canonicalRichText(value as RichTextDoc)
    }
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, canonicalContent(v)]),
    )
  }
  return value
}

const POOL: ReadonlyArray<Person> = [
  person('pa', 'Zorvak', ['Maëlle Quenta'], 'Person 1'),
  person('pb', 'José Quill', ["O'Rourke Vance", 'Xander'], 'Person 2'),
  person('pc', 'Ilka', [], 'Person 3'),
  // Scripts written without spaces between words.
  person('pd', '田中', ['山田太郎'], 'Person 4'),
  person('pe', 'สมชาย', ['タナカ'], 'Person 5'),
  person('pf', 'សុខា', ['ສົມຊາຍ', 'မောင်မောင်'], 'Person 6'),
]

const aliasesOf = (people: ReadonlyArray<Person>) =>
  people.flatMap(p => [p.name, ...p.aliases])

const stripAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')

const FORMATS: ReadonlyArray<string> = [
  '\u200b',
  '\u200c',
  '\u200d',
  '\u2060',
  '\u00ad',
  '\u200e',
]

const inject = (
  value: unknown,
  key: string | undefined,
  aliases: ReadonlyArray<string>,
  counter: { n: number },
): unknown => {
  if (typeof value === 'string') {
    if (aliases.length === 0) {
      return value
    }
    const alias = aliases[counter.n % aliases.length] as string
    const variant = counter.n % 9
    counter.n++
    if (key === 'href') {
      const slug = tokens(alias).join('-')
      return /^https?:/i.test(value) ? `${value}/${slug}` : `${value}?q=${slug}`
    }
    if (
      key !== 'text' &&
      key !== 'alt' &&
      key !== 'title' &&
      key !== 'reason' &&
      key !== 'name'
    ) {
      return value
    }
    const forms = [
      `${alias} ${value}`,
      `${value} ${alias}.`,
      `(${alias.toUpperCase()}) ${value}`,
      `${stripAccents(alias)}'s ${value}`,
      `${value}, ${alias.toLowerCase()};`,
      `${value}-${alias}`,
      // Without spaces around it, a space inside it replaced by a format
      // character, and format characters between its letters.
      `${value}${alias}${value}`,
      `${value} ${alias.replace(/ /g, FORMATS[counter.n % FORMATS.length] as string)} ${value}`,
      `${value} ${Array.from(alias).join(FORMATS[counter.n % FORMATS.length] as string)} ${value}`,
    ]
    const form = (forms[variant] as string).trim()
    // Text nodes sit next to each other: keep a name from touching a word of
    // the next node, which would make it another word.
    return key === 'text' ? ` ${form} ` : form
  }
  if (Array.isArray(value)) {
    return value.map(entry => inject(entry, key, aliases, counter))
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, entry]) => [
        k,
        STRUCTURE.has(k) ? entry : inject(entry, k, aliases, counter),
      ]),
    )
  }
  return value
}

const figuresOf = (
  value: unknown,
  out: Array<{ imageId: string; safe: boolean }>,
) => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      figuresOf(entry, out)
    }
  } else if (value !== null && typeof value === 'object') {
    const node = value as {
      type?: unknown
      attrs?: { imageId?: string; safeToShare?: boolean }
    }
    if (node.type === 'figure' && node.attrs?.imageId !== undefined) {
      out.push({
        imageId: node.attrs.imageId,
        safe: node.attrs.safeToShare === true,
      })
    }
    for (const entry of Object.values(value)) {
      figuresOf(entry, out)
    }
  }
}

describe('stage 1 done-when: no alias and no unmarked image', () => {
  const flagsArb = fc.record({
    'img-1': fc.boolean(),
    'img-2': fc.boolean(),
    'img-3': fc.boolean(),
  })
  const peopleArb = fc
    .subarray([...POOL], { minLength: 1 })
    .map(list => list as ReadonlyArray<Person>)

  test('for generated templates, content and people lists', () => {
    fc.assert(
      fc.property(
        templateWithContentArbitrary,
        peopleArb,
        flagsArb,
        ({ template, content }, people, flags) => {
          const aliases = aliasesOf(people)
          const injected = inject(content, undefined, aliases, { n: 0 })
          const prepared = withImageFlags(injected as ReportContent, flags)
          // The input is valid and does hold names.
          expect(Result.isSuccess(validateContent(template, prepared))).toBe(
            true,
          )

          const out = redactContent(people, prepared)

          // 1. No alias in any text of the output: the independent check.
          for (const text of allTextOf(out)) {
            for (const alias of aliases) {
              expect(leaks(text, alias), `"${alias}" in "${text}"`).toBe(false)
            }
          }
          // 2. No unmarked image, and no ID of one anywhere.
          const used: Array<{ imageId: string; safe: boolean }> = []
          figuresOf(prepared, used)
          const unsafe = new Set(used.filter(f => !f.safe).map(f => f.imageId))
          const kept: Array<{ imageId: string; safe: boolean }> = []
          figuresOf(out, kept)
          expect(kept.every(f => f.safe && !unsafe.has(f.imageId))).toBe(true)
          expect(kept.length).toBe(used.filter(f => f.safe).length)
          const json = JSON.stringify(out)
          for (const id of unsafe) {
            expect(json).not.toContain(`"${id}"`)
          }
          // 3. A valid document of the same schema.
          expect(Result.isSuccess(validateContent(template, out))).toBe(true)
          // 4. Idempotent.
          expect(redactContent(people, out)).toEqual(out)
          // 5. The draft's people list holds labels only.
          const draft = redactDraft({ content: prepared, people })
          expect(allTextOf(draft.people).join(' ')).not.toMatch(
            /zorvak|quill|ilka|quenta|xander|rourke|田中|山田|สมชาย|タナカ/i,
          )
        },
      ),
      { numRuns: 200 },
    )
  })

  test('property: a name split across text nodes, in any script, with format characters', () => {
    const aliasArb = fc.constantFrom(...aliasesOf(POOL))
    const splitArb = fc.array(fc.nat(50), { minLength: 1, maxLength: 4 })
    const formatArb = fc.constantFrom('', ...FORMATS)
    const markArb = fc.constantFrom<'bold' | 'italic' | 'underline' | undefined>(
      undefined,
      'bold',
      'italic',
      'underline',
    )
    fc.assert(
      fc.property(
        aliasArb,
        splitArb,
        formatArb,
        fc.constantFrom('', ' ', ', ', '-'),
        fc.constantFrom('', ' ', ' and '),
        markArb,
        fc.constantFrom(' ', ...FORMATS),
        (alias, cuts, format, before, after, mark, gap) => {
          const chars = Array.from(alias.replace(/ /g, gap))
          const points = [...new Set(cuts.map(c => c % (chars.length + 1)))].sort(
            (a, b) => a - b,
          )
          const pieces: Array<string> = []
          let last = 0
          for (const point of [...points, chars.length]) {
            pieces.push(chars.slice(last, point).join(''))
            last = point
          }
          const nodes = [
            before,
            ...pieces.map((piece, index) =>
              index < pieces.length - 1 ? piece + format : piece,
            ),
            after,
          ]
            .filter(piece => piece !== '')
            .map((text, index) => ({
              type: 'text' as const,
              text,
              ...(mark !== undefined && index % 2 === 0
                ? { marks: [{ type: mark }] }
                : {}),
            }))
          const input = doc({ type: 'paragraph', content: nodes } as never)
          const out = redactRichText(POOL, input)
          const joined = (
            out.content[0] as { content?: ReadonlyArray<{ text?: string }> }
          ).content
            ?.map(node => node.text ?? '')
            .join('')
          for (const name of aliasesOf(POOL)) {
            expect(leaks(joined ?? '', name), `"${name}" in "${joined}"`).toBe(
              false,
            )
          }
        },
      ),
      { numRuns: 600 },
    )
  })

  test('the independent check catches a leak (it is not vacuous)', () => {
    expect(leaks('Ana\u200bGarcia', 'Ana Garcia')).toBe(true)
    expect(leaks('田中さんは来た', '田中')).toBe(true)
    expect(leaks('Person 4さんは来た', '田中')).toBe(false)
    const leaked = tokens('Met maëlle  QUENTA.')
    expect(hasRun(leaked, tokens('Maëlle Quenta'))).toBe(true)
    expect(hasRun(tokens('Quentas'), tokens('Quenta'))).toBe(false)
  })

  test('with no people and only safe images the content is unchanged', () => {
    fc.assert(
      fc.property(templateWithContentArbitrary, ({ template, content }) => {
        const safe = withImageFlags(content, {
          'img-1': true,
          'img-2': true,
          'img-3': true,
        })
        expect(Result.isSuccess(validateContent(template, safe))).toBe(true)
        expect(redactContent([], safe)).toEqual(canonicalContent(safe))
      }),
      { numRuns: 100 },
    )
  })

  test('redaction does not change what it is not asked to change', () => {
    fc.assert(
      fc.property(templateWithContentArbitrary, ({ content }) => {
        const safe = withImageFlags(content, {
          'img-1': true,
          'img-2': true,
          'img-3': true,
        })
        // People whose names are not in the text: only canonical form may differ.
        expect(redactContent([person('z', 'Qwertzuiop')], safe)).toEqual(
          canonicalContent(safe),
        )
      }),
      { numRuns: 60 },
    )
  })
})
