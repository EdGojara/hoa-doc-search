// ============================================================================
// tests/test_legal_team_e2e.js  (Ed 2026-10-11)
// ----------------------------------------------------------------------------
// End to end on the real modules (suggestion engine, draft builder, research,
// Kat's verification, Approve Treatment, posting, the manager's activity
// state). Only the database, the mail/OneDrive sources and the GL/owner-ledger
// posters are faked.
//
//   A  supported recovery: intake -> Emma's draft -> Amanda (notice content +
//      certified mailing verified) -> Kat verified -> owner confirms the
//      association line -> owner approves -> postings (balanced, linked,
//      idempotent) -> recovery resolved; attorney payment still open until paid.
//   B  bankruptcy: Amanda holds; paying the attorney closes ONLY the payment
//      activity; recovery and documentation stay open.
// ============================================================================
const assert = require('assert');
const TEAM = require('../lib/legal/team');
const T = require('../lib/legal/treatment');
const R = require('../lib/legal/review_data');

let pass = 0, fail = 0;
const pending = [];
const t = (n, f) => pending.push([n, f]);

// ---- in-memory database with the RPCs the workflow uses ---------------------
function db0(seed) {
  const db = { tables: JSON.parse(JSON.stringify(seed)), seq: 0 };
  const id = (p) => `${p}-${++db.seq}`;
  const rows = (tb) => (db.tables[tb] = db.tables[tb] || []);
  const get = (r, k) => { const m = /^(\w+)->>(\w+)$/.exec(k); if (m) return r[m[1]] && r[m[1]][m[2]] != null ? String(r[m[1]][m[2]]) : null; return r[k]; };
  db.from = (tb) => {
    const st = { op: 'select', f: [], payload: null, one: false, maybe: false, head: false, ret: false };
    const match = (r) => st.f.every((fn) => fn(r));
    const q = {
      select(_c, o) { if (o && o.head) st.head = true; if (st.op !== 'select') st.ret = true; return q; },
      insert(p) { st.op = 'insert'; st.payload = p; return q; }, update(p) { st.op = 'update'; st.payload = p; return q; },
      eq(k, v) { st.f.push((r) => get(r, k) === v || (typeof v !== 'string' && get(r, k) == v)); return q; },
      neq(k, v) { st.f.push((r) => get(r, k) !== v); return q; },
      is(k, v) { st.f.push((r) => (get(r, k) == null) === (v === null)); return q; },
      in(k, vs) { st.f.push((r) => vs.includes(get(r, k))); return q; },
      like(k, p) { const pre = p.replace(/%$/, ''); st.f.push((r) => String(get(r, k) || '').startsWith(pre)); return q; },
      gt() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; },
      single() { st.one = true; return q; }, maybeSingle() { st.maybe = true; return q; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      if (st.op === 'insert') {
        const list = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((p) => Object.assign({ id: id(tb), created_at: new Date(Date.now() + db.seq).toISOString() }, p));
        rows(tb).push(...list);
        return { data: st.one || st.maybe ? list[0] : list, error: null };
      }
      if (st.op === 'update') { const hit = rows(tb).filter(match); hit.forEach((r) => Object.assign(r, st.payload)); return { data: st.ret ? hit : null, error: null }; }
      const hit = rows(tb).filter(match);
      if (st.head) return { data: null, count: hit.length, error: null };
      if (st.one) return hit.length === 1 ? { data: hit[0], error: null } : { data: null, error: { message: `not single (${tb}: ${hit.length})` } };
      if (st.maybe) return { data: hit[0] || null, error: null };
      return { data: hit, error: null };
    }
    return q;
  };
  db.rpc = async (fn, a) => {
    const reviews = rows('legal_invoice_reviews');
    if (fn === 'legal_review_save_draft') {
      let r = reviews.find((x) => x.ap_invoice_id === a.p_ap_invoice_id);
      if (!r) { r = { id: id('rev'), ap_invoice_id: a.p_ap_invoice_id, community_id: a.p_community_id, status: 'draft', revision: 0 }; reviews.push(r); }
      if (r.status === 'approved') return { data: { ok: false, error: 'approved_locked' }, error: null };
      if (r.revision !== a.p_base_revision) return { data: { ok: false, error: 'stale', revision: r.revision }, error: null };
      const rev = r.revision + 1;
      rows('legal_invoice_items').forEach((x) => { if (x.review_id === r.id) x.is_active = false; });
      rows('legal_invoice_allocations').forEach((x) => { if (x.review_id === r.id) x.is_active = false; });
      a.p_items.forEach((it, i) => {
        const item = Object.assign({ id: id('item'), review_id: r.id, revision: rev, is_active: true, sort_order: i }, it); delete item.allocations;
        rows('legal_invoice_items').push(item);
        for (const al of it.allocations) rows('legal_invoice_allocations').push(Object.assign({ id: id('alloc'), item_id: item.id, review_id: r.id, revision: rev, is_active: true, legal_invoice_items: { matter_ref: it.matter_ref } }, al));
      });
      Object.assign(r, { revision: rev, updated_by: a.p_actor });
      return { data: { ok: true, review_id: r.id, revision: rev }, error: null };
    }
    if (fn === 'legal_review_approve') {
      const r = reviews.find((x) => x.ap_invoice_id === a.p_ap_invoice_id);
      if (r.revision !== a.p_base_revision) return { data: { ok: false, error: 'stale' }, error: null };
      if (r.status === 'approved') return { data: { ok: true, already: true, revision: r.revision }, error: null };
      Object.assign(r, { status: 'approved', approved_by: a.p_actor, approved_at: new Date().toISOString(), approved_revision: r.revision });
      for (const p of a.p_postings) rows('legal_invoice_postings').push(Object.assign({ id: id('post'), review_id: r.id, ap_invoice_id: a.p_ap_invoice_id, community_id: r.community_id, review_revision: r.revision, status: 'pending', claim_token: null, claimed_at: null }, p));
      return { data: { ok: true, revision: r.revision }, error: null };
    }
    if (fn === 'legal_posting_claim') {
      const p = rows('legal_invoice_postings').find((x) => x.id === a.p_posting_id && x.status === a.p_from_status);
      if (!p || (p.claimed_at && p.claim_token !== a.p_token)) return { data: false, error: null };
      Object.assign(p, { claim_token: a.p_token, claimed_at: new Date().toISOString() });
      return { data: true, error: null };
    }
    throw new Error('rpc ' + fn);
  };
  return db;
}

// The shape review_data.loadInvoice returns, built from the fake tables.
function loaderFor(db, { communityName = 'Waterview Estates' } = {}) {
  return async (_s, invId) => {
    const inv = db.tables.ap_invoices.find((x) => x.id === invId);
    if (!inv) return null;
    const acct = (gid) => { const a = db.tables.chart_of_accounts.find((x) => x.id === gid); return a ? `${a.account_number} ${a.account_name}` : null; };
    const lines = db.tables.ap_invoice_lines.filter((l) => l.invoice_id === invId).map((l) => ({ id: l.id, line_number: l.line_number, description: l.description, amount_cents: l.amount_cents, account: acct(l.gl_account_id) }));
    const review = (db.tables.legal_invoice_reviews || []).find((r) => r.ap_invoice_id === invId) || null;
    const items = review ? (db.tables.legal_invoice_items || []).filter((x) => x.review_id === review.id && x.is_active).sort((a, b) => a.sort_order - b.sort_order).map((it) => Object.assign({}, it, {
      allocations: (db.tables.legal_invoice_allocations || []).filter((a) => a.item_id === it.id && a.is_active).map((a) => Object.assign({}, a)),
    })) : [];
    return {
      invoice: { id: inv.id, vendor: 'RMWBH', invoice_number: inv.vendor_invoice_number, invoice_date: inv.invoice_date, total_cents: inv.total_cents, ap_status: inv.status, voided: false, accrued: !!inv.posting_journal_entry_id, has_file: false, community_id: inv.community_id },
      community: { id: inv.community_id, name: communityName }, lines, invoiceNumber: inv.vendor_invoice_number,
      ctx: { properties: db.tables.properties, tenures: db.tables.ownership_tenures, owners: db.tables.owner_names, bankruptcyPropertyIds: [], legalStates: {} },
      saved: review ? { review: { id: review.id, revision: review.revision, status: review.status, updated_by: review.updated_by, approved_by: review.approved_by || null }, items } : null,
      schemaReady: true, extraction: null, extractionUse: { ok: false }, readOnly: null,
    };
  };
}

const C = 'c-wv', INV = 'inv-350881';
const WV_NOTICE = 'NOTICE OF VIOLATION HEARING December 13, 2024 Certified Mail No. 9589 0710 5270 2276 8814 10 Ricardo Martinez 5922 Spring Sunrise Drive Richmond, TX a covenant violation exists. cure within 30 days. request a hearing. you will be responsible for all reasonable attorney fees. Section 209.006';
const seed = (extra = {}) => Object.assign({
  communities: [{ id: C, gl_cutover_date: '2026-08-01' }],
  chart_of_accounts: [
    { id: 'a1300', community_id: C, account_number: '1300', account_name: 'Accounts Receivable', is_active: true },
    { id: 'a5870', community_id: C, account_number: '5870', account_name: 'Legal Fees - Collections/DRV', is_active: true },
    { id: 'a5860', community_id: C, account_number: '5860', account_name: 'Legal Fees - Corporate', is_active: true },
    { id: 'a2000', community_id: C, account_number: '2000', account_name: 'Accounts Payable', is_active: true }],
  properties: [{ id: '11111111-1111-4111-8111-111111111111', community_id: C, street_address: '5922 Spring Sunrise Drive' }],
  ownership_tenures: [{ id: '22222222-2222-4222-8222-222222222222', property_id: '11111111-1111-4111-8111-111111111111', community_id: C, kind: 'owner', start_date: '2019-04-01', end_date: null, origin: 'backfill_current' }],
  owner_names: [{ property_id: '11111111-1111-4111-8111-111111111111', tenure_id: '22222222-2222-4222-8222-222222222222', name: 'Ricardo Martinez' }],
  ap_invoices: [{ id: INV, community_id: C, vendor_id: 'v-rmwbh', vendor_invoice_number: 'PS-INV350881', invoice_date: '2026-08-28', total_cents: 62735, status: 'awaiting_approval', posting_journal_entry_id: 'je-acc', dedup_status: 'unique' }],
  ap_invoice_lines: [
    { id: 'l1', invoice_id: INV, line_number: 1, description: 'Martinez, Ricardo Ignacio - 5922 Spring Sunrise Dr. - Prepared Original Petition; court filing fee', amount_cents: 55735, gl_account_id: 'a5870' },
    { id: 'l2', invoice_id: INV, line_number: 2, description: 'General Matters - correspondence with the Board regarding annual meeting', amount_cents: 7000, gl_account_id: 'a5860' }],
  ap_invoice_approvals: [{ invoice_id: INV, action: 'approved' }],
  ap_payment_applications: [],
  journal_entries: [{ id: 'je-acc', posting_date: '2026-08-28', status: 'posted', reference: 'AP-1' }],
  ar_account_collections: [], violations: [], sent_letter_archive: [], homeowner_transactions: [],
  legal_invoice_reviews: [], legal_invoice_items: [], legal_invoice_allocations: [], legal_invoice_postings: [],
  objectives: [], objective_events: [], objective_decisions: [],
}, extra);

const OPEN = { closedThrough: async () => null, openPeriod: async () => ({ id: 'per' }) };
const sources = (reportText) => ({
  graphConfigured: () => true, mailboxes: () => ['ed@example.test'], driveOwner: () => 'ed@example.test',
  searchMail: async (_m, q) => ({ messages: /5922|13705/.test(q) ? [{ id: 'm1', subject: 'RMWBH Status Report - Waterview', received_at: '2026-05-28', from: { email: 'status@rmwbh.test' }, has_attachments: true, web_link: 'L1' }] : [] }),
  attachmentTexts: async () => [{ name: 'RMWBH Status Report.pdf', text: reportText }],
  searchDrive: async () => ({ items: [{ id: 'd1', name: 'Martinez - Notice of Violation Hearing.pdf', web_url: 'W1' }] }),
  driveText: async () => WV_NOTICE,
  governingDocs: async () => ({ sources: [{ filename: 'WV Declaration.pdf' }], context: 'Owner shall pay reasonable attorney fees incurred in enforcement.' }),
});
const DRV_REPORT = 'Deed Restriction DRV Litigation Martinez, Ricardo Ignacio (5922 Spring Sunrise Dr) 13705-20061 Last Action: 05/25/26 Pending - Return of executed Affidavit (Lit) (DRV) 01/20/26 trailer violation remained open.';
const BK_REPORT = 'Collection Martinez, Ricardo Ignacio (5922 Spring Sunrise Dr) 13705-20061 Last Action: 05/25/26 owner filed bankruptcy; BK-Monitoring Bankruptcy, case is still active.';
function posters(db) {
  const calls = { je: [], charge: [] };
  return { calls, postJE: async (o) => { calls.je.push(o); const e = { id: `je-${calls.je.length}`, source_module: o.source_module, source_reference: o.source_reference, status: 'posted' }; db.tables.journal_entries.push(e); return { entry: e }; },
    postCharge: async (_s, o) => { calls.charge.push(o); const r = { id: `ht-${calls.charge.length}`, community_id: o.communityId, property_id: o.propertyId, txn_type: 'charge', description: o.description, raw_row_jsonb: o.raw }; db.tables.homeowner_transactions.push(r); return { chargeId: r.id }; } };
}
const open = (db, kind) => db.tables.objectives.find((o) => o.subject_key === `${kind}:${INV}` && o.status !== 'resolved');
const objective = (db, kind) => db.tables.objectives.filter((o) => o.subject_key === `${kind}:${INV}`).pop();

t('A: supported recovery runs end to end; attorney payment and recovery close on their own criteria', async () => {
  const db = db0(seed()); const load = loaderFor(db); const P = posters(db);
  const deps = { loadInvoice: load, sources: sources(DRV_REPORT), periods: OPEN };
  // 1. intake -> team
  const r1 = await TEAM.runLegalTeam(db, INV, { trigger: 'intake', deps });
  assert.ok(r1.ok && !r1.skipped, JSON.stringify(r1));
  const review = db.tables.legal_invoice_reviews[0];
  assert.ok(['emma-ai@bedrocktx.com', 'amanda-ai@bedrocktx.com'].includes(review.updated_by), 'Emma drafted, Amanda refined (AI-owned)');
  const d1 = await load(db, INV);
  const owner = d1.saved.items.flatMap((i) => i.allocations).find((a) => a.property_id === '11111111-1111-4111-8111-111111111111');
  assert.strictEqual(owner.classification, 'homeowner_recoverable'); assert.strictEqual(owner.charge_category, 'attorney_fee_other', 'deed-restriction fee category');
  assert.ok(/^Amanda \(AI\): READY FOR APPROVAL - .* on file with certified mailing\./.test(owner.note));
  const amanda = db.tables.objective_decisions.find((x) => x.decided_by === 'amanda');
  const f = amanda.evidence.findings[0];
  assert.ok(f.evidence.content.length && f.evidence.mailing.length && !f.evidence.delivery.length, 'content and mailing verified; delivery not claimed');
  assert.ok(db.tables.objective_decisions.some((x) => x.decided_by === 'emma') && db.tables.objective_decisions.some((x) => x.decided_by === 'kat'));
  assert.ok(open(db, 'legal_invoice') && open(db, 'legal_recovery'), 'payment and recovery activities open');
  // 2. re-run with nothing new: no new decisions, no new activities
  const nDec = db.tables.objective_decisions.length, nObj = db.tables.objectives.length;
  await TEAM.runLegalTeam(db, INV, { trigger: 'manual', deps });
  assert.strictEqual(db.tables.objective_decisions.length, nDec); assert.strictEqual(db.tables.objectives.length, nObj);
  // 3. the owner confirms the association line (a person's save; the AI never rewrites it afterwards)
  const d2 = await load(db, INV);
  const items = d2.saved.items.map((it) => ({ source_line_ids: it.source_line_ids, matter_ref: it.matter_ref, allocations: it.allocations.map((a) => ({ amount_cents: a.amount_cents, classification: a.property_id ? a.classification : 'association_legal_expense', property_id: a.property_id || null, charge_category: a.charge_category || null, note: a.note, confirmed: true })) }));
  const built = R.buildDraft(d2, { items }, 'owner@example.test');
  assert.ok(!built.errors, JSON.stringify(built.errors));
  await db.rpc('legal_review_save_draft', { p_ap_invoice_id: INV, p_community_id: C, p_base_revision: d2.saved.review.revision, p_actor: 'owner@example.test', p_items: built.items, p_summary: {} });
  await TEAM.runLegalTeam(db, INV, { trigger: 'manual', deps });
  assert.strictEqual(db.tables.legal_invoice_reviews[0].updated_by, 'owner@example.test', 'research never overwrites the person\'s draft');
  const kat = db.tables.objective_decisions.filter((x) => x.decided_by === 'kat').pop();
  assert.strictEqual(kat.verdict, 'PROPOSE_ACTION', JSON.stringify(kat.evidence.checks.filter((c) => !c.ok)));
  assert.ok(/^Approval required/.test(open(db, 'legal_recovery').title));
  // 4. the owner approves: postings balanced, linked, idempotent; never AP
  const d3 = await load(db, INV);
  const ap = await T.approveTreatment(db, d3, { actor: 'owner@example.test', baseRevision: d3.saved.review.revision, deps: { periods: OPEN, postJE: P.postJE, postCharge: P.postCharge } });
  assert.ok(ap.ok, JSON.stringify(ap));
  assert.strictEqual(P.calls.je.length, 1);
  const je = P.calls.je[0];
  assert.strictEqual(je.lines[0].account_id, 'a1300'); assert.strictEqual(je.lines[1].account_id, 'a5870', 'credited back to the account the line accrued to');
  assert.strictEqual(je.lines[0].debit_cents, je.lines[1].credit_cents);
  assert.ok(je.lines.every((l) => l.account_id !== 'a2000'));
  const post = db.tables.legal_invoice_postings[0];
  assert.deepStrictEqual(post.ap_invoice_line_ids, ['l1']); assert.strictEqual(post.status, 'posted');
  assert.strictEqual(P.calls.charge[0].raw.legal_posting_id, post.id);
  const again = await T.approveTreatment(db, await load(db, INV), { actor: 'owner@example.test', baseRevision: d3.saved.review.revision, deps: { periods: OPEN, postJE: P.postJE, postCharge: P.postCharge } });
  assert.ok(again.ok && again.posted.length === 0 && P.calls.je.length === 1, 'idempotent');
  // 5. activities: recovery resolves on posting; payment stays open until paid
  await TEAM.updateActivity(db, INV, 'posted', { loadInvoice: load });
  assert.ok(!open(db, 'legal_recovery'), 'recovery resolved'); assert.ok(/homeowner charges posted/.test(objective(db, 'legal_recovery').closed_reason));
  assert.ok(open(db, 'legal_invoice'), 'payment still open');
  db.tables.ap_invoices[0].status = 'paid';
  await TEAM.updateActivity(db, INV, 'paid', { loadInvoice: load });
  assert.ok(!open(db, 'legal_invoice') && !open(db, 'legal_documentation'), 'all closed');
});

t('B: bankruptcy holds the owner charge; paying the attorney closes only the payment activity', async () => {
  const db = db0(seed()); const load = loaderFor(db);
  const deps = { loadInvoice: load, sources: Object.assign(sources(BK_REPORT), { searchDrive: async () => { throw Object.assign(new Error('Item not found'), { status: 404 }); } }), periods: OPEN };
  await TEAM.runLegalTeam(db, INV, { trigger: 'intake', deps });
  const f = db.tables.objective_decisions.find((x) => x.decided_by === 'amanda').evidence.findings[0];
  assert.strictEqual(f.recommendation, 'hold'); assert.ok(f.inaccessible.includes('OneDrive'));
  assert.ok(f.judgment.some((j) => /active bankruptcy/.test(j)));
  assert.strictEqual(f.external_request, null, 'no outside request while an internal source was inaccessible');
  const rec = open(db, 'legal_recovery');
  assert.strictEqual(rec.autonomy_class, 'BLOCK');
  assert.ok(open(db, 'legal_documentation'), 'documentation gap tracked separately');
  db.tables.ap_invoices[0].status = 'paid';
  await TEAM.updateActivity(db, INV, 'paid', { loadInvoice: load });
  assert.ok(!open(db, 'legal_invoice'), 'attorney payment closed');
  assert.ok(open(db, 'legal_recovery') && open(db, 'legal_documentation'), 'recovery and documentation stay open after payment');
});

(async () => {
  for (const [n, f] of pending) {
    try { await f(); pass++; console.log('  ok   ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n        ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); }
  }
  console.log(`\n${pass} passed${fail ? ', FAILURES above' : ''}`);
  if (fail) process.exit(1);
})();
