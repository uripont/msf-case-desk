import { Schema } from 'effect'

import { Case } from './case'

const HOUR_MS = 3_600_000

export const DEMO_START = Date.UTC(2026, 10, 2, 9, 0, 0)

const hoursBefore = (hours: number): number => DEMO_START - hours * HOUR_MS

const decodeCases = Schema.decodeUnknownSync(Schema.Array(Case))

export const SEED_CASES = decodeCases([
  {
    id: 'SYN-001',
    centre: 'OCG',
    summary:
      'Anonymous report that a team lead pressures junior staff for favours in exchange for contract renewals.',
    channel: 'IntegrityLine',
    receivedAt: hoursBefore(20),
    scope: 'Team',
    risk: 'High',
    urgency: 'Elevated',
    fastTrackSignals: ['Exploitation'],
  },
  {
    id: 'SYN-002',
    centre: 'OCBA',
    summary:
      'A staff member says they were threatened after speaking to a manager about a previous complaint.',
    channel: 'Email',
    receivedAt: hoursBefore(8),
    scope: 'Individual',
    risk: 'High',
    urgency: 'Immediate',
    fastTrackSignals: ['Retaliation'],
  },
  {
    id: 'SYN-003',
    centre: 'OCB',
    summary:
      'Repeated disrespectful language in a project meeting, reported by two colleagues.',
    channel: 'LineManager',
    receivedAt: hoursBefore(52),
    scope: 'Team',
    risk: 'Medium',
    urgency: 'Routine',
    fastTrackSignals: [],
  },
  {
    id: 'SYN-004',
    centre: 'OCP',
    summary:
      'Report of a pattern of unequal treatment across several country offices.',
    channel: 'PartnerOrganisation',
    receivedAt: hoursBefore(30),
    scope: 'Systemic',
    risk: 'Medium',
    urgency: 'Elevated',
    fastTrackSignals: [],
  },
  {
    id: 'SYN-005',
    centre: 'OCA',
    summary:
      'Concern about a colleague who shares inappropriate jokes in a team chat.',
    channel: 'Email',
    receivedAt: hoursBefore(70),
    scope: 'Individual',
    risk: 'Low',
    urgency: 'Routine',
    fastTrackSignals: [],
  },
  {
    id: 'SYN-006',
    centre: 'OCG',
    summary:
      'A worker reports unsafe conditions on a field site and fears for their immediate safety.',
    channel: 'IntegrityLine',
    receivedAt: hoursBefore(3),
    scope: 'Team',
    risk: 'High',
    urgency: 'Immediate',
    fastTrackSignals: ['ImmediatePhysicalSafety'],
  },
  {
    id: 'SYN-007',
    centre: 'OCBA',
    summary:
      'Conflict between two managers over resource allocation that is affecting their teams.',
    channel: 'LineManager',
    receivedAt: hoursBefore(26),
    scope: 'Team',
    risk: 'Low',
    urgency: 'Elevated',
    fastTrackSignals: [],
  },
  {
    id: 'SYN-008',
    centre: 'OCB',
    summary:
      'Question about whether a gift from a supplier breaches the code of conduct.',
    channel: 'Email',
    receivedAt: hoursBefore(5),
    scope: 'Individual',
    risk: 'Low',
    urgency: 'Routine',
    fastTrackSignals: [],
  },
])
