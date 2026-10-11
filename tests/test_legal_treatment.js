// ============================================================================
// tests/test_legal_treatment.js  (Ed 2026-10-11, migration 508)
// ----------------------------------------------------------------------------
// Approve Treatment: the accounting a reviewed attorney invoice produces, and
// the controls around it. Deterministic: an in-memory Supabase stand-in and
// injected GL / owner-ledger posters. No database, no real posting.
//
//   - a homeowner chargeback is Dr 1300 (property) / Cr the invoice line's
//     accrued expense account. AP is never credited again.
//   - association expense posts nothing; Bedrock needs a receivable account
//     and written evidence.
//   - the treatment reconciles to the invoice total, to the cent.
//   - idempotent: a second run, or a run resuming after a crash, never posts
//     twice.
//   - corrections reverse (journal entry + owner adjustment) with a reason;
//     nothing is deleted. Reopen only after every posting is reversed.
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
  const db = { tables: JSON.parse(JSON.stringify(seed)), seq: 0, missing: new Set() };
  const id = (p) => `${p}-${++db.seq}`;
  const get = (row, k) => {
    const m = /^(\w+)->>(\w+)$/.exec(k);
    if (m) return row[m[1]] && row[m[1]][m[2]] != null ? String(row[m[1]][m[2]]) : null;
    return row[k];
  };
  db.from = (table) => {
    const st = { op: 'select', filters: [], payload: null, one: false, maybe: false, head: false };
    const rows = () => (db.tables[table] = db.tables[table] || []);
    const match = (r) => st.filters.every((f) => f(r));
    const b = {
      select(_c, o) { if (o && o.head) st.head = true; return b; },
      insert(p) { st.op = 'insert'; st.payload = p; return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; },
      eq(k, v) { st.filters.push((r) => get(r, k) === v || (typeof v !== 'string' && get(r, k) == v)); return b; },
      in(k, vs) { st.filters.push((r) => vs.includes(get(r, k))); return b; },
      like(k, p) { const pre = p.replace(/%$/, ''); st.filters.push((r) => String(get(r, k) || '').startsWith(pre)); return b; },
      order() { return b; }, limit() { return b; },
      single() { st.one = true; return b; }, maybeSingle() { st.maybe = true; return b; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      if (db.missing.has(table)) return { data: null, error: { code: 'PGRST205', message: `Could not find the table ${table} in the schema cache` } };
      if (st.op === 'insert') {
        const row = Object.assign({ id: id(table), created_at: new Date(Date.now() + db.seq).toISOString() }, st.payload);
        if (table === 'legal_invoice_postings' && rows().some((r) => r.allocation_id === row.allocation_id && ['pending', 'posted'].includes(r.status))) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_legal_invoice_postings_live_allocation"' } };
        }
        rows().push(row);
        return { data: st.one || st.maybe ? row : [row], error: null };
      }
      if (st.op === 'update') {
        const hit = rows().filter(match);
        hit.forEach((r) => Object.assign(r, st.payload));
        return { data: hit, error: null };
      }
      const hit = rows().filter(match);
      if (st.head) return { data: null, count: hit.length, error: null };
      if (st.one) return hit.length === 1 ? { data: hit[0], error: null } : { data: null, error: { message: 'not single' } };
      if (st.maybe) return { data: hit[0] || null, error: null };
      return { data: hit, error: null };
    }
    return b;
  };
  db.rpc = async (fn, a) => {
    const reviews = db.tables.legal_invoice_reviews;
    const r = reviews.find((x) => x.ap_invoice_id === a.p_ap_invoice_id);
    if (fn === 'legal_review_approve') {
      if (!r) return { data: { ok: false, error: 'no_review' }, error: null };
      if (r.revision !== a.p_base_revision) return { data: { ok: false, error: 'stale', revision: r.revision }, error: null };
      if (r.status === 'approved') return { data: { ok: true, already: true, review_id: r.id, revision: r.revision }, error: null };
      Object.assign(r, { status: 'approved', approved_revision: r.revision, approved_by: a.p_actor, approved_at: new Date().toISOString() });
      db.tables.legal_invoice_review_events.push({ review_id: r.id, action: 'treatment_approved', actor: a.p_actor, summary: a.p_summary });
      return { data: { ok: true, review_id: r.id, revision: r.revision }, error: null };
    }
    if (fn === 'legal_review_reopen') {
      if (!a.p_reason || a.p_reason.trim().length < 5) return { data: null, error: { message: 'legal_review_reason_required' } };
      if (db.tables.legal_invoice_postings.some((p) => p.review_id === r.id && ['pending', 'posted'].includes(p.status))) return { data: { ok: false, error: 'live_postings' }, error: null };
      Object.assign(r, { status: 'draft', approved_revision: null, approved_by: null, approved_at: null });
      db.tables.legal_invoice_review_events.push({ review_id: r.id, action: 'review_reopened', actor: a.p_actor, summary: { reason: a.p_reason } });
      return { data: { ok: true }, error: null };
    }
    throw new Error('unexpected rpc ' + fn);
  };
  return db;
}

// ---- a Canyon Gate-shaped invoice: one AP line coded to 5870 ----------------
const CG = 'cg', INV = 'inv-280595', LINE = 'line-1', REV = 'rev-1';
const CONFIRMED = { kind: 'staff_confirmed', value: 'confirmed by staff' };
const seed = () => ({
  chart_of_accounts: [
    { id: 'a1300', community_id: CG, account_number: '1300', account_name: 'Accounts Receivable', is_active: true },
    { id: 'a1375', community_id: CG, account_number: '1375', account_name: 'Due from prior management co', is_active: true },
    { id: 'a5870', community_id: CG, account_number: '5870', account_name: 'Legal Fees - Collections/DRV', is_active: true },
    { id: 'a5860', community_id: CG, account_number: '5860', account_name: 'Legal Fees - Corporate', is_active: true },
    { id: 'a2000', community_id: CG, account_number: '2000', account_name: 'Accounts Payable', is_active: true },
  ],
  ap_invoices: [{ id: INV, community_id: CG, posting_journal_entry_id: 'je-accrual' }],
  ap_invoice_lines: [{ id: LINE, invoice_id: INV, gl_account_id: 'a5870' }, { id: 'line-2', invoice_id: INV, gl_account_id: 'a5860' }],
  journal_entries: [{ id: 'je-accrual', posting_date: '2026-08-31', status: 'posted', reference: 'AP-280595' }],
  legal_invoice_reviews: [{ id: REV, ap_invoice_id: INV, community_id: CG, status: 'draft', revision: 3 }],
  legal_invoice_review_events: [],
  legal_invoice_postings: [],
  homeowner_transactions: [],
});
const owner = (amount, pid, extra) => Object.assign({ id: 'al-' + pid, amount_cents: amount, classification: 'homeowner_recoverable', property_id: pid,
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

function posters(db, { failChargeOnce } = {}) {
  const calls = { je: [], charge: [], void: [], credit: [] };
  let failed = false;
  return {
    calls,
    deps: {
      postJE: async (o) => { calls.je.push(o); const e = { id: 'je-' + calls.je.length, source_module: o.source_module, source_reference: o.source_reference, status: 'posted' }; db.tables.journal_entries.push(e); return { entry: e }; },
      postCharge: async (_s, o) => {
        if (failChargeOnce && !failed) { failed = true; throw new Error('network blip'); }
        calls.charge.push(o); const row = { id: 'ht-' + calls.charge.length, community_id: o.communityId, txn_type: 'charge', raw_row_jsonb: o.raw };
        db.tables.homeowner_transactions.push(row); return { chargeId: row.id };
      },
      voidJE: async (o) => { calls.void.push(o); const je = db.tables.journal_entries.find((j) => j.id === o.journal_entry_id); je.status = 'voided'; je.void_reversal_je_id = 'rev-' + je.id; return { reversal_entry: { id: 'rev-' + je.id } }; },
      postCredit: async (_s, o) => { calls.credit.push(o); const row = { id: 'ht-cr-' + calls.credit.length, community_id: o.communityId, txn_type: 'adjustment', raw_row_jsonb: o.raw }; db.tables.homeowner_transactions.push(row); return { chargeId: row.id }; },
    },
  };
}

// ---- plan ------------------------------------------------------------------
t('plan: owner-specific lines bill back Dr 1300 / Cr the accrued 5870; the general matter posts nothing', async () => {
  const db = fakeDb(seed());
  const p = await T.planTreatment(db, twoOwnersOneGeneral());
  assert.ok(p.ready, p.blocking.join('; '));
  assert.strictEqual(p.postings.length, 2);
  p.postings.forEach((x) => { assert.strictEqual(x.debit_account_id, 'a1300'); assert.strictEqual(x.credit_account_id, 'a5870'); assert.notStrictEqual(x.credit_account_id, 'a2000'); });
  assert.deepStrictEqual(p.totals, { homeowner_cents: 247246, association_cents: 19027, bedrock_cents: 0 });
  assert.strictEqual(p.totals.homeowner_cents + p.totals.association_cents + p.totals.bedrock_cents, p.invoice_total_cents);
  assert.strictEqual(p.posting_date, '2026-08-31', 'defaults to the accrual date');
});
t('plan: a line coded to 5860 is credited back to 5860, line by line', async () => {
  const db = fakeDb(seed());
  const p = await T.planTreatment(db, invoice([item('it-1', LINE, [owner(10000, 'p-a')]), item('it-2', 'line-2', [owner(3200, 'p-b')])]));
  assert.ok(p.ready, p.blocking.join('; '));
  assert.deepStrictEqual(p.postings.map((x) => x.credit_account_id), ['a5870', 'a5860']);
});
t('plan: an unaccrued invoice, a former client, an exception or needs-review all block', async () => {
  const db = fakeDb(seed());
  const un = await T.planTreatment(db, invoice([item('it-1', LINE, [owner(1000, 'p-a')])], { invoice: Object.assign({}, twoOwnersOneGeneral().invoice, { total_cents: 1000, accrued: false }) }));
  assert.ok(!un.ready && un.blocking.some((b) => /accrual/.test(b)));
  const ro = await T.planTreatment(db, invoice([item('it-1', LINE, [owner(1000, 'p-a')])], { readOnly: 'Leaving Bedrock (last day 2026-09-30): view only.' }));
  assert.ok(!ro.ready && ro.blocking.some((b) => /Leaving Bedrock/.test(b)));
  const nr = await T.planTreatment(db, invoice([item('it-1', LINE, [assoc(1000, { classification: 'needs_review', evidence: [] })])]));
  assert.ok(!nr.ready, 'uncertain recoverability is flagged, never defaulted to general');
  const former = await T.planTreatment(db, invoice([item('it-1', LINE, [owner(1000, 'p-a', { tenure_match: 'former' })])]));
  assert.ok(!former.ready && former.blocking.some((b) => /owner at the time/.test(b)), 'ownership change blocks');
  const bk = await T.planTreatment(db, invoice([item('it-1', LINE, [owner(1000, 'p-a', { bankruptcy_stop: true, evidence: [CONFIRMED] })])]));
  assert.ok(!bk.ready && bk.blocking.some((b) => /bankruptcy/.test(b)), 'bankruptcy stops a homeowner charge');
});
t('plan: bankruptcy work kept as association expense is approvable once confirmed', async () => {
  const db = fakeDb(seed());
  const p = await T.planTreatment(db, invoice([item('it-1', LINE, [assoc(58750, { bankruptcy_stop: true })])]));
  assert.ok(p.ready, p.blocking.join('; '));
  assert.strictEqual(p.postings.length, 0);
});
t('plan: a split that does not reconcile to the invoice blocks', async () => {
  const db = fakeDb(seed());
  const d = twoOwnersOneGeneral(); d.invoice.total_cents += 1;
  const p = await T.planTreatment(db, d);
  assert.ok(!p.ready && p.blocking.some((b) => /add up|invoice total/.test(b)));
});
t('plan: Bedrock responsibility refuses without a receivable-from-Bedrock account (never 1375 prior manager)', async () => {
  const db = fakeDb(seed());
  const bedrock = { id: 'al-b', amount_cents: 7000, classification: 'bedrock_corporate', property_id: null, tenure_match: 'not_applicable', confidence: 'none', charge_category: null, bankruptcy_stop: false, suggested: false, evidence: [], note: 'Resale certificate work is the manager’s cost under the management agreement' };
  const p = await T.planTreatment(db, invoice([item('it-1', LINE, [bedrock])]));
  assert.ok(!p.ready && p.blocking.some((b) => /receivable-from-Bedrock/.test(b)));
  db.tables.chart_of_accounts.push({ id: 'a1390', community_id: CG, account_number: '1390', account_name: 'Due from Bedrock (management company)', is_active: true });
  const p2 = await T.planTreatment(db, invoice([item('it-1', LINE, [bedrock])]));
  assert.ok(p2.ready, p2.blocking.join('; '));
  assert.strictEqual(p2.postings[0].debit_account_id, 'a1390');
  assert.strictEqual(p2.totals.bedrock_cents, 7000);
});

// ---- approve + post ---------------------------------------------------------
t('approve: locks the revision, posts each owner once, links JE + owner charge to the posting and invoice line', async () => {
  const db = fakeDb(seed()); const P = posters(db);
  const out = await T.approveTreatment(db, twoOwnersOneGeneral(), { actor: 'owner@example.test', baseRevision: 3, deps: P.deps });
  assert.ok(out.ok, JSON.stringify(out));
  assert.strictEqual(db.tables.legal_invoice_reviews[0].status, 'approved');
  assert.strictEqual(P.calls.je.length, 2);
  assert.strictEqual(P.calls.charge.length, 2);
  P.calls.je.forEach((j) => {
    assert.strictEqual(j.source_module, 'ap_billback');
    assert.ok(j.lines.every((l) => l.account_id !== 'a2000'), 'AP is never credited again');
    assert.strictEqual(j.lines[0].account_id, 'a1300'); assert.ok(j.lines[0].property_id);
    assert.strictEqual(j.lines[1].account_id, 'a5870');
  });
  const posts = db.tables.legal_invoice_postings;
  assert.ok(posts.every((p) => p.status === 'posted' && p.journal_entry_id && p.homeowner_transaction_id && p.ap_invoice_line_ids[0] === LINE));
  assert.ok(P.calls.charge.every((c) => c.raw.legal_posting_id && c.raw.ap_invoice_id === INV && /280595/.test(c.description)));
  assert.strictEqual(db.tables.legal_invoice_review_events.filter((e) => e.action === 'posting_recorded').length, 2);
});
t('idempotent: approving again posts nothing new', async () => {
  const db = fakeDb(seed()); const P = posters(db);
  await T.approveTreatment(db, twoOwnersOneGeneral(), { actor: 'owner@example.test', baseRevision: 3, deps: P.deps });
  const again = await T.approveTreatment(db, twoOwnersOneGeneral(), { actor: 'owner@example.test', baseRevision: 3, deps: P.deps });
  assert.ok(again.ok && again.already_approved);
  assert.ok(again.posted.every((p) => p.already));
  assert.strictEqual(P.calls.je.length, 2); assert.strictEqual(P.calls.charge.length, 2);
});
t('idempotent: a run that crashed after the JE resumes without a second JE', async () => {
  const db = fakeDb(seed()); const P = posters(db, { failChargeOnce: true });
  await assert.rejects(T.approveTreatment(db, twoOwnersOneGeneral(), { actor: 'owner@example.test', baseRevision: 3, deps: P.deps }), /network blip/);
  assert.strictEqual(db.tables.legal_invoice_postings[0].status, 'pending');
  const out = await T.approveTreatment(db, twoOwnersOneGeneral(), { actor: 'owner@example.test', baseRevision: 3, deps: P.deps });
  assert.ok(out.ok);
  assert.strictEqual(P.calls.je.length, 2, 'the first allocation’s JE was found by source_reference, not reposted');
  assert.strictEqual(P.calls.charge.length, 2);
  assert.ok(db.tables.legal_invoice_postings.every((p) => p.status === 'posted'));
});
t('approve: a stale revision or a blocked plan posts nothing', async () => {
  const db = fakeDb(seed()); const P = posters(db);
  const stale = await T.approveTreatment(db, twoOwnersOneGeneral(), { actor: 'owner@example.test', baseRevision: 2, deps: P.deps });
  assert.strictEqual(stale.error, 'stale');
  const blocked = await T.approveTreatment(db, invoice([item('it-1', LINE, [owner(1000, 'p-a', { tenure_match: 'unresolved' })])]), { actor: 'owner@example.test', baseRevision: 3, deps: P.deps });
  assert.strictEqual(blocked.error, 'not_ready');
  assert.strictEqual(P.calls.je.length, 0); assert.strictEqual(db.tables.legal_invoice_reviews[0].status, 'draft');
});
t('approve: before migration 508 it says so and posts nothing', async () => {
  const db = fakeDb(seed()); db.missing.add('legal_invoice_postings'); const P = posters(db);
  const out = await T.approveTreatment(db, twoOwnersOneGeneral(), { actor: 'owner@example.test', baseRevision: 3, deps: P.deps });
  assert.strictEqual(out.error, 'migration_pending');
  assert.strictEqual(P.calls.je.length, 0);
});

// ---- corrections ------------------------------------------------------------
t('correction: reverse needs a reason, voids the JE, credits the owner, keeps the original; reopen only after all reversed', async () => {
  const db = fakeDb(seed()); const P = posters(db);
  await T.approveTreatment(db, twoOwnersOneGeneral(), { actor: 'owner@example.test', baseRevision: 3, deps: P.deps });
  const [a, b] = db.tables.legal_invoice_postings;
  assert.strictEqual((await T.reversePosting(db, a.id, { actor: 'owner@example.test', reason: '', deps: P.deps })).error, 'reason_required');
  const early = await T.reopenReview(db, INV, { actor: 'owner@example.test', reason: 'wrong property on line 2' });
  assert.strictEqual(early.error, 'live_postings');
  const r = await T.reversePosting(db, a.id, { actor: 'owner@example.test', reason: 'billed to the wrong lot', deps: P.deps });
  assert.ok(r.ok && r.reversal_journal_entry_id && r.reversal_homeowner_transaction_id);
  assert.strictEqual(P.calls.credit[0].amountCents, a.amount_cents);
  assert.strictEqual(db.tables.homeowner_transactions.filter((h) => h.txn_type === 'charge').length, 2, 'the original charge is never deleted');
  assert.strictEqual((await T.reversePosting(db, a.id, { actor: 'owner@example.test', reason: 'again please', deps: P.deps })).error, 'not_posted');
  await T.reversePosting(db, b.id, { actor: 'owner@example.test', reason: 'billed to the wrong lot', deps: P.deps });
  const ok = await T.reopenReview(db, INV, { actor: 'owner@example.test', reason: 'wrong property on line 2' });
  assert.ok(ok.ok); assert.strictEqual(db.tables.legal_invoice_reviews[0].status, 'draft');
  const acts = db.tables.legal_invoice_review_events.map((e) => e.action);
  assert.ok(['treatment_approved', 'posting_recorded', 'posting_reversed', 'review_reopened'].every((x) => acts.includes(x)));
});
t('correction: after reopen + re-approve, the same allocation can post again (the old claim is reversed)', async () => {
  const db = fakeDb(seed()); const P = posters(db);
  await T.approveTreatment(db, twoOwnersOneGeneral(), { actor: 'o@example.test', baseRevision: 3, deps: P.deps });
  for (const p of db.tables.legal_invoice_postings.slice()) await T.reversePosting(db, p.id, { actor: 'o@example.test', reason: 'restating the split', deps: P.deps });
  await T.reopenReview(db, INV, { actor: 'o@example.test', reason: 'restating the split' });
  const again = await T.approveTreatment(db, twoOwnersOneGeneral(), { actor: 'o@example.test', baseRevision: 3, deps: P.deps });
  assert.ok(again.ok);
  assert.strictEqual(db.tables.legal_invoice_postings.filter((p) => p.status === 'posted').length, 2);
  assert.strictEqual(db.tables.legal_invoice_postings.filter((p) => p.status === 'reversed').length, 2);
});

// ---- former clients ---------------------------------------------------------
t('former client: terminated, or terminating past the last day; not while still in notice', () => {
  const today = '2026-10-11';
  assert.ok(FC.isFormerClient({ management_status: 'terminating', management_end_date: '2026-09-30' }, today), 'Eaglewood');
  assert.ok(FC.isFormerClient({ management_status: 'terminated', management_end_date: null }, today));
  assert.ok(!FC.isFormerClient({ management_status: 'terminating', management_end_date: '2026-12-31' }, today), 'still managed until the last day');
  assert.ok(!FC.isFormerClient({ management_status: 'terminating', management_end_date: '2026-10-11' }, today), 'the last day itself is still ours');
  assert.ok(!FC.isFormerClient({ management_status: 'active' }, today));
  assert.ok(/former client/.test(FC.formerClientReason({ name: 'Eaglewood', management_end_date: '2026-09-30' })));
});
t('former client: ids come back for the queue filter', async () => {
  const db = fakeDb({ communities: [
    { id: 'ew', name: 'Eaglewood', management_status: 'terminating', management_end_date: '2026-09-30' },
    { id: 'cg', name: 'Canyon Gate', management_status: 'active' },
    { id: 'nx', name: 'Next', management_status: 'terminating', management_end_date: '2027-01-31' }] });
  const ids = await FC.formerClientIds(db, '2026-10-11');
  assert.deepStrictEqual([...ids], ['ew']);
  assert.ok(await FC.formerClientFor(db, 'ew', '2026-10-11'));
  assert.strictEqual(await FC.formerClientFor(db, 'cg', '2026-10-11'), null);
});

(async () => {
  for (const [name, fn] of pending) {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n        ' + (e && e.message)); }
  }
  console.log(`\n${pass} passed${fail ? ', FAILURES above' : ''}`);
  if (fail) process.exit(1);
})();
