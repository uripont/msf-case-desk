import type {
  ItemValue,
  ItemValues,
  ReportContent,
  SectionContents,
} from './content'
import type { Person } from './people'
import { findAliasMatches } from './redaction'
import { richTextBlocks, richTextFigures } from './richtext'
import type { Template } from './template'

// NOTE: Name suggestions (D14, stage 1e): a heuristic that points the author at
// words that look like the name of a person and are not covered by the people
// list yet. It is shown only to authors and never decides anything. It is
// deterministic and does no I/O.
//
// A candidate is a run of capitalised words (Latin letters with accents, with
// inner apostrophes and hyphens, so "O'Brien" and "Jean-Pierre" are one word),
// joined by single spaces, and optionally by a lower-case particle between two
// capitalised words ("Maria de la Cruz", "van Dijk" is not one: it needs a
// capital on both sides). A word does not count if
//
// - it is in a small stopword list (articles, pronouns, titles, months, days,
//   in English, French, Spanish and Catalan);
// - it appears in the text of the template (headings, labels, instructions);
// - it is written in capitals only (acronyms);
// - it is a single word at the start of a sentence, which is capitalised
//   anyway. A run of two or more words is kept at the start of a sentence.
//
// A title before a name ("Dr.", "Mrs") does not end the sentence before it. A
// possessive is dropped ("Ana's" is "Ana"). A candidate that the people list
// already covers is left out. Candidates are counted without regard to case or
// accents and returned by count, then alphabetically.

export type NameSuggestion = Readonly<{ text: string; count: number }>

const STOPWORDS: ReadonlySet<string> = new Set(
  `the a an this that these those he she it they we i you his her its their our your my
  and but or if in on at to for from with of by as when while after before during since until
  yes no not so then later also however yesterday today tomorrow see now thus finally first second next last
  according regarding please thank thanks dear hello hi there here what who whom which why how all any some each every
  mr mrs ms miss dr prof sir madam mme mlle sr sra dra st
  le la les un une des du de et ou dans sur pour avec par il elle ils elles nous vous je tu ce cette ces
  el los las una unos unas y o en con por para su sus del al lo yo ella ellos ellas
  els i amb per als
  january february march april may june july august september october november december
  monday tuesday wednesday thursday friday saturday sunday
  janvier fevrier mars avril mai juin juillet aout septembre octobre novembre decembre
  lundi mardi mercredi jeudi vendredi samedi dimanche
  enero febrero marzo abril mayo junio julio agosto septiembre noviembre diciembre
  lunes martes miercoles jueves viernes sabado domingo
  gener febrer marc abril maig juny juliol setembre octubre novembre desembre`
    .split(/\s+/)
    .filter(word => word !== ''),
)

const TITLES: ReadonlySet<string> = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'mme',
  'mlle',
  'sr',
  'sra',
  'dra',
  'st',
])

const PARTICLES: ReadonlySet<string> = new Set([
  'de',
  'del',
  'della',
  'di',
  'da',
  'dos',
  'das',
  'la',
  'le',
  'van',
  'von',
  'der',
  'den',
  'bin',
  'al',
  'el',
  'y',
  'i',
])

const key = (word: string): string =>
  word
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’]s$/u, '')

const WORD_TOKEN = /[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu

const wordsOf = (text: string): ReadonlyArray<string> =>
  (text.match(WORD_TOKEN) ?? []).map(key)

const stringsOf = (value: unknown, out: Array<string>): void => {
  if (typeof value === 'string') {
    out.push(value)
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      stringsOf(entry, out)
    }
  } else if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      stringsOf(entry, out)
    }
  }
}

// ---- The texts of a content ------------------------------------------------------------------

const valueTexts = (value: ItemValue, out: Array<string>): void => {
  switch (value.type) {
    case 'text':
      out.push(value.text)
      return
    case 'signature':
      out.push(value.name)
      return
    case 'not_applicable':
      out.push(value.reason)
      return
    case 'rich_text':
      out.push(...richTextBlocks(value.doc))
      out.push(...richTextFigures(value.doc).map(figure => figure.alt))
      return
    case 'repeated':
      for (const entry of value.entries) {
        if (entry.title !== undefined) {
          out.push(entry.title)
        }
        valuesTexts(entry.values, out)
      }
      return
    case 'date':
    case 'select':
    case 'people':
      return
  }
}

const valuesTexts = (values: ItemValues, out: Array<string>): void => {
  for (const value of Object.values(values)) {
    valueTexts(value, out)
  }
}

const sectionsTexts = (sections: SectionContents, out: Array<string>): void => {
  for (const section of Object.values(sections)) {
    if (section.notApplicable !== undefined) {
      out.push(section.notApplicable.reason)
    }
    valuesTexts(section.values, out)
    sectionsTexts(section.sections, out)
    for (const entry of section.entries ?? []) {
      if (entry.title !== undefined) {
        out.push(entry.title)
      }
      valuesTexts(entry.values, out)
      sectionsTexts(entry.sections, out)
    }
  }
}

// NOTE: Every text an author wrote in the content, one entry per text block.
export const contentTexts = (content: ReportContent): ReadonlyArray<string> => {
  const out: Array<string> = []
  sectionsTexts(content.sections, out)
  return out
}

// ---- Candidates ------------------------------------------------------------------------------------

type Token = Readonly<{ text: string; start: number; end: number }>

const TOKEN = /[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*|\d+|\S/gu

const tokenize = (text: string): ReadonlyArray<Token> =>
  Array.from(text.matchAll(TOKEN), match => ({
    text: match[0],
    start: match.index as number,
    end: (match.index as number) + match[0].length,
  }))

const isWord = (token: string): boolean => /^[\p{L}\p{M}]/u.test(token)

const isCapitalised = (token: string): boolean => {
  const first = Array.from(token)[0] as string
  const letters = token.replace(/[^\p{L}]/gu, '')
  return (
    /^[\p{Lu}\p{Lt}]$/u.test(first) &&
    letters.length >= 2 &&
    letters !== letters.toUpperCase()
  )
}

const SENTENCE_END = new Set(['.', '!', '?', '…'])

type Found = { text: string; atStart: boolean; start: number; end: number }

const candidatesIn = (
  text: string,
  excluded: (word: string) => boolean,
): ReadonlyArray<Found> => {
  const tokens = tokenize(text)
  const found: Array<Found> = []
  const usable = (index: number): boolean => {
    const token = tokens[index]
    return (
      token !== undefined &&
      isWord(token.text) &&
      isCapitalised(token.text) &&
      !excluded(key(token.text))
    )
  }
  const gapIsSpace = (a: Token, b: Token): boolean => {
    const gap = text.slice(a.end, b.start)
    return gap !== '' && /^[^\S\n]+$/u.test(gap)
  }
  // The state is "the next word starts a sentence", per token.
  const starts: Array<boolean> = []
  let atStart = true
  let lastWord = ''
  tokens.forEach((token, index) => {
    const previous = tokens[index - 1]
    if (
      previous !== undefined &&
      text.slice(previous.end, token.start).includes('\n')
    ) {
      atStart = true
    }
    starts.push(atStart)
    if (isWord(token.text)) {
      atStart = false
      lastWord = key(token.text)
    } else if (SENTENCE_END.has(token.text)) {
      atStart = !(token.text === '.' && TITLES.has(lastWord))
    } else if (!/^["'“”‘’«»(\[¿¡—–-]$/u.test(token.text)) {
      atStart = false
    }
  })
  let i = 0
  while (i < tokens.length) {
    if (!usable(i)) {
      i++
      continue
    }
    let last = i
    let next = i + 1
    for (;;) {
      const current = tokens[last] as Token
      const following = tokens[next]
      if (following === undefined || !gapIsSpace(current, following)) {
        break
      }
      if (usable(next)) {
        last = next
        next++
        continue
      }
      // One or two lower-case particles, then a capitalised word.
      let target = next
      while (
        target < next + 2 &&
        tokens[target] !== undefined &&
        isWord((tokens[target] as Token).text) &&
        (tokens[target] as Token).text ===
          (tokens[target] as Token).text.toLowerCase() &&
        PARTICLES.has(key((tokens[target] as Token).text)) &&
        gapIsSpace(tokens[target - 1] as Token, tokens[target] as Token)
      ) {
        target++
      }
      if (
        target > next &&
        tokens[target] !== undefined &&
        gapIsSpace(tokens[target - 1] as Token, tokens[target] as Token) &&
        usable(target)
      ) {
        last = target
        next = target + 1
        continue
      }
      break
    }
    const first = tokens[i] as Token
    const end = tokens[last] as Token
    const startAt = starts[i] as boolean
    if (last > i || !startAt) {
      found.push({
        text: text.slice(first.start, end.end).replace(/['’]s$/u, ''),
        atStart: startAt,
        start: first.start,
        end: end.end,
      })
    }
    i = last + 1
  }
  return found
}

const fullyCovered = (people: ReadonlyArray<Person>, text: string): boolean => {
  const matches = findAliasMatches(people, text)
  if (matches.length === 0) {
    return false
  }
  let rest = ''
  let cursor = 0
  for (const match of matches) {
    rest += text.slice(cursor, match.start)
    cursor = match.end
  }
  rest += text.slice(cursor)
  return !/[\p{L}\p{N}]/u.test(rest)
}

export type SuggestInput = Readonly<{
  content: ReportContent
  people: ReadonlyArray<Person>
  // The words of the template are never suggested.
  template?: Template
}>

// NOTE: Candidates for names not yet in the people list, most frequent first.
export const suggestNames = (
  input: SuggestInput,
): ReadonlyArray<NameSuggestion> => {
  const templateWords = new Set<string>()
  if (input.template !== undefined) {
    const strings: Array<string> = []
    stringsOf(input.template, strings)
    for (const string of strings) {
      for (const word of wordsOf(string)) {
        templateWords.add(word)
      }
    }
  }
  const all = contentTexts(input.content)
  // A word also written in lower case somewhere is a common word.
  const common = new Set<string>()
  for (const text of all) {
    for (const word of text.match(WORD_TOKEN) ?? []) {
      if (word === word.toLowerCase()) {
        common.add(key(word))
      }
    }
  }
  const excluded = (word: string): boolean =>
    STOPWORDS.has(word) || templateWords.has(word) || common.has(word)
  const counts = new Map<string, { text: string; count: number }>()
  for (const text of all) {
    for (const candidate of candidatesIn(text, excluded)) {
      if (fullyCovered(input.people, candidate.text)) {
        continue
      }
      const id = wordsOf(candidate.text).join(' ')
      const entry = counts.get(id)
      if (entry === undefined) {
        counts.set(id, { text: candidate.text, count: 1 })
      } else {
        entry.count++
      }
    }
  }
  return Array.from(counts.entries())
    .sort(([a, x], [b, y]) => y.count - x.count || (a < b ? -1 : a > b ? 1 : 0))
    .map(([, entry]) => ({ text: entry.text, count: entry.count }))
}

// NOTE: The same for one piece of text (a comment reply being typed, a case
// title), without a content.
export const suggestNamesInText = (
  text: string,
  people: ReadonlyArray<Person>,
  template?: Template,
): ReadonlyArray<NameSuggestion> =>
  suggestNames({
    content: {
      schemaVersion: 1,
      templateId: template?.id ?? '',
      templateVersion: 1,
      sections: {
        text: {
          values: { text: { type: 'text', text } },
          sections: {},
        },
      },
    },
    people,
    ...(template === undefined ? {} : { template }),
  })
