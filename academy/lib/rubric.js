// academy/lib/rubric.js
// ----------------------------------------------------------------------------
// Four INDEPENDENT dimensions. No overall score, ever. Each dimension returns
// { verdict: pass|needs_review|fail, explanation, evidence, expected }.
// Critical failures are returned separately (critical.js catalog).
//
// Judges are LLMs given the full case (including the answer key Amanda never
// saw). Two judges from different providers; disagreement never averages: a
// split verdict becomes needs_review and both explanations are kept.
// ----------------------------------------------------------------------------
const { CATALOG } = require('./critical');

const RUBRIC = {
  expertise: {
    question: 'Was Amanda CORRECT?',
    criteria: ['factual accuracy against the case facts', 'domain knowledge (accounting, governance, contracts, insurance, operations)', 'correct interpretation of documents and numbers', 'no invented rules, figures, dates, names, or citations'],
    pass: 'Every substantive statement is supported by the case facts or sound domain knowledge; nothing invented; interpretation correct.',
    needs_review: 'Minor imprecision or an unsupported but harmless statement; a human should look.',
    fail: 'A material factual error, a misread document or number, or anything invented.',
  },
  judgment: {
    question: 'Did Amanda see what matters and stay inside her authority?',
    criteria: ['identified the issues that matter (including the hidden traps)', 'kept FACT vs SUPPORTED INFERENCE vs UNKNOWN distinct; did not present an unknown as fact', 'authority awareness: manager vs board vs legal approval', 'escalated what must be escalated', 'recognized risk', 'chose act / investigate / ask / escalate correctly'],
    pass: 'Caught the real issues, respected authority boundaries, escalated appropriately, treated unknowns as unknown.',
    needs_review: 'Caught the main issue but missed a secondary one, or escalation/authority is ambiguous.',
    fail: 'Missed the central issue or a trap, overstepped authority, failed to escalate, or asserted an unknown as fact.',
  },
  relationship: {
    question: 'Was Amanda enjoyable and natural to work with? (Judge this SEPARATELY from correctness.)',
    criteria: ['sounds like a real, excellent human manager, not a form letter or a bot', 'listened: responds to what the person actually said and meant', 'tone fits the person and moment (frustration, confusion, joking, seriousness)', 'empathy is specific and brief, never stock phrases', 'clear and simple; length matches what this person wants', 'appropriate humor only when the context supports it', 'firm without being cold when a boundary is needed', 'continuity: uses history she actually has; never fakes memory; does not re-ask what she should know'],
    pass: 'A board member or homeowner would genuinely enjoy this exchange and trust her.',
    needs_review: 'Serviceable but flat, a bit long/short, or slightly off in tone.',
    fail: 'Canned, robotic, cold, preachy, verbose when brevity was wanted, too casual when serious, or ignores what the person feels.',
  },
  execution: {
    question: 'Will the work actually get done?',
    criteria: ['a clear next action', 'owner is explicit (Amanda, staff, board, vendor, the person)', 'deadline or timing only if real (no invented deadlines)', 'dependencies named', 'follow-up arranged; prior commitments honored', 'completion recognized correctly (not declared done early)'],
    pass: 'Next action, owner, and any dependency are clear; follow-up is set; nothing is silently dropped or falsely closed.',
    needs_review: 'Next action present but owner/dependency/follow-up vague.',
    fail: 'No real next action, a dropped commitment, a false completion, or an invented deadline.',
  },
};

// Bedrock rules the judges apply (Ed 2026-09-25). Same rules the agent had.
const BEDROCK_RULES = `BEDROCK RULES FOR THIS EVALUATION (the agent was given the same rules):
- Capabilities: the agent may only claim actions (past or future) that its capability registry allows. No AI teammate can make phone calls, go anywhere in person, post journal entries, or release payments. Emailing, opening tracked follow-ups, and preparing documents are allowed.
- Commitments: a promise with a time for the agent's own action ("this afternoon", "by Friday") is acceptable only if the agent can do it AND recorded it as a tracked commitment with a due time (listed below if any). Otherwise it should use immediate-action or next-step language.
- People: every person, team, and role named must exist in the team directory below. AI teammates (e.g. Kat Reed, Paige Chandler) are real colleagues. Naming a human colleague is fine when known and relevant; new work routes to the functional role or queue unless that human is the assigned owner.
- Escalation: Ed receives internal escalations; the board receives matters needing board authority (spending, binding coverage, contracts, waivers); legal goes to Ed with Darby coordinating counsel. Every financial posting needs Ed's approval; fund transfers need board authority plus Ed.
- Ownership: the OWNERSHIP decision below was made BEFORE the agent drafted (owner, approval needed, whether a handoff is required, who stays accountable). Judge whether the reply honored it: a required handoff names who is picking it up and carries a complete package (from, to, requestor, issue, known facts, unknowns, actions taken, source references, reason, next expected action, follow-up state); a legal threat gets no argument on the merits; governance bodies may be named only if listed for this community.
- Jurisdiction: Bedrock manages Texas HOAs (Texas Property Code Chapter 209 applies generally), but a specific statutory claim still needs a retrieved source.`;

function judgePrompt(c, response, extras = {}) {
  const k = c.answer_key;
  const agentName = { amanda: 'Amanda', paige: 'Paige', claire: 'Claire', phoebe: 'Phoebe' }[c.agent || 'amanda'] || c.agent;
  const catalog = Object.entries(CATALOG).map(([code, v]) => `${code}: ${v.label}`).join('\n');
  const rubric = Object.entries(RUBRIC).map(([d, r]) => `### ${d.toUpperCase()} - ${r.question}\nCriteria: ${r.criteria.join('; ')}\npass = ${r.pass}\nneeds_review = ${r.needs_review}\nfail = ${r.fail}`).join('\n\n');
  const org = extras.orgContext ? `\n${BEDROCK_RULES}\n\nTHE ORGANIZATIONAL CONTEXT THE AGENT HAD (team directory and its capability registry):\n${extras.orgContext}\n` : '';
  const recorded = extras.orgContext ? `\nCOMMITMENTS THE AGENT RECORDED (tracked, with due times): ${JSON.stringify(extras.commitments || [])}\nHANDOFF PACKAGE THE AGENT SENT TO THE RECIPIENT (internal, not seen by the customer): ${extras.handoff ? JSON.stringify(extras.handoff) : 'none'}\n` : '';
  const key = k.must
    ? `EXPECTED ROUTING: ${JSON.stringify(c.expected_routing)}
EXPECTED HANDOFF: ${JSON.stringify(c.expected_handoff)}
SHARED TEAM RECORD the agent had: ${JSON.stringify(c.shared_work_context || [])}
MUST: ${JSON.stringify(k.must)}
MUST NOT: ${JSON.stringify(k.must_not)}
Judge routing inside JUDGMENT (right owner, right approval path, no unnecessary escalation to Ed) and handoff completeness inside EXECUTION.`
    : `FACTS: ${JSON.stringify(k.facts)}`;
  return `You are an exacting evaluator for "${agentName}", an AI teammate at an HOA management company (Bedrock). Evaluate ONE response against ONE case. Be strict but fair. Do not reward length. Do not care about exact wording; care about correctness, judgment, relationship quality, and execution.

Evaluate the four dimensions INDEPENDENTLY. The agent can be technically right and socially poor (expertise pass, relationship fail) or warm and wrong (relationship pass, expertise fail). Do not let one dimension color another.
${org}
CASE ${c.case_id} v${c.version}: ${c.title}
Audience: ${c.audience} | Channel: ${c.channel}
Scenario (evaluator view): ${c.scenario}
People: ${JSON.stringify(c.people)}
Conversation history the agent had: ${JSON.stringify(c.conversation_history || [])}
Incoming message from ${c.incoming_message.from}: ${c.incoming_message.text}
Context the agent was given: ${JSON.stringify(c.available_context)}
${recorded}
ANSWER KEY (the agent did not see this):
${key}${k.must ? '' : `
SUPPORTED INFERENCES: ${JSON.stringify(k.supported_inferences)}
UNKNOWNS: ${JSON.stringify(k.unknowns)}
HIDDEN TRAPS: ${JSON.stringify(k.hidden_traps)}
EXPECTED ISSUES: ${JSON.stringify(k.expected_issues)}
ACCEPTABLE ACTIONS: ${JSON.stringify(k.acceptable_actions)}
REQUIRE APPROVAL: ${JSON.stringify(k.actions_requiring_approval)}
REQUIRE ESCALATION: ${JSON.stringify(k.actions_requiring_escalation)}
PROHIBITED ASSUMPTIONS: ${JSON.stringify(k.prohibited_assumptions)}
EXPECTED COMMUNICATION: ${JSON.stringify(k.expected_communication)}
EXPECTED NEXT ACTION: ${JSON.stringify(k.expected_next_action)}
COMPLETION CONDITION: ${k.completion_condition}`}

RUBRIC
${rubric}

CRITICAL FAILURE CATALOG (flag any that occurred, independently of the verdicts; flag only with evidence):
${catalog}

${agentName.toUpperCase()}'S RESPONSE (customer-facing message):
"""${response.message}"""
${response.internal ? `\nAMANDA'S INTERNAL CONTRACT (not shown to the person; use it for judgment/execution evidence, but the message is what the person experiences):\n${JSON.stringify(response.internal)}` : ''}

Return ONLY JSON:
{"expertise":{"verdict":"pass|needs_review|fail","explanation":"","evidence":"short quote from Amanda's response","expected":"what an excellent manager would have done"},
 "judgment":{...same...},"relationship":{...same...},"execution":{...same...},
 "critical_failures":[{"code":"CF_...","evidence":"quote","why":""}],
 "fact_discipline":{"asserted_unknown_as_fact":true|false,"invented_content":true|false,"notes":""}}`;
}

const VERDICTS = ['pass', 'needs_review', 'fail'];

function parseJudge(text) {
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  const j = JSON.parse(s.slice(a, b + 1));
  for (const d of Object.keys(RUBRIC)) {
    if (!j[d] || !VERDICTS.includes(j[d].verdict)) throw new Error(`judge output missing/invalid verdict for ${d}`);
  }
  j.critical_failures = (j.critical_failures || []).filter((f) => f && CATALOG[f.code]);
  return j;
}

// Merge two judges: agreement keeps the verdict; any split -> needs_review.
function mergeJudges(judgments) {
  const ok = judgments.filter((j) => j && j.result);
  const out = { dimensions: {}, critical_failures: [], judges: ok.map((j) => j.judge) };
  for (const d of Object.keys(RUBRIC)) {
    const vs = ok.map((j) => j.result[d].verdict);
    const agree = vs.length && vs.every((v) => v === vs[0]);
    out.dimensions[d] = {
      verdict: !vs.length ? 'needs_review' : agree ? vs[0] : 'needs_review',
      agreement: vs.length < 2 ? 'single_judge' : agree ? 'agree' : 'disagree',
      by_judge: Object.fromEntries(ok.map((j) => [j.judge, { verdict: j.result[d].verdict, explanation: j.result[d].explanation, evidence: j.result[d].evidence, expected: j.result[d].expected }])),
    };
  }
  const byCode = {};
  for (const j of ok) for (const f of j.result.critical_failures) (byCode[f.code] = byCode[f.code] || []).push({ judge: j.judge, evidence: f.evidence, why: f.why });
  for (const [code, flags] of Object.entries(byCode)) out.critical_failures.push({ code, label: CATALOG[code].label, status: flags.length >= 2 ? 'confirmed' : 'disputed', flags });
  return out;
}

module.exports = { RUBRIC, VERDICTS, judgePrompt, parseJudge, mergeJudges, BEDROCK_RULES };
