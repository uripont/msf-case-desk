import {
  DEFAULT_THEME,
  type FontFamily,
  type PublicTheme,
} from '@quoroom/domain'

// NOTE: The look of the deployment (D24). `/api/config` gives the theme, and
// the app applies it as CSS custom properties on its root element. The `brand-`
// colours in the views are the theme's: `brand-primary` is the primary colour,
// `brand-ink` the text colour, `brand-paper` the background, `brand-accent` the
// accent. Errors keep their own fixed colour, so a theme can never make them
// look like decoration. The fonts are the bundled set (D16).

// STYLE

const FONT_STACKS: Readonly<Record<FontFamily, string>> = {
  'Hanken Grotesk':
    "'Hanken Grotesk Variable', 'Helvetica Neue', Arial, sans-serif",
  Inter: "'Inter', 'Helvetica Neue', Arial, sans-serif",
  'Source Serif 4': "'Source Serif 4', Georgia, 'Times New Roman', serif",
  'Noto Sans': "'Noto Sans', 'Helvetica Neue', Arial, sans-serif",
}

export const fontStackOf = (font: FontFamily): string => FONT_STACKS[font]

export const themeStyle = (theme: PublicTheme): Record<string, string> => ({
  '--color-brand-primary': theme.colors.primary,
  '--color-brand-ink': theme.colors.text,
  '--color-brand-paper': theme.colors.background,
  '--color-brand-accent': theme.colors.accent,
  '--font-sans': fontStackOf(theme.fonts.body),
  '--font-heading': fontStackOf(theme.fonts.heading),
})

export const defaultThemeStyle: Record<string, string> =
  themeStyle(DEFAULT_THEME)
