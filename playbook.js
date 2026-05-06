// ============================================================================
// Bedrock Intelligence — Unified Playbook Retrieval Helper
//
// Replaces all per-endpoint category-filtered playbook queries with a single
// semantic search function. Every AI endpoint should use this instead of
// querying the playbook table directly.
//
// Usage:
//   const { getRelevantPlaybook, formatPlaybookContext } = require('./lib/playbook');
//
//   const entries = await getRelevantPlaybook(situationText, { matchCount: 8 });
//   const promptContext = formatPlaybookContext(entries);
//   // pass promptContext into your AI prompt
//
//   // entries also includes similarity scores for transparency UI
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DEFAULT_MATCH_COUNT = 8;
const DEFAULT_SIMILARITY_THRESHOLD = 0.0;  // no filter; tune later from data

/**
 * Embed a text query using the same model used to embed playbook entries.
 * @param {string} text
 * @returns {Promise<number[]>} 1536-dim embedding vector
 */
async function embedQuery(text) {
  if (!text || !text.trim()) {
    throw new Error('embedQuery: empty text');
  }
  const cleaned = text.replace(/\n+/g, ' ').slice(0, 8000);
  const result = await openai.embeddings.create({
    model: 'text-embedding-ada-002',
    input: cleaned
  });
  return result.data[0].embedding;
}

/**
 * Get the most relevant playbook entries for a given situation.
 *
 * Replaces the old pattern of:
 *   supabase.from('playbook').select('*').or('category.eq.X,category.eq.Y')
 *
 * Returns the top N most semantically similar ACTIVE entries based on
 * embedding cosine similarity. Categories are NOT used to filter — the
 * embedding finds what's relevant regardless of category.
 *
 * @param {string} situationText - the text to find relevant entries for
 *   (e.g. the homeowner email, the proposal data, the situation description)
 * @param {object} [options]
 * @param {number} [options.matchCount=8] - max entries to return
 * @param {number} [options.similarityThreshold=0.0] - drop matches below this
 * @returns {Promise<Array<{id, situation, response, reasoning, category, similarity}>>}
 *   Returns empty array if no situationText or on error (logged, not thrown).
 */
async function getRelevantPlaybook(situationText, options = {}) {
  const matchCount = options.matchCount || DEFAULT_MATCH_COUNT;
  const similarityThreshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;

  // No text = nothing to match against. Return empty rather than throwing —
  // callers can still proceed with no playbook context.
  if (!situationText || !situationText.trim()) {
    console.log('[playbook] getRelevantPlaybook called with empty text — returning []');
    return [];
  }

  try {
    const queryEmbedding = await embedQuery(situationText);

    const { data, error } = await supabase.rpc('match_playbook', {
      query_embedding: queryEmbedding,
      match_count: matchCount,
      similarity_threshold: similarityThreshold
    });

    if (error) {
      console.error('[playbook] match_playbook RPC error:', error.message);
      return [];
    }

    const entries = data || [];

    // Log what got matched. This is the transparency layer — if a query
    // pulls weird entries, you'll see it in the Render logs immediately.
    if (entries.length === 0) {
      console.log('[playbook] No matches found for query.');
    } else {
      console.log(`[playbook] Matched ${entries.length} entries:`);
      entries.forEach(e => {
        const preview = (e.situation || '').slice(0, 70).replace(/\n/g, ' ');
        console.log(`  [${e.id}] sim=${e.similarity.toFixed(3)} cat=${e.category || '-'} "${preview}..."`);
      });
    }

    return entries;
  } catch (err) {
    console.error('[playbook] getRelevantPlaybook failed:', err.message);
    return [];
  }
}

/**
 * Format a list of playbook entries into the prompt-ready text block that
 * gets passed to Anthropic. Matches the format the existing endpoints use,
 * so swapping in this helper doesn't change prompt structure.
 *
 * @param {Array} entries - from getRelevantPlaybook
 * @param {object} [options]
 * @param {string} [options.heading='INSTITUTIONAL GUIDELINES FROM PAST SITUATIONS']
 * @param {boolean} [options.includeSimilarity=false] - prepend sim score (rare; mainly for debugging)
 * @returns {string} prompt-ready context block, or empty string if no entries
 */
function formatPlaybookContext(entries, options = {}) {
  if (!entries || entries.length === 0) return '';

  const heading = options.heading || 'INSTITUTIONAL GUIDELINES FROM PAST SITUATIONS';
  const includeSimilarity = options.includeSimilarity || false;

  const formatted = entries.map(p => {
    const simTag = includeSimilarity ? ` [match: ${p.similarity.toFixed(2)}]` : '';
    return `SITUATION${simTag}: ${p.situation}\nAPPROACH: ${p.response}\nREASONING: ${p.reasoning || 'Not specified'}`;
  }).join('\n\n---\n\n');

  return `\n\n${heading}:\n\n${formatted}\n`;
}

/**
 * Build a small "applied playbook" summary for inclusion in API responses.
 * Lets the frontend show users which entries influenced an AI response.
 *
 * @param {Array} entries - from getRelevantPlaybook
 * @returns {Array<{id, situation_summary, category, similarity}>}
 */
function buildAppliedPlaybookSummary(entries) {
  if (!entries || entries.length === 0) return [];
  return entries.map(p => ({
    id: p.id,
    situation_summary: (p.situation || '').slice(0, 120),
    category: p.category || null,
    similarity: Number(p.similarity.toFixed(3))
  }));
}

module.exports = {
  getRelevantPlaybook,
  formatPlaybookContext,
  buildAppliedPlaybookSummary,
  embedQuery
};
