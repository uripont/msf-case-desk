import { clsx } from 'clsx'

export const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-msf-ink'

export const labelClassName =
  'flex flex-col gap-2 text-base font-medium text-msf-ink'

export const fieldClassName = clsx(
  'h-12 w-full border border-msf-line bg-white px-3 text-lg font-normal text-msf-black transition-colors hover:border-msf-ink aria-[invalid=true]:border-msf-red',
  focusRing,
)

export const textAreaClassName = clsx(
  'min-h-32 w-full border border-msf-line bg-white px-3 py-2 text-lg font-normal leading-relaxed text-msf-black transition-colors hover:border-msf-ink aria-[invalid=true]:border-msf-red',
  focusRing,
)

export const primaryButtonClassName = clsx(
  'inline-flex h-12 cursor-pointer items-center justify-center bg-msf-red px-6 text-lg font-medium text-white transition-colors hover:bg-msf-black disabled:cursor-wait disabled:opacity-70',
  focusRing,
)

export const textButtonClassName = clsx(
  'cursor-pointer text-msf-ink underline decoration-msf-line decoration-1 underline-offset-[6px] transition-colors hover:decoration-msf-red',
  focusRing,
)

export const outlineButtonClassName = clsx(
  'inline-flex h-10 min-w-14 cursor-pointer items-center justify-center border border-msf-line px-3 tabular-nums text-msf-ink transition-colors hover:border-msf-red hover:text-msf-red active:bg-msf-mist',
  focusRing,
)
