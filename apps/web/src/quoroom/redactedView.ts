import { clsx } from 'clsx'
import { Array, Schema } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import {
  type Person,
  type SectionContent,
  type Template,
  highlightedTexts,
  redactedSectionOf,
  redactorFor,
} from '@case-desk/domain'

import { focusRing } from '../style'
import { readOnlySection } from './contentView'
import { topLevelSections } from './draftText'
import { markedChildren } from './marked'

// NOTE: The original and the redacted view of a working copy (stage 5, D14),
// computed here in the browser with the same domain functions the server uses
// when a section is shared (`redactedSectionOf`, `redactorFor`), so what the
// author reads is the text that will be stored for the redacted roles. Every
// replacement is highlighted and a withheld image is the placeholder. The
// views show the working copy as it is now; nothing leaves the browser.

export const PreviewView = Schema.Literals(['original', 'redacted'])
export type PreviewView = typeof PreviewView.Type

export type PreviewInput = Readonly<{
  template: Template
  people: ReadonlyArray<Person>
  contents: Readonly<Record<string, SectionContent>>
  reportId: string
  // NOTE: The case file title, shown with the same redaction.
  caseTitle: string
}>

const EMPTY_SECTION: SectionContent = { values: {}, sections: {} }

// NOTE: A people item in a redacted text shows the label, never the name.
export const labelledPeople = (
  people: ReadonlyArray<Person>,
): ReadonlyArray<Person> =>
  Array.map(people, person => ({
    ...person,
    name: person.label,
    aliases: [],
  }))

// NOTE: What a redacted role reads of one top-level section.
export const redactedContents = (
  input: PreviewInput,
): Readonly<Record<string, SectionContent>> =>
  Object.fromEntries(
    Array.map(topLevelSections(input.template), section => [
      section.id,
      redactedSectionOf(
        input.template,
        input.people,
        section.id,
        input.contents[section.id] ?? EMPTY_SECTION,
      ),
    ]),
  )

export const redactedCaseTitle = (
  people: ReadonlyArray<Person>,
  title: string,
): string => redactorFor(people).text(title)

// NOTE: The two buttons that choose the view. The pressed one is marked for
// assistive technology and by its look, not by colour alone.
export const viewToggle = <M>(
  h: HtmlBuilder<M>,
  view: PreviewView,
  onChoose: (view: PreviewView) => M,
): Html => {
  const button = (target: PreviewView, label: string): Html =>
    h.button(
      [
        h.Type('button'),
        h.AriaPressed(view === target ? 'true' : 'false'),
        h.DataAttribute('view', target),
        h.Class(
          clsx(
            'inline-flex h-10 cursor-pointer items-center justify-center border px-4 text-base transition-colors',
            view === target
              ? 'border-msf-black bg-msf-black font-medium text-white'
              : 'border-msf-line text-msf-ink hover:border-msf-red hover:text-msf-red',
            focusRing,
          ),
        ),
        h.OnClick(onChoose(target)),
      ],
      [label],
    )
  return h.div(
    [
      h.Role('group'),
      h.AriaLabel('Which version of the text to show'),
      h.Class('flex flex-wrap gap-2'),
    ],
    [button('original', 'Original'), button('redacted', 'Redacted')],
  )
}

export const viewNote = (view: PreviewView): string =>
  view === 'redacted'
    ? 'This is what the reviewers of a redacted role will read. Every replaced name is highlighted. Pictures not marked safe to share are left out.'
    : 'This is the original text, as the authors read it. Redacted roles never receive it.'

// NOTE: One top-level section in the chosen view, with its title as a heading
// of its own.
export const previewSection = <M>(
  h: HtmlBuilder<M>,
  input: PreviewInput,
  view: PreviewView,
  sectionId: string,
): Html => {
  const sections = topLevelSections(input.template)
  const section = sections.find(candidate => candidate.id === sectionId)
  if (section === undefined) {
    return h.empty
  }
  const redacted = view === 'redacted'
  const content = redacted
    ? redactedSectionOf(
        input.template,
        input.people,
        sectionId,
        input.contents[sectionId] ?? EMPTY_SECTION,
      )
    : (input.contents[sectionId] ?? EMPTY_SECTION)
  return readOnlySection(h, section, content, {
    reportId: input.reportId,
    people: redacted ? labelledPeople(input.people) : input.people,
    topSectionId: sectionId,
    ...(redacted ? { marks: highlightedTexts(input.people) } : {}),
  })
}

// NOTE: Every section, one after the other, for the share screen.
export const previewAll = <M>(
  h: HtmlBuilder<M>,
  input: PreviewInput,
  view: PreviewView,
): Html =>
  h.div(
    [h.DataAttribute('preview', view), h.Class('flex min-w-0 flex-col gap-8')],
    [
      h.p(
        [h.Class('text-lg font-medium text-msf-ink')],
        [
          'Case file: ',
          ...markedChildren(
            h,
            view === 'redacted'
              ? redactedCaseTitle(input.people, input.caseTitle)
              : input.caseTitle,
            view === 'redacted' ? highlightedTexts(input.people) : [],
          ),
        ],
      ),
      ...Array.map(topLevelSections(input.template), section =>
        h.keyed('section')(
          section.id,
          [
            h.AriaLabel(section.title),
            h.Class(
              'flex min-w-0 flex-col gap-4 border-t border-msf-line pt-4',
            ),
          ],
          [
            h.h3([h.Class('text-2xl font-black')], [section.title]),
            previewSection(h, input, view, section.id),
          ],
        ),
      ),
    ],
  )
