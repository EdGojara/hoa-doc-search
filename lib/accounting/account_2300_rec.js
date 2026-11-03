// ============================================================================
// lib/accounting/account_2300_rec.js  (Ed 2026-11-03: Kat's monthly 2300 control)
// ----------------------------------------------------------------------------
// Read-only monthly reconciliation of GL 2300 (Accrued Liability), the account
// owner fees pass through on their way to Bedrock. Kat prepares it as an
// accounting run (process 'account_reconciliation', subject = the 2300 account);
// the owner reviews it on Today. Nothing posts: approving records the review.
//
// For the month it ties, exactly, to the GL:
//   beginning balance + every line in the month = ending balance (each line is
//   classified once; the classes must sum to the month's net)
// and splits the month into: owner fees ASSESSED (credits), VOIDS (system errors
// voided, je_status pairs), Bedrock SETTLEMENTS (debits from a Bedrock bill), the
// CONVERSION lines and OTHER. Ownership comes from the association's contract
// rate card (contract_owner_charges): a fee type on it is Bedrock's; anything
// else is not assumed to be.
//
// Collections use ACTUAL payment allocations (ar_payment_applications against the
// fee's ar_charge). A fee with no linked charge, or whose charge has no allocation
// record, is reported as "collection not determinable" and never inferred from a
// remaining balance.
//
// Exceptions (open items for a person; nothing is adjusted): a debit balance; a
// conversion balance with no item detail (open until the Vantaca 2300 support
// arrives); a fee not on the rate card; fees assessed but not yet billed to
// Bedrock and Bedrock settlements with no assessed fee (matched by fee type and
// count, cumulative since the cutover); lines that could not be classified.
// ============================================================================
const { countsInGl } = require('./je_status');
const day = (d) => String(d || '').slice(0, 10);
const money = (c) => { const n = Number(c || 0) / 100; const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return n < 0 ? `($${s})` : `$${s}`; };
const lastOf = (pm) => { const d = new Date(`${day(pm).slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); };
const BEDROCK_VENDOR_ID = 'e254e558-9285-4a02-9b35-7ea66d07ec91';

// Fee types by rate-card category, recognised from the text on a 2300 line.
const FEE_TYPES = [
  { type: 'certified_letter', cats: ['drv_certified_demand', 'deed_restriction_certified_demand_letter', 'assessment_certified_demand'], rx: /certified/i },
  { type: 'nsf', cats: ['nsf_charge'], rx: /insufficient|\bnsf\b|returned (check|payment)|bank return/i },
  { type: 'payment_plan', cats: ['payment_plan_fee'], rx: /payment plan/i },
  { type: 'arc_application', cats: ['arc_application_fee'], rx: /\barc\b|architectural|acc application/i },
  { type: 'late_reminder', cats: ['assessment_late_reminder'], rx: /late reminder|reminder notice/i },
  { type: 'attorney_referral', cats: ['attorney_legal_action'], rx: /attorney|legal action/i },
  { type: 'mediation', cats: ['mediation_court_appearance'], rx: /mediation|court appearance/i },
];
const feeTypeOf = (text) => (FEE_TYPES.find((f) => f.rx.test(text || '')) || {}).type || null;

/**
 * PURE. lines: 2300 lines with journal_entries {id, reference, posting_date, status, source_module,
 * description, void_reversal_je_id, reverses_je_id, superseded_at} + memo, property_id, bedrock (bool:
 * the entry posts a Bedrock bill), charge ({ id, applied_cents } when the line is an ar_charge's entry).
 * rateCard: [{ category, description, fee_amount }]. Returns the month's reconciliation.
 */
function reconcileMonth({ lines, period_month, rateCard = [], cutover = '2026-08-01' }) {
  const start = `${day(period_month).slice(0, 7)}-01`, end = lastOf(period_month);
  const counted = (lines || []).filter((l) => countsInGl(l.journal_entries) && !l.journal_entries.superseded_at);
  const net = (arr) => arr.reduce((t, l) => t + Number(l.credit_cents || 0) - Number(l.debit_cents || 0), 0);   // credit balance positive
  const beginning = net(counted.filter((l) => day(l.journal_entries.posting_date) < start));
  const month = counted.filter((l) => day(l.journal_entries.posting_date) >= start && day(l.journal_entries.posting_date) <= end);
  const ending = beginning + net(month);
  const bedrockTypes = new Set(FEE_TYPES.filter((f) => f.cats.some((c) => rateCard.some((r) => r.category === c))).map((f) => f.type));
  const voidIds = new Set(); const byId = new Map(month.map((l) => [l.journal_entries.id, l.journal_entries]));
  for (const j of byId.values()) if (j.status === 'voided' && j.void_reversal_je_id) { voidIds.add(j.id); voidIds.add(j.void_reversal_je_id); }
  const classes = { assessed: [], voids: [], settlements: [], conversion: [], other: [] };
  for (const l of month) {
    const j = l.journal_entries; const text = `${l.memo || ''} ${j.description || ''}`;
    const cents = Number(l.credit_cents || 0) - Number(l.debit_cents || 0);
    const row = { reference: j.reference, date: day(j.posting_date), source: j.source_module, text: text.trim().slice(0, 140), cents, fee_type: feeTypeOf(text), lot: l.property_id || null, charge: l.charge || null };
    if (voidIds.has(j.id)) classes.voids.push(row);
    else if (j.source_module === 'opening_entry' || /^CONV-/.test(j.reference || '')) classes.conversion.push(row);
    else if (cents < 0 && l.bedrock) classes.settlements.push(row);
    else if (cents > 0 && row.fee_type) classes.assessed.push(row);
    else classes.other.push(row);
  }
  const sum = (k) => classes[k].reduce((t, r) => t + r.cents, 0);
  const tie = beginning + sum('assessed') + sum('voids') + sum('settlements') + sum('conversion') + sum('other') === ending;
  // Collections from actual allocations only.
  const collected = classes.assessed.filter((r) => r.charge && r.charge.applied_cents != null).reduce((t, r) => t + Number(r.charge.applied_cents), 0);
  const undeterminable = classes.assessed.filter((r) => !r.charge || r.charge.applied_cents == null);
  // Bedrock matching by fee type and count, cumulative from the cutover through month end.
  const allVoid = new Set();
  for (const l of counted) { const j = l.journal_entries; if (j.status === 'voided' && j.void_reversal_je_id) { allVoid.add(j.id); allVoid.add(j.void_reversal_je_id); } }
  const cum = counted.filter((l) => day(l.journal_entries.posting_date) >= cutover && day(l.journal_entries.posting_date) <= end && !allVoid.has(l.journal_entries.id));
  const tally = {};
  for (const l of cum) {
    const j = l.journal_entries; const text = `${l.memo || ''} ${j.description || ''}`; const t = feeTypeOf(text); if (!t) continue;
    const cents = Number(l.credit_cents || 0) - Number(l.debit_cents || 0);
    if (j.source_module === 'opening_entry' || /^CONV-/.test(j.reference || '')) continue;
    tally[t] = tally[t] || { assessed_cents: 0, settled_cents: 0 };
    if (cents > 0 && !l.bedrock) tally[t].assessed_cents += cents; else if (cents < 0 && l.bedrock) tally[t].settled_cents += -cents;
  }
  const exceptions = [];
  const ex = (code, text, extra = {}) => exceptions.push({ code, severity: 'open', text, ...extra });
  if (ending < 0) ex('debit_balance', `2300 ends ${end} with a DEBIT balance of ${money(-ending)}: more was billed by Bedrock (or moved out) than owners were charged. A payable to Bedrock cannot be negative; find the cause.`);
  const conv = counted.filter((l) => (l.journal_entries.source_module === 'opening_entry' || /^CONV-/.test(l.journal_entries.reference || '')) && day(l.journal_entries.posting_date) <= end);
  if (conv.length) ex('conversion_detail_missing', `Conversion balance carried at the cutover: ${money(net(conv))} across ${conv.length} entr(ies) with no item detail. Open until the Vantaca 2300 GL detail is obtained.`, { conversion_cents: net(conv) });
  for (const r of classes.assessed) if (!bedrockTypes.has(r.fee_type)) ex('not_on_rate_card', `${r.reference} ${r.date}: ${r.fee_type.replace(/_/g, ' ')} fee ${money(r.cents)} is not on this association's rate card, so it is not assumed to be Bedrock's.`, { reference: r.reference });
  for (const [t, v] of Object.entries(tally)) {
    const gap = v.assessed_cents - v.settled_cents;
    if (gap > 0) ex('assessed_not_billed', `${t.replace(/_/g, ' ')} fees: ${money(v.assessed_cents)} charged to owners since ${cutover}, ${money(v.settled_cents)} billed by Bedrock; ${money(gap)} not yet billed to Bedrock.`, { fee_type: t, cents: gap });
    if (gap < 0) ex('billed_not_assessed', `${t.replace(/_/g, ' ')} fees: Bedrock billed ${money(v.settled_cents)} since ${cutover} against ${money(v.assessed_cents)} charged to owners; ${money(-gap)} billed with no matching owner fee.`, { fee_type: t, cents: -gap });
  }
  for (const r of classes.other) ex('unclassified', `${r.reference} ${r.date} ${money(r.cents)}: not a recognised owner fee or Bedrock settlement (${r.source}): ${r.text}`, { reference: r.reference });
  if (undeterminable.length) ex('no_allocation_recorded', `${undeterminable.length} owner fee(s) this month (${money(undeterminable.reduce((t, r) => t + r.cents, 0))}) have no recorded payment allocation in trustEd, so whether they were collected is not known. Not inferred from balances; owner payments after the cutover may still be in Vantaca.`, { references: undeterminable.map((r) => r.reference) });
  if (!tie) ex('does_not_tie', 'The classified activity does not sum to the GL change for the month.');
  const totals = { beginning_cents: beginning, assessed_cents: sum('assessed'), voids_cents: sum('voids'), settlements_cents: sum('settlements'), conversion_cents: sum('conversion'), other_cents: sum('other'),
    ending_cents: ending, ties: tie, collected_cents: collected, collection_unknown_count: undeterminable.length, owed_to_bedrock_cents: Object.values(tally).reduce((t, v) => t + Math.max(0, v.assessed_cents - v.settled_cents), 0), exceptions: exceptions.length };
  return { period_month: start, period_end: end, totals, classes, tally, exceptions };
}

function reportText(r, label = '2300') {
  const t = r.totals;
  return [`GL ${label} roll-forward, ${r.period_month.slice(0, 7)} (read-only; nothing posts)`,
    `  Beginning balance            ${money(t.beginning_cents)}`,
    `  + Owner fees assessed        ${money(t.assessed_cents)}  (${r.classes.assessed.length})`,
    `  + Voids (system errors)      ${money(t.voids_cents)}  (${r.classes.voids.length})`,
    `  - Bedrock settlements        ${money(t.settlements_cents)}  (${r.classes.settlements.length})`,
    `  +/- Conversion entries       ${money(t.conversion_cents)}  (${r.classes.conversion.length})`,
    `  +/- Other                    ${money(t.other_cents)}  (${r.classes.other.length})`,
    `  = Ending balance             ${money(t.ending_cents)}   ${t.ties ? 'ties to the GL' : 'DOES NOT TIE'}`,
    `  Collected from owners (recorded allocations only): ${money(t.collected_cents)}; fees with no recorded allocation: ${t.collection_unknown_count}`,
    `  Charged to owners and not yet billed by Bedrock since the cutover: ${money(t.owed_to_bedrock_cents)}`,
    `  Exceptions: ${t.exceptions}`].join('\n');
}

async function must(q, what) { const { data, error } = await q; if (error) throw new Error(`${what}: ${error.message}`); return data; }

async function prepare(supabase, { community_id, period_month, account_id = null }) {
  const acct = account_id
    ? (await must(supabase.from('chart_of_accounts').select('id, account_number, account_name').eq('id', account_id).eq('community_id', community_id).limit(1), 'account'))[0]
    : (await must(supabase.from('chart_of_accounts').select('id, account_number, account_name').eq('community_id', community_id).eq('account_number', '2300').limit(1), 'account'))[0];
  if (!acct) throw Object.assign(new Error('this association has no 2300 account'), { code: 'invalid_input' });
  const { fetchAllQuery } = require('../db/fetch_all');
  const raw = await fetchAllQuery(() => supabase.from('journal_entry_lines').select('id, debit_cents, credit_cents, memo, property_id, journal_entries!inner(id, reference, posting_date, status, source_module, description, void_reversal_je_id, reverses_je_id, superseded_at)')
    .eq('account_id', acct.id).lte('journal_entries.posting_date', lastOf(period_month)), { orderBy: 'id' });
  const jeIds = [...new Set(raw.map((l) => l.journal_entries.id))];
  const bedrockJe = new Set(); const chargeByJe = {};
  for (let i = 0; i < jeIds.length; i += 200) {
    const ids = jeIds.slice(i, i + 200);
    const bills = await must(supabase.from('ap_invoices').select('posting_journal_entry_id, vendor_id').in('posting_journal_entry_id', ids), 'bills');
    for (const b of bills) if (b.vendor_id === BEDROCK_VENDOR_ID) bedrockJe.add(b.posting_journal_entry_id);
    const ch = await must(supabase.from('ar_charges').select('id, posting_journal_entry_id').in('posting_journal_entry_id', ids), 'charges');
    for (const c of ch) chargeByJe[c.posting_journal_entry_id] = { id: c.id, applied_cents: null };
  }
  const chIds = Object.values(chargeByJe).map((c) => c.id);
  for (let i = 0; i < chIds.length; i += 200) {
    const apps = await must(supabase.from('ar_payment_applications').select('charge_id, applied_cents').in('charge_id', chIds.slice(i, i + 200)), 'allocations');
    for (const c of Object.values(chargeByJe)) { const mine = apps.filter((a) => a.charge_id === c.id); if (mine.length) c.applied_cents = (c.applied_cents || 0) + mine.reduce((t, a) => t + Number(a.applied_cents || 0), 0); }
  }
  // No allocation rows = no recorded collection. Never inferred from the charge's remaining balance
  // (Ed 2026-11-03): owner payments after the cutover may still be in Vantaca and not yet imported.
  const lines = raw.map((l) => ({ ...l, bedrock: bedrockJe.has(l.journal_entries.id), charge: chargeByJe[l.journal_entries.id] || null }));
  const contract = (await must(supabase.from('contracts').select('id').eq('community_id', community_id).eq('status', 'active').order('version', { ascending: false }).limit(1), 'contract'))[0];
  const rateCard = contract ? await must(supabase.from('contract_owner_charges').select('category, description, fee_amount').eq('contract_id', contract.id), 'rate card') : [];
  const { getGlCutoverDate } = require('./cutover');
  const cutover = (await getGlCutoverDate(supabase, community_id)) || '2026-08-01';
  const r = reconcileMonth({ lines, period_month, rateCard, cutover });
  if (!contract) r.exceptions.unshift({ code: 'no_contract', severity: 'open', text: 'No active management agreement on file, so no fee can be confirmed as Bedrock\'s.' });
  return { account: { id: acct.id, number: acct.account_number, name: acct.account_name }, rate_card: rateCard.map((x) => x.category), ...r, report: reportText(r, acct.account_number) };
}

module.exports = { reconcileMonth, reportText, prepare, FEE_TYPES, feeTypeOf };
