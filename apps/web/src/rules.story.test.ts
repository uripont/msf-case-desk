import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'

import { DEFAULT_RULES, type RuleSet, SEED_CASES } from '@case-desk/domain'

import { loadedModel } from './fixtures'
import { Message, PutRuleSet, queueOf, update } from './main'
import { previewOfRules, rulesFormFor } from './rulesForm'

const savedOcg: RuleSet = {
  scope: 'OCG',
  rules: { ...DEFAULT_RULES, version: 'ocg-strict', p1MinScore: 5 },
  updatedAt: 0,
  updatedByName: 'Synthetic Tester',
}

describe('rules editor', () => {
  test('a centre without its own rules starts from the default ones', () => {
    const form = rulesFormFor([], 'OCB')
    expect(form.p1MinScore).toBe(String(DEFAULT_RULES.p1MinScore))
    expect(form.version).toBe(DEFAULT_RULES.version)
  })

  test('the preview shows cases that would change group', () => {
    const form = {
      ...rulesFormFor([], 'OCB'),
      p1MinScore: '2',
      p2MinScore: '1',
    }
    const preview = previewOfRules(form, [], SEED_CASES)
    expect(preview._tag).toBe('Some')
    if (preview._tag === 'Some') {
      const ocbCases = SEED_CASES.filter(seed => seed.centre === 'OCB')
      expect(preview.value.affectedCases).toBe(ocbCases.length)
      preview.value.moved.forEach(({ triageCase, after }) => {
        expect(triageCase.centre).toBe('OCB')
        expect(after).toBe('P1')
      })
    }
  })

  test('inconsistent rules are not sent and say why', () => {
    story(
      update,
      given(loadedModel),
      message(Message.ClickedPage({ page: 'Rules' })),
      message(Message.UpdatedRulesField({ field: 'p2MinScore', value: '9' })),
      message(Message.SubmittedRules()),
      model(next => {
        expect(next.rulesForm.isShowingErrors).toBe(true)
        expect(next.rulesForm.submission._tag).toBe('Editing')
      }),
      Command.expectNone(),
    )
  })

  test('saved rules for a centre change how its cases are grouped', () => {
    story(
      update,
      given(loadedModel),
      message(Message.ClickedPage({ page: 'Rules' })),
      message(Message.SelectedRulesScope({ scope: 'OCG' })),
      message(Message.UpdatedRulesField({ field: 'p1MinScore', value: '5' })),
      message(
        Message.UpdatedRulesField({ field: 'version', value: 'ocg-strict' }),
      ),
      message(Message.SubmittedRules()),
      model(next => {
        expect(next.rulesForm.submission._tag).toBe('Saving')
      }),
      Command.expectHas(PutRuleSet({ scope: 'OCG', rules: savedOcg.rules })),
      Command.resolve(
        PutRuleSet,
        Message.SucceededPutRuleSet({ ruleSet: savedOcg }),
      ),
      model(next => {
        expect(next.ruleSets).toEqual([savedOcg])
        expect(next.rulesForm.submission._tag).toBe('Saved')
        queueOf(next)
          .filter(
            row => row.triageCase.centre === 'OCG' && !row.result.isFastTrack,
          )
          .forEach(row => {
            expect(row.result.priority).toBe(
              row.result.score >= 5
                ? 'P1'
                : row.result.score >= 4
                  ? 'P2'
                  : 'P3',
            )
          })
      }),
    )
  })

  test('a failed save keeps the changes', () => {
    story(
      update,
      given(loadedModel),
      message(Message.ClickedPage({ page: 'Rules' })),
      message(Message.UpdatedRulesField({ field: 'targetP3', value: '120' })),
      message(Message.SubmittedRules()),
      Command.resolve(
        PutRuleSet,
        Message.FailedPutRuleSet({ failure: 'Unavailable' }),
      ),
      model(next => {
        expect(next.rulesForm.targetP3).toBe('120')
        expect(next.rulesForm.submission).toEqual({
          _tag: 'Failed',
          failure: 'Unavailable',
        })
      }),
    )
  })
})
