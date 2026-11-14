import { Array, Option, Record } from 'effect'

// NOTE: The pure part of the editor toolbar. The toolbar is drawn by
// the editor element, because what it shows (which mark is on at the caret,
// whether undo is possible, whether the caret is inside a table) changes with
// every ProseMirror transaction and would otherwise travel through Messages on
// every key press. What each button is, and when it is pressed or disabled, is
// decided here from plain facts, so it is tested without a browser.

export type ToolbarButtonId =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'bulletList'
  | 'orderedList'
  | 'link'
  | 'insertTable'
  | 'insertImage'
  | 'undo'
  | 'redo'
  | 'addRowBefore'
  | 'addRowAfter'
  | 'deleteRow'
  | 'addColumnBefore'
  | 'addColumnAfter'
  | 'deleteColumn'
  | 'widenColumn'
  | 'narrowColumn'
  | 'toggleHeaderRow'
  | 'deleteTable'

export type ToolbarGroup = Readonly<{
  id: string
  label: string
  isTableGroup: boolean
  buttons: ReadonlyArray<ToolbarButtonId>
}>

export const TOOLBAR_GROUPS: ReadonlyArray<ToolbarGroup> = [
  {
    id: 'text',
    label: 'Text',
    isTableGroup: false,
    buttons: ['bold', 'italic', 'underline'],
  },
  {
    id: 'lists',
    label: 'Lists',
    isTableGroup: false,
    buttons: ['bulletList', 'orderedList'],
  },
  {
    id: 'insert',
    label: 'Insert',
    isTableGroup: false,
    buttons: ['link', 'insertTable', 'insertImage'],
  },
  {
    id: 'history',
    label: 'History',
    isTableGroup: false,
    buttons: ['undo', 'redo'],
  },
  {
    id: 'table',
    label: 'Table',
    isTableGroup: true,
    buttons: [
      'addRowBefore',
      'addRowAfter',
      'deleteRow',
      'addColumnBefore',
      'addColumnAfter',
      'deleteColumn',
      'widenColumn',
      'narrowColumn',
      'toggleHeaderRow',
      'deleteTable',
    ],
  },
]

export const BUTTON_LABELS: Readonly<Record<ToolbarButtonId, string>> = {
  bold: 'Bold',
  italic: 'Italic',
  underline: 'Underline',
  bulletList: 'Bulleted list',
  orderedList: 'Numbered list',
  link: 'Link',
  insertTable: 'Insert table',
  insertImage: 'Insert image',
  undo: 'Undo',
  redo: 'Redo',
  addRowBefore: 'Add row above',
  addRowAfter: 'Add row below',
  deleteRow: 'Delete row',
  addColumnBefore: 'Add column before',
  addColumnAfter: 'Add column after',
  deleteColumn: 'Delete column',
  widenColumn: 'Make column wider',
  narrowColumn: 'Make column narrower',
  toggleHeaderRow: 'Header row on or off',
  deleteTable: 'Delete table',
}

export const BUTTON_SHORT_LABELS: Readonly<Record<ToolbarButtonId, string>> = {
  bold: 'B',
  italic: 'I',
  underline: 'U',
  bulletList: 'Bullets',
  orderedList: 'Numbers',
  link: 'Link',
  insertTable: 'Table',
  insertImage: 'Image',
  undo: 'Undo',
  redo: 'Redo',
  addRowBefore: 'Row above',
  addRowAfter: 'Row below',
  deleteRow: 'Delete row',
  addColumnBefore: 'Column before',
  addColumnAfter: 'Column after',
  deleteColumn: 'Delete column',
  widenColumn: 'Wider',
  narrowColumn: 'Narrower',
  toggleHeaderRow: 'Header row',
  deleteTable: 'Delete table',
}

export type BlockStyle = 'paragraph' | 'other' | 1 | 2 | 3 | 4

export const BLOCK_STYLES: ReadonlyArray<
  Readonly<{ value: string; label: string; style: BlockStyle }>
> = [
  { value: 'paragraph', label: 'Paragraph', style: 'paragraph' },
  { value: '1', label: 'Heading 1', style: 1 },
  { value: '2', label: 'Heading 2', style: 2 },
  { value: '3', label: 'Heading 3', style: 3 },
  { value: '4', label: 'Heading 4', style: 4 },
]

export type EditorFacts = Readonly<{
  isEditable: boolean
  bold: boolean
  italic: boolean
  underline: boolean
  link: boolean
  bulletList: boolean
  orderedList: boolean
  blockStyle: BlockStyle
  inTable: boolean
  canInsertTable: boolean
  hasLinkTarget: boolean
  canUndo: boolean
  canRedo: boolean
  canInsertImage: boolean
}>

export type ButtonState = Readonly<{ pressed: boolean; disabled: boolean }>

const pressedWhen =
  (pick: (facts: EditorFacts) => boolean) =>
  (facts: EditorFacts): ButtonState => ({
    pressed: pick(facts),
    disabled: false,
  })

const disabledWhen =
  (pick: (facts: EditorFacts) => boolean) =>
  (facts: EditorFacts): ButtonState => ({
    pressed: false,
    disabled: pick(facts),
  })

const tableOnly = disabledWhen(facts => !facts.inTable)

const RULES: Readonly<
  Record<ToolbarButtonId, (facts: EditorFacts) => ButtonState>
> = {
  bold: pressedWhen(facts => facts.bold),
  italic: pressedWhen(facts => facts.italic),
  underline: pressedWhen(facts => facts.underline),
  bulletList: pressedWhen(facts => facts.bulletList),
  orderedList: pressedWhen(facts => facts.orderedList),
  link: facts => ({ pressed: facts.link, disabled: !facts.hasLinkTarget }),
  insertTable: disabledWhen(facts => !facts.canInsertTable),
  insertImage: disabledWhen(facts => !facts.canInsertImage),
  undo: disabledWhen(facts => !facts.canUndo),
  redo: disabledWhen(facts => !facts.canRedo),
  addRowBefore: tableOnly,
  addRowAfter: tableOnly,
  deleteRow: tableOnly,
  addColumnBefore: tableOnly,
  addColumnAfter: tableOnly,
  deleteColumn: tableOnly,
  widenColumn: tableOnly,
  narrowColumn: tableOnly,
  toggleHeaderRow: tableOnly,
  deleteTable: tableOnly,
}

// NOTE: A read-only editor has every button disabled and nothing pressed.
export const buttonState = (
  id: ToolbarButtonId,
  facts: EditorFacts,
): ButtonState =>
  facts.isEditable ? RULES[id](facts) : { pressed: false, disabled: true }

export const toolbarState = (
  facts: EditorFacts,
): Readonly<Record<ToolbarButtonId, ButtonState>> =>
  Record.map(RULES, (_, id) => buttonState(id, facts))

export const visibleGroups = (
  facts: EditorFacts,
): ReadonlyArray<ToolbarGroup> =>
  Array.filter(TOOLBAR_GROUPS, group => !group.isTableGroup || facts.inTable)

export const blockStyleValue = (style: BlockStyle): string =>
  style === 'other' ? 'paragraph' : String(style)

export const blockStyleOfValue = (value: string): Option.Option<BlockStyle> =>
  Option.map(
    Array.findFirst(BLOCK_STYLES, entry => entry.value === value),
    entry => entry.style,
  )

// ---- Links ----------------------------------------------------------------

export const MAX_LINK_LENGTH = 2000

const ALLOWED_LINK = /^(https?:\/\/|mailto:|tel:)\S+$/i
const EMAIL = /^[^\s@:/]+@[^\s@:/]+\.[^\s@:/]+$/
const DOMAIN = /^[^\s@:/.]+(\.[^\s@:/.]+)+([/?#]\S*)?$/

export const isAllowedLinkUrl = (url: string): boolean =>
  url.length <= MAX_LINK_LENGTH && ALLOWED_LINK.test(url)

// NOTE: What the author typed into the link box, made into an address the
// schema accepts. Only http, https, mailto and tel are ever stored (D3). A
// bare address with an at sign becomes mailto, a bare domain becomes https,
// anything else (javascript:, data:, text with spaces) is refused.
export const normaliseLinkUrl = (input: string): Option.Option<string> => {
  const typed = input.trim()
  const candidate = ALLOWED_LINK.test(typed)
    ? typed
    : EMAIL.test(typed)
      ? `mailto:${typed}`
      : DOMAIN.test(typed)
        ? `https://${typed}`
        : ''
  return isAllowedLinkUrl(candidate) ? Option.some(candidate) : Option.none()
}
