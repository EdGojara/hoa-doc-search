#!/usr/bin/env node
/**
 * Vantaca extraction regression test runner.
 *
 * Discovers every fixture in tests/fixtures/vantaca-violations/, runs the
 * appropriate extractor (CSV path for .csv/.xlsx, PDF path for .pdf), and
 * asserts against expected-counts.json. The PDF runs are skipped when
 * ANTHROPIC_API_KEY is not set in the env.
 *
 * Exit code: 0 on all pass, 1 on any failure. CI-ready.
 *
 * Run locally:
 *   node tests/test_vantaca_extraction.js
 * Or:
 *   npm run test:vantaca
 *
 * Adding a fixture:
 *   1. Drop file in tests/fixtures/vantaca-violations/
 *   2. Add expected counts to expected-counts.json
 *   3. Re-run this script
 *
 * This is the "no regression contract" — every file Bedrock has actually
 * imported successfully gets a permanent test that runs before changes
 * ship. See memory project_ed_not_in_loop_test for the principle.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  parseVantacaViolations,
  parseVantacaViolationsPdf,
} = require('../lib/enforcement/vantaca_violation_import');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'vantaca-violations');
const EXPECTED_PATH = path.join(FIXTURE_DIR, 'expected-counts.json');

// CHECK constraint validation — Ed 2026-06-10 evening.
//
// The violations.current_stage column has a CHECK constraint that allows
// only this enumerated set of values. Parser bugs that invent values
// outside this set (e.g. 'hearing_pending', 'hearing_notice') parse OK
// but crash on INSERT in production, after staff already saw "✓ Preview".
//
// This validator runs over every parsed row and FAILS the test if any
// stage value falls outside the allow-list. Structural coverage of the
// CLAUDE.md scar "CHECK constraint values that don't exist in the
// constraint" — that bug can't ship.
//
// Source of truth: distinct values present in production violations
// table. Pulled live below when SUPABASE_KEY is set; falls back to a
// known-good static list when running offline.
const CANONICAL_STAGES_FALLBACK = new Set([
  'courtesy_1',
  'courtesy_2',
  'certified_209',
  'fine_assessed',
  'hearing_notice',   // exists in CHECK but parser folds into certified_209
  'legal_referral',
  'lien_filed',
  'cured',
  'closed',
  'voided',
]);

async function loadCanonicalStages() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) return CANONICAL_STAGES_FALLBACK;
  try {
    const { createClient } = require('@supabase/supabase-js');
    const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    // We can't easily introspect a CHECK constraint via supabase-js without
    // raw SQL — instead use the proven-accepted values currently in the
    // table. Any value present here was accepted by the constraint at
    // insert time, so it's a safe allow-list.
    const { data } = await s.from('violations').select('current_stage').limit(2000);
    const live = new Set((data || []).map((r) => r.current_stage).filter(Boolean));
    // Merge with fallback so we don't reject stages that exist in the
    // constraint but aren't represented in current data.
    for (const s of CANONICAL_STAGES_FALLBACK) live.add(s);
    return live;
  } catch (_) {
    return CANONICAL_STAGES_FALLBACK;
  }
}

const COLOR = {
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  gray:   (s) => `\x1b[90m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
};

function fail(name, msg) {
  console.log(`  ${COLOR.red('✗')} ${COLOR.bold(name)}`);
  console.log(`    ${COLOR.red(msg)}`);
}
function pass(name, msg) {
  console.log(`  ${COLOR.green('✓')} ${COLOR.bold(name)}${msg ? ' ' + COLOR.gray(msg) : ''}`);
}
function skip(name, msg) {
  console.log(`  ${COLOR.yellow('⊝')} ${COLOR.bold(name)} ${COLOR.gray(msg)}`);
}

function distributionFromRows(rows) {
  const d = {};
  for (const r of rows) {
    const k = r.resolved_via ? 'cured' : (r.stage || 'unknown');
    d[k] = (d[k] || 0) + 1;
  }
  return d;
}

function assertInRange(label, actual, spec, failures) {
  if (typeof spec === 'number') {
    if (actual !== spec) failures.push(`${label}: expected ${spec}, got ${actual}`);
    return;
  }
  if (spec && typeof spec === 'object') {
    if (spec.min != null && actual < spec.min) failures.push(`${label}: expected ≥ ${spec.min}, got ${actual}`);
    if (spec.max != null && actual > spec.max) failures.push(`${label}: expected ≤ ${spec.max}, got ${actual}`);
  }
}

async function runOneFixture(filename, expected, canonicalStages) {
  const filePath = path.join(FIXTURE_DIR, filename);
  if (!fs.existsSync(filePath)) {
    fail(filename, `fixture file missing`);
    return false;
  }
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filename).toLowerCase();

  let result;
  if (ext === '.pdf') {
    if (expected.skip_if_no_anthropic_key && !process.env.ANTHROPIC_API_KEY) {
      skip(filename, 'no ANTHROPIC_API_KEY — skipping PDF extraction');
      return true;
    }
    result = await parseVantacaViolationsPdf(buffer, filename);
  } else {
    result = parseVantacaViolations(buffer, filename);
  }

  const failures = [];

  if (expected.must_have_no_errors && result.errors && result.errors.length > 0) {
    failures.push(`expected no errors, got: ${result.errors.join('; ')}`);
  }

  // Hard rule: every emitted stage value MUST be in the constraint allow-list.
  // Catches the class of bug where parsers invent enum values that production
  // INSERT refuses. Null stage is allowed — cured rows track resolved_via
  // instead, and the apply endpoint defaults to courtesy_1 if stage is null.
  if (canonicalStages && result.rows && result.rows.length > 0) {
    const violatingRows = [];
    for (const row of result.rows) {
      if (row.stage != null && !canonicalStages.has(row.stage)) {
        violatingRows.push({ stage: row.stage, source_row: row._source_row, address: row.street_address });
        if (violatingRows.length >= 5) break;
      }
    }
    if (violatingRows.length > 0) {
      const uniqueBadStages = [...new Set(violatingRows.map(r => r.stage))];
      failures.push(
        `parser emitted stage values not in production CHECK constraint: ${uniqueBadStages.join(', ')}\n` +
        violatingRows.slice(0, 3).map(r => `    e.g. row ${r.source_row} (${r.address || 'unknown'}) emitted "${r.stage}"`).join('\n')
      );
    }
  }

  const rowCount = result.rows.length;
  if (expected.rows != null)          assertInRange('row count', rowCount, expected.rows,     failures);
  if (expected.min_rows != null)      assertInRange('row count', rowCount, { min: expected.min_rows }, failures);
  if (expected.max_rows != null)      assertInRange('row count', rowCount, { max: expected.max_rows }, failures);

  if (expected.stage_distribution) {
    const actual = distributionFromRows(result.rows);
    for (const [stage, spec] of Object.entries(expected.stage_distribution)) {
      assertInRange(`stage[${stage}]`, actual[stage] || 0, spec, failures);
    }
  }

  if (expected.must_have_address_for_known_row) {
    const hit = result.rows.find((r) => r.street_address === expected.must_have_address_for_known_row);
    if (!hit) failures.push(`expected a row for "${expected.must_have_address_for_known_row}" — not found`);
  }
  if (expected.must_have_category_for_known_row) {
    const hit = result.rows.find((r) => r.category_label === expected.must_have_category_for_known_row);
    if (!hit) failures.push(`expected a row with category "${expected.must_have_category_for_known_row}" — not found`);
  }

  if (failures.length > 0) {
    fail(filename, failures.join('\n    '));
    return false;
  }
  pass(filename, `${rowCount} rows · ${Object.entries(distributionFromRows(result.rows)).map(([k,v]) => `${v} ${k}`).join(' · ')}`);
  return true;
}

async function main() {
  console.log(COLOR.bold('\nVantaca extraction regression tests'));
  console.log(COLOR.gray(`  fixtures: ${FIXTURE_DIR}\n`));

  if (!fs.existsSync(EXPECTED_PATH)) {
    console.log(COLOR.red('expected-counts.json missing — no assertions to run'));
    process.exit(1);
  }
  const expectedAll = JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));
  const fixtureNames = Object.keys(expectedAll);

  if (fixtureNames.length === 0) {
    console.log(COLOR.yellow('No fixtures registered in expected-counts.json'));
    process.exit(0);
  }

  const canonicalStages = await loadCanonicalStages();
  console.log(COLOR.gray(`  canonical stages (${canonicalStages.size}): ${[...canonicalStages].join(', ')}\n`));

  let passCount = 0;
  let failCount = 0;
  for (const name of fixtureNames) {
    const ok = await runOneFixture(name, expectedAll[name], canonicalStages);
    if (ok) passCount++; else failCount++;
  }

  console.log();
  if (failCount === 0) {
    console.log(COLOR.green(COLOR.bold(`✓ All ${passCount} fixture(s) passed.`)));
    process.exit(0);
  } else {
    console.log(COLOR.red(COLOR.bold(`✗ ${failCount} of ${passCount + failCount} fixture(s) failed.`)));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(COLOR.red('Runner crashed:'), err);
  process.exit(1);
});
