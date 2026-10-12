// ============================================================================
// lib/collections/notices.js  (Ed 2026-10-12)
// ----------------------------------------------------------------------------
// Certified collections notices (Tex. Prop. Code 209.0064), inside Receivables.
//
//   Amanda prepares   eligible accounts (community policy + every restriction) ->
//                     a batch of DRAFT notices, each with a FIXED statement snapshot
//   Kat verifies      independently re-reads the ledger: snapshot = ledger = notice,
//                     fee = configuration, dates consistent, nothing changed
//   staff approve     an identified staff user, with an owner-approved template;
//                     the issued PDFs are rendered and stored (immutable paths)
//   office mails      prints from the batch PDF, records USPS certified tracking,
//                     the mailing date (must equal the notice date) and the
//                     regular-mail copy
//   on mailing        the homeowner certified-letter fee posts ONCE (if the community
//                     turned it on), Bedrock's contract fee is staged for billing,
//                     and the account's collection status becomes certified_demand.
//
// Nothing here mails anything or charges anyone on its own. A draft never charges.
// Reuses: the AR aging open-charge computation (api/gl.js), the current-owner ledger
// views, the statement data builder and scanline, community_billing_policies,
// payment_plans, ar_account_collections, v_current_enforcement_state,
// community_account_roles, ar_charge_types 'certified_collection', postJournalEntry,
// billing_pending_items.
// ============================================================================
const crypto = require('crypto');

const CURE_MIN = 45;
const OPEN_NOTICE = ['draft', 'approved', 'printed'];
const HOLD_COLLECTION_STATUS = { bankruptcy: 'Bankruptcy on file', with_attorney: 'With the attorney', lien_filed: 'Lien filed', foreclosure: 'Foreclosure', written_off: 'Written off', payment_plan: 'On a payment plan', board_review: 'Board review' };
const HOLD_ENFORCEMENT_STATE = { in_bankruptcy: 'Bankruptcy on file', at_legal: 'At legal', lien_filed: 'Lien filed', judgment: 'Judgment', on_payment_plan: 'On a payment plan' };

const must = async (q, what) => { const { data, error } = await q; if (error) throw Object.assign(new Error(`${what}: ${error.message}`), { code: error.code }); return data; };
const todayCentral = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const longDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const shortDate = (d) => { const [y, m, dd] = String(d).slice(0, 10).split('-'); return `${m}/${dd}/${y}`; };
const money = (c) => { const n = Math.round(Number(c) || 0); const t = `$${(Math.abs(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; return n < 0 ? `(${t})` : t; };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function numberWords(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
  return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ''}`;
}

// ---------------------------------------------------------------------------
// 1) Dates: everything derives from the notice date (the mailing date)
// ---------------------------------------------------------------------------
function noticeDates(noticeDate, cureDays) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(noticeDate || ''))) throw Object.assign(new Error('notice date required (YYYY-MM-DD)'), { code: 'invalid_input' });
  const cure = Math.max(CURE_MIN, Number(cureDays) || CURE_MIN);
  return { notice_date: noticeDate, cure_days: cure, deadline_date: addDays(noticeDate, cure) };
}

// Pure: every date on a notice agrees with every other (the Vantaca example printed a
// 2025 deadline on a 2026 notice).
function dateErrors(n, { today = todayCentral() } = {}) {
  const e = [];
  if (n.cure_days < CURE_MIN) e.push(`cure period ${n.cure_days} days is below the statutory ${CURE_MIN}`);
  if (n.deadline_date !== addDays(n.notice_date, n.cure_days)) e.push(`deadline ${n.deadline_date} is not the notice date + ${n.cure_days} days`);
  if (n.deadline_date <= n.notice_date) e.push('deadline is not after the notice date');
  if (n.notice_date < today) e.push(`notice date ${n.notice_date} is in the past; re-date the batch`);
  const yNotice = Number(n.notice_date.slice(0, 4)), yDeadline = Number(n.deadline_date.slice(0, 4));
  if (yDeadline < yNotice || yDeadline > yNotice + 1) e.push(`deadline year ${yDeadline} is inconsistent with notice year ${yNotice}`);
  if (n.mailed_date && n.mailed_date !== n.notice_date) e.push(`mailed ${n.mailed_date} but dated ${n.notice_date}; re-date and reprint`);
  return e;
}

// ---------------------------------------------------------------------------
// 2) Configuration: template, policy, fees
// ---------------------------------------------------------------------------
async function loadConfig(supabase, communityId) {
  const comm = await must(supabase.from('communities').select('id, name, legal_name, hoa_legal_name, letter_pay_to_name, letter_pay_to_address, certified_collection_fee_cents, collection_fee_autopost, management_company_id').eq('id', communityId).single(), 'community');
  const templates = await must(supabase.from('collection_notice_templates').select('*').eq('community_id', communityId).neq('status', 'retired').order('version', { ascending: false }).limit(10), 'templates');
  const template = templates.find((t) => t.status === 'approved') || templates[0] || null;
  const pol = await must(supabase.from('community_billing_policies').select('*').eq('community_id', communityId).is('effective_end_date', null).order('effective_start_date', { ascending: false }).limit(1), 'billing policy');
  const policy = pol[0] || { certified_209_notice_days: 45, grace_period_days: 10 };
  const types = await must(supabase.from('ar_charge_types').select('type_code, gl_revenue_account_id, gl_receivable_account_id').eq('community_id', communityId).eq('type_code', 'certified_collection').limit(1), 'charge type');
  const contracts = await must(supabase.from('contracts').select('id').eq('community_id', communityId).eq('status', 'active').limit(5), 'contracts');
  let bedrockFee = null;
  if (contracts.length) {
    const oc = await must(supabase.from('contract_owner_charges').select('category, fee_amount').in('contract_id', contracts.map((c) => c.id)).in('category', ['assessment_certified_demand', 'assessment_certified_demand_letter']).limit(5), 'contract fee');
    if (oc.length) bedrockFee = { category: oc[0].category, cents: Math.round(Number(oc[0].fee_amount) * 100) };
  }
  return { community: comm, template, policy, fee: feeConfig(comm, types[0] || null, bedrockFee) };
}

// Pure: what this community's notice charges the homeowner, and what Bedrock bills.
function feeConfig(comm, chargeType, bedrockFee) {
  const recoverable = Number(comm.certified_collection_fee_cents || 0);
  const reasons = [];
  if (!comm.collection_fee_autopost) reasons.push('the homeowner certified-letter fee is turned off for this community');
  if (recoverable <= 0) reasons.push('no homeowner certified-letter fee amount is set (communities.certified_collection_fee_cents)');
  if (!chargeType || !chargeType.gl_revenue_account_id) reasons.push("the 'certified_collection' charge type has no GL account mapped");
  if (bedrockFee && recoverable > bedrockFee.cents) reasons.push(`the homeowner fee ${money(recoverable)} exceeds the management-agreement rate ${money(bedrockFee.cents)}`);
  return {
    homeowner_fee_cents: reasons.length ? 0 : recoverable, charges_homeowner: !reasons.length, why_not: reasons,
    credit_account_id: chargeType ? chargeType.gl_revenue_account_id : null,
    bedrock_fee_cents: bedrockFee ? bedrockFee.cents : null, bedrock_fee_category: bedrockFee ? bedrockFee.category : null,
    differs: !!(bedrockFee && recoverable && bedrockFee.cents !== recoverable),
  };
}

// ---------------------------------------------------------------------------
// 3) Eligibility
// ---------------------------------------------------------------------------
// Pure: a converted opening balance is dated at the cutover, not when the assessment fell
// due. Walk the prior-system history back (newest first) until it covers the open
// assessment amount; the oldest charge reached is the real due date. If the history runs
// out first, the uncovered part is OLDER than the oldest charge found, so that date is a
// safe lower bound (it can only understate the delinquency, never overstate it).
// null = no prior-system assessment on file.
function originalDueDate(openAssessCents, historyCharges) {
  let acc = 0; let oldest = null;
  for (const c of [...(historyCharges || [])].filter((x) => x.amount_cents > 0).sort((a, b) => String(b.date).localeCompare(String(a.date)))) {
    acc += c.amount_cents; oldest = c.date;
    if (acc >= openAssessCents) return oldest;
  }
  return oldest;
}

// Pure: one account against the policy and every restriction.
function evaluateAccount(a, { policy, template, today = todayCentral() }) {
  const holds = [];
  const trigger = Number(policy.certified_209_notice_days || 45);
  const grace = Number(policy.grace_period_days || 0);
  const assess = (a.open_charges || []).filter((c) => c.category === 'assessment' && c.balance_cents > 0).map((c) => ({ ...c, effective_due: c.original_due_date || c.due_date })).sort((x, y) => String(x.effective_due).localeCompare(String(y.effective_due)));
  const oldest = assess[0] || null;
  const daysPastDue = oldest ? daysBetween(addDays(oldest.effective_due, grace), today) : 0;
  if (oldest && oldest.opening_balance && !oldest.original_due_date) holds.push(`Assessment is a conversion opening balance (${oldest.due_date}); its original due date is not on file`);
  if (!a.tenure_id) holds.push('No single current owner account (tenure)');
  if (!(a.balance_cents > 0)) holds.push('No balance due');
  else if (a.balance_cents < Number(template.min_balance_cents || 0)) holds.push(`Balance ${money(a.balance_cents)} is under the ${money(template.min_balance_cents)} minimum`);
  if (!oldest) holds.push('No delinquent assessment (fees only)');
  else if (daysPastDue < trigger) holds.push(`Oldest assessment is ${daysPastDue} days past due; the policy sends the certified notice at ${trigger}`);
  if (a.collection_status && HOLD_COLLECTION_STATUS[a.collection_status]) holds.push(HOLD_COLLECTION_STATUS[a.collection_status]);
  if (a.bankruptcy_open) holds.push('Bankruptcy on file (automatic stay)');
  if (a.enforcement_state && HOLD_ENFORCEMENT_STATE[a.enforcement_state]) holds.push(HOLD_ENFORCEMENT_STATE[a.enforcement_state]);
  if (a.active_payment_plan) holds.push('Active payment plan');
  // An owner with collections counsel is contacted through counsel, not directly. Attorney /
  // legal-fee activity in the last year holds the account until staff confirm its status
  // (trustEd's legal-status record is not populated for every converted community).
  if (a.attorney_activity && a.enforcement_state !== 'current') holds.push(`Attorney / legal fees on the account (${a.attorney_activity.date}: ${a.attorney_activity.description}); confirm it is not with collections counsel`);
  if (a.open_notice) holds.push(`A collections notice is already in progress (${a.open_notice.status})`);
  if (a.last_mailed && a.last_mailed.deadline_date >= today) holds.push(`The last notice (mailed ${a.last_mailed.mailed_date}) is still in its cure period until ${a.last_mailed.deadline_date}`);
  if (a.recent_payment && daysBetween(a.recent_payment.date, today) <= Number(template.recent_payment_days || 0)) holds.push(`Recent payment ${money(a.recent_payment.cents)} on ${a.recent_payment.date}; confirm the balance before sending`);
  if (!a.mailing_ok) holds.push('No mailing address on file');
  return { eligible: !holds.length, holds, days_past_due: daysPastDue, oldest_assessment_due: oldest ? oldest.effective_due : null, due_date_basis: oldest ? (oldest.original_due_date ? 'prior-system history (conversion opening balance)' : 'ledger') : null };
}

async function eligibleAccounts(supabase, communityId, { today = todayCentral() } = {}) {
  const { accountingStatusFor } = require('../accounting/ownership');
  const st = await accountingStatusFor(supabase, communityId);
  if (!st.enabled) return { community_blocked: `Accounting is not active for this community (${st.reason || 'disabled'}).`, accounts: [] };
  const cfg = await loadConfig(supabase, communityId);
  if (!cfg.template) return { community_blocked: 'No collections notice template for this community (migration 515).', accounts: [] };
  const { fetchAllQuery } = require('../db/fetch_all');
  const gl = require('../../api/gl')._test;
  const open = await gl._openChargesFromTransactions(communityId);
  const byProp = {};
  for (const c of open) (byProp[c.property_id] = byProp[c.property_id] || []).push({ category: (c.ar_charge_types || {}).category, label: (c.ar_charge_types || {}).display_name, due_date: c.due_date, balance_cents: Number(c.balance_remaining_cents) });
  const bals = await fetchAllQuery(() => supabase.from('v_current_owner_balance').select('property_id, tenure_id, balance_cents').eq('community_id', communityId), { orderBy: 'property_id' });
  const pids = bals.filter((b) => Number(b.balance_cents) > 0).map((b) => b.property_id);
  if (!pids.length) return { config: summarizeConfig(cfg), accounts: [] };
  const chunk = async (fn) => { const out = []; for (let i = 0; i < pids.length; i += 150) out.push(...await fn(pids.slice(i, i + 150))); return out; };
  const owners = await chunk((ids) => must(supabase.from('v_current_property_owners').select('property_id, owner_name, street_address, owner_mailing_street, owner_mailing_city, owner_mailing_state, owner_mailing_zip').in('property_id', ids), 'owners'));
  const coll = await chunk((ids) => must(supabase.from('ar_account_collections').select('property_id, collection_status, bankruptcy_petition_date, bankruptcy_discharge_date, bankruptcy_dismissed_date').in('property_id', ids), 'collections'));
  const enf = await chunk((ids) => must(supabase.from('v_current_enforcement_state').select('property_id, state').in('property_id', ids), 'enforcement state'));
  const plans = await chunk((ids) => must(supabase.from('payment_plans').select('property_id').eq('status', 'active').in('property_id', ids), 'payment plans'));
  const notices = await chunk((ids) => must(supabase.from('collection_notices').select('property_id, status, mailed_date, deadline_date').in('property_id', ids).neq('status', 'cancelled'), 'notices'));
  const since = addDays(today, -60);
  const pays = await chunk((ids) => must(supabase.from('v_current_owner_ledger').select('property_id, transaction_date, amount_cents, txn_type').in('property_id', ids).eq('txn_type', 'payment').gte('transaction_date', since), 'recent payments'));
  // Conversion opening balances: date them by the prior-system history they carried forward.
  const bbf = await chunk((ids) => must(supabase.from('v_current_owner_ledger').select('property_id, transaction_date, charge_category, amount_cents').in('property_id', ids).eq('txn_type', 'balance_brought_forward'), 'opening balances'));
  const bbfProps = [...new Set(bbf.filter((x) => x.charge_category === 'assessment').map((x) => x.property_id))];
  const hist = [];
  // Prior-system history: the imported Vantaca history, and the pre-conversion Vantaca AR
  // snapshot the conversion superseded (reverted batches).
  for (let i = 0; i < bbfProps.length; i += 150) {
    const rv = await must(supabase.from('homeowner_transactions').select('property_id, transaction_date, description, amount_cents, transaction_upload_batches!inner(status)').in('property_id', bbfProps.slice(i, i + 150))
      .eq('transaction_upload_batches.status', 'reverted').ilike('description', '%assessment%').gt('amount_cents', 0).limit(5000), 'superseded prior-system snapshot');
    hist.push(...rv.map((x) => ({ property_id: x.property_id, entry_date: x.transaction_date, description: x.description, charge_cents: x.amount_cents })));
  }
  for (let i = 0; i < bbfProps.length; i += 150) hist.push(...await must(supabase.from('homeowner_ledger_entries').select('property_id, entry_date, description, charge_cents').in('property_id', bbfProps.slice(i, i + 150)).eq('source', 'vantaca_history').ilike('description', '%assessment%').gt('charge_cents', 0).limit(5000), 'prior-system history'));
  for (const pid of bbfProps) {
    const dates = new Set(bbf.filter((x) => x.property_id === pid && x.charge_category === 'assessment').map((x) => String(x.transaction_date).slice(0, 10)));
    const charges = (byProp[pid] || []).filter((c) => c.category === 'assessment' && dates.has(String(c.due_date).slice(0, 10)));
    if (!charges.length) continue;
    const seen = new Set();
    const h = hist.filter((x) => x.property_id === pid && !/late|interest|balance forward|beginning/i.test(x.description || '')).map((x) => ({ date: String(x.entry_date).slice(0, 10), amount_cents: Number(x.charge_cents) })).filter((x) => { const k = `${x.date}|${x.amount_cents}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const od = originalDueDate(charges.reduce((s2, c) => s2 + c.balance_cents, 0), h.filter((x) => x.date <= [...dates].sort().pop()));
    for (const c of charges) { c.opening_balance = true; c.original_due_date = od; }
  }
  const legal = await chunk((ids) => must(supabase.from('v_current_owner_ledger').select('property_id, transaction_date, description, amount_cents').in('property_id', ids).gt('amount_cents', 0)
    .or('description.ilike.%legal%,description.ilike.%attorney%,charge_category.eq.attorney_fee,charge_category.eq.attorney_fee_other').gte('transaction_date', addDays(today, -365)), 'attorney activity'));
  const O = Object.fromEntries(owners.map((o) => [o.property_id, o]));
  const accounts = bals.filter((b) => Number(b.balance_cents) > 0).map((b) => {
    const o = O[b.property_id] || {};
    const cl = coll.find((x) => x.property_id === b.property_id) || {};
    const ns = notices.filter((x) => x.property_id === b.property_id);
    const lastMailed = ns.filter((x) => x.status === 'mailed').sort((x, y) => String(y.mailed_date).localeCompare(String(x.mailed_date)))[0] || null;
    const rp = pays.filter((x) => x.property_id === b.property_id).sort((x, y) => String(y.transaction_date).localeCompare(String(x.transaction_date)))[0];
    const a = {
      property_id: b.property_id, tenure_id: b.tenure_id, balance_cents: Number(b.balance_cents), street_address: o.street_address || null, owner_name: o.owner_name || null,
      open_charges: byProp[b.property_id] || [], collection_status: cl.collection_status || null,
      bankruptcy_open: !!(cl.bankruptcy_petition_date && !cl.bankruptcy_discharge_date && !cl.bankruptcy_dismissed_date),
      enforcement_state: (enf.find((x) => x.property_id === b.property_id) || {}).state || null,
      active_payment_plan: plans.some((x) => x.property_id === b.property_id),
      open_notice: ns.find((x) => OPEN_NOTICE.includes(x.status)) || null, last_mailed: lastMailed,
      recent_payment: rp ? { date: rp.transaction_date, cents: -Number(rp.amount_cents) } : null,
      attorney_activity: (() => { const l = legal.filter((x) => x.property_id === b.property_id).sort((x, y) => String(y.transaction_date).localeCompare(String(x.transaction_date)))[0]; return l ? { date: String(l.transaction_date).slice(0, 10), description: String(l.description || '').slice(0, 80) } : null; })(),
      mailing_ok: !!((o.owner_mailing_street || o.street_address)),
    };
    return { ...a, ...evaluateAccount(a, { policy: cfg.policy, template: cfg.template, today }) };
  }).sort((x, y) => (Number(y.eligible) - Number(x.eligible)) || (y.balance_cents - x.balance_cents));
  return { config: summarizeConfig(cfg), accounts };
}

function summarizeConfig(cfg) {
  return {
    template: cfg.template ? { id: cfg.template.id, version: cfg.template.version, status: cfg.template.status, counsel_status: cfg.template.counsel_status, counsel_questions: cfg.template.counsel_questions, cure_days: cfg.template.cure_days, source_note: cfg.template.source_note } : null,
    trigger_days: Number(cfg.policy.certified_209_notice_days || 45), grace_days: Number(cfg.policy.grace_period_days || 0), fee: cfg.fee,
  };
}

// ---------------------------------------------------------------------------
// 4) Statement snapshot (fixed, reproducible) and the letter
// ---------------------------------------------------------------------------
// Pure: rows (complete current-owner ledger, oldest first) -> the statement lines.
// Running totals are computed here (never trusted from import columns); rows before the
// display window collapse into one Prior Balance line, so the statement always ties.
function statementLines(rows, { windowStart, feeCents = 0, noticeDate, feeLabel = 'Certified Letter - Delinquency Certified Letter' }) {
  let run = 0; let prior = 0; const lines = [];
  for (const r of rows || []) {
    const amt = Math.round(Number(r.amount_cents) || 0);
    if (String(r.transaction_date) < windowStart) { prior += amt; run += amt; continue; }
    run += amt;
    lines.push({ date: String(r.transaction_date).slice(0, 10), description: r.description || '', charge_cents: amt > 0 ? amt : 0, payment_cents: amt < 0 ? -amt : 0, total_cents: run, txn_id: r.id || null });
  }
  if (feeCents > 0) { run += feeCents; lines.push({ date: noticeDate, description: feeLabel, charge_cents: feeCents, payment_cents: 0, total_cents: run, pending_until_mailed: true }); }
  return { prior_balance_cents: prior, lines, ending_cents: run };
}

async function buildSnapshot(supabase, { propertyId, noticeDate, feeCents }) {
  const { buildStatementData, buildScanline } = require('../statements/assessment_statement');
  const { currentOwnerActivity, currentOwnerBalance } = require('../ar/current_owner_ledger');
  const base = await buildStatementData(supabase, propertyId);
  const rows = await currentOwnerActivity(supabase, propertyId, { ascending: true });
  const bal = await currentOwnerBalance(supabase, propertyId);
  const ledgerBalance = bal ? Number(bal.balance_cents) : 0;
  const windowStart = `${Number(noticeDate.slice(0, 4)) - 1}-01-01`;
  const st = statementLines(rows, { windowStart, feeCents, noticeDate });
  const sumAll = rows.reduce((s, r) => s + Math.round(Number(r.amount_cents) || 0), 0);
  const snap = {
    as_of: new Date().toISOString(), notice_date: noticeDate, property_id: propertyId, tenure_id: bal ? bal.tenure_id : null,
    association: base.association, mgmt: base.mgmt, remit: base.remit, account_number: base.account_number, addressee: base.addressee,
    property_label: base.property_label, property_address: base.property_address, owner_name_raw: base.owner_name_raw,
    ledger_balance_cents: ledgerBalance, ledger_rows: rows.length, ledger_sum_cents: sumAll, last_txn_id: rows.length ? rows[rows.length - 1].id : null,
    fee_cents: feeCents, amount_due_cents: ledgerBalance + feeCents, ...st,
  };
  snap.scanline = buildScanline({ account_number: snap.account_number, owner_name_raw: snap.owner_name_raw, balance_cents: snap.amount_due_cents });
  return snap;
}

function mergeFields(snapshot, notice, community) {
  const assoc = (snapshot.association && snapshot.association.name) || community.hoa_legal_name || community.name;
  const remitBlock = (snapshot.remit && snapshot.remit.block) || '';
  return {
    association_name: assoc, amount_due: money(notice.amount_due_cents), deadline_date: longDate(notice.deadline_date), notice_date: longDate(notice.notice_date),
    cure_days: String(notice.cure_days), cure_days_words: numberWords(notice.cure_days), payable_to: (snapshot.remit && snapshot.remit.name) || assoc,
    payment_address: remitBlock.split('\n').map((s) => s.trim()).filter(Boolean).join(', '), phone: (snapshot.mgmt && snapshot.mgmt.phone) || '',
  };
}
const fill = (text, f) => String(text).replace(/\{\{(\w+)\}\}/g, (m, k) => (f[k] != null ? f[k] : m));

// Pure: the letter's paragraphs, with every merge field filled.
function letterParagraphs(template, snapshot, notice, community) {
  const f = mergeFields(snapshot, notice, community);
  return (template.paragraphs || []).map((p) => fill(p, f));
}

// Pure: required elements present, no unfilled merge field, dates consistent, amounts tie.
function validateNotice({ template, snapshot, notice, community, today }) {
  const errs = [];
  const paras = letterParagraphs(template, snapshot, notice, community);
  const text = [`Amount Due: ${money(notice.amount_due_cents)}`, ...paras].join('\n');
  for (const el of template.required_elements || []) { try { if (!new RegExp(el.pattern).test(text)) errs.push(`Missing required element: ${el.label}`); } catch (_) { errs.push(`Template element "${el.label}" has an invalid pattern`); } }
  const left = text.match(/\{\{\w+\}\}/g); if (left) errs.push(`Unfilled template fields: ${[...new Set(left)].join(', ')}`);
  errs.push(...dateErrors(notice, { today }));
  if (notice.amount_due_cents !== notice.ledger_balance_cents + notice.fee_cents) errs.push('Amount due is not the ledger balance plus the fee');
  if (snapshot.ending_cents !== notice.amount_due_cents) errs.push(`Statement total ${money(snapshot.ending_cents)} does not equal the notice amount ${money(notice.amount_due_cents)}`);
  if (snapshot.ledger_sum_cents !== snapshot.ledger_balance_cents) errs.push(`Ledger rows sum to ${money(snapshot.ledger_sum_cents)} but the account balance is ${money(snapshot.ledger_balance_cents)}`);
  if (!(notice.amount_due_cents > 0)) errs.push('Nothing is due');
  if (!snapshot.addressee || !snapshot.addressee.street) errs.push('No mailing address');
  return errs;
}

// Pure: the packet (letter, statement + coupon, office copy) as one HTML document.
function renderNoticeHTML({ template, snapshot, notice, community }) {
  const paras = letterParagraphs(template, snapshot, notice, community);
  const a = snapshot.addressee || {};
  const assoc = (snapshot.association && snapshot.association.name) || community.name;
  const m = snapshot.mgmt || {};
  const letter = (copy) => `<section class="page">
    ${copy ? '<div class="copy">OFFICE COPY</div>' : ''}
    <div class="cert">Certified Mail No. ${esc(notice.certified_tracking_number || '__________________________')}<br>Return Receipt Requested &amp; Copy by Regular Mail</div>
    <div class="from">${esc(m.line1 || '')}<br>${esc(m.city || '')}</div>
    <div class="date">${esc(longDate(notice.notice_date))}</div>
    <div class="to">${esc(a.name || '')}<br>${esc(a.street || '')}<br>${esc(a.cityline || '')}</div>
    <div class="re"><strong>Re: ${esc(template.subject_line || 'PAST DUE ASSESSMENTS')}</strong><br><strong>Amount Due: ${esc(money(notice.amount_due_cents))}</strong></div>
    ${paras.map((p, i) => `<p class="${i === 0 ? 'demand' : ''}">${esc(p)}</p>`).join('')}
    <p>Respectfully,<br><br>Board of Directors</p>
    <p class="encl">Enclosure: Account Statement ${esc(assoc)}</p></section>`;
  const rows = snapshot.lines || [];
  const statement = `<section class="page">
    <div class="sthead"><div><strong>${esc(assoc)}</strong><br>c/o ${esc(m.name || '')}<br>${esc(m.line1 || '')}<br>${esc(m.city || '')}</div>
      <div class="bar"><div><span>Account Number</span>${esc(snapshot.account_number || '')}</div><div><span>Due Date</span>Past Due</div><div><span>Pay This Amount</span>${esc(money(notice.amount_due_cents))}</div><div class="asof">as of ${esc(shortDate(notice.notice_date))}</div></div></div>
    <div class="to">${esc(a.name || '')}<br>${esc(a.street || '')}<br>${esc(a.cityline || '')}</div>
    <h3>ACCOUNT STATEMENT</h3>
    <div class="prop">Property: ${esc(snapshot.property_label || '')}</div>
    <table><thead><tr><th>DATE</th><th>DESCRIPTION</th><th class="n">CHARGES</th><th class="n">PAYMENTS</th><th class="n">TOTAL</th></tr></thead><tbody>
      <tr><td></td><td>-- Prior Balance --</td><td></td><td></td><td class="n">${esc(money(snapshot.prior_balance_cents))}</td></tr>
      ${rows.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.description)}</td><td class="n">${r.charge_cents ? esc(money(r.charge_cents)) : ''}</td><td class="n">${r.payment_cents ? esc(money(r.payment_cents)) : ''}</td><td class="n">${esc(money(r.total_cents))}</td></tr>`).join('')}
    </tbody></table>
    <div class="coupon"><div class="cut">Please detach and return this portion with your payment.</div>
      <div class="cgrid"><div><strong>Mail Checks to:</strong><br>${esc((snapshot.remit && snapshot.remit.block) || '').replace(/\n/g, '<br>')}</div>
        <div><div>Account Number: <strong>${esc(snapshot.account_number || '')}</strong></div><div>RE: ${esc(snapshot.property_label || '')}</div><div>DUE DATE: Past Due</div><div>PAY THIS AMOUNT: <strong>${esc(money(notice.amount_due_cents))}</strong></div>
        <div class="small">Please include your account number on your check. Make check payable to your association.</div></div></div>
      <div class="to">${esc(a.name || '')}<br>${esc(a.street || '')}<br>${esc(a.cityline || '')}</div>
      <div class="scan">${esc(snapshot.scanline || '')}</div></div></section>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: Letter; margin: 0.6in 0.7in; } body { font-family: Georgia, 'Times New Roman', serif; font-size: 11pt; color: #111; }
    .page { page-break-after: always; position: relative; } .page:last-child { page-break-after: auto; }
    .copy { position: absolute; top: -0.2in; right: 0; font: bold 10pt Arial; color: #991b1b; letter-spacing: 2px; }
    .cert { font-size: 10pt; margin-bottom: 10px; } .from { text-align: right; font-size: 10pt; } .date { margin: 14px 0; }
    .to { margin: 10px 0 14px; } .re { margin-bottom: 12px; } p { text-align: justify; line-height: 1.35; margin: 0 0 9px; } p.demand { font-weight: bold; }
    .encl { margin-top: 14px; font-size: 10pt; } .sthead { display: flex; justify-content: space-between; font-size: 10pt; }
    .bar { display: grid; grid-template-columns: repeat(3, auto); gap: 4px 14px; text-align: center; } .bar span { display: block; font-size: 8pt; color: #555; } .bar .asof { grid-column: 1 / 4; font-size: 8pt; }
    h3 { font: bold 12pt Arial; margin: 10px 0 4px; } .prop { font-size: 9.5pt; margin-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; font: 9pt Arial; } th, td { border-bottom: 1px solid #ddd; padding: 3px 4px; text-align: left; } .n { text-align: right; }
    .coupon { margin-top: 18px; border-top: 1px dashed #333; padding-top: 6px; font: 9pt Arial; } .cut { text-align: center; font-size: 8pt; margin-bottom: 6px; }
    .cgrid { display: flex; justify-content: space-between; gap: 20px; } .small { font-size: 7.5pt; margin-top: 4px; } .scan { font-family: 'Courier New', monospace; font-size: 10pt; margin-top: 10px; letter-spacing: 1px; }
  </style></head><body>${letter(false)}${statement}${template.include_office_copy ? letter(true) : ''}</body></html>`;
}

async function renderPdf(html) {
  const puppeteer = require('puppeteer');
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    return Buffer.from(await page.pdf({ format: 'Letter', printBackground: true, preferCSSPageSize: true }));
  } finally { if (browser) await browser.close(); }
}

// ---------------------------------------------------------------------------
// 5) Amanda: prepare a batch (drafts only)
// ---------------------------------------------------------------------------
async function prepareBatch(supabase, { communityId, noticeDate = todayCentral(), propertyIds = null, preparedBy = 'Amanda (AI)' }) {
  const elig = await eligibleAccounts(supabase, communityId);
  if (elig.community_blocked) throw Object.assign(new Error(elig.community_blocked), { code: 'blocked' });
  const cfg = await loadConfig(supabase, communityId);
  const want = propertyIds ? new Set(propertyIds) : null;
  const picked = elig.accounts.filter((a) => (want ? want.has(a.property_id) : a.eligible));
  const notEligible = picked.filter((a) => !a.eligible);
  if (notEligible.length) throw Object.assign(new Error(`Not eligible: ${notEligible.map((a) => `${a.street_address} (${a.holds.join('; ')})`).join(' | ')}`), { code: 'not_eligible', accounts: notEligible });
  if (!picked.length) return { batch: null, notices: [], message: 'No eligible accounts.' };
  const d = noticeDates(noticeDate, cfg.template.cure_days);
  const batch = await must(supabase.from('collection_notice_batches').insert({ community_id: communityId, status: 'prepared', notice_date: d.notice_date, template_id: cfg.template.id, prepared_by: preparedBy }).select('*').single(), 'batch');
  const notices = [];
  for (const a of picked) {
    const fee = cfg.fee.homeowner_fee_cents;
    const snap = await buildSnapshot(supabase, { propertyId: a.property_id, noticeDate: d.notice_date, feeCents: fee });
    const row = {
      batch_id: batch.id, community_id: communityId, property_id: a.property_id, tenure_id: snap.tenure_id || a.tenure_id, status: 'draft',
      ...d, account_number: snap.account_number, owner_name: (snap.addressee || {}).name || a.owner_name, mailing_address: snap.addressee,
      ledger_balance_cents: snap.ledger_balance_cents, fee_cents: fee, amount_due_cents: snap.ledger_balance_cents + fee, bedrock_fee_cents: cfg.fee.bedrock_fee_cents,
      statement_snapshot: snap, snapshot_sha256: sha256(canonical(snap)), snapshot_as_of: snap.as_of,
      eligibility: { holds: a.holds, days_past_due: a.days_past_due, oldest_assessment_due: a.oldest_assessment_due, policy_trigger_days: elig.config.trigger_days },
      template_id: cfg.template.id, template_version: cfg.template.version,
    };
    const { data, error } = await supabase.from('collection_notices').insert(row).select('id, property_id, amount_due_cents').single();
    if (error) { if (error.code === '23505') continue; throw error; }
    notices.push(data);
  }
  const verification = await verifyBatch(supabase, batch.id);
  return { batch: { ...batch, status: verification.ok ? 'verified' : 'verification_failed' }, notices, verification };
}

// ---------------------------------------------------------------------------
// 6) Kat: independent verification (reads the ledger again; never trusts the batch)
// ---------------------------------------------------------------------------
async function verifyBatch(supabase, batchId, { verifier = 'Kat (AI)', today = todayCentral() } = {}) {
  const { currentOwnerBalance } = require('../ar/current_owner_ledger');
  const batch = await must(supabase.from('collection_notice_batches').select('*').eq('id', batchId).single(), 'batch');
  const notices = await must(supabase.from('collection_notices').select('*').eq('batch_id', batchId).in('status', ['draft', 'approved']), 'notices');
  const cfg = await loadConfig(supabase, batch.community_id);
  const template = await must(supabase.from('collection_notice_templates').select('*').eq('id', batch.template_id).single(), 'template');
  const elig = await eligibleAccounts(supabase, batch.community_id, { today });
  const E = Object.fromEntries((elig.accounts || []).map((a) => [a.property_id, a]));
  const results = [];
  for (const n of notices) {
    const errs = [];
    const snap = n.statement_snapshot || {};
    if (sha256(canonical(snap)) !== n.snapshot_sha256) errs.push('The statement snapshot was altered after it was taken');
    const bal = await currentOwnerBalance(supabase, n.property_id);
    if (!bal || bal.tenure_id !== n.tenure_id) errs.push('The owner account (tenure) changed since the snapshot');
    else if (Number(bal.balance_cents) !== n.ledger_balance_cents) errs.push(`The ledger balance is now ${money(bal.balance_cents)}, not ${money(n.ledger_balance_cents)} (activity since the snapshot)`);
    if (n.fee_cents !== cfg.fee.homeowner_fee_cents) errs.push(`The notice fee ${money(n.fee_cents)} no longer matches the community setting ${money(cfg.fee.homeowner_fee_cents)}`);
    const a = E[n.property_id];
    const restrictions = a ? a.holds.filter((h) => !/already in progress/.test(h)) : ['The account is no longer delinquent or has no balance'];
    if (restrictions.length) errs.push(...restrictions.map((h) => `Restriction: ${h}`));
    errs.push(...validateNotice({ template, snapshot: snap, notice: n, community: cfg.community, today }));
    results.push({ notice_id: n.id, property_id: n.property_id, ok: !errs.length, errors: errs, amount_due_cents: n.amount_due_cents });
  }
  const ok = results.length > 0 && results.every((r) => r.ok);
  const verification = { ok, verified_at: new Date().toISOString(), verifier, notices: results.length, failed: results.filter((r) => !r.ok).length, total_due_cents: results.reduce((s, r) => s + r.amount_due_cents, 0), results };
  if (['prepared', 'verified', 'verification_failed'].includes(batch.status)) {
    await must(supabase.from('collection_notice_batches').update({ status: ok ? 'verified' : 'verification_failed', verification, verified_by: verifier, verified_at: verification.verified_at, updated_at: new Date().toISOString() }).eq('id', batchId).select('id'), 'store verification');
  }
  return verification;
}

// ---------------------------------------------------------------------------
// 7) Approval -> issued PDFs; printing; mailing
// ---------------------------------------------------------------------------
async function approveBatch(supabase, batchId, { actor, render = renderPdf }) {
  const batch = await must(supabase.from('collection_notice_batches').select('*').eq('id', batchId).single(), 'batch');
  if (batch.status !== 'verified') throw Object.assign(new Error(`The batch is ${batch.status}; only a verified batch can be approved.`), { code: 'conflict' });
  if (/\(AI\)/.test(String(actor))) throw Object.assign(new Error('Approval needs a staff user, not an AI teammate.'), { code: 'forbidden' });
  const template = await must(supabase.from('collection_notice_templates').select('*').eq('id', batch.template_id).single(), 'template');
  if (template.status !== 'approved') throw Object.assign(new Error('The notice template has not been approved for mailing (the owner approves the wording once; counsel questions are listed with it).'), { code: 'template_not_approved' });
  const v = await verifyBatch(supabase, batchId);
  if (!v.ok) throw Object.assign(new Error(`Kat's re-check failed for ${v.failed} notice(s); the batch is back to verification_failed.`), { code: 'verification_failed', verification: v });
  const comm = await must(supabase.from('communities').select('id, name, legal_name, hoa_legal_name').eq('id', batch.community_id).single(), 'community');
  const notices = await must(supabase.from('collection_notices').select('*').eq('batch_id', batchId).eq('status', 'draft'), 'notices');
  const htmls = [];
  for (const n of notices) {
    const html = renderNoticeHTML({ template, snapshot: n.statement_snapshot, notice: n, community: comm });
    htmls.push(html);
    const pdf = await render(html);
    const hash = crypto.createHash('sha256').update(pdf).digest('hex');
    const path = `collections/${batch.community_id}/${batchId}/${n.id}-${hash.slice(0, 12)}.pdf`;
    const { error: ue } = await supabase.storage.from('documents').upload(path, pdf, { contentType: 'application/pdf', upsert: false });
    if (ue && !/exists/i.test(ue.message)) throw ue;
    await must(supabase.from('collection_notices').update({ status: 'approved', pdf_path: path, pdf_sha256: hash, updated_at: new Date().toISOString() }).eq('id', n.id).eq('status', 'draft').select('id'), 'notice approved');
  }
  // One print file for the office (all packets, in order).
  const bodies = htmls.map((h) => h.replace(/^[\s\S]*?<body>/, '').replace(/<\/body>[\s\S]*$/, ''));
  const head = htmls[0] ? htmls[0].replace(/<body>[\s\S]*$/, '') : '<html><head></head>';
  const batchPdf = await render(`${head}<body>${bodies.join('<div style="page-break-after:always"></div>')}</body></html>`);
  const bh = crypto.createHash('sha256').update(batchPdf).digest('hex');
  const bpath = `collections/${batch.community_id}/${batchId}/batch-${bh.slice(0, 12)}.pdf`;
  const { error: be } = await supabase.storage.from('documents').upload(bpath, batchPdf, { contentType: 'application/pdf', upsert: false });
  if (be && !/exists/i.test(be.message)) throw be;
  return must(supabase.from('collection_notice_batches').update({ status: 'approved', approved_by: actor, approved_at: new Date().toISOString(), batch_pdf_path: bpath, batch_pdf_sha256: bh, updated_at: new Date().toISOString() }).eq('id', batchId).eq('status', 'verified').select('*').single(), 'batch approved');
}

async function markPrinted(supabase, batchId, { actor }) {
  const b = await must(supabase.from('collection_notice_batches').select('status').eq('id', batchId).single(), 'batch');
  if (b.status === 'printed') return { status: 'already_printed' };
  if (b.status !== 'approved') throw Object.assign(new Error(`The batch is ${b.status}; approve it first.`), { code: 'conflict' });
  await must(supabase.from('collection_notices').update({ status: 'printed', updated_at: new Date().toISOString() }).eq('batch_id', batchId).eq('status', 'approved').select('id'), 'notices printed');
  return must(supabase.from('collection_notice_batches').update({ status: 'printed', printed_by: actor, printed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', batchId).select('*').single(), 'batch printed');
}

// USPS certified mail numbers: 20 or 22 digits (Certified Mail / Certified Mail with RR).
const validTracking = (t) => /^\d{20}$|^\d{22}$/.test(String(t || '').replace(/\s/g, ''));

async function recordMailing(supabase, noticeId, { trackingNumber, mailedDate, regularMailConfirmed, actor, post = require('../accounting/posting').postJournalEntry }) {
  const n = await must(supabase.from('collection_notices').select('*').eq('id', noticeId).single(), 'notice');
  if (n.status === 'mailed') return { status: 'already_mailed', notice: n, fee: await postNoticeFee(supabase, n, { actor, post }) };
  if (n.status !== 'printed') throw Object.assign(new Error(`The notice is ${n.status}; print the approved batch first.`), { code: 'conflict' });
  const tn = String(trackingNumber || '').replace(/\s/g, '');
  if (!validTracking(tn)) throw Object.assign(new Error('Enter the 20- or 22-digit USPS certified tracking number.'), { code: 'invalid_input' });
  if (mailedDate !== n.notice_date) throw Object.assign(new Error(`The notice is dated ${n.notice_date}. A notice mailed on ${mailedDate} must be re-dated and reprinted so the letter, the deadline and the statement agree.`), { code: 'date_mismatch' });
  if (!regularMailConfirmed) throw Object.assign(new Error('Confirm the regular-mail copy was mailed too (the notice says "Copy by Regular Mail").'), { code: 'invalid_input' });
  const { data: upd, error } = await supabase.from('collection_notices').update({ status: 'mailed', certified_tracking_number: tn, mailed_date: mailedDate, regular_mail_confirmed: true, mailed_by: actor, mailed_recorded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', noticeId).eq('status', 'printed').select('*').single();
  if (error) { if (error.code === '23505') throw Object.assign(new Error('That tracking number is already recorded on another notice.'), { code: 'duplicate' }); throw error; }
  // The account's existing collection status follows the mailing.
  const { error: ce } = await supabase.from('ar_account_collections').upsert({ community_id: n.community_id, property_id: n.property_id, collection_status: 'certified_demand', status_since: mailedDate }, { onConflict: 'community_id,property_id' });
  if (ce) console.warn('[collections] mailed notice', noticeId, 'but the account collection status could not be updated:', ce.message);
  const fee = await postNoticeFee(supabase, upd, { actor, post });
  const billing = await stageBedrockFee(supabase, upd, { actor });
  const left = await must(supabase.from('collection_notices').select('id').eq('batch_id', n.batch_id).in('status', ['draft', 'approved', 'printed']).limit(1), 'remaining');
  if (!left.length) await supabase.from('collection_notice_batches').update({ status: 'mailed', updated_at: new Date().toISOString() }).eq('id', n.batch_id).eq('status', 'printed');
  return { status: 'mailed', notice: upd, fee, billing };
}

// The homeowner fee for THIS mailed notice, exactly once: ledger row (draft batch, the
// owner's tenure) -> GL Dr AR / Cr the certified_collection mapping -> commit.
async function postNoticeFee(supabase, n, { actor, post }) {
  if (!(n.fee_cents > 0)) return { status: 'no_fee', reason: 'The notice carried no homeowner fee.' };
  if (n.status !== 'mailed') return { status: 'not_mailed' };
  const ref = `collnotice:${n.id}`;
  const existingTxn = await must(supabase.from('homeowner_transactions').select('id, source_batch_id').eq('raw_row_jsonb->>source', 'collection_notice_fee').eq('raw_row_jsonb->>collection_notice_id', n.id).limit(1), 'existing fee');
  const priorJe = await must(supabase.from('journal_entries').select('id, reference').eq('community_id', n.community_id).eq('source_reference', ref).eq('status', 'posted').limit(1), 'existing GL');
  if (existingTxn.length && priorJe.length) {
    if (!n.fee_homeowner_txn_id) await supabase.from('collection_notices').update({ fee_homeowner_txn_id: existingTxn[0].id, fee_journal_entry_id: priorJe[0].id }).eq('id', n.id);
    await supabase.from('transaction_upload_batches').update({ status: 'committed', committed_at: new Date().toISOString() }).eq('id', existingTxn[0].source_batch_id).eq('status', 'draft');
    return { status: 'already_posted', journal_reference: priorJe[0].reference };
  }
  const cfg = await loadConfig(supabase, n.community_id);
  if (!cfg.fee.credit_account_id) throw Object.assign(new Error("No GL account is mapped for the 'certified_collection' charge type."), { code: 'blocked' });
  const roles = await must(supabase.from('community_account_roles').select('role, chart_of_accounts!inner(id, fund_id)').eq('community_id', n.community_id).eq('role', 'homeowner_ar'), 'AR role');
  if (!roles.length) throw Object.assign(new Error('No homeowner AR account role for this community.'), { code: 'blocked' });
  const ar = roles[0].chart_of_accounts;
  const credit = await must(supabase.from('chart_of_accounts').select('id, fund_id').eq('id', cfg.fee.credit_account_id).single(), 'credit account');
  let txn = existingTxn[0];
  if (!txn) {
    const t = await must(supabase.from('ownership_tenures').select('vantaca_account_id').eq('id', n.tenure_id).single(), 'tenure');
    const p = await must(supabase.from('properties').select('trusted_account_number').eq('id', n.property_id).single(), 'property');
    const own = await must(supabase.from('property_ownerships').select('contact_id').eq('tenure_id', n.tenure_id).order('is_primary', { ascending: false }).limit(1), 'owner');
    const b = await must(supabase.from('transaction_upload_batches').insert({ management_company_id: cfg.community.management_company_id, community_id: n.community_id, period_label: `Collections certified letter ${n.notice_date}`, as_of_date: n.notice_date,
      source_format: 'manual', status: 'draft', row_count: 1, account_count: 1, total_charges_cents: n.fee_cents, total_payments_cents: 0, min_transaction_date: n.notice_date, max_transaction_date: n.notice_date,
      uploaded_by: 'collection_notice', notes: `Certified collections notice ${n.id} mailed ${n.mailed_date} (USPS ${n.certified_tracking_number}); recorded by ${actor}. Committed after its GL entry posts.` }).select('id').single(), 'fee batch');
    txn = await must(supabase.from('homeowner_transactions').insert({ source_batch_id: b.id, source_row_index: 1, community_id: n.community_id, vantaca_account_id: t.vantaca_account_id, trusted_account_number: p.trusted_account_number,
      property_id: n.property_id, contact_id: own[0] ? own[0].contact_id : null, tenure_id: n.tenure_id, transaction_date: n.notice_date, description: 'Certified Letter - Delinquency Certified Letter',
      txn_type: 'charge', charge_category: 'certified_letter', amount_cents: n.fee_cents, raw_row_jsonb: { source: 'collection_notice_fee', collection_notice_id: n.id, tracking_number: n.certified_tracking_number } }).select('id, source_batch_id').single(), 'fee row');
  }
  const je = priorJe[0] || (await post({ community_id: n.community_id, posting_date: n.notice_date, source_module: 'certified_letter_fee', source_reference: ref,
    description: `Certified collections letter fee: ${n.owner_name || 'owner'} (notice ${n.notice_date}, USPS ${n.certified_tracking_number})`,
    notes: `Homeowner certified-letter fee for collections notice ${n.id}, posted on confirmed mailing by ${actor}. Fee = community setting ${money(n.fee_cents)}${n.bedrock_fee_cents != null ? `; management-agreement rate ${money(n.bedrock_fee_cents)}` : ''}.`,
    lines: [
      { account_id: ar.id, fund_id: ar.fund_id, debit_cents: n.fee_cents, credit_cents: 0, property_id: n.property_id, memo: 'Certified collections letter fee' },
      { account_id: credit.id, fund_id: credit.fund_id, debit_cents: 0, credit_cents: n.fee_cents, memo: 'Certified collections letter fee' },
    ] })).entry;
  await must(supabase.from('transaction_upload_batches').update({ status: 'committed', committed_at: new Date().toISOString() }).eq('id', txn.source_batch_id).eq('status', 'draft').select('id'), 'commit fee');
  await must(supabase.from('collection_notices').update({ fee_homeowner_txn_id: txn.id, fee_journal_entry_id: je.id, updated_at: new Date().toISOString() }).eq('id', n.id).select('id'), 'link fee');
  return { status: 'posted', journal_reference: je.reference, amount_cents: n.fee_cents };
}

// Bedrock's processing fee owed by the association (management agreement), staged for
// the monthly Bedrock billing review exactly once per notice. Never invoiced here.
async function stageBedrockFee(supabase, n, { actor }) {
  if (n.bedrock_fee_cents == null) return { status: 'no_contract_rate' };
  if (n.bedrock_billing_item_id) return { status: 'already_staged' };
  const cfg = await loadConfig(supabase, n.community_id);
  const row = { management_company_id: cfg.community.management_company_id, community_id: n.community_id, category: cfg.fee.bedrock_fee_category, description: `Certified collections letter: ${(n.statement_snapshot && n.statement_snapshot.property_address) || n.owner_name || ''} (mailed ${n.mailed_date}, USPS ${n.certified_tracking_number})`,
    qty: 1, unit_price: n.bedrock_fee_cents / 100, amount: n.bedrock_fee_cents / 100, source: 'collection_notice', source_ref: `collection_notice:${n.id}`, submitted_by: actor, note: 'Staged automatically on confirmed mailing; review on the Bedrock invoice.', status: 'pending' };
  let { data, error } = await supabase.from('billing_pending_items').insert(row).select('id').single();
  if (error && error.code === '23505') ({ data, error } = await supabase.from('billing_pending_items').select('id').eq('source', 'collection_notice').eq('source_ref', row.source_ref).single());
  if (error) throw error;
  await supabase.from('collection_notices').update({ bedrock_billing_item_id: data.id }).eq('id', n.id);
  return { status: 'staged', billing_item_id: data.id, amount_cents: n.bedrock_fee_cents };
}

async function cancelNotice(supabase, noticeId, { reason, actor }) {
  if (!String(reason || '').trim()) throw Object.assign(new Error('a reason is required'), { code: 'invalid_input' });
  const n = await must(supabase.from('collection_notices').select('id, status, batch_id').eq('id', noticeId).single(), 'notice');
  if (n.status === 'mailed') throw Object.assign(new Error('A mailed notice cannot be cancelled; it is part of the account history.'), { code: 'conflict' });
  if (n.status === 'cancelled') return { status: 'already_cancelled' };
  await must(supabase.from('collection_notices').update({ status: 'cancelled', cancelled_reason: `${actor}: ${String(reason).trim()}`, updated_at: new Date().toISOString() }).eq('id', noticeId).select('id'), 'cancel');
  const left = await must(supabase.from('collection_notices').select('id').eq('batch_id', n.batch_id).neq('status', 'cancelled').limit(1), 'remaining');
  if (!left.length) await supabase.from('collection_notice_batches').update({ status: 'cancelled', cancelled_reason: 'All notices cancelled', updated_at: new Date().toISOString() }).eq('id', n.batch_id);
  return { status: 'cancelled' };
}

async function cancelBatch(supabase, batchId, { reason, actor }) {
  const ns = await must(supabase.from('collection_notices').select('id, status').eq('batch_id', batchId), 'notices');
  if (ns.some((x) => x.status === 'mailed')) throw Object.assign(new Error('Some notices in this batch were mailed; cancel the unmailed ones individually.'), { code: 'conflict' });
  for (const x of ns.filter((y) => y.status !== 'cancelled')) await cancelNotice(supabase, x.id, { reason, actor });
  await supabase.from('collection_notice_batches').update({ status: 'cancelled', cancelled_reason: `${actor}: ${String(reason || '').trim()}`, updated_at: new Date().toISOString() }).eq('id', batchId);
  return { status: 'cancelled' };
}

// Re-date: cancel the unmailed batch and prepare the same accounts again on the new date
// (fresh snapshot, fresh verification). Never edits an issued notice in place.
async function redateBatch(supabase, batchId, { noticeDate, actor }) {
  const b = await must(supabase.from('collection_notice_batches').select('*').eq('id', batchId).single(), 'batch');
  const ns = await must(supabase.from('collection_notices').select('property_id, status').eq('batch_id', batchId).neq('status', 'cancelled'), 'notices');
  if (!ns.length) throw Object.assign(new Error('No notices to re-date.'), { code: 'conflict' });
  await cancelBatch(supabase, batchId, { reason: `Re-dated to ${noticeDate}`, actor });
  return prepareBatch(supabase, { communityId: b.community_id, noticeDate, propertyIds: ns.map((x) => x.property_id), preparedBy: `${actor} (re-date of ${batchId.slice(0, 8)})` });
}

// Amanda's periodic run: for each community with an approved template and no batch in
// progress, prepare and verify a batch. Drafts only; nothing is approved, printed,
// mailed or charged.
async function runCollectionsPrep({ supabase }) {
  const comms = await must(supabase.from('collection_notice_templates').select('community_id').eq('status', 'approved'), 'approved templates');
  const out = [];
  for (const { community_id } of comms) {
    try {
      const busy = await must(supabase.from('collection_notice_batches').select('id').eq('community_id', community_id).in('status', ['prepared', 'verified', 'verification_failed', 'approved', 'printed']).limit(1), 'open batch');
      if (busy.length) { out.push({ community_id, skipped: 'batch in progress' }); continue; }
      const r = await prepareBatch(supabase, { communityId: community_id });
      out.push({ community_id, batch_id: r.batch && r.batch.id, notices: r.notices.length, verified: r.verification ? r.verification.ok : null });
    } catch (e) { out.push({ community_id, error: e.message }); }
  }
  return { communities: out.length, results: out };
}

module.exports = {
  CURE_MIN, numberWords, noticeDates, originalDueDate, dateErrors, feeConfig, evaluateAccount, eligibleAccounts, statementLines, buildSnapshot,
  letterParagraphs, validateNotice, renderNoticeHTML, renderPdf, prepareBatch, verifyBatch, approveBatch, markPrinted,
  validTracking, recordMailing, postNoticeFee, stageBedrockFee, cancelNotice, cancelBatch, redateBatch, runCollectionsPrep, canonical, sha256, loadConfig,
};
