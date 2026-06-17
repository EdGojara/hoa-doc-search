// ============================================================================
// lib/hybrid_retrieval.js — single source of truth for document retrieval
// ----------------------------------------------------------------------------
// Vector + keyword + title-match hybrid retrieval over the unified `documents`
// table. Used by:
//   - /ask-ed and /ask-ed-stream (server.js)
//   - /ask-ed-chat-stream (server.js)
//   - lib/voice/reason.js (Claire's per-turn document context)
//
// One implementation, three call sites. No parallel silos — see the scar in
// CLAUDE.md ("Vector silos").
//
// Why hybrid: vector search is great for "tell me about X" / concept questions
// but routinely misses exact-fact chunks when multiple chunks in the same
// document score similarly. We hit this hard on 2026-05-22 with the Canyon
// Gate quorum question. Hybrid retrieval (vector + keyword + title-match
// fused via Reciprocal Rank Fusion) is the fix.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const { communityNameVariations } = require('./library_reindex');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ----------------------------------------------------------------------------
// Stopword list for the keyword half of hybrid retrieval. We strip these
// before running ILIKE searches so "what's the quorum at Canyon Gate" doesn't
// also match every chunk containing "the" / "at" / "is".
// ----------------------------------------------------------------------------
const HYBRID_STOPWORDS = new Set([
  'a','an','and','are','as','at','be','been','being','but','by','can','could',
  'did','do','does','for','from','had','has','have','having','he','her','here',
  'his','how','i','if','in','into','is','it','its','just','many','me','more',
  'most','much','my','no','not','now','of','on','one','only','or','our','out',
  'over','same','she','should','so','some','such','than','that','the','their',
  'them','then','there','these','they','this','those','to','too','under','up',
  'us','very','was','we','were','what','whats','when','where','which','while',
  'who','why','will','with','would','you','your','yours',
]);

// Domain anchor tokens — when present in the text, these always survive
// keyword extraction even if other tokens crowd them out by position.
// Without this, a long-form homeowner email that opens with greeting +
// address ("Hello I am a homeowner at 5523 Elderberry Arbor...") consumed
// the first 8 keyword slots before words like "declaration", "section",
// "vehicle" were ever seen -- so title-match couldn't find the Declaration
// of Covenants for a Section 3.3 question. Ed 2026-06-16.
const DOMAIN_ANCHOR_TOKENS = new Set([
  'declaration', 'declarations', 'covenant', 'covenants', 'ccr', 'ccrs',
  'bylaw', 'bylaws', 'bylaw', 'article', 'articles', 'section', 'sections',
  'amendment', 'amendments', 'rule', 'rules', 'regulation', 'regulations',
  'guideline', 'guidelines', 'restriction', 'restrictions',
  'fine', 'fines', 'violation', 'violations', 'enforcement', 'lien',
  'assessment', 'assessments', 'quorum', 'meeting', 'meetings',
  'variance', 'easement', 'setback', 'roof', 'fence', 'pool',
  'vehicle', 'parking',
]);

function extractKeywords(text) {
  if (!text) return [];
  const tokens = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9§%$\s.-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((t) => t && t.length > 2 && !HYBRID_STOPWORDS.has(t));
  const unique = Array.from(new Set(tokens));
  // Domain anchors get pulled to the front so they always survive the cap,
  // even if they appear deep in a long-form homeowner email.
  const anchors = unique.filter((t) => DOMAIN_ANCHOR_TOKENS.has(t));
  const rest = unique.filter((t) => !DOMAIN_ANCHOR_TOKENS.has(t));
  return [...anchors, ...rest].slice(0, 20);
}

const HYBRID_K = 18;
const VECTOR_K = 15;
const KEYWORD_K = 10;
const RRF_C = 60;
// Per-doc chunk fetch on a title match. Bumped from 8 to 25 on 2026-06-03
// because the askEd org-meeting bug surfaced when a 100+ page bylaws PDF
// would have its TOC pages returned as the first 8 chunks (table order ≈
// document order ≈ TOC first), so substantive body chunks never even
// entered the candidate pool to compete in the RRF merge. 25 gives the
// body real coverage on most docs without blowing up token budget.
const TITLE_MATCH_PER_DOC = 25;
const TOC_DERANK_FACTOR = 0.15;

// ----------------------------------------------------------------------------
// isLikelyTOC — heuristic to identify table-of-contents chunks so we can
// de-rank them in the merge step. Without this, vector search ranks TOC
// chunks above body content because TOCs pack section keywords densely in a
// small token window ("ORGANIZATION MEETING ........ 8" is 100% keyword
// density). The askEd Canyon Gate org-meeting answer 2026-06-03 returned
// 18 chunks, all of them TOC — model correctly reported "section exists,
// body not in context," which read like a broken tool.
//
// Three signals (any one triggers):
//   - Dot leaders ("....." followed by a digit) — the canonical TOC layout
//   - More than half the lines end in a 1-3 digit page number
//   - High Section/Article reference density (>4% of words are section refs)
// ----------------------------------------------------------------------------
function isLikelyTOC(content) {
  if (!content) return false;
  const text = String(content);

  const dotLeaderHits = (text.match(/\.{4,}\s*\d/g) || []).length;
  if (dotLeaderHits >= 3) return true;

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length >= 5) {
    const pageNumberLines = lines.filter((l) => /\s\d{1,3}\s*$/.test(l)).length;
    if (pageNumberLines >= 5 && pageNumberLines / lines.length >= 0.5) return true;
  }

  const sectionHits = (text.match(/\b(?:Section|Article)\s+[\dIVXLCDM]/gi) || []).length;
  const wordCount = (text.match(/\S+/g) || []).length;
  if (wordCount > 0 && sectionHits >= 5 && sectionHits / wordCount > 0.04) return true;

  return false;
}

async function getRelevantChunks(text, community) {
  // Ed 2026-06-04: 'General' was previously included as a universal
  // fallback bucket, meaning EVERY query (regardless of community) also
  // searched docs tagged 'General'. That made any orphan doc (uploaded
  // without a community_id, or with a broken FK) pollute every community's
  // results — Lakes of Pine Forest insurance docs surfacing on Quail Ridge
  // queries, the mis-tagged Quail Ridge Declaration competing with itself,
  // etc. Now the fallback is 'Law' only (statutes are legitimately cross-
  // community). Orphan docs need to be re-tagged to their actual community
  // via the Documents tab's "General orphans" diagnostic (see new endpoint).
  const communities = ['Law', ...communityNameVariations(community)];

  // --- Vector half ---
  const vectorPromise = (async () => {
    try {
      const embeddingResponse = await openai.embeddings.create({
        model: 'text-embedding-ada-002',
        input: text.replace(/\n/g, ' ').slice(0, 8000),
      });
      const queryEmbedding = embeddingResponse.data[0].embedding;
      const { data: chunks, error } = await supabase.rpc('match_documents', {
        query_embedding: queryEmbedding,
        match_count: VECTOR_K,
        filter_communities: communities,
      });
      if (error) {
        console.warn('[hybrid-retrieval] vector half failed:', error.message);
        return [];
      }
      return chunks || [];
    } catch (err) {
      console.warn('[hybrid-retrieval] vector half threw:', err.message);
      return [];
    }
  })();

  // --- Title-match half ---
  const titleMatchPromise = (async () => {
    const keywords = extractKeywords(text);
    if (keywords.length === 0) return [];
    try {
      // Push community filter INTO the SQL query, not the JS post-filter.
      // Previously: SQL returned the first 30 matches across ALL communities,
      // then JS filtered down to the requested community -- so if 30 docs
      // matched "declaration" or "section" across the portfolio, the
      // requested community's Declaration could be silently starved out
      // before the JS filter ever saw it. Same scar as the 1000-row
      // PostgREST truncation: never trust a JS post-filter to recover from
      // a SQL .limit() that ran without the community filter. Ed 2026-06-16.
      const { data: commRows } = await supabase
        .from('communities')
        .select('id, name')
        .in('name', communities);
      const communityIds = (commRows || []).map((c) => c.id);
      if (communityIds.length === 0) return [];

      const titleOrFilter = keywords.map((kw) => `title.ilike.%${kw.replace(/[%_]/g, '')}%`).join(',');
      const { data: docs, error } = await supabase
        .from('library_documents')
        .select('id, title, communities:community_id(name)')
        .in('community_id', communityIds)
        .or(titleOrFilter)
        .limit(30);
      if (error) {
        console.warn('[hybrid-retrieval] title-match half failed:', error.message);
        return [];
      }
      // Belt-and-suspenders JS filter still runs in case the join returned
      // something unexpected. With the SQL-side filter doing the real work
      // this should never drop anything.
      const communityLower = new Set(communities.map((c) => String(c || '').toLowerCase()));
      const eligibleDocs = (docs || []).filter((d) => {
        const cname = String(d.communities?.name || '').toLowerCase();
        return communityLower.has(cname);
      });
      if (eligibleDocs.length === 0) return [];

      const communityTokens = new Set(
        (community || '').toLowerCase().split(/\s+/).filter((t) => t && t.length > 2)
      );
      const discriminatingKeywords = keywords.filter((kw) => !communityTokens.has(kw));

      const scoredDocs = eligibleDocs.map((d) => {
        const titleLower = String(d.title || '').toLowerCase();
        const discMatches = discriminatingKeywords.filter((kw) => titleLower.includes(kw)).length;
        const commMatches = keywords.filter((kw) => communityTokens.has(kw) && titleLower.includes(kw)).length;
        return { doc: d, score: 3 * discMatches + commMatches };
      }).sort((a, b) => b.score - a.score);

      const chunkResults = await Promise.all(scoredDocs.map(async ({ doc }) => {
        // Two link paths between library_documents and documents chunks:
        //   - New ingestion path: chunk's metadata.library_document_id = doc.id
        //   - Legacy promotion path: chunk's SQL column migrated_to_library_id = doc.id
        //
        // ALSO: when the doc is large (Waterview's Declaration is 109 chunks),
        // the first 25 chunks by row order are TOC pages -- never the answer.
        // Prefer chunks whose CONTENT contains query keywords; only fall back
        // to raw row order to fill any unused slots. This matches the
        // 2026-06-03 askEd org-meeting bug fix at the per-doc level: TOC
        // chunks were structurally crowding out body chunks because they came
        // first in document order. The 3x title boost was landing on TOC
        // pages while Section 3.3 body chunks never entered the candidate
        // pool. Ed 2026-06-16.
        const discriminating = discriminatingKeywords
          .map((kw) => kw.replace(/[%_]/g, ''))
          .filter((kw) => kw.length >= 3)
          .slice(0, 12);
        const keywordOrFilter = discriminating.length
          ? discriminating.map((kw) => `content.ilike.%${kw}%`).join(',')
          : null;
        const buildKeywordQ = (linkField, isMetaPath) => {
          let q = supabase.from('documents').select('content, metadata');
          q = isMetaPath
            ? q.eq('metadata->>library_document_id', doc.id)
            : q.eq('migrated_to_library_id', doc.id);
          if (keywordOrFilter) q = q.or(keywordOrFilter);
          return q.limit(TITLE_MATCH_PER_DOC);
        };
        const buildAnyQ = (isMetaPath) => {
          let q = supabase.from('documents').select('content, metadata');
          q = isMetaPath
            ? q.eq('metadata->>library_document_id', doc.id)
            : q.eq('migrated_to_library_id', doc.id);
          return q.limit(TITLE_MATCH_PER_DOC);
        };
        const queries = [];
        if (keywordOrFilter) {
          queries.push(buildKeywordQ(null, true));   // keyword + meta
          queries.push(buildKeywordQ(null, false));  // keyword + migrated
        }
        queries.push(buildAnyQ(true));    // fallback any + meta
        queries.push(buildAnyQ(false));   // fallback any + migrated
        const results = await Promise.all(queries);
        results.forEach((r, i) => {
          if (r.error) console.warn(`[hybrid-retrieval] title-match chunks query[${i}] for "${doc.title}" failed:`, r.error.message);
        });
        // Order matters -- keyword-matching chunks first, raw chunks as
        // filler. Dedupe by content prefix so the same chunk doesn't take
        // two slots.
        const combined = results.flatMap((r) => r.data || []);
        const seen = new Set();
        const deduped = combined.filter((c) => {
          const key = (c.content || '').slice(0, 240);
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        return deduped.slice(0, TITLE_MATCH_PER_DOC);
      }));
      const flat = chunkResults.flat();
      console.log(`[hybrid-retrieval] title-match found ${eligibleDocs.length} docs (top: "${scoredDocs[0]?.doc?.title}"), ${flat.length} chunks`);
      return flat;
    } catch (err) {
      console.warn('[hybrid-retrieval] title-match half threw:', err.message);
      return [];
    }
  })();

  // --- Keyword half ---
  const keywordPromise = (async () => {
    const keywords = extractKeywords(text);
    if (keywords.length === 0) return [];
    const communityLower = new Set(communities.map((c) => String(c || '').toLowerCase()));
    // Push the community filter INTO the SQL query (not the JS post-filter).
    // Without this, .limit(500) gets filled with rows from heavy-volume
    // communities (e.g., LPF has 788 chunks) BEFORE rows from the target
    // community get fetched, and the JS filter then drops them — silent
    // cross-community starvation for the target community. CLAUDE.md
    // documents this exact scar at within-document level; same pattern
    // bites at the community level. We use the PostgREST .in() operator
    // against the JSONB virtual column metadata->>community.
    const communityValues = communities
      .filter((c) => c != null && c !== '')
      .map((c) => String(c));
    try {
      const perKwResults = await Promise.all(
        keywords.map(async (kw) => {
          let query = supabase
            .from('documents')
            .select('content, metadata')
            .ilike('content', `%${kw.replace(/[%_]/g, '')}%`);
          if (communityValues.length > 0) {
            query = query.in('metadata->>community', communityValues);
          }
          const { data, error } = await query.limit(500);
          if (error) {
            console.warn(`[hybrid-retrieval] keyword "${kw}" failed:`, error.message);
            return { kw, rows: [] };
          }
          // Belt-and-suspenders: still apply the JS filter in case the
          // jsonb operator missed any edge cases (e.g., case mismatches).
          const rows = (data || []).filter((row) => {
            const c = String(row.metadata?.community || '').toLowerCase();
            return communityLower.has(c);
          });
          return { kw, rows };
        })
      );

      const byKey = new Map();
      const keyOf = (row) => `${(row.content || '').slice(0, 200)}::${row.metadata?.filename || ''}`;
      for (const { kw, rows } of perKwResults) {
        for (const row of rows) {
          const k = keyOf(row);
          const ex = byKey.get(k);
          if (ex) { ex.matchedKeywords.add(kw); }
          else byKey.set(k, { row, matchedKeywords: new Set([kw]) });
        }
      }
      for (const entry of byKey.values()) {
        const fname = String(entry.row.metadata?.filename || '').toLowerCase();
        const titleHits = keywords.filter((kw) => fname.includes(kw));
        entry.score = entry.matchedKeywords.size + 2 * titleHits.length;
      }

      const ranked = Array.from(byKey.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, KEYWORD_K);

      return ranked.map((r) => r.row);
    } catch (err) {
      console.warn('[hybrid-retrieval] keyword half threw:', err.message);
      return [];
    }
  })();

  const [vectorChunks, keywordChunks, titleMatchChunks] = await Promise.all([
    vectorPromise, keywordPromise, titleMatchPromise,
  ]);

  // --- Reciprocal Rank Fusion merge ---
  const byKey = new Map();
  const keyOf = (row) => `${(row.content || '').slice(0, 200)}::${row.metadata?.filename || ''}`;

  titleMatchChunks.forEach((row, i) => {
    const k = keyOf(row);
    const score = 3 / (RRF_C + i + 1);
    const existing = byKey.get(k);
    if (existing) { existing.score += score; existing.sources.add('title'); }
    else byKey.set(k, { row, score, sources: new Set(['title']) });
  });
  vectorChunks.forEach((row, i) => {
    const k = keyOf(row);
    const score = 1 / (RRF_C + i + 1);
    const existing = byKey.get(k);
    if (existing) { existing.score += score; existing.sources.add('vector'); }
    else byKey.set(k, { row, score, sources: new Set(['vector']) });
  });
  keywordChunks.forEach((row, i) => {
    const k = keyOf(row);
    const score = 1 / (RRF_C + i + 1);
    const existing = byKey.get(k);
    if (existing) { existing.score += score; existing.sources.add('keyword'); }
    else byKey.set(k, { row, score, sources: new Set(['keyword']) });
  });

  // TOC de-rank: a chunk that looks like a table of contents loses 85% of
  // its score. Body chunks naturally rise to the top. TOC chunks remain as
  // a fallback if a doc has nothing but TOC pages (rare). See isLikelyTOC.
  let derankedCount = 0;
  for (const entry of byKey.values()) {
    if (isLikelyTOC(entry.row.content)) {
      entry.score *= TOC_DERANK_FACTOR;
      entry.sources.add('toc-derank');
      derankedCount += 1;
    }
  }

  // Legal-update enrichment. Any chunk whose library_document_id has a
  // legal_updates sidecar gets its breadcrumb header enriched with source
  // publisher + date + topics + key holding — so the model sees a
  // citation-ready label and can cite it verbatim. Ed 2026-06-04 build.
  // Done in a single batched query for all retrieved library_document_ids
  // so retrieval stays under one round-trip.
  const libDocIds = Array.from(new Set(
    Array.from(byKey.values())
      .map((e) => e.row?.metadata?.library_document_id)
      .filter(Boolean)
  ));
  const legalByLibDocId = new Map();
  if (libDocIds.length > 0) {
    try {
      const { data: legalRows, error: legalErr } = await supabase
        .from('legal_updates')
        .select('id, library_document_id, source_publisher, source_date, jurisdiction, topics, key_holding, status')
        .in('library_document_id', libDocIds);
      if (legalErr) {
        console.warn('[hybrid-retrieval] legal-updates sidecar fetch failed:', legalErr.message);
      } else {
        for (const lr of (legalRows || [])) {
          legalByLibDocId.set(lr.library_document_id, lr);
        }
      }
    } catch (e) {
      console.warn('[hybrid-retrieval] legal-updates sidecar threw:', e.message);
    }
  }

  const merged = Array.from(byKey.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, HYBRID_K);

  const dualHits = merged.filter((m) => m.sources.size >= 2).length;
  const survivingTOC = merged.filter((m) => m.sources.has('toc-derank')).length;
  console.log(`[hybrid-retrieval] community="${community || '(all)'}" vector=${vectorChunks.length} keyword=${keywordChunks.length} title=${titleMatchChunks.length} merged=${merged.length} multi-source=${dualHits} toc-deranked=${derankedCount} toc-in-final=${survivingTOC}`);

  return merged.map(({ row, sources }) => {
    const ocrTag = row.metadata?.ocr ? " — OCR'd scan, may have minor errors" : '';
    // toc-derank is an internal merge-step signal — don't surface to the
    // UI as a source pill ("matched vector+toc-derank" reads as broken).
    const sources_arr = [...sources].filter((s) => s !== 'toc-derank');
    const sourceTag = sources_arr.length >= 2 ? ` — matched ${sources_arr.join('+')}` : '';
    // Structure breadcrumb (Ed 2026-06-04). When the indexer detected an
    // Article/Section header upstream of this chunk, surface it in the
    // header so the model can cite "Article VII / Section 7.2 / Commercial
    // Use Prohibited" verbatim instead of writing "Section [X] of Article
    // [X]" placeholders. Gracefully empty when no breadcrumb data exists
    // (legacy chunks, non-governing-doc types, formats that evaded the
    // pattern). NEVER include the chunk's content text here — header only.
    const breadcrumb = (() => {
      const parts = [];
      if (row.metadata?.article) {
        const heading = row.metadata.article_heading;
        parts.push(heading ? `Article ${row.metadata.article} — ${heading}` : `Article ${row.metadata.article}`);
      }
      if (row.metadata?.section) {
        const heading = row.metadata.section_heading;
        parts.push(heading ? `Section ${row.metadata.section} — ${heading}` : `Section ${row.metadata.section}`);
      }
      return parts.length > 0 ? ` / ${parts.join(' / ')}` : '';
    })();
    // Legal-update tag — if this chunk's library doc has a legal_updates
    // sidecar row, surface source + date + key holding in the header so
    // the model has a citation-ready label. Status is also surfaced so
    // the model knows whether this is current guidance or superseded.
    const legalTag = (() => {
      const lr = legalByLibDocId.get(row.metadata?.library_document_id);
      if (!lr) return '';
      const date = lr.source_date ? ` · ${lr.source_date}` : '';
      const statusFlag = lr.status === 'current' ? '' : ` · ⚠ ${lr.status.toUpperCase()}`;
      const topicList = Array.isArray(lr.topics) && lr.topics.length > 0 ? ` · topics: ${lr.topics.join(', ')}` : '';
      const holding = lr.key_holding ? ` — "${lr.key_holding.slice(0, 200)}"` : '';
      return ` · LEGAL UPDATE: ${lr.source_publisher}${date}${topicList}${statusFlag}${holding}`;
    })();
    return `[From: ${row.metadata?.filename} - ${row.metadata?.community}${breadcrumb}${legalTag}${ocrTag}${sourceTag}]\n${row.content}`;
  }).join('\n\n---\n\n');
}

// ----------------------------------------------------------------------------
// getRelevantChunksWithSources — same retrieval as getRelevantChunks but
// returns BOTH the prompt-context string AND a structured source list so
// the askEd UI can show the user which documents were actually consulted.
//
// Returns: { context: string, sources: [{
//   filename, community, chunk_count, sources: ['vector','title','keyword'],
//   ocr: bool, library_document_id?
// }] }
//
// Existing getRelevantChunks stays untouched (5+ callers depend on its
// current string return shape). New callers that want trust-at-point-of-use
// citations should use this function.
// ----------------------------------------------------------------------------
async function getRelevantChunksWithSources(text, community) {
  // Build the same merged set the original function produces, then return
  // both the prompt-context string AND a dedup'd source list. We duplicate
  // a small amount of retrieval logic rather than refactor the existing
  // function — keeps blast radius zero on the proven path.
  const tokens = extractKeywords(text);
  // Use the existing function for the heavy lifting; it already does the
  // 3-way hybrid retrieval + RRF merge + community-name fan-out. Calling it
  // means we get all future bug fixes / tuning for free.
  const context = await getRelevantChunks(text, community);

  // Parse the [From: filename - community — matched X+Y] header lines from
  // the context string to derive the source list. This avoids a second
  // round of retrieval — same merged set, no extra DB load.
  const sources = new Map(); // key = filename — dedup multiple chunks per doc
  const headerRe = /^\[From: (.+?) - (.+?)(?: — OCR'd[^\]]*)?(?: — matched ([^\]]+))?\]/gm;
  let m;
  while ((m = headerRe.exec(context)) !== null) {
    const filename = m[1].trim();
    const commName = m[2].trim();
    const matchSources = (m[3] || '').split('+').filter(Boolean);
    const isOcr = / — OCR'd/.test(m[0]);
    const key = filename;
    const existing = sources.get(key);
    if (existing) {
      existing.chunk_count++;
      matchSources.forEach((s) => existing.sources.add(s));
    } else {
      sources.set(key, {
        filename,
        community: commName,
        chunk_count: 1,
        sources: new Set(matchSources),
        ocr: isOcr,
      });
    }
  }

  return {
    context,
    sources: Array.from(sources.values()).map((s) => ({
      filename: s.filename,
      community: s.community,
      chunk_count: s.chunk_count,
      sources: [...s.sources],
      ocr: s.ocr,
    })),
  };
}

module.exports = {
  getRelevantChunks,
  getRelevantChunksWithSources,
  extractKeywords,
  HYBRID_STOPWORDS,
};
