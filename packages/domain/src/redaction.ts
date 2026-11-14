import type { DraftData } from './compare'
import type {
  ItemEntry,
  ItemValue,
  ItemValues,
  ReportContent,
  SectionContent,
  SectionContents,
  SectionEntry,
} from './content'
import type { Person } from './people'
import {
  type BlockNode,
  type InlineNode,
  type ListBlock,
  type ListItemNode,
  type Mark,
  type RichTextDoc,
  type TableCellNode,
  type TableHeaderNode,
  canonicalRichText,
} from './richtext'

// NOTE: Redaction (D14, stage 1e). Pure functions: no clock, no I/O. The API
// calls them only for roles whose view is `redacted`; a `full` role reads the
// original, so the `full` code path must never reach this file.
//
// What is replaced. Every name and alias of every person is replaced by that
// person's display label in every text a redacted role can receive: text and
// signature values, entry titles, *not applicable* reasons (of items and of
// sections), rich text (text nodes, link titles and targets, table cells,
// captions, alt text). Strings that are not part of the content (the case file
// title as it was when shared, a reply to a comment, a file name, PDF metadata,
// the outcome text of a branch that ended the report) go through `redactText`.
//
// The label. A person's display label is stored on the person (`label`, by
// default "Person N", see `nextDefaultLabel`), so reordering the list never
// changes what reviewers read. Redacted drafts carry the people list with the label as the name and no
// aliases, so a people item can be shown as its label.
//
// Matching. Case-insensitive and accent-insensitive (NFKD without marks, a few
// letters folded by hand: ø, đ, ł, ß, æ, œ, ı), whitespace runs equal, curly
// apostrophes and dash variants equal, combining marks transparent. Format
// characters (zero-width space, joiners, word joiner, soft hyphen, bidi marks:
// `\p{Cf}`) are never deleted: each run becomes one marker in the folded text
// that a name may have between any two of its letters (as nothing) and that
// also counts as the separator between its words (so "Ana<ZWSP>Garcia" is
// "Ana Garcia", and "Ana<ZWSP>s" still holds "Ana"). Offsets stay in the
// original text, and a trailing marker is replaced with the name. A match must sit on
// whole words: the character before and after is not a letter or a number (so
// "Ana's" matches "Ana" and "Banana" does not). Scripts written without
// spaces (Han, Hiragana, Katakana, Thai, Khmer, Lao, Myanmar, Tibetan) have no
// word boundaries: a name in them matches wherever it occurs, and their
// characters never count as a word next to a name in another script.
// Every occurrence of every alias is found, the longest alias first. A match
// that is not entirely inside a longer one adds coverage, and overlapping
// matches are replaced as one range, labelled with each person involved ("Person
// 1 / Person 2"), so no part of a name survives. Two people with the same alias:
// the earlier person wins. Matching runs over a whole text block, across text
// nodes (a name split by bold stays one name) and over line breaks.
//
// Rich text. A document is always rebuilt in canonical form, never returned as
// it came, so no attribute or field of the input can get through. A
// link whose target contains an alias (also percent-encoded, or split by `.`,
// `-`, `_`, `/`, `@`) loses the link and keeps its redacted text. An image whose
// `safeToShare` is false is replaced by a paragraph "Image withheld": its ID,
// alt text and caption leave the document. Results are cut to the length limits
// of the schema, so a redacted document is always valid.
//
// Ambiguities resolved conservatively: matching is also done on the loose form
// for link targets; the signature name is redacted like any text; a label never
// appears in an alias check, so an alias that equals a label word (for example
// "Person") is the author's problem and will also hit later labels if redacted
// twice.

export const IMAGE_WITHHELD_TEXT = 'Image withheld'

// NOTE: The display label of a person, or `undefined` if the ID is not listed.
export const personLabel = (
  people: ReadonlyArray<Person>,
  personId: string,
): string | undefined => people.find(person => person.id === personId)?.label

// ---- Folding --------------------------------------------------------------------------

type Folded = {
  readonly text: string
  // Per UTF-16 unit of `text`, the span of the original text it came from.
  readonly starts: ReadonlyArray<number>
  readonly ends: ReadonlyArray<number>
}

const SPECIAL: Readonly<Record<string, string>> = {
  ß: 'ss',
  ø: 'o',
  đ: 'd',
  ł: 'l',
  æ: 'ae',
  œ: 'oe',
  ı: 'i',
  ς: 'σ',
  '’': "'",
  '‘': "'",
  ʼ: "'",
  '`': "'",
  '´': "'",
  '‐': '-',
  '‑': '-',
  '–': '-',
  '—': '-',
  '−': '-',
}

const TRANSPARENT = /^[\p{M}\p{Cf}]$/u
const FORMAT = /^\p{Cf}$/u
// NOTE: What a run of format characters becomes in the folded text. A
// noncharacter, so it is neither a letter nor a space.
const MARK = '\uFFFF'
const SPACE = /^\s$/u
const WORD = /[\p{L}\p{N}]/u
// NOTE: Scripts written without spaces between words. Their letters are not
// "words" for the boundary rule (see `wordBefore`, `wordAt`).
const UNSPACED =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Thai}\p{Script_Extensions=Khmer}\p{Script_Extensions=Lao}\p{Script_Extensions=Myanmar}\p{Script_Extensions=Tibetan}\p{Script_Extensions=Bopomofo}]/u
const SPACED_WORD = (ch: string): boolean => WORD.test(ch) && !UNSPACED.test(ch)

const isAsciiWord = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x7a)

// NOTE: exported for the equivalence test of the ASCII path only.
export const foldForTest = (input: string, loose: boolean): Folded =>
  fold(input, loose)

const fold = (input: string, loose: boolean): Folded => {
  const text: Array<string> = []
  const starts: Array<number> = []
  const ends: Array<number> = []
  let lastFirst = -1
  let offset = 0
  const pushRun = (char: string, start: number, end: number) => {
    if (text.length > 0 && text[text.length - 1] === char) {
      ends[ends.length - 1] = end
    } else {
      lastFirst = text.length
      text.push(char)
      starts.push(start)
      ends.push(end)
    }
  }
  const pushSpace = (start: number, end: number) => pushRun(' ', start, end)
  for (const ch of input) {
    const start = offset
    const end = offset + ch.length
    offset = end
    // NOTE: ASCII, the bulk of most texts, without the Unicode tests below,
    // with the same result: no ASCII character is a format character or a
    // mark, the spaces are TAB to CR and SPACE, NFKD changes nothing, and the
    // only one in SPECIAL is the backtick.
    const code = ch.charCodeAt(0)
    if (code < 0x80) {
      if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) {
        pushSpace(start, end)
        continue
      }
      const unit =
        code >= 0x41 && code <= 0x5a
          ? String.fromCharCode(code + 0x20)
          : code === 0x60
            ? "'"
            : ch
      lastFirst = text.length
      if (loose && !isAsciiWord(unit.charCodeAt(0))) {
        pushSpace(start, end)
      } else {
        text.push(unit)
        starts.push(start)
        ends.push(end)
      }
      continue
    }
    if (FORMAT.test(ch) || ch === MARK) {
      pushRun(MARK, start, end)
      continue
    }
    if (TRANSPARENT.test(ch)) {
      for (let i = Math.max(lastFirst, 0); i < ends.length; i++) {
        ends[i] = end
      }
      continue
    }
    if (SPACE.test(ch)) {
      pushSpace(start, end)
      continue
    }
    const lower = ch.toLowerCase()
    const folded = (SPECIAL[lower] ?? lower)
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
    lastFirst = text.length
    for (const c of folded) {
      if (loose && !WORD.test(c)) {
        pushSpace(start, end)
        continue
      }
      for (const unit of c) {
        text.push(unit)
        starts.push(start)
        ends.push(end)
      }
    }
  }
  return { text: text.join(''), starts, ends }
}

const foldKey = (alias: string, loose: boolean): string =>
  fold(alias, loose)
    .text.split(MARK)
    .join('')
    .replace(/ +/g, ' ')
    .trim()

// NOTE: The key two labels are compared by: folded, case- and accent-blind.
export const foldedKey = (text: string): string => foldKey(text, false)

const wordBefore = (text: string, index: number): boolean => {
  if (index <= 0) {
    return false
  }
  const low = text.charCodeAt(index - 1)
  const start =
    low >= 0xdc00 && low <= 0xdfff && index >= 2 ? index - 2 : index - 1
  return SPACED_WORD(text.slice(start, index))
}

const wordAt = (text: string, index: number): boolean =>
  index < text.length &&
  SPACED_WORD(String.fromCodePoint(text.codePointAt(index) as number))

// ---- Matcher -----------------------------------------------------------------------------

export type Match = Readonly<{
  // Offsets in the original string.
  start: number
  end: number
  label: string
}>

type AliasEntry = Readonly<{ key: string; person: number; pattern: RegExp }>

// NOTE: The key as a pattern over the folded text: a marker may sit between
// any two letters, and a space of the key is a space, a marker, or both.
const patternOf = (key: string): RegExp => {
  const parts: Array<string> = []
  for (const [index, unit] of Array.from(key).entries()) {
    if (unit === ' ') {
      parts.push(`[ ${MARK}]+`)
    } else {
      const escaped = unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      parts.push(index === Array.from(key).length - 1 ? escaped : `${escaped}${MARK}*`)
    }
  }
  return new RegExp(parts.join(''), 'g')
}

const entriesFor = (
  people: ReadonlyArray<Person>,
  loose: boolean,
): ReadonlyArray<AliasEntry> => {
  const seen = new Set<string>()
  const out: Array<AliasEntry> = []
  people.forEach((person, index) => {
    for (const alias of [person.name, ...person.aliases]) {
      const key = foldKey(alias, loose)
      if (key !== '' && !seen.has(key)) {
        seen.add(key)
        out.push({ key, person: index, pattern: patternOf(key) })
      }
    }
  })
  return out
    .map((entry, order) => ({ entry, order }))
    .sort(
      (a, b) => b.entry.key.length - a.entry.key.length || a.order - b.order,
    )
    .map(({ entry }) => entry)
}

type Range = { start: number; end: number; person: number }

// NOTE: The matches in the folded text, in offsets of the original. A marker
// next to a match is a separator, so it ends a word on either side.
const rangesIn = (
  entries: ReadonlyArray<AliasEntry>,
  folded: Folded,
): ReadonlyArray<Range> => {
  const f = folded.text
  const covered = new Uint8Array(f.length)
  const accepted: Array<Range> = []
  for (const { key, person, pattern } of entries) {
    const startsOnWord = wordAt(key, 0)
    const endsOnWord = wordBefore(key, key.length)
    pattern.lastIndex = 0
    for (;;) {
      const found = pattern.exec(f)
      if (found === null) {
        break
      }
      const at = found.index
      let end = at + found[0].length
      pattern.lastIndex = at + 1
      if (startsOnWord && wordBefore(f, at)) {
        continue
      }
      if (endsOnWord && wordAt(f, end)) {
        continue
      }
      while (f[end] === MARK) {
        end++
      }
      let adds = false
      for (let i = at; i < end; i++) {
        if (covered[i] === 0) {
          adds = true
          covered[i] = 1
        }
      }
      if (adds) {
        accepted.push({
          start: folded.starts[at] as number,
          end: folded.ends[end - 1] as number,
          person,
        })
      }
    }
  }
  return accepted
}

const findMatches = (
  entries: ReadonlyArray<AliasEntry>,
  labels: ReadonlyArray<string>,
  input: string,
  loose: boolean,
): ReadonlyArray<Match> => {
  if (entries.length === 0 || input === '') {
    return []
  }
  const accepted = [...rangesIn(entries, fold(input, loose))]
  accepted.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: Array<Match> = []
  let i = 0
  while (i < accepted.length) {
    const first = accepted[i] as Range
    const start = first.start
    let end = first.end
    const people: Array<number> = [first.person]
    i++
    while (i < accepted.length && (accepted[i] as Range).start < end) {
      const next = accepted[i] as Range
      end = Math.max(end, next.end)
      if (!people.includes(next.person)) {
        people.push(next.person)
      }
      i++
    }
    out.push({
      start,
      end,
      label: people.map(index => labels[index] as string).join(' / '),
    })
  }
  return out
}

export type Matcher = Readonly<{
  hasAliases: boolean
  // The text with every match replaced by its label.
  text: (text: string) => string
  // Every range of `text` to replace, in order, with the label to put there.
  matches: (text: string) => ReadonlyArray<Match>
  // Like `matches` on the loose form, where every character that is not a
  // letter or a number is a separator. For link targets.
  looseMatches: (text: string) => ReadonlyArray<Match>
}>

export const makeMatcher = (people: ReadonlyArray<Person>): Matcher => {
  const strict = entriesFor(people, false)
  const loose = entriesFor(people, true)
  const labels = people.map(person => person.label)
  return {
    hasAliases: strict.length > 0,
    text: text => apply(text, findMatches(strict, labels, text, false)),
    matches: text => findMatches(strict, labels, text, false),
    looseMatches: text => findMatches(loose, labels, text, true),
  }
}

const apply = (text: string, matches: ReadonlyArray<Match>): string => {
  let out = ''
  let cursor = 0
  for (const match of matches) {
    out += text.slice(cursor, match.start) + match.label
    cursor = match.end
  }
  return out + text.slice(cursor)
}

// NOTE: The ranges of `text` that hold a name or alias of the people, in order.
export const findAliasMatches = (
  people: ReadonlyArray<Person>,
  text: string,
): ReadonlyArray<Match> => makeMatcher(people).matches(text)

// NOTE: True if the text holds a name or alias of the people.
export const containsAlias = (
  people: ReadonlyArray<Person>,
  text: string,
): boolean => findAliasMatches(people, text).length > 0

// NOTE: The quoted text of a selection, for a reader who has the redacted
// text. A selection is made on the original text, so one that starts or ends
// inside a name would show a fragment of it. The range is first widened to
// every name it touches (`matches` of the matcher) and to whole words, and
// only then are the names in it replaced by their labels, so the result is a
// part of the redacted text and never a cut piece of an alias (D14). `from`
// and `to` are offsets of `text`, as in `richtext-offsets.ts`.
export const redactedQuote = (
  people: ReadonlyArray<Person>,
  text: string,
  from: number,
  to: number,
): string => {
  const matcher = makeMatcher(people)
  const matches = matcher.matches(text)
  let low = Math.max(0, Math.min(from, to, text.length))
  let high = Math.min(text.length, Math.max(from, to, 0))
  const isWord = (index: number): boolean =>
    index >= 0 &&
    index < text.length &&
    /[\p{L}\p{N}\p{M}]/u.test(text.charAt(index))
  for (;;) {
    const before = `${low}:${high}`
    for (const match of matches) {
      if (match.start < high && match.end > low) {
        low = Math.min(low, match.start)
        high = Math.max(high, match.end)
      }
    }
    while (low > 0 && isWord(low - 1) && isWord(low)) low--
    while (high < text.length && isWord(high - 1) && isWord(high)) high++
    if (`${low}:${high}` === before) break
  }
  let out = ''
  let cursor = low
  for (const match of matches) {
    if (match.start >= low && match.end <= high) {
      out += text.slice(cursor, match.start) + match.label
      cursor = match.end
    }
  }
  return out + text.slice(cursor, high)
}

// ---- Limits --------------------------------------------------------------------------------

const fit = (text: string, max: number, trimmed: boolean): string => {
  if (text.length <= max) {
    return text
  }
  const cut = Array.from(text).reduce<string>(
    (acc, ch) => (acc.length + ch.length <= max ? acc + ch : acc),
    '',
  )
  return trimmed ? cut.trimEnd() : cut
}

const LIMIT = {
  longText: 50_000,
  title: 200,
  reason: 500,
  alt: 500,
  signatureName: 200,
  linkTitle: 300,
  textNode: 100_000,
} as const

// ---- Redactor ----------------------------------------------------------------------------

export type Redactor = Readonly<{
  // Any string: a file name, a reply, a case file title, PDF metadata.
  text: (text: string) => string
  content: (content: ReportContent) => ReportContent
  richText: (doc: RichTextDoc) => RichTextDoc
}>

type Context = { changed: boolean }

const redactMarks = (
  matcher: Matcher,
  context: Context,
  marks: ReadonlyArray<Mark> | undefined,
): ReadonlyArray<Mark> | undefined => {
  if (marks === undefined) {
    return undefined
  }
  const out: Array<Mark> = []
  let touched = false
  for (const mark of marks) {
    if (mark.type !== 'link') {
      out.push(mark)
      continue
    }
    const href = mark.attrs.href
    let decoded = href
    try {
      decoded = decodeURIComponent(href)
    } catch {
      // keep the raw form
    }
    if (
      matcher.matches(href).length > 0 ||
      matcher.matches(decoded).length > 0 ||
      matcher.looseMatches(decoded).length > 0 ||
      matcher.looseMatches(href).length > 0
    ) {
      context.changed = true
      touched = true
      continue
    }
    const title = mark.attrs.title
    if (title === undefined) {
      out.push(mark)
      continue
    }
    const redacted = fit(matcher.text(title), LIMIT.linkTitle, false)
    if (redacted !== title) {
      context.changed = true
      touched = true
      out.push({ ...mark, attrs: { ...mark.attrs, title: redacted } })
    } else {
      out.push(mark)
    }
  }
  return touched ? out : marks
}

const redactInline = (
  matcher: Matcher,
  context: Context,
  nodes: ReadonlyArray<InlineNode> | undefined,
): ReadonlyArray<InlineNode> | undefined => {
  if (nodes === undefined) {
    return undefined
  }
  const joined = nodes
    .map(node => (node.type === 'text' ? node.text : '\n'))
    .join('')
  const matches = matcher.matches(joined)
  if (matches.length > 0) {
    context.changed = true
  }
  const out: Array<InlineNode> = []
  let offset = 0
  for (const node of nodes) {
    const length = node.type === 'text' ? node.text.length : 1
    const nodeStart = offset
    const nodeEnd = offset + length
    offset = nodeEnd
    if (node.type === 'hardBreak') {
      if (
        !matches.some(
          match => nodeStart >= match.start && nodeStart < match.end,
        )
      ) {
        out.push(node)
      }
      continue
    }
    let text = ''
    let cursor = nodeStart
    for (const match of matches) {
      if (match.end <= nodeStart || match.start >= nodeEnd) {
        continue
      }
      if (match.start > cursor) {
        text += node.text.slice(cursor - nodeStart, match.start - nodeStart)
      }
      if (match.start >= nodeStart) {
        text += match.label
      }
      cursor = Math.min(match.end, nodeEnd)
    }
    text += node.text.slice(cursor - nodeStart)
    const marks = redactMarks(matcher, context, node.marks)
    out.push(
      text === node.text && marks === node.marks
        ? node
        : {
            type: 'text',
            text: fit(text, LIMIT.textNode, false),
            ...(marks === undefined || marks.length === 0 ? {} : { marks }),
          },
    )
  }
  return out
}

const withInline = <A extends { readonly type: string }>(
  node: A,
  content: ReadonlyArray<InlineNode> | undefined,
): A & { readonly content?: ReadonlyArray<InlineNode> } =>
  content === undefined ? node : { ...node, content }

const redactListBlock = (
  matcher: Matcher,
  context: Context,
  block: ListBlock,
): ListBlock => {
  switch (block.type) {
    case 'paragraph':
      return withInline(
        { type: 'paragraph' as const },
        redactInline(matcher, context, block.content),
      )
    case 'heading':
      return withInline(
        { type: 'heading' as const, attrs: block.attrs },
        redactInline(matcher, context, block.content),
      )
    case 'bulletList':
      return {
        type: 'bulletList',
        content: block.content.map(item => redactItem(matcher, context, item)),
      }
    case 'orderedList':
      return {
        type: 'orderedList',
        ...(block.attrs === undefined ? {} : { attrs: block.attrs }),
        content: block.content.map(item => redactItem(matcher, context, item)),
      }
  }
}

const redactItem = (
  matcher: Matcher,
  context: Context,
  item: ListItemNode,
): ListItemNode => ({
  type: 'listItem',
  content: item.content.map(block => redactListBlock(matcher, context, block)),
})

const redactCell = (
  matcher: Matcher,
  context: Context,
  cell: TableCellNode | TableHeaderNode,
): TableCellNode | TableHeaderNode => ({
  ...cell,
  content: cell.content.map(block => redactListBlock(matcher, context, block)),
})

const WITHHELD_PLACEHOLDER: BlockNode = {
  type: 'paragraph',
  content: [
    { type: 'text', text: IMAGE_WITHHELD_TEXT, marks: [{ type: 'italic' }] },
  ],
}

const redactBlock = (
  matcher: Matcher,
  context: Context,
  block: BlockNode,
): BlockNode => {
  switch (block.type) {
    case 'table':
      return {
        type: 'table',
        content: block.content.map(row => ({
          type: 'tableRow' as const,
          content: row.content.map(cell => redactCell(matcher, context, cell)),
        })),
      }
    case 'figure': {
      if (!block.attrs.safeToShare) {
        context.changed = true
        return WITHHELD_PLACEHOLDER
      }
      const alt = fit(matcher.text(block.attrs.alt), LIMIT.alt, false)
      if (alt !== block.attrs.alt) {
        context.changed = true
      }
      return withInline(
        { type: 'figure' as const, attrs: { ...block.attrs, alt } },
        redactInline(matcher, context, block.content),
      )
    }
    default:
      return redactListBlock(matcher, context, block)
  }
}

// NOTE: Always a rebuilt document, in canonical form: nothing of the input
// object (no attribute, no field the schema does not know) is carried over.
const redactDoc = (matcher: Matcher, doc: RichTextDoc): RichTextDoc => {
  const context: Context = { changed: false }
  const content = doc.content.map(block => redactBlock(matcher, context, block))
  return canonicalRichText({ type: 'doc', content })
}

// ---- Content -------------------------------------------------------------------------------

const redactValue = (matcher: Matcher, value: ItemValue): ItemValue => {
  switch (value.type) {
    case 'text':
      return {
        ...value,
        text: fit(matcher.text(value.text), LIMIT.longText, false),
      }
    case 'signature':
      return {
        ...value,
        name: fit(matcher.text(value.name), LIMIT.signatureName, false),
      }
    case 'not_applicable':
      return {
        ...value,
        reason: fit(matcher.text(value.reason), LIMIT.reason, true),
      }
    case 'rich_text':
      return { ...value, doc: redactDoc(matcher, value.doc) }
    case 'repeated':
      return {
        ...value,
        entries: value.entries.map(entry => redactItemEntry(matcher, entry)),
      }
    case 'date':
    case 'select':
    case 'people':
      return value
  }
}

const redactValues = (matcher: Matcher, values: ItemValues): ItemValues =>
  Object.fromEntries(
    Object.entries(values).map(([id, value]) => [
      id,
      redactValue(matcher, value),
    ]),
  )

const redactTitle = (
  matcher: Matcher,
  title: string | undefined,
): { title?: string } =>
  title === undefined
    ? {}
    : { title: fit(matcher.text(title), LIMIT.title, true) }

const redactItemEntry = (matcher: Matcher, entry: ItemEntry): ItemEntry => ({
  id: entry.id,
  ...redactTitle(matcher, entry.title),
  values: redactValues(matcher, entry.values),
})

const redactSectionEntry = (
  matcher: Matcher,
  entry: SectionEntry,
): SectionEntry => ({
  id: entry.id,
  ...redactTitle(matcher, entry.title),
  values: redactValues(matcher, entry.values),
  sections: redactSections(matcher, entry.sections),
})

const redactSection = (
  matcher: Matcher,
  section: SectionContent,
): SectionContent => ({
  ...(section.notApplicable === undefined
    ? {}
    : {
        notApplicable: {
          reason: fit(
            matcher.text(section.notApplicable.reason),
            LIMIT.reason,
            true,
          ),
        },
      }),
  values: redactValues(matcher, section.values),
  sections: redactSections(matcher, section.sections),
  ...(section.entries === undefined
    ? {}
    : {
        entries: section.entries.map(entry =>
          redactSectionEntry(matcher, entry),
        ),
      }),
})

const redactSections = (
  matcher: Matcher,
  sections: SectionContents,
): SectionContents =>
  Object.fromEntries(
    Object.entries(sections).map(([id, section]) => [
      id,
      redactSection(matcher, section),
    ]),
  )

// NOTE: A redactor for one people list. Build it once and use it for every
// text of one revision.
export const redactorFor = (people: ReadonlyArray<Person>): Redactor => {
  const matcher = makeMatcher(people)
  return {
    text: matcher.text,
    richText: doc => redactDoc(matcher, doc),
    content: content => ({
      ...content,
      sections: redactSections(matcher, content.sections),
    }),
  }
}

// NOTE: One string with every alias replaced by the label of its person.
export const redactText = (
  people: ReadonlyArray<Person>,
  text: string,
): string => redactorFor(people).text(text)

// NOTE: A file name. Separators such as `_`, `-` and `.` split words, so
// `ana_garcia.pdf` holds the name "Ana Garcia". It matches on the loose form.
export const redactFileName = (
  people: ReadonlyArray<Person>,
  name: string,
): string => {
  const matcher = makeMatcher(people)
  return apply(name, matcher.looseMatches(name))
}

export const redactRichText = (
  people: ReadonlyArray<Person>,
  doc: RichTextDoc,
): RichTextDoc => redactorFor(people).richText(doc)

// NOTE: The content a redacted role may receive. A valid `ReportContent` of the
// same template. With no people it is the same content, except that images not
// marked safe are still withheld.
export const redactContent = (
  people: ReadonlyArray<Person>,
  content: ReportContent,
): ReportContent => redactorFor(people).content(content)

// NOTE: The redacted draft: redacted content, and the people list with each
// name replaced by its label and no aliases.
export const redactDraft = (draft: DraftData): DraftData => ({
  content: redactContent(draft.people, draft.content),
  people: draft.people.map(person => ({
    id: person.id,
    name: person.label,
    label: person.label,
    aliases: [],
  })),
})
