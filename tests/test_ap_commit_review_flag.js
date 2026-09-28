// tests/test_ap_commit_review_flag.js — the invoice review flag is sticky (ChatGPT
// review of 4802839b, Issue #3). Runs the REAL commitInvoice against an in-memory
// Supabase fake injected before lib/ap/intake.js loads, and checks the PERSISTED
// ap_invoices.needs_review against the value commitInvoice returns.
require('dotenv').config({ quiet: true });
const assert = require('assert');
const Module = require('module');

// ---- in-memory fake: records inserts/updates; unknown reads come back empty ----
const db = { ap_invoices: [], ap_invoice_lines: [], updates: [] };
function fakeClient() {
  return {
    from(table) {
      const st = { table, filters: [], op: 'select', payload: null };
      const rows = () => (db[table] || []).filter((r) => st.filters.every(([c, v]) => r[c] === v));
      const q = {
        select() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; },
        eq(c, v) { st.filters.push([c, v]); return q; }, neq() { return q; }, in() { return q; }, is() { return q; },
        ilike() { return q; }, or() { return q; }, not() { return q; }, gte() { return q; }, lte() { return q; }, lt() { return q; }, gt() { return q; },
        insert(p) {
          st.op = 'insert';
          const list = (Array.isArray(p) ? p : [p]).map((r, i) => ({ id: `${table}-${(db[table] || []).length + i + 1}`, ...r }));
          if (!db[table]) db[table] = [];
          db[table].push(...list);
          st.inserted = list;
          return q;
        },
        update(p) { st.op = 'update'; st.payload = p; return q; },
        async single() { return { data: st.inserted ? st.inserted[0] : (rows()[0] || null), error: null }; },
        async maybeSingle() { return { data: st.op === 'insert' ? st.inserted[0] : (rows()[0] || null), error: null }; },
        then(res, rej) {
          if (st.op === 'update') {
            for (const r of rows()) Object.assign(r, st.payload);
            db.updates.push({ table, filters: st.filters, payload: st.payload });
            return Promise.resolve({ data: null, error: null }).then(res, rej);
          }
          if (st.op === 'insert') return Promise.resolve({ data: st.inserted, error: null }).then(res, rej);
          return Promise.resolve({ data: rows(), error: null }).then(res, rej);
        },
      };
      return q;
    },
    storage: { from() { return { upload: async () => ({ error: null }), download: async () => ({ data: null, error: null }) }; } },
  };
}
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') return { createClient: () => fakeClient() };
  return realLoad.apply(this, arguments);
};
const { commitInvoice, mergedNeedsReview, lineClassificationReason } = require('../lib/ap/intake');
Module._load = realLoad;

let failed = 0;
const results = [];
const t = (name, fn) => results.push({ name, fn });
const GL = { account_id: 'a5900', account_number: '5900', account_name: 'Community Events' };
const reimbExtracted = () => ({
  invoice_date: '2026-05-25', total_cents: 3572, subtotal_cents: 3572, tax_cents: 0, vendor_name: 'Walmart',
  line_items: [{ description: 'Walmart: reimbursed purchase', quantity: 1, unit_price_cents: 3572, amount_cents: 3572 }],
});
const persisted = (id) => db.ap_invoices.find((r) => r.id === id);

t('forceReview (new reimbursement payee) + successful staff-directed line coding: persisted invoice stays needs_review=true', async () => {
  const out = await commitInvoice({ extracted: reimbExtracted(), vendorId: 'payee-1', communityId: 'c-lopf', sha256: 'sha-a', storagePath: 'p.pdf',
    intakeMethod: 'email', sourceRef: 'email:a', staffGl: GL, reimbursementSource: 'Walmart', forceReview: true, extraNotes: 'test' });
  assert.strictEqual(out.outcome, 'loaded');
  const inv = persisted(out.invoice_id);
  assert.strictEqual(inv.needs_review, true, 'persisted flag must survive line coding');
  assert.strictEqual(out.needs_review, inv.needs_review, 'returned and persisted must agree');
  const lines = db.ap_invoice_lines.filter((l) => l.invoice_id === out.invoice_id);
  assert.deepStrictEqual(lines.map((l) => [l.amount_cents, l.gl_account_id]), [[3572, 'a5900']]);   // the line now exists
  assert.match(inv.classification_reason, /^Staff-directed: code 5900 Community Events: all 1 line\(s\) coded per the staff instruction\.$/);
});

t('a clean staff-directed vendor invoice may remain needs_review=false (and returned == persisted)', async () => {
  const out = await commitInvoice({ extracted: { invoice_date: '2026-09-01', total_cents: 12050, invoice_number: 'INV-1', vendor_name: 'Water Logic', line_items: [{ description: 'Irrigation repair', amount: 120.5 }] },
    vendorId: 'v-clean', communityId: 'c-lopf', sha256: 'sha-b', storagePath: 'q.pdf', intakeMethod: 'email', sourceRef: 'email:b', staffGl: GL });
  const inv = persisted(out.invoice_id);
  assert.strictEqual(inv.needs_review, false);
  assert.strictEqual(out.needs_review, false);
});

t('line-level review elevates false -> true, never true -> false', () => {
  assert.strictEqual(mergedNeedsReview(false, [{ needs_review: false }, { needs_review: true }]), true);
  assert.strictEqual(mergedNeedsReview(true, [{ needs_review: false }]), true);
  assert.strictEqual(mergedNeedsReview(true, []), true);
  assert.strictEqual(mergedNeedsReview(false, [{}, { needs_review: false }]), false);
});

t('returned needs_review is the persisted value (source contract)', () => {
  const src = require('fs').readFileSync(require.resolve('../lib/ap/intake'), 'utf8');
  assert.ok(/needs_review: merged,/.test(src));
  assert.ok(/needs_review: finalNeedsReview,/.test(src));
  assert.ok(!/needs_review: codedLines\.some\(\(l\) => l\.needs_review\)/.test(src), 'the old overwrite must be gone');
});

t('provenance: staff-directed lines are labeled staff-directed; classifier lines keep the line-by-line wording', () => {
  assert.match(lineClassificationReason([{ gl_account_id: 'a', reason: 'Staff-directed: code 5900 Community Events' }]), /^Staff-directed: code 5900/);
  assert.match(lineClassificationReason([{ gl_account_id: 'a', reason: 'history' }, { gl_account_id: 'b', reason: null }]), /^Coded line by line from the invoice: 2 line\(s\) across 2 account\(s\)\.$/);
});

(async () => {
  for (const { name, fn } of results) {
    try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.stack.split('\n').slice(0, 3).join('\n   ')); }
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall AP commit review-flag checks passed');
  process.exitCode = failed ? 1 : 0;
})();
