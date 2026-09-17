// ============================================================================
// lib/team/grounding.js  (Ed 2026-09-17)
// ----------------------------------------------------------------------------
// "Receipts" for the AI team. When a teammate drafts a reply that makes factual
// claims about source material (attached proposals/PDFs, account data, governing
// docs), this produces two things a human reviewer can see BEFORE approving:
//
//   Layer 1 — self-grounding (auditability): every key claim tagged fact /
//     recommendation / gap, facts carry a source pointer, gaps are flagged
//     instead of filled. Makes "how does she know this" visible.
//
//   Layer 2 — independent verification (accuracy): an ADVERSARIAL re-check of
//     the hard, checkable numbers (counts, dollar totals, dates, quantities)
//     directly against the source documents, WITHOUT trusting the draft's own
//     citation. This is the layer that catches a confident miscount — e.g. a
//     draft saying "18 cameras" when the proposal supports 27 — because a model
//     that miscounts will also confidently cite the right page for its wrong
//     number (the "never let a record cite itself" scar). Re-derive, don't trust.
//
// Why this shape (Ed 2026-09-17, on the iTech proposal review): Amanda's analysis
// was strong but stated a wrong camera count with the same confidence as the
// correct facts, and it only got caught by a second human review. For an AI
// manager we can eventually let run, the missing piece is not analysis quality,
// it is showing how it knows a fact and flagging what it could not verify.
//
// Best-effort by contract: any failure returns null for that layer and NEVER
// throws, so grounding can never break the underlying draft. The human gate
// stays — this informs the approve/edit decision, it does not auto-send.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const MODEL = 'claude-sonnet-4-5';

function _client() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// Tolerant JSON extraction from a model reply (handles ```json fences / prose).
function _parseJson(raw) {
  if (!raw) return null;
  let t = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
  try { return JSON.parse(t); } catch (_) {}
  // Fall back to the first {...} block.
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}

// Build the user content array: the instruction text, the draft, any textual
// source context, then the source documents/images as real content blocks so
// the model READS them (vision), not a summary.
function _content(promptText, draftBody, sourceText, sourceBlocks) {
  const parts = [];
  let text = promptText + '\n\n=== THE DRAFT REPLY (under review) ===\n' + String(draftBody || '');
  if (sourceText && String(sourceText).trim()) {
    text += '\n\n=== TEXT CONTEXT THE DRAFT WAS GIVEN ===\n' + String(sourceText).slice(0, 20000);
  }
  if (sourceBlocks && sourceBlocks.length) {
    text += '\n\n=== SOURCE DOCUMENTS ARE ATTACHED BELOW — verify against these ===';
  }
  parts.push({ type: 'text', text });
  for (const b of (sourceBlocks || [])) parts.push(b);
  return parts;
}

// ---------------------------------------------------------------------------
// Layer 1 — self-grounding record.
// ---------------------------------------------------------------------------
const GROUNDING_SYS = `You audit a drafted reply for a human reviewer. You separate what the draft can back up from what it cannot, so the reviewer can trust the approve/edit decision instead of taking the draft on faith.

Return STRICT JSON, no code fences:
{"claims":[
  {"statement":"<a specific claim the draft makes, quoted or tightly paraphrased>",
   "type":"fact" | "recommendation" | "gap",
   "source":"<for a fact: where it is supported — document name and page/section if visible, or which context field. null for recommendation/gap>",
   "confidence":"verified" | "uncertain" | "unverifiable"}
]}

Rules:
- "fact": the draft states it as true and it IS supported by the SOURCE DOCUMENTS or TEXT CONTEXT. Cite where. confidence "verified" if you can point to it, "uncertain" if it is implied but not explicit.
- "recommendation": the draft's own judgment or advice ("I would ask them to..."). source null.
- "gap": the draft states as fact something you CANNOT find in the sources, or the draft itself says a value is not provided. confidence "unverifiable". These are the ones the reviewer most needs to see.
- Cover the load-bearing claims (numbers, scope, coverage, contract terms, prices, dates). Do not pad with trivia.
- Judge only against what you were given. If no source material was provided, say so by marking supported-looking claims "uncertain" rather than inventing a citation.`;

async function buildGroundingRecord({ draftBody, sourceText = '', sourceBlocks = [] }) {
  const anthropic = _client();
  if (!anthropic || !draftBody) return null;
  try {
    const resp = await anthropic.messages.create({
      model: MODEL, max_tokens: 1500, system: GROUNDING_SYS,
      messages: [{ role: 'user', content: _content('Audit this draft now.', draftBody, sourceText, sourceBlocks) }],
    });
    const raw = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const j = _parseJson(raw);
    if (!j || !Array.isArray(j.claims)) return null;
    const claims = j.claims
      .filter((c) => c && c.statement)
      .map((c) => ({
        statement: String(c.statement).slice(0, 400),
        type: ['fact', 'recommendation', 'gap'].includes(c.type) ? c.type : 'fact',
        source: c.source ? String(c.source).slice(0, 200) : null,
        confidence: ['verified', 'uncertain', 'unverifiable'].includes(c.confidence) ? c.confidence : 'uncertain',
      }));
    if (!claims.length) return null;
    return {
      claims,
      counts: {
        facts: claims.filter((c) => c.type === 'fact').length,
        recommendations: claims.filter((c) => c.type === 'recommendation').length,
        gaps: claims.filter((c) => c.type === 'gap').length,
      },
    };
  } catch (e) { console.warn('[grounding] buildGroundingRecord failed:', e.message); return null; }
}

// ---------------------------------------------------------------------------
// Layer 2 — independent verification of the hard numbers.
// ---------------------------------------------------------------------------
const VERIFY_SYS = `You are an adversarial fact-checker for a draft that is about to go to a board. DO NOT TRUST THE DRAFT. Your job is to catch a confident wrong number before it is sent.

From the draft, find every CHECKABLE quantitative claim: counts (e.g. number of cameras), dollar amounts and totals, dates, terms/durations, quantities, and any fact the draft attributes to a document. For EACH one, determine the correct value YOURSELF, only from the SOURCE DOCUMENTS / TEXT CONTEXT provided. Recount and re-add from the source — do not assume the draft's number is right. Then compare.

Return STRICT JSON, no code fences:
{"claims":[
  {"claim":"<what the draft asserts>",
   "draft_value":"<the value as the draft states it>",
   "source_value":"<the value you derive from the source, or 'not stated in source'>",
   "status":"match" | "mismatch" | "unverifiable",
   "where":"<document + page/section you checked, or null>",
   "note":"<one line: how you derived it, or why it can't be verified>"}
]}

Rules:
- "match": your independently derived value equals the draft's.
- "mismatch": they differ — this is the important one. Show both values.
- "unverifiable": the source does not contain what's needed to check it (e.g. a retention period the proposal never states). Not a mismatch, but the reviewer must know it wasn't confirmed.
- Only include claims that are actually checkable against the sources. Skip pure opinions/recommendations.
- Be exact with arithmetic and counts. If the draft says a system totals N of something, reconstruct that total from the source line items and report what you actually get.
- "source_value" must be your final derived value for the SAME quantity the draft is stating. If the draft counts cameras, source_value is your camera count — not a different but related number (e.g. a license count). Put the step-by-step derivation in "note" and the single corrected figure in "source_value", and make sure they agree.
- If NO source material was provided, return every checkable claim with status "unverifiable" and note "no source document to check against".`;

async function verifyClaims({ draftBody, sourceText = '', sourceBlocks = [] }) {
  const anthropic = _client();
  if (!anthropic || !draftBody) return null;
  try {
    const resp = await anthropic.messages.create({
      model: MODEL, max_tokens: 2000, system: VERIFY_SYS,
      messages: [{ role: 'user', content: _content('Fact-check this draft now.', draftBody, sourceText, sourceBlocks) }],
    });
    const raw = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const j = _parseJson(raw);
    if (!j || !Array.isArray(j.claims)) return null;
    const claims = j.claims
      .filter((c) => c && (c.claim || c.draft_value))
      .map((c) => ({
        claim: String(c.claim || '').slice(0, 300),
        draft_value: c.draft_value != null ? String(c.draft_value).slice(0, 120) : null,
        source_value: c.source_value != null ? String(c.source_value).slice(0, 160) : null,
        status: ['match', 'mismatch', 'unverifiable'].includes(c.status) ? c.status : 'unverifiable',
        where: c.where ? String(c.where).slice(0, 160) : null,
        note: c.note ? String(c.note).slice(0, 300) : null,
      }));
    const mismatches = claims.filter((c) => c.status === 'mismatch');
    const unverifiable = claims.filter((c) => c.status === 'unverifiable');
    return {
      claims,
      ok: mismatches.length === 0,
      counts: { checked: claims.length, matches: claims.filter((c) => c.status === 'match').length, mismatches: mismatches.length, unverifiable: unverifiable.length },
    };
  } catch (e) { console.warn('[grounding] verifyClaims failed:', e.message); return null; }
}

// Run both layers in parallel. Returns { grounding, verification } — either may
// be null on failure. Never throws.
async function groundAndVerify(opts = {}) {
  const [grounding, verification] = await Promise.all([
    buildGroundingRecord(opts).catch(() => null),
    verifyClaims(opts).catch(() => null),
  ]);
  return { grounding, verification };
}

module.exports = { buildGroundingRecord, verifyClaims, groundAndVerify };
