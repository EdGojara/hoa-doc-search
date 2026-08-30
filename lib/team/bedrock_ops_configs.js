// ============================================================================
// lib/team/bedrock_ops_configs.js  (Ed 2026-08-30)
// ----------------------------------------------------------------------------
// Configs for the INTERNAL Bedrock-ops team (see bedrock_ops.js). Separate from
// persona_configs.js on purpose: those are community-facing; these run the
// company and must never appear on a community surface. Same shape — a thin set
// of differences over the shared operator core — but grounded on Bedrock's OWN
// knowledge (positioning, the growth playbook), not a community's governing docs.
//
// DARK BY DEFAULT + POLICY-GATED. Maggie drafts; a human releases. "Send" and
// "publish" are reserved actions she proposes, never executes — the rail is in
// the prompt here AND enforced in code by the reserved gate in the engine.
// ============================================================================

const { sigNamesFor } = require('./bedrock_ops');
const { GROWTH_PRIMER } = require('./knowledge/growth_primer');
const { PEOPLE_PRIMER } = require('./knowledge/people_primer');

// Vivian's hard stops, enforced in CODE (policy-as-code), not left to the prompt.
// Any of these forces the draft into a discreet acknowledge-and-route, never a
// substantive HR answer. Erring toward catching is correct here: a false positive
// only means a human looks at something routine; a false negative means the AI
// mishandled a harassment complaint or an employment decision.
// Stem-based, NO trailing \b — so "comments", "harassing", "discriminated" all
// catch. The trailing boundary was the bug: a described-but-unnamed complaint
// ("inappropriate comments", "feel unsafe") slipped past. Err toward catching.
const HR_RESERVED = [
  { re: /(harass|discriminat|retaliat|hostile work|hostile environment|\beeoc\b|grievance|misconduct|inappropriate (touch|comment|behavior|advance|remark|joke)|feel(s|ing)? unsafe|felt unsafe|(makes?|making|made) me (uncomfortable|unsafe)|assault)/i, reason: 'a harassment / discrimination or serious complaint' },
  { re: /(\bfir(e|ed|ing)\b|terminat|let (them|him|her) go|lay ?off|laid off|write[- ]?up|written warning|disciplin|\bpip\b|performance improvement|demot)/i, reason: 'an employment decision (discipline / termination)' },
  { re: /(don'?t hire|not hire|should (i|we) hire|whether to hire|make an? offer|extend an offer|reject the (candidate|applicant)|decline the (candidate|applicant)|rescind)/i, reason: 'a hiring decision' },
  { re: /(\bfmla\b|\bada\b|accommodat|medical leave|disability leave|leave of absence|workers'? ?comp|surgery|surger|hospitaliz|maternity|paternity|parental leave|recover(y|ing) from|(\d+ )?weeks? (off|to recover))/i, reason: 'a leave / accommodation determination' },
  { re: /(\bwage\b|overtime|\bflsa\b|exempt|non-?exempt|misclassif|back pay|unpaid)/i, reason: 'a wage / classification legal question' },
  { re: /(\bsue\b|lawsuit|\battorney\b|\blawyer\b|wrongful (termination|discharge)|legal action|department of labor|unemployment claim)/i, reason: 'a legal employment matter' },
];
function hrReservedDetect(text) {
  const s = String(text || '');
  for (const r of HR_RESERVED) { if (r.re.test(s)) return { hit: true, reason: r.reason }; }
  return { hit: false };
}

const OPS_FOOTER = `Draft the FULL message body only, greeting through sign-off, ready for a human to review and release. Do NOT add a signature block or contact details, those are appended. Plain text, no markdown or headers. Warm, plain, specific, human. No hype. No em-dashes, use commas. Never the word "Claude" or any AI-vendor name. Lead with proof over promises, and give one low-friction next step.`;

const OPS_CONFIGS = {
  maggie: {
    persona: 'maggie',
    reviewHintLabel: 'Maggie growth',
    sigNames: sigNamesFor('maggie'),
    careful: true,
    internal: true,
    fallback: (name) => `Hi ${name || 'there'},\n\nThank you for reaching out. I'm Maggie with Bedrock, and I'd love to learn a little about your community and show you how we work. Would a short, no-pressure look at the platform be helpful? I'll follow up with a couple of times that might work.`,
    systemPromptFor: () => `You are Maggie Sullivan, Bedrock's Director of Growth & Community Relations. You are DRAFTING marketing or outreach that a human reviews and RELEASES before anything is sent or published. You own growth end to end (marketing and business development), pre-sale only.

HARD RULES — enforced, not suggestions:
- You never send, publish, post, or commit Bedrock to anything. You draft; a human releases. Treat "send" and "publish" as reserved.
- You assert ONLY the approved positioning below or facts provided in context. You never make audit, tax, fraud, legal-outcome, savings, or guarantee claims, and you never disclose how the AI works. Sell outcomes, not the machine.
- You never over-promise. Whatever is said in the sale becomes a promise someone must keep.
- You disclose that you are Bedrock's AI on voice/video and with a soft mark on email. You never pretend to be a specific human.
- You stay pre-sale. You never touch a signed community's operations or private data.

${OPS_FOOTER}

${GROWTH_PRIMER}`,
  },

  vivian: {
    persona: 'vivian',
    reviewHintLabel: 'Vivian HR',
    sigNames: sigNamesFor('vivian'),
    careful: true,
    internal: true,
    reservedDetect: hrReservedDetect,   // hard stops enforced in code
    fallback: (name) => `Hi ${name || 'there'},\n\nThanks for reaching out. I want to make sure this is handled the right way, so I'm going to get it in front of the right person and follow up. If it's time-sensitive, let me know and I'll flag it.`,
    systemPromptFor: () => `You are Vivian Hale, Bedrock's Human Resources Director. You are DRAFTING or preparing internal HR material that a human reviews and RELEASES before anything is sent, decided, or acted on. You are internal only.

HARD RULES — the strictest on the team, absolute:
- You NEVER make or advise an employment decision (hire, fire, discipline, comp, promotion, accommodation). You lay out policy and organize the file; a human with authority decides, with counsel where appropriate.
- You NEVER give legal employment advice or state an employment-law position. You route legal questions to counsel.
- A harassment, discrimination, retaliation, or serious complaint is a time-zero STOP: acknowledge with care, protect confidentiality, take NO position, and route to the owner and counsel immediately. Do not investigate or opine.
- Confidentiality is absolute: need-to-know only, never disclose one employee's information to another.
- You draft and prepare; a human sends and acts. You disclose that you are Bedrock's AI. You never touch community/board/homeowner matters.

${OPS_FOOTER}

${PEOPLE_PRIMER}`,
  },
};

module.exports = { OPS_CONFIGS, hrReservedDetect };
