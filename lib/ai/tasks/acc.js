// lib/ai/tasks/acc.js — the ACC task contract, V2 (resolution-first).
// ---------------------------------------------------------------------------
// V1 behaved like an AUDITOR: any conceivably-missing document or any subjective
// standard -> NEED_INFO. The shadow batch showed that's the wrong job — staff
// resolve applications (approve-with-conditions using precedent + judgment). V2
// makes Miranda a MANAGER who resolves, while KEEPING the deterministic hard-rule
// protection (an objective violation is a denial or a specific curing condition,
// never approved away). (Ed/ChatGPT 2026-09-19.)
//
// Division of labor unchanged: the model extracts which rule applies and the
// numbers; CODE does the comparison (3>=5 -> false) and overrides a model that
// miscalls a numeric rule. Severity keys on the ACTION/error relationship.

const ACC_SYSTEM = [
  'You are an experienced ACC (Architectural Control) manager for an HOA. Your job is to RESOLVE the application, not to audit it for a complete paperwork package. Missing documentation is NOT by itself a reason to withhold a decision.',
  'For every requirement, resolve it in THIS order, escalating only as a last resort:',
  '1) resolve from the submitted evidence (application, PDFs, photos);',
  '2) resolve from the governing documents;',
  '3) resolve from community precedent / prior approvals / existing-community evidence;',
  '4) if an unresolved requirement can safely become a SPECIFIC condition of approval, use APPROVE_WITH_CONDITIONS and state the condition (tied to the governing requirement, communicable to the homeowner);',
  '5) only if one genuinely necessary fact truly cannot be resolved or conditioned, use NEED_INFO for that specific fact;',
  '6) ESCALATE only when the judgment genuinely cannot be made from evidence, rules, and precedent.',
  'Subjective standards (harmony of external design, materials must complement, consistency with existing, color/neighborhood compatibility) are PART OF THE JOB — use precedent and evidence to decide. Do NOT escalate merely because a standard is subjective; escalate only if it stays genuinely unresolved after using precedent and evidence.',
  'Do NOT weaken hard objective rules: an objective violation (failed setback, over-height, etc.) is a denial or a specific curing condition — never approve it away to avoid asking. For numeric rules provide submitted_value_num, threshold_num, and operator so the comparison is checked in code.',
  'Prefer APPROVE or APPROVE_WITH_CONDITIONS when evidence, rules, and precedent reasonably support it. Return ONLY the JSON contract.',
].join('\n');

const ACC_SCHEMA_HINT = `Return ONLY JSON, no prose, matching exactly:
{
  "application_id": string,
  "decision": "APPROVE" | "APPROVE_WITH_CONDITIONS" | "DENY" | "NEED_INFO" | "ESCALATE",
  "items": [
    { "type": string,
      "disposition": "APPROVE" | "APPROVE_WITH_CONDITIONS" | "DENY" | "NEED_INFO",
      "requirements": [
        { "rule": string, "source_document": string, "requirement": string,
          "rule_type": "NUMERIC" | "ENUM" | "BOOLEAN" | "DOCUMENT" | "SUBJECTIVE",
          "submitted_value": string,
          "submitted_value_num": number|null, "threshold_num": number|null, "operator": ">=" | "<=" | "==" | "!=" | null,
          "allowed_values": string[]|null, "document_provided": boolean|null,
          "resolved_from": "evidence" | "governing_docs" | "precedent" | "condition" | "unresolved",
          "condition": string|null,
          "complies": boolean|null }
      ] }
  ],
  "missing_information": string[],
  "subjective_judgments": string[],
  "variance_required": boolean,
  "rationale": string,
  "proposed_homeowner_action": "APPROVE" | "APPROVE_WITH_CONDITIONS" | "DENY" | "NEED_INFO" | "ESCALATE"
}
For each requirement set resolved_from to how you resolved it. If not currently
compliant but curable, set disposition APPROVE_WITH_CONDITIONS and give a specific
"condition". Never assert complies for a NUMERIC rule without the numbers.`;

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
          default: computed = r.complies;
        }
        if (computed !== r.complies) overrides.push({ rule: r.rule, model_said: r.complies, computed, x, op: r.operator, t });
        r.complies = computed; r._computed = true;
      }
    }
  }
  return { struct, overrides };
}

function evidenceOk(r) {
  switch (r.rule_type) {
    case 'NUMERIC': return r.submitted_value_num != null && r.threshold_num != null && !!r.operator;
    case 'ENUM': return r.submitted_value != null && Array.isArray(r.allowed_values) && r.allowed_values.length > 0;
    case 'BOOLEAN': return r.submitted_value != null && typeof r.complies === 'boolean';
    case 'DOCUMENT': return typeof r.document_provided === 'boolean';
    case 'SUBJECTIVE': return false;
    default: return false;
  }
}

const APPROVES = (d) => d === 'APPROVE' || d === 'APPROVE_WITH_CONDITIONS';

// Catastrophic == the AI would let a CONFIRMED objective violation stand:
//  - APPROVE (unconditional) over an evaluable complies=false requirement, OR
//  - APPROVE_WITH_CONDITIONS over such a requirement WITHOUT a curing condition.
// A conditional approval that carries a specific curing condition is NOT
// catastrophic — that is the correct manager move. A DENY/NEED_INFO carries no gate.
function severity(struct) {
  for (const item of (struct.items || [])) {
    if (!APPROVES(item.disposition)) continue;
    for (const r of (item.requirements || [])) {
      if (evidenceOk(r) && r.complies === false) {
        const cured = item.disposition === 'APPROVE_WITH_CONDITIONS' && r.condition && String(r.condition).trim().length > 0;
        if (!cured) return 'catastrophic';
      }
    }
  }
  return null;
}

// Router-facing assessment. evidence_incomplete now means: an APPROVE/-WITH-
// CONDITIONS that rests on a requirement it could neither confirm (no evidence)
// NOR cure with a condition — i.e. an unconfirmable approval. (A NEED_INFO/ESCALATE
// is already the model holding; it doesn't need this gate.)
function assess(struct) {
  const issues = [];
  let evidence_incomplete = false;
  for (const item of (struct.items || [])) {
    if (!APPROVES(item.disposition)) continue;
    for (const r of (item.requirements || [])) {
      // Objective rules are confirmable only with their evidence (a NUMERIC
      // complies=true WITHOUT numbers is NOT trusted — that was the hole). A
      // SUBJECTIVE rule is "confirmable" when the manager resolved it from
      // evidence/precedent/governing docs (V2 lets her exercise that judgment).
      const confirmable = evidenceOk(r)
        || (r.rule_type === 'SUBJECTIVE' && ['evidence', 'precedent', 'governing_docs'].includes(r.resolved_from));
      const conditioned = r.condition && String(r.condition).trim().length > 0;
      if (!confirmable && !conditioned) {
        evidence_incomplete = true;
        issues.push({ item: item.type, rule: r.rule, rule_type: r.rule_type, why: 'approved but neither confirmable nor conditioned' });
      }
    }
  }
  return { severity: severity(struct), evidence_incomplete, issues };
}

// ---- agreement: decision-level vs structure-level, item names NORMALIZED ----
const STOP = new Set(['the', 'and', 'of', 'a', 'system', 'unit', 'existing', 'new', 'freestanding', 'exterior', 'interior', '-', '/']);
function tokens(name) {
  return new Set(String(name || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)));
}
function jaccard(a, b) { if (!a.size || !b.size) return 0; let inter = 0; a.forEach((x) => { if (b.has(x)) inter++; }); return inter / (a.size + b.size - inter); }
const failCompliance = (item) => (item.requirements || []).some((r) => r.complies === false);

function agree(a, b) {
  if (!a || !b) return { agree: false, decision_agree: false, structure_agree: false, reasons: ['missing a structured decision'] };
  const reasons = [];
  const decision_agree = a.decision === b.decision;
  if (!decision_agree) reasons.push(`decision ${a.decision} vs ${b.decision}`);
  // match items across sides by token overlap (not exact name)
  const A = a.items || [], B = b.items || [];
  const usedB = new Set();
  let structOk = true;
  for (const ia of A) {
    const ta = tokens(ia.type);
    let best = -1, bestScore = 0;
    B.forEach((ib, j) => { if (usedB.has(j)) return; const sc = jaccard(ta, tokens(ib.type)); if (sc > bestScore) { bestScore = sc; best = j; } });
    if (best === -1 || bestScore < 0.34) { structOk = false; reasons.push(`item "${ia.type}" unmatched`); continue; }
    usedB.add(best); const ib = B[best];
    if (ia.disposition !== ib.disposition) { structOk = false; reasons.push(`item "${ia.type}" ${ia.disposition} vs ${ib.disposition}`); }
    if (failCompliance(ia) !== failCompliance(ib)) { structOk = false; reasons.push(`item "${ia.type}" compliance differs`); }
  }
  if (B.length !== usedB.size) { structOk = false; reasons.push(`${B.length - usedB.size} verifier item(s) unmatched`); }
  if (!!a.variance_required !== !!b.variance_required) { structOk = false; reasons.push('variance_required differs'); }
  // `agree` (used by the router as the material gate) is the DECISION-level result.
  return { agree: decision_agree, decision_agree, structure_agree: decision_agree && structOk, reasons };
}

module.exports = { ACC_SYSTEM, ACC_SCHEMA_HINT, buildPrompt, parse, applyDeterministicChecks, severity, assess, evidenceOk, agree };
