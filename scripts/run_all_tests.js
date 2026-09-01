#!/usr/bin/env node
// ============================================================================
// run_all_tests.js  (Ed 2026-08-18)
// ----------------------------------------------------------------------------
// Runs EVERY check and reports at the end. Replaces the `a && b && c` chain
// that used to be `npm test`.
//
// THE SCAR. The chain short-circuited on the first failure. On 2026-08-18
// `test_vendor_master.js` sat at step 7 of 33 and was failing on a data
// condition (two duplicate active vendor rows). That meant the other 26 steps
// NEVER RAN, including:
//
//   test_claire_guardrails      — the limits on what Claire may say
//   test_board_access           — board portal access scoping
//   test_board_vote_token       — vote token security
//   check_owner_concentration   — the guard added after the owner-collapse
//   check_pagination            — the 1000-row truncation control
//   check_credential_claims     — CPA/assurance language in customer copy
//   check_stored_email_body     — a stored message that kept only its preview
//   test_balance_asof           — stale balances shown as current
//
// Every one of those was silently inert, and the suite still looked like it
// was "failing for a known reason." That is the worst possible state for a
// control: present, trusted, and not running. It is the same meta-scar
// CLAUDE.md already names — a rule nobody executes is decoration.
//
// This runner keeps going, so one dirty fixture can never again disable the
// checks behind it. Exit code is non-zero if ANY check failed.
//
//   npm test                 run everything
//   npm test -- --bail       stop at the first failure (old behaviour)
//   npm test -- --only=board run just the checks whose name matches
// ============================================================================
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Order preserved from the original chain: cheap static checks first, then
// fixtures, then the live-data checks.
const CHECKS = [
  'scripts/check_constraint_values.js',
  'tests/test_vantaca_extraction.js',
  'tests/test_retrieval_regression.js',
  'tests/test_builder_letter_validate.js',
  'tests/test_forward_note_voice.js',
  'tests/test_persona_knows_team.js',
  'tests/test_vendor_master.js',
  'tests/test_forward_hygiene.js',
  'tests/test_payment_dedup.js',
  'tests/test_community_jurisdiction.js',
  'tests/test_board_package_registry.js',
  'tests/test_bill_classifier.js',
  'tests/test_property_resolution.js',
  'tests/test_reply_recipient.js',
  'tests/test_reply_learning.js',
  'tests/test_acc_application_matching.js',
  'tests/test_recurrence_escalation.js',
  'tests/test_route_specialist.js',
  'tests/test_board_access.js',
  'tests/test_board_motions.js',
  'tests/test_board_vote_token.js',
  'tests/test_board_vote_reply.js',
  'tests/test_statement_lines.js',
  'tests/test_gl_concept.js',
  'tests/test_letter_batch.js',
  'tests/test_bd_card.js',
  'tests/test_claire_guardrails.js',
  'tests/test_amanda_guardrails.js',
  'tests/test_amanda_audience.js',
  'tests/test_amanda_disposition.js',
  'tests/test_persona_configs.js',
  'tests/test_operator_actions.js',
  'tests/test_legal_threat_detect.js',
  'tests/test_shadow.js',
  'tests/test_objectives.js',
  'tests/test_reconcile.js',
  'tests/test_bedrock_ops.js',
  'tests/test_legal_billback.js',
  'tests/test_early_prepay.js',
  'tests/test_tessa_schedule.js',
  'tests/test_insurance_compare.js',
  'tests/test_insurance_renewal.js',
  'tests/test_team_roster.js',
  'tests/test_claire_scope.js',
  'scripts/check_owner_concentration.js',
  'scripts/check_pagination.js',
  'scripts/check_credential_claims.js',
  'scripts/check_stored_email_body.js',
  'scripts/check_source_bytes.js',
  'scripts/check_requires_tracked.js',
  'scripts/check_micr_pitch.js',
  'tests/test_contact_mining.js',
  'tests/test_persona_routing.js',
  'tests/test_signature_identity.js',
  'tests/test_reply_includes_history.js',
  'tests/test_tessa_voice.js',
  'tests/test_tessa_request.js',
  'tests/test_tessa_identity.js',
  'tests/test_tessa_groups.js',
  'tests/test_tessa_reply_recipients.js',
  'tests/test_tessa_board_command.js',
  'tests/test_presentation_mode.js',
  'tests/test_checkout_preview_gate.js',
  'tests/test_attachment_names_intent.js',
  'tests/test_paige_doc_review.js',
  'tests/test_draft_attachments.js',
  'tests/test_ap_attach_document.js',
  'tests/test_community_lifecycle.js',
  'tests/test_bedrock_pay.js',
  'tests/test_refund_routing.js',
  'tests/test_autopay.js',
  'tests/test_paige_annual_meeting.js',
  'tests/test_balance_asof.js',
  'tests/test_amanda_review.js',
  'tests/test_staff_directives.js',
];

const args = process.argv.slice(2);
const bail = args.includes('--bail');
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length) : null;

const queue = only ? CHECKS.filter((c) => c.includes(only)) : CHECKS;
if (!queue.length) {
  console.error(`No checks matched --only=${only}`);
  process.exit(1);
}

const results = [];
const started = Date.now();

for (const rel of queue) {
  const label = rel.replace(/^(tests|scripts)\//, '').replace(/\.js$/, '');
  process.stdout.write(`\n──────── ${label} ────────\n`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, rel)], {
    cwd: ROOT, stdio: 'inherit', env: process.env,
  });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  results.push({ label, rel, ok, ms, status: r.status });
  if (!ok && bail) {
    console.error(`\n--bail: stopping at first failure (${label}).`);
    break;
  }
}

const failed = results.filter((r) => !r.ok);
const skipped = queue.length - results.length;

console.log('\n' + '='.repeat(64));
console.log(`  ${results.length - failed.length}/${results.length} checks passed` +
  (skipped ? `  (${skipped} not reached — --bail)` : '') +
  `   ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log('='.repeat(64));

if (failed.length) {
  console.log('\n  FAILED:');
  for (const f of failed) console.log(`    ✗ ${f.label}   (exit ${f.status})   node ${f.rel}`);
  console.log('\n  Every other check still ran. A failure here no longer hides the ones behind it.\n');
  process.exit(1);
}
console.log('\n  ✓ All checks passed.\n');
