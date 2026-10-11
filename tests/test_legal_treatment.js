// ============================================================================
// tests/test_legal_treatment.js  (Ed 2026-10-11, migration 508)
// ----------------------------------------------------------------------------
// Approve Treatment: the accounting a reviewed attorney invoice produces, and
// the controls around it. Deterministic: an in-memory Supabase stand-in (with
// the 508 RPCs modelled) and injected GL / owner-ledger posters.
//
//   - a homeowner chargeback is Dr 1300 (property) / Cr the invoice line's
//     accrued expense account. AP is never credited again.
//   - association expense posts nothing; Bedrock needs a receivable account
//     and written evidence. Treatment reconciles to the invoice to the cent.
//   - posting date: never before the accrual or cutover, never into a closed
//     month; no open period blocks before anything is locked.
//   - the owner reviewed must still own the property, at plan and at posting.
//   - approval + claims are atomic; each claim is worked under a lease, so a
//     second run, a concurrent run or a crash-resume never posts twice; a
//     failed lookup never reads as "nothing written".
//   - corrections: reverse (idempotent), cancel a stuck pending claim
//     (reversing what it wrote), reopen only when nothing is live.
//   - a former client's invoices never reach routine payment.
// ============================================================================
const assert = require('assert');
const T = require('../lib/legal/treatment');
const FC = require('../lib/ap/former_client');

let pass = 0, fail = 0;
const pending = [];
function t(name, fn) { pending.push([name, fn]); }

// ---- in-memory Supabase ----------------------------------------------------
function fakeDb(seed) {
  const db = { tables: JSON.parse(JSON.stringify(seed)), seq: 0, missing: new Set(), failSelect: null };
  const id = (p) => `${p}-${++db.seq}`;
  const get = (row, k) => {
    const m = /^(\w+)->>(\w+)$/.exec(k);
    if (m) return row[m[1]] && row[m[1]][m[2]] != null ? String(row[m[1]][m[2]]) : null;
    return row[k];
  };
  const rowsOf = (t) => (db.tables[t] = db.tables[t] || []);
  db.from = (table) => {
    const st = { op: 'select', filters: [], payload: null, one: false, maybe: false, head: false, returning: false };
    const match = (r) => st.filters.every((f) => f(r));
    const b = {
      select(_c, o) { if (o && o.head) st.head = true; if (st.op !== 'select') st.returning = true; return b; },
      insert(p) { st.op = 'insert'; st.payload = p; return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; },
      eq(k, v) { st.filters.push((r) => get(r, k) === v || (typeof v !== 'string' && get(r, k) == v)); return b; },
      is(k, v) { st.filters.push((r) => (get(r, k) == null) === (v === null)); return b; },
      in(k, vs) { st.filters.push((r) => vs.includes(get(r, k))); return b; },
      like(k, p) { const pre = p.replace(/%$/, ''); st.filters.push((r) => String(get(r, k) || '').startsWith(pre)); return b; },
      order() { return b; }, limit() { return b; },
      single() { st.one = true; return b; }, maybeSingle() { st.maybe = true; return b; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      if (db.missing.has(table)) return { data: null, error: { code: 'PGRST205', message: `Could not find the table ${table} in the schema cache` } };
      if (st.op === 'select' && db.failSelect && db.failSelect(table)) return { data: null, error: { message: 'statement timeout' } };
      if (st.op === 'insert') {
        const row = Object.assign({ id: id(table), created_at: new Date(Date.now() + db.seq).toISOString() }, st.payload);
        rowsOf(table).push(row);
        return { data: st.one || st.maybe ? row : [row], error: null };
      }
      if (st.op === 'update') {
        const hit = rowsOf(table).filter(match);
        hit.forEach((r) => Object.assign(r, st.payload));
        return { data: st.returning ? hit : null, error: null };
      }
      const hit = rowsOf(table).filter(match);
      if (st.head) return { data: null, count: hit.length, error: null };
      if (st.one) return hit.length === 1 ? { data: hit[0], error: null } : { data: null, error: { message: 'not single' } };
      if (st.maybe) return { data: hit[0] || null, error: null };
      return { data: hit, error: null };
    }
    return b;
  };
  // The 508 functions, modelled.
  db.rpc = async (fn, a) => {
    const reviews = rowsOf('legal_invoice_reviews');
    const postings = rowsOf('legal_invoice_postings');
    if (fn === 'legal_review_approve') {
      const r = reviews.find((x) => x.ap_invoice_id === a.p_ap_invoice_id);
      if (!r) return { data: { ok: false, error: 'no_review' }, error: null };
      if (r.revision !== a.p_base_revision) return { data: { ok: false, error: 'stale', revision: r.revision }, error: null };
      if (r.status === 'approved') return { data: { ok: true, already: true, review_id: r.id, revision: r.revision }, error: null };
      // atomic: validate every claim before writing any
      for (const p of a.p_postings) if (postings.some((x) => x.allocation_id === p.allocation_id && ['pending', 'posted'].includes(x.status))) return { data: null, error: { code: '23505', message: 'duplicate live allocation' } };
      Object.assign(r, { status: 'approved', approved_revision: r.revision, approved_by: a.p_actor, approved_at: new Date().toISOString() });
      for (const p of a.p_postings) postings.push(Object.assign({ id: id('post'), review_id: r.id, ap_invoice_id: a.p_ap_invoice_id, community_id: r.community_id, review_revision: r.revision, status: 'pending', claim_token: null, claimed_at: null, created_at: new Date().toISOString() }, p));
      rowsOf('legal_invoice_review_events').push({ review_id: r.id, action: 'treatment_approved', actor: a.p_actor, summary: a.p_summary });
      return { data: { ok: true, review_id: r.id, revision: r.revision }, error: null };
    }
    if (fn === 'legal_posting_claim') {
      const p = postings.find((x) => x.id === a.p_posting_id && x.status === a.p_from_status);
      const stale = (x) => !x.claimed_at || Date.parse(x.claimed_at) < Date.now() - 10 * 60 * 1000;
      if (!p || !(stale(p) || p.claim_token === a.p_token)) return { data: false, error: null };
      Object.assign(p, { claim_token: a.p_token, claimed_at: new Date().toISOString() });
      return { data: true, error: null };
    }
    if (fn === 'legal_review_reopen') {
      const r = reviews.find((x) => x.ap_invoice_id === a.p_ap_invoice_id);
      if (!a.p_reason || a.p_reason.trim().length < 5) return { data: null, error: { message: 'legal_review_reason_required' } };
      if (postings.some((p) => p.review_id === r.id && ['pending', 'posted'].includes(p.status))) return { data: { ok: false, error: 'live_postings' }, error: null };
      Object.assign(r, { status: 'draft', approved_revision: null, approved_by: null, approved_at: null });
      rowsOf('legal_invoice_review_events').push({ review_id: r.id, action: 'review_reopened', actor: a.p_actor, summary: { reason: a.p_reason } });
      return { data: { ok: true }, error: null };
    }
    throw new Error('unexpected rpc ' + fn);
  };
  return db;
}

// ---- a Canyon Gate-shaped invoice: AP lines coded to 5870 / 5860 ------------
const CG = 'cg', INV = 'inv-280595', LINE = 'line-1', REV = 'rev-1';
const CONFIRMED = { kind: 'staff_confirmed', value: 'confirmed by staff' };
const OPEN = { closedThrough: async () => null, openPeriod: async () => ({ id: 'per' }) };
const seed = () => ({
  chart_of_accounts: [
    { id: 'a1300', community_id: CG, account_number: '1300', account_name: 'Accounts Receivable', is_active: true },
    { id: 'a1375', community_id: CG, account_number: '1375', account_name: 'Due from prior management co', is_active: true },
    { id: 'a5870', community_id: CG, account_number: '5870', account_name: 'Legal Fees - Collections/DRV', is_active: true },
    { id: 'a5860', community_id: CG, account_number: '5860', account_name: 'Legal Fees - Corporate', is_active: true },
    { id: 'a2000', community_id: CG, account_number: '2000', account_name: 'Accounts Payable', is_active: true },
  ],
  communities: [{ id: CG, gl_cutover_date: '2026-08-01' }],
  ap_invoices: [{ id: INV, community_id: CG, posting_journal_entry_id: 'je-accrual' }],
  ap_invoice_lines: [{ id: LINE, invoice_id: INV, gl_account_id: 'a5870' }, { id: 'line-2', invoice_id: INV, gl_account_id: 'a5860' }],
  journal_entries: [{ id: 'je-accrual', posting_date: '2026-08-31', status: 'posted', reference: 'AP-280595' }],
  ownership_tenures: ['p-clear', 'p-glen', 'p-a', 'p-b'].map((p) => ({ id: 'ten-' + p, property_id: p, kind: 'owner', end_date: null })),
  legal_invoice_reviews: [{ id: REV, ap_invoice_id: INV, community_id: CG, status: 'draft', revision: 3 }],
  legal_invoice_allocations: [],
  legal_invoice_review_events: [],
  legal_invoice_postings: [],
  homeowner_transactions: [],
});
const owner = (amount, pid, extra) => Object.assign({ id: 'al-' + pid, amount_cents: amount, classification: 'homeowner_recoverable', property_id: pid, tenure_id: 'ten-' + pid,
  tenure_match: 'current', confidence: 'high', charge_category: 'attorney_fee', bankruptcy_stop: false, suggested: true, evidence: [], note: null }, extra || {});
const assoc = (amount, extra) => Object.assign({ id: 'al-assoc-' + amount, amount_cents: amount, classification: 'association_legal_expense', property_id: null,
  tenure_match: 'not_applicable', confidence: 'none', charge_category: null, bankruptcy_stop: false, suggested: false, evidence: [CONFIRMED], note: null }, extra || {});
function invoice(items, over) {
  const total = items.reduce((s, it) => s + it.amount_cents, 0);
  return Object.assign({
    invoice: { id: INV, community_id: CG, vendor: 'Daughtry & Farine, P.C.', invoice_number: '280595', invoice_date: '2026-08-31', total_cents: total, accrued: true },
    invoiceNumber: '280595',
    lines: [{ id: LINE, line_number: 1, description: 'Legal services', amount_cents: items.filter((i) => i.source_line_ids[0] === LINE).reduce((s, i) => s + i.amount_cents, 0) },
      { id: 'line-2', line_number: 2, description: 'Corporate', amount_cents: items.filter((i) => i.source_line_ids[0] === 'line-2').reduce((s, i) => s + i.amount_cents, 0) }].filter((l) => l.amount_cents),
    saved: { review: { id: REV, revision: 3, status: 'draft' }, items },
    readOnly: null, extraction: null, extractionUse: { ok: false },
  }, over || {});
}
const item = (id, lineId, allocs) => ({ id, source_line_ids: [lineId], source_text: null, matter_ref: id, amount_cents: allocs.reduce((s, a) => s + a.amount_cents, 0), allocations: allocs });
const twoOwnersOneGeneral = () => invoice([item('it-1', LINE, [owner(141416, 'p-clear'), owner(105830, 'p-glen'), assoc(19027)])]);
// allocations live in the DB too (the approve RPC and postClaim read them)
function withAllocs(db, d) {
  for (const it of d.saved.items) for (const a of it.allocations) db.tables.legal_invoice_allocations.push(Object.assign({ item_id: it.id, review_id: REV, revision: 3, is_active: true, legal_invoice_items: { matter_ref: it.matter_ref } }, a));
  return d;
}

function posters(db, { failChargeOnce } = {}) {
  const calls = { je: [], charge: [], void: [], credit: [] };
  let failed = false;
  return {
    calls,
    deps: {
      periods: OPEN,
      postJE: async (o) => { calls.je.push(o); const e = { id: 'je-' + calls.je.length, source_module: o.source_module, source_reference: o.source_reference, status: 'posted' }; db.tables.journal_entries.push(e); return { entry: e }; },
      postCharge: async (_s, o) => {
        if (failChargeOnce && !failed) { failed = true; throw new Error('network blip'); }
        calls.charge.push(o); const row = { id: 'ht-' + calls.charge.length, community_id: o.communityId, txn_type: 'charge', raw_row_jsonb: o.raw };
        db.tables.homeowner_transactions.push(row); return { chargeId: row.id };
      },
      voidJE: async (o) => { calls.void.push(o); const je = db.tables.journal_entries.find((j) => j.id === o.journal_entry_id); je.status = 'voided'; const r = { id: 'rev-' + je.id, reverses_je_id: je.id, status: 'posted' }; db.tables.journal_entries.push(r); return { reversal_entry: r }; },
      postCredit: async (_s, o) => { calls.credit.push(o); const row = { id: 'ht-cr-' + calls.credit.length, community_id: o.communityId, txn_type: 'adjustment', raw_row_jsonb: o.raw }; db.tables.homeowner_transactions.push(row); return { chargeId: row.id }; },
    },
  };
}
const approve = (db, d, P, extra) => T.approveTreatment(db, d, Object.assign({ actor: 'owner@example.test', baseRevision: 3, deps: P.deps }, extra || {}));

// ---- plan ------------------------------------------------------------------
t('plan: owner-specific lines bill back Dr 1300 / Cr the accrued 5870; the general matter posts nothing', async () => {
  const db = fakeDb(seed());
  const p = await T.planTreatment(db, twoOwnersOneGeneral(), { periods: OPEN });
  assert.ok(p.ready, p.blocking.join('; '));
  assert.strictEqual(p.postings.length, 2);
  p.postings.forEach((x) => { assert.strictEqual(x.debit_account_id, 'a1300'); assert.strictEqual(x.credit_account_id, 'a5870'); assert.notStrictEqual(x.credit_account_id, 'a2000'); });
  assert.deepStrictEqual(p.totals, { homeowner_cents: 247246, association_cents: 19027, bedrock_cents: 0 });
  assert.strictEqual(p.totals.homeowner_cents + p.totals.association_cents + p.totals.bedrock_cents, p.invoice_total_cents);
  assert.strictEqual(p.posting_date, '2026-08-31', 'defaults to the accrual date');
});
t('plan: a pre-cutover accrual (neutralized and re-posted at conversion) posts at the cutover, never before', async () => {
  const db = fakeDb(seed()); db.tables.journal_entries[0].posting_date = '2026-07-13';
  const p = await T.planTreatment(db, twoOwnersOneGeneral(), { periods: OPEN });
  assert.strictEqual(p.posting_date, '2026-08-01');
  const early = await T.planTreatment(db, twoOwnersOneGeneral(), { postingDate: '2026-07-20', periods: OPEN });
  assert.ok(!early.ready && early.blocking.some((b) => /cannot be before 2026-08-01/.test(b)));
});
t('plan: books closed through August → the default moves to Sep 1; an explicit closed date or no open period blocks', async () => {
  const db = fakeDb(seed());
  const closedAug = { closedThrough: async () => '2026-08-31', openPeriod: async () => ({ id: 'per' }) };
  const p = await T.planTreatment(db, twoOwnersOneGeneral(), { periods: closedAug });
  assert.ok(p.ready, p.blocking.join('; ')); assert.strictEqual(p.posting_date, '2026-09-01');
  assert.ok(p.postings.every((x) => x.posting_date === '2026-09-01'));
  const explicit = await T.planTreatment(db, twoOwnersOneGeneral(), { postingDate: '2026-08-31', periods: closedAug });
  assert.ok(!explicit.ready && explicit.blocking.some((b) => /closed through 2026-08-31/.test(b)));
  const none = await T.planTreatment(db, twoOwnersOneGeneral(), { periods: { closedThrough: async () => null, openPeriod: async () => null } });
  assert.ok(!none.ready && none.blocking.some((b) => /no open accounting period/.test(b)));
});
t('plan: a line coded to 5860 is credited back to 5860, line by line', async () => {
  const db = fakeDb(seed());
  const p = await T.planTreatment(db, invoice([item('it-1', LINE, [owner(10000, 'p-a')]), item('it-2', 'line-2', [owner(3200, 'p-b')])]), { periods: OPEN });
  assert.ok(p.ready, p.blocking.join('; '));
  assert.deepStrictEqual(p.postings.map((x) => x.credit_account_id), ['a5870', 'a5860']);
});
t('plan: the owner reviewed must still own the property (a sale since the draft blocks)', async () => {
  const db = fakeDb(seed());
  db.tables.ownership_tenures.find((x) => x.property_id === 'p-glen').end_date = '2026-09-15';
  db.tables.ownership_tenures.push({ id: 'ten-buyer', property_id: 'p-glen', kind: 'owner', end_date: null });
  const p = await T.planTreatment(db, twoOwnersOneGeneral(), { periods: OPEN });
  assert.ok(!p.ready && p.blocking.some((b) => /no longer the current owner/.test(b)));
});
t('plan: an unaccrued invoice, a former client, an exception or needs-review all block', async () => {
  const db = fakeDb(seed());
  const un = await T.planTreatment(db, invoice([item('it-1', LINE, [owner(1000, 'p-a')])], { invoice: Object.assign({}, twoOwnersOneGeneral().invoice, { total_cents: 1000, accrued: false }) }), { periods: OPEN });
  assert.ok(!un.ready && un.blocking.some((b) => /accrual/.test(b)));
  const ro = await T.planTreatment(db, invoice([item('it-1', LINE, [owner(1000, 'p-a')])], { readOnly: 'Leaving Bedrock (last day 2026-09-30): view only.' }), { periods: OPEN });
  assert.ok(!ro.ready && ro.blocking.some((b) => /Leaving Bedrock/.test(b)));
  const nr = await T.planTreatment(db, invoice([item('it-1', LINE, [assoc(1000, { classification: 'needs_review', evidence: [] })])]), { periods: OPEN });
  assert.ok(!nr.ready, 'uncertain recoverability is flagged, never defaulted to general');
  const former = await T.planTreatment(db, invoice([item('it-1', LINE, [owner(1000, 'p-a', { tenure_match: 'former' })])]), { periods: OPEN });
  assert.ok(!former.ready && former.blocking.some((b) => /owner at the time/.test(b)), 'ownership change blocks');
  const bk = await T.planTreatment(db, invoice([item('it-1', LINE, [owner(1000, 'p-a', { bankruptcy_stop: true, evidence: [CONFIRMED] })])]), { periods: OPEN });
  assert.ok(!bk.ready && bk.blocking.some((b) => /bankruptcy/.test(b)), 'bankruptcy stops a homeowner charge');
});
t('plan: bankruptcy work kept as association expense is approvable once confirmed', async () => {
  const db = fakeDb(seed());
  const p = await T.planTreatment(db, invoice([item('it-1', LINE, [assoc(58750, { bankruptcy_stop: true })])]), { periods: OPEN });
  assert.ok(p.ready, p.blocking.join('; ')); assert.strictEqual(p.postings.length, 0);
});
t('plan: a split that does not reconcile to the invoice blocks', async () => {
  const db = fakeDb(seed()); const d = twoOwnersOneGeneral(); d.invoice.total_cents += 1;
  const p = await T.planTreatment(db, d, { periods: OPEN });
  assert.ok(!p.ready && p.blocking.some((b) => /add up|invoice total/.test(b)));
});
t('plan: Bedrock responsibility refuses without a receivable-from-Bedrock account (never 1375 prior manager)', async () => {
  const db = fakeDb(seed());
  const bedrock = { id: 'al-b', amount_cents: 7000, classification: 'bedrock_corporate', property_id: null, tenure_match: 'not_applicable', confidence: 'none', charge_category: null, bankruptcy_stop: false, suggested: false, evidence: [], note: 'Resale certificate work is the manager’s cost under the management agreement' };
  const p = await T.planTreatment(db, invoice([item('it-1', LINE, [bedrock])]), { periods: OPEN });
  assert.ok(!p.ready && p.blocking.some((b) => /receivable-from-Bedrock/.test(b)));
  db.tables.chart_of_accounts.push({ id: 'a1390', community_id: CG, account_number: '1390', account_name: 'Due from Bedrock (management company)', is_active: true });
  const p2 = await T.planTreatment(db, invoice([item('it-1', LINE, [bedrock])]), { periods: OPEN });
  assert.ok(p2.ready, p2.blocking.join('; '));
  assert.strictEqual(p2.postings[0].debit_account_id, 'a1390'); assert.strictEqual(p2.totals.bedrock_cents, 7000);
});

// ---- approve + post ---------------------------------------------------------
t('approve: approval and every claim commit together; each owner posts once, linked to JE + owner charge + invoice line', async () => {
  const db = fakeDb(seed()); const d = withAllocs(db, twoOwnersOneGeneral()); const P = posters(db);
  const out = await approve(db, d, P);
  assert.ok(out.ok, JSON.stringify(out));
  assert.strictEqual(db.tables.legal_invoice_reviews[0].status, 'approved');
  assert.strictEqual(P.calls.je.length, 2); assert.strictEqual(P.calls.charge.length, 2);
  P.calls.je.forEach((j) => {
    assert.strictEqual(j.source_module, 'ap_billback');
    assert.ok(j.lines.every((l) => l.account_id !== 'a2000'), 'AP is never credited again');
    assert.strictEqual(j.lines[0].account_id, 'a1300'); assert.ok(j.lines[0].property_id);
    assert.strictEqual(j.lines[1].account_id, 'a5870');
  });
  const posts = db.tables.legal_invoice_postings;
  assert.ok(posts.every((p) => p.status === 'posted' && p.journal_entry_id && p.homeowner_transaction_id && p.ap_invoice_line_ids[0] === LINE && !p.claim_token));
  assert.ok(P.calls.charge.every((c) => c.raw.legal_posting_id && c.raw.ap_invoice_id === INV && /280595/.test(c.description) && c.chargeCategory === 'attorney_fee'));
  assert.strictEqual(db.tables.legal_invoice_review_events.filter((e) => e.action === 'posting_recorded').length, 2);
});
t('idempotent: approving again posts nothing new', async () => {
  const db = fakeDb(seed()); const d = withAllocs(db, twoOwnersOneGeneral()); const P = posters(db);
  await approve(db, d, P);
  const again = await approve(db, d, P);
  assert.ok(again.ok && again.already_approved && again.posted.length === 0);
  assert.strictEqual(P.calls.je.length, 2); assert.strictEqual(P.calls.charge.length, 2);
});
t('idempotent: a run that crashed after the JE resumes from the claim row, without a second JE', async () => {
  const db = fakeDb(seed()); const d = withAllocs(db, twoOwnersOneGeneral()); const P = posters(db, { failChargeOnce: true });
  await assert.rejects(approve(db, d, P), /network blip/);
  const stuck = db.tables.legal_invoice_postings.find((p) => p.status === 'pending' && p.claim_token);
  stuck.claimed_at = new Date(Date.now() - 11 * 60 * 1000).toISOString();   // the crashed request's lease has lapsed
  const out = await approve(db, d, P);
  assert.ok(out.ok);
  assert.strictEqual(P.calls.je.length, 2, 'the first allocation’s JE was found by source_reference, not reposted');
  assert.strictEqual(P.calls.charge.length, 2);
  assert.ok(db.tables.legal_invoice_postings.every((p) => p.status === 'posted'));
});
t('concurrency: a claim held by another live request is skipped, never posted twice', async () => {
  const db = fakeDb(seed()); const d = withAllocs(db, twoOwnersOneGeneral()); const P = posters(db);
  // first request approves; simulate it still working on every claim
  const realPost = P.deps.postJE; let held = true;
  P.deps.postJE = async (o) => { if (held) throw new Error('first request still working'); return realPost(o); };
  await assert.rejects(approve(db, d, P));
  db.tables.legal_invoice_postings.forEach((p) => { p.claim_token = 'other-request'; p.claimed_at = new Date().toISOString(); });
  held = false;
  const second = await approve(db, d, P);
  assert.ok(second.ok && second.posted.every((r) => r.in_progress), 'live leases are respected');
  assert.strictEqual(P.calls.je.length, 0);
});
t('a failed lookup throws instead of reading as "nothing written" (no double post on resume)', async () => {
  const db = fakeDb(seed()); const d = withAllocs(db, twoOwnersOneGeneral()); const P = posters(db);
  db.failSelect = (table) => table === 'journal_entries' && db.tables.legal_invoice_reviews[0].status === 'approved';
  await assert.rejects(approve(db, d, P), /bill-back entry lookup/);
  assert.strictEqual(P.calls.je.length, 0);
});
t('approve: a stale revision or a blocked plan posts nothing and locks nothing', async () => {
  const db = fakeDb(seed()); const d = withAllocs(db, twoOwnersOneGeneral()); const P = posters(db);
  const stale = await approve(db, d, P, { baseRevision: 2 });
  assert.strictEqual(stale.error, 'stale');
  const closed = await approve(db, d, Object.assign({}, P, { deps: Object.assign({}, P.deps, { periods: { closedThrough: async () => null, openPeriod: async () => null } }) }));
  assert.strictEqual(closed.error, 'not_ready', 'no open period blocks before the lock');
  assert.strictEqual(P.calls.je.length, 0); assert.strictEqual(db.tables.legal_invoice_reviews[0].status, 'draft');
  assert.strictEqual(db.tables.legal_invoice_postings.length, 0);
});
t('approve: before migration 508 it says so and posts nothing', async () => {
  const db = fakeDb(seed()); db.missing.add('legal_invoice_postings'); const P = posters(db);
  const out = await approve(db, twoOwnersOneGeneral(), P);
  assert.strictEqual(out.error, 'migration_pending'); assert.strictEqual(P.calls.je.length, 0);
});
t('a sale after approval stops the owner charge; cancel reverses the entry already posted and frees reopen', async () => {
  const db = fakeDb(seed()); const d = withAllocs(db, invoice([item('it-1', LINE, [owner(10000, 'p-a')])])); const P = posters(db);
  // the plan sees the reviewed owner as current; the sale lands between the entry and the owner charge
  const realPostJE = P.deps.postJE; let sold = false;
  P.deps.postJE = async (o) => { const r = await realPostJE(o); sold = true; db.tables.ownership_tenures.find((x) => x.id === 'ten-p-a').end_date = '2026-09-20'; db.tables.ownership_tenures.push({ id: 'ten-buyer', property_id: 'p-a', kind: 'owner', end_date: null }); return r; };
  await assert.rejects(approve(db, d, P), (e) => e.code === 'tenure_changed');
  assert.ok(sold); assert.strictEqual(P.calls.charge.length, 0, 'the buyer is never charged');
  const row = db.tables.legal_invoice_postings[0];
  assert.strictEqual(row.status, 'pending');
  row.claimed_at = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  assert.strictEqual((await T.reopenReview(db, INV, { actor: 'o@example.test', reason: 'sale after approval' })).error, 'live_postings');
  const c = await T.cancelPendingPosting(db, row.id, { actor: 'o@example.test', reason: 'sold after approval', deps: P.deps });
  assert.ok(c.ok && c.reversal_journal_entry_id, JSON.stringify(c));
  assert.strictEqual(row.status, 'cancelled'); assert.strictEqual(P.calls.void.length, 1);
  assert.ok((await T.reopenReview(db, INV, { actor: 'o@example.test', reason: 'sale after approval' })).ok);
});
t('cancel: a pending claim that wrote nothing is released with a reason and no GL activity', async () => {
  const db = fakeDb(seed()); const d = withAllocs(db, invoice([item('it-1', LINE, [owner(10000, 'p-a')])])); const P = posters(db);
  P.deps.postJE = async () => { throw Object.assign(new Error('period_closed: the books are closed through 2026-09-30'), { code: 'period_closed' }); };
  await assert.rejects(approve(db, d, P), /period_closed/);
  const row = db.tables.legal_invoice_postings[0]; row.claimed_at = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  assert.strictEqual((await T.cancelPendingPosting(db, row.id, { actor: 'o@example.test', reason: '', deps: P.deps })).error, 'reason_required');
  const c = await T.cancelPendingPosting(db, row.id, { actor: 'o@example.test', reason: 'period closed after approval', deps: P.deps });
  assert.ok(c.ok); assert.strictEqual(c.reversal_journal_entry_id, null); assert.strictEqual(P.calls.void.length, 0);
  assert.ok(db.tables.legal_invoice_review_events.some((e) => e.action === 'posting_cancelled'));
});

// ---- corrections ------------------------------------------------------------
t('correction: reverse needs a reason, voids the JE, credits the owner, keeps the original; reopen only after all reversed', async () => {
  const db = fakeDb(seed()); const d = withAllocs(db, twoOwnersOneGeneral()); const P = posters(db);
  await approve(db, d, P);
  const [a, b] = db.tables.legal_invoice_postings;
  assert.strictEqual((await T.reversePosting(db, a.id, { actor: 'owner@example.test', reason: '', deps: P.deps })).error, 'reason_required');
  assert.strictEqual((await T.reopenReview(db, INV, { actor: 'owner@example.test', reason: 'wrong property on line 2' })).error, 'live_postings');
  const r = await T.reversePosting(db, a.id, { actor: 'owner@example.test', reason: 'billed to the wrong lot', deps: P.deps });
  assert.ok(r.ok && r.reversal_journal_entry_id && r.reversal_homeowner_transaction_id);
  assert.strictEqual(P.calls.credit[0].amountCents, a.amount_cents);
  assert.strictEqual(db.tables.homeowner_transactions.filter((h) => h.txn_type === 'charge').length, 2, 'the original charge is never deleted');
  assert.strictEqual((await T.reversePosting(db, a.id, { actor: 'owner@example.test', reason: 'again please', deps: P.deps })).error, 'not_posted');
  await T.reversePosting(db, b.id, { actor: 'owner@example.test', reason: 'billed to the wrong lot', deps: P.deps });
  assert.ok((await T.reopenReview(db, INV, { actor: 'owner@example.test', reason: 'wrong property on line 2' })).ok);
  assert.strictEqual(db.tables.legal_invoice_reviews[0].status, 'draft');
  const acts = db.tables.legal_invoice_review_events.map((e) => e.action);
  assert.ok(['treatment_approved', 'posting_recorded', 'posting_reversed', 'review_reopened'].every((x) => acts.includes(x)));
});
t('correction: a reversal that crashed after the reversing entry finds it again, never a second one', async () => {
  const db = fakeDb(seed()); const d = withAllocs(db, invoice([item('it-1', LINE, [owner(10000, 'p-a')])])); const P = posters(db);
  await approve(db, d, P);
  const row = db.tables.legal_invoice_postings[0];
  db.tables.journal_entries.push({ id: 'rev-earlier', reverses_je_id: row.journal_entry_id, status: 'posted' });   // posted, then the request died
  const r = await T.reversePosting(db, row.id, { actor: 'o@example.test', reason: 'restating the split', deps: P.deps });
  assert.ok(r.ok); assert.strictEqual(r.reversal_journal_entry_id, 'rev-earlier'); assert.strictEqual(P.calls.void.length, 0);
});
t('correction: after reopen + re-approve, the same allocation can post again (the old claim is reversed)', async () => {
  const db = fakeDb(seed()); const d = withAllocs(db, twoOwnersOneGeneral()); const P = posters(db);
  await approve(db, d, P);
  for (const p of db.tables.legal_invoice_postings.slice()) await T.reversePosting(db, p.id, { actor: 'o@example.test', reason: 'restating the split', deps: P.deps });
  await T.reopenReview(db, INV, { actor: 'o@example.test', reason: 'restating the split' });
  const again = await approve(db, d, P);
  assert.ok(again.ok);
  assert.strictEqual(db.tables.legal_invoice_postings.filter((p) => p.status === 'posted').length, 2);
  assert.strictEqual(db.tables.legal_invoice_postings.filter((p) => p.status === 'reversed').length, 2);
});
t('void/split guard: live postings on an invoice are counted; before 508 there are none', async () => {
  const db = fakeDb(seed()); const d = withAllocs(db, twoOwnersOneGeneral()); const P = posters(db);
  assert.strictEqual(await T.livePostingsForInvoice(db, INV), 0);
  await approve(db, d, P);
  assert.strictEqual(await T.livePostingsForInvoice(db, INV), 2);
  const pre = fakeDb(seed()); pre.missing.add('legal_invoice_postings');
  assert.strictEqual(await T.livePostingsForInvoice(pre, INV), 0);
});

// ---- former clients ---------------------------------------------------------
t('former client: terminated, or terminating past the last day; not while still in notice', () => {
  const today = '2026-10-11';
  assert.ok(FC.isFormerClient({ management_status: 'terminating', management_end_date: '2026-09-30' }, today), 'Eaglewood');
  assert.ok(FC.isFormerClient({ management_status: 'terminated', management_end_date: null }, today));
  assert.ok(!FC.isFormerClient({ management_status: 'terminating', management_end_date: '2026-12-31' }, today), 'still managed until the last day');
  assert.ok(!FC.isFormerClient({ management_status: 'terminating', management_end_date: '2026-10-11' }, today), 'the last day itself is still ours');
  assert.ok(!FC.isFormerClient({ management_status: 'active' }, today));
});

(async () => {
  for (const [name, fn] of pending) {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n        ' + (e && e.message)); }
  }
  console.log(`\n${pass} passed${fail ? ', FAILURES above' : ''}`);
  if (fail) process.exit(1);
})();
