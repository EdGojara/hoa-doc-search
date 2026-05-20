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

// Parse an "Article X, Section Y.Z" / "Section Y.Z" reference out of a chunk
// of text. Returns the FIRST match, normalizing whitespace. Returns null if
// no recognizable reference appears.
//
// We try the most specific pattern first (Article + Section) then fall back
// to a bare Section. Roman numerals + decimals are both supported because
// HOA documents use both ("Article VII, Section 7.3" vs "Section 4.02").
function _extractReference(text) {
  if (!text) return null;
  const t = text.replace(/\s+/g, ' ').slice(0, 800);
  // Article X, Section Y(.Z)
  const m1 = t.match(/Article\s+([IVXLCDM]+|\d+)\s*,?\s*Section\s+(\d+(?:\.\d+)*)/i);
  if (m1) return { article: m1[1], section: m1[2], full: `Article ${m1[1]}, Section ${m1[2]}` };
  // Plain Section X(.Y)
  const m2 = t.match(/Section\s+(\d+(?:\.\d+)*)/i);
  if (m2) return { article: null, section: m2[1], full: `Section ${m2[1]}` };
  // Just an Article — last-resort
  const m3 = t.match(/Article\s+([IVXLCDM]+|\d+)/i);
  if (m3) return { article: m3[1], section: null, full: `Article ${m3[1]}` };
  return null;
}

// Tighten a chunk down to the most relevant ~280 chars for use as the quoted
// excerpt on the letter. Prefers the sentence(s) that mention the actual
// obligation language ("shall maintain", "must not", "is prohibited"). Falls
// back to the first ~280 chars if no obligation sentence is found.
function _extractQuote(text, maxLen = 280) {
  if (!text) return null;
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;

  // Try sentence-level: find a sentence containing obligation/prohibition language
  const sentences = cleaned.match(/[^.!?]+[.!?]+/g) || [];
  const obligationRe = /\b(shall|must|may not|prohibited|not permit|maintain|keep|cause to be|responsible for)\b/i;
  for (const s of sentences) {
    if (obligationRe.test(s) && s.length <= maxLen + 60) {
      return s.trim();
    }
  }

  return cleaned.slice(0, maxLen).trim() + '…';
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
    if (!Array.isArray(chunks) || chunks.length === 0) return null;

    // Prefer the highest-similarity chunk that ALSO yields a parseable
    // Article/Section reference. If none parse, fall back to the top chunk
    // and tag the reference with the document title.
    let chosen = null;
    let parsed = null;
    for (const ch of chunks) {
      if (Number(ch.similarity) < minSimilarity) continue;
      const ref = _extractReference(ch.text) || _extractReference(ch.section_heading);
      if (ref) {
        chosen = ch;
        parsed = ref;
        break;
      }
    }
    if (!chosen) {
      const top = chunks[0];
      if (Number(top.similarity) < minSimilarity) return null;
      chosen = top;
      parsed = _extractReference(top.text) || _extractReference(top.section_heading);
    }

    const referenceLabel = parsed
      ? `${parsed.full} of the ${_docKindLabel(chosen.document_title)}`
      : `the ${_docKindLabel(chosen.document_title)}`;

    return {
      reference:      referenceLabel,
      section_title:  chosen.section_heading || null,
      quote:          _extractQuote(chosen.text),
      page:           chosen.page_number || null,
      document_title: chosen.document_title || null,
      similarity:     chosen.similarity,
      source:         'auto_lookup',
    };
  } catch (err) {
    console.warn('[governing_doc_lookup] failed:', err.message);
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
