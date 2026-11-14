import { DEFAULT_THEME, type Theme } from '@case-desk/domain'

import { clickedLinkTo } from './fixtures'
import { Message, update } from './main'
import { adminModel } from './quoroom.fixtures'
import * as ThemeScreen from './quoroom/themeScreen'

// NOTE: Stage 9d, with invented data: an administrator opens the theme screen.

export const SAVED_THEME: Theme = {
  ...DEFAULT_THEME,
  organisationName: 'Invented Organisation',
  pdf: { header: 'STRICTLY CONFIDENTIAL', footer: 'Page {page} of {pages}' },
}

export const themeMessage = (message: ThemeScreen.Message) =>
  Message.GotThemeScreenMessage({ message })

export const openThemeScreen = (from = adminModel) =>
  [
    clickedLinkTo('/theme'),
    themeMessage(ThemeScreen.loadedTheme({ theme: SAVED_THEME })),
  ].reduce((model, message) => update(model, message).model, from)

type Step = ReturnType<typeof update>

export const sendToTheme = (
  start: ReturnType<typeof openThemeScreen>,
  ...messages: ReadonlyArray<ThemeScreen.Message>
): Step =>
  messages.reduce<Step>((step, next) => update(step.model, themeMessage(next)), {
    model: start,
  })

export const commandNames = (step: ReturnType<typeof update>) =>
  (step.commands ?? []).map(command => command.name)

export const LOGO_PREVIEW: ThemeScreen.LogoPreview = {
  imageId: 'logo-upload-1',
  src: 'blob:logo-1',
  mime: 'image/png',
  chunks: 1,
}

export const UPLOADED = {
  imageId: LOGO_PREVIEW.imageId,
  mime: LOGO_PREVIEW.mime,
  chunks: LOGO_PREVIEW.chunks,
}
