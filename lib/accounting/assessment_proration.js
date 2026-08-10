// ============================================================================
// lib/accounting/assessment_proration.js  (Ed 2026-08-10)
// ----------------------------------------------------------------------------
// Prorated assessments at a property transfer. Three transfer types, treated
// differently (Ed 2026-08-10):
//   developer_to_builder -> new prorated charge at the BUILDER rate
//   builder_to_homeowner -> new prorated charge at the HOMEOWNER rate
//   owner_resale         -> NO new HOA charge (already billed to the property;
//                           title prorates on the closing statement)
// Proration is daily: annual * remaining_days_in_year / days_in_year, from the
// transfer date to the community's fiscal year-end. Matches the one-off August
// Meadows script (224/365 * $400 = $245.48 from 2026-05-21).
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const { createCharge } = require('./ar_engine');
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

// Post the prorated assessment to whichever owner-AR ledger the community uses.
// Communities on the GL subledger have an 'assessment' ar_charge_type with GL
// mappings -> createCharge (posts AR + revenue JE). Native-AR communities (Still
// Creek Ranch, August Meadows: thousands of homeowner_transactions, zero
// ar_charges) get a homeowner_transactions charge line, the same ledger the
// August Meadows builder-assessment import wrote to. Returns { ledger, charge_id }.
async function postAssessmentCharge({ community_id, property_id, effective_date, amount_cents, description }) {
  // GL path if this community bills assessments through the GL subledger.
  const { data: ct } = await supabase.from('ar_charge_types')
    .select('id, gl_revenue_account_id, gl_receivable_account_id')
    .eq('community_id', community_id).eq('type_code', 'assessment').eq('is_active', true).maybeSingle();
  if (ct && ct.gl_revenue_account_id && ct.gl_receivable_account_id) {
    const charge = await createCharge({
      community_id, property_id, charge_type_code: 'assessment', amount_cents,
      charge_date: effective_date, due_date: effective_date, description,
      source_module: 'assessment_billing',
    });
    const id = (charge && (charge.charge?.id || charge.ar_charge?.id || charge.id)) || null;
    return { ledger: 'gl', charge_id: id };
  }

  // Native-AR path — homeowner_transactions (needs a batch; identity + running
  // balance resolved from the property's existing ledger).
  const { data: idRow } = await supabase.from('homeowner_transactions')
    .select('trusted_account_number, vantaca_account_id').eq('property_id', property_id)
    .order('transaction_date', { ascending: false }).limit(1).maybeSingle();
  let trusted = idRow ? idRow.trusted_account_number : null;
  const vantaca = idRow ? idRow.vantaca_account_id : null;
  if (!trusted) {
    const { data: prop } = await supabase.from('properties').select('trusted_account_number').eq('id', property_id).maybeSingle();
    trusted = prop ? prop.trusted_account_number : null;
  }
  // Current balance = sum of this property's ledger lines.
  const { data: txns } = await supabase.from('homeowner_transactions').select('amount_cents').eq('property_id', property_id);
  const currentBal = (txns || []).reduce((s, t) => s + Number(t.amount_cents || 0), 0);

  const { data: comm } = await supabase.from('communities').select('management_company_id').eq('id', community_id).maybeSingle();
  const { data: batch, error: bErr } = await supabase.from('transaction_upload_batches').insert({
    management_company_id: (comm && comm.management_company_id) || BEDROCK_MGMT_CO_ID,
    community_id, period_label: `Proration ${effective_date}`, as_of_date: effective_date,
    source_format: 'manual', status: 'committed', uploaded_by: 'transfer_proration',
    row_count: 1, account_count: 1, total_charges_cents: amount_cents, total_payments_cents: 0,
    min_transaction_date: effective_date, max_transaction_date: effective_date,
    committed_at: new Date().toISOString(), notes: description,
  }).select('id').single();
  if (bErr) throw bErr;

  const { data: txn, error: tErr } = await supabase.from('homeowner_transactions').insert({
    source_batch_id: batch.id, source_row_index: 0, community_id, property_id,
    trusted_account_number: trusted, vantaca_account_id: vantaca,
    transaction_date: effective_date, description, txn_type: 'charge', charge_category: 'assessment',
    amount_cents, running_balance_cents: currentBal + amount_cents, is_operator_override: true,
    notes: 'Prorated assessment posted at transfer',
  }).select('id').single();
  if (tErr) throw tErr;
  return { ledger: 'native', charge_id: txn.id };
}

const TRANSFER_TYPES = ['developer_to_builder', 'builder_to_homeowner', 'owner_resale'];
// The buyer's class decides which rate applies. Resale creates no charge.
const OWNER_CLASS_FOR = { developer_to_builder: 'builder', builder_to_homeowner: 'homeowner', owner_resale: null };

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInYear = (y) => (isLeap(y) ? 366 : 365);
// 1-based day of the year for a 'YYYY-MM-DD' date (UTC-safe, no Date.now()).
function dayOfYear(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const start = Date.UTC(y, 0, 0);
  const cur = Date.UTC(y, m - 1, d);
  return Math.round((cur - start) / 86400000);
}
const money = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function getRate(communityId, ownerClass) {
  const { data, error } = await supabase.from('community_assessment_rates')
    .select('*').eq('community_id', communityId).eq('owner_class', ownerClass).maybeSingle();
  if (error) throw error;
  return data;
}

// Compute the proration WITHOUT posting. Returns a breakdown the UI previews.
async function computeProration({ community_id, property_id, transfer_type, effective_date }) {
  if (!community_id) throw Object.assign(new Error('community_id_required'), { code: 'invalid_input' });
  if (!TRANSFER_TYPES.includes(transfer_type)) throw Object.assign(new Error('invalid_transfer_type'), { code: 'invalid_input' });
  if (!effective_date || !/^\d{4}-\d{2}-\d{2}$/.test(effective_date)) throw Object.assign(new Error('effective_date_required'), { code: 'invalid_input' });

  const ownerClass = OWNER_CLASS_FOR[transfer_type];

  // Resale: no new HOA charge — ownership + balance transfer only.
  if (transfer_type === 'owner_resale') {
    return {
      transfer_type, owner_class: null, charge: false, prorated_amount_cents: 0,
      note: 'Resale — the year’s assessment is already billed to the property; title prorates it on the closing statement. No new HOA charge; ownership and balance transfer only.',
    };
  }

  const rate = await getRate(community_id, ownerClass);
  if (!rate) {
    return { transfer_type, owner_class: ownerClass, charge: false, prorated_amount_cents: 0,
      error: 'no_rate', note: `No ${ownerClass} assessment rate set for this community — set it first.` };
  }

  const year = Number(effective_date.slice(0, 4));
  const fiscalYearEnd = `${year}-${rate.fiscal_year_end_mmdd}`;
  const diy = daysInYear(year);
  // Days from the transfer date to year-end (transfer date owned by the seller;
  // buyer owes from the next day through year-end — the August Meadows basis).
  let remainingDays = dayOfYear(fiscalYearEnd) - dayOfYear(effective_date);
  if (remainingDays < 0) remainingDays = 0;
  if (remainingDays > diy) remainingDays = diy;
  const prorated = Math.round(Number(rate.annual_amount_cents) * remainingDays / diy);

  return {
    transfer_type, owner_class: ownerClass, charge: prorated > 0,
    annual_amount_cents: rate.annual_amount_cents,
    fiscal_year_end: fiscalYearEnd, days_prorated: remainingDays, days_in_year: diy,
    prorated_amount_cents: prorated,
    note: `${remainingDays} of ${diy} days (${effective_date} → ${fiscalYearEnd}) × ${money(rate.annual_amount_cents)} ${ownerClass} rate = ${money(prorated)}.`,
  };
}

// Compute + post the AR charge (unless resale) + write the audit log. Refuses an
// exact re-run (same property + effective date + transfer type already charged)
// unless allow_duplicate.
async function postProration({ community_id, property_id, transfer_type, effective_date, posted_by, allow_duplicate = false, posted_by_user_id = null }) {
  if (!property_id) throw Object.assign(new Error('property_id_required'), { code: 'invalid_input' });
  const calc = await computeProration({ community_id, property_id, transfer_type, effective_date });
  if (calc.error) return { ok: false, ...calc };

  // Resale — log the transfer decision, post nothing.
  if (!calc.charge) {
    const { data: log } = await supabase.from('assessment_prorations').insert({
      community_id, property_id, transfer_type, owner_class: calc.owner_class,
      effective_date, fiscal_year_end: `${Number(effective_date.slice(0, 4))}-12-31`,
      days_prorated: 0, days_in_year: daysInYear(Number(effective_date.slice(0, 4))),
      annual_amount_cents: null, prorated_amount_cents: 0, ar_charge_id: null,
      posted_by: posted_by || 'staff', notes: calc.note,
    }).select('id').single();
    return { ok: true, charge: false, proration_id: log ? log.id : null, ...calc };
  }

  if (!allow_duplicate) {
    const { data: dup } = await supabase.from('assessment_prorations')
      .select('id, prorated_amount_cents').eq('property_id', property_id)
      .eq('effective_date', effective_date).eq('transfer_type', transfer_type)
      .gt('prorated_amount_cents', 0).limit(1);
    if (dup && dup.length) {
      return { ok: false, error: 'already_prorated', detail: `This lot was already prorated for a ${transfer_type.replace(/_/g, ' ')} on ${effective_date} (${money(dup[0].prorated_amount_cents)}).`, ...calc };
    }
  }

  const desc = `Prorated ${calc.owner_class} assessment ${effective_date} → ${calc.fiscal_year_end} (${calc.days_prorated}/${calc.days_in_year} of ${money(calc.annual_amount_cents)})`;
  let posted;
  try {
    posted = await postAssessmentCharge({
      community_id, property_id, effective_date, amount_cents: calc.prorated_amount_cents, description: desc,
    });
  } catch (e) {
    return { ok: false, error: e.code || 'charge_failed', detail: e.message, ...calc };
  }
  const chargeId = posted.charge_id;

  const { data: log } = await supabase.from('assessment_prorations').insert({
    community_id, property_id, transfer_type, owner_class: calc.owner_class,
    effective_date, fiscal_year_end: calc.fiscal_year_end,
    days_prorated: calc.days_prorated, days_in_year: calc.days_in_year,
    annual_amount_cents: calc.annual_amount_cents, prorated_amount_cents: calc.prorated_amount_cents,
    ar_charge_id: chargeId, posted_by: posted_by || 'staff', notes: desc,
  }).select('id').single();

  return { ok: true, charge: true, proration_id: log ? log.id : null, ar_charge_id: chargeId, ...calc };
}

async function listRates(communityId) {
  const { data, error } = await supabase.from('community_assessment_rates')
    .select('*').eq('community_id', communityId).order('owner_class');
  if (error) throw error;
  return data || [];
}

async function upsertRate({ community_id, owner_class, annual_amount_cents, fiscal_year_end_mmdd, notes }) {
  if (!community_id) throw Object.assign(new Error('community_id_required'), { code: 'invalid_input' });
  if (!['builder', 'homeowner'].includes(owner_class)) throw Object.assign(new Error('invalid_owner_class'), { code: 'invalid_input' });
  const cents = Math.round(Number(annual_amount_cents));
  if (!Number.isFinite(cents) || cents < 0) throw Object.assign(new Error('annual_amount_required'), { code: 'invalid_input' });
  const row = { community_id, owner_class, annual_amount_cents: cents };
  if (fiscal_year_end_mmdd && /^\d{2}-\d{2}$/.test(fiscal_year_end_mmdd)) row.fiscal_year_end_mmdd = fiscal_year_end_mmdd;
  if (notes != null) row.notes = notes;
  const { data, error } = await supabase.from('community_assessment_rates')
    .upsert(row, { onConflict: 'community_id,owner_class' }).select('*').single();
  if (error) throw error;
  return data;
}

async function listHistory({ community_id, property_id }) {
  let q = supabase.from('assessment_prorations')
    .select('*, properties(street_address)').eq('community_id', community_id)
    .order('created_at', { ascending: false }).limit(500);
  if (property_id) q = q.eq('property_id', property_id);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

module.exports = { computeProration, postProration, listRates, upsertRate, listHistory, TRANSFER_TYPES };
