// ============================================================================
// tests/test_vantaca_reconcile.js
// ----------------------------------------------------------------------------
// Proves the 180-day certified-letter reconciliation guard. Run:
//   node tests/test_vantaca_reconcile.js
//
// Covers the cases that matter for Ed's ask "don't send first notice to anyone
// that got a cert":
//   1. Cert issued WITHIN 180 days  → incoming first notice is BLOCKED.
//   2. Cert issued OVER 180 days ago → stale; first notice is allowed.
//   3. trustEd already certified, Vantaca shows first notice → no regression.
//   4. trustEd at courtesy_1, Vantaca certified → advance (no duplicate).
//   5. Vantaca "Resolved"/"Void" (terminal) → recorded, never opens a notice.
//   6. Unmapped stage ("Owner Response", null) → needs_review, NOT courtesy_1.
//   7. "Pending Hearing" (folded to certified_209 upstream) protects siblings.
//   8. CONSTRAINT layer: every emitted result_stage is a value the
//      violations_current_stage_check CHECK constraint actually accepts.
// ============================================================================

const assert = require('assert');
const {
  reconcileResolvedRows,
  planApply,
  markStaleCourtesyClosed,
  CERT_VALID_DAYS,
} = require('../lib/enforcement/vantaca_reconcile');

// The exact OPEN+terminal values the live CHECK constraint allows
// (migration 050). result_stage must always be one of these — that's the
// "output is insertable" confirmation, not just "parser produced output."
const ALLOWED_STAGES = new Set([
  'courtesy_1', 'courtesy_2', 'certified_209', 'fine_assessed',
  'hearing_notice', 'legal_referral', 'lien_filed',
  'cured', 'closed', 'voided',
  null, // terminal-skip / needs-review rows carry no open stage
]);

const ASOF = '2026-06-18';
let passed = 0;
function check(name, cond) {
  assert.ok(cond, `FAIL: ${name}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// Helper to find the annotated row for a given category in the result.
const byCat = (rows, cat) => rows.find((r) => r.category_label === cat);

// ----------------------------------------------------------------------------
// Case 1 + 2 + 6 + 5: incoming Vantaca rows, no existing trustEd cases.
// ----------------------------------------------------------------------------
{
  const P = 'prop-1';
  const incoming = [
    // 1. A live cert (60 days old) AND a first notice on the SAME case →
    //    the first notice must be blocked by the cert.
    { property_id: P, category_id: 'cat-fence', stage: 'certified_209', opened_at: '2026-04-19', category_label: 'Fences (cert)' },
    { property_id: P, category_id: 'cat-fence', stage: 'courtesy_1',    opened_at: '2026-06-10', category_label: 'Fences (cert)' },
    // 2. A stale cert (>180 days old) on a different case + a fresh first
    //    notice → cert is expired, first notice is allowed.
    { property_id: P, category_id: 'cat-mow', stage: 'certified_209', opened_at: '2025-10-01', category_label: 'Mow (stale cert)' },
    { property_id: P, category_id: 'cat-mow', stage: 'courtesy_1',    opened_at: '2026-06-12', category_label: 'Mow (stale cert)' },
    // 5. Terminal rows.
    { property_id: P, category_id: 'cat-trash', stage: 'cured',  opened_at: '2026-05-01', category_label: 'Trash (resolved)' },
    { property_id: P, category_id: 'cat-sod',   stage: 'voided', opened_at: '2026-05-01', category_label: 'Sod (void)' },
    // 6. Unmapped stage (Owner Response → null upstream).
    { property_id: P, category_id: 'cat-paint', stage: null, opened_at: '2026-05-01', category_label: 'Paint (owner response)' },
  ];

  const { rows, blocklist, summary } = reconcileResolvedRows(incoming, [], { asOf: ASOF });

  const fenceCourtesy = rows.filter((r) => r.category_label === 'Fences (cert)' && r.reconciliation.incoming_stage === 'courtesy_1')[0];
  check('live cert blocks the sibling first notice', fenceCourtesy.reconciliation.action === 'block_regression');
  check('blocked first notice is pinned to certified_209', fenceCourtesy.reconciliation.result_stage === 'certified_209');
  check('blocklist surfaces the blocked notice', blocklist.length === 1 && blocklist[0].category_label === 'Fences (cert)');

  const mowCourtesy = rows.filter((r) => r.category_label === 'Mow (stale cert)' && r.reconciliation.incoming_stage === 'courtesy_1')[0];
  check('stale cert (>180d) does NOT block a fresh first notice', mowCourtesy.reconciliation.action === 'open');
  check('stale-cert pair is not marked cert_protected', mowCourtesy.reconciliation.cert_protected === false);

  check('cured row is skip_terminal, not a notice', byCat(rows, 'Trash (resolved)').reconciliation.action === 'skip_terminal');
  check('void row is skip_terminal, not a notice', byCat(rows, 'Sod (void)').reconciliation.action === 'skip_terminal');

  const paint = byCat(rows, 'Paint (owner response)');
  check('unmapped stage → needs_review (NOT courtesy_1)', paint.reconciliation.action === 'needs_review');
  check('unmapped stage never silently becomes a first notice', paint.reconciliation.result_stage !== 'courtesy_1');

  check('summary counts the block', summary.block_regression === 1);
}

// ----------------------------------------------------------------------------
// Case 3 + 4: existing trustEd cases meet incoming Vantaca rows.
// ----------------------------------------------------------------------------
{
  const P = 'prop-2';
  const existing = [
    // 3. trustEd already certified (40 days ago).
    { property_id: P, primary_category_id: 'cat-fence', current_stage: 'certified_209', current_stage_started_at: '2026-05-09', opened_at: '2026-03-01' },
    // 4. trustEd at courtesy_1.
    { property_id: P, primary_category_id: 'cat-mow', current_stage: 'courtesy_1', current_stage_started_at: '2026-05-20', opened_at: '2026-05-20' },
  ];
  const incoming = [
    // 3. Vantaca shows a first notice for the already-certified case.
    { property_id: P, category_id: 'cat-fence', stage: 'courtesy_1', opened_at: '2026-06-15', category_label: 'Fences' },
    // 4. Vantaca shows certified for the courtesy_1 case → advance.
    { property_id: P, category_id: 'cat-mow', stage: 'certified_209', opened_at: '2026-06-14', category_label: 'Mow' },
  ];

  const { rows } = reconcileResolvedRows(incoming, existing, { asOf: ASOF });

  const fence = byCat(rows, 'Fences');
  // trustEd already certified within 180d → cert-protected → block (no regression).
  check('first notice over trustEd cert is blocked', fence.reconciliation.action === 'block_regression');
  check('blocked case stays certified_209', fence.reconciliation.result_stage === 'certified_209');

  const mow = byCat(rows, 'Mow');
  check('Vantaca certified advances trustEd courtesy_1', mow.reconciliation.action === 'advance');
  check('advanced case lands on certified_209', mow.reconciliation.result_stage === 'certified_209');
}

// ----------------------------------------------------------------------------
// Case 7: "Pending Hearing" (folded to certified_209 upstream) protects a
// sibling courtesy notice exactly like a certified letter does.
// ----------------------------------------------------------------------------
{
  const P = 'prop-3';
  const incoming = [
    { property_id: P, category_id: 'cat-x', stage: 'certified_209', opened_at: '2026-05-22', category_label: 'Hearing-stage case' },
    { property_id: P, category_id: 'cat-x', stage: 'courtesy_1',    opened_at: '2026-06-16', category_label: 'Hearing-stage case' },
  ];
  const { rows, summary } = reconcileResolvedRows(incoming, [], { asOf: ASOF });
  const courtesy = rows.filter((r) => r.reconciliation.incoming_stage === 'courtesy_1')[0];
  check('pending-hearing (certified_209) blocks sibling first notice', courtesy.reconciliation.action === 'block_regression');
  check('cert_protected counted', summary.cert_protected >= 1);
}

// ----------------------------------------------------------------------------
// Case 8: constraint layer — every emitted result_stage is insertable.
// ----------------------------------------------------------------------------
{
  const P = 'prop-4';
  const existing = [
    { property_id: P, primary_category_id: 'cat-a', current_stage: 'courtesy_2', current_stage_started_at: '2026-06-01', opened_at: '2026-05-01' },
  ];
  const incoming = [
    { property_id: P, category_id: 'cat-a', stage: 'certified_209', opened_at: '2026-06-10', category_label: 'A' },
    { property_id: P, category_id: 'cat-b', stage: 'courtesy_1', opened_at: '2026-06-10', category_label: 'B' },
    { property_id: P, category_id: 'cat-c', stage: 'fine_assessed', opened_at: '2026-06-10', category_label: 'C' },
    { property_id: P, category_id: 'cat-d', stage: 'cured', opened_at: '2026-06-10', category_label: 'D' },
    { property_id: P, category_id: 'cat-e', stage: null, opened_at: '2026-06-10', category_label: 'E' },
  ];
  const { rows } = reconcileResolvedRows(incoming, existing, { asOf: ASOF });
  let allValid = true;
  for (const r of rows) {
    if (!ALLOWED_STAGES.has(r.reconciliation.result_stage)) {
      allValid = false;
      console.error(`    emitted non-insertable stage: ${r.reconciliation.result_stage}`);
    }
  }
  check('every result_stage is accepted by the CHECK constraint', allValid);
}

// ----------------------------------------------------------------------------
// Case 9: the EXACT labels from Ed's Waterview "Violation Report - Detail"
// (6/18/2026) map to the right canonical stage. This is the hard-fixture
// confirmation — the real file's vocabulary, not synthetic stages.
// ----------------------------------------------------------------------------
{
  const { _normalizeStage, _ssrsStageToCanonical } = require('../lib/enforcement/vantaca_violation_import');
  const expect = {
    'First Notice': 'courtesy_1',
    'Second Notice': 'courtesy_2',
    'Certified Letter Notice': 'certified_209',
    'Pending Hearing': 'certified_209',   // §209 hearing step, NOT fine_assessed
    'Owner Response': null,               // unmapped → needs_review, NOT a first notice
    'Closed': 'cured',
    'Resolved': 'cured',
    'Void': 'voided',
  };
  for (const [label, want] of Object.entries(expect)) {
    check(`_normalizeStage("${label}") → ${want}`, _normalizeStage(label) === want);
    // SSRS path uses a separate mapper; the two must agree on the labels they
    // both recognize (hearing folding + first/second/certified).
    const ssrs = _ssrsStageToCanonical(label);
    if (ssrs !== null) {
      check(`_ssrsStageToCanonical("${label}") agrees → ${ssrs}`, ssrs === want);
    }
  }
}

// ----------------------------------------------------------------------------
// Case 10: planApply turns reconciliation decisions into the right DB ops, and
// an 'advance' carries the existing violation id so the writer UPDATEs the
// real case instead of inserting a duplicate.
// ----------------------------------------------------------------------------
{
  const P = 'prop-5';
  const existing = [
    { id: 'viol-mow-1', property_id: P, primary_category_id: 'cat-mow', current_stage: 'courtesy_1', current_stage_started_at: '2026-05-20', opened_at: '2026-05-20' },
    { id: 'viol-fence-1', property_id: P, primary_category_id: 'cat-fence', current_stage: 'certified_209', current_stage_started_at: '2026-05-09', opened_at: '2026-03-01' },
  ];
  const incoming = [
    { property_id: P, category_id: 'cat-mow', stage: 'certified_209', opened_at: '2026-06-14', category_label: 'Mow' },     // advance
    { property_id: P, category_id: 'cat-fence', stage: 'courtesy_1', opened_at: '2026-06-15', category_label: 'Fence' },     // block
    { property_id: P, category_id: 'cat-new', stage: 'courtesy_1', opened_at: '2026-06-15', category_label: 'New' },         // open
    { property_id: P, category_id: 'cat-done', stage: 'cured', opened_at: '2026-06-01', category_label: 'Done' },            // terminal
    { property_id: P, category_id: 'cat-huh', stage: null, opened_at: '2026-06-01', category_label: 'Huh' },                 // needs_review
  ];
  const { rows } = reconcileResolvedRows(incoming, existing, { asOf: ASOF });
  const plan = planApply(rows);

  check('planApply: one advance update', plan.updates.length === 1);
  check('advance update targets the real violation id', plan.updates[0].violation_id === 'viol-mow-1');
  check('advance update moves to certified_209', plan.updates[0].current_stage === 'certified_209');
  check('planApply: one fresh insert', plan.inserts.length === 1 && plan.inserts[0].row.category_label === 'New');
  check('planApply: one blocked courtesy (no write)', plan.blocked.length === 1 && plan.blocked[0].category_label === 'Fence');
  check('planApply: one terminal record', plan.terminal.length === 1 && plan.terminal[0].row.category_label === 'Done');
  check('planApply: one needs_review (no write)', plan.needs_review.length === 1 && plan.needs_review[0].category_label === 'Huh');
  check('planApply: blocked + needs_review never become inserts',
    !plan.inserts.some((i) => ['Fence', 'Huh'].includes(i.row.category_label)));
}

// ----------------------------------------------------------------------------
// Case 11: a trustEd case already PAST certified (hearing_notice / legal_referral
// / lien_filed) must never be regressed by an incoming Vantaca courtesy notice.
// These stages rank ABOVE certified_209; a missing rank would silently treat
// them as 0 and let a courtesy_1 "advance" the case downward.
// ----------------------------------------------------------------------------
{
  const P = 'prop-6';
  const existing = [
    { id: 'v-lien', property_id: P, primary_category_id: 'cat-lien', current_stage: 'lien_filed', current_stage_started_at: '2026-06-01', opened_at: '2026-01-01' },
    { id: 'v-hear', property_id: P, primary_category_id: 'cat-hear', current_stage: 'hearing_notice', current_stage_started_at: '2026-06-01', opened_at: '2026-02-01' },
  ];
  const incoming = [
    { property_id: P, category_id: 'cat-lien', stage: 'courtesy_1', opened_at: '2026-06-15', category_label: 'Lien case' },
    { property_id: P, category_id: 'cat-hear', stage: 'courtesy_1', opened_at: '2026-06-15', category_label: 'Hearing case' },
  ];
  const { rows } = reconcileResolvedRows(incoming, existing, { asOf: ASOF });
  const lien = byCat(rows, 'Lien case');
  const hear = byCat(rows, 'Hearing case');
  check('lien_filed case is cert-protected from a courtesy', lien.reconciliation.action === 'block_regression');
  check('lien_filed case never regresses below certified', lien.reconciliation.result_stage !== 'courtesy_1');
  check('hearing_notice case is cert-protected from a courtesy', hear.reconciliation.action === 'block_regression');
}

// ----------------------------------------------------------------------------
// Case 12: re-import idempotency — importing the SAME report again must not
// create duplicate open cases. Every incoming row matches an existing open case
// at the same stage → all 'continue', zero inserts.
// ----------------------------------------------------------------------------
{
  const P = 'prop-7';
  const existing = [
    { id: 'e1', property_id: P, primary_category_id: 'cat-a', current_stage: 'courtesy_1', current_stage_started_at: '2026-05-17', opened_at: '2026-05-17' },
    { id: 'e2', property_id: P, primary_category_id: 'cat-b', current_stage: 'certified_209', current_stage_started_at: '2026-04-01', opened_at: '2026-02-01' },
  ];
  const incoming = [
    { property_id: P, category_id: 'cat-a', stage: 'courtesy_1', opened_at: '2026-05-17', category_label: 'A' },
    { property_id: P, category_id: 'cat-b', stage: 'certified_209', opened_at: '2026-04-01', category_label: 'B' },
  ];
  const { rows } = reconcileResolvedRows(incoming, existing, { asOf: ASOF });
  const plan = planApply(rows);
  check('re-import creates ZERO new inserts', plan.inserts.length === 0);
  check('re-import creates ZERO advances (stages already match)', plan.updates.length === 0);
  check('re-import marks both as continued', plan.continued.length === 2);
}

// ----------------------------------------------------------------------------
// Case 13: staleness closure — a first/second notice with no recent activity is
// recorded as closed; certified (and beyond) is NEVER auto-closed. Cutoff is the
// first day of the month before the latest activity in the data.
// ----------------------------------------------------------------------------
{
  const rows = [
    { property_id: 'p1', category_id: 'c1', stage: 'courtesy_1', opened_at: '2026-01-15', category_label: 'old first' },
    { property_id: 'p2', category_id: 'c2', stage: 'courtesy_2', opened_at: '2026-02-10', category_label: 'old second' },
    { property_id: 'p3', category_id: 'c3', stage: 'courtesy_1', opened_at: '2026-05-06', category_label: 'recent first' },
    { property_id: 'p4', category_id: 'c4', stage: 'certified_209', opened_at: '2026-01-20', category_label: 'old certified' },
    { property_id: 'p5', category_id: 'c5', stage: 'fine_assessed', opened_at: '2026-01-05', category_label: 'old fine' },
  ];
  const { rows: out, stale_closed, cutoff } = markStaleCourtesyClosed(rows);
  const by = Object.fromEntries(out.map((r) => [r.category_label, r]));
  check('staleness cutoff is April 1 (latest data in May)', cutoff === '2026-04-01');
  check('stale-closed count = 2', stale_closed === 2);
  check('old first notice → cured', by['old first'].stage === 'cured' && by['old first']._stale_closed === true);
  check('old second notice → cured', by['old second'].stage === 'cured');
  check('recent first notice stays open', by['recent first'].stage === 'courtesy_1');
  check('OLD CERTIFIED is never auto-closed', by['old certified'].stage === 'certified_209');
  check('old fine_assessed (beyond certified) never auto-closed', by['old fine'].stage === 'fine_assessed');
  check('auto-closed rows carry a resolved date', by['old first'].resolved_at === '2026-01-15');

  // Explicit cutoff override is honored.
  const forced = markStaleCourtesyClosed(rows, { cutoff: '2026-06-01' });
  check('explicit cutoff closes the recent one too', forced.stale_closed === 3);
}

// Sanity on the constant so a future edit to the window is loud.
check('cert window is 180 days', CERT_VALID_DAYS === 180);

console.log(`\n${passed} assertions passed.`);
