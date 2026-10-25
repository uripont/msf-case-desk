# Triage rules (draft 0.1)

These rules are drafts. They exist so the team and the unit have something concrete to criticise, and they are kept as data in `packages/domain/src/rules.ts` so they can change without touching the engine.

## Inputs

Each case carries three assessed factors and an optional list of fast-track signals.

| Factor | Levels and points |
| --- | --- |
| Scope | Individual 0, Team 1, Systemic 2 |
| Risk | Low 0, Medium 2, High 4 |
| Urgency | Routine 0, Elevated 2, Immediate 4 |

Fast-track signals: `ImmediatePhysicalSafety`, `Exploitation`, `Retaliation`.

## Priority

1. If the case has any fast-track signal, it is **P1** and its target is the fast-track clock.
2. Otherwise the score is the sum of the three factors, from 0 to 10.
3. A score of 7 or more is **P1**, 4 or more is **P2**, anything lower is **P3**.

## Targets for the initial assessment

| Priority | Target (hours from reception) |
| --- | --- |
| Fast-track | 24 |
| P1 | 48 |
| P2 | 72 |
| P3 | 96 |

The charter sets the goal of getting the average time from intake to triage under 48 to 72 hours, down from up to 14 days. The simulation planned for increment 3 is how the project will measure that.

## Properties the tests enforce

- A fast-track signal always gives P1 with the fast-track clock.
- Raising any factor never lowers the priority or the score.
- The score is always between 0 and 10.
- The same case and rules always give the same result.
- Every result carries at least four reasons, and each one can be described in words.

## Open questions for the unit

- Are three factors enough, and are the points proportionate?
- Which signals should force the fast-track?
- Are 24, 48, 72 and 96 hours the right targets, and are they calendar or working hours?
