// ============================================================================
// lib/home_sales/transfer_package.js  (Ed 2026-11-26: one approval for completed builder closings)
// ----------------------------------------------------------------------------
// Ed: "Prepare one consolidated approval package showing the ownership changes, their effective
// closing dates, the builder and buyer prorations and the buyer capitalization charges. Once
// authorized, execute the transfers and capitalization charges using the existing workflows,
// without duplicate assessments or fees. Do not require me to navigate and approve each lot."
//
// Nothing new posts here. The package only GROUPS the existing workflows behind one owner click:
//   transfer        the Ownership Review path: gateTransferProration (the proration the screen
//                   shows), approve_ownership_proposal (the one transfer path), afterTransfer
//                   (posts the builder's unbilled days and the buyer's share)
//   capitalization  one Kat journal-entry run (lib/accounting/journal_entry_runs), Dr 1300 /
//                   Cr 4020 per lot with the buyer's owner charge, approved through
//                   monthly_runs.approveAndPost with the signed-in owner's in-app approval
//
// Included: pending transfers whose seller is a builder under the proration program (the gate
// asks for confirmation) and whose settlement is on or after the GL cutover. Everything else is
// listed as excluded with the reason (exception paths stay where they are).
// Duplicate protection: the package fingerprint must match what the owner saw; each capitalization
// item id is stable per proposal (posts once); a lot already carrying a capitalization charge for
// the buyer, or a posted entry for that item, gets no second fee; the database refuses re-approval.
// The capitalization run is prepared only AFTER the transfers, so each fee lands on the buyer.
// ============================================================================
const crypto = require('crypto');

async function must(q, what) { const { data, error } = await q; if (error) throw new Error(`${what}: ${error.message}`); return data; }
const capItemId = (proposalId) => `capfee-${proposalId}`;
const capSourceRef = (communityId, proposalId) => `KATJE:${communityId}:${capItemId(proposalId)}`;
const MAX = 50;   // one Kat journal-entry run holds at most 50 entries

// PURE: the fingerprint of exactly what the owner is shown.
function fingerprint(rows) {
  const core = rows.map((r) => [r.proposal_id, r.settlement_date, r.buyer, r.builder_adjustment_cents, r.homeowner_due_cents, r.capitalization_cents]);
  return crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex');
}
function totals(rows) {
  return rows.reduce((t, r) => ({ transfers: t.transfers + 1, builder_adjustment_cents: t.builder_adjustment_cents + r.builder_adjustment_cents,
    homeowner_due_cents: t.homeowner_due_cents + r.homeowner_due_cents, capitalization_cents: t.capitalization_cents + r.capitalization_cents }),
  { transfers: 0, builder_adjustment_cents: 0, homeowner_due_cents: 0, capitalization_cents: 0 });
}

// A capitalization charge already on the lot dated on/after this settlement, or Kat's entry for this proposal.
async function capitalizationAlready(supabase, { communityId, propertyId, proposalId, settlementDate }) {
  const je = await must(supabase.from('journal_entries').select('id').eq('source_reference', capSourceRef(communityId, proposalId)).neq('status', 'voided').limit(1), 'capitalization entry');
  if (je.length) return 'already posted for this closing';
  const ht = await must(supabase.from('homeowner_transactions').select('id, transaction_date').eq('property_id', propertyId).eq('txn_type', 'charge')
    .ilike('description', '%capitaliz%').gte('transaction_date', settlementDate).limit(1), 'capitalization charges');
  return ht.length ? 'a capitalization charge is already on this lot for this closing' : null;
}

async function buildPackage(supabase, { communityId, deps = {} }) {
  const TP = deps.TP || require('../accounting/transfer_proration');
  const CS = deps.CS || require('../accounting/closing_statement');
  const cutover = await (deps.cutover || require('../accounting/cutover').getGlCutoverDate)(supabase, communityId);
  const cap = await CS.loadCapitalization(supabase, communityId);
  const pend = await must(supabase.from('ownership_change_proposals').select('id, property_id, proposed_owner_name, effective_start_date, properties(street_address)')
    .eq('community_id', communityId).eq('status', 'pending').order('created_at').limit(500), 'pending transfers');
  const rows = []; const excluded = [];
  for (const p of pend) {
    const address = (p.properties && p.properties.street_address) || p.property_id;
    const out = (reason) => excluded.push({ proposal_id: p.id, address, settlement_date: p.effective_start_date || null, buyer: p.proposed_owner_name, reason });
    if (!p.effective_start_date) { out('no settlement date on the proposal'); continue; }
    if (cutover && String(p.effective_start_date) < String(cutover)) { out(`dated before the GL cutover (${cutover}); stays on its exception path`); continue; }
    const openT = await must(supabase.from('ownership_tenures').select('id').eq('property_id', p.property_id).eq('kind', 'owner').is('end_date', null).limit(2), 'seller tenure');
    if (openT.length !== 1) { out(openT.length ? 'more than one current owner on file' : 'no current owner on file; record the seller first'); continue; }
    const g = await TP.gateTransferProration(supabase, { propertyId: p.property_id, sellerTenureId: openT[0].id, settlementDate: p.effective_start_date, buyerName: p.proposed_owner_name });
    if (g.proceed) { out('not a builder closing under the proration program; approve it in Ownership Review'); continue; }
    if (!g.body || g.body.code !== 'proration_confirmation_required') { out((g.body && g.body.error) || 'the proration cannot be confirmed'); continue; }
    const plan = g.body.proration;
    let capCents = 0; let capNote = null;
    if (!cap.configured) capNote = `capitalization fee not configured (${cap.reason})`;
    else {
      capNote = await capitalizationAlready(supabase, { communityId, propertyId: p.property_id, proposalId: p.id, settlementDate: p.effective_start_date });
      if (!capNote) capCents = cap.amount_cents;
    }
    rows.push({ proposal_id: p.id, property_id: p.property_id, address, settlement_date: p.effective_start_date, buyer: p.proposed_owner_name,
      seller: (plan.seller_names || []).join('; ') || plan.builder || null,
      builder_adjustment_cents: Number(plan.builder_adjustment_cents || 0), homeowner_due_cents: Number(plan.homeowner_due_cents || 0),
      builder_prior_billed_cents: Number(plan.builder_prior_billed_cents || 0), capitalization_cents: capCents, capitalization_note: capNote,
      differences: (plan.ownership && plan.ownership.difference_text) || [] });
  }
  rows.sort((a, b) => String(a.address).localeCompare(String(b.address)));
  if (rows.length > MAX) throw Object.assign(new Error(`${rows.length} transfers is more than one package holds (${MAX})`), { code: 'too_many' });
  return { community_id: communityId, cutover_date: cutover || null, capitalization: cap, rows, excluded, totals: totals(rows), fingerprint: fingerprint(rows) };
}

// Kat's journal-entry items for the capitalization fees of the transferred rows.
function capitalizationItems(rows, { communityName = '' } = {}) {
  return rows.filter((r) => r.capitalization_cents > 0).map((r) => ({
    id: capItemId(r.proposal_id), label: `Capitalization fee ${r.address}`, posting_date: r.settlement_date,
    description: `Capitalization Fees - RE: Ownership Transfer, ${r.address}`.slice(0, 200),
    lines: [{ account_number: '1300', debit_cents: r.capitalization_cents, memo: r.buyer }, { account_number: '4020', credit_cents: r.capitalization_cents, memo: 'Capitalization Fee' }],
    homeowner: { property_id: r.property_id, charge_category: 'other' },
    evidence: { basis: `Initial homeowner purchase from the builder, recorded ${r.settlement_date} (transfer ${r.proposal_id}); capitalization fee per the ${communityName || 'association'} rate on file, payable by the buyer.`, proposal_id: r.proposal_id },
  }));
}

/**
 * Execute the package the owner saw. `owner` = { user_id, email } from the signed-in owner session.
 * Refuses when the package changed since it was shown. Each transfer runs through the existing
 * path; a failure is reported and never undoes the others. Capitalization fees post only for the
 * lots whose transfer completed.
 */
async function executePackage(supabase, { communityId, fingerprint: seen, owner, deps = {} }) {
  if (!owner || !owner.email) throw Object.assign(new Error('the signed-in owner is required'), { code: 'approval_required' });
  const TP = deps.TP || require('../accounting/transfer_proration');
  const R = deps.R || require('../accounting/monthly_runs');
  const pkg = await buildPackage(supabase, { communityId, deps });
  if (!pkg.rows.length) throw Object.assign(new Error('nothing to approve'), { code: 'empty' });
  if (pkg.fingerprint !== seen) throw Object.assign(new Error('the package changed since it was shown; review it again'), { code: 'stale_package', package: pkg });
  const reviewer = `${owner.email} (owner, transfer package ${pkg.fingerprint.slice(0, 8)})`;
  const results = [];
  for (const r of pkg.rows) {
    const res = { proposal_id: r.proposal_id, address: r.address, settlement_date: r.settlement_date };
    try {
      const openT = await must(supabase.from('ownership_tenures').select('id').eq('property_id', r.property_id).eq('kind', 'owner').is('end_date', null).single(), 'seller tenure');
      const gate = await TP.gateTransferProration(supabase, { propertyId: r.property_id, sellerTenureId: openT.id, settlementDate: r.settlement_date, buyerName: r.buyer, confirmed: true });
      if (!gate.proceed) throw new Error((gate.body && gate.body.error) || 'the proration gate refused');
      const { error } = await supabase.rpc('approve_ownership_proposal', { p_proposal_id: r.proposal_id, p_reviewed_by: reviewer, p_notes: 'Approved in the owner transfer package', p_settlement_date: r.settlement_date });
      if (error) throw new Error(error.message);
      res.transferred = true;
      const pr = await TP.afterTransfer(supabase, gate, { proposalId: r.proposal_id, postedBy: reviewer });
      res.proration = pr ? (pr.status || 'posted') : 'not_applicable';
      if (pr && pr.status === 'pending') res.proration_error = pr.error;
    } catch (e) { res.transferred = res.transferred || false; res.error = e.message; }
    results.push(res);
  }
  const done = new Set(results.filter((x) => x.transferred).map((x) => x.proposal_id));
  const comm = await must(supabase.from('communities').select('name').eq('id', communityId).maybeSingle(), 'community');
  const items = capitalizationItems(pkg.rows.filter((r) => done.has(r.proposal_id)), { communityName: comm && comm.name });
  let capitalization = { prepared: 0, posted: 0 };
  if (items.length) {
    try {
      const prep = await R.prepare(supabase, { community_id: communityId, process: 'journal_entry', period_month: new Date().toISOString().slice(0, 8) + '01', actor: `${R.KAT} (owner transfer package)`, items });
      if (prep.skipped || prep.failed) throw new Error(prep.skipped || prep.error);
      const run = prep.run;
      capitalization = { run_id: run.id, prepared: items.length, posted: 0 };
      const ids = ((run.preview || {}).items || []).filter((i) => !i.already).map((i) => i.id);
      if (ids.length) await R.approveAndPost(supabase, { run_id: run.id, approval: { channel: 'in_app', user_id: owner.user_id, email: owner.email }, include: ids });
      const after = await must(supabase.from('accounting_runs').select('status, result').eq('id', run.id).single(), 'capitalization run');
      capitalization.status = after.status;
      capitalization.posted = ((after.result || {}).posted || []).length;
    } catch (e) { capitalization.error = e.message; console.error('[transfer-package] capitalization not posted', JSON.stringify({ communityId, error: e.message })); }
  }
  return { fingerprint: pkg.fingerprint, totals: pkg.totals, results, transferred: done.size, failed: results.length - done.size, capitalization };
}

module.exports = { buildPackage, executePackage, capitalizationItems, fingerprint, totals, capItemId, capSourceRef };
