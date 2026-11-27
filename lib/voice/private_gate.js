// ============================================================================
// lib/voice/private_gate.js — the homeowner security boundary for the PHONE
// ----------------------------------------------------------------------------
// Owner rule (Ed 2026-11-27): a caller saying a property address is NOT
// authentication. Caller ID is not authentication either (it can be spoofed).
// Public information and general homeowner help stay open to anyone; private
// records require real verification first.
//
// PRIVATE (never disclosed on an unverified phone call):
//   account balance / AR / as-of dates, transactions, payment plans and terms,
//   collections / legal / attorney / bankruptcy status, enforcement or
//   violation status or stage, ACC/ARC case details, contact and
//   correspondence history, prior call summaries, owner names and contact
//   details (email, phone, mailing address).
//
// TODAY THERE IS NO PHONE VERIFICATION STEP (no OTP, no PIN). So the gate is
// FAIL-CLOSED: phoneVerifiedPropertyId() returns null on every phone call and
// every private tool refuses. When a real verification step is built (for
// example a one-time code texted to the phone on file), it adds its method to
// VERIFICATION_METHODS and calls createPhoneVerification() for that call. That
// is the ONLY way the gate opens.
//
// Why a branded object instead of a plain `verified_property_id` field: call
// context on the phone is assembled from things an outsider controls (Twilio
// stream parameters, Vapi metadata, model tool arguments, JSON). None of those
// can carry a module-private Symbol, so nothing decoded from a request or
// written by the model can forge verification. Only code in this process
// that calls createPhoneVerification() can.
//
// The portal is a different channel (HMAC-signed login) and keeps its own
// `caller.verified` flag; see api/claire.js. This module never reads it, and
// the phone path strips it (phonePromptView) so caller ID can never set it.
// ============================================================================

const VERIFIED = Symbol('bedrock.phone_verification');

// Verification methods that are allowed to open the gate. EMPTY on purpose:
// none exists yet. Adding one here is a security decision, with tests.
const VERIFICATION_METHODS = Object.freeze([]);

function createPhoneVerification({ property_id, method } = {}) {
  if (!VERIFICATION_METHODS.includes(method)) {
    throw new Error('no_phone_verification_method_available');
  }
  if (!property_id) throw new Error('property_id_required');
  return Object.freeze({ [VERIFIED]: true, property_id: String(property_id), method, verified_at: new Date().toISOString() });
}

/**
 * The verified property for this call, or null. Today: always null.
 * @param {object} ctx — tool/stream context; reads ctx.phone_verification only.
 */
function phoneVerifiedPropertyId(ctx) {
  const v = ctx && ctx.phone_verification;
  if (!v || typeof v !== 'object' || v[VERIFIED] !== true) return null;
  return typeof v.property_id === 'string' && v.property_id ? v.property_id : null;
}

// Safe structured refusal a private tool returns when the gate is closed. It
// tells the assistant what it CAN do instead, and deliberately says nothing
// about whether the address exists or what is on the account.
function verificationRequired(topic, reason = 'not_verified') {
  return {
    ok: false,
    error: 'verification_required',
    verified: false,
    topic,
    reason,
    detail:
      'Private account information cannot be shared on this call. Confirming a property address, ' +
      'or calling from a number on file, is NOT identity verification, and there is no phone ' +
      'verification step yet. Do not state, hint at, or confirm any balance, payment, payment plan, ' +
      'collections, legal, attorney, bankruptcy, violation, ARC case, contact history, or owner ' +
      'name/contact detail. Do not say whether the address is on file.',
    what_you_can_do: [
      'Answer general and public community questions (rules, amenity hours, assessment AMOUNTS, forms, how processes work).',
      'Point them to the secure homeowner portal, where they sign in and can see their own account.',
      'Offer a callback from the team, who will verify identity before discussing the account.',
    ],
    claire_can_say:
      "I can't pull up account details over the phone, but you can see all of that by signing in to your homeowner portal, or I can have someone from the team call you back. Which works better?",
  };
}

/**
 * What the phone system prompt is allowed to know about the caller. Unless the
 * gate is open, the caller-ID match and the pre-call warmup are dropped
 * entirely (no name, no address, no residency, no balance, no flags), and any
 * `verified` flag on the caller object is ignored. Pure function.
 */
function phonePromptView({ caller, warmup, phone_verification } = {}) {
  const pid = phoneVerifiedPropertyId({ phone_verification });
  if (!pid || !caller) return { caller: null, warmup: null };
  return {
    caller: { ...caller, property_id: pid, verified: true, verified_channel: 'phone' },
    warmup: warmup || null,
  };
}

module.exports = {
  phoneVerifiedPropertyId,
  createPhoneVerification,
  verificationRequired,
  phonePromptView,
  VERIFICATION_METHODS,
};
