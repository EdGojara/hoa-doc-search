// ============================================================================
// violation_letter_rules.js — Statutory wording + business-rule constants
// ----------------------------------------------------------------------------
// Single source of truth for the Texas Property Code §209 language that
// appears in violation letters. The renderer (violation_letter.js) is the
// only place this text touches; everything else references these constants.
//
// Why pull these out of the renderer:
//   - Texas §209 wording is legally-anchored. If an attorney reviews and
//     edits one phrase, it must propagate everywhere. One file = one edit.
//   - The "engineer-in-the-room" rule (CLAUDE.md): statutory text never
//     gets paraphrased by Claude at generation time. It comes from here.
//   - Catastrophic-output discipline: this is a court-litigated artifact,
//     not internal copy. Wording integrity is the whole point.
//
// To update any text below: have it reviewed by an HOA attorney first.
// Then update the constant. The renderer reads from here at render time
// so changes take effect on the next letter mailed.
//
// All wording reflects Texas Property Code as of 2024. Verify before any
// production change. Last attorney review: NOT YET (pre-production).
// ============================================================================

'use strict';

// ----------------------------------------------------------------------------
// Default cure periods by stage. Per-community overrides on
// `communities.letter_cure_days_*`. Statute floor for §209 certified is 30 days.
// ----------------------------------------------------------------------------
const CURE_DAYS_DEFAULT = {
  courtesy_1:    20,
  courtesy_2:    20,
  certified_209: 30,   // floor per Texas Property Code §209.006(d)
  fine_assessed: 30,   // same as certified_209
};

// Hearing-request window from notice mailing (statute-fixed at 30 days).
const HEARING_REQUEST_DAYS = 30;

// Default admin fee (cents) by stage if community hasn't set an override.
const FEE_CENTS_DEFAULT = {
  courtesy_1:    0,
  courtesy_2:    0,
  certified_209: 3500,   // $35.00
  fine_assessed: 3500,
};

// ----------------------------------------------------------------------------
// Vocabulary translation — homeowner-facing tone discipline.
// See memory note feedback_compliance_facing_tone.md.
//
// The legacy industry uses adversarial language ("violation," "cure," "due
// process"). Bedrock's surfaces use compliance-framing because the goal is
// resolution, not punishment. The empty-chair lens runs through every line.
//
// Note: SOME terms MUST stay legal-precise on certified §209 letters because
// they're statutory ("Notice of Covenant Violation" — that's the literal
// §209 phrase, can't soften it to "Notice of Compliance Concern" on
// certified mail because then we're not satisfying the statute). The maps
// below distinguish "tone OK to soften" (courtesy stages) from "must stay
// statutory" (certified stages).
// ----------------------------------------------------------------------------
const TONE_SOFTENED = {
  // courtesy_1 + courtesy_2 — homeowner-facing, friendly first contact
  title_courtesy_1: 'Courtesy Notice',
  title_courtesy_2: 'Second Notice — Covenant Violation',
  cure_label_courtesy: 'Time to address',
  intro_courtesy_1: (hoaName) =>
    `We're reaching out as a friendly first reminder. ${hoaName} appreciates your help keeping the community welcoming and well-maintained, and we want to flag the following so it can be addressed before it escalates.`,
  intro_courtesy_2: (hoaName) =>
    `${hoaName} previously reached out about the matter below and would like to follow up. Resolving this now keeps your account from progressing to a formal notice with associated fees.`,
};

const TONE_STATUTORY = {
  // certified_209 + fine_assessed — must match §209 framework precisely
  title_certified_209: 'FORMAL NOTICE OF COVENANT VIOLATION',
  title_fine_assessed: 'NOTICE OF FINE ASSESSMENT',
  cure_label_statutory: 'Cure deadline',
};

// ----------------------------------------------------------------------------
// Texas Property Code §209 statutory language blocks.
// These appear verbatim on certified §209 letters. Do NOT paraphrase.
// ----------------------------------------------------------------------------

const STATUTORY_209 = {
  // §209.006 — notice and cure framework
  // Required language stating the letter satisfies the statute's written
  // notice + opportunity-to-cure requirements.
  notice_satisfies_209_006: () =>
    'This formal notice satisfies the written-notice and opportunity-to-cure requirements of Texas Property Code §209.006.',

  // §209.006(e) — cure-before-deadline kills the fine.
  // Critical: this protects the Association from over-collection AND
  // protects the owner from getting fined after they've remedied the issue.
  cure_kills_fine: () =>
    'If the violation is cured to the Association\'s reasonable satisfaction before the cure deadline above, any fine assessed for this violation may be waived. Document your cure (photos, receipts) and contact the Association to confirm.',

  // §209.0064 — fines reasonable, schedule-anchored
  fines_schedule_anchored: () =>
    'Fines are assessed in accordance with the Board-approved fine schedule and Texas Property Code §209.0064.',

  // §209.006(b)(1) — fee disclosure when fine assessed
  fee_disclosure_fine_assessed: (feeDollars) =>
    `An administrative fee of $${feeDollars} has been assessed to your account in connection with this notice, as authorized by Texas Property Code §209.006(b)(1) and the Association's governing documents.`,

  // §209.007 — hearing request rights
  // The owner has the right to a hearing if they request one in writing
  // within 30 days of notice mailing.
  hearing_request_rights: (hearingByDate, hearingAddress) =>
    `You have the right to request a hearing before the Board of Directors or a designated committee. To request a hearing, submit a written request to the Association at the address below on or before ${hearingByDate}. The hearing must be held not later than the 30th day after the Board receives your request, unless mutually agreed to a later date. ${hearingAddress ? `Direct your request to: ${hearingAddress}.` : ''}`,

  // §209.006(d) — postmark anchors the cure clock on certified mail
  // Belt-and-suspenders language to close the legal-challenge surface when
  // print date and postmark date differ by 1-2 days.
  postmark_anchor: () =>
    'For the avoidance of any timing dispute, the cure period and hearing-request window run from the postmark date of this certified mailing as shown on the certified mail receipt. If the postmark date differs from the date printed on this letter, the later date controls.',

  // Servicemembers Civil Relief Act disclosure on certified §209 letters.
  // Required by federal law for any escalated collections/enforcement
  // action when the respondent's military status is unknown.
  scra_disclosure: () =>
    'If you or a member of your household is on active military duty, you may have certain rights under the federal Servicemembers Civil Relief Act (SCRA) including a stay of proceedings and limits on enforcement action. If SCRA may apply, contact the Association in writing immediately.',
};

// ----------------------------------------------------------------------------
// Compliance-tone preamble for courtesy stages. Sets the tone of the
// letter overall — we lead with "we want resolution" not "you're in trouble."
// ----------------------------------------------------------------------------
const COURTESY_PREAMBLE = {
  resolution_first: () =>
    'Our goal is resolution, not enforcement. Most concerns are resolved with a single courtesy notice. If you have questions, need a few extra days due to scheduling or weather, or believe this notice was sent in error, please reply to this notice. The Association is reasonable.',
};

// ----------------------------------------------------------------------------
// Bedrock managing-agent disclosure footer (every letter).
// The Association is the principal — Bedrock is the managing agent. This
// posture must show on every letter. Pre-judgment-day defense.
// ----------------------------------------------------------------------------
const MANAGING_AGENT_FOOTER = (hoaName) =>
  `This community is professionally managed by Bedrock Association Management, LLC on behalf of ${hoaName}. Bedrock acts as the managing agent. All enforcement decisions, fine assessments, and hearing-related matters are made by ${hoaName}'s Board of Directors.`;

// ----------------------------------------------------------------------------
// Photo + documentation discipline.
// Photos appear on every letter (courtesy and certified). Empty-chair lens:
// they're shown TO the homeowner so they can verify what was documented and
// resolve it, NOT used adversarially. The wide-shot establishes property
// identity (wrong-house defense); close-up documents the specific finding.
// ----------------------------------------------------------------------------
const PHOTO_DISCIPLINE = {
  caption_wide: () => 'Wide-shot photograph documenting property identity.',
  caption_closeup: (violationType) =>
    `Documentation of: ${violationType}. Photo taken on the inspection date noted above.`,
  wrong_house_required: true,  // 5-signal verification required before any letter ships
};

module.exports = {
  CURE_DAYS_DEFAULT,
  HEARING_REQUEST_DAYS,
  FEE_CENTS_DEFAULT,
  TONE_SOFTENED,
  TONE_STATUTORY,
  STATUTORY_209,
  COURTESY_PREAMBLE,
  MANAGING_AGENT_FOOTER,
  PHOTO_DISCIPLINE,
};
