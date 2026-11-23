// ============================================================================
// lib/ar/monthly_interest.js  (Ed 2026-10-11)
// ----------------------------------------------------------------------------
// THE monthly late-interest process on trustEd's authoritative homeowner
// ledger (tenure-aware homeowner_transactions, committed batches only). One
// reusable engine, generalized from the LOPF 8/1/2026 posting
// (scripts/lopf/post_interest_2026_08.js on ops/lopf-interest-2026-08); it
// replaces neither the legacy Billing-policy run (native ar_charges, a ledger
// converted communities do not use) nor anything else: Kat prepares it through
// lib/accounting/monthly_runs.js and a person approves before anything posts.
//
// Rule (configurable per community, community_accounting_automation.settings):
//   interest = round(eligible assessment principal x rate_bps / 10000 / 12)
//   eligible principal = assessment charges past due by more than grace_days
//     (due = charge date + due_offset_days; a conversion balance brought forward
//     is already past due), less receipts dated on or before the run date,
//     applied to delinquent assessments FIRST (Tex. Prop. Code 209.0063 step 1,
//     the same order as payment_application_step in migration 469). Returned
//     payments add back. Never on prior interest, late fees, attorney fees,
//     fines or other charges.
//   Only the tenure that owns the lot on the run date is charged (former owners:
//   none). A tenure already charged interest for the run date is skipped
//   (idempotent per property + month).
//   An assessment credit or correction (charge_category 'assessment', negative) reduces
//   principal from its own date: delinquent assessments first, then current ones.
//   There is no default rate or grace: each association's policy is configured
//   (requirePolicy), or nothing is calculated.
// Exceptions are proposed, never auto-charged: attorney fees on the account or the lot
// at legal, a payment plan, a returned payment in the period, an unapplied or
// unclassified credit, or interest already on the lot whose owner is unclear.
// Posted interest is never edited: reviewPostedInterest recalculates each posted month
// on the ledger as it stands now (late-entered payments, corrections) and lists the
// correcting amount for approval.
// ============================================================================

const RECEIPT_CATS = new Set(['payment', 'credit', 'refund']);
const REVERSAL_CATS = new Set(['payment_reversal', 'chargeback']);
const day = (d) => String(d || '').slice(0, 10);
const addDays = (iso, n) => { const d = new Date(`${day(iso)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const money = (c) => (Number(c) / 100).toFixed(2);

function isReturn(r) {
  if (r.reverses_txn_id || REVERSAL_CATS.has(r.charge_category)) return true;
  return Number(r.amount_cents) > 0 && r.charge_category === 'adjustment' && /return|reversal|nsf|chargeback/i.test(String(r.description || ''));
}
function isReceipt(r) {
  return Number(r.amount_cents) < 0 && (r.txn_type === 'payment' || RECEIPT_CATS.has(r.charge_category));
}

// PURE. rows: committed homeowner_transactions; tenures; properties; opts.
// Ed 2026-11-17: the CALCULATION cutoff (asOfDate, e.g. the prior month-end) is separate from the run /
// posting date. Only rows dated on or before the cutoff count. A month is charged once: any interest
// already recorded in the run's month (from any source, on any day of that month) marks the owner
// already charged. Bankruptcy (collections status, or a ledger entry naming it) is an exception.
function computeInterest({ rows = [], tenures = [], properties = [], runDate, asOfDate = null, cutoverDate = null, settings = {}, collections = [], enforcement = [], plans = [] }) {
  const run = day(runDate); const cutoff = day(asOfDate || runDate); const runMonth = run.slice(0, 7);
  const bankruptProps = new Set((collections || []).filter((c) => c.collection_status === 'bankruptcy').map((c) => c.property_id));
  const stateOf = new Map((enforcement || []).map((e) => [e.property_id, e.state]));
  const planProps = new Set((plans || []).filter((x) => x.status === 'active').map((x) => x.property_id));
  const interestNoOwner = new Set();
  const rateBps = Number(settings.rate_bps ?? 1000), grace = Number(settings.grace_days ?? 30), offset = Number(settings.due_offset_days ?? 0);
  const P = new Map(properties.map((p) => [p.id, p]));
  const ownerOn = (pid, d) => tenures.filter((t) => t.property_id === pid && t.kind === 'owner' && (!t.start_date || day(t.start_date) <= d) && (!t.end_date || day(t.end_date) >= d));
  const acc = new Map();
  const get = (tid) => { if (!acc.has(tid)) acc.set(tid, { tenure_id: tid, eligible_charges: 0, current_charges: 0, receipts: 0, returns: 0, attorney: 0, credit_open: 0, assessment_credits: 0, unclassified: 0, existing_interest: 0, plan: false, contact_id: null, notes: [] }); return acc.get(tid); };
  const unmatched = [];
  let latestReceipt = null;
  for (const r of rows) {
    const d = day(r.transaction_date);
    if (!d) continue;
    // the period guard sees interest in the run's month even when it is dated after the cutoff
    const periodInterest = r.charge_category === 'interest' && d.slice(0, 7) === runMonth && r.txn_type !== 'balance_brought_forward' && !(cutoverDate && d < day(cutoverDate));
    if (d > cutoff && !periodInterest) continue;
    if (isReceipt(r) && (!latestReceipt || d > latestReceipt)) latestReceipt = d;
    let tid = r.tenure_id;
    const broughtFwd = r.txn_type === 'balance_brought_forward' || (cutoverDate && d < day(cutoverDate));
    if (!tid && broughtFwd) continue;   // conversion balances with no owner tenure (former owners): never charged, not a receipt
    if (!tid) {
      const c = r.property_id ? ownerOn(r.property_id, d) : [];
      if (c.length !== 1) { if (periodInterest) interestNoOwner.add(r.property_id); if (isReceipt(r) || isReturn(r)) unmatched.push({ id: r.id, property_id: r.property_id, date: d, amount_cents: Number(r.amount_cents), owners_found: c.length }); continue; }
      tid = c[0].id;
    }
    const b = get(tid); const amt = Number(r.amount_cents);
    if (!b.contact_id && r.contact_id) b.contact_id = r.contact_id;
    if (/payment plan/i.test(String(r.description || ''))) b.plan = true;
    if (/bankrupt/i.test(String(r.description || ''))) b.bankruptcy = true;
    const brought = r.txn_type === 'balance_brought_forward' || (cutoverDate && d < day(cutoverDate));
    if (r.charge_category === 'assessment') {
      const due = addDays(d, offset);
      if (!brought && amt < 0) b.assessment_credits += -amt;
      else if (brought || addDays(due, grace) < cutoff) b.eligible_charges += amt; else b.current_charges += amt;
    } else if (r.charge_category === 'attorney_fee' || r.charge_category === 'attorney_fee_other') b.attorney += amt;
    else if (periodInterest) b.existing_interest += amt;
    else if (brought && (r.charge_category === 'credit' || r.txn_type === 'credit') && amt < 0) b.credit_open += amt;
    else if (!brought && isReturn(r)) b.returns += amt;
    else if (!brought && isReceipt(r)) b.receipts += amt;   // negative
    else if (!brought && amt < 0 && r.charge_category === 'adjustment') b.unclassified += -amt;   // what it corrects is not recorded
  }
  const T = new Map(tenures.map((t) => [t.id, t]));
  const items = [];
  for (const b of acc.values()) {
    const t = T.get(b.tenure_id); if (!t) continue;
    const p = P.get(t.property_id) || {};
    const owner = t.kind === 'owner' && (!t.start_date || day(t.start_date) <= run) && (!t.end_date || day(t.end_date) >= run);
    const netCash = b.receipts + b.returns;                         // negative = money received
    const credited = Math.min(Math.max(b.eligible_charges, 0), b.assessment_credits);
    const delinquent = b.eligible_charges - credited;
    const applied = delinquent > 0 && netCash < 0 ? Math.min(delinquent, -netCash) : 0;
    const eligible = owner ? Math.max(delinquent - applied, 0) : 0;
    if (eligible <= 0 && !b.existing_interest) continue;
    const interest = Math.round(eligible * rateBps / 10000 / 12);
    const flags = [];
    const state = stateOf.get(t.property_id);
    if (b.attorney > 0) flags.push({ code: 'attorney', text: `Attorney fees on the account ($${money(b.attorney)}): likely at collections counsel.` });
    if (!(b.attorney > 0) && ['at_legal', 'lien_filed', 'judgment'].includes(state)) flags.push({ code: 'attorney', text: 'The lot is recorded at legal.' });
    if (b.plan || planProps.has(t.property_id) || state === 'on_payment_plan') flags.push({ code: 'payment_plan', text: 'A payment plan is recorded on the account.' });
    if (b.bankruptcy || bankruptProps.has(t.property_id) || state === 'in_bankruptcy') flags.push({ code: 'bankruptcy', text: 'Bankruptcy is recorded on the account (automatic stay / discharge): interest needs review.' });
    if (b.returns > 0) flags.push({ code: 'returned_payment', text: `Returned payment in the period ($${money(b.returns)}).` });
    if (b.credit_open < 0) flags.push({ code: 'unapplied_credit', text: `Holds an unapplied credit of $${money(-b.credit_open)}.` });
    if (b.unclassified > 0 && eligible > 0) flags.push({ code: 'unclassified_credit', text: `A credit of $${money(b.unclassified)} does not say whether it reduces the assessment.` });
    if (interestNoOwner.has(t.property_id)) flags.push({ code: 'interest_owner_unclear', text: `Interest is already on this lot in ${runMonth} with no clear owner.` });
    if (b.existing_interest) flags.push({ code: 'already_charged', text: `Interest of ${money(b.existing_interest)} is already recorded for ${runMonth}.` });
    items.push({
      tenure_id: t.id, property_id: t.property_id, address: p.street_address || null,
      vantaca_account_id: t.vantaca_account_id || p.vantaca_account_id || null, trusted_account_number: p.trusted_account_number || null, contact_id: b.contact_id,
      eligible_charges_cents: b.eligible_charges, assessment_credits_cents: credited, receipts_cents: -b.receipts, returns_cents: b.returns, applied_cents: applied,
      eligible_principal_cents: eligible, interest_cents: b.existing_interest ? 0 : interest,
      flags, exception: flags.some((f) => ['attorney', 'payment_plan', 'returned_payment', 'bankruptcy', 'unclassified_credit', 'unapplied_credit', 'interest_owner_unclear'].includes(f.code)), skip: !!b.existing_interest,
      description: `Interest ${run}: ${rateBps / 100}% per year / 12 on assessment principal ${money(eligible)} at ${cutoff} = ${money(interest)}`,
    });
  }
  items.sort((a, b) => String(a.address).localeCompare(String(b.address)));
  const sum = (list, k) => list.reduce((s, i) => s + i[k], 0);
  const live = items.filter((i) => !i.skip && i.interest_cents > 0);
  const clean = live.filter((i) => !i.exception), exc = live.filter((i) => i.exception);
  return {
    run_date: run, as_of_date: cutoff, rule: { rate_bps: rateBps, grace_days: grace, due_offset_days: offset, calculation_cutoff: cutoff, basis: 'eligible assessment principal at the cutoff, receipts applied to delinquent assessments first; once per month' },
    items, unmatched, latest_receipt_date: latestReceipt,
    totals: {
      owners: live.length, principal_cents: sum(live, 'eligible_principal_cents'), interest_cents: sum(live, 'interest_cents'),
      clean_owners: clean.length, clean_interest_cents: sum(clean, 'interest_cents'),
      exception_owners: exc.length, exception_interest_cents: sum(exc, 'interest_cents'),
      skipped_already_charged: items.filter((i) => i.skip).length, unmatched_receipts: unmatched.length,
    },
  };
}

// The association's own policy. No association inherits another's rate or grace period.
function requirePolicy(settings) {
  const s = settings || {};
  if (!(Number(s.rate_bps) > 0) || s.grace_days == null || !Number.isFinite(Number(s.grace_days))) throw Object.assign(new Error('interest policy not configured: set the rate and grace period from this association\'s governing documents'), { code: 'interest_policy_missing' });
  return s;
}
const monthEndBefore = (run) => { const x = new Date(`${day(run).slice(0, 7)}-01T00:00:00Z`); x.setUTCDate(0); return x.toISOString().slice(0, 10); };
const cutoffFor = (settings, run) => ((settings || {}).calc_cutoff === 'prior_month_end' ? monthEndBefore(run) : null);

// PURE. Each month with posted interest since the cutover, recalculated on today's ledger.
// Every row dated by its EFFECTIVE date, whenever it was entered. correction_cents: negative
// = credit the owner, positive = undercharged. Nothing is changed here.
function reviewPostedInterest(inp) {
  const cut = day(inp.cutoverDate || '0000-00-00');
  const posted = inp.rows.filter((r) => r.charge_category === 'interest' && r.txn_type !== 'balance_brought_forward' && day(r.transaction_date) >= cut);
  const out = [];
  for (const ym of [...new Set(posted.map((r) => day(r.transaction_date).slice(0, 7)))].sort()) {
    const run = `${ym}-01`; const mine = posted.filter((r) => day(r.transaction_date).slice(0, 7) === ym);
    const r = computeInterest({ ...inp, rows: inp.rows.filter((x) => !mine.includes(x)), runDate: run, asOfDate: cutoffFor(inp.settings, run) });
    const want = new Map(r.items.map((i) => [i.property_id, i])); const got = new Map();
    for (const x of mine) got.set(x.property_id, (got.get(x.property_id) || 0) + Number(x.amount_cents));
    for (const [pid, cents] of got) {
      const i = want.get(pid); const exp = i ? i.interest_cents : 0;
      if (exp !== cents) out.push({ month: ym, property_id: pid, address: (i && i.address) || (inp.properties.find((p) => p.id === pid) || {}).street_address || null, posted_cents: cents, recalculated_cents: exp, correction_cents: exp - cents, flags: i ? i.flags.map((f) => f.code) : [] });
    }
  }
  return out;
}

// PURE. Would this run still charge the same amounts? (checked again at approval)
function changedSince(preview, fresh) {
  const F = new Map(fresh.map((i) => [i.tenure_id, i])); const P = new Map(preview.map((i) => [i.tenure_id, i])); const out = [];
  for (const k of new Set([...F.keys(), ...P.keys()])) { const a = P.get(k), b = F.get(k); const x = a && !a.skip ? a.interest_cents : 0, y = b && !b.skip ? b.interest_cents : 0; if (x !== y || !!(a && a.exception) !== !!(b && b.exception)) out.push({ tenure_id: k, address: (b || a).address, prepared_cents: x, now_cents: y }); }
  return out;
}

async function pageAll(supabase, table, select, apply) {
  const out = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await apply(supabase.from(table).select(select)).order('id').range(i, i + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data); if (data.length < 1000) break;
  }
  return out;
}

async function loadInputs(supabase, community_id) {
  const { data: batches, error: be } = await supabase.from('transaction_upload_batches').select('id').eq('community_id', community_id).eq('status', 'committed');
  if (be) throw new Error(`batches: ${be.message}`);
  const ids = batches.map((b) => b.id); const rows = [];
  for (let i = 0; i < ids.length; i += 50) rows.push(...await pageAll(supabase, 'homeowner_transactions',
    'id, tenure_id, property_id, vantaca_account_id, trusted_account_number, contact_id, transaction_date, txn_type, charge_category, amount_cents, description, reverses_txn_id',
    (q) => q.in('source_batch_id', ids.slice(i, i + 50))));
  const tenures = await pageAll(supabase, 'ownership_tenures', 'id, property_id, kind, start_date, end_date, vantaca_account_id', (q) => q.eq('community_id', community_id));
  const properties = await pageAll(supabase, 'properties', 'id, street_address, vantaca_account_id, trusted_account_number', (q) => q.eq('community_id', community_id));
  const collections = await pageAll(supabase, 'ar_account_collections', 'id, property_id, collection_status', (q) => q.eq('community_id', community_id));
  const plans = await pageAll(supabase, 'payment_plans', 'id, property_id, status', (q) => q.eq('community_id', community_id));
  const { data: enforcement, error: ee } = await supabase.from('v_current_enforcement_state').select('property_id, state').eq('community_id', community_id).order('property_id').limit(1000);
  if (ee) throw new Error(`enforcement states: ${ee.message}`);
  if (enforcement.length >= 1000) throw new Error('enforcement states: at the 1000-row cap');
  const { data: comm, error: ce } = await supabase.from('communities').select('id, gl_cutover_date, management_company_id, account_code').eq('id', community_id).single();
  if (ce) throw new Error(`community: ${ce.message}`);
  return { rows, tenures, properties, collections, plans, enforcement, community: comm };
}

async function previewInterest(supabase, { community_id, run_date, as_of_date = null, settings }) {
  requirePolicy(settings);
  const inp = await loadInputs(supabase, community_id);
  const base = { ...inp, cutoverDate: inp.community.gl_cutover_date, settings };
  return { ...computeInterest({ ...base, runDate: run_date, asOfDate: as_of_date }), posted_review: reviewPostedInterest(base) };
}

// Post the approved items (LOPF pattern): a draft ledger batch, one interest row per
// tenure, one GL entry (Dr homeowner AR per property / Cr interest income) through the
// guarded poster, then commit the batch. A failure after the draft marks it reverted;
// nothing is ever deleted. Refuses a second posting for the same reference.
async function postInterest(supabase, { community_id, run_date, items, settings, actor }) {
  const { postJournalEntry } = require('../accounting/posting');
  requirePolicy(settings);
  const run = day(run_date); const ym = run.slice(0, 7);
  const post = items.filter((i) => i.interest_cents > 0 && !i.skip);
  if (!post.length) return { posted: 0, interest_cents: 0, note: 'nothing to post' };
  const total = post.reduce((s, i) => s + i.interest_cents, 0);
  const { data: comm, error: ce } = await supabase.from('communities').select('management_company_id, account_code').eq('id', community_id).single();
  if (ce) throw new Error(`community: ${ce.message}`);
  // Once per owner and month, whatever posted it. A second entry in the month is allowed only for
  // owners with no interest in it (exceptions approved later), under its own reference.
  const base = `INT-${comm.account_code || community_id.slice(0, 8)}-${ym}`;
  const { data: prior, error: de } = await supabase.from('journal_entries').select('id, reference').eq('community_id', community_id).like('reference', `${base}%`).limit(100);
  if (de) throw new Error(`duplicate check: ${de.message}`);
  const { data: charged, error: he } = await supabase.from('homeowner_transactions').select('id, property_id, transaction_upload_batches!inner(status)').eq('community_id', community_id).eq('charge_category', 'interest')
    .neq('txn_type', 'balance_brought_forward').eq('transaction_upload_batches.status', 'committed').gte('transaction_date', `${ym}-01`).lt('transaction_date', addDays(`${ym}-28`, 4).slice(0, 8) + '01').in('property_id', post.map((i) => i.property_id)).limit(1000);
  if (he) throw new Error(`duplicate check: ${he.message}`);
  if ((charged || []).length) throw Object.assign(new Error(`interest for ${ym} is already posted for ${new Set(charged.map((x) => x.property_id)).size} of these owners; refresh the run`), { code: 'duplicate' });
  const ref = (prior || []).length ? `${base}-S${prior.length}` : base;
  const { data: roles } = await supabase.from('community_account_roles').select('role, account_id').eq('community_id', community_id);
  const arRole = (roles || []).find((r) => r.role === 'homeowner_ar');
  const { data: coa, error: ae } = await supabase.from('chart_of_accounts').select('id, account_number, fund_id').eq('community_id', community_id).in('account_number', ['1300', settings.income_account_number || '4030']);
  if (ae) throw new Error(`accounts: ${ae.message}`);
  const ar = arRole ? { id: arRole.account_id } : coa.find((a) => a.account_number === '1300');
  const inc = coa.find((a) => a.account_number === (settings.income_account_number || '4030'));
  if (!ar || !inc) throw new Error('homeowner AR or interest income account missing');
  const label = `Interest ${run} (${(settings.rate_bps ?? 1000) / 100}% per year on assessment principal)`;
  const { data: batch, error: be } = await supabase.from('transaction_upload_batches').insert({
    management_company_id: comm.management_company_id, community_id, period_label: label, as_of_date: run, source_format: 'manual',
    row_count: post.length, account_count: post.length, total_charges_cents: total, total_payments_cents: 0, status: 'draft',
    min_transaction_date: run, max_transaction_date: run, notes: `Monthly interest run; GL ${ref}. ${actor}`,
  }).select('id').single();
  if (be) throw new Error(`batch: ${be.message}`);
  const fail = async (why) => {
    await supabase.from('transaction_upload_batches').update({ status: 'reverted', reverted_at: new Date().toISOString(), reverted_reason: `posting failed: ${why}`.slice(0, 500) }).eq('id', batch.id);
    throw new Error(`interest posting failed (draft batch ${batch.id} reverted): ${why}`);
  };
  const { error: ie } = await supabase.from('homeowner_transactions').insert(post.map((i, n) => ({
    source_batch_id: batch.id, source_row_index: n + 1, community_id, vantaca_account_id: i.vantaca_account_id, trusted_account_number: i.trusted_account_number,
    property_id: i.property_id, contact_id: i.contact_id || null, tenure_id: i.tenure_id, transaction_date: run, description: i.description,
    txn_type: 'charge', charge_category: 'interest', amount_cents: i.interest_cents,
  })));
  if (ie) await fail(ie.message);
  let je;
  try {
    je = await postJournalEntry({ community_id, posting_date: run, reference: ref, source_module: 'assessment_billing', source_reference: `interest:${community_id}:${ym}${ref === base ? '' : ref.slice(base.length)}`,
      description: `Late interest ${run}: ${post.length} owners, ${(settings.rate_bps ?? 1000) / 100}% per year on assessment principal`, notes: actor,
      lines: [...post.map((i) => ({ account_id: ar.id, debit_cents: i.interest_cents, credit_cents: 0, property_id: i.property_id, memo: `Interest ${run} ${i.address || i.property_id} on principal ${money(i.eligible_principal_cents)}` })),
        { account_id: inc.id, debit_cents: 0, credit_cents: total, memo: `Late interest ${run} (${post.length} owners)` }] });
  } catch (e) { await fail(e.message); }
  const { error: ue } = await supabase.from('transaction_upload_batches').update({ status: 'committed' }).eq('id', batch.id);
  if (ue) throw new Error(`GL ${ref} posted but the ledger batch ${batch.id} did not commit: ${ue.message}. Commit it; do not re-run.`);
  return { posted: post.length, interest_cents: total, journal_reference: (je.entry || {}).reference || ref, batch_id: batch.id };
}

module.exports = { computeInterest, previewInterest, postInterest, loadInputs, reviewPostedInterest, changedSince, requirePolicy, cutoffFor };
