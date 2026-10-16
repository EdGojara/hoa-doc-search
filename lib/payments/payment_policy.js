// ============================================================================
// lib/payments/payment_policy.js  (Ed 2026-10-16)
// ----------------------------------------------------------------------------
// Who bears Stripe costs on a homeowner assessment payment. These are the
// defaults the code runs on TODAY, written down so nobody has to infer them from
// how a destination charge happens to work. They are NOT a policy decision.
//
// TODO(Ed): decide both, then change the value here and say so in the
// management agreement / fee schedule.
//
// ach_fee_bearer 'platform'
//   Assessment checkouts are destination charges created on Bedrock's platform
//   account. Stripe bills its processing fee to the platform, and the
//   association receives the full assessment (ACH carries no convenience fee;
//   card carries one that grosses the fee up). Alternative: 'association'
//   (an application fee or a monthly bill-back).
//
// dispute_bearer 'platform'
//   On a destination charge Stripe debits a dispute (amount plus its dispute
//   fee) from the PLATFORM balance, not the association's, even with
//   on_behalf_of. Unless the transfer to the association is reversed, Bedrock
//   eats it. A lost dispute is therefore flagged for staff with the exact
//   transfer reversal (communities.stripe_dispute_auto_reversal OFF), or
//   reversed automatically for a community where it is ON. Alternative:
//   'association' (turn auto reversal on everywhere).
//
// Accounting consequence while dispute_bearer stays 'platform': the chargeback
// entry already moved the homeowner back to owing (Dr AR / Cr Stripe clearing),
// but the association's Stripe balance still holds the money, so its next payout
// leaves Stripe clearing short by the disputed amount until staff either reverse
// the transfer or record Bedrock's reimbursement. The review flag says this.
// ============================================================================

const PAYMENT_POLICY = Object.freeze({
  ach_fee_bearer: 'platform',
  dispute_bearer: 'platform',
});

module.exports = { PAYMENT_POLICY };
