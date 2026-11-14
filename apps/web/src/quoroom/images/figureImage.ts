import { Option } from 'effect'

import { loadImage } from './read'
import { IMAGE_TAG, imageContextToken, parseImageContext } from './spec'

// NOTE: The element that shows one stored image, in the editor and in
// the read-only rich-text view. It fetches the image through the image route
// with the session cookie (never a public address), shows the picture in an
// `<img>` through an object URL, and revokes that URL and stops the request
// when it leaves the page. Foldkit sets `imageId`, `report`, `context` (the version it is read through) and `alt`; nothing
// is fetched until both IDs are set, and a change of either loads again.

class QuoroomImage extends HTMLElement {
  #imageId = ''
  #report = ''
  #context = ''
  #alt = ''
  #url: string | undefined
  #abort: AbortController | undefined
  #scheduled = false
  #loadedFor = ''

  get imageId(): string {
    return this.#imageId
  }

  set imageId(value: string) {
    this.#imageId = value
    this.#schedule()
  }

  get report(): string {
    return this.#report
  }

  set report(value: string) {
    this.#report = value
    this.#schedule()
  }

  get context(): string {
    return this.#context
  }

  set context(value: string) {
    this.#context = value
    this.#schedule()
  }

  get alt(): string {
    return this.#alt
  }

  set alt(value: string) {
    this.#alt = value
    this.querySelector('img')?.setAttribute('alt', value)
  }

  connectedCallback(): void {
    this.#schedule()
  }

  disconnectedCallback(): void {
    this.#release()
    this.#loadedFor = ''
  }

  #schedule(): void {
    if (this.#scheduled) {
      return
    }
    this.#scheduled = true
    queueMicrotask(() => {
      this.#scheduled = false
      this.#start()
    })
  }

  #release(): void {
    this.#abort?.abort()
    this.#abort = undefined
    if (this.#url !== undefined) {
      URL.revokeObjectURL(this.#url)
      this.#url = undefined
    }
    this.replaceChildren()
  }

  #say(text: string, role: 'status' | 'alert'): void {
    const message = document.createElement('p')
    message.className = 'quoroom-image-message'
    message.setAttribute('role', role)
    message.textContent = text
    this.replaceChildren(message)
  }

  #start(): void {
    if (!this.isConnected || this.#imageId === '' || this.#report === '') {
      return
    }
    const context = parseImageContext(this.#context)
    const key = `${this.#report}/${this.#imageId}/${imageContextToken(context)}`
    if (key === this.#loadedFor) {
      return
    }
    this.#release()
    this.#loadedFor = key
    const abort = new AbortController()
    this.#abort = abort
    this.#say('Loading the image.', 'status')
    loadImage(
      { imageId: this.#imageId, reportId: this.#report, context },
      abort.signal,
    ).then(
      loaded => {
        if (abort.signal.aborted) {
          return
        }
        Option.match(loaded, {
          onNone: () => this.#say('The image could not be loaded.', 'alert'),
          onSome: image => {
            const url = URL.createObjectURL(image.blob)
            this.#url = url
            const picture = document.createElement('img')
            picture.className = 'quoroom-image-picture'
            picture.setAttribute('alt', this.#alt)
            picture.setAttribute('src', url)
            this.replaceChildren(picture)
          },
        })
      },
      () => {
        if (!abort.signal.aborted) {
          this.#say('The image could not be loaded.', 'alert')
        }
      },
    )
  }
}

if (customElements.get(IMAGE_TAG) === undefined) {
  customElements.define(IMAGE_TAG, QuoroomImage)
}

export { QuoroomImage }
