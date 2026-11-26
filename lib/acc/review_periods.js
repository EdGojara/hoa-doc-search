// ============================================================================
// lib/acc/review_periods.js  (Ed 2026-11-26)
// ----------------------------------------------------------------------------
// How long each association's governing documents give the architectural
// reviewer to act, from receipt, and what happens if it does not. One table,
// read by the ACC work views (lib/acc/work_view) for every application's
// deadline. A deadline that falls on a weekend or Bedrock holiday
// (lib/builder_arc/holidays.json) moves to the next business day for our own
// tracking; the documents' own consequence is reported as written.
//
// Where no period was found in the documents on file, Bedrock's standard
// (30 days from receipt) is used and labeled as such, never presented as the
// association's rule.
// ============================================================================
const DAY = 86400000;
const DEFAULT = { days: 30, consequence: null, citation: null, label: 'Bedrock standard: 30 days from receipt (no review period found in the governing documents on file)' };

// Filled from the governing documents (research 2026-11-26). key = lower-case community name.
const PERIODS = {
  'waterview estates': { days: 45, consequence: 'deemed denied if not acted on', citation: 'Declaration Art. II §2.1; Architectural Guidelines 2016 §1.4.4.3' },
  'canyon gate at cinco ranch': { days: 45, consequence: 'consequence depends on the section: Sections 1-7 deemed approved, Section 8 deemed denied; requests violating a setback, easement or express provision are deemed disapproved', citation: 'Declarations Art. II (Sections 1-8)' },
  'quail ridge': { days: 30, consequence: 'deemed approved if not acted on', citation: 'Restrictions and Covenants (1978) ¶2' },
  'still creek ranch': { days: 30, consequence: 'deemed disapproved if not approved', citation: 'Declaration (2019) Art. X.B' },
  'august meadows': { days: 30, consequence: 'deemed denied if not approved', citation: 'Declaration (2025) Art. XI.B' },
  // Lakes of Pine Forest: no review period or deemed outcome found in the Master
  // Declaration, Supplementals or Builder Guidelines (Art. VI §3 sets none). Bedrock standard applies.
};

function reviewPeriodFor(communityName, community = null) {
  const cfg = community && community.acc_delegation && Number(community.acc_delegation.review_days) > 0
    ? { days: Number(community.acc_delegation.review_days), consequence: community.acc_delegation.review_consequence || null, citation: community.acc_delegation.reference || null }
    : PERIODS[String(communityName || '').trim().toLowerCase()];
  if (!cfg) return DEFAULT;
  const label = `${cfg.days} days from receipt${cfg.consequence ? `; ${cfg.consequence}` : ''}${cfg.citation ? ` (${cfg.citation})` : ''}`;
  return { ...cfg, label };
}

function isBusinessDay(d) {
  const { isBusinessDay: b } = require('../builder_arc/deadlines');
  return b(d);
}

function deadlineFrom(receivedIso, period = DEFAULT) {
  const start = Date.parse(receivedIso);
  if (!Number.isFinite(start)) return null;
  const d = new Date(start + (period.days || DEFAULT.days) * DAY);
  for (let i = 0; i < 10 && !isBusinessDay(d); i++) d.setTime(d.getTime() + DAY);
  return d.toISOString();
}

module.exports = { reviewPeriodFor, deadlineFrom, PERIODS, DEFAULT };
