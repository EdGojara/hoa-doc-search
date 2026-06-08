// ============================================================================
// lib/enforcement/regulatory_guard.js — structural prevention of regulatory violations
// ----------------------------------------------------------------------------
// Ed 2026-06-08 — Every code path that produces a letter, postcard, fine,
// or other collection communication MUST go through this guard first.
//
// The states that block communication:
//   in_bankruptcy → 11 USC §362 automatic stay. ANY collection communication
//                   is a sanctionable federal violation. HARD STOP.
//   at_legal      → FDCPA scoping. Once turned over to counsel, Bedrock
//                   communicating directly is an FDCPA violation. HARD STOP.
//   in_collections → Formal collections process — direct contact restricted.
//                    HARD STOP for collection-classified communications.
//
// Lien filed / judgment / payment plan / current do NOT block communication
// (different operational concerns; e.g., a payment-plan owner can still get
// an ACC decision letter — that's not a collection communication).
//
// USAGE:
//
//   const { assertCanSendCommunication } = require('./regulatory_guard');
//
//   async function renderViolationLetter(ctx) {
//     await assertCanSendCommunication(supabase, ctx.property.id, 'violation_letter');
//     // ... safe to proceed
//   }
//
// On block, throws RegulatoryBlockError with:
//   .code  = 'regulatory_block'
//   .state = 'in_bankruptcy' | 'at_legal' | 'in_collections'
//   .reason = human-readable explanation for UI surfacing
//   .attorney_contact = { name, email, phone } when on file
//
// The API endpoints calling renderers should catch this error and return
// HTTP 409 with the reason — the operator sees a loud red banner explaining
// why the letter was blocked. Structural enforcement, not "remember to
// check first."
// ============================================================================

// ----------------------------------------------------------------------------
// LEGAL FRAMEWORK (Ed correction 2026-06-08):
//
// §362 automatic stay covers DEBT COLLECTION on pre-petition claims. It
// does NOT cover:
//   - Covenant enforcement (DRV violation letters, postcards) — these
//     are NOT money claims; they enforce community restrictions.
//   - Post-petition assessments — the HOA can continue billing for
//     assessments that accrue AFTER the petition date.
//   - Force-mow notices — covenant enforcement; the resulting charge
//     may be subject to stay scrutiny separately.
//
// What §362 DOES cover (HARD BLOCK during in_bankruptcy):
//   - Fine assessment on pre-petition violations (money claim)
//   - Demand letters for pre-petition AR balances
//   - Payment reminders for pre-petition debt
//   - Collection-related certified §209 mail
//   - Pre-petition lien filings
//
// at_legal: FDCPA prohibits Bedrock from direct collection contact, but
// covenant enforcement is handled by management (not the collection
// attorney), so warn but allow.
//
// in_collections: similar — collection is restricted, enforcement is not.
//
// THREE TIERS per communication type:
//   block: states that HARD-REFUSE (throw RegulatoryBlockError)
//   warn:  states that show a warning (operator can override)
//   none:  states where the type is unrestricted
// ----------------------------------------------------------------------------
const COMMUNICATION_RULES = {
  // ---- HARD COLLECTION CLASS ----
  // These are unambiguously debt collection. Block in bankruptcy. Warn
  // at_legal/in_collections because the collection attorney should be
  // the one driving these, not Bedrock directly.
  fine_assessment:           { block: ['in_bankruptcy'],                       warn: ['at_legal', 'in_collections'] },
  payment_reminder:          { block: ['in_bankruptcy'],                       warn: ['at_legal', 'in_collections'] },
  ar_statement:              { block: ['in_bankruptcy'],                       warn: ['at_legal', 'in_collections'] },
  certified_209_collection:  { block: ['in_bankruptcy', 'at_legal'],          warn: ['in_collections'] },
  lien_filing:               { block: ['in_bankruptcy'],                       warn: ['at_legal'] },

  // ---- COVENANT ENFORCEMENT CLASS ----
  // These are NOT money claims. Bankruptcy does not bar them. Warn so
  // operator is aware of the broader situation, but allow.
  violation_letter:          { block: [],                                      warn: ['in_bankruptcy', 'at_legal'] },
  postcard_reminder:         { block: [],                                      warn: ['in_bankruptcy', 'at_legal'] },
  force_mow_letter:          { block: [],                                      warn: ['in_bankruptcy', 'at_legal'] },
  certified_209_drv:         { block: [],                                      warn: ['in_bankruptcy', 'at_legal'] },

  // ---- ENGAGEMENT-CLASS ----
  // Community communication — newsletters, events, pool closures, meeting
  // notices, etc. NOT debt collection. The §362 stay doesn't reach this.
  // FDCPA doesn't reach this. Everyone in the community gets these.
  // (Ed correction 2026-06-08 — my initial pass over-warned here.)
  engagement_blast:          { block: [], warn: [] },
  meeting_notice:            { block: [], warn: [] },

  // ---- OPERATIONAL ----
  // No restrictions — these don't touch debt OR enforcement.
  acc_decision:              { block: [], warn: [] },
  amenity_response:          { block: [], warn: [] },
  event_notice:              { block: [], warn: [] },
};

class RegulatoryBlockError extends Error {
  constructor({ state, communicationType, attorneyContact, propertyId, reason }) {
    super(reason || `Regulatory block: cannot send ${communicationType} to property in state "${state}".`);
    this.code = 'regulatory_block';
    this.state = state;
    this.communication_type = communicationType;
    this.property_id = propertyId;
    this.attorney_contact = attorneyContact || null;
    this.http_status = 409;
  }
}

// ----------------------------------------------------------------------------
// assertCanSendCommunication — guard called by every communication path.
//
// Returns:
//   null   → clear to send, no warning
//   { warning, state, attorney_contact } → operator should be warned but
//                                          allowed to proceed
//
// Throws RegulatoryBlockError when the type is hard-blocked for this state.
//
// Caller pattern:
//   const warn = await assertCanSendCommunication(supabase, propertyId, 'violation_letter');
//   if (warn) { /* surface warning in UI, allow override */ }
//   // proceed with render
// ----------------------------------------------------------------------------
async function assertCanSendCommunication(supabase, propertyId, communicationType) {
  if (!propertyId) return null;
  const rules = COMMUNICATION_RULES[communicationType];
  if (rules == null) {
    // Unknown type — default to the most cautious matrix to avoid silent
    // allow. Treat as hard block for bankruptcy, warn for at_legal.
    console.warn(`[regulatory_guard] unknown communication_type='${communicationType}' — defaulting to cautious matrix`);
  }
  const blockStates = rules?.block || ['in_bankruptcy'];
  const warnStates  = rules?.warn  || ['at_legal', 'in_collections'];

  const { data: es } = await supabase
    .from('v_current_enforcement_state')
    .select('state, attorney_name, attorney_firm, attorney_email, attorney_phone, bankruptcy_attorney_name, bankruptcy_attorney_email, bankruptcy_chapter, bankruptcy_case_number, bankruptcy_court, effective_at')
    .eq('property_id', propertyId)
    .maybeSingle();

  if (!es) return null;

  const attorneyContact = (() => {
    if (es.state === 'in_bankruptcy') {
      return es.bankruptcy_attorney_name ? {
        name: es.bankruptcy_attorney_name,
        email: es.bankruptcy_attorney_email,
        type: 'bankruptcy_attorney',
      } : null;
    }
    if (es.attorney_name || es.attorney_firm) {
      return {
        name: es.attorney_name || es.attorney_firm,
        email: es.attorney_email,
        phone: es.attorney_phone,
        type: 'collections_attorney',
      };
    }
    return null;
  })();

  // HARD BLOCK
  if (blockStates.includes(es.state)) {
    let reason;
    if (es.state === 'in_bankruptcy') {
      const caseDetails = es.bankruptcy_case_number
        ? `Chapter ${es.bankruptcy_chapter || '?'} case ${es.bankruptcy_case_number}${es.bankruptcy_court ? ' (' + es.bankruptcy_court + ')' : ''}`
        : 'bankruptcy filing on file';
      const refer = attorneyContact?.name
        ? `Refer to bankruptcy attorney: ${attorneyContact.name}${attorneyContact.email ? ' (' + attorneyContact.email + ')' : ''}.`
        : 'Refer to the homeowner\'s bankruptcy attorney.';
      reason = `🛑 BLOCKED — 11 USC §362 automatic stay. ${caseDetails}. Sending a ${communicationType.replace(/_/g, ' ')} is debt-collection activity barred by the stay — sanctionable federal violation. ${refer}`;
    } else if (es.state === 'at_legal') {
      const refer = attorneyContact?.name
        ? `Refer to: ${attorneyContact.name}${attorneyContact.email ? ' (' + attorneyContact.email + ')' : ''}.`
        : 'Refer to the attorney on file.';
      reason = `⚖ BLOCKED — Account is at-legal. FDCPA prohibits Bedrock from sending a ${communicationType.replace(/_/g, ' ')} once collection is turned over to counsel. ${refer}`;
    } else if (es.state === 'in_collections') {
      reason = `⚠ BLOCKED — Account is in collections. ${communicationType.replace(/_/g, ' ')} must be routed through the collections process.`;
    } else {
      reason = `BLOCKED — Property is in state "${es.state}", which doesn't permit ${communicationType}.`;
    }
    throw new RegulatoryBlockError({
      state: es.state,
      communicationType,
      propertyId,
      attorneyContact,
      reason,
    });
  }

  // SOFT WARN — allow but surface context
  if (warnStates.includes(es.state)) {
    let warning;
    if (es.state === 'in_bankruptcy') {
      // For covenant enforcement during bankruptcy — allowed because the
      // §362 stay covers debt collection, NOT covenant enforcement, but
      // the operator should still know what they're walking into.
      warning = `Property is in bankruptcy (Chapter ${es.bankruptcy_chapter || '?'}). This ${communicationType.replace(/_/g, ' ')} is covenant enforcement, not debt collection, so §362 stay does NOT bar it — but verify with counsel if any fine/fee is attached. Bankruptcy attorney on file: ${attorneyContact?.name || 'not entered'}.`;
    } else if (es.state === 'at_legal') {
      warning = `Property is at-legal for collections${attorneyContact?.name ? ' (attorney: ' + attorneyContact.name + ')' : ''}. Covenant enforcement is handled by Bedrock and is NOT subject to FDCPA — but if this ${communicationType.replace(/_/g, ' ')} includes a fine/fee, the collection attorney should drive that.`;
    } else if (es.state === 'in_collections') {
      warning = `Property is in collections. Verify this ${communicationType.replace(/_/g, ' ')} doesn't conflict with the collections process before sending.`;
    } else {
      warning = `Property is in state "${es.state}". Verify before sending.`;
    }
    return {
      warning,
      state: es.state,
      attorney_contact: attorneyContact,
      blocked: false,
    };
  }

  return null;  // unrestricted
}

module.exports = {
  assertCanSendCommunication,
  RegulatoryBlockError,
  COMMUNICATION_RULES,   // exported for tests + future audit
};
