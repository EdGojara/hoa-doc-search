// ============================================================================
// lib/enforcement/governing_doc_lookup.js
// ----------------------------------------------------------------------------
// At letter-generation time, look up the actual CC&R / governing-doc section
// that authorizes enforcement of THIS specific violation category. Uses the
// unified knowledge substrate (project_unified_architecture.md) — the same
// store askEd searches, so every CC&R/Bylaws/Rules doc already ingested for
// the community is searchable here without a separate pipeline.
//
// WHY THIS EXISTS:
//   Ed's ask: "i need the system to look up what it is violating i can't put
//   every section in here." Manually populating community_enforcement_priorities
//   for every (community × category) pair doesn't scale across 30+ communities.
//   The CC&Rs are already in the substrate — read from them at letter time.
//
// HOW IT FITS WITH THE MANUAL OVERRIDE:
//   - community_enforcement_priorities (manual override): high-touch communities
//     can lock in a counsel-verified citation. Always wins when present.
//   - Auto-lookup (this file): fires when no manual override exists. Returns the
//     top semantic match from the community's CC&Rs/Bylaws/Rules and Regs.
//   - Fallback in the letter: when both above are empty, the Authority statement
//     uses a generic-but-defensible phrase naming the maintenance / architectural
//     / enforcement Articles of the Declaration.
//
// LATENCY: one embedding call (~80ms) + one RPC call (~50ms) per letter. Cheap.
// For batch generation, a small in-memory LRU keyed by (community_id, category_id)
// would amortize across letters in the same run; current implementation calls
// fresh each time and that's fine until letter volumes climb.
// ============================================================================

const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

function _openai() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// Build the search query. The phrasing matters — we want to surface the OBLIGATION
// + ENFORCEMENT POWER chunks, not arbitrary mentions of the topic. Targeting
// "the rule that requires" + "the rule that authorizes enforcement" pushes the
// right chunks to the top.
function _buildQuery(categoryLabel, categoryDescription) {
  const label = (categoryLabel || '').trim();
  const desc = (categoryDescription || '').trim();
  const subject = desc || label || 'covenant condition';
  return `What article or section of the Declaration, Bylaws, or Rules and Regulations governs the obligation to maintain or prohibit the following condition, and authorizes the Association to enforce against an owner who fails to cure: ${subject}. Cite the article and section number.`;
}

// Parse a reference out of a chunk. STRICT — we only return a result if
// we find BOTH an article AND a section together. A bare "Section 2" without
// any article context (as Ed flagged 2026-05-20) is meaningless on a letter
// because every governing doc has a Section 2; without the article it points
// to nothing useful.
//
// Returns null for ambiguous chunks → caller falls back to the inline
// section heading (which often has e.g. "ARTICLE VII MAINTENANCE OBLIGATIONS")
// or to the generic CC&R reference in the authority statement.
function _extractReference(text) {
  if (!text) return null;
  const t = text.replace(/\s+/g, ' ').slice(0, 1200);
  // Article X, Section Y(.Z) — must appear together
  const m1 = t.match(/Article\s+([IVXLCDM]+|\d+)\s*,?\s*Section\s+(\d+(?:\.\d+)*)/i);
  if (m1) return { article: m1[1], section: m1[2], full: `Article ${m1[1]}, Section ${m1[2]}` };
  // Article X followed by SECTION X.X. NAME pattern (Vantaca/HOA convention)
  // e.g. "ARTICLE VII SECTION 31. OWNER'S MAINTENANCE"
  const m2 = t.match(/Article\s+([IVXLCDM]+|\d+)[^A-Za-z]{0,8}Section\s+(\d+(?:\.\d+)*)/i);
  if (m2) return { article: m2[1], section: m2[2], full: `Article ${m2[1]}, Section ${m2[2]}` };
  // No article+section pair found — don't return a partial.
  return null;
}

// OCR-damage detector. CC&Rs scanned to image PDFs and run through bad OCR
// produce text like "perfonn" (perform), "/ /;~", "(~,?", etc. We reject
// chunks where junk characters or recognizable-misspelling patterns exceed
// a sanity threshold so the letter doesn't quote garbage at the homeowner.
function _looksOcrDamaged(text) {
  if (!text) return true;
  const s = String(text);
  if (s.length < 40) return true; // too short to be a useful quote
  // Count non-alphanumeric / non-whitespace / non-standard-punctuation chars
  const oddChars = (s.match(/[^A-Za-z0-9\s.,;:'"()\-—–§ &/]/g) || []).length;
  const oddRatio = oddChars / s.length;
  if (oddRatio > 0.05) return true;
  // Known OCR misreads (a few signal words covers most failures)
  const ocrSigs = /(perfonn|perfonned|infonn|govemed|govem|maintainence|premiseS|owner['']?S |Loi |Hie |obhgated|propenY)/i;
  if (ocrSigs.test(s)) return true;
  return false;
}

// Tighten a chunk down to the most relevant ~280 chars for use as the quoted
// excerpt on the letter. Prefers the sentence(s) that mention the actual
// obligation language ("shall maintain", "must not", "is prohibited").
// Returns null when no clean obligation sentence is found — better to print
// no quote than a fragmentary OCR-damaged one (Ed flagged garbled quotes
// 2026-05-20).
function _extractQuote(text, maxLen = 280) {
  if (!text) return null;
  const cleaned = text.replace(/\s+/g, ' ').trim();

  // Try sentence-level: find a sentence containing obligation/prohibition language
  const sentences = cleaned.match(/[^.!?]+[.!?]+/g) || [];
  const obligationRe = /\b(shall|must|may not|prohibited|not permit|maintain|keep|cause to be|responsible for)\b/i;
  for (const s of sentences) {
    if (obligationRe.test(s) && s.length >= 30 && s.length <= maxLen + 60 && !_looksOcrDamaged(s)) {
      return s.trim();
    }
  }

  // No clean obligation sentence — return null so the letter omits the quote
  // block entirely rather than printing a fragment.
  return null;
}

/**
 * Look up the CC&R section governing a violation category for a community.
 *
 * @param {Object}  args
 * @param {string}  args.communityId
 * @param {string}  args.categoryLabel        e.g., "Tree overgrowth"
 * @param {string}  [args.categoryDescription] long-form definition
 * @param {string}  [args.aiDescription]      observation text (further specificity)
 * @param {number}  [args.matchCount=4]       how many chunks to consider
 * @param {number}  [args.minSimilarity=0.72] threshold to count as a real hit
 * @returns {Promise<null|{
 *   reference: string,
 *   section_title: string|null,
 *   quote: string,
 *   page: number|null,
 *   document_title: string|null,
 *   similarity: number,
 *   source: 'auto_lookup'
 * }>}
 */
async function lookupGoverningDoc({
  communityId,
  categoryLabel,
  categoryDescription,
  aiDescription,
  matchCount = 4,
  minSimilarity = 0.72,
}) {
  try {
    if (!communityId) return null;
    const openai = _openai();
    if (!openai) return null; // no key → skip silently, letter falls back

    const query = _buildQuery(categoryLabel,
      [categoryDescription, aiDescription].filter(Boolean).join('. '));

    // Embed the query
    const embedRes = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: query.slice(0, 8000),
    });
    const embedding = embedRes.data && embedRes.data[0] && embedRes.data[0].embedding;
    if (!embedding) return null;

    // Search the substrate. Restricted to library_doc + governing_document
    // source types so we don't surface emails/ARC decisions/inspection notes
    // as governing authority.
    const { data: chunks, error } = await supabase.rpc('match_knowledge_chunks', {
      query_embedding: embedding,
      mgmt_co_id: BEDROCK_MGMT_CO_ID,
      match_count: matchCount,
      vendor_filter: null,
      source_filter: ['library_doc', 'governing_document'],
      community_filter: communityId,
      as_of_date: null,
      access_filter: null,
    });
    if (error) {
      console.warn('[governing_doc_lookup] RPC failed:', error.message);
      return null;
    }
    if (!Array.isArray(chunks) || chunks.length === 0) {
      console.log(`[governing_doc_lookup] community=${communityId} category="${categoryLabel}" → no chunks matched substrate (CC&Rs may not be ingested for this community)`);
      return null;
    }

    // Filter to chunks that meet similarity threshold AND aren't OCR-damaged.
    // We pass the survivors to Claude for citation extraction — handles old
    // CC&Rs that use "Section 4(c)", "Restriction 12", or other formats
    // outside the strict Article+Section regex.
    const candidates = chunks
      .filter((ch) => Number(ch.similarity) >= minSimilarity)
      .filter((ch) => !_looksOcrDamaged(ch.text));
    if (candidates.length === 0) {
      const reasons = chunks.map((ch) => {
        if (Number(ch.similarity) < minSimilarity) return `low-sim(${ch.similarity.toFixed(2)})`;
        if (_looksOcrDamaged(ch.text)) return `ocr-damage(${(ch.document_title || '').slice(0, 40)})`;
        return 'unknown';
      });
      console.log(`[governing_doc_lookup] community=${communityId} category="${categoryLabel}" → ${chunks.length} chunks, none passed quality filter. Reasons: ${reasons.join(', ')}`);
      return null;
    }

    // AI-driven citation extraction. Pass the top 3 candidate chunks to
    // Claude with a focused prompt and let it return a structured citation
    // matching the document's own numbering style (Article+Section, Section
    // alone, Paragraph N, Restriction X — whatever the CC&R uses).
    const top = candidates.slice(0, 3);
    const ai = await _aiExtractCitation({ categoryLabel, categoryDescription, aiDescription, chunks: top });
    if (!ai || !ai.found) {
      console.log(`[governing_doc_lookup] community=${communityId} category="${categoryLabel}" → AI extraction returned not-found from ${top.length} candidate chunks`);
      return null;
    }

    return {
      reference:      ai.reference,
      section_title:  ai.section_title || null,
      quote:          ai.quote || null,
      page:           top[0].page_number || null,
      document_title: ai.document_title || top[0].document_title || null,
      similarity:     top[0].similarity,
      source:         'auto_lookup_ai',
    };
  } catch (err) {
    console.warn('[governing_doc_lookup] failed:', err.message);
    return null;
  }
}

// AI-driven citation extraction. Given the top candidate chunks from the
// semantic search, ask Claude to identify which section of which document
// actually creates the obligation the homeowner is violating, formatted in
// the document's own numbering style. Handles old CC&Rs that use any
// convention — "Section 4(c)", "Restriction 12", "Paragraph IV.A.2", etc.
async function _aiExtractCitation({ categoryLabel, categoryDescription, aiDescription, chunks }) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const excerptsBlock = chunks.map((c, i) =>
      `[Excerpt ${i + 1} — from "${c.document_title || 'governing doc'}"${c.section_heading ? ' / heading: ' + c.section_heading : ''}]\n${(c.text || '').slice(0, 1200)}`
    ).join('\n\n---\n\n');

    const violationSummary = [categoryLabel, categoryDescription, aiDescription].filter(Boolean).join(' · ');

    const prompt = `You are helping draft an HOA covenant-violation letter. Read these excerpts from the Association's governing documents and identify the specific section that creates the obligation being violated.

VIOLATION: ${violationSummary}

EXCERPTS:
${excerptsBlock}

Return ONLY valid JSON, no prose, in this exact shape:
{
  "found": true | false,
  "reference": "the exact reference using the document's own numbering — examples: 'Section 4(c)', 'Article VII, Section 7.3', 'Restriction 12', 'Paragraph IV.A.2'. Include the article/section structure that appears in the source.",
  "document_title": "Declaration of Covenants, Conditions and Restrictions" | "Bylaws" | "Rules and Regulations" | "Architectural Guidelines" | etc. — friendly name for the homeowner, not the file name,
  "section_title": "short title from the source if present, like 'OWNER\\'S MAINTENANCE' — null if not present",
  "quote": "ONE sentence verbatim from the excerpt that states what the owner shall do or shall not do, max 280 chars. No fragmentary OCR text. null if no clean obligation sentence exists.",
  "confidence": "high" | "medium" | "low"
}

If none of the excerpts contain a section that clearly creates an obligation for this violation type, return { "found": false }. Do not invent references that aren't in the text.`;

    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = resp.content && resp.content[0] && resp.content[0].text;
    if (!text) return null;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (_) {
      return null;
    }
  } catch (err) {
    console.warn('[governing_doc_lookup] AI extraction failed:', err.message);
    return null;
  }
}

// Best-effort "what KIND of governing doc is this" — for the inline citation
// it matters whether we're pointing to the Declaration vs the Bylaws vs the
// Rules and Regulations. Document title is usually informative.
function _docKindLabel(title) {
  if (!title) return 'Declaration of Covenants, Conditions and Restrictions';
  const t = String(title).toLowerCase();
  if (t.includes('declaration') || t.includes('ccr') || t.includes('cc&r') || t.includes('cc & r')) {
    return 'Declaration of Covenants, Conditions and Restrictions';
  }
  if (t.includes('bylaw')) return 'Bylaws';
  if (t.includes('rule') || t.includes('regulation')) return 'Rules and Regulations';
  if (t.includes('design') || t.includes('guideline') || t.includes('architectural')) return 'Architectural Guidelines';
  if (t.includes('resolution') || t.includes('policy')) return 'Board Resolutions and Policies';
  return 'governing documents';
}

module.exports = { lookupGoverningDoc };
