import { clsx } from 'clsx'

export const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-ink'

export const labelClassName =
  'flex flex-col gap-2 text-base font-medium text-brand-ink'

export const fieldClassName = clsx(
  'h-12 w-full border border-brand-line bg-white px-3 text-lg font-normal text-brand-ink transition-colors hover:border-brand-ink aria-[invalid=true]:border-brand-alert',
  focusRing,
)

export const textAreaClassName = clsx(
  'min-h-32 w-full border border-brand-line bg-white px-3 py-2 text-lg font-normal leading-relaxed text-brand-ink transition-colors hover:border-brand-ink aria-[invalid=true]:border-brand-alert',
  focusRing,
)

export const primaryButtonClassName = clsx(
  'inline-flex h-12 cursor-pointer items-center justify-center bg-brand-primary px-6 text-lg font-medium text-white transition-colors hover:bg-brand-ink disabled:cursor-wait disabled:opacity-70',
  focusRing,
)

export const textButtonClassName = clsx(
  'cursor-pointer text-brand-ink underline decoration-brand-line decoration-1 underline-offset-[6px] transition-colors hover:decoration-brand-primary',
  focusRing,
)
