-- Synthetic demo cases, generated from packages/domain/src/seed.ts.
-- Regenerate with: pnpm --filter @case-desk/api demo:seed
-- Refreshed: 2026-11-02T19:19

INSERT INTO cases (id, centre, received_at, summary, scope, risk, urgency, fast_track_signals, channel, entered_at, entered_by, schema_version)
VALUES ('DEMO-001', 'OCG', CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 72000000, 'Anonymous report that a team lead pressures junior staff for favours in exchange for contract renewals.', 'Team', 'High', 'Elevated', '["Exploitation"]', 'IntegrityLine', CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 72000000, (SELECT id FROM users WHERE email = 'demo@case-desk.test'), 1)
ON CONFLICT (id) DO UPDATE SET received_at = excluded.received_at, entered_at = excluded.entered_at;
INSERT INTO cases (id, centre, received_at, summary, scope, risk, urgency, fast_track_signals, channel, entered_at, entered_by, schema_version)
VALUES ('DEMO-002', 'OCBA', CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 28800000, 'A staff member says they were threatened after speaking to a manager about a previous complaint.', 'Individual', 'High', 'Immediate', '["Retaliation"]', 'Email', CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 28800000, (SELECT id FROM users WHERE email = 'demo@case-desk.test'), 1)
ON CONFLICT (id) DO UPDATE SET received_at = excluded.received_at, entered_at = excluded.entered_at;
INSERT INTO cases (id, centre, received_at, summary, scope, risk, urgency, fast_track_signals, channel, entered_at, entered_by, schema_version)
VALUES ('DEMO-003', 'OCB', CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 187200000, 'Repeated disrespectful language in a project meeting, reported by two colleagues.', 'Team', 'Medium', 'Routine', '[]', 'LineManager', CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 187200000, (SELECT id FROM users WHERE email = 'demo@case-desk.test'), 1)
ON CONFLICT (id) DO UPDATE SET received_at = excluded.received_at, entered_at = excluded.entered_at;
INSERT INTO cases (id, centre, received_at, summary, scope, risk, urgency, fast_track_signals, channel, entered_at, entered_by, schema_version)
VALUES ('DEMO-004', 'OCP', CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 108000000, 'Report of a pattern of unequal treatment across several country offices.', 'Systemic', 'Medium', 'Elevated', '[]', 'PartnerOrganisation', CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 108000000, (SELECT id FROM users WHERE email = 'demo@case-desk.test'), 1)
ON CONFLICT (id) DO UPDATE SET received_at = excluded.received_at, entered_at = excluded.entered_at;
INSERT INTO cases (id, centre, received_at, summary, scope, risk, urgency, fast_track_signals, channel, entered_at, entered_by, schema_version)
VALUES ('DEMO-005', 'OCA', CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 252000000, 'Concern about a colleague who shares inappropriate jokes in a team chat.', 'Individual', 'Low', 'Routine', '[]', 'Email', CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 252000000, (SELECT id FROM users WHERE email = 'demo@case-desk.test'), 1)
ON CONFLICT (id) DO UPDATE SET received_at = excluded.received_at, entered_at = excluded.entered_at;
INSERT INTO cases (id, centre, received_at, summary, scope, risk, urgency, fast_track_signals, channel, entered_at, entered_by, schema_version)
VALUES ('DEMO-006', 'OCG', CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 10800000, 'A worker reports unsafe conditions on a field site and fears for their immediate safety.', 'Team', 'High', 'Immediate', '["ImmediatePhysicalSafety"]', 'IntegrityLine', CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 10800000, (SELECT id FROM users WHERE email = 'demo@case-desk.test'), 1)
ON CONFLICT (id) DO UPDATE SET received_at = excluded.received_at, entered_at = excluded.entered_at;
INSERT INTO cases (id, centre, received_at, summary, scope, risk, urgency, fast_track_signals, channel, entered_at, entered_by, schema_version)
VALUES ('DEMO-007', 'OCBA', CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 93600000, 'Conflict between two managers over resource allocation that is affecting their teams.', 'Team', 'Low', 'Elevated', '[]', 'LineManager', CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 93600000, (SELECT id FROM users WHERE email = 'demo@case-desk.test'), 1)
ON CONFLICT (id) DO UPDATE SET received_at = excluded.received_at, entered_at = excluded.entered_at;
INSERT INTO cases (id, centre, received_at, summary, scope, risk, urgency, fast_track_signals, channel, entered_at, entered_by, schema_version)
VALUES ('DEMO-008', 'OCB', CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 18000000, 'Question about whether a gift from a supplier breaches the code of conduct.', 'Individual', 'Low', 'Routine', '[]', 'Email', CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 18000000, (SELECT id FROM users WHERE email = 'demo@case-desk.test'), 1)
ON CONFLICT (id) DO UPDATE SET received_at = excluded.received_at, entered_at = excluded.entered_at;
