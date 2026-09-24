#!/usr/bin/env node
// ============================================================================
// One ownership-transfer path (mig 459). Static guard over the app code: every
// caller goes through approve_ownership_proposal with a settlement date, and no
// JS path ends an ownership, creates/ends a tenure, or flips a lot's source
// account directly. (The database refuses those too; this catches it at build
// time, before a user hits the refusal.) Behavior of the transfer itself is
// proven by tests/sql/459_transfer_rehearsal_tests.sql in the rollback rehearsal.
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}
const appFiles = [...walk('api'), ...walk('lib'), 'server.js'];

let failed = 0;
const t = (name, fn) => { try { fn(); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); } };

t('every approve_ownership_proposal call passes a settlement date', () => {
  let calls = 0;
  for (const f of appFiles) {
    const src = read(f);
    const re = /rpc\('approve_ownership_proposal',\s*\{([\s\S]*?)\}\)/g;
    let m;
    while ((m = re.exec(src))) { calls++; assert.ok(/p_settlement_date:/.test(m[1]), `${f}: approve call without p_settlement_date`); }
  }
  assert.ok(calls >= 2, 'expected Ownership Review + Home Sales callers, found ' + calls);
});

t('Home Sales record-closing passes the home sale id into the transfer', () => {
  const src = read('api/home_sales.js');
  assert.ok(/p_home_sale_id:\s*saleId/.test(src));
  assert.ok(!/from\('home_sales'\)\s*\.update\(saleRow\)/.test(src), 'post-transfer home_sales write is back');
});

t('no app code ends an ownership or writes tenures directly', () => {
  for (const f of appFiles) {
    const src = read(f);
    const re = /from\('property_ownerships'\)\s*\.update\(\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(src))) assert.ok(!/end_date/.test(m[1]), `${f}: direct end_date write on property_ownerships`);
    assert.ok(!/from\('ownership_tenures'\)\s*\.(insert|update|upsert|delete)\(/.test(src), `${f}: direct ownership_tenures write`);
  }
});

t('Claim Transfer files a pending proposal and does not touch ownership or the account', () => {
  const src = read('api/roster_import.js');
  const start = src.indexOf("router.post('/communities/:id/mailing-delta/claim-transfer'");
  const block = src.slice(start, src.indexOf('\n});', start));
  assert.ok(/from\('ownership_change_proposals'\)[\s\S]*?\.insert\(/.test(block), 'no proposal insert');
  assert.ok(/status: 'pending'/.test(block));
  assert.ok(!/from\('property_ownerships'\)/.test(block), 'still writes property_ownerships');
  assert.ok(!/from\('properties'\)\s*\.update/.test(block), 'still updates properties');
  assert.ok(!/from\('contacts'\)\s*\.insert/.test(block), 'still creates contacts');
});

t('Vantaca contacts upload never patches a lot account; owner changes carry the account onto the proposal', () => {
  const src = read('api/contacts.js');
  assert.ok(/field === 'vantaca_account_id'[\s\S]{0,200}continue;/.test(src), 'vantaca_account_id still patched by field changes');
  assert.ok(/vantaca_account_id:\s*row\.account_id && row\.account_id !== existingProp\.vantaca_account_id/.test(read('lib/contacts/vantaca_import.js')));
});

t('Ownership Review requires the settlement date before Approve', () => {
  const html = read('public/ownership-proposals-review.html');
  assert.ok(/id="settlementDate"/.test(html));
  assert.ok(/approveBtn'\)\.disabled = !\(transferReady\(p\) && d &&/.test(html));
  assert.ok(/body\.settlement_date = \$\('settlementDate'\)\.value/.test(html));
  const api = read('api/ownership_proposals.js');
  assert.ok(/settlement_date_required/.test(api));
});

t('migration 459 leaves exactly one approve signature and guards the direct writers', () => {
  const sql = read('migrations/459_ownership_transfer_single_path.sql');
  assert.ok(/DROP FUNCTION IF EXISTS approve_ownership_proposal\(uuid, text, text\);/.test(sql));
  for (const trg of ['trg_ownership_tenures_transfer_only', 'trg_property_ownerships_transfer_guard', 'trg_properties_account_xref_guard']) {
    assert.ok(sql.includes('CREATE TRIGGER ' + trg), 'missing ' + trg);
  }
  assert.ok(/seller_end := settle - 1;/.test(sql));
});

console.log(failed ? `\n${failed} failure(s)` : '\nall passed');
process.exitCode = failed ? 1 : 0;
