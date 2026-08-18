// ============================================================================
// lib/claire/guardrails.js  (Ed 2026-08-16)
// ----------------------------------------------------------------------------
// WHAT CLAIRE MAY NOT DO — enforced in code, not asked for in a prompt.
//
// The existing rule (CLAUDE.md, templates/responder-engine.spec.md §8) is that
// voice surfaces never touch compliance outputs: Claire cannot grant a waiver,
// decide a violation, or assert a legal position. On the phone that rule lived
// only in the system prompt. On VIDEO it cannot, for one reason:
//
//   A photoreal face is read as authority. A homeowner who hears "sure, I'll
//   take care of that fine" from a person-shaped thing on screen believes the
//   association said it. A model that complies 99% of the time is a 1% chance
//   of the association being held to a waiver it never granted.
//
// So the gate runs BEFORE the model does, server-side, on every turn. A prompt
// instruction is a request; this is a control. (The meta-scar in CLAUDE.md: the
// second time a rule is violated, it stops being prose and becomes a check.)
//
// The design constraint that matters as much as the blocking: a control that
// stonewalls gets routed around. Claire still ANSWERS. She explains what the
// notice means, what the rule says, and exactly what happens next. What she
// won't do is make the decision. Every refusal carries a real next step and an
// offer of a human, never a dead end.
// ============================================================================

// Requests for a BINDING DECISION Claire has no authority to make. These target
// the ask ("can you waive it"), not the topic ("what is this fine for") — the
// explanatory question is the whole point of the surface and must get through.
const RULES = [
  {
    reason: 'waiver_or_dismissal',
    // "can you waive / drop / remove / reverse / forgive / cancel my fine"
    pattern: /\b(?:can|could|will|would|w(?:ill|ould)n'?t)\s+(?:you|claire|the\s+(?:hoa|association|board))\b[^.?!]{0,60}\b(?:waive|waiv(?:ing|er)|drop|dismiss|remove|reverse|forgive|cancel|void|write\s+off|clear)\b|\b(?:please\s+)?(?:waive|dismiss|reverse|forgive|write\s+off)\s+(?:my|the|this|his|her|their)\b/i,
    reply: 'I can explain exactly why this was assessed and what the rule says, but I am not able to waive or reverse a charge, that decision belongs to the association. What I can do is put the request in front of the team today with everything you have told me, so nobody has to start from scratch. Want me to do that?',
  },
  {
    reason: 'acc_decision',
    // asking Claire to approve/deny an architectural request
    pattern: /\b(?:can|could|will|would)\s+(?:you|claire)\b[^.?!]{0,60}\b(?:approve|deny|reject|sign\s+off|green\s*light|okay|ok)\b|\b(?:please\s+)?approve\s+(?:my|this|the)\s+(?:request|application|submittal|plan|fence|shed|paint|roof|pool|addition)\b/i,
    reply: 'I can walk you through the guidelines your request is judged against and tell you where it stands right now, but approvals are the committee\'s call, not mine. If it helps, I can check what is still missing from your submittal so it does not stall on paperwork. Want me to look?',
  },
  {
    reason: 'legal_position',
    // asking Claire to say whether something is legal / enforceable / actionable
    pattern: /\b(?:is|are|was|were|isn'?t|aren'?t)\s+(?:this|that|it|they|the\s+\w+|these)\b[^.?!]{0,40}\b(?:legal|illegal|lawful|unlawful|enforceable|valid\s+under\s+(?:law|the\s+law)|a\s+violation\s+of\s+(?:state|texas)\s+law)\b|\b(?:can|could|should)\s+(?:i|we|the\s+board)\b[^.?!]{0,40}\b(?:sue|be\s+sued|take\s+(?:them|him|her|us)\s+to\s+court|counter\s*sue|file\s+suit)\b|\bwhat\s+are\s+my\s+legal\s+rights\b|\b(?:legal|attorney)\s+advice\b/i,
    reply: 'That one crosses into legal territory, and I am not the right source for it, the association uses counsel for exactly this. I can tell you what the governing documents actually say and pull the section for you, and I can get the question to the team so it reaches the right person. Which would you like first?',
  },
  {
    reason: 'money_movement',
    // asking Claire to take a payment or move a balance
    pattern: /\b(?:can|could|will|would)\s+(?:you|claire)\b[^.?!]{0,60}\b(?:charge|bill|refund|credit|debit|adjust|zero\s+out|take\s+(?:my|a)\s+(?:payment|card))\b|\b(?:here\s+is|take|use|run)\s+my\s+(?:card|credit\s+card|account\s+number|routing)\b|\b(?:please\s+)?(?:refund|credit)\s+(?:my|the)\s+(?:account|balance|payment)\b/i,
    reply: 'I am not able to take a payment or change a balance in this conversation, and I would not want your card details read out here either. Payments go through your portal where they post to your account straight away, and I can send you the direct link right now. Want it by email or text?',
  },
  {
    reason: 'enforcement_action',
    // Asking Claire to start or escalate enforcement against someone. Note the
    // bare-imperative branches: neighbor complaints arrive as commands ("send
    // them a letter"), not as polite questions aimed at Claire, so a pattern
    // that only matches "can you ..." misses the common phrasing entirely.
    pattern: new RegExp([
      /\b(?:can|could|will|would|please)\s+(?:you|claire)\b[^.?!]{0,60}\b(?:fine|cite|lien|foreclose|turn\s+(?:them|him|her)\s+in)\b/.source,
      /\b(?:please\s+)?(?:file|start|open|place)\s+an?\s+(?:lien|violation|case|citation)\b/.source,
      /\b(?:please\s+)?(?:send|mail|issue|write)\s+(?:them|him|her|the\s+owner|my\s+neighbou?r|that\s+house)\b[^.?!]{0,30}\b(?:letter|notice|violation|citation|fine)\b/.source,
      /\b(?:please\s+)?(?:fine|cite|ticket)\s+(?:them|him|her|my\s+neighbou?r|the\s+owner)\b/.source,
      /\bsend\s+(?:them|him|her|it)\s+to\s+collections\b/.source,
    ].join('|'), 'i'),
    reply: 'I can log what you are seeing with the details and the address so it gets looked at properly, but I do not open enforcement on anyone, that runs through inspection and the association\'s process. If you tell me the address and what you observed, I will get it into the queue today.',
  },
];

// Topics that are fine to EXPLAIN and would trip a naive keyword filter. Kept
// as documentation of intent and used by the test suite: if any of these ever
// starts getting blocked, the gate has drifted from helpful to obstructive.
const MUST_ALLOW = Object.freeze([
  'What does this violation letter mean?',
  'Why did I get a fine?',
  'How do I fix the violation so it goes away?',
  'What is my balance?',
  'When is my assessment due?',
  'What are the fence rules?',
  'How do I submit an ACC request?',
  'What happens if I do not respond to the notice?',
  'Can you explain the deadline on this letter?',
  'Is the pool open on Sundays?',
  'Can you tell me who my board members are?',
  'What did the board decide about the pool project?',
]);

/**
 * Screen one visitor utterance BEFORE it reaches the model.
 * Returns { allow: true } or { allow: false, reason, reply }.
 *
 * Role is accepted so the gate can widen later (staff asking "should we fine
 * 123 Main" is an operational question, not Claire acting) — but today every
 * role is held to the same line, because the output is identical either way:
 * Claire must not be the one who decides.
 */
function screen(text, role = 'homeowner') {
  const t = String(text || '').trim();
  if (!t) return { allow: true };
  for (const rule of RULES) {
    if (rule.pattern.test(t)) {
      return { allow: false, reason: rule.reason, reply: rule.reply, role };
    }
  }
  return { allow: true };
}

// The honest-AI line. On video this is NOT optional and NOT only spoken: a
// realistic face that does not announce itself is deceptive, and someone who
// joins late never hears the opener. The surface also carries a persistent
// badge. See feedback_no_claude_branding: the platform IS Bedrock AI.
function honestOpener(communityName, firstName, language = 'en') {
  const who = firstName ? `, ${firstName}` : '';
  if (language === 'es') {
    return `Hola${who}, soy Isabella, la asistente de inteligencia artificial de Bedrock para ${communityName}. En qué le puedo ayudar?`;
  }
  return `Hi${who}, I'm Claire, Bedrock's AI assistant for ${communityName}. What can I help with?`;
}

module.exports = { screen, honestOpener, RULES, MUST_ALLOW };
