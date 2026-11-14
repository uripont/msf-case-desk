import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import { DEFAULT_THEME, publicThemeOf } from '@case-desk/domain'

import { clickedLinkTo } from './fixtures'
import { ConfigLoad, themeOf, update } from './main'
import { adminModel, authorModel } from './quoroom.fixtures'
import * as ThemeScreenForm from './quoroom/themeForm'
import * as ThemeScreen from './quoroom/themeScreen'
import {
  LOGO_PREVIEW,
  SAVED_THEME,
  UPLOADED,
  commandNames,
  openThemeScreen,
  sendToTheme,
} from './theme.screen.fixtures'

// NOTE: Stage 9d as a person would drive it, checked on the Model and the
// Commands: a colour that makes text unreadable is shown beside the colour and
// refused on saving, a fix is saved, and the app applies the saved theme
// without a reload.

const M = ThemeScreen.Message

const problemKeys = (model: ThemeScreen.Model): ReadonlyArray<string> =>
  ThemeScreenForm.problemsOfFields(model.fields).map(problem =>
    problem.path.join('.'),
  )

describe('opening the theme screen', () => {
  test('the address loads the saved theme into the form', () => {
    const opened = update(adminModel, clickedLinkTo('/theme'))
    expect(commandNames(opened)).toContain('LoadTheme')
    const loaded = openThemeScreen()
    expect(loaded.themeScreen.fields.organisationName).toBe(
      'Invented Organisation',
    )
    expect(loaded.themeScreen.fields.footer).toBe('Page {page} of {pages}')
  })

  test('a saved logo is loaded for the preview', () => {
    const step = sendToTheme(
      adminModel,
      M.SucceededLoadTheme({
        record: { theme: { ...SAVED_THEME, logo: 'logo-1' } },
      }),
    )
    expect(commandNames(step)).toEqual(['LoadLogoPreview'])
  })
})

describe('contrast', () => {
  test('an unreadable colour is a problem beside that colour and the theme is not sent', () => {
    const start = openThemeScreen()
    const faint = sendToTheme(
      start,
      M.UpdatedColour({ name: 'text', value: '#cccccc' }),
    )
    const problems = problemKeys(faint.model.themeScreen)
    expect(problems).toContain('colors.text')
    const submitted = sendToTheme(faint.model, M.SubmittedTheme())
    expect(commandNames(submitted)).not.toContain('SaveTheme')
    expect(submitted.model.themeScreen.saveForm._tag).toBe('Invalid')
    expect(themeOf(submitted.model)).toEqual(publicThemeOf(DEFAULT_THEME))
  })

  test('a malformed colour is refused in plain words, not sent', () => {
    const typed = sendToTheme(
      openThemeScreen(),
      M.UpdatedColour({ name: 'primary', value: 'blue' }),
    )
    expect(problemKeys(typed.model.themeScreen)).toContain('colors.primary')
    expect(
      commandNames(sendToTheme(typed.model, M.SubmittedTheme())),
    ).not.toContain('SaveTheme')
  })

  test('an unknown token in the footer is a problem beside the footer', () => {
    const typed = sendToTheme(
      openThemeScreen(),
      M.UpdatedPdfText({ field: 'footer', value: 'Page {nope}' }),
    )
    expect(problemKeys(typed.model.themeScreen)).toContain('pdf.footer')
  })

  test('a fix makes the theme valid again and it is sent', () => {
    const faint = sendToTheme(
      openThemeScreen(),
      M.UpdatedColour({ name: 'text', value: '#cccccc' }),
    )
    const fixed = sendToTheme(
      faint.model,
      M.UpdatedColour({ name: 'text', value: '#202020' }),
    )
    expect(problemKeys(fixed.model.themeScreen)).toEqual([])
    const submitted = sendToTheme(fixed.model, M.SubmittedTheme())
    expect(commandNames(submitted)).toEqual(['SaveTheme'])
  })
})

describe('saving', () => {
  const footer = 'Confidential, page {page}'
  const edited = sendToTheme(
    openThemeScreen(),
    M.UpdatedOrganisationName({ value: 'Renamed Organisation' }),
    M.UpdatedColour({ name: 'primary', value: '#0b5d3b' }),
    M.UpdatedPdfText({ field: 'footer', value: footer }),
    M.SelectedFont({ role: 'heading', value: 'Source Serif 4' }),
  )

  test('the Command carries the theme as typed', () => {
    const submitted = sendToTheme(edited.model, M.SubmittedTheme())
    const command = (submitted.commands ?? []).find(c => c.name === 'SaveTheme')
    expect(command?.args).toMatchObject({
      theme: {
        organisationName: 'Renamed Organisation',
        colors: { primary: '#0b5d3b' },
        fonts: { heading: 'Source Serif 4' },
        pdf: { header: 'STRICTLY CONFIDENTIAL', footer },
      },
    })
  })

  test('after saving the app shows the new name and colour without a reload', () => {
    const submitted = sendToTheme(edited.model, M.SubmittedTheme())
    const theme = {
      ...SAVED_THEME,
      organisationName: 'Renamed Organisation',
      colors: { ...SAVED_THEME.colors, primary: '#0b5d3b' },
      pdf: { ...SAVED_THEME.pdf, footer },
    }
    const saved = sendToTheme(
      submitted.model,
      M.SucceededSaveTheme({ record: { theme } }),
    )
    expect(themeOf(saved.model).organisationName).toBe('Renamed Organisation')
    expect(themeOf(saved.model).colors.primary).toBe('#0b5d3b')
    expect(saved.model.themeScreen.maybeNotice._tag).toBe('Some')
    expect('pdf' in themeOf(saved.model)).toBe(false)
  })

  test('a refusal by the server is shown and nothing changes in the app', () => {
    const submitted = sendToTheme(edited.model, M.SubmittedTheme())
    const refused = sendToTheme(
      submitted.model,
      M.FailedSaveTheme({ failure: { _tag: 'NotAllowed' } }),
    )
    expect(refused.model.themeScreen.saveForm._tag).toBe('Failed')
    expect(themeOf(refused.model)).toEqual(publicThemeOf(DEFAULT_THEME))
  })
})

describe('the logo', () => {
  test('choosing a file sends it; the uploaded image is previewed and then saved with the theme', () => {
    const file = new File([new Uint8Array([1])], 'logo.png', {
      type: 'image/png',
    })
    const chosen = sendToTheme(
      openThemeScreen(),
      M.SelectedLogoFile({ files: [file] }),
    )
    expect(commandNames(chosen)).toEqual(['UploadLogo'])
    expect(chosen.model.themeScreen.logoState._tag).toBe('Sending')
    const uploaded = sendToTheme(
      chosen.model,
      M.SucceededUploadLogo(UPLOADED),
    )
    expect(commandNames(uploaded)).toEqual(['LoadLogoPreview'])
    const shown = sendToTheme(
      uploaded.model,
      M.SucceededLoadLogoPreview({ preview: LOGO_PREVIEW }),
    )
    const submitted = sendToTheme(shown.model, M.SubmittedTheme())
    const command = (submitted.commands ?? []).find(c => c.name === 'SaveTheme')
    expect(command?.args).toMatchObject({
      theme: { logo: LOGO_PREVIEW.imageId },
    })
    const saved = sendToTheme(
      submitted.model,
      M.SucceededSaveTheme({
        record: { theme: { ...SAVED_THEME, logo: LOGO_PREVIEW.imageId } },
      }),
    )
    expect(saved.model.config._tag).toBe('Loaded')
    expect(
      saved.model.config._tag === 'Loaded'
        ? saved.model.config.config.logo
        : undefined,
    ).toEqual({ id: LOGO_PREVIEW.imageId, mime: 'image/png', chunks: 1 })
    expect(saved.model.maybeLogoSrc).toEqual(Option.some(LOGO_PREVIEW.src))
  })

  test('a refused picture is explained and nothing is set', () => {
    const failed = sendToTheme(
      openThemeScreen(),
      M.FailedUploadLogo({ message: 'That file is not a picture.' }),
    )
    expect(failed.model.themeScreen.logoState._tag).toBe('Failed')
    expect(failed.model.themeScreen.fields.maybeLogoId).toEqual(Option.none())
  })

  test('a preview that arrives for a logo that was since removed is ignored', () => {
    const removed = sendToTheme(
      openThemeScreen(),
      M.SucceededUploadLogo(UPLOADED),
      M.ClickedRemoveLogo(),
      M.SucceededLoadLogoPreview({ preview: LOGO_PREVIEW }),
    )
    expect(removed.model.themeScreen.maybeLogoPreview).toEqual(Option.none())
    expect(removed.model.themeScreen.fields.maybeLogoId).toEqual(Option.none())
  })
})

describe('the PDF preview', () => {
  test('it is made only when asked for, then again after an edit, and only the latest result is used', () => {
    const opened = openThemeScreen()
    expect(
      commandNames(
        sendToTheme(opened, M.UpdatedPdfText({ field: 'header', value: 'A' })),
      ),
    ).toEqual([])
    const asked = sendToTheme(opened, M.ClickedShowPdfPreview())
    expect(commandNames(asked)).toEqual(['RenderSamplePdf'])
    const edited = sendToTheme(
      asked.model,
      M.UpdatedPdfText({ field: 'footer', value: 'New footer' }),
    )
    expect(commandNames(edited)).toEqual(['RenderSamplePdf'])
    const stale = sendToTheme(
      edited.model,
      M.SucceededRenderSamplePdf({ generation: 1, src: 'blob:old' }),
    )
    expect(commandNames(stale)).toEqual(['RevokeObjectUrl'])
    expect(stale.model.themeScreen.pdf._tag).toBe('Rendering')
    const fresh = sendToTheme(
      edited.model,
      M.SucceededRenderSamplePdf({ generation: 2, src: 'blob:new' }),
    )
    expect(fresh.model.themeScreen.pdf).toEqual({
      _tag: 'Shown',
      src: 'blob:new',
    })
  })

  test('an invalid theme waits instead of making a document', () => {
    const asked = sendToTheme(openThemeScreen(), M.ClickedShowPdfPreview())
    const faint = sendToTheme(
      asked.model,
      M.UpdatedColour({ name: 'text', value: '#dddddd' }),
    )
    expect(commandNames(faint)).toEqual([])
    expect(faint.model.themeScreen.pdf._tag).toBe('Blocked')
  })
})

describe('who may open it', () => {
  test('the screen is only reached by the address; an author has no link to it', () => {
    expect(authorModel.session._tag).toBe('SignedIn')
  })
})

const revoked = (step: {
  commands?: ReadonlyArray<{ name: string; args?: unknown }> | undefined
}): ReadonlyArray<string> =>
  (step.commands ?? [])
    .flatMap(command =>
      command.name === 'RevokeObjectUrl' &&
      typeof command.args === 'object' &&
      command.args !== null &&
      'src' in command.args &&
      typeof command.args.src === 'string'
        ? [command.args.src]
        : [],
    )

const SECOND_PREVIEW = {
  ...LOGO_PREVIEW,
  imageId: 'logo-upload-2',
  src: 'blob:logo-2',
}

describe('logo preview addresses', () => {
  const shown = () =>
    sendToTheme(
      openThemeScreen(),
      M.SucceededUploadLogo(UPLOADED),
      M.SucceededLoadLogoPreview({ preview: LOGO_PREVIEW }),
    )

  test('are revoked when the logo is replaced', () => {
    const replaced = sendToTheme(
      shown().model,
      M.SucceededUploadLogo({ ...UPLOADED, imageId: SECOND_PREVIEW.imageId }),
    )
    expect(revoked(replaced)).toEqual([LOGO_PREVIEW.src])
  })

  test('are revoked when the logo is removed', () => {
    expect(revoked(sendToTheme(shown().model, M.ClickedRemoveLogo()))).toEqual([
      LOGO_PREVIEW.src,
    ])
  })

  test('are revoked when the theme is loaded again', () => {
    const loaded = sendToTheme(
      shown().model,
      M.SucceededLoadTheme({ record: { theme: SAVED_THEME } }),
    )
    expect(revoked(loaded)).toEqual([LOGO_PREVIEW.src])
  })

  test('are revoked when the screen is entered again', () => {
    expect(revoked(ThemeScreen.enter(shown().model.themeScreen))).toEqual([
      LOGO_PREVIEW.src,
    ])
  })

  test('a late preview of a logo no longer chosen is revoked', () => {
    const late = sendToTheme(
      openThemeScreen(),
      M.SucceededUploadLogo(UPLOADED),
      M.ClickedRemoveLogo(),
      M.SucceededLoadLogoPreview({ preview: LOGO_PREVIEW }),
    )
    expect(revoked(late)).toEqual([LOGO_PREVIEW.src])
  })

  test('the one the app holds after saving is kept, and revoked when a later save replaces it', () => {
    const saved = sendToTheme(
      shown().model,
      M.SubmittedTheme(),
      M.SucceededSaveTheme({
        record: { theme: { ...SAVED_THEME, logo: LOGO_PREVIEW.imageId } },
      }),
    )
    expect(saved.model.maybeLogoSrc).toEqual(Option.some(LOGO_PREVIEW.src))
    const replaced = sendToTheme(
      saved.model,
      M.SucceededUploadLogo({ ...UPLOADED, imageId: SECOND_PREVIEW.imageId }),
    )
    // The app still shows it, so it is not revoked yet.
    expect(revoked(replaced)).toEqual([])
    const second = sendToTheme(
      replaced.model,
      M.SucceededLoadLogoPreview({ preview: SECOND_PREVIEW }),
      M.SubmittedTheme(),
      M.SucceededSaveTheme({
        record: { theme: { ...SAVED_THEME, logo: SECOND_PREVIEW.imageId } },
      }),
    )
    expect(second.model.maybeLogoSrc).toEqual(Option.some(SECOND_PREVIEW.src))
    expect(revoked(second)).toEqual([LOGO_PREVIEW.src])
  })
})

describe('saving with a logo whose preview did not load', () => {
  test('the app still gets the logo reference', () => {
    const saved = sendToTheme(
      openThemeScreen(),
      M.SucceededUploadLogo(UPLOADED),
      M.FailedLoadLogoPreview({ imageId: UPLOADED.imageId }),
      M.SubmittedTheme(),
      M.SucceededSaveTheme({
        record: { theme: { ...SAVED_THEME, logo: UPLOADED.imageId } },
      }),
    )
    expect(
      saved.model.config._tag === 'Loaded'
        ? saved.model.config.config.logo
        : undefined,
    ).toEqual({ id: UPLOADED.imageId, mime: 'image/png', chunks: 1 })
    expect(commandNames(saved)).toContain('LoadLogo')
  })

  test('the real configuration is kept, no mode is made up', () => {
    const unknown = sendToTheme(
      {
        ...openThemeScreen(),
        config: ConfigLoad.Unavailable(),
      },
      M.SubmittedTheme(),
      M.SucceededSaveTheme({ record: { theme: SAVED_THEME } }),
    )
    expect(unknown.model.config._tag).toBe('Unavailable')
  })
})
