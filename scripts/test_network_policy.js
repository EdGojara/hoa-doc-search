// ============================================================================
// scripts/test_network_policy.js  (Ed 2026-10-04, Issue #27 follow-up)
// ----------------------------------------------------------------------------
// Which checks may touch the network, and how. ONE list, read by
// scripts/run_all_tests.js (to set TEST_NO_PROD per check) and by
// scripts/check_test_network_guard.js (to enforce it). Everything NOT named
// here runs loopback-only (TEST_NO_PROD=1): any other connect is refused and
// fails the check. See tests/_support/no_prod_network.js for the scar.
//
// Adding a check here is a reviewed decision. It is never the way to turn a
// red check green: a unit test refused by the guard needs a fake, not a pass.
// ============================================================================

// Read real production data on purpose, and ONLY read. Run TEST_NO_PROD=readonly:
// GET/HEAD to the Supabase host; every write and every other host is refused.
// Each was verified 2026-10-04 to pass with zero refusals in readonly mode.
const LIVE_READ_CHECKS = [
  'tests/test_builder_letter_validate.js',
  'tests/test_vendor_master.js',
  'tests/test_payment_dedup.js',
  'tests/test_board_package_registry.js',
  'tests/test_homeowner_ledger_path.js',
  'tests/test_ap_cutover.js',
  'tests/test_budget_phase0.js',          // hybrid: also fakes supabase-js (uses _support/live_readonly)
  'tests/test_report_categories.js',      // hybrid
  'tests/test_budget_monthly_plan.js',    // hybrid
  'tests/test_board_access.js',
  'scripts/check_owner_concentration.js',
  'tests/test_tessa_request.js',
  'tests/test_presentation_parity.js',
  'tests/test_dependency_count.js',
  'tests/test_lma_board_access.js',
];

// WRITE to production or call paid model APIs (which also log to agent_runs).
// NOT run by `npm test`. They run only with `npm test -- --live`, unguarded,
// and the summary names every one it skipped so the gap is never silent.
// Each is a follow-up: give it a fake/fixture or a PGlite world, then move it.
const LIVE_WRITE_CHECKS = [
  'tests/test_community_boundary.js',     // inserts + deletes a ZZTEST community and RPC writes
  'tests/test_character_registry.js',     // probes that direct writes to characters/component_versions are refused
  'tests/test_vantaca_extraction.js',     // Anthropic PDF extraction; agent_runs insert
  'tests/test_retrieval_regression.js',   // OpenAI embeddings against the live corpus
  'tests/test_forward_note_voice.js',     // Anthropic; agent_runs insert
  'tests/test_persona_knows_team.js',     // Anthropic; agent_runs insert
];

module.exports = { LIVE_READ_CHECKS, LIVE_WRITE_CHECKS };
