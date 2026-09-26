// academy/lib/intent.js  (Amanda Academy v1.1, sandbox)
// ----------------------------------------------------------------------------
// Communication-intent classifier. Runs BEFORE Amanda decides how to answer and
// controls response SHAPE (not facts, not authority):
//
//   direct_fact | status_update | casual_conversation | explanation |
//   decision_support | conflict_deescalation | task_request | escalation_risk
//
// Plus a separate RISK OVERLAY: a status question about an expired policy is
// still a status question, but it must be answered with escalation behavior.
// If risk signals are present the effective mode becomes escalation_risk and the
// underlying mode is kept (e.g. escalation_risk over direct_fact).
//
// Deterministic first (testable, explainable, free). An LLM fallback for
// low-confidence cases is a design item, not wired here.
// ----------------------------------------------------------------------------

const MODES = ['direct_fact', 'status_update', 'casual_conversation', 'explanation', 'decision_support', 'conflict_deescalation', 'task_request', 'escalation_risk'];

const R = {
  conflict: /\b(thieves|ridiculous|unacceptable|fed up|i'?m done|sick of|incompetent|lawyer|sue|scam|furious)\b|!{2,}|\bwtf\b/i,
  task: /\b(go ahead and|please (send|schedule|set up|draft|sign|pull|book|order|pay|call|fix|reset)|can you (send|pull|draft|set up|schedule|sign|call|book|order|fix|reset)|could you (send|pull|draft|set up|schedule|fix)|can (someone|somebody|you guys) (fix|reset|look at|come out)|sign (it|the)|set (that|it) up|can i close)\b/i,
  // Decision format is for real choices. "Can the board raise dues without a
  // vote?" is a question about authority (a fact), not a decision request.
  decision: /\b(should (we|i|the board)|which (option|vendor|one)|do you recommend|what would you recommend|renew .* or|go out to bid|vote on|is it worth|can we just|is it (ok|okay) (if|to))\b/i,
  status: /\b(any update|update on|what happened with|whatever happened|where are we on|status (of|on)|still waiting|any idea when|when will .* (be|get) (working|fixed|done|back)|how long until|did .* (ever )?(get|come) (back|fixed|done)|has .* been (fixed|done|paid|resolved))\b/i,
  explain: /\b(why|walk me through|explain|how does|how do|what does .* mean|help me understand|i don'?t (even )?(know|understand) what)\b/i,
  fact: /(^|[.?!]\s+|,\s*)(did|is|are|was|were|has|have|do|does|can|could|may|how much|how many|what|when|who|where)\b[^.?!]*\?/i,
  yn: /\by\/n\b|\byes or no\b/i,
  casual: /^\s*(thanks|thank you|thx|morning|good morning|hey|hi|lol|haha|appreciate it|nice|great)\b/i,
  joke: /(😅|😂|🤣|\blol\b|\bhaha\b|\bjk\b)/i,
  riskTopic: /\b(insurance|insured|coverage|covered|policy|tree|oak|gate|latch|leak(ing)?|mold|gas|fire|flood|electrical)\b/i,
  statusAsk: /\b(covered|good on|ok(ay)? on|done|all set|complete|close (the )?ticket|lapse[ds]?|expired|in force|any update|update on|safe|still (broken|out))\b/i,
  hazard: /\b(unsafe|hazard|injur(y|ed)|emergency|kids can get in|could come down|fire|flood|gas leak|sparking)\b/i,
  riskCtx: /\b(expired|ended \d|term ended|no (renewal|binder)|unconfirmed|not (yet )?confirmed|safety|hazard|leaning|could come down)\b/i,
};

function classifyIntent({ message, channel = 'email', contextText = '', audience = null }) {
  const m = String(message || '').trim();
  const words = (m.match(/\S+/g) || []).length;
  const signals = [];
  let mode = null;
  const hit = (name, re) => { if (re.test(m)) { signals.push(name); return true; } return false; };

  if (hit('conflict', R.conflict)) mode = 'conflict_deescalation';
  else if (hit('task', R.task)) mode = 'task_request';
  else if (hit('decision', R.decision)) mode = 'decision_support';
  else if (hit('status', R.status)) mode = 'status_update';
  else if (hit('explain', R.explain)) mode = 'explanation';
  else if (hit('fact', R.fact) || hit('yes_no', R.yn)) mode = words <= 25 ? 'direct_fact' : 'explanation';
  else if (hit('casual', R.casual)) mode = 'casual_conversation';
  else if (/\?\s*$/.test(m)) { signals.push('question'); mode = words <= 25 ? 'direct_fact' : 'explanation'; }
  else mode = words <= 12 ? 'casual_conversation' : 'explanation';

  // A colleague asking "should I...?" wants a direct answer, not a board-style
  // options memo; decision format is for the people who actually decide.
  if (mode === 'decision_support' && audience === 'staff') { mode = 'direct_fact'; signals.push('staff_advice'); }
  // Long, emotional venting (not abusive) is still de-escalation.
  if (mode !== 'conflict_deescalation' && words > 60 && /\b(nobody cares|why (do )?i (even )?bother|never been this bad|i'?m (so )?(frustrated|upset|tired))\b/i.test(m)) { mode = 'conflict_deescalation'; signals.push('venting'); }

  const joking = R.joke.test(m);
  if (joking) signals.push('humor_present');
  // Risk overlay: an explicit hazard in the message, or a STATUS/COMPLETION ask
  // about a risk-bearing item while the context shows it unresolved. Asking to
  // have the insurance line explained is not a risk ask.
  const riskFromCtx = R.riskCtx.test(String(contextText || ''));
  const risk = R.hazard.test(m) || (R.riskTopic.test(m) && R.statusAsk.test(m) && riskFromCtx);
  if (risk) signals.push('risk');

  const underlying = mode;
  const effective = risk && !['decision_support', 'conflict_deescalation'].includes(mode) ? 'escalation_risk' : mode;
  const strong = ['conflict', 'task', 'decision', 'status', 'risk', 'staff_advice'];
  const confidence = !signals.length ? 'low' : (signals.some((x) => strong.includes(x)) || signals.length >= 2 ? 'high' : 'medium');
  return { mode: effective, underlying_mode: underlying, risk, joking, channel, confidence, signals };
}

// How each mode shapes the reply. This is the ONLY place decision format
// (options / tradeoffs / recommendation) is asked for.
const SHAPES = {
  direct_fact: 'Answer the question in the first sentence. Add only what they would need next. No options, no recommendation, no preamble.',
  status_update: 'Give the status in one or two sentences, labelling what is confirmed, unconfirmed, or unknown, then the next step and who owns it. No options and no recommendation unless they ask what to do.',
  casual_conversation: 'Reply naturally and briefly, like a colleague. Humor is fine if they used it and the moment is light. No structure, no options. Gently correct a wrong premise if there is one.',
  explanation: 'Explain plainly, in the order they need to understand it, with the real numbers. Short paragraphs; numbered steps only if the process genuinely has steps. Length should match what they asked for.',
  decision_support: 'They are asking for a decision. Lay out the relevant facts, give 2 to 3 real options with their tradeoffs, state your recommendation, and say who decides (the board, by vote or written consent, when it is theirs).',
  conflict_deescalation: 'Acknowledge the specific thing that upset them in your own words, once and briefly (no stock phrases). Give the facts plainly. Hold any boundary calmly and without threats. Offer one clear path forward. Do not grovel and do not match their tone.',
  task_request: 'Say whether you can do it, and do what is within your authority. If it needs someone else\'s approval, say exactly what is needed and the fastest legitimate path, and move it forward.',
  escalation_risk: 'Lead with the risk status, labelling what is confirmed, unconfirmed, or unknown precisely. Verifying it is your job: say what you are doing about it now, using only what you can actually do. If someone else needs to know, name them from YOUR TEAM and its ESCALATION PATHS (Ed for internal escalation, the board for anything needing board authority, legal review for legal matters); if no one else needs to know yet, say nothing about escalation. Anything that commits money or coverage (binding, signing, paying) is a decision for the board or Ed: say you will bring it to them, not that you will do it. Keep the tone proportionate to what is actually known. If they joked, a brief human nod is fine, then be serious.',
};

// v1.3: when the pre-draft owner classifier requires a handoff, ownership wins
// over the conversational intent (a legal threat read as "casual" must not get a
// chatty reply). Not a classifier mode; applied by withOwnership().
SHAPES.handoff = 'This belongs to someone else (see OWNERSHIP). Acknowledge what they raised in a sentence, in your own words. Say plainly who is taking it (by name or role) and what happens next, and that nothing is lost (they will not have to start over). Say nothing on the substance that belongs to the owner: no rulings, no arguments, no numbers you have not confirmed. Keep it short.';

function withOwnership(intent, owner) {
  if (!owner || !owner.handoff_required) return intent;
  return { ...intent, mode: 'handoff', underlying_mode: intent.mode };
}

module.exports = { MODES, classifyIntent, SHAPES, withOwnership };
