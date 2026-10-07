#!/usr/bin/env node
// ============================================================================
// scripts/check_migration_immutability.js  (Ed 2026-09-27)
// ----------------------------------------------------------------------------
// A migration file is IMMUTABLE once it lands on main. To change behaviour,
// write a new migration. This check fails the build if any migrations/*.sql
// that exists on main has been modified or deleted relative to the content it
// had when it FIRST landed on main (first-parent history).
//
// Why: 27 files were edited after landing on main (see migrations/LEDGER_NOTES.md),
// and in two cases (227, 435) the tracker now records a version that differs from
// the file. A prose rule didn't prevent it; this does.
//
// Not checked: files that have not reached main yet, so a migration can still be
// revised on its feature branch before merge.
//
// Comparison uses git blob ids. `git hash-object --path` applies the same
// line-ending normalization git uses, so a Windows CRLF checkout compares equal.
// ============================================================================
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 }).toString();

// Historical edits made before this rule existed, each pinned to its CURRENT blob
// id so it can never change again. Documented in migrations/LEDGER_NOTES.md.
// Do not add to this list; write a new migration instead.
const HISTORICAL_EXCEPTIONS = {
  // A. tracker records a different version than the file
  '227_portal_manager_builder_scope.sql': '0ea83315aa1b6fa10b37d294ad29a561134fa574',
  '435_presentation_artifact_type.sql': '65af77bd7b99a48d641e774396674520cd28a22c',
  // B. edited on main before being applied (tracker = current file)
  '012_documents_module.sql': '38b34f15f403ab7bb79d6f889ca4c4fc7a24b674',
  '013b_documents_unify_hotfix.sql': '98d61f2fc52fdbe29a0dfa53ac56df2bb5e12e1e',
  '027_arc_historical_decisions.sql': '767a6fc893999f3cb5ffe44c2c7554021e04f417',
  '051_view_lat_lng.sql': '7dcab1b296d895650b5a0d4cf30571698c2ebc63',
  '055_interactions_printed_at.sql': '9c6b9c12317885cc5b1c08383be100ce9875ed6c',
  '076_property_summary_view.sql': 'afb0b27283abb646c55a9c4f11edea2a499fbb40',
  '085_dedup_properties_function.sql': '0f40b5c2d2500d715a55fc6d239a99031c0372a1',
  '091_reserve_today_view.sql': 'e8485ce7046c447578be709e11a409cd84794bcb',
  '093_reserve_view_with_amenity_operating.sql': '6438d4cb2c1b3c1e000b3d28ef6771638d03f7e5',
  '094_vendor_contract_category.sql': 'ac8233a248d1971cd9c62fe3c91e8b42a5b300dd',
  '121_community_map_audit_and_acks.sql': '850e9dd5ad266127b08ba020f3dfa9d4b5855c0f',
  '147_community_default_geo.sql': 'c1d890f4cd491b108923cfd5225f537177200320',
  '151_community_website_url.sql': 'e8f42f1bc39a51ef43494f5e75f7ebc9654b28d9',
  '219_violation_continuations.sql': '7ca4cea3009a89bc859ed78e5a0dc2e15e9efe9d',
  '278_add_postage_drv_category.sql': '0226ddf6196f683aa44d80745282b037cfe8515a',
  '322_violation_field_checks.sql': '0e4e55a510eb1d8bce8681984d4c67b9b4369477',
  '361_property_summary_canonical_balance.sql': '1064ff126c95b9510af5a9981ace3823dd662ba8',
  '363_chamber_meeting_broadcasts.sql': '1b752ddae517e89d977bc44ef09fbe83df9f87cc',
  '385_board_learning.sql': '587ad661862a43c6b862433b0ffe76f578238727',
  '390_amenity_security_and_sports_fields.sql': '62870e74137404b37d47fb4d17dca0451e0f48bc',
  '391_drama_creek_demo_amenities.sql': 'ea7e94f5ea01c3c7c8600dc7b4832418a352c785',
  '418_voice_route_bedrock_number.sql': 'b929c6364d8db198ff93bc22547f9ecce730625c',
  '434_acc_async_clarification.sql': '4cb23cacd58624f9499569513856bdd778171b24',
  '460_same_day_sequential_resale.sql': 'ce2298a63d9acc51fe889a8fa78748e87ab7d227',
  'RUN_NOW_karla_drb_consolidate.sql': 'd2a945c5b812321f4ab82f2436e7b73d52495efd',
  // One-time, sanctioned by Ed 2026-10-06 (LEDGER_NOTES.md): runner refused #71's
  // version unexecuted; #72 fixed it before apply; applied version = this blob.
  '492_tessa_outbox_meeting_mode.sql': '668c698c4b11958f3b2a4c1f00b59bbc5b06b153',
};

function mainRef() {
  for (const ref of ['origin/main', 'main']) {
    try { git('rev-parse', '--verify', '--quiet', ref); return ref; } catch (_) { /* try next */ }
  }
  return null;
}

function run() {
  try { git('rev-parse', '--git-dir'); } catch (_) {
    console.log('SKIP  migration immutability (not a git checkout)');
    return 0;
  }
  const ref = mainRef();
  if (!ref) { console.log('SKIP  migration immutability (no main branch available)'); return 0; }

  // First blob each file had when it landed on main. The log is newest-first, so
  // keep overwriting: the last assignment is the oldest add.
  const raw = git('log', ref, '--first-parent', '-m', '--diff-filter=A', '--raw', '--no-abbrev', '--format=', '--', 'migrations/');
  const firstBlob = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^:\d+ \d+ [0-9a-f]+ ([0-9a-f]{40}) A\t(migrations\/[^\t]+\.sql)$/);
    if (m) firstBlob[m[2]] = m[1];
  }

  const onMain = git('ls-tree', '--name-only', ref, 'migrations/').split('\n').filter((f) => f.endsWith('.sql'));
  const failures = [];
  const present = onMain.filter((f) => fs.existsSync(path.join(ROOT, f)));
  for (const f of onMain) if (!present.includes(f)) failures.push(`${f}: deleted (migration history must be preserved)`);

  const blobs = execFileSync('git', ['hash-object', '--stdin-paths'], { cwd: ROOT, input: present.join('\n') + '\n', maxBuffer: 64 * 1024 * 1024 })
    .toString().trim().split('\n');

  let checked = 0;
  present.forEach((f, i) => {
    const orig = firstBlob[f];
    if (!orig) { failures.push(`${f}: on ${ref} but no add commit found in first-parent history`); return; }
    checked++;
    const name = f.slice('migrations/'.length);
    const now = blobs[i];
    if (now === orig) return;
    if (Object.prototype.hasOwnProperty.call(HISTORICAL_EXCEPTIONS, name)) {
      const pinned = HISTORICAL_EXCEPTIONS[name];
      if (pinned === now) return;
      failures.push(`${f}: documented historical exception, but it changed AGAIN (pinned ${String(pinned).slice(0, 12)}, now ${now.slice(0, 12)})`);
      return;
    }
    failures.push(`${f}: modified after it landed on main (first ${orig.slice(0, 12)}, now ${now.slice(0, 12)}). Write a new migration instead.`);
  });

  if (failures.length) {
    console.log(`FAIL  migration immutability: ${failures.length} problem(s)`);
    for (const x of failures) console.log(`   - ${x}`);
    return 1;
  }
  console.log(`PASS  migration immutability: ${checked} migrations on ${ref} unchanged since they landed (${Object.keys(HISTORICAL_EXCEPTIONS).length} pinned historical exceptions)`);
  return 0;
}

process.exitCode = run();
