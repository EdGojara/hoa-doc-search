#!/usr/bin/env node
// ============================================================================
// tests/test_legal_review_data.js  (Issue #9 step 2, draft-only review)
// ----------------------------------------------------------------------------
// Locks the server side of a draft save:
//   lib/legal/review_data.js buildDraft():
//     - every invoice line with an amount is in exactly one item (no gaps, no
//       duplicates, no foreign lines); item amounts come from the lines, never
//       from the browser;
//     - a property must be in the invoice's community; a recoverable charge
//       needs one; a charge category survives only on a recoverable charge;
//     - evidence, tenure and the bankruptcy stop are recomputed on the server
//       (a staff-picked property is marked as such, confidence "none");
//     - service date source is derived, not trusted;
//   readOnlyReason(): leaving / prospect / not our books → view only;
//   api/legal_review.js POST /invoices/:id/draft:
//     - read-only → 409, migration not applied → 409, invalid → 400 with the
//       reasons, stale → 409 "stale", success → 200 with a fresh payload;
//     - the save goes through the one RPC and nothing else is written.
// Offline: Supabase and the auth gate are stubbed.
// ============================================================================
const assert = require('assert');
const Module = require('module');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://x';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';

let pass = 0;
const results = [];
function t(name, fn) { results.push([name, fn]); }

// ---- a loaded invoice (shape of review_data.loadInvoice) -------------------------
const P1 = '00000000-0000-4000-8000-000000000101', P2 = '00000000-0000-4000-8000-000000000102', PX = '00000000-0000-4000-8000-000000000199';
const L1 = '00000000-0000-4000-8000-000000000201', L2 = '00000000-0000-4000-8000-000000000202', L3 = '00000000-0000-4000-8000-000000000203';
const INV = '00000000-0000-4000-8000-0000000000e1';
function loaded(over) {
  return Object.assign({
    invoice: { id: INV, invoice_date: '2026-08-31', total_cents: 10000, service_period_start: null, service_period_end: null, community_id: 'c1' },
    community: { id: 'c1', name: 'Sample HOA', management_status: 'active', books_of_record: 'trusted', financials_active: true },
    lines: [
      { id: L1, line_number: 1, description: 'Testerly, Marigold - 4101 Sample Meadow Dr. - Fees - collection demand', amount_cents: 6000 },
      { id: L2, line_number: 2, description: 'Testerly, Marigold - 4101 Sample Meadow Dr. - Expenses', amount_cents: 1000 },
      { id: L3, line_number: 3, description: 'Reviewed Chapter 13 plan for 4202 Example Hollow Ct', amount_cents: 3000 },
    ],
    ctx: {
      properties: [
        { id: P1, street_address: '4101 Sample Meadow Dr', normalized_address: '4101 sample meadow drive' },
        { id: P2, street_address: '4202 Example Hollow Ct', normalized_address: '4202 example hollow court' },
      ],
      tenures: [
        { id: 't1', property_id: P1, kind: 'owner', start_date: '2026-05-26', end_date: null, origin: 'backfill_current' },
        { id: 't2', property_id: P2, kind: 'owner', start_date: '2026-05-26', end_date: null, origin: 'backfill_current' },
      ],
      owners: [{ property_id: P1, tenure_id: 't1', name: 'Marigold Testerly' }],
      bankruptcyPropertyIds: [], legalStates: {},
    },
    saved: null, schemaReady: true, readOnly: null,
  }, over || {});
}
const goodBody = () => ({ base_revision: 0, items: [
  { source_line_ids: [L1, L2], allocations: [{ amount_cents: 7000, classification: 'homeowner_recoverable', property_id: P1, charge_category: 'attorney_fee' }] },
  { source_line_ids: [L3], allocations: [{ amount_cents: 3000, classification: 'needs_review', property_id: P2 }] },
] });

const R = require('../lib/legal/review_data');

t('buildDraft: a complete draft validates; item amounts come from the lines', () => {
  const b = goodBody(); b.items[0].amount_cents = 1;   // browser-sent amount is ignored
  const r = R.buildDraft(loaded(), b);
  assert.ok(!r.errors, JSON.stringify(r.errors));
  assert.strictEqual(r.items[0].amount_cents, 7000);
  assert.strictEqual(r.reconciliation.reconciled, true);
});

t('buildDraft: server recomputes evidence + tenure; text match is "suggested", high confidence', () => {
  const a = R.buildDraft(loaded(), goodBody()).items[0].allocations[0];
  assert.strictEqual(a.suggested, true);
  assert.strictEqual(a.tenure_match, 'current');
  assert.strictEqual(a.tenure_id, 't1');
  assert.strictEqual(a.confidence, 'high');
  assert.ok(a.evidence.some((e) => e.kind === 'address'));
});

t('buildDraft: bankruptcy in the text sets the stop even though the browser did not', () => {
  const a = R.buildDraft(loaded(), goodBody()).items[1].allocations[0];
  assert.strictEqual(a.bankruptcy_stop, true);
});

t('buildDraft: a staff-picked property is marked staff, confidence none, with the override noted', () => {
  const b = goodBody(); b.items[0].allocations[0].property_id = P2;
  const a = R.buildDraft(loaded(), b).items[0].allocations[0];
  assert.strictEqual(a.suggested, false);
  assert.strictEqual(a.confidence, 'none');
  assert.ok(a.evidence.some((e) => e.kind === 'staff_selected'));
  assert.ok(a.evidence.some((e) => e.kind === 'staff_override'));
});

t('buildDraft: a missing line, a duplicated line and a foreign line are all refused', () => {
  const miss = goodBody(); miss.items.pop();
  assert.ok(R.buildDraft(loaded(), miss).errors.some((e) => /line 3 is not in any item/.test(e)));
  const dup = goodBody(); dup.items[1].source_line_ids.push(L1);
  assert.ok(R.buildDraft(loaded(), dup).errors.some((e) => /already in item 1/.test(e)));
  const foreign = goodBody(); foreign.items[1].source_line_ids = [L3, '00000000-0000-4000-8000-000000000999'];
  assert.ok(R.buildDraft(loaded(), foreign).errors.some((e) => /not on this invoice/.test(e)));
});

t('buildDraft: a property outside the community is refused; recoverable needs a property', () => {
  const b = goodBody(); b.items[0].allocations[0].property_id = PX;
  const errs = R.buildDraft(loaded(), b).errors;
  assert.ok(errs.some((e) => /not in this community/.test(e)));
  assert.ok(errs.some((e) => /needs a property/.test(e)));
});

t('buildDraft: zero / fractional amounts and unknown values are refused', () => {
  const b = goodBody();
  b.items[0].allocations[0].amount_cents = 0;
  b.items[1].allocations[0].amount_cents = 12.5;
  b.items[1].allocations[0].classification = 'write_off';
  const errs = R.buildDraft(loaded(), b).errors;
  assert.ok(errs.filter((e) => /non-zero whole number/.test(e)).length === 2);
  assert.ok(errs.some((e) => /unknown classification/.test(e)));
});

t('buildDraft: a charge category is dropped from anything not recoverable', () => {
  const b = goodBody(); b.items[1].allocations[0].charge_category = 'attorney_fee';
  assert.strictEqual(R.buildDraft(loaded(), b).items[1].allocations[0].charge_category, null);
});

t('buildDraft: service basis is derived on the server (invoice point / staff / none), bad dates refused', () => {
  const d = loaded(); d.invoice.service_period_start = '2026-08-15'; d.invoice.service_period_end = '2026-08-15';
  const b = goodBody(); b.items[0].service_date = '2026-08-15'; b.items[1].service_date = '2026-07-01';
  const r = R.buildDraft(d, b);
  assert.strictEqual(r.items[0].service_date_source, 'invoice_service_period');
  assert.strictEqual(r.items[1].service_date_source, 'staff');
  const bad = goodBody(); bad.items[0].service_date = '08/15/2026';
  assert.ok(R.buildDraft(loaded(), bad).errors.some((e) => /not a date/.test(e)));
  assert.strictEqual(R.buildDraft(loaded(), goodBody()).items[0].service_date_source, 'none');
});

t('buildDraft: an invoice service RANGE is kept as a range; a staff date overrides it; line-text date wins', () => {
  const d = loaded(); d.invoice.service_period_start = '2026-08-01'; d.invoice.service_period_end = '2026-08-31';
  const b = goodBody(); b.items[1].service_date = '2026-08-20';
  const r = R.buildDraft(d, b);
  assert.deepStrictEqual([r.items[0].service_date, r.items[0].service_period_start, r.items[0].service_period_end, r.items[0].service_date_source], [null, '2026-08-01', '2026-08-31', 'invoice_service_period']);
  assert.deepStrictEqual([r.items[1].service_date, r.items[1].service_period_start, r.items[1].service_date_source], ['2026-08-20', null, 'staff']);
  assert.ok(r.items[0].allocations[0].evidence.some((e) => e.kind === 'service_basis' && /2026-08-01 to 2026-08-31/.test(e.value)));
  const d2 = loaded(); d2.lines[2].description += ' - order entered 8/12/2026';
  assert.deepStrictEqual([R.buildDraft(d2, goodBody()).items[1].service_date, R.buildDraft(d2, goodBody()).items[1].service_date_source], ['2026-08-12', 'line_text']);
});

t('buildDraft: an allocation split that does not balance is saved but blocks approval', () => {
  const b = goodBody(); b.items[0].allocations[0].amount_cents = 6900;
  const r = R.buildDraft(loaded(), b);
  assert.ok(!r.errors);
  assert.strictEqual(r.reconciliation.reconciled, false);
  assert.strictEqual(r.reconciliation.ready_for_approval, false);
});

t('buildDraft: empty / malformed bodies are refused cleanly', () => {
  assert.ok(R.buildDraft(loaded(), null).errors.length);
  assert.ok(R.buildDraft(loaded(), { items: [] }).errors.length);
  assert.ok(R.buildDraft(loaded(), { items: [{}] }).errors.length);
});

t('readOnlyReason: leaving, prospect, financials off and non-trustEd books are view only', () => {
  assert.strictEqual(R.readOnlyReason({ management_status: 'active', books_of_record: 'trusted', financials_active: true }), null);
  assert.ok(/Leaving/.test(R.readOnlyReason({ management_status: 'terminating', management_end_date: '2026-10-31' })));
  assert.ok(/Prospect/.test(R.readOnlyReason({ management_status: 'prospect' })));
  assert.ok(/books/.test(R.readOnlyReason({ management_status: 'active', financials_active: false })));
  assert.ok(/Vantaca/.test(R.readOnlyReason({ management_status: 'active', books_of_record: 'vantaca' })));
});

t('detailPayload: suggestions reconcile and carry property labels + owner names', () => {
  const p = R.detailPayload(loaded());
  assert.strictEqual(p.suggestion.reconciliation.reconciled, true);
  const a = p.suggestion.items[0].allocations[0];
  assert.strictEqual(a.property_label, '4101 Sample Meadow Dr');
  assert.deepStrictEqual(a.owner_names, ['Marigold Testerly']);
  assert.strictEqual(p.draft, null);
  assert.strictEqual(p.revision, 0);
});

// ---- API: POST /invoices/:id/draft with stubs ------------------------------------
async function apiTests() {
  const writes = [];
  let rpcResult = { data: { ok: true, review_id: 'r1', revision: 1 }, error: null };
  let current = loaded();
  let readResult = { extraction_id: 'ext-1', status: 'valid', reused: false }; const readCalls = [];
  const stubR = Object.assign({}, R, { loadInvoice: async () => current, legalVendors: async () => ({ vendors: [], flag_ready: true }),
    readInvoicePdf: async (sb, d, actor, opts) => { readCalls.push({ actor, force: opts.force }); return readResult; } });
  const fakeSb = { rpc: async (name, args) => { writes.push({ name, args }); return rpcResult; }, from: (tbl) => { writes.push({ from: tbl }); throw new Error('no direct table access expected'); } };
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === '@supabase/supabase-js') return { createClient: () => fakeSb };
    if (req === './_require_admin') return { requireStaff: async () => ({ email: 'staff@example.test', role: 'staff' }) };
    if (req === '../lib/legal/review_data') return stubR;
    return origLoad.apply(this, arguments);
  };
  const express = require('express');
  const app = express();
  app.use('/api/legal-review', require('../api/legal_review'));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api/legal-review/invoices/${INV}/draft`;
  const post = async (body) => { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    const run = async (name, fn) => { try { await fn(); pass += 1; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; } };
    await run('api: base_revision is required', async () => { assert.strictEqual((await post({ items: [] })).status, 400); });
    await run('api: read-only community → 409, nothing written', async () => {
      current = loaded({ readOnly: 'Leaving Bedrock: view only.' }); writes.length = 0;
      const r = await post(goodBody());
      assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'read_only'); assert.strictEqual(writes.length, 0);
    });
    await run('api: migration not applied → 409 migration_pending, nothing written', async () => {
      current = loaded({ schemaReady: false }); writes.length = 0;
      const r = await post(goodBody());
      assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'migration_pending'); assert.strictEqual(writes.length, 0);
    });
    await run('api: invalid draft → 400 with reasons, nothing written', async () => {
      current = loaded(); writes.length = 0;
      const b = goodBody(); b.items.pop();
      const r = await post(b);
      assert.strictEqual(r.status, 400); assert.ok(r.body.errors.some((e) => /not in any item/.test(e))); assert.strictEqual(writes.length, 0);
    });
    await run('api: stale revision → 409 stale', async () => {
      current = loaded(); rpcResult = { data: { ok: false, error: 'stale', revision: 3 }, error: null };
      const r = await post(goodBody());
      assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'stale'); assert.strictEqual(r.body.revision, 3);
    });
    await run('api: success → one RPC with server-built items, actor from the session, fresh payload back', async () => {
      current = loaded(); writes.length = 0; rpcResult = { data: { ok: true, review_id: 'r1', revision: 1 }, error: null };
      const r = await post(goodBody());
      assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.saved, true);
      assert.strictEqual(writes.length, 1); assert.strictEqual(writes[0].name, 'legal_review_save_draft');
      const a = writes[0].args;
      assert.strictEqual(a.p_actor, 'staff@example.test'); assert.strictEqual(a.p_base_revision, 0); assert.strictEqual(a.p_community_id, 'c1');
      assert.strictEqual(a.p_items[1].allocations[0].bankruptcy_stop, true);
      assert.strictEqual(a.p_summary.items, 2);
    });
    const readUrl = url.replace(/\/draft$/, '/read-pdf');
    const postRead = async (body) => { const r = await fetch(readUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
    await run('api read-pdf: view-only community → 409, reader not called', async () => {
      current = loaded({ readOnly: 'Leaving Bedrock: view only.' }); readCalls.length = 0;
      const r = await postRead({}); assert.strictEqual(r.status, 409); assert.strictEqual(readCalls.length, 0);
    });
    await run('api read-pdf: success → the session actor, force passed through, fresh payload with the read result', async () => {
      current = loaded(); readCalls.length = 0; readResult = { extraction_id: 'ext-1', status: 'valid', reused: false };
      const r = await postRead({ force: true });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.deepStrictEqual(readCalls, [{ actor: 'staff@example.test', force: true }]);
      assert.strictEqual(r.body.read.extraction_id, 'ext-1'); assert.ok(r.body.suggestion);
    });
    await run('api read-pdf: migration not applied → 409 migration_pending', async () => {
      current = loaded(); readResult = { http: 409, error: 'migration_pending', detail: 'x' };
      const r = await postRead({}); assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'migration_pending');
    });
    await run('api: an RPC error → 500 with a safe message', async () => {
      current = loaded(); rpcResult = { data: null, error: { message: 'legal_review_property_not_in_community' } };
      assert.strictEqual((await post(goodBody())).status, 500);
    });
  } finally { server.close(); Module._load = origLoad; }
}

(async () => {
  console.log('test_legal_review_data');
  for (const [name, fn] of results) { try { fn(); pass += 1; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; } }
  await apiTests();
  console.log(`\n${pass} passed${process.exitCode ? ', FAILURES above' : ''}`);
})();
