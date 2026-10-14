// ============================================================================
// lib/vigilance/permissions.js — what each teammate may do on her own when she
// finds something (Ed 2026-10-14)
// ----------------------------------------------------------------------------
// `may`: actions the owner takes without asking (investigate, open and drive the
// case, prepare correspondence, recommend a hold). `human`: actions that ALWAYS
// need a person: sending anything outside, acting in a bank portal, moving money,
// changing bank or vendor banking details. An action outside `may` is never
// performed; it becomes an escalation. One table for every agent.
// ============================================================================
const HUMAN = ['send_correspondence', 'bank_portal_action', 'move_money', 'change_bank_settings', 'change_vendor_banking'];
const POLICY = {
  kat: { may: ['open_case', 'investigate', 'prepare_bank_inquiry', 'prepare_correspondence', 'hold_for_review', 'hold_vendor_banking_change', 'flag_do_not_act', 'follow_up'] },
  emma: { may: ['open_case', 'investigate', 'prepare_correspondence', 'hold_for_review', 'hold_vendor_banking_change', 'flag_do_not_act', 'follow_up'] },
  amanda: { may: ['open_case', 'investigate', 'prepare_correspondence', 'flag_do_not_act', 'follow_up'] },
};
const DEFAULT = { may: ['open_case', 'investigate', 'follow_up'] };
const policyFor = (persona) => POLICY[persona] || DEFAULT;
const can = (persona, action) => !HUMAN.includes(action) && policyFor(persona).may.includes(action);
module.exports = { can, policyFor, HUMAN, POLICY };
