// ============================================================================
// lib/postage/usps_rates.js  (Ed 2026-07-10)
// ----------------------------------------------------------------------------
// USPS First-Class Mail single-piece 1-oz letter (retail / Forever stamp) rate
// SCHEDULE, so postage on the activity report bills at the rate that was in
// effect on each letter's MAIL DATE — and auto-adjusts when USPS changes rates
// (we just add the next row here; no rate-card editing per community).
//
// Source: History of United States postage rates (USPS PRC filings).
// When USPS announces the next increase, append { from: 'YYYY-MM-DD', cents }.
// Rates are retail single-piece first-class (what "first class rates" means for
// violation-letter postage). Metered/presort is a few cents lower — a community
// mailing that way can still override its rate-card line.
// ============================================================================

// Ascending by effective date.
const FIRST_CLASS_SCHEDULE = [
  { from: '2019-01-27', cents: 55 },
  { from: '2021-08-29', cents: 58 },
  { from: '2022-07-10', cents: 60 },
  { from: '2023-01-22', cents: 63 },
  { from: '2023-07-09', cents: 66 },
  { from: '2024-01-21', cents: 68 },
  { from: '2024-07-14', cents: 73 },
  { from: '2025-07-13', cents: 78 },
  { from: '2026-07-12', cents: 82 },
];

// The first-class rate (in cents) in effect on a given date ('YYYY-MM-DD' or ISO).
// Falls back to the earliest known rate for dates before the schedule, and to
// the latest for anything on/after the newest effective date.
function firstClassRateCents(dateStr) {
  const d = String(dateStr || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return FIRST_CLASS_SCHEDULE[FIRST_CLASS_SCHEDULE.length - 1].cents;
  let rate = FIRST_CLASS_SCHEDULE[0].cents;
  for (const r of FIRST_CLASS_SCHEDULE) {
    if (r.from <= d) rate = r.cents; else break;
  }
  return rate;
}

module.exports = { firstClassRateCents, FIRST_CLASS_SCHEDULE };
