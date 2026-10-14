// ============================================================================
// lib/vigilance/permissions.js — what each teammate may do on her own, and which
// communications need a person (Ed 2026-10-14)
// ----------------------------------------------------------------------------
// ACTIONS. `may`: what the owner does without asking (investigate, open and drive
// a case, prepare correspondence, recommend a hold). An action outside `may` is
// never performed; it becomes an escalation. Some actions need a person ALWAYS,
// whoever asks: acting in a bank portal, moving money, changing bank or vendor
// banking details.
//
// SENDING IS RISK-BASED, NOT UNIVERSAL. Routine, authorized communication goes out
// under the sender's own autonomy policy (Amanda: lib/amanda/reply_policy, the
// EXECUTE gate); nothing here adds an approval step to it. A RESTRICTED topic
// (banking, payment changes, legal, enforcement, security) always waits for a
// person's approval, whatever the sender's policy says. Vigilance correspondence
// is about an anomaly, so it is tagged with its topic and follows that rule.
// ============================================================================
const ALWAYS_HUMAN = ['bank_portal_action', 'move_money', 'change_bank_settings', 'change_vendor_banking'];
const RESTRICTED_TOPICS = ['banking', 'payment_change', 'legal', 'enforcement', 'security'];
const POLICY = {
  kat: { may: ['open_case', 'investigate', 'prepare_bank_inquiry', 'prepare_correspondence', 'hold_for_review', 'hold_vendor_banking_change', 'flag_do_not_act', 'follow_up'] },
  emma: { may: ['open_case', 'investigate', 'prepare_correspondence', 'hold_for_review', 'hold_vendor_banking_change', 'flag_do_not_act', 'follow_up'] },
  amanda: { may: ['open_case', 'investigate', 'prepare_correspondence', 'flag_do_not_act', 'follow_up'] },
};
const DEFAULT = { may: ['open_case', 'investigate', 'follow_up'] };
const policyFor = (persona) => POLICY[persona] || DEFAULT;
const can = (persona, action) => !ALWAYS_HUMAN.includes(action) && policyFor(persona).may.includes(action);

/**
 * Who decides whether a message goes out.
 * @returns {{ decision: 'approval_required' | 'sender_policy', reason }}
 *   approval_required: a person approves it, whatever the sender's own policy says;
 *   sender_policy:     routine; the sender's autonomy policy decides (e.g. Amanda's EXECUTE gate).
 */
function sendDecision({ topic = 'routine' } = {}) {
  if (RESTRICTED_TOPICS.includes(topic)) return { decision: 'approval_required', reason: `${topic} communication always needs a person's approval` };
  return { decision: 'sender_policy', reason: 'routine communication: the sender\'s own autonomy policy decides' };
}

// The topic of a vigilance case's correspondence, from what was detected and with whom.
function topicFor(detector, counterpartyType) {
  if (detector === 'payment_instructions') return 'payment_change';
  if (counterpartyType === 'bank') return 'banking';
  if (['recipient_change', 'sender_lookalike'].includes(detector)) return 'security';
  return 'routine';
}

module.exports = { can, policyFor, sendDecision, topicFor, ALWAYS_HUMAN, RESTRICTED_TOPICS, POLICY };
