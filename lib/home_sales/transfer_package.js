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
async function executePackage(supabase, { communityId, fingerprint: seen, owner, authorization = null, deps = {} }) {
  // Two ways the owner approves the package, never mixed up: the signed-in owner's click (owner), or
  // the owner's verified reply to Tessa's Owner Authorization Service request (authorization, migration 583).
  if (authorization) {
    if (authorization.status !== 'authorized' || authorization.scope !== 'closing_packages' || !authorization.authorized_by_email) throw Object.assign(new Error('no authorized closing package authorization'), { code: 'approval_required' });
  } else if (!owner || !owner.email) throw Object.assign(new Error('the signed-in owner is required'), { code: 'approval_required' });
  const TP = deps.TP || require('../accounting/transfer_proration');
  const R = deps.R || require('../accounting/monthly_runs');
  const pkg = await buildPackage(supabase, { communityId, deps });
  if (!pkg.rows.length) throw Object.assign(new Error('nothing to approve'), { code: 'empty' });
  if (pkg.fingerprint !== seen) throw Object.assign(new Error('the package changed since it was shown; review it again'), { code: 'stale_package', package: pkg });
  if (authorization) {
    const authorized = new Set((authorization.items || []).map((i) => i.proposal_id));
    if (pkg.rows.length !== authorized.size || pkg.rows.some((r) => !authorized.has(r.proposal_id))) throw Object.assign(new Error('the package lists other transfers than the owner authorized'), { code: 'stale_package', package: pkg });
  }
  const reviewer = authorization
    ? `${authorization.authorized_by_email} (owner, authorized by email reply, owner authorization ${authorization.id}; executed by Kat with Reese)`
    : `${owner.email} (owner, transfer package ${pkg.fingerprint.slice(0, 8)})`;
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
      const approval = authorization ? { channel: 'owner_closing_package', authorization_id: authorization.id } : { channel: 'in_app', user_id: owner.user_id, email: owner.email };
      if (ids.length) await R.approveAndPost(supabase, { run_id: run.id, approval, include: ids });
      const after = await must(supabase.from('accounting_runs').select('status, result').eq('id', run.id).single(), 'capitalization run');
      capitalization.status = after.status;
      capitalization.posted = ((after.result || {}).posted || []).length;
    } catch (e) { capitalization.error = e.message; console.error('[transfer-package] capitalization not posted', JSON.stringify({ communityId, error: e.message })); }
  }
  return { fingerprint: pkg.fingerprint, totals: pkg.totals, results, transferred: done.size, failed: results.length - done.size, capitalization };
}

// ----------------------------------------------------------------------------
// Owner Authorization Service (migration 583): the same package, requested by Tessa and approved
// by the owner's verified reply, then executed by executePackage above. No second package.
// ----------------------------------------------------------------------------
const usd = (c) => (Number(c) < 0 ? '-' : '') + '$' + (Math.abs(Number(c)) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDay = (d) => { const [y, m, dd] = String(d).slice(0, 10).split('-').map(Number); return `${m}/${dd}/${y}`; };

// PURE: the request items (numbered), each carrying the package fingerprint.
function authorizationItems(pkg) {
  return pkg.rows.map((r, i) => ({ n: i + 1, object_type: 'ownership_transfer', proposal_id: r.proposal_id, community_id: pkg.community_id, property_id: r.property_id,
    address: r.address, settlement_date: r.settlement_date, buyer: r.buyer, seller: r.seller, builder_adjustment_cents: r.builder_adjustment_cents,
    homeowner_due_cents: r.homeowner_due_cents, capitalization_cents: r.capitalization_cents, fingerprint: pkg.fingerprint }));
}

function requestSubject(code, communityName, t) {
  return `Owner authorization ${code}: closing package, ${communityName}, ${t.transfers} ownership transfer${t.transfers === 1 ? '' : 's'}, ${usd(t.builder_adjustment_cents + t.homeowner_due_cents + t.capitalization_cents)} in new charges`;
}

// PURE: Tessa's request email.
function renderRequest({ subject, pkg, communityName, expiresAt }) {
  const t = pkg.totals; const all = t.builder_adjustment_cents + t.homeowner_due_cents + t.capitalization_cents;
  const lines = pkg.rows.map((r, i) => `${i + 1}. ${r.address}, settled ${fmtDay(r.settlement_date)}, to ${r.buyer}: builder ${usd(r.builder_adjustment_cents)}, buyer ${usd(r.homeowner_due_cents)}, capitalization ${r.capitalization_cents ? usd(r.capitalization_cents) : 'none (' + (r.capitalization_note || 'not charged') + ')'}`);
  const excluded = pkg.excluded.map((x) => `- ${x.address}${x.settlement_date ? ' (' + fmtDay(x.settlement_date) + ')' : ''}: ${x.reason}`);
  const intro = `The ${communityName} closing package is ready: ${t.transfers} ownership transfer${t.transfers === 1 ? '' : 's'} from the builder to the first homeowner, each at its recorded settlement date. Previously billed amounts stay as billed; nothing is credited or adjusted retroactively.`;
  const what = `New charges: builder unbilled days ${usd(t.builder_adjustment_cents)}, buyer shares of the year ${usd(t.homeowner_due_cents)}, buyer capitalization fees ${usd(t.capitalization_cents)}. Total ${usd(all)}.`;
  const how = `Reply "approved" to authorize exactly these transfers and charges. Reese records each transfer through Ownership Review, its proration posts with it, and Kat then posts the capitalization fees on the buyers and reports back. If anything in the package changes before then, nothing is carried out. Reply anything else (or nothing) and nothing happens. This request expires ${expiresAt}. No money moves and no refunds are issued under this request.`;
  const text = ['Ed,', '', intro, '', what, '', how, '', ...lines, '', ...(excluded.length ? ['Not in this package (they stay on their own paths):', ...excluded, ''] : []), 'Tessa'].join('\n');
  const rows = pkg.rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.address)}</td><td>${fmtDay(r.settlement_date)}</td><td>${esc(r.buyer)}</td><td style="text-align:right">${usd(r.builder_adjustment_cents)}</td><td style="text-align:right">${usd(r.homeowner_due_cents)}</td><td style="text-align:right">${r.capitalization_cents ? usd(r.capitalization_cents) : esc(r.capitalization_note || 'none')}</td></tr>`).join('');
  const html = `<p>Ed,</p><p>${esc(intro)}</p><p><b>${esc(what)}</b></p><p>${esc(how)}</p>`
    + `<table style="border-collapse:collapse;font-family:Arial;font-size:13px" cellpadding="4" border="1"><tr><th>#</th><th>Property</th><th>Settled</th><th>Buyer</th><th>Builder (unbilled days)</th><th>Buyer share</th><th>Capitalization fee</th></tr>${rows}`
    + `<tr style="font-weight:bold"><td></td><td colspan="3">Total (${t.transfers})</td><td style="text-align:right">${usd(t.builder_adjustment_cents)}</td><td style="text-align:right">${usd(t.homeowner_due_cents)}</td><td style="text-align:right">${usd(t.capitalization_cents)}</td></tr></table>`
    + (excluded.length ? `<p>Not in this package (they stay on their own paths):</p><ul>${pkg.excluded.map((x) => `<li>${esc(x.address)}${x.settlement_date ? ' (' + fmtDay(x.settlement_date) + ')' : ''}: ${esc(x.reason)}</li>`).join('')}</ul>` : '')
    + '<p>Tessa</p>';
  return { subject, text, html };
}

// One request for the community's package, from Tessa's mailbox. Sends nothing else.
async function requestAuthorization({ supabase, rpc, send, communityId, ownerEmail, fromMailbox, summary, hours = 72, deps = {} }) {
  const pkg = await buildPackage(supabase, { communityId, deps });
  if (!pkg.rows.length) throw Object.assign(new Error('no completed builder closings are pending'), { code: 'empty' });
  const open = await must(supabase.from('owner_authorizations').select('id, subject, items').eq('scope', 'closing_packages').in('status', ['requested', 'authorized']).limit(50), 'open requests');
  const dup = open.find((a) => (a.items || []).some((i) => pkg.rows.some((r) => r.proposal_id === i.proposal_id)));
  if (dup) throw Object.assign(new Error(`an open request already covers these transfers: ${dup.subject}`), { code: 'duplicate_request' });
  const comm = await must(supabase.from('communities').select('name').eq('id', communityId).maybeSingle(), 'community');
  const name = (comm && comm.name) || 'Community';
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  const subject = requestSubject(code, name, pkg.totals);
  const items = authorizationItems(pkg);
  const r = await rpc('owner_authorization_request_closing_package', { p_subject: subject, p_summary: summary, p_community_id: communityId, p_items: items, p_owner_email: ownerEmail, p_requested_by: 'ai-team:amanda', p_hours: hours });
  const expiresAt = new Date(Date.now() + hours * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const mail = renderRequest({ subject, pkg, communityName: name, expiresAt });
  const sent = await send({ from: fromMailbox, to: ownerEmail, subject: mail.subject, text: mail.text, html: mail.html });
  if (!sent || !sent.internetMessageId || !sent.conversationId) throw new Error('the request email was not sent with a message identity; nothing can authorize it');
  await rpc('owner_authorization_sent', { p_id: r.id, p_message_id: sent.internetMessageId, p_conversation_id: sent.conversationId });
  const AZ = require('../authorization');
  await AZ.recordEvents(supabase, items.flatMap((i) => ['requested', 'sent'].map((event) => ({ community_id: communityId, authority_kind: 'request', authorization_id: r.id,
    action_type: 'closing_package', target_id: i.proposal_id, fingerprint: i.fingerprint, event, channel: 'email', requested_by: 'ai-team:amanda',
    evidence: event === 'sent' ? { subject, request_message_id: sent.internetMessageId, conversation_id: sent.conversationId } : { summary, settlement_date: i.settlement_date } }))));
  return { id: r.id, subject, transfers: items.length, totals: pkg.totals, items_sha256: r.items_sha256 };
}

// Execute an AUTHORIZED request (lib/authorization/actions adapter): the existing package workflow.
async function executeAuthorized(ctx, authorization) {
  const items = authorization.items || [];
  const out = await executePackage(ctx.supabase, { communityId: items[0] && items[0].community_id, fingerprint: items[0] && items[0].fingerprint, authorization, deps: ctx.deps || {} });
  const capOk = !out.capitalization.error && (out.capitalization.prepared === 0 || out.capitalization.status === 'posted');
  if (!out.failed && capOk && ctx.rpc) await ctx.rpc('owner_authorization_mark_executed', { p_id: authorization.id, p_execution: { transferred: out.transferred, failed: out.failed, capitalization: out.capitalization, results: out.results } });
  return { ...out, ok: !out.failed && capOk };
}

function renderCompletion(authorization, out) {
  const lines = out.results.map((r) => `- ${r.address}: ${r.transferred ? `transferred at ${fmtDay(r.settlement_date)}, proration ${r.proration}${r.proration_error ? ' (' + r.proration_error + ')' : ''}` : 'NOT transferred: ' + r.error}`);
  const c = out.capitalization || {};
  const cap = c.error ? `Capitalization fees NOT posted: ${c.error}` : `Capitalization fees: ${c.posted || 0} of ${c.prepared || 0} posted (run ${String(c.run_id || '').slice(0, 8)}).`;
  const text = ['Ed,', '', `Your authorization ${authorization.id.slice(0, 8)} was carried out: ${out.transferred} transfer(s) recorded, ${out.failed} not.`, cap, '', ...lines, '',
    out.ok ? 'Every authorized transfer and charge posted and was checked.' : 'Anything not carried out stays as it was; Amanda follows it up.', '', 'Tessa'].join('\n');
  return { subject: `Done: ${authorization.subject}`, text, html: `<pre style="font-family:Consolas,monospace;font-size:12px;white-space:pre-wrap">${esc(text)}</pre>` };
}

module.exports = { buildPackage, executePackage, capitalizationItems, fingerprint, totals, capItemId, capSourceRef,
  authorizationItems, requestSubject, renderRequest, requestAuthorization, executeAuthorized, renderCompletion };
