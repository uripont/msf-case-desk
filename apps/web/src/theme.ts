import {
  DEFAULT_THEME,
  type FontFamily,
  type PublicTheme,
} from '@case-desk/domain'

// NOTE: The look of the deployment (D24). `/api/config` gives the theme, and
// the app applies it as CSS custom properties on its root element. The class
// names in the views keep their `msf-` names (internal names stay), but the
// tokens behind them are the theme's: `msf-red` is the primary colour,
// `msf-black` and `msf-ink` the text colour, `msf-paper` the background. Errors
// keep their own fixed colour, so a theme can never make them look like
// decoration. The fonts are the bundled set (D16).

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
  '--color-msf-red': theme.colors.primary,
  '--color-msf-black': theme.colors.text,
  '--color-msf-ink': theme.colors.text,
  '--color-msf-paper': theme.colors.background,
  '--color-msf-accent': theme.colors.accent,
  '--font-sans': fontStackOf(theme.fonts.body),
  '--font-heading': fontStackOf(theme.fonts.heading),
})

export const defaultThemeStyle: Record<string, string> =
  themeStyle(DEFAULT_THEME)
