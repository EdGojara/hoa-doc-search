// evals/cases/board-packet-completeness/case.js
// ---------------------------------------------------------------------------
// Case #5: board packet — large-context synthesis and COMPLETENESS. Different
// axis again: not one hard number or one rule, but "did it surface everything the
// board must act on, and not BURY a critical item in a tidy summary?"
//
// The source data mixes routine items with time-sensitive ones. The buried
// critical item is a property/GL insurance policy expiring in 20 days, not yet
// bound — a board that isn't told risks a coverage lapse. Omitting it is a
// catastrophic completeness failure even if the rest of the report is polished.
// ---------------------------------------------------------------------------

const SYSTEM = [
  'You prepare the Manager\'s Report action-items section of an HOA board packet.',
  'Surface everything the board must act on or be aware of. Flag every time-sensitive item with its date and make critical items impossible to miss. A polished summary that omits a critical or time-sensitive item is a failure — completeness matters more than brevity here.',
].join(' ');

const PROMPT = `Source data for this month's board packet (community: operating account and status):

- Operating cash: $148,200. Reserve fund: $512,000.
- Assessments: 92% collected YTD. Delinquency: $38,400 across 14 accounts; 2 accounts are with the attorney.
- Deed-restriction violations: 27 open (down from 34 last month).
- Property + General Liability insurance policy: EXPIRES 2026-10-09 (about 20 days out). A renewal quote has been received but the policy is NOT yet bound.
- Annual membership meeting: must be held by 2026-11-15 per the bylaws; owner notice must be mailed no later than 2026-10-29.
- ACC: 3 applications in review; 1 escalated (a fence variance request needing board input).
- Landscaping contract with GreenScape: auto-renews on 2026-10-18 for another year unless written non-renewal notice is given 30 days prior.
- Reserve study: last updated 2024; an update is recommended in the next budget cycle.
- Pool: closed for the season 2026-09-30.

Write the Manager's Report action-items section for the board. Surface everything requiring board awareness or action, flag time-sensitive items with dates, and do not bury critical items.`;

const RUBRIC = [
  { id: 'insurance_expiry', type: 'regex', pattern: '(insurance|policy|coverage|GL)[\\s\\S]{0,120}(expir|renew|not (yet )?bound|10/09|oct(ober)?\\s?9|20 days|lapse)|(expir|renew|bound)[\\s\\S]{0,60}(insurance|policy|coverage)', weight: 3, sev: 'catastrophic', desc: 'Surfaces the insurance policy expiring in ~20 days (the buried critical item)' },
  { id: 'annual_meeting', type: 'regex', pattern: '(annual (membership )?meeting|owner notice|notice.{0,20}mail)[\\s\\S]{0,120}(11/15|nov(ember)?|10/29|oct(ober)?\\s?29|deadline|by )', weight: 2, sev: 'compliance', desc: 'Surfaces the annual-meeting + notice-mailing deadlines' },
  { id: 'vendor_autorenew', type: 'regex', pattern: '(greenscape|landscap|contract)[\\s\\S]{0,120}(auto-?renew|non-?renew|10/18|oct(ober)?\\s?18|30 days|notice)', weight: 2, sev: 'financial', desc: 'Surfaces the landscaping contract auto-renewal decision window (buried)' },
  { id: 'delinquency', type: 'number', value: 38400, tolerance: 50, weight: 1, sev: 'financial', desc: 'Reports the $38,400 delinquency' },
  { id: 'acc_escalated', type: 'regex', pattern: '(acc|variance|architectural)[\\s\\S]{0,80}(escalat|board input|fence|decision|review)', weight: 1, sev: 'operational', desc: 'Flags the escalated ACC/fence variance needing board input' },
  { id: 'time_sensitive_flagged', type: 'regex', pattern: '(time-?sensitive|action required|urgent|deadline|by (2026|oct|nov)|due )', weight: 1, sev: 'operational', desc: 'Flags time-sensitive items with dates' },
];

module.exports = {
  id: 'board-packet-completeness',
  title: 'Board packet: Manager\'s Report completeness (large-context synthesis)',
  system: SYSTEM,
  prompt: PROMPT,
  maxTokens: 2400,
  rubric: RUBRIC,
  meta: { buried_critical: 'insurance policy expiring 2026-10-09, not bound', time_sensitive: ['insurance', 'annual_meeting_notice', 'vendor_autorenewal'] },
};
