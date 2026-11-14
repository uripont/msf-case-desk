import { Option, Result } from 'effect'

import { Editor } from '@tiptap/core'
import { TableMap, cellAround } from '@tiptap/pm/tables'

import { type PreparedImage, prepareImage } from '../images/encode'
import { newUploadId } from '../images/id'
import { fitsReport, refusalText } from '../images/plan'
import { uploadImage } from '../images/upload'
import {
  type ColumnDirection,
  nextColumnWidth,
  withColumnWidth,
} from './columns'
import { quoroomExtensions } from './extensions'
import {
  EMPTY_RICH_TEXT_JSON,
  normaliseEditorJson,
  selectionAnchor,
  serializeRichText,
} from './richText'
import {
  EDITOR_FINAL_EVENT,
  EDITOR_TAG,
  EDITOR_UPLOAD_CANCELLED_EVENT,
} from './spec'
import {
  BLOCK_STYLES,
  BUTTON_LABELS,
  BUTTON_SHORT_LABELS,
  type BlockStyle,
  type EditorFacts,
  TOOLBAR_GROUPS,
  type ToolbarButtonId,
  blockStyleOfValue,
  blockStyleValue,
  buttonState,
  normaliseLinkUrl,
} from './toolbar'

// NOTE: The rich-text editor as a custom element. It is plain DOM
// code that owns everything inside it: Tiptap, the toolbar and the link box.
// Foldkit sets the properties `content` (canonical JSON text), `version`,
// `disabled`, `label`, `report` (the report whose images are shown and
// uploaded) and `remaining` (bytes of image space left in the report, -1 when
// unknown), and listens to the events `change`, `selection` and `image`. It
// never reaches inside.
//
// Images are handled here, as plain DOM code: a picture chosen,
// pasted or dropped is prepared in the browser (`images/encode.ts`), uploaded
// in chunks (`images/upload.ts`) and then inserted as a `figure` node after
// the block the caret is in. Progress, refusals and a retry button are shown
// in a panel under the toolbar.
//
// The module registers the element when it is imported. The drafting screen
// loads it with a Command (`import('./element')`) and renders the tag only
// after that has completed; an element rendered earlier would have its
// properties set before it is upgraded.
//
// Echo guard: `knownVersion` is the newest version this element has seen. A
// local edit raises it and is announced in `change` with that number, so the
// echo of it coming back through the Model has a version that is not greater
// and is ignored, which keeps the caret where it is. To replace the text from
// outside, the Model raises the version, or, to replace the text whatever the
// element has taken meanwhile (a reload), raises `generation`: a new generation
// makes the element take the content at once, and report the text it had not
// sent yet in a `discarded` event, so it is kept and not lost.
//
// An element that is removed sends what it still holds. Foldkit has taken its
// listeners off by then, so the last `change` and the end of a picture that was
// being sent go out as events on the window, tagged with the `owner` property
// (the Model's description of whose text this is).

const DEBOUNCE_MS = 250
const MAX_WAIT_MS = 1000
const SELECTION_SETTLE_MS = 200

type ToolRun = (editor: Editor) => void

const insertTable: ToolRun = editor => {
  editor
    .chain()
    .focus()
    .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
    .run()
}

// NOTE: Widens or narrows the column the caret is in by one step, the same
// change a mouse drag on the column border makes: every cell of the column gets
// the new `colwidth` in one transaction. Touch cannot drag that border.
function resizeColumn(editor: Editor, direction: ColumnDirection): void {
  const { state, view } = editor
  const $cell = cellAround(state.selection.$from)
  if ($cell === null) {
    return
  }
  const table = $cell.node(-1)
  const tableStart = $cell.start(-1)
  const map = TableMap.get(table)
  const cellStart = $cell.pos - tableStart
  const column = map.colCount(cellStart)
  const anchor = table.nodeAt(cellStart)
  if (anchor === null) {
    return
  }
  const dom = view.nodeDOM($cell.pos)
  const measured = dom instanceof HTMLElement ? dom.offsetWidth : 0
  const width = nextColumnWidth(anchor.attrs.colwidth?.[0], measured, direction)
  const tr = state.tr
  Array.from({ length: map.height }, (_, row) => row).forEach(row => {
    const at = map.map[row * map.width + column]
    if (
      at === undefined ||
      (row > 0 && at === map.map[(row - 1) * map.width + column])
    ) {
      return
    }
    const cell = table.nodeAt(at)
    if (cell === null) {
      return
    }
    tr.setNodeMarkup(tableStart + at, null, {
      ...cell.attrs,
      colwidth: withColumnWidth(
        cell.attrs.colwidth,
        cell.attrs.colspan,
        cell.attrs.colspan === 1 ? 0 : column - map.colCount(at),
        width,
      ),
    })
  })
  view.dispatch(tr)
}

const TOOLS: Readonly<Record<ToolbarButtonId, ToolRun>> = {
  bold: editor => editor.chain().focus().toggleBold().run(),
  italic: editor => editor.chain().focus().toggleItalic().run(),
  underline: editor => editor.chain().focus().toggleUnderline().run(),
  bulletList: editor => editor.chain().focus().toggleBulletList().run(),
  orderedList: editor => editor.chain().focus().toggleOrderedList().run(),
  link: () => undefined,
  insertTable,
  insertImage: () => undefined,
  widenColumn: editor => resizeColumn(editor, 'widen'),
  narrowColumn: editor => resizeColumn(editor, 'narrow'),
  undo: editor => editor.chain().focus().undo().run(),
  redo: editor => editor.chain().focus().redo().run(),
  addRowBefore: editor => editor.chain().focus().addRowBefore().run(),
  addRowAfter: editor => editor.chain().focus().addRowAfter().run(),
  deleteRow: editor => editor.chain().focus().deleteRow().run(),
  addColumnBefore: editor => editor.chain().focus().addColumnBefore().run(),
  addColumnAfter: editor => editor.chain().focus().addColumnAfter().run(),
  deleteColumn: editor => editor.chain().focus().deleteColumn().run(),
  toggleHeaderRow: editor => editor.chain().focus().toggleHeaderRow().run(),
  deleteTable: editor => editor.chain().focus().deleteTable().run(),
}

const create = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  attributes: Readonly<Record<string, string>> = {},
): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag)
  element.className = className
  Object.entries(attributes).forEach(([name, value]) =>
    element.setAttribute(name, value),
  )
  return element
}

const blockStyleOf = (editor: Editor): BlockStyle => {
  const level = [1, 2, 3, 4].find(candidate =>
    editor.isActive('heading', { level: candidate }),
  )
  if (level === 1 || level === 2 || level === 3 || level === 4) {
    return level
  }
  return editor.isActive('paragraph') ? 'paragraph' : 'other'
}

const factsOf = (
  editor: Editor,
  isEditable: boolean,
  hasLinkBox: boolean,
  canInsertImage: boolean,
): EditorFacts => {
  const { empty } = editor.state.selection
  const inTable = editor.isActive('table')
  const inList = editor.isActive('bulletList') || editor.isActive('orderedList')
  return {
    isEditable,
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    underline: editor.isActive('underline'),
    link: editor.isActive('link') || hasLinkBox,
    bulletList: editor.isActive('bulletList'),
    orderedList: editor.isActive('orderedList'),
    blockStyle: blockStyleOf(editor),
    inTable,
    canInsertTable: !inTable && !inList && !editor.isActive('figure'),
    hasLinkTarget: !empty || editor.isActive('link'),
    canUndo: editor.can().undo(),
    canRedo: editor.can().redo(),
    canInsertImage,
  }
}

type UnsentImage = Readonly<{
  image: PreparedImage
  uploadId: string
  // NOTE: The chunk to resume from.
  next: number
}>

class QuoroomEditor extends HTMLElement {
  #editor: Editor | undefined
  #surface: HTMLDivElement | undefined
  #toolbar: HTMLDivElement | undefined
  #linkForm: HTMLFormElement | undefined
  #linkInput: HTMLInputElement | undefined
  #linkMessage: HTMLParagraphElement | undefined
  #status: HTMLParagraphElement | undefined
  #blockSelect: HTMLSelectElement | undefined
  #buttons = new Map<ToolbarButtonId, HTMLButtonElement>()
  #groups = new Map<string, HTMLDivElement>()
  #pendingContent = EMPTY_RICH_TEXT_JSON
  #pendingVersion = 0
  #applyScheduled = false
  #knownVersion = -1
  #pendingGeneration = 0
  #appliedGeneration = -1
  #owner = ''
  #upload: AbortController | undefined
  #lastContent = EMPTY_RICH_TEXT_JSON
  #disabled = false
  #label = ''
  #debounce: ReturnType<typeof setTimeout> | undefined
  #maxWait: ReturnType<typeof setTimeout> | undefined
  #hadSelection = false
  #selectionTimer: ReturnType<typeof setTimeout> | undefined
  #isLinkBoxOpen = false
  #report = ''
  #remaining = -1
  #isBusy = false
  #fileInput: HTMLInputElement | undefined
  #imageStatus: HTMLParagraphElement | undefined
  #imageAlert: HTMLParagraphElement | undefined
  #retryButton: HTMLButtonElement | undefined
  #unsent: UnsentImage | undefined

  get content(): string {
    return this.#pendingContent
  }

  set content(value: string) {
    this.#pendingContent = value
    this.#scheduleApply()
  }

  get version(): number {
    return this.#pendingVersion
  }

  set version(value: number) {
    this.#pendingVersion = value
    this.#scheduleApply()
  }

  get generation(): number {
    return this.#pendingGeneration
  }

  set generation(value: number) {
    this.#pendingGeneration = value
    this.#scheduleApply()
  }

  get owner(): string {
    return this.#owner
  }

  set owner(value: string) {
    this.#owner = value
  }

  get disabled(): boolean {
    return this.#disabled
  }

  set disabled(value: boolean) {
    this.#disabled = value
    this.#editor?.setEditable(!value)
    this.#refreshToolbar()
  }

  get label(): string {
    return this.#label
  }

  set label(value: string) {
    this.#label = value
    this.#surface
      ?.querySelector('.ProseMirror')
      ?.setAttribute('aria-label', value)
  }

  get report(): string {
    return this.#report
  }

  set report(value: string) {
    this.#report = value
    this.#refreshToolbar()
  }

  get remaining(): number {
    return this.#remaining
  }

  set remaining(value: number) {
    this.#remaining = value
  }

  connectedCallback(): void {
    if (this.#editor !== undefined) {
      return
    }
    this.classList.add('quoroom-editor')
    this.#build()
  }

  disconnectedCallback(): void {
    this.#flush(true)
    this.#upload?.abort()
    clearTimeout(this.#selectionTimer)
    this.#editor?.destroy()
    this.#editor = undefined
    this.#knownVersion = -1
    this.#appliedGeneration = -1
    this.#lastContent = EMPTY_RICH_TEXT_JSON
    this.replaceChildren()
    this.#buttons.clear()
    this.#groups.clear()
    this.#unsent = undefined
  }

  #scheduleApply(): void {
    if (this.#applyScheduled) {
      return
    }
    this.#applyScheduled = true
    queueMicrotask(() => {
      this.#applyScheduled = false
      this.#applyIncoming()
    })
  }

  #applyIncoming(): void {
    const editor = this.#editor
    const isReset = this.#pendingGeneration !== this.#appliedGeneration
    if (
      editor === undefined ||
      (!isReset && this.#pendingVersion <= this.#knownVersion)
    ) {
      return
    }
    if (isReset) {
      this.#reportDiscarded()
      this.#appliedGeneration = this.#pendingGeneration
    }
    this.#knownVersion = this.#pendingVersion
    const parsed = this.#parse()
    if (parsed === undefined) {
      this.#showStatus('The saved text could not be read.')
      return
    }
    editor.commands.setContent(parsed, { emitUpdate: false })
    this.#lastContent = this.#pendingContent
    this.#showStatus('')
    this.#refreshToolbar()
  }

  // NOTE: Keystrokes still waiting for their `change` when the text is
  // replaced from outside are sent as `discarded`, never as a change.
  #reportDiscarded(): void {
    const editor = this.#editor
    if (editor === undefined || this.#debounce === undefined) {
      return
    }
    clearTimeout(this.#debounce)
    this.#debounce = undefined
    if (this.#maxWait !== undefined) {
      clearTimeout(this.#maxWait)
      this.#maxWait = undefined
    }
    Result.match(normaliseEditorJson(editor.getJSON()), {
      onFailure: () => undefined,
      onSuccess: doc => {
        const content = serializeRichText(doc)
        if (content !== this.#lastContent) {
          this.dispatchEvent(
            new CustomEvent('discarded', {
              detail: { content, version: this.#knownVersion },
            }),
          )
        }
      },
    })
  }

  #parse(): ReturnType<typeof JSON.parse> | undefined {
    try {
      const parsed = JSON.parse(this.#pendingContent)
      return Result.isSuccess(normaliseEditorJson(parsed)) ? parsed : undefined
    } catch (_error) {
      return undefined
    }
  }

  #build(): void {
    const toolbar = create('div', 'quoroom-toolbar', {
      role: 'toolbar',
      'aria-label': 'Text formatting',
    })
    this.#toolbar = toolbar
    toolbar.append(this.#blockStyleControl())
    TOOLBAR_GROUPS.forEach(group => {
      const element = create('div', 'quoroom-toolbar-group', {
        role: 'group',
        'aria-label': group.label,
      })
      group.buttons.forEach(id => {
        const button = this.#button(id)
        this.#buttons.set(id, button)
        element.append(button)
      })
      this.#groups.set(group.id, element)
      toolbar.append(element)
    })
    const linkForm = this.#linkFormElement()
    const status = create('p', 'quoroom-editor-status', {
      role: 'status',
    })
    this.#status = status
    const surface = create('div', 'quoroom-surface')
    this.#surface = surface
    this.append(toolbar, linkForm, this.#imagePanel(), surface, status)

    const editor = new Editor({
      element: surface,
      extensions: quoroomExtensions(() => this.#report),
      content: JSON.parse(EMPTY_RICH_TEXT_JSON),
      editable: !this.#disabled,
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': this.#label,
          class: 'quoroom-prose',
        },
        handlePaste: (_view, event) =>
          this.#takeImage(event.clipboardData?.files, event),
        handleDrop: (_view, event) =>
          this.#takeImage(event.dataTransfer?.files, event),
      },
      onUpdate: () => this.#onLocalEdit(),
      onSelectionUpdate: () => this.#onSelection(),
      onTransaction: () => this.#refreshToolbar(),
      onBlur: () => this.#flush(),
    })
    this.#editor = editor
    this.#applyIncoming()
    this.#refreshToolbar()
  }

  #button(id: ToolbarButtonId): HTMLButtonElement {
    const button = create('button', 'quoroom-tool', {
      type: 'button',
      'data-tool': id,
      'aria-label': BUTTON_LABELS[id],
      title: BUTTON_LABELS[id],
    })
    button.textContent = BUTTON_SHORT_LABELS[id]
    button.addEventListener('mousedown', event => event.preventDefault())
    button.addEventListener('click', () => this.#runTool(id))
    return button
  }

  #blockStyleControl(): HTMLElement {
    const wrapper = create('div', 'quoroom-toolbar-group')
    const select = create('select', 'quoroom-block-style', {
      'aria-label': 'Text style',
    })
    BLOCK_STYLES.forEach(entry => {
      const option = create('option', '')
      option.value = entry.value
      option.textContent = entry.label
      select.append(option)
    })
    select.addEventListener('change', () => {
      const editor = this.#editor
      if (editor === undefined) {
        return
      }
      Option.match(blockStyleOfValue(select.value), {
        onNone: () => undefined,
        onSome: style => {
          if (style === 'paragraph') {
            editor.chain().focus().setParagraph().run()
          } else if (style !== 'other') {
            editor.chain().focus().setHeading({ level: style }).run()
          }
        },
      })
    })
    this.#blockSelect = select
    wrapper.append(select)
    return wrapper
  }

  #linkFormElement(): HTMLFormElement {
    const form = create('form', 'quoroom-link-form', {
      'aria-label': 'Link',
    })
    form.hidden = true
    const label = create('label', 'quoroom-link-label')
    label.textContent = 'Link address'
    const input = create('input', 'quoroom-link-input', {
      type: 'text',
      inputmode: 'url',
      autocomplete: 'off',
      placeholder: 'https://example.org',
    })
    label.append(input)
    const apply = create('button', 'quoroom-tool', { type: 'submit' })
    apply.textContent = 'Apply link'
    const remove = create('button', 'quoroom-tool', { type: 'button' })
    remove.textContent = 'Remove link'
    const cancel = create('button', 'quoroom-tool', { type: 'button' })
    cancel.textContent = 'Cancel'
    const message = create('p', 'quoroom-link-message', { role: 'alert' })
    form.append(label, apply, remove, cancel, message)
    form.addEventListener('submit', event => {
      event.preventDefault()
      this.#applyLink()
    })
    remove.addEventListener('click', () => {
      this.#closeLinkBox()
      this.#editor?.chain().focus().extendMarkRange('link').unsetLink().run()
    })
    cancel.addEventListener('click', () => {
      this.#closeLinkBox()
      this.#editor?.commands.focus()
    })
    form.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        this.#closeLinkBox()
        this.#editor?.commands.focus()
      }
    })
    this.#linkForm = form
    this.#linkInput = input
    this.#linkMessage = message
    return form
  }

  #openLinkBox(): void {
    const editor = this.#editor
    if (
      editor === undefined ||
      this.#linkForm === undefined ||
      this.#linkInput === undefined
    ) {
      return
    }
    const current: unknown = editor.getAttributes('link').href
    this.#linkInput.value = typeof current === 'string' ? current : ''
    this.#linkForm.hidden = false
    this.#isLinkBoxOpen = true
    this.#setLinkMessage('')
    this.#linkInput.focus()
    this.#refreshToolbar()
  }

  #closeLinkBox(): void {
    if (this.#linkForm !== undefined) {
      this.#linkForm.hidden = true
    }
    this.#isLinkBoxOpen = false
    this.#refreshToolbar()
  }

  #setLinkMessage(text: string): void {
    if (this.#linkMessage !== undefined) {
      this.#linkMessage.textContent = text
    }
  }

  #applyLink(): void {
    const editor = this.#editor
    const typed = this.#linkInput?.value ?? ''
    if (editor === undefined) {
      return
    }
    Option.match(normaliseLinkUrl(typed), {
      onNone: () =>
        this.#setLinkMessage(
          'Use an address that starts with https://, http://, mailto: or tel:.',
        ),
      onSome: href => {
        this.#closeLinkBox()
        editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
      },
    })
  }

  #runTool(id: ToolbarButtonId): void {
    const editor = this.#editor
    if (editor === undefined || this.#disabled) {
      return
    }
    if (id === 'insertImage') {
      this.#fileInput?.click()
      return
    }
    if (id === 'link') {
      if (this.#isLinkBoxOpen) {
        this.#closeLinkBox()
      } else {
        this.#openLinkBox()
      }
      return
    }
    TOOLS[id](editor)
  }

  #refreshToolbar(): void {
    const editor = this.#editor
    if (editor === undefined) {
      return
    }
    const facts = factsOf(
      editor,
      !this.#disabled,
      this.#isLinkBoxOpen,
      !this.#isBusy && this.#report !== '',
    )
    this.#buttons.forEach((button, id) => {
      const state = buttonState(id, facts)
      button.disabled = state.disabled
      button.setAttribute('aria-pressed', String(state.pressed))
    })
    TOOLBAR_GROUPS.forEach(group => {
      if (group.isTableGroup) {
        const element = this.#groups.get(group.id)
        if (element !== undefined) {
          element.hidden = !facts.inTable
        }
      }
    })
    if (this.#blockSelect !== undefined) {
      this.#blockSelect.value = blockStyleValue(facts.blockStyle)
      this.#blockSelect.disabled = this.#disabled
    }
  }

  // ---- Images -------------------------------------------------------------------

  #imagePanel(): HTMLElement {
    const panel = create('div', 'quoroom-image-panel')
    const input = create('input', '', {
      type: 'file',
      accept: 'image/*',
      'aria-label': 'Choose a picture',
      tabindex: '-1',
    })
    input.hidden = true
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      input.value = ''
      if (file !== undefined) {
        void this.#addImage(file)
      }
    })
    const status = create('p', 'quoroom-editor-status', { role: 'status' })
    const alert = create('p', 'quoroom-image-alert', { role: 'alert' })
    const retry = create('button', 'quoroom-tool', { type: 'button' })
    retry.textContent = 'Send the picture again'
    retry.hidden = true
    retry.addEventListener('click', () => void this.#sendUnsent())
    panel.append(input, status, alert, retry)
    this.#fileInput = input
    this.#imageStatus = status
    this.#imageAlert = alert
    this.#retryButton = retry
    return panel
  }

  #say(status: string, alert: string, canRetry: boolean): void {
    if (this.#imageStatus !== undefined) {
      this.#imageStatus.textContent = status
    }
    if (this.#imageAlert !== undefined) {
      this.#imageAlert.textContent = alert
    }
    if (this.#retryButton !== undefined) {
      this.#retryButton.hidden = !canRetry
    }
  }

  // NOTE: A picture pasted or dropped into the text. Anything that is not a
  // picture is left to the editor.
  #takeImage(files: FileList | null | undefined, event: Event): boolean {
    const picture = Array.from(files ?? []).find(file =>
      file.type.startsWith('image/'),
    )
    if (picture === undefined || this.#disabled) {
      return false
    }
    event.preventDefault()
    void this.#addImage(picture)
    return true
  }

  async #addImage(file: Blob): Promise<void> {
    if (this.#isBusy || this.#disabled || this.#report === '') {
      return
    }
    this.#setBusy(true)
    this.#say('Preparing the picture.', '', false)
    const signal = this.#startUpload()
    const prepared = await prepareImage(file)
    if (signal.aborted) {
      this.#cancelUpload()
      return
    }
    if (!prepared.ok) {
      this.#say('', refusalText(prepared.refusal), false)
      this.#setBusy(false)
      return
    }
    const remaining =
      this.#remaining < 0 ? Option.none() : Option.some(this.#remaining)
    if (!fitsReport(prepared.image.bytes.length, remaining)) {
      this.#say(
        '',
        refusalText({
          kind: 'report_full',
          remaining: this.#remaining,
          bytes: prepared.image.bytes.length,
        }),
        false,
      )
      this.#setBusy(false)
      return
    }
    const uploadId = await newUploadId()
    if (signal.aborted) {
      this.#cancelUpload()
      return
    }
    this.#unsent = { image: prepared.image, uploadId, next: 0 }
    await this.#sendUnsent(signal)
  }

  #startUpload(): AbortSignal {
    this.#upload?.abort()
    const controller = new AbortController()
    this.#upload = controller
    return controller.signal
  }

  // NOTE: The element went away while a picture was being prepared or sent.
  // The upload is stopped, nothing is inserted, and the Model says so.
  #cancelUpload(): void {
    this.#unsent = undefined
    if (this.#owner !== '') {
      window.dispatchEvent(
        new CustomEvent(EDITOR_UPLOAD_CANCELLED_EVENT, {
          detail: { owner: this.#owner },
        }),
      )
    }
  }

  async #sendUnsent(known?: AbortSignal): Promise<void> {
    const unsent = this.#unsent
    if (unsent === undefined) {
      return
    }
    const signal = known ?? this.#startUpload()
    this.#setBusy(true)
    const result = await uploadImage({
      signal,
      reportId: this.#report,
      uploadId: unsent.uploadId,
      image: unsent.image,
      startAt: unsent.next,
      onProgress: progress =>
        this.#say(
          `Sending the picture: ${progress.percent}% (part ${progress.chunk} of ${progress.chunks}).`,
          '',
          false,
        ),
    })
    if (signal.aborted) {
      this.#cancelUpload()
      return
    }
    if (result.ok) {
      this.#unsent = undefined
      this.#insertFigure(unsent.uploadId)
      this.#say('Picture added.', '', false)
      this.dispatchEvent(
        new CustomEvent('image', {
          detail: {
            imageId: unsent.uploadId,
            size: unsent.image.bytes.length,
          },
        }),
      )
    } else {
      Option.match(result.resumeAt, {
        onNone: () => {
          this.#unsent = undefined
          this.#say('', result.message, false)
        },
        onSome: at => {
          this.#unsent = { ...unsent, next: at }
          this.#say('', result.message, true)
        },
      })
    }
    this.#setBusy(false)
  }

  #setBusy(isBusy: boolean): void {
    this.#isBusy = isBusy
    this.#refreshToolbar()
  }

  // NOTE: The figure goes after the top-level block the caret is in, with an
  // empty paragraph after it if it is then the last thing in the text, so the
  // author can keep writing. The caret moves into the caption.
  #insertFigure(imageId: string): void {
    const editor = this.#editor
    if (editor === undefined) {
      return
    }
    const { $to, to } = editor.state.selection
    const at = $to.depth === 0 ? to : $to.after(1)
    const isLast = at >= editor.state.doc.content.size
    editor
      .chain()
      .focus()
      .insertContentAt(at, [
        { type: 'figure', attrs: { imageId, alt: '', safeToShare: false } },
        ...(isLast ? [{ type: 'paragraph' }] : []),
      ])
      .setTextSelection(at + 1)
      .run()
  }

  #showStatus(text: string): void {
    if (this.#status !== undefined) {
      this.#status.textContent = text
    }
  }

  #onLocalEdit(): void {
    this.#knownVersion += 1
    if (this.#debounce !== undefined) {
      clearTimeout(this.#debounce)
    }
    this.#debounce = setTimeout(() => this.#flush(), DEBOUNCE_MS)
    if (this.#maxWait === undefined) {
      this.#maxWait = setTimeout(() => this.#flush(), MAX_WAIT_MS)
    }
  }

  #flush(isFinal = false): void {
    if (this.#debounce !== undefined) {
      clearTimeout(this.#debounce)
      this.#debounce = undefined
    }
    if (this.#maxWait !== undefined) {
      clearTimeout(this.#maxWait)
      this.#maxWait = undefined
    }
    const editor = this.#editor
    if (editor === undefined) {
      return
    }
    Result.match(normaliseEditorJson(editor.getJSON()), {
      onFailure: reason => {
        this.#showStatus(
          'This text uses something Quoroom cannot store, so the last change was not saved.',
        )
        this.setAttribute('data-invalid', reason)
      },
      onSuccess: doc => {
        this.removeAttribute('data-invalid')
        this.#showStatus('')
        const content = serializeRichText(doc)
        if (content === this.#lastContent) {
          return
        }
        this.#lastContent = content
        this.dispatchEvent(
          new CustomEvent('change', {
            detail: { content, version: this.#knownVersion },
          }),
        )
        if (isFinal && this.#owner !== '') {
          window.dispatchEvent(
            new CustomEvent(EDITOR_FINAL_EVENT, {
              detail: {
                owner: this.#owner,
                content,
                version: this.#knownVersion,
              },
            }),
          )
        }
      },
    })
  }

  #onSelection(): void {
    if (this.#selectionTimer !== undefined) {
      clearTimeout(this.#selectionTimer)
    }
    this.#selectionTimer = setTimeout(() => {
      this.#selectionTimer = undefined
      this.#reportSelection()
    }, SELECTION_SETTLE_MS)
  }

  #reportSelection(): void {
    const editor = this.#editor
    if (editor === undefined) {
      return
    }
    const { from, to } = editor.state.selection
    const hasSelection = from !== to
    if (!hasSelection && !this.#hadSelection) {
      return
    }
    this.#hadSelection = hasSelection
    // NOTE: Reported as text offsets of the shared anchor scheme (domain
    // `richtext-offsets.ts`), not as ProseMirror positions.
    const anchor = hasSelection
      ? selectionAnchor(editor.getJSON(), from, to)
      : Option.none()
    this.dispatchEvent(
      new CustomEvent('selection', {
        detail: Option.getOrElse(anchor, () => ({ from: 0, to: 0, text: '' })),
      }),
    )
  }
}

if (customElements.get(EDITOR_TAG) === undefined) {
  customElements.define(EDITOR_TAG, QuoroomEditor)
}

export { QuoroomEditor }
