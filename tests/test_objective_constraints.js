// ============================================================================
// tests/test_objective_constraints.js  (Ed 2026-10-11)
// ----------------------------------------------------------------------------
// Scar: PR #123 shipped objective_type 'legal' for the legal activities. The
// objectives CHECK (migration 489) does not allow it, so every team run failed
// in production with "violates check constraint objectives_objective_type_check".
// scripts/check_constraint_values.js only sees `.insert({col:'literal'})`; these
// values travel through lib/manager/state.apply in an object literal, so it
// missed them. This test reads the LATEST CHECK definition for each objectives
// column from the migrations and fails on any literal the code emits that the
// database would reject.
// ============================================================================
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } }

const MIG = path.join(__dirname, '..', 'migrations');
function latestAllowed(constraint, column) {
  let allowed = null;
  for (const f of fs.readdirSync(MIG).filter((x) => /^\d{3}_.*\.sql$/.test(x)).sort()) {
    const sql = fs.readFileSync(path.join(MIG, f), 'utf8');
    const named = new RegExp(constraint + '\\s*\\n?\\s*CHECK\\s*\\(([^;]*?)\\)\\s*\\)?;', 'i').exec(sql);
    const inline = f.startsWith('399_') ? new RegExp(column + '[^\\n]*CHECK \\(' + column + ' IN \\(([^)]*)\\)', 'i').exec(sql) : null;
    const m = named || inline;
    if (m) allowed = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }
  return allowed;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

console.log('objectives CHECK values');
const cols = [['objective_type', 'objectives_objective_type_check'], ['domain', 'objectives_domain_check'], ['owner_kind', 'objectives_owner_kind_check']];
const files = walk(path.join(__dirname, '..', 'lib'));
for (const [col, cons] of cols) {
  const allowed = latestAllowed(cons, col);
  ok(Array.isArray(allowed) && allowed.length > 0, `found the latest ${cons} (${(allowed || []).join(', ')})`);
  if (!allowed) continue;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (!/objective_type/.test(src)) continue;   // only files that build objectives
    for (const m of src.matchAll(new RegExp(`\\b${col}:\\s*'([a-z_]+)'`, 'g'))) {
      ok(allowed.includes(m[1]), `${path.relative(path.join(__dirname, '..'), f)}: ${col} '${m[1]}' is allowed`);
    }
  }
}

// The legal activities in particular (the shipped failure).
const TEAM = require('../lib/legal/team');
const row = { id: 'i', community_id: 'c', invoice_number: '1', vendor: 'V', total_cents: 1, ap_status: 'awaiting_approval', paid: false, released: false, manager_approved: false,
  review_status: 'draft', has_draft: false, homeowner_cents: 0, recoverable_count: 0, exceptions: [], docs: { missing: [], inaccessible: [] }, postings: { pending: 0, posted: 0 } };
const allowedType = latestAllowed('objectives_objective_type_check', 'objective_type');
const allowedDomain = latestAllowed('objectives_domain_check', 'domain');
for (const [name, fn] of [['payment', TEAM.legalPayment], ['recovery', TEAM.legalRecovery], ['documentation', TEAM.legalDocumentation]]) {
  const c = fn(row);
  ok(allowedType.includes(c.objective_type) && allowedDomain.includes(c.domain), `legal ${name} activity: objective_type '${c.objective_type}', domain '${c.domain}' are allowed`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
