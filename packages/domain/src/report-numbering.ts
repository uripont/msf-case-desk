// NOTE: Names of the versions of a report (D10). Draft 0 is the empty
// template and exists from the start; shared drafts are Draft 1, 2 and so on;
// every publication to a committee is Revision 1, 2 and so on, a closing
// revision included. Working copies have no number. The numbers come from
// the stored ones, never from a clock or a counter kept here.

export type VersionRef = Readonly<{
  kind: 'draft' | 'revision'
  number: number
}>

export const draftLabel = (number: number): string => `Draft ${number}`

export const revisionLabel = (number: number): string => `Revision ${number}`

// NOTE: A closing revision is numbered like any other and marked as closing.
export const revisionTitle = (number: number, closing: boolean): string =>
  closing ? `${revisionLabel(number)} (closing)` : revisionLabel(number)

export const versionLabel = (ref: VersionRef): string =>
  ref.kind === 'draft' ? draftLabel(ref.number) : revisionLabel(ref.number)

// NOTE: The part of a PDF file name that names the version (D10), for example
// `Revision-2` or `Draft-5`.
export const versionSlug = (ref: VersionRef): string =>
  versionLabel(ref).replace(' ', '-')

// NOTE: The next number after the numbers already used. Draft 0 always
// exists, so the first shared draft is Draft 1 even with no stored draft.
export const nextDraftNumber = (existing: ReadonlyArray<number>): number =>
  Math.max(0, ...existing) + 1

export const nextRevisionNumber = (existing: ReadonlyArray<number>): number =>
  Math.max(0, ...existing) + 1
