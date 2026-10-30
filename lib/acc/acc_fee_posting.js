// ============================================================================
// lib/acc/acc_fee_posting.js  (Ed 2026-10-21)
// ----------------------------------------------------------------------------
// The homeowner-pays ACC fee (Canyon Gate: $25 per final decision, Ed
// 2026-07-25) posts to the HOMEOWNER LEDGER and the GL together, so it is part
// of THE homeowner balance (lib/ar/owner_balance.js) and ties to GL 1300. It is
// never a native ar_charges row: the ledger is the AR of record (the 7/31
// conversion balances live there), and a native row would sit outside it.
//
//   GL      Dr 1300 Accounts Receivable / Cr 2300 Accrued Liability (the
//           community's acc_fee charge-type mapping). 2300 is the clearing
//           account Bedrock's monthly ARC fee invoice debits, so homeowner
//           recoveries and Bedrock's invoice net there.
//   Ledger  one homeowner_transactions charge "ARC Fee - <ref>" (category
//           'other', the conversion's category for ARC fees), stamped to the
//           current owner's tenure, carrying the decision id and the JE id.
//
// planAccFee decides; postAccFee posts only a plan with no holds. HOLDS (never
// posted; staff resolve and post later):
//   - the community does not bill the ACC fee to the homeowner
//   - the address does not resolve to exactly one lot with one current owner
//   - the decision is dated before the GL cutover (a Vantaca-era fee is in the
//     conversion balances already)
//   - the applicant on the decision is not the owner of record
//   - an ARC / ACC fee is already on this owner's ledger in the last 180 days
//     (including a 7/31 conversion opening ARC balance): possible duplicate
//   - this decision already has a fee (ledger row, or a native charge from the
//     old path)
// Idempotent: a second call for the same decision returns the existing posting.
// A failed ledger write after the JE reverses the JE, so the GL and the ledger
// never disagree.
// ============================================================================

const DUP_WINDOW_DAYS = 180;
const FEE_RX = /\b(arc|acc)\b.*fee|architectural.*fee|application processing fee/i;

// Applicant vs owner of record. Applicants arrive as "Kevin and Glynn Thoms" or
// "HTX Premier Properties LLC / Tom Nguyen"; owners as "LLC., HTX Premier
// Properties" or "Jr., Donald C. Biasiolli". A person matches by
// namesAreEquivalent; an entity matches when every significant word of the
// owner's name appears in the applicant text.
const ENTITY_STOP = new Set(['llc', 'inc', 'the', 'ltd', 'lp', 'co', 'corp', 'trust', 'and', 'of', 'jr', 'sr']);
const words = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !ENTITY_STOP.has(w));
function applicantIsOwner(applicant, ownerNames) {
  const { namesAreEquivalent } = require('../entity_resolution');
  const parts = String(applicant || '').split(/\s*(?:&|\band\b|\/)\s*/i).map((x) => x.trim()).filter(Boolean);
  const surname = (parts[parts.length - 1] || '').split(/\s+/).pop();
  const people = parts.map((x) => (x.split(/\s+/).length === 1 && surname ? `${x} ${surname}` : x));
  const aw = new Set(words(applicant));
  return ownerNames.some((o) => people.some((a) => namesAreEquivalent(a, o))
    || (words(o).length >= 2 && words(o).every((w) => aw.has(w))));
}

const must = (r, what) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };
const day = (d) => String(d || '').slice(0, 10);
const addDays = (d, n) => { const t = new Date(`${day(d)}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

async function planAccFee(supabase, decision, { postingDate = null, deps = {} } = {}) {
  const holds = [];
  const plan = { decision_id: decision.id, reference: decision.reference_number || null, community_id: decision.community_id, holds };
  const comm = must(await supabase.from('communities').select('id, acc_fee_payer, acc_fee_cents, gl_cutover_date').eq('id', decision.community_id).maybeSingle(), 'community');
  const feeCents = comm ? Number(comm.acc_fee_cents) || 0 : 0;
  if (!comm || comm.acc_fee_payer !== 'homeowner' || feeCents <= 0) { holds.push('This community does not bill the ACC fee to the homeowner.'); return plan; }
  plan.amount_cents = feeCents;
  plan.posting_date = day(postingDate || decision.decided_at || new Date().toISOString());
  if (comm.gl_cutover_date && plan.posting_date < day(comm.gl_cutover_date)) holds.push(`Decision dated ${plan.posting_date}, before the ${day(comm.gl_cutover_date)} conversion: a Vantaca-era fee is already in the conversion balances.`);

  // Lot + current owner.
  const resolveProperty = deps.resolveProperty || require('../entity_resolution').resolveProperty;
  const prop = await resolveProperty(supabase, decision.community_id, decision.homeowner_address);
  if (!prop || !prop.id) { holds.push(`The address "${decision.homeowner_address}" does not resolve to a lot.`); return plan; }
  plan.property_id = prop.id; plan.street_address = prop.street_address || decision.homeowner_address;
  const owners = must(await supabase.from('v_current_property_owners').select('property_id, tenure_id, owner_name').eq('property_id', prop.id), 'current owner');
  const tenures = [...new Set(owners.map((o) => o.tenure_id).filter(Boolean))];
  if (tenures.length !== 1) { holds.push(tenures.length ? 'The lot has more than one current owner period.' : 'The lot has no current owner on record.'); return plan; }
  plan.tenure_id = tenures[0];
  plan.owner_name = owners.map((o) => o.owner_name).filter(Boolean).join(' & ') || null;
  const ownerNames = owners.flatMap((o) => String(o.owner_name || '').split(/\s*(?:&|\band\b)\s*/i)).map((x) => x.trim()).filter(Boolean);
  const applicant = String(decision.homeowner_name || '').trim();
  if (!applicant) holds.push('The decision has no applicant name to confirm against the owner of record.');
  else if (!applicantIsOwner(applicant, ownerNames)) holds.push(`The applicant (${applicant}) is not the owner of record (${plan.owner_name || 'none'}); confirm the responsible account.`);

  // Already billed for this decision (ledger, or the retired native path)?
  const existing = must(await supabase.from('homeowner_transactions').select('id, transaction_date, amount_cents, raw_row_jsonb')
    .eq('community_id', decision.community_id).eq('raw_row_jsonb->>acc_decision_id', decision.id).limit(1), 'existing fee');
  if (existing.length) { plan.already_posted = { homeowner_transaction_id: existing[0].id, journal_entry_id: (existing[0].raw_row_jsonb || {}).journal_entry_id || null }; return plan; }
  const native = must(await supabase.from('ar_charges').select('id').eq('community_id', decision.community_id).eq('source_module', 'acc_decision').eq('source_reference', decision.id).limit(1), 'native fee');
  if (native.length) holds.push(`This decision already has a native ACC charge (${native[0].id}) from the retired path; resolve it before posting to the ledger.`);

  // Possible duplicate: an ARC / ACC fee on this owner's ledger recently.
  const since = addDays(plan.posting_date, -DUP_WINDOW_DAYS);
  const recent = must(await supabase.from('v_current_owner_ledger').select('id, transaction_date, description, amount_cents')
    .eq('property_id', prop.id).gt('amount_cents', 0).gte('transaction_date', since), 'recent ledger');
  // ...and in the imported prior-system history (a Vantaca-era fee before the conversion).
  const hist = must(await supabase.from('homeowner_ledger_entries').select('entry_date, description, charge_cents')
    .eq('property_id', prop.id).eq('source', 'vantaca_history').gt('charge_cents', 0).gte('entry_date', since), 'prior-system history');
  const prior = recent.filter((r) => FEE_RX.test(r.description || ''))
    .concat(hist.filter((h) => FEE_RX.test(h.description || '')).map((h) => ({ transaction_date: h.entry_date, description: `${h.description} (prior system)`, amount_cents: Number(h.charge_cents) })));
  if (prior.length) holds.push(`An ARC / ACC fee is already on this owner's ledger (${prior.map((r) => `${day(r.transaction_date)} ${r.description} $${(r.amount_cents / 100).toFixed(2)}`).join('; ')}): confirm it is a different application.`);

  // GL accounts from the community's acc_fee charge type.
  const ct = must(await supabase.from('ar_charge_types').select('gl_receivable_account_id, gl_revenue_account_id, display_name')
    .eq('community_id', decision.community_id).eq('type_code', 'acc_fee').eq('is_active', true).maybeSingle(), 'acc_fee charge type');
  if (!ct || !ct.gl_receivable_account_id || !ct.gl_revenue_account_id) { holds.push('The ACC fee charge type has no GL mapping (Dr 1300 / Cr 2300).'); return plan; }
  const accts = must(await supabase.from('chart_of_accounts').select('id, account_number, account_name').in('id', [ct.gl_receivable_account_id, ct.gl_revenue_account_id]), 'accounts');
  const A = Object.fromEntries(accts.map((a) => [a.id, a]));
  plan.debit = A[ct.gl_receivable_account_id] || { id: ct.gl_receivable_account_id };
  plan.credit = A[ct.gl_revenue_account_id] || { id: ct.gl_revenue_account_id };
  plan.description = `ARC Fee - ${decision.reference_number || `ACC application decided ${plan.posting_date}`}`;
  return plan;
}

async function postAccFee(supabase, decision, { actorUserId = null, postingDate = null, deps = {} } = {}) {
  const plan = await planAccFee(supabase, decision, { postingDate, deps });
  if (plan.already_posted) return { posted: true, already: true, ...plan.already_posted, plan };
  if (plan.holds.length) return { posted: false, held: true, holds: plan.holds, plan };
  const postJE = deps.postJE || require('../accounting/posting').postJournalEntry;
  const voidJE = deps.voidJE || require('../accounting/posting').voidJournalEntry;
  const postCharge = deps.postCharge || require('../accounting/homeowner_charge').postHomeownerCharge;
  const je = await postJE({
    community_id: plan.community_id, posting_date: plan.posting_date,
    description: `${plan.description} — ${plan.street_address}`,
    source_module: 'acc_fee', source_reference: decision.id, posted_by_user_id: actorUserId,
    lines: [
      { account_id: plan.debit.id, debit_cents: plan.amount_cents, credit_cents: 0, memo: plan.description, property_id: plan.property_id },
      { account_id: plan.credit.id, debit_cents: 0, credit_cents: plan.amount_cents, memo: `${plan.description} (homeowner recovery)`, property_id: plan.property_id },
    ],
  });
  const jeId = je && je.entry && je.entry.id;
  if (!jeId) throw new Error('ACC fee journal entry did not return an id');
  try {
    const charge = await postCharge(supabase, {
      communityId: plan.community_id, propertyId: plan.property_id, tenureId: plan.tenure_id,
      transactionDate: plan.posting_date, description: plan.description, chargeCategory: 'other', amountCents: plan.amount_cents,
      notes: `ACC application fee, decision ${plan.reference || decision.id}`,
      raw: { source: 'acc_decision', acc_decision_id: decision.id, journal_entry_id: jeId },
    });
    return { posted: true, homeowner_transaction_id: charge.chargeId, journal_entry_id: jeId, amount_cents: plan.amount_cents, property_id: plan.property_id, plan };
  } catch (e) {
    await voidJE({ journal_entry_id: jeId, void_reason: `ACC fee ledger write failed: ${e.message}`.slice(0, 500), reversal_date: plan.posting_date, posted_by_user_id: actorUserId });
    throw e;
  }
}

module.exports = { planAccFee, postAccFee, DUP_WINDOW_DAYS };
