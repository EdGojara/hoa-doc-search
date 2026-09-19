// lib/ai/verify.js — cross-provider verification + STRUCTURED agreement.
// Agreement compares material facts, cited rules, calculations, and disposition —
// NOT prose similarity (two right answers can read very differently; two wrong
// ones can read alike).
const { callModel } = require('./model_client');

// Light structured extraction from an answer's text, per task type. Real domain
// parsers replace these as each surface is productionized; they are enough to
// prove the pipeline and to compare primary vs verifier.
function extractStructured(text, taskType) {
  const t = String(text || '');
  const s = { business_decision: 'ANALYZE', basis: null, cited_rules: [], numbers: {} };
  if (taskType === 'acc') {
    if (/\b(deny|denied|cannot be approved|not approved(?! as submitted)|declined)\b/i.test(t)) s.business_decision = 'DENY';
    else if (/\b(need (more )?info|clarif|missing information|please confirm|request(ing)? (additional )?information)\b/i.test(t)) s.business_decision = 'NEED_INFO';
    else if (/\b(escalat|refer to the board|board input|human review)\b/i.test(t)) s.business_decision = 'ESCALATE';
    else if (/\bapprove/i.test(t)) s.business_decision = 'APPROVE';
    s.basis = /(consistent with the neighborhood|harmonious|subjective|aesthetic|no approved palette|no objective standard)/i.test(t) ? 'subjective' : 'objective';
    s.cited_rules = [...t.matchAll(/(section\s?\d+(?:\.\d+)?|§\s?\d+(?:\.\d+)?|setback|palette|guideline)/ig)].map((m) => m[1].toLowerCase());
  } else if (taskType === 'finance') {
    // the reconciled/adjusted balance the answer settles on
    const m = [...t.matchAll(/(reconcil|adjusted|ties?|balance)[^\d]{0,40}\$?([\d,]+(?:\.\d+)?)/ig)];
    if (m.length) s.numbers.reconciled = parseFloat(m[m.length - 1][2].replace(/,/g, ''));
  }
  return s;
}

// Do primary and verifier materially agree? Returns { agree, reasons }.
function agree(a, b, taskType) {
  const reasons = [];
  if (a.business_decision && b.business_decision && a.business_decision !== b.business_decision) {
    reasons.push(`decision ${a.business_decision} vs ${b.business_decision}`);
  }
  if (taskType === 'finance') {
    const x = a.numbers.reconciled, y = b.numbers.reconciled;
    if (x != null && y != null && Math.abs(x - y) > 1) reasons.push(`reconciled ${x} vs ${y}`);
    if ((x == null) !== (y == null)) reasons.push('one side has no reconciled figure');
  }
  return { agree: reasons.length === 0, reasons };
}

// Run an independent cross-provider verifier on the primary's answer.
async function runVerifier({ taskType, taskPrompt, primaryText, verifierCfg }) {
  if (!verifierCfg) return { ran: false, ok: false, reason: 'no verifier configured' };
  const prompt = `Independently verify the analysis below against the task. Recompute any numbers, re-check any cited rule, and state your own decision. Be terse and specific.\n\n=== TASK ===\n${taskPrompt}\n\n=== ANALYSIS TO VERIFY ===\n${primaryText}`;
  const r = await callModel({
    provider: verifierCfg.provider, model: verifierCfg.model, price: verifierCfg,
    system: 'You are a meticulous independent reviewer from a different provider than the author. Recompute, do not rubber-stamp.',
    prompt, maxTokens: 2500, kind: 'verify',
  });
  if (!r.ok) return { ran: true, ok: false, reason: r.error, meta: { provider: r.provider, model: r.model } };
  return { ran: true, ok: true, findings_text: r.text, structured: extractStructured(r.text, taskType), meta: { provider: r.provider, model: r.model, latency_ms: r.latency_ms } };
}

module.exports = { extractStructured, agree, runVerifier };
