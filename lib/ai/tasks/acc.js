// lib/ai/tasks/acc.js — the ACC task contract. Eliminates prose parsing: the
// model returns a STRICT schema, code does the objective comparisons, and
// severity keys on the ACTION/error relationship (APPROVE-over-a-hard-violation),
// never on "a violation exists." A correct DENY of a noncompliant item is exactly
// right and must NOT trip a catastrophic gate.
//
// Division of labor (ChatGPT/Ed 2026-09-19):
//   model  -> which rule applies, what the numbers mean (extract rule + values)
//   code   -> the comparison itself (3 >= 5 -> false), deterministically
// So a model that extracts "submitted 3ft, min 5ft" but claims complies:true is
// overridden by code, and if it then APPROVED that item, that's catastrophic.

// The decision contract primary AND verifier must both return.
const ACC_SCHEMA_HINT = `Return ONLY JSON, no prose, matching exactly:
{
  "application_id": string,
  "decision": "APPROVE" | "DENY" | "NEED_INFO" | "ESCALATE",
  "items": [
    { "type": string,
      "disposition": "APPROVE" | "DENY" | "NEED_INFO",
      "requirements": [
        { "rule": string, "source_document": string, "requirement": string,
          "submitted_value": string,
          "submitted_value_num": number|null, "threshold_num": number|null,
          "operator": ">=" | "<=" | "==" | "!=" | null,
          "complies": boolean }
      ] }
  ],
  "missing_information": string[],
  "subjective_judgments": string[],
  "variance_required": boolean,
  "rationale": string,
  "proposed_homeowner_action": "APPROVE" | "DENY" | "NEED_INFO" | "ESCALATE"
}
For any numeric rule (setback, height, size, count), fill submitted_value_num,
threshold_num, and operator so the comparison can be checked in code. Do not
decide compliance for numeric rules by intuition; provide the numbers.`;

function buildPrompt(applicationAndGuidelines) {
  return `${applicationAndGuidelines}\n\n${ACC_SCHEMA_HINT}`;
}

function parse(text) {
  let s = String(text || '').trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b === -1) return { ok: false, error: 'no JSON object found' };
  try { return { ok: true, value: JSON.parse(s.slice(a, b + 1)) }; }
  catch (e) { return { ok: false, error: 'JSON parse: ' + e.message }; }
}

// Recompute `complies` for every numeric requirement in code. Returns the struct
// with code-authoritative compliance plus a list of overrides where the model
// disagreed with arithmetic.
function applyDeterministicChecks(struct) {
  const overrides = [];
  for (const item of (struct.items || [])) {
    for (const r of (item.requirements || [])) {
      if (r.submitted_value_num != null && r.threshold_num != null && r.operator) {
        const x = Number(r.submitted_value_num), t = Number(r.threshold_num);
        let computed;
        switch (r.operator) {
          case '>=': computed = x >= t; break;
          case '<=': computed = x <= t; break;
          case '==': computed = x === t; break;
          case '!=': computed = x !== t; break;
          default: computed = r.complies; // unknown operator: leave model's claim
        }
        if (computed !== r.complies) overrides.push({ rule: r.rule, model_said: r.complies, computed, x, op: r.operator, t });
        r.complies = computed; // code is authoritative for numeric rules
        r._computed = true;
      }
    }
  }
  return { struct, overrides };
}

// Severity keyed on the ACTION/error relationship, NOT on the mere existence of a
// violation. Catastrophic == the AI would APPROVE something that objectively
// fails a hard rule. A correct DENY of a noncompliant item -> no gate.
function severity(struct) {
  const approvesViolation = (disp) => disp === 'APPROVE';
  for (const item of (struct.items || [])) {
    const failing = (item.requirements || []).some((r) => r.complies === false);
    if (failing && approvesViolation(item.disposition)) return 'catastrophic';
  }
  // Overall APPROVE while any item objectively fails a hard rule.
  if (struct.decision === 'APPROVE' && (struct.items || []).some((it) => (it.requirements || []).some((r) => r.complies === false))) return 'catastrophic';
  return null; // correct approvals, and any denial/need-info, carry no severity gate here
}

// Field-by-field structured agreement (not prose). Compares overall decision,
// per-item disposition, and per-requirement compliance + rule.
function agree(a, b) {
  const reasons = [];
  if (!a || !b) return { agree: false, reasons: ['missing a structured decision'] };
  if (a.decision !== b.decision) reasons.push(`decision ${a.decision} vs ${b.decision}`);
  const byType = (s) => Object.fromEntries((s.items || []).map((i) => [String(i.type || '').toLowerCase(), i]));
  const A = byType(a), B = byType(b);
  for (const type of new Set([...Object.keys(A), ...Object.keys(B)])) {
    if (!A[type] || !B[type]) { reasons.push(`item "${type}" present on one side only`); continue; }
    if (A[type].disposition !== B[type].disposition) reasons.push(`item "${type}" ${A[type].disposition} vs ${B[type].disposition}`);
    const cmp = (i) => (i.requirements || []).some((r) => r.complies === false);
    if (cmp(A[type]) !== cmp(B[type])) reasons.push(`item "${type}" compliance differs`);
  }
  if (!!a.variance_required !== !!b.variance_required) reasons.push('variance_required differs');
  return { agree: reasons.length === 0, reasons };
}

module.exports = { ACC_SCHEMA_HINT, buildPrompt, parse, applyDeterministicChecks, severity, agree };
