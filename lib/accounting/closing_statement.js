// ============================================================================
// lib/accounting/closing_statement.js  (Ed 2026-11-26)
// ----------------------------------------------------------------------------
// What is due at a closing, in the sections the closing screen must show
// separately: due from the seller, due from the buyer, the capitalization fee
// (capital contribution), other fees (each identified, with who it is payable
// to), and the total due at closing.
//
// Before this, the builder-to-homeowner closing screen showed only the
// assessment proration (transfer_proration_plan). It never showed the
// capitalization fee the declaration requires on every transfer, never added
// the seller's unpaid balance to what the seller owes at closing, and never
// gave a total. Staff had to assemble the closing amount by hand.
//
// Rules (configuration, never a community name in code):
//   seller  = the seller's open balance on its own account (what the ledger
//             says it owes today, which already includes any assessment
//             billed to it this year) + the builder proration charge the
//             transfer will post for its unbilled days.
//   buyer   = the prorated assessment from the settlement date to year end.
//   capitalization fee = capitalization_fee_pct of the then-current annual
//             assessment (community_assessment_rates, homeowner row), NOT
//             prorated, payable by the person acquiring title. Not configured
//             = the statement is INCOMPLETE (never a silent $0).
//   other fees = only fees staff entered from the title packet / resale demand
//             (e.g. the management company's transfer fee); each keeps its
//             label and payee. Management company fees are never Association
//             money and are totaled apart.
// A seller balance the ledger cannot state (UNKNOWN) also makes the statement
// incomplete. Nothing here writes anything.
// ============================================================================

const isCents = (v) => v != null && v !== '' && Number.isFinite(Number(v));
const cents = (v) => Math.round(Number(v));

// The capitalization fee for a sale. PURE.
//   rate: the homeowner rate row ({ annual_amount_cents, capitalization_fee_pct, capitalization_fee_evidence })
function capitalizationFee(rate) {
  if (!rate || !isCents(rate.annual_amount_cents)) return { configured: false, reason: 'annual_assessment_missing' };
  if (rate.capitalization_fee_pct == null) return { configured: false, reason: 'capitalization_fee_not_configured' };
  const pct = Number(rate.capitalization_fee_pct);
  if (!Number.isFinite(pct) || pct < 0) return { configured: false, reason: 'capitalization_fee_invalid' };
  return {
    configured: true, pct, annual_assessment_cents: cents(rate.annual_amount_cents),
    amount_cents: Math.round(Number(rate.annual_amount_cents) * pct / 100),
    prorated: false, payable_by: 'buyer', payable_to: 'association',
    evidence: rate.capitalization_fee_evidence || null,
  };
}

// The statement. PURE.
//   plan: transfer_proration_plan output (or null / applies:false for a sale with no builder proration)
//   seller: { balance_status: 'KNOWN'|'UNKNOWN', balance_cents }
//   capitalization: capitalizationFee(...) output
//   otherFees: [{ label, amount_cents, payable_by: 'buyer'|'seller', payable_to: 'association'|'management_company' }]
function buildClosingStatement({ plan, seller, capitalization, otherFees } = {}) {
  const gaps = [];
  const applies = !!(plan && plan.applies);
  if (applies && plan.blocked) gaps.push('assessment_proration_blocked');

  // Seller
  const sellerKnown = seller && seller.balance_status === 'KNOWN' && isCents(seller.balance_cents);
  if (!sellerKnown) gaps.push('seller_balance_unknown');
  const sellerOpen = sellerKnown ? cents(seller.balance_cents) : null;
  const builderCharge = applies ? cents(plan.builder_adjustment_cents || 0) : 0;
  const sellerLines = [
    { key: 'seller_open_balance', label: 'Seller account balance on file (charges billed to the seller, less payments)', amount_cents: sellerOpen },
  ];
  if (applies) sellerLines.push({ key: 'builder_proration', label: `Builder assessment for its unbilled days (${plan.builder_rate_pct}% rate)`, amount_cents: builderCharge,
    period_start: plan.builder_unbilled_period ? plan.builder_unbilled_period.start : plan.builder_period_start,
    period_end: plan.builder_unbilled_period ? plan.builder_unbilled_period.end : plan.builder_period_end,
    days: plan.builder_unbilled_period ? plan.builder_unbilled_period.days : plan.builder_days });
  const dueFromSeller = sellerKnown ? sellerOpen + builderCharge : null;

  // Buyer (the prorated assessment)
  const buyerProrated = applies ? cents(plan.homeowner_due_cents || 0) : 0;
  const buyerLines = applies ? [{ key: 'buyer_proration', label: `Prorated assessment ${plan.homeowner_period_start} to ${plan.homeowner_period_end} (${plan.homeowner_rate_pct}% rate)`,
    amount_cents: buyerProrated, days: plan.homeowner_days }] : [];

  // Capitalization fee
  const cap = capitalization || { configured: false, reason: 'capitalization_fee_not_configured' };
  if (!cap.configured) gaps.push(cap.reason || 'capitalization_fee_not_configured');
  const capCents = cap.configured ? cap.amount_cents : null;

  // Other fees, each identified
  const fees = [];
  for (const f of otherFees || []) {
    if (!f || !isCents(f.amount_cents) || !(Number(f.amount_cents) > 0)) continue;
    fees.push({ label: String(f.label || 'Fee'), amount_cents: cents(f.amount_cents),
      payable_by: f.payable_by === 'seller' ? 'seller' : 'buyer',
      payable_to: f.payable_to === 'management_company' ? 'management_company' : 'association' });
  }
  const feeSum = (pred) => fees.filter(pred).reduce((a, f) => a + f.amount_cents, 0);

  const complete = gaps.length === 0;
  const toAssociation = complete ? dueFromSeller + buyerProrated + capCents + feeSum((f) => f.payable_to === 'association') : null;
  const toManagement = feeSum((f) => f.payable_to === 'management_company');
  // The builder's actual-ownership schedule (lib/accounting/builder_ownership.js), shown with its formulas.
  const own = applies && plan.ownership && plan.ownership.applies ? {
    acquisition_date: plan.ownership.acquisition_date || null, acquisition_basis: plan.ownership.acquisition_basis || null,
    periods: (plan.ownership.schedule && plan.ownership.schedule.periods) || [], total_cents: plan.ownership.schedule ? plan.ownership.schedule.total_cents : null,
    prior_year_cents: plan.ownership.prior_year_cents || 0, holds: plan.ownership.holds || [], hold_text: plan.ownership.hold_text || [],
    warnings: plan.ownership.warnings || [], flags: plan.ownership.flags || [], packet_remittances: plan.ownership.packet_remittances || [],
  } : null;
  return {
    complete, gaps, builder_ownership: own,
    due_from_seller: { cents: dueFromSeller, lines: sellerLines },
    due_from_buyer: { cents: buyerProrated, lines: buyerLines },
    capitalization_fee: { cents: capCents, ...cap },
    other_fees: fees,
    payable_to_association_cents: toAssociation,
    payable_to_management_company_cents: toManagement,
    total_due_at_closing_cents: complete ? toAssociation + toManagement : null,
  };
}

const GAP_TEXT = {
  assessment_proration_blocked: 'the assessment proration is blocked (see above)',
  seller_balance_unknown: "the seller's balance is not known from the ledger",
  capitalization_fee_not_configured: "the community's capitalization fee is not configured (homeowner rate row)",
  capitalization_fee_invalid: "the community's capitalization fee setting is invalid",
  annual_assessment_missing: 'the annual assessment is not set for this community',
};
const gapText = (codes) => (codes || []).map((c) => GAP_TEXT[c] || c);

// The homeowner rate row with its capitalization fee. Before migration 579 the
// columns do not exist: the fee reads as not configured (never $0).
const _err = (e) => Object.assign(new Error(e.message || String(e)), { code: e.code });
async function loadCapitalization(supabase, communityId) {
  let { data, error } = await supabase.from('community_assessment_rates')
    .select('annual_amount_cents, capitalization_fee_pct, capitalization_fee_evidence')
    .eq('community_id', communityId).eq('owner_class', 'homeowner').maybeSingle();
  if (error && /capitalization_fee/.test(error.message || '')) {
    console.warn('[closing-statement] capitalization fee columns missing (migration 579 not applied)');
    ({ data, error } = await supabase.from('community_assessment_rates').select('annual_amount_cents')
      .eq('community_id', communityId).eq('owner_class', 'homeowner').maybeSingle());
    if (error) throw _err(error);
    return capitalizationFee(data ? { ...data, capitalization_fee_pct: null } : null);
  }
  if (error) throw _err(error);
  return capitalizationFee(data);
}

module.exports = { buildClosingStatement, capitalizationFee, loadCapitalization, gapText, GAP_TEXT };
