import { Option } from 'effect'
import { modifyFields } from 'foldkit/struct'
import { describe, expect, test } from 'vitest'

import type { Comparison } from '@case-desk/domain'

import { Failure } from './failure'
import * as Share from './share'

const COPY: Share.CopyOutline = {
  saveCounter: 4,
  baseDraft: 0,
  latestDraft: 0,
  behind: false,
  hasUnsharedChanges: true,
  sectionIds: ['case-details', 'allegations'],
}

const ready = modifyFields(Share.initialModel, {
  reportId: () => 'report-1',
  maybeCopy: () => Option.some(COPY),
})

const SCOPE = { reportId: 'report-1', generation: 0 }

const names = (step: { commands?: ReadonlyArray<{ name: string }> }) =>
  (step.commands ?? []).map(command => command.name)

const COMPARISON: Comparison = {
  baseDraft: 0,
  theirsDraft: 1,
  conflicts: [
    { key: 'image:a', kind: 'image_flag', ours: true, theirs: false },
  ],
  automatic: [],
  problems: [],
}

describe('sharing a draft', () => {
  test('sections are sent one by one, then the share is finished', () => {
    const asked = Share.update(ready, Share.Message.ClickedShare())
    expect(names(asked)).toEqual([Share.NewShareId.name])
    const first = Share.update(
      asked.model,
      Share.Message.GeneratedShareId({ scope: SCOPE, shareId: 's1' }),
    )
    expect(names(first)).toEqual([Share.StageSection.name])
    expect(first.model.phase).toEqual(
      Share.Phase.Staging({ shareId: 's1', next: 0 }),
    )
    const second = Share.update(
      first.model,
      Share.Message.SucceededStageSection({
        scope: SCOPE,
        shareId: 's1',
        index: 0,
        redactedHash: 'h',
        peopleHash: 'p',
        caseHash: 'c',
      }),
    )
    expect(second.model.phase).toEqual(
      Share.Phase.Staging({ shareId: 's1', next: 1 }),
    )
    const finishing = Share.update(
      second.model,
      Share.Message.SucceededStageSection({
        scope: SCOPE,
        shareId: 's1',
        index: 1,
        redactedHash: 'h',
        peopleHash: 'p',
        caseHash: 'c',
      }),
    )
    expect(names(finishing)).toEqual([Share.FinishShare.name])
    expect(finishing.model.phase).toEqual(
      Share.Phase.Finishing({ shareId: 's1' }),
    )
  })

  test('a failed section can be resumed with the same share ID', () => {
    const failed = Share.update(
      modifyFields(ready, {
        phase: () => Share.Phase.Staging({ shareId: 's1', next: 1 }),
      }),
      Share.Message.FailedStageSection({
        scope: SCOPE,
        needsReload: false,
        shareId: 's1',
        index: 1,
        failure: Failure.Unavailable(),
      }),
    )
    expect(failed.model.phase._tag).toBe('Failed')
    const resumed = Share.update(failed.model, Share.Message.ClickedResume())
    expect(resumed.model.phase).toEqual(
      Share.Phase.Staging({ shareId: 's1', next: 1 }),
    )
    expect(names(resumed)).toEqual([Share.StageSection.name])
  })

  test('nothing is shared when there is nothing new', () => {
    const none = modifyFields(ready, {
      maybeCopy: () => Option.some({ ...COPY, hasUnsharedChanges: false }),
    })
    expect(Share.canShare(none)).toBe(false)
    expect(names(Share.update(none, Share.Message.ClickedShare()))).toEqual([])
  })

  test('a stale base shows the comparison, and resolving needs every choice', () => {
    const stale = Share.update(
      modifyFields(ready, {
        phase: () => Share.Phase.Finishing({ shareId: 's1' }),
      }),
      Share.Message.SucceededFinishShare({
        scope: SCOPE,
        shareId: 's1',
        outcome: {
          kind: 'stale_base',
          latestDraft: 1,
          comparison: COMPARISON,
        },
      }),
    )
    expect(stale.model.phase._tag).toBe('Comparing')
    expect(Option.isNone(Share.draftsOf(COMPARISON, stale.model.choices))).toBe(
      true,
    )
    const chosen = Share.update(
      stale.model,
      Share.Message.ChoseSide({ key: 'image:a', side: 'theirs' }),
    )
    expect(
      Option.getOrThrow(Share.draftsOf(COMPARISON, chosen.model.choices)),
    ).toEqual({ 'image:a': 'theirs' })
  })

  test('an answer of another entry of the screen is dropped', () => {
    const asked = Share.update(ready, Share.Message.ClickedShare())
    const first = Share.update(
      asked.model,
      Share.Message.GeneratedShareId({ scope: SCOPE, shareId: 's1' }),
    )
    const late = Share.update(
      first.model,
      Share.Message.SucceededStageSection({
        scope: { reportId: 'report-1', generation: 1 },
        shareId: 's1',
        index: 0,
        redactedHash: 'h',
        peopleHash: 'p',
        caseHash: 'c',
      }),
    )
    expect(late.model).toBe(first.model)
    expect(names(late)).toEqual([])
    const other = Share.update(
      first.model,
      Share.Message.SucceededStageSection({
        scope: { reportId: 'report-2', generation: 0 },
        shareId: 's1',
        index: 0,
        redactedHash: 'h',
        peopleHash: 'p',
        caseHash: 'c',
      }),
    )
    expect(other.model).toBe(first.model)
  })

  test('after a stale save the share offers to reload and share again', () => {
    const failed = Share.update(
      modifyFields(ready, {
        phase: () => Share.Phase.Staging({ shareId: 's1', next: 1 }),
      }),
      Share.Message.FailedStageSection({
        scope: SCOPE,
        shareId: 's1',
        index: 1,
        failure: Failure.Unavailable(),
        needsReload: true,
      }),
    )
    expect(failed.model.phase).toEqual(
      Share.Phase.Failed({
        shareId: 's1',
        next: 1,
        failure: Failure.Unavailable(),
        needsReload: true,
      }),
    )
    const reloading = Share.update(
      failed.model,
      Share.Message.ClickedReloadShare(),
    )
    expect(reloading.model.phase._tag).toBe('Ready')
    expect(names(reloading)).toEqual([Share.LoadShare.name])
  })
})
