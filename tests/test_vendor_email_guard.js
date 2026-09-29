// tests/test_vendor_email_guard.js — a Bedrock staff address never lands on a vendor
// (Ed 2026-09-28: "celina email is not to be used for any vendor"). Runs the REAL
// ensureVendorForInvoice against an in-memory Supabase fake.
require('dotenv').config({ quiet: true });
const assert = require('assert');
const Module = require('module');

const inserted = [];
const fake = { from() {
  const q = { select() { return q; }, eq() { return q; }, neq() { return q; }, ilike() { return q; }, limit() { return q; }, order() { return q; }, in() { return q; }, or() { return q; },
    insert(row) { inserted.push(row); return { select() { return { single: async () => ({ data: { id: 'v-new', ...row }, error: null }) }; } }; },
    update() { return q; }, maybeSingle: async () => ({ data: null, error: null }),
    then(res) { return res({ data: [], error: null }); } };
  return q; } };
const realLoad = Module._load;
Module._load = function (request) {
  if (request === '@supabase/supabase-js') return { createClient: () => fake };
  return realLoad.apply(this, arguments);
};
const { ensureVendorForInvoice } = require('../lib/ap/vendor_master');
Module._load = realLoad;
const G = require('../lib/ap/vendor_email_guard');

let failed = 0;
const results = [];
const t = (name, fn) => results.push({ name, fn });

t('staff addresses are never a vendor email; Bedrock itself is the only exception', () => {
  assert.strictEqual(G.vendorEmailOrNull('cdeleon@bedrocktx.com', 'Star Protection Agency LLC'), null);
  assert.strictEqual(G.vendorEmailOrNull('  CDeleon@BedrockTX.com ', 'S&L Solutions'), null);
  assert.strictEqual(G.vendorEmailOrNull('billing@starprotection.com', 'Star Protection Agency LLC'), 'billing@starprotection.com');
  assert.strictEqual(G.vendorEmailOrNull('info@bedrocktx.com', 'Bedrock Association Management, LLC'), 'info@bedrocktx.com');
  assert.deepStrictEqual(G.refusedStaffEmailFields({ contact_email: 'cdeleon@bedrocktx.com', email: 'ok@vendor.com' }, 'Sweetwater Pools'), ['contact_email']);
  assert.deepStrictEqual(G.refusedStaffEmailFields({ contact_name: 'Nat' }, 'Sweetwater Pools'), []);
});

t('Emma creating a vendor from a forwarded bill that shows a staff address stores NO email', async () => {
  const r = await ensureVendorForInvoice({ extracted: { vendor_name: 'Brand New Pools LLC', vendor_email: 'cdeleon@bedrocktx.com' }, actor: 'Emma (AP)' });
  assert.ok(r.created);
  const row = inserted[inserted.length - 1];
  assert.strictEqual(row.email, null); assert.strictEqual(row.contact_email, null);
  // A real vendor address is still captured.
  await ensureVendorForInvoice({ extracted: { vendor_name: 'Other Pools LLC', vendor_email: 'ap@otherpools.com' }, actor: 'Emma (AP)' });
  assert.strictEqual(inserted[inserted.length - 1].contact_email, 'ap@otherpools.com');
});

t('the vendor edit check covers EVERY email field, including account_manager_email', () => {
  for (const f of G.EMAIL_FIELDS) {
    assert.ok(G.touchesStaffEmail({ [f]: 'cdeleon@bedrocktx.com' }), f);
    assert.deepStrictEqual(G.refusedStaffEmailFields({ [f]: 'cdeleon@bedrocktx.com' }, 'Star Protection Agency LLC'), [f]);
  }
  assert.ok(G.EMAIL_FIELDS.includes('account_manager_email'));
  assert.strictEqual(G.touchesStaffEmail({ account_manager_email: 'rep@vendor.com', contact_name: 'x' }), false);
  const src = require('fs').readFileSync(require.resolve('../api/vendors'), 'utf8');
  assert.ok(/if \(touchesStaffEmail\(update\)\)/.test(src), 'PATCH pre-check uses the all-fields helper');
  assert.ok(!/\['email', 'contact_email'\]\.some/.test(src), 'the two-field pre-check is gone');
});

t('every vendor write path goes through the guard (source contract)', () => {
  const fs = require('fs');
  const vendors = fs.readFileSync(require.resolve('../api/vendors'), 'utf8');
  assert.ok(/staff_email_not_allowed/.test(vendors), 'vendor PATCH refuses staff emails');
  assert.ok(/vendorEmailOrNull\(vendor_email, vendor_name\)/.test(fs.readFileSync(require.resolve('../api/ap'), 'utf8')));
  assert.ok(/vendorEmailOrNull\(extracted\.vendor_email/.test(fs.readFileSync(require.resolve('../lib/ap/vendor_master'), 'utf8')));
});

(async () => {
  for (const { name, fn } of results) {
    try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); }
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall vendor email guard checks passed');
  process.exitCode = failed ? 1 : 0;
})();
