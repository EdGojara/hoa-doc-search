// ============================================================================
// test_escalation.js — regression tests for the enforcement decision engine
// ----------------------------------------------------------------------------
// Run: node tests/test_escalation.js   (exit 1 on any failure)
//
// Locks in the SAME-OCCURRENCE rule added 2026-06-26 (Erika Helms lawn case):
// a violation observed on the SAME calendar day as the one being opened is the
// SAME occurrence (two findings from one drive, or a deduped duplicate photo),
// NOT a prior repeat. It must NOT escalate. Real priors from earlier days MUST
// still escalate, and historical Vantaca rows that share an artificial import
// date must NOT be collapsed (that would lose real repeat history).
// ============================================================================

const { decideEscalation } = require('../lib/enforcement/escalation');

const today = new Date().toISOString();
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();
const prior = (opened, extra = {}) => ({
  opened_at: opened, primary_category_id: 'x', current_stage: 'courtesy_1',
  confidence_weight: 1.0, source: 'trustEd_native', ...extra,
});

const cases = [
  { name: 'No priors → courtesy_1', priors: [], want: 'courtesy_1' },
  { name: '1 same-drive sibling (today) → courtesy_1', priors: [prior(today)], want: 'courtesy_1' },
  { name: '2 same-drive siblings (today) → courtesy_1', priors: [prior(today), prior(today)], want: 'courtesy_1' },
  { name: '1 real prior (30d ago) → courtesy_2', priors: [prior(daysAgo(30))], want: 'courtesy_2' },
  { name: 'real prior (30d) + same-drive sibling (today) → courtesy_2', priors: [prior(daysAgo(30)), prior(today)], want: 'courtesy_2' },
  { name: '2 real priors (different past days) → certified_209', priors: [prior(daysAgo(60)), prior(daysAgo(30))], want: 'certified_209' },
  {
    name: '3 Vantaca priors sharing one import date → certified_209 (history preserved)',
    priors: [prior(daysAgo(40), { source: 'vantaca_import' }), prior(daysAgo(40), { source: 'vantaca_import' }), prior(daysAgo(40), { source: 'vantaca_import' })],
    want: 'certified_209',
  },
  // occurrence_date override: recompute an OLD violation; its same-day siblings excluded.
  {
    name: 'occurrence_date override excludes same-day-as-that-violation siblings',
    priors: [prior(daysAgo(90)), prior(daysAgo(90))],
    opts: { occurrence_date: daysAgo(90) },
    want: 'courtesy_1',
  },
  // CLOSED-CHAIN backstop (2026-06-29 certified-with-no-reason scar): a prior
  // that was voided/cured closes the chain and must NOT count — even if a
  // caller passes it unfiltered. A new violation after it is a fresh courtesy_1.
  {
    name: '2 VOIDED priors (resolved_at set) → courtesy_1 (closed chain ignored)',
    priors: [prior(daysAgo(60), { resolved_at: daysAgo(50), resolved_via: 'voided' }), prior(daysAgo(30), { resolved_at: daysAgo(20), resolved_via: 'voided' })],
    want: 'courtesy_1',
  },
  {
    name: '2 CURED priors (resolved_at set) → courtesy_1 (complied; chain closed)',
    priors: [prior(daysAgo(60), { resolved_at: daysAgo(50), resolved_via: 'cured' }), prior(daysAgo(30), { resolved_at: daysAgo(20), resolved_via: 'cured' })],
    want: 'courtesy_1',
  },
  {
    name: '1 standing prior + 1 voided prior → courtesy_2 (only the standing one counts)',
    priors: [prior(daysAgo(60)), prior(daysAgo(30), { resolved_at: daysAgo(20), resolved_via: 'voided' })],
    want: 'courtesy_2',
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const d = decideEscalation({ prior_violations: c.priors, priority_weight: 'standard', ...(c.opts || {}) });
  const ok = d.stage === c.want;
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${c.name} => ${d.stage}${ok ? '' : ` (wanted ${c.want})`}`);
}
console.log(`\n${pass}/${cases.length} passed`);
if (fail > 0) { console.error(`${fail} FAILURE(S)`); process.exit(1); }
