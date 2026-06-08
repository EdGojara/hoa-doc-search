// ============================================================================
// lib/ar/bankruptcy_charge_guard.js — Pre/post-petition charge legality guard
// ----------------------------------------------------------------------------
// Ed 2026-06-08 — When the accounting module assesses interest, fines,
// late fees, or other charges, it MUST consult this guard for any property
// in bankruptcy. The §362 automatic stay PROHIBITS post-petition collection
// of pre-petition debt, but the underlying rules differ by charge type:
//
//   INTEREST on pre-petition amounts:
//     - PROHIBITED. Cannot accrue or assess.
//     - Reason: 11 USC §502(b)(2) — claims for unmatured interest are
//       disallowed in the bankruptcy estate. Continuing to charge interest
//       on pre-petition balance is stay violation.
//
//   LATE FEES on pre-petition amounts:
//     - PROHIBITED. Same rationale — late fees calculated on pre-petition
//       balance ARE collection activity on pre-petition debt.
//
//   FINES (covenant violations):
//     - Pre-petition fines: cannot collect (frozen as pre-petition claim).
//     - Post-petition violation that occurs AFTER filing_date: CAN assess
//       as a post-petition fine (not subject to stay; debtor's post-petition
//       conduct).
//
//   ASSESSMENTS (monthly/annual):
//     - Pre-petition assessments: cannot collect (frozen as pre-petition).
//     - Post-petition assessments: CAN charge and collect. Continuing
//       assessments are a post-petition debt the homeowner owes.
//       Critical: in Chapter 13, post-petition assessments must be paid
//       through the plan or directly per the confirmation order.
//
// USAGE (when the accounting module lands):
//
//   const { assertChargeLegal } = require('./bankruptcy_charge_guard');
//   await assertChargeLegal(supabase, {
//     propertyId,
//     chargeType: 'interest',                // 'interest' | 'late_fee' | 'fine' | 'assessment'
//     chargeDate: '2026-06-15',              // when the charge would be assessed
//     basisIsPrePetition: true,              // if charging interest on $X, was $X pre-petition?
//   });
//   // Throws BankruptcyChargeBlockedError if illegal; returns silently if legal.
//
// PHILOSOPHY: this is "we know we'll forget" infrastructure. Build the guard
// now so accounting can NEVER assess interest on pre-petition without an
// explicit check. The function should be the only path that allows
// continuation; refusing-by-default is the safer side of the legal line.
// ============================================================================

class BankruptcyChargeBlockedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BankruptcyChargeBlockedError';
    this.code = 'bankruptcy_charge_blocked';
    this.details = details;
  }
}

/**
 * Check whether a proposed charge against a property is legal under §362.
 * Returns silently if legal. Throws BankruptcyChargeBlockedError if not.
 *
 * Properties NOT in bankruptcy → always legal (returns null).
 * Properties IN bankruptcy → applies the pre/post-petition rules above.
 *
 * @param {object} supabase
 * @param {{ propertyId: string, chargeType: string, chargeDate?: string,
 *           basisIsPrePetition?: boolean, violationDate?: string }} opts
 * @returns {Promise<{ allowed: boolean, reason: string, enforcement_state?: any }>}
 */
async function assertChargeLegal(supabase, opts = {}) {
  const { propertyId, chargeType, chargeDate, basisIsPrePetition, violationDate } = opts;
  if (!propertyId) throw new Error('propertyId required');
  if (!chargeType) throw new Error('chargeType required');

  // Look up current enforcement state
  const { data: es } = await supabase
    .from('v_current_enforcement_state')
    .select('state, bankruptcy_filing_date, bankruptcy_chapter, bankruptcy_case_number, bankruptcy_attorney_name')
    .eq('property_id', propertyId)
    .maybeSingle();

  // Not in bankruptcy → no §362 restriction
  if (!es || es.state !== 'in_bankruptcy') {
    return { allowed: true, reason: 'Property not in bankruptcy — no §362 restriction.' };
  }

  const filingDate = es.bankruptcy_filing_date;
  if (!filingDate) {
    // In bankruptcy with no filing date on file — we can't tell pre/post,
    // so we have to refuse the charge until operator records the date.
    throw new BankruptcyChargeBlockedError(
      `Property is in bankruptcy but no filing_date is recorded. Cannot determine pre/post-petition. Record filing_date on the enforcement state before assessing any charges.`,
      { propertyId, chargeType, state: 'in_bankruptcy', missing: 'filing_date' }
    );
  }

  const chargeDt = chargeDate || new Date().toISOString().slice(0, 10);

  switch (chargeType) {
    case 'interest':
      // Interest on pre-petition principal is PROHIBITED, period.
      if (basisIsPrePetition === true) {
        throw new BankruptcyChargeBlockedError(
          `Cannot assess interest on pre-petition balance. Property in bankruptcy since ${filingDate}; §502(b)(2) disallows unmatured interest on pre-petition claims. Refer to ${es.bankruptcy_attorney_name || 'bankruptcy counsel'}.`,
          { propertyId, chargeType, filingDate, basisIsPrePetition }
        );
      }
      // Interest on post-petition balance is technically allowed but
      // accounting policy needs operator review — surface a warning.
      return {
        allowed: true,
        reason: 'Interest on post-petition charges is technically allowed but requires bankruptcy attorney coordination. Recommend pause + attorney consult before assessing.',
        warning: true,
        enforcement_state: es,
      };

    case 'late_fee':
      // Late fees calculated on pre-petition balance = collection of
      // pre-petition debt = stay violation.
      if (basisIsPrePetition === true) {
        throw new BankruptcyChargeBlockedError(
          `Cannot assess late fee on pre-petition balance. Property in bankruptcy since ${filingDate}; calculating late fee on pre-petition debt is collection activity barred by §362.`,
          { propertyId, chargeType, filingDate, basisIsPrePetition }
        );
      }
      return {
        allowed: true,
        reason: 'Late fee on post-petition assessments is allowed.',
        enforcement_state: es,
      };

    case 'fine':
      // Fines for pre-petition violations: frozen (cannot collect).
      // Fines for post-petition violations: assessable (debtor's
      // post-filing conduct isn't shielded by §362).
      if (!violationDate) {
        throw new BankruptcyChargeBlockedError(
          `Cannot assess fine without a violation_date. Property in bankruptcy since ${filingDate}; pre-petition violations cannot be fined post-filing, post-petition violations can. Record the violation_date.`,
          { propertyId, chargeType, filingDate, missing: 'violation_date' }
        );
      }
      if (violationDate < filingDate) {
        throw new BankruptcyChargeBlockedError(
          `Cannot assess fine for a violation that occurred BEFORE the bankruptcy filing (violation ${violationDate} < filing ${filingDate}). Pre-petition violation = pre-petition claim, barred by §362.`,
          { propertyId, chargeType, filingDate, violationDate }
        );
      }
      return {
        allowed: true,
        reason: `Fine for post-petition violation (${violationDate} > filing ${filingDate}) is allowed.`,
        enforcement_state: es,
      };

    case 'assessment':
      // Regular continuing assessments post-filing are allowed. The
      // chargeDate must be post-filing to be a post-petition assessment.
      if (chargeDt < filingDate) {
        throw new BankruptcyChargeBlockedError(
          `Cannot assess a charge dated BEFORE the bankruptcy filing date (${chargeDt} < ${filingDate}). Pre-petition assessments are frozen.`,
          { propertyId, chargeType, filingDate, chargeDate: chargeDt }
        );
      }
      return {
        allowed: true,
        reason: `Post-petition assessment (${chargeDt} ≥ filing ${filingDate}) is allowed. In Ch 13, ensure homeowner is paying per confirmed plan.`,
        enforcement_state: es,
      };

    default:
      // Unknown charge type — refuse rather than guess
      throw new BankruptcyChargeBlockedError(
        `Unknown chargeType '${chargeType}' against bankruptcy property. Cannot determine legality. Refusing by default.`,
        { propertyId, chargeType }
      );
  }
}

module.exports = {
  assertChargeLegal,
  BankruptcyChargeBlockedError,
};
