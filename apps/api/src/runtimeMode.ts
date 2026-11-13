import { type RuntimeMode, readRuntimeMode } from '@case-desk/domain'

// NOTE: The one place a Worker turns its `RUNTIME_MODE` variable into a mode
// (D20). A value that is not `demo` or `pilot` is a configuration error: the
// Worker logs it and answers 500 to every API request, so a typo never serves
// the triage desk by accident. Unset is a pilot.
export type ModeOrRefusal =
  | Readonly<{ mode: RuntimeMode; refusal?: undefined }>
  | Readonly<{ mode?: undefined; refusal: Response }>

export const modeOf = (value: string | undefined): ModeOrRefusal => {
  const reading = readRuntimeMode(value)
  if (reading.ok) {
    return { mode: reading.mode }
  }
  // NOTE: the value is a deployment setting, not personal data; it is
  // shortened in case somebody put something long there.
  console.error(
    `RUNTIME_MODE must be "demo" or "pilot", got "${reading.value.slice(0, 40)}". The API is refusing every request until it is fixed.`,
  )
  return {
    refusal: Response.json(
      { error: 'MisconfiguredRuntimeMode' },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    ),
  }
}
