// lib/ai/shadow/evidence_conflict.js — Phase 2 of the evidence-readiness layer
// (Ed/ChatGPT 2026-09-19). Two jobs, both NARROW and separate from the ACC
// decision:
//   1) detectConflicts — a factual-only pass that finds mutually-exclusive claims
//      across evidence sources (the masonry case: one letter says the stone
//      veneer stays, another says it is being replaced). It does NOT make or
//      suggest an ACC decision. Code renders a canonical clarification question
//      from the structured conflict so the ask is STABLE across runs.
//   2) clarification/resume — apply the homeowner's answer as new evidence,
//      mark the conflict resolved, VERSION the package (new hash), so Miranda
//      resumes automatically. Pure functions; failure-isolated like the shadow.
const crypto = require('crypto');
const { READINESS, STATE } = require('./acc_evidence');

const CONFLICT_SYSTEM = [
  'You compare EVIDENCE SOURCES for FACTUAL contradictions ONLY.',
  'You do NOT make, suggest, or hint at an ACC/architectural decision. You do not judge compliance.',
  'Find pairs of sources that assert MUTUALLY EXCLUSIVE facts about project scope, materials, dimensions, or placement (e.g. one source says a feature stays as-is, another says it is being replaced).',
  'A difference in wording or detail is NOT a conflict. Only genuinely contradictory facts count.',
  'Return ONLY JSON.',
].join('\n');

const CONFLICT_SCHEMA = `Return ONLY JSON matching exactly:
{ "conflicts": [ { "topic": string, "topic_label": string,
  "assertion_a": { "source": string, "claim": string },
  "assertion_b": { "source": string, "claim": string },
  "resolvable_by": "homeowner_clarification" | "governing_docs" | "precedent" } ] }
If there are no genuine factual contradictions, return {"conflicts": []}.`;

function parse(text) {
  let s = String(text || '').trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b === -1) return { ok: false, error: 'no JSON object' };
  try { return { ok: true, value: JSON.parse(s.slice(a, b + 1)) }; } catch (e) { return { ok: false, error: e.message }; }
}

// canonical, DETERMINISTIC question from a structured conflict — same conflict
// always renders the same ask (GPT's "same targeted clarification across runs").
function renderQuestion(c) {
  const label = c.topic_label || c.topic || 'your project scope';
  const a = (c.assertion_a && c.assertion_a.claim) || 'one option';
  const b = (c.assertion_b && c.assertion_b.claim) || 'the other option';
  return `Your application materials contain conflicting information about ${label}: one indicates "${a}", while another indicates "${b}". Please confirm which is correct so we can complete your review.`;
}

// deps: { callModel, model_cfg } — model_cfg { provider, model, price }. Narrow +
// failure-isolated: any error yields { ok:false, conflicts:[] } (never throws).
async function detectConflicts(pkg, deps) {
  try {
    const callModel = deps && deps.callModel;
    const cfg = (deps && deps.model_cfg) || {};
    if (!callModel) return { ok: false, conflicts: [], error: 'no callModel' };
    const prompt = `EVIDENCE SOURCES:\n${pkg.bundle_text}\n\n${CONFLICT_SCHEMA}`;
    const r = await callModel({ provider: cfg.provider, model: cfg.model, price: cfg, system: CONFLICT_SYSTEM, prompt, maxTokens: 1500, kind: 'conflict_detect' });
    if (!r.ok) return { ok: false, conflicts: [], error: r.error };
    const p = parse(r.text);
    if (!p.ok) return { ok: false, conflicts: [], error: p.error };
    const conflicts = (p.value.conflicts || []).map((c, i) => ({
      conflict_id: `${pkg.package_id}:c${i + 1}`,
      topic: c.topic || `conflict_${i + 1}`, topic_label: c.topic_label || c.topic || null,
      assertions: [c.assertion_a, c.assertion_b].filter(Boolean),
      resolvable_by: c.resolvable_by || 'homeowner_clarification',
      question: renderQuestion(c), status: 'OPEN', resolution: null,
    }));
    return { ok: true, conflicts };
  } catch (e) { return { ok: false, conflicts: [], error: e && e.message ? e.message : String(e) }; }
}

function _hash(bundle_text, manifest, conflicts, version) {
  const stateFp = manifest.map((m) => `${m.source}:${m.state}`).sort().join('|');
  const conflictFp = (conflicts || []).map((c) => `${c.topic}:${c.status}`).sort().join('|');
  return crypto.createHash('sha256').update(`v${version}\n${bundle_text}\n##STATES##\n${stateFp}\n##CONFLICTS##\n${conflictFp}`).digest('hex');
}

// return a NEW frozen package carrying the detected conflicts. readiness becomes
// CONFLICT while any conflict is OPEN (that supersedes READY — do not reason on
// contradictory facts). If no conflicts, returns the package unchanged.
function withConflicts(pkg, conflicts) {
  if (!conflicts || !conflicts.length) return pkg;
  const version = pkg.version || 1;
  const readiness = conflicts.some((c) => c.status === 'OPEN') ? READINESS.CONFLICT : pkg.readiness;
  const next = { ...pkg, conflicts: conflicts.map((c) => Object.freeze(c)), readiness, content_hash: _hash(pkg.bundle_text, pkg.manifest, conflicts, version) };
  Object.freeze(next.conflicts);
  return Object.freeze(next);
}

// apply a homeowner clarification: the answer becomes new evidence, the matching
// conflict resolves, the package VERSIONS (new hash), and readiness recomputes so
// Miranda resumes automatically. Pure — returns a new frozen package version.
// resolution: { topic, answer, source? }
function applyClarification(pkg, resolution) {
  const version = (pkg.version || 1) + 1;
  const conflicts = (pkg.conflicts || []).map((c) => {
    if (c.status === 'OPEN' && (c.topic === resolution.topic || !resolution.topic)) {
      return Object.freeze({ ...c, status: 'RESOLVED', resolution: { answer: resolution.answer, source: resolution.source || 'homeowner_clarification', resolved_at: new Date().toISOString() } });
    }
    return c;
  });
  const manifest = [...pkg.manifest, Object.freeze({ source: 'homeowner_clarification', required: false, type: 'clarification', state: STATE.PRESENT_READABLE, method: 'homeowner_reply', attempts: 1, chars: String(resolution.answer || '').length })];
  const bundle_text = `${pkg.bundle_text}\n\nHOMEOWNER CLARIFICATION (${resolution.topic || 'scope'}):\n${resolution.answer}`;
  const stillOpen = conflicts.some((c) => c.status === 'OPEN');
  // recompute readiness: if no open conflicts and required artifacts are all
  // present/readable, we're READY again.
  const reqOk = manifest.filter((m) => m.required).every((m) => m.state === STATE.PRESENT_READABLE);
  const readiness = stillOpen ? READINESS.CONFLICT : (reqOk ? READINESS.READY : pkg.readiness);
  const next = { ...pkg, version, manifest: manifest.map((m) => Object.freeze(m)), conflicts: conflicts.map((c) => Object.freeze(c)), bundle_text, readiness, content_hash: _hash(bundle_text, manifest, conflicts, version) };
  Object.freeze(next.manifest); Object.freeze(next.conflicts);
  return Object.freeze(next);
}

module.exports = { detectConflicts, withConflicts, applyClarification, renderQuestion, CONFLICT_SYSTEM, CONFLICT_SCHEMA };
