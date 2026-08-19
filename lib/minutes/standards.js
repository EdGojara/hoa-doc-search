// ============================================================================
// lib/minutes/standards.js  (Ed 2026-08-19)
// ----------------------------------------------------------------------------
// The house rules for board meeting minutes, in ONE place.
//
// Two things consume these and they must never drift apart:
//   - api/minutes.js          drafts minutes and must FOLLOW them
//   - lib/community/amanda_review.js  reviews a manager's draft and must CHECK
//     the same list
//
// If the reviewer and the drafter carry separate copies, Amanda eventually
// corrects Martha for breaking a rule the platform itself no longer applies,
// which is worse than not reviewing at all.
//
// Every rule here came out of a real August 2026 LOPF draft. They are not
// style preferences.
// ============================================================================

const MINUTES_RULES = [
  {
    id: 'no_gl_codes',
    rule: 'Never put a GL account number, account code, or chart-of-accounts reference in minutes.',
    why: 'Minutes record what the board DECIDED, not how it is booked. The journal entry cites the minutes, never the reverse. A wrong code becomes a permanent record that care cannot prevent, and every old minute goes stale the moment the chart changes. The August 2026 LOPF draft cited 1810 and 2810, which are the two halves of an interfund payable rather than the cash accounts (1100 savings, 1000 operating), and it read perfectly plausibly.',
    say: 'Say "transfer $50,000 from the savings account to the operating account."',
  },
  {
    id: 'transfer_purpose',
    rule: 'Any transfer of funds states the amount, the from and to in plain words, and the PURPOSE.',
    why: 'A year later nobody remembers why, and money leaving savings is the first thing an auditor asks about.',
  },
  {
    id: 'motion_attribution',
    rule: 'Record the maker and the seconder of any motion involving money.',
    why: 'An approval with no maker is hard to defend later, and the larger the number the more it matters.',
  },
  {
    id: 'no_adjudication',
    rule: 'Never resolve a disputed question of fact. Record that the topic was DISCUSSED, never which side is right.',
    why: 'Minutes are quotable against the association. The LOPF draft stated "LOPF HOA owns fountains not retention ponds" while ownership was actively in dispute with the MUD.',
    say: 'Say "ownership and maintenance responsibility for the fountains and retention ponds was discussed."',
  },
  {
    id: 'officer_calls_to_order',
    rule: 'Only a board officer calls a meeting to order. A manager or managing agent never does.',
    why: 'It is the presiding officer\'s act. Recording it as the manager\'s puts an association action in the hands of its vendor.',
  },
  {
    id: 'no_incidental_personal_detail',
    rule: 'Leave out incidental personal detail about staff or attendees.',
    why: 'It is permanent and it serves nobody. The LOPF draft noted the manager was "stuck in traffic and late."',
  },
  {
    id: 'executive_session_minimal',
    rule: 'Executive session minutes stay minimal: the headings with "none" where nothing occurred, never the substance of the discussion.',
    why: 'This is the one most managers get wrong in the other direction. Keeping the heading with "none" is correct practice and shows the matter was considered.',
  },
  {
    id: 'header_consistency',
    rule: 'Section headers must match the body. Check that dates and times in a header are not copy-pasted from another section.',
    why: 'The LOPF executive session header read 6:20 PM while the session was called to order at 7:45 PM.',
  },
];

/** The rules as prompt text for the DRAFTER. */
function draftingGuidance() {
  return [
    'WHAT MINUTES ARE, AND ARE NOT (house rules — every one came from a real draft):',
    ...MINUTES_RULES.map((r) => `- ${r.rule}${r.say ? ' ' + r.say : ''} (${r.why})`),
  ].join('\n');
}

/** The rules as prompt text for the REVIEWER. */
function reviewGuidance() {
  return [
    'Check the draft against these house rules. Cite the rule id when you flag something.',
    ...MINUTES_RULES.map((r) => `[${r.id}] ${r.rule} WHY: ${r.why}${r.say ? ' PREFERRED: ' + r.say : ''}`),
  ].join('\n');
}

module.exports = { MINUTES_RULES, draftingGuidance, reviewGuidance };
