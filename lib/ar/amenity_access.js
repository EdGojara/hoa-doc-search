// ============================================================================
// lib/ar/amenity_access.js — Legally-defensible amenity access decision
// ----------------------------------------------------------------------------
// Ed 2026-06-08 — Associations have been sued for wrongly denying amenity
// access. The rule is NOT "owes money = denied." The rule is much more
// specific:
//
//   DENY only when:
//     - The DELINQUENT AMOUNT in ASSESSMENT-CLASS categories
//       (assessment + late_fee + interest) is past-due AND
//     - NO active payment plan exists AND
//     - Property is NOT in bankruptcy (don't pile on during stay)
//
//   ALLOW in all other cases — including:
//     - Property owes only fines / attorney fees / admin fees
//     - Active payment plan (current on plan)
//     - In bankruptcy (don't restrict during stay)
//     - Balance is zero or net credit
//
// The decision is rendered as a structured result so:
//   - Claire can read it and explain the reason TO the homeowner
//   - The operator UI can show "Why" they're allowed/denied
//   - An auditor can replay the inputs and verify the decision
//
// USAGE:
//   const { evaluateAmenityAccess } = require('./amenity_access');
//   const decision = await evaluateAmenityAccess(supabase, {
//     propertyId, vantacaAccountId, communityId,
//   });
//   if (decision.allowed) { // ... } else { surface decision.reason }
//
// RETURNS:
//   {
//     allowed: boolean,
//     reason: string (human-readable, suitable for Claire to read),
//     basis: { assessment_past_due_cents, fines_cents, attorney_fees_cents, ... },
//     enforcement_override?: 'in_bankruptcy' | 'on_payment_plan',
//     threshold_applied_cents: number (community-tunable; default 0)
//   }
// ============================================================================

// Categories that count toward "delinquent assessment" for denial purposes.
// Fines, attorney fees, admin fees do NOT — keeping access available when
// the only debt is fines is the case law that's been litigated.
const ASSESSMENT_DENIAL_CATEGORIES = new Set(['assessment', 'late_fee', 'interest']);

// Default grace amount — communities can override per-community. $0 means
// any past-due assessment triggers denial. Some communities give a $50
// grace before denial.
const DEFAULT_GRACE_CENTS = 0;

/**
 * Evaluate whether amenity access should be allowed for a property.
 *
 * @param {object} supabase
 * @param {{ propertyId?: string, vantacaAccountId?: string, communityId?: string, graceCents?: number }} opts
 * @returns {Promise<object>} decision
 */
async function evaluateAmenityAccess(supabase, opts = {}) {
  let { propertyId, vantacaAccountId, communityId, graceCents } = opts;
  const grace = (graceCents != null && Number.isFinite(graceCents)) ? graceCents : DEFAULT_GRACE_CENTS;

  // Resolve any missing identifiers from the property
  if (propertyId && (!vantacaAccountId || !communityId)) {
    try {
      const { data: p } = await supabase
        .from('properties')
        .select('vantaca_account_id, community_id')
        .eq('id', propertyId)
        .maybeSingle();
      if (p) {
        vantacaAccountId = vantacaAccountId || p.vantaca_account_id || null;
        communityId      = communityId      || p.community_id      || null;
      }
    } catch (_) {}
  }

  // Step 1 — enforcement state overrides
  let enforcement = null;
  if (propertyId) {
    try {
      const { data: es } = await supabase
        .from('v_current_enforcement_state')
        .select('state, payment_plan_terms_text')
        .eq('property_id', propertyId)
        .maybeSingle();
      enforcement = es || null;
    } catch (_) {}
  }

  // In bankruptcy → ALWAYS allow (stay protection + sensitivity)
  if (enforcement?.state === 'in_bankruptcy') {
    return {
      allowed: true,
      reason: 'Property is in bankruptcy — amenity access stays open during the case. Don\'t pile restrictions on a homeowner under §362 protection.',
      basis: {},
      enforcement_override: 'in_bankruptcy',
      threshold_applied_cents: grace,
    };
  }

  // Active payment plan → ALWAYS allow (presumes current; operator would
  // change state if plan went into default)
  if (enforcement?.state === 'on_payment_plan') {
    return {
      allowed: true,
      reason: `Active payment plan on file${enforcement.payment_plan_terms_text ? ' (' + enforcement.payment_plan_terms_text + ')' : ''}. Amenity access remains available as long as plan is current.`,
      basis: {},
      enforcement_override: 'on_payment_plan',
      threshold_applied_cents: grace,
    };
  }

  // Step 2 — balance composition lookup
  if (!vantacaAccountId || !communityId) {
    // No way to compute — allow with explanation. Better to default open
    // than wrongly deny.
    return {
      allowed: true,
      reason: 'No Vantaca account on file for this property — cannot compute balance composition. Defaulting to allow.',
      basis: {},
      threshold_applied_cents: grace,
    };
  }

  const { data: rows, error } = await supabase
    .from('v_homeowner_balance_composition')
    .select('charge_category, amount_cents')
    .eq('community_id', communityId)
    .eq('vantaca_account_id', vantacaAccountId);
  if (error) {
    return {
      allowed: true,
      reason: `Couldn't read balance composition (${error.message}). Defaulting to allow.`,
      basis: {},
      threshold_applied_cents: grace,
    };
  }

  const basis = {
    assessment_cents:  0,
    late_fee_cents:    0,
    interest_cents:    0,
    fine_cents:        0,
    attorney_fee_cents: 0,
    admin_fee_cents:   0,
    payment_cents:     0,
    credit_cents:      0,
    other_cents:       0,
  };
  for (const r of (rows || [])) {
    const cat = r.charge_category;
    const amt = Number(r.amount_cents || 0);
    const key = (cat === 'assessment') ? 'assessment_cents'
              : (cat === 'late_fee')   ? 'late_fee_cents'
              : (cat === 'interest')   ? 'interest_cents'
              : (cat === 'fine')       ? 'fine_cents'
              : (cat === 'attorney_fee') ? 'attorney_fee_cents'
              : (cat === 'admin_fee')  ? 'admin_fee_cents'
              : (cat === 'payment')    ? 'payment_cents'
              : (cat === 'credit' || cat === 'refund') ? 'credit_cents'
              : 'other_cents';
    basis[key] += amt;
  }

  // Delinquent assessment amount = assessment + late_fee + interest (these
  // are the "assessment class" charges). Payments + credits are signed
  // negative in homeowner_transactions, so they already reduce these sums
  // through the rolling-balance view — but the composition view groups by
  // category, so payments are in their own bucket. The assessment buckets
  // here represent gross assessment charges before payment application.
  //
  // For an accurate "is the assessment side delinquent," we need:
  //   net_assessment = assessment_charges - payments_applied_to_assessment
  // Vantaca doesn't tell us how payments were APPLIED across categories,
  // so we use a conservative rule:
  //   net_assessment_delinquent ≈ assessment + late_fee + interest + min(0, payment_cents + credit_cents)
  // Where the negative-only portion of payments/credits is applied first
  // to the assessment side (because payment plans + collections target
  // assessments preferentially).
  //
  // Simpler shorthand for v1: if the SUM across all categories (which is
  // the total balance) minus the fine + attorney + admin amounts is
  // greater than the grace threshold, treat as assessment-side delinquent.

  const totalBalance = Object.values(basis).reduce((a, b) => a + b, 0);
  const nonAssessmentBalance =
    basis.fine_cents + basis.attorney_fee_cents + basis.admin_fee_cents;
  const assessmentSideNet = totalBalance - nonAssessmentBalance;

  const assessmentDelinquent = assessmentSideNet > grace;

  if (totalBalance <= grace) {
    return {
      allowed: true,
      reason: 'Balance is within the grace threshold. Amenity access allowed.',
      basis,
      threshold_applied_cents: grace,
    };
  }

  if (!assessmentDelinquent) {
    return {
      allowed: true,
      reason: `Past-due balance exists but it's not in the assessment class — only fines / attorney fees / admin fees. Amenity access cannot be denied on those alone.`,
      basis,
      threshold_applied_cents: grace,
    };
  }

  // Assessment-class delinquent + no plan → deny
  const dollars = (cents) => '$' + (cents / 100).toFixed(2);
  return {
    allowed: false,
    reason: `Past-due assessment balance of ${dollars(assessmentSideNet)} with no active payment plan. Amenity access denied until the assessment side is brought current or a payment plan is set up. (Fines / attorney fees / admin fees of ${dollars(nonAssessmentBalance)} do NOT factor into denial — only assessments + assessment-related charges.)`,
    basis,
    threshold_applied_cents: grace,
  };
}

module.exports = { evaluateAmenityAccess, ASSESSMENT_DENIAL_CATEGORIES };
