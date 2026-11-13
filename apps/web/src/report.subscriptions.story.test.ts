import { describe, expect, test } from 'vitest'

import { clickedLinkTo, clickedPage } from './fixtures'
import { subscriptions, update } from './main'
import { authorModel } from './quoroom.fixtures'

// NOTE: Stage 4 review: the timers of a screen run only while that screen is
// shown, and the farewell of an editor is heard on every route.

const dependenciesOf = (name: string, model: typeof authorModel) =>
  JSON.stringify(
    Object.entries(subscriptions)
      .filter(([key]) => key === name)
      .map(([, entry]) => entry.modelToDependencies(model)),
  )

describe('subscriptions follow the route', () => {
  const onReport = update(authorModel, clickedLinkTo('/r/report-1')).model
  const onReports = update(authorModel, clickedPage('Reports')).model

  test('the names are the ones the screens declare', () => {
    expect(Object.keys(subscriptions)).toEqual(
      expect.arrayContaining(['drafting', 'saveRetry', 'editorFarewell']),
    )
  })

  test('the drafting refresh and the save retry only run on a report', () => {
    ;['drafting', 'saveRetry'].forEach(name => {
      expect(dependenciesOf(name, onReport)).not.toBe(
        dependenciesOf(name, onReports),
      )
      expect(dependenciesOf(name, onReports)).toContain('"_tag":"None"')
    })
  })

  test('the farewell of an editor does not depend on the route', () => {
    expect(dependenciesOf('editorFarewell', onReport)).toBe(
      dependenciesOf('editorFarewell', onReports),
    )
  })
})
