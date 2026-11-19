import { MAX_COLWIDTH } from '@quoroom/domain'

// NOTE: Column widths by buttons. ProseMirror's resize handle
// needs a mouse or a pen, so on a phone the toolbar widens or narrows the
// column the caret is in by a fixed step. The step and the limits are pure so
// they are tested without a browser. The smallest width is the one the editor
// already gives a column (`cellMinWidth`, in `extensions.ts`).

export const COLUMN_MIN_WIDTH = 80
export const COLUMN_STEP = 40
export const COLUMN_MAX_WIDTH = MAX_COLWIDTH

export type ColumnDirection = 'widen' | 'narrow'

// NOTE: The new width in pixels. `current` is the width stored on the column
// (undefined, 0 or null when it has none, in which case the width it is drawn
// with, `measured`, is the starting point). The result is a whole number
// between the minimum and the maximum.
export const nextColumnWidth = (
  current: number | null | undefined,
  measured: number,
  direction: ColumnDirection,
): number => {
  const start =
    current !== undefined && current !== null && current > 0
      ? current
      : Math.round(measured)
  const moved =
    direction === 'widen' ? start + COLUMN_STEP : start - COLUMN_STEP
  return Math.min(
    COLUMN_MAX_WIDTH,
    Math.max(COLUMN_MIN_WIDTH, Math.round(moved)),
  )
}

// NOTE: The widths of the cells of a column that spans several columns, with
// one entry set. `widths` is the stored list (or none), `span` how many
// columns the cell covers, `at` which of them is changed. An entry that was
// never set (0 in ProseMirror) becomes the minimum, since the schema stores
// whole numbers of at least 1.
export const withColumnWidth = (
  widths: ReadonlyArray<number> | null | undefined,
  span: number,
  at: number,
  width: number,
): ReadonlyArray<number> =>
  Array.from({ length: span }, (_, index) =>
    index === at ? width : widths?.[index] || COLUMN_MIN_WIDTH,
  )
