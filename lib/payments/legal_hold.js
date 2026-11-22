// ============================================================================
// lib/payments/legal_hold.js  (Ed 2026-11-22: policy for accounts at legal)
// ----------------------------------------------------------------------------
// An account handled by legal counsel cannot pay online. The homeowner is
// sent to the law firm instead. Source of truth: the property's ACTIVE row in
// property_enforcement_states (migration 202): the same legal status and
// assigned attorney staff maintain on the Homeowner 360 legal panel. Nothing is
// copied; clearing (ending) the state restores payment access on the next
// request.
//
// Enforced on the server in lib/payments/assessment_checkout.js
// resolvePayableAssessment, the one gate every assessment payment path passes:
// portal Pay now (setup/quote/confirm), the older Checkout path, staff payment
// links, autopay enrollment, and each scheduled autopay notice and charge.
//
// Counsel contact shown to the homeowner is ONLY what staff recorded on the
// state (firm/attorney name, phone, email). Missing contact is never guessed or
// filled in: the hold still applies, the homeowner sees what is on file, and the
// account is flagged for staff (contact_complete=false) on the Lookup screen.
//
// Fails closed: if the status cannot be read, payment is refused.
// ============================================================================

const LEGAL_HOLD_MESSAGE = 'Your account is currently being handled by legal counsel. Please contact the law firm listed below regarding your account balance and payment arrangements.';

// States that mean counsel handles the account. A payment plan holds only when
// counsel administers it (an attorney is recorded on the state); a plan run by
// management is not "at legal".
const HELD_STATES = new Set(['at_legal', 'in_collections', 'in_bankruptcy', 'lien_filed', 'judgment']);

const clean = (v) => { const s = String(v == null ? '' : v).trim(); return s || null; };

// Pure. st = an active property_enforcement_states row (or null).
// -> null (no hold) | { held:true, state, message, counsel:{firm, attorney, phone, email}, contact_complete, missing:[] }
function holdFromState(st) {
  if (!st || !st.state) return null;
  const firm = clean(st.attorney_firm);
  const attorney = clean(st.attorney_name);
  const counselAssigned = !!(firm || attorney);
  const held = HELD_STATES.has(st.state) || (st.state === 'on_payment_plan' && counselAssigned);
  if (!held) return null;
  const counsel = { firm, attorney, phone: clean(st.attorney_phone), email: clean(st.attorney_email) };
  const missing = [];
  if (!counselAssigned) missing.push('law firm');
  if (!counsel.phone) missing.push('phone');
  if (!counsel.email) missing.push('email');
  return {
    held: true,
    state: st.state,
    message: LEGAL_HOLD_MESSAGE,
    counsel,
    // A firm and at least one way to reach it (phone or email) is enough for
    // the homeowner; anything short of that is flagged for staff.
    contact_complete: counselAssigned && !!(counsel.phone || counsel.email),
    missing,
  };
}

const STATE_COLUMNS = 'id, property_id, state, attorney_firm, attorney_name, attorney_phone, attorney_email';

// -> { ok:true, hold: null|{...} } | { ok:false, error }
async function legalHoldFor(supabase, propertyId) {
  if (!propertyId) return { ok: true, hold: null };
  const { data, error } = await supabase.from('property_enforcement_states')
    .select(STATE_COLUMNS).eq('property_id', propertyId).is('ended_at', null).limit(2);
  if (error) {
    console.warn(`[legal_hold] status lookup failed for property=${propertyId}: ${error.message}`);
    return { ok: false, error: error.message };
  }
  // One active row per property (partial unique index); take the first.
  return { ok: true, hold: holdFromState((data || [])[0] || null) };
}

// The refusal every payment path returns, shaped like the other payment gates.
function legalHoldRefusal(hold) {
  return {
    ok: false, status: 403, error: 'account_with_counsel', hint: hold.message,
    legal_hold: { message: hold.message, counsel: hold.counsel, contact_complete: hold.contact_complete },
  };
}

// Server-rendered counsel block (the /pay/:token link page). Only fields on file.
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function counselHtml(lh) {
  const c = (lh && lh.counsel) || {};
  const lines = [];
  if (c.firm) lines.push(`<strong>${esc(c.firm)}</strong>`);
  if (c.attorney && c.attorney !== c.firm) lines.push(esc(c.attorney));
  if (c.phone) lines.push(`Phone: <a href="tel:${esc(c.phone.replace(/[^\d+]/g, ''))}">${esc(c.phone)}</a>`);
  if (c.email) lines.push(`Email: <a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`);
  if (!c.phone && !c.email) lines.push('Contact details for the firm are being updated. Please contact management if you need them.');
  return `<h1>Please contact the law firm</h1><p>${esc(lh.message)}</p><p>${lines.join('<br>')}</p>`;
}

module.exports = { holdFromState, legalHoldFor, legalHoldRefusal, counselHtml, LEGAL_HOLD_MESSAGE, HELD_STATES, STATE_COLUMNS };
