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
// THE ONE VERIFICATION METHOD (Ed 2026-11-27, decision 2): a one-time code sent
// by Twilio Verify to a phone number ALREADY ON FILE for the record (the owner
// of that property), read back by the caller (lib/verification). Only that
// service, after Twilio approves the code, calls createPhoneVerification(). That
// is the ONLY way the gate opens; without it every private tool refuses.
//
// Amanda's callers (Ed, staff, board) verify the same way against their own
// record; that mints an IDENTITY verification (createIdentityVerification),
// which lib/phone turns into the shared-lookups principal for that person.
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

// Verification methods that are allowed to open the gate. Adding one here is a
// security decision, with tests (tests/test_phone_private_records_gate.js).
const SMS_CODE_ON_FILE = 'sms_code_to_number_on_file';
const VERIFICATION_METHODS = Object.freeze([SMS_CODE_ON_FILE]);
const IDENTITY_KINDS = Object.freeze(['owner', 'staff', 'board']);

// The brand is NON-enumerable: a spread or JSON copy of a verification carries no brand.
function brand(o) { Object.defineProperty(o, VERIFIED, { value: true, enumerable: false }); return Object.freeze(o); }

function createPhoneVerification({ property_id, method } = {}) {
  if (!VERIFICATION_METHODS.includes(method)) {
    throw new Error('no_phone_verification_method_available');
  }
  if (!property_id) throw new Error('property_id_required');
  return brand({ property_id: String(property_id), method, verified_at: new Date().toISOString() });
}

/**
 * A verified PERSON on this call (Amanda's line): the owner, a staff member or a
 * board member, matched to their own record and proven by a code sent to the
 * number on that record. Same branding as the property verification.
 */
function createIdentityVerification({ kind, user_id = null, email = null, name = null, community_ids = null, method } = {}) {
  if (!VERIFICATION_METHODS.includes(method)) throw new Error('no_phone_verification_method_available');
  if (!IDENTITY_KINDS.includes(kind)) throw new Error('identity_kind_invalid');
  if (!user_id && !email) throw new Error('identity_required');
  return brand({ identity: Object.freeze({ kind, user_id: user_id ? String(user_id) : null, email: email ? String(email).toLowerCase() : null, name: name || null, community_ids: Array.isArray(community_ids) ? Object.freeze([...community_ids]) : null }), method, verified_at: new Date().toISOString() });
}

/** The verified person on this call, or null. Reads ctx.identity_verification only. */
function verifiedIdentity(ctx) {
  const v = ctx && ctx.identity_verification;
  if (!v || typeof v !== 'object' || v[VERIFIED] !== true || !v.identity) return null;
  return v.identity;
}

/**
 * The verified property for this call, or null (null until the code check passes).
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
      'Private account information cannot be shared on this call yet. Confirming a property address, ' +
      'or calling from a number on file, is NOT identity verification. The only way is a one-time code ' +
      'texted to the phone number on file for the owner of that home (verify_caller), where this call offers it. Do not state, hint at, or confirm any balance, payment, payment plan, ' +
      'collections, legal, attorney, bankruptcy, violation, ARC case, contact history, or owner ' +
      'name/contact detail. Do not say whether the address is on file.',
    what_you_can_do: [
      'Offer to text a one-time code to the phone number on file for the owner of that home (verify_caller), where this call offers it.',
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
  createIdentityVerification,
  verifiedIdentity,
  SMS_CODE_ON_FILE,
  IDENTITY_KINDS,
  verificationRequired,
  phonePromptView,
  VERIFICATION_METHODS,
};
