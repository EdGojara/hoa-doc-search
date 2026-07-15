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

// ----------------------------------------------------------------------------
// Situation -> governing-doc CONCEPT expansion. A member describes a REAL-WORLD
// condition ("water leak, algae on the sidewalk, make them fix it") but the
// enforceable provision uses domain vocabulary ("Lot and Building Maintenance,
// good repair, nuisance"). The keyword + title halves can't bridge that (no
// shared words) and vector alone ranks the provision too low, so the section
// that answers the question never surfaces. Appending the likely provision
// concepts lets all three halves find it. Additive + cost-free (no LLM call):
// only fires when a situation trigger is present; a query with no trigger is
// unchanged. Ed 2026-07-01 (Waterview leak/Section 3.12 miss).
// ----------------------------------------------------------------------------
const CONCEPT_EXPANSIONS = [
  { on: /leak|water|flood|drain|algae|mold|mildew|standing water|puddl|erosion|sewage/i, add: 'property maintenance good repair condition nuisance drainage sanitary' },
  { on: /weed|grass|lawn|overgrow|unmow|yard|landscap/i, add: 'maintenance weeds grass sanitary lot condition attractive' },
  { on: /trash|garbage|debris|junk|rubbish|dump|refuse/i, add: 'nuisance trash refuse sanitary storage maintenance' },
  { on: /fence|paint|roof|siding|brick|wall|garage door|window|rot|peel|fad|stucco|driveway/i, add: 'maintenance good repair condition improvements exterior building' },
  { on: /noise|party|loud|barking|odor|smell|light/i, add: 'nuisance offensive detrimental disturbance annoyance' },
  { on: /park|vehicle|\brv\b|boat|trailer|inoperable|junk car|commercial/i, add: 'vehicle parking storage nuisance prohibited use' },
  { on: /pet|dog|animal|livestock|chicken/i, add: 'pets animals nuisance prohibited use' },
  { on: /enforce|violation|remedy|cure|comply|notice|restrict/i, add: 'enforcement maintenance nuisance restriction covenant declaration use' },
];
// Remove the community's own name from a query. The community is already a hard
// scoping filter, so its name is pure noise in every retrieval half.
function stripCommunityName(text, community) {
  let out = String(text || '');
  for (const tok of String(community || '').split(/\s+/).filter((t) => t.length > 2)) {
    out = out.replace(new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), ' ');
  }
  return out.replace(/[ \t]+/g, ' ');
}

function expandQueryConcepts(text, community) {
  if (!text) return text;
  // The COMMUNITY NAME is not a symptom — strip it before testing triggers.
  // Scar (Ed 2026-07-14): "Waterview" contains "water", so the leak/flood/drain
  // rule fired on EVERY Waterview Estates question (1,171 homes), appending
  // "property maintenance good repair condition nuisance drainage sanitary" to
  // a clubhouse-capacity question. That polluted the vector embedding AND made
  // "condition" title-match "Declaration of Covenants, CONDITIONS and
  // Restrictions" — so the Declaration buried the Clubhouse Agreement and
  // Claire told a homeowner there was no capacity limit when the doc says 50.
  // Generalizes to any community whose name embeds a trigger (Parkview -> park,
  // Creekside -> creek, Lakes of Pine Forest -> lake).
  let probe = String(text);
  for (const tok of String(community || '').split(/\s+/).filter((t) => t.length > 2)) {
    probe = probe.replace(new RegExp(tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  }
  const adds = [];
  for (const c of CONCEPT_EXPANSIONS) if (c.on.test(probe)) adds.push(c.add);
  if (!adds.length) return text;
  const concepts = Array.from(new Set(adds.join(' ').split(/\s+/)));
  return `${text}\n\n[relevant governing-doc concepts: ${concepts.join(' ')}]`;
}

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
// Per-doc chunk fetch on a title match. Bumped 8 -> 25 on 2026-06-03 after
// the askEd org-meeting bug (TOC chunks crowding out body); bumped 25 -> 60
// on 2026-06-16 after the Section 3.3 question on Waterview's 109-chunk
// Declaration -- the first 25 chunks were still TOC + early sections, with
// Section 3.3 body chunks deep enough in the doc to be cropped out. 60
// pulls enough that body chunks reliably enter the candidate pool; RRF
// then ranks them against keyword and vector halves on equal footing.
// Token cost is bounded -- only matched docs hit this path, and chunks are
// later trimmed to HYBRID_K (18) by the merge.
const TITLE_MATCH_PER_DOC = 60;
// Max DOCS the title-match half will pull chunks for. With TITLE_MATCH_PER_DOC=60,
// an unbounded fan-out let one loose query (25 docs) dump 502 chunks into the
// merge and bury the one doc that actually answered the question. Title-match is
// meant to be a precise signal ("the doc literally titled about this"), so a
// handful of docs is the right ceiling. (Ed 2026-07-14.)
const TITLE_MATCH_MAX_DOCS = 6;
const TOC_DERANK_FACTOR = 0.15;

// Amendment supersession factors (migration 228).
//
// SECTION_SUPERSEDED_DERANK = chunk's section is literally named in an
//   amendment's amended_sections array. Severe penalty (0.10) -- the section
//   has been replaced; the AI should almost never see the original text.
//
// SUPERSEDED_BY_AMENDMENT_DERANK = parent doc has a whole-doc supersession
//   (amendment has no specific amended_sections). Strong penalty (0.20) but
//   not as severe as section-level -- the rest of the doc may still be useful
//   context.
//
// AMENDMENT_BOOST_FACTOR = chunk is from a confirmed amendment doc. 1.5x
//   boost so amendments reliably surface even when the parent doc is also
//   keyword/title-matched.
//
// Note: chunks from unamended sections of a parent doc that has amendments
// are LEFT ALONE (no penalty). Those sections are still current.
const SECTION_SUPERSEDED_DERANK = 0.10;
const SUPERSEDED_BY_AMENDMENT_DERANK = 0.20;
const AMENDMENT_BOOST_FACTOR = 1.50;

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

  // Expand a symptom-worded question with the governing-doc concepts it
  // implies, so all three retrieval halves can find the provision that answers
  // it (see expandQueryConcepts). No-op when no situation trigger is present.
  // The community is ALREADY a hard filter on all three halves, so the community
  // NAME inside the question carries zero retrieval signal — and it actively
  // hurts: as a keyword it matches every chunk in scope ("Waterview Estates"
  // appears on every page), it dilutes the embedding, and it title-matches every
  // doc. Homeowners naturally write it ("the Waterview Estates clubhouse"),
  // which is exactly why Claire's answers were worse than askEd's — askEd takes
  // the community from a dropdown, so its query never contained it. Strip once,
  // use everywhere. (Ed 2026-07-14.)
  const qtext = stripCommunityName(text, community);
  const rtext = expandQueryConcepts(qtext, community);

  // --- Vector half ---
  const vectorPromise = (async () => {
    try {
      const embeddingResponse = await openai.embeddings.create({
        model: 'text-embedding-ada-002',
        input: rtext.replace(/\n/g, ' ').slice(0, 8000),
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
    // Deliberately keyed on the ORIGINAL text, not the concept-expanded rtext.
    // Expansion exists so the vector + keyword halves can find a provision from
    // symptom wording — but title-match asks a different question: "is there a
    // doc literally TITLED about this?" That must use the user's own words.
    // Scar (Ed 2026-07-14): expandQueryConcepts appends "...condition nuisance
    // drainage sanitary", and "condition" is a substring of "Declaration of
    // Covenants, CONDITIONS and Restrictions" — so the Declaration title-matched
    // essentially EVERY expanded question, in every community, and its chunks
    // (3x title weight) buried the doc that actually answered. That's how a
    // clubhouse-capacity question returned the Declaration and Claire told a
    // homeowner the form "doesn't list a maximum capacity" while the Clubhouse
    // Agreement said 50.
    const keywords = extractKeywords(qtext);
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
        return { doc: d, discMatches, score: 3 * discMatches + commMatches };
      })
        // A title that matches ONLY the community name is NOT a signal — every
        // doc in the community matches it, so it floods the merge with noise.
        // Scar (Ed 2026-07-14): a homeowner asked "how many people can the
        // Waterview Estates clubhouse accommodate?". "waterview"/"estates" in
        // the question title-matched all 25 Waterview docs -> 502 Declaration
        // chunks at 3x title weight buried the Clubhouse Agreement, and Claire
        // replied "the form doesn't list a capacity" while askEd (community
        // picked from a dropdown, so no community words in the query) quoted
        // the real 50-person limit. Require >=1 DISCRIMINATING keyword, and cap
        // the doc fan-out so one loose query can't dominate the merge.
        .filter((s) => s.discMatches > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, TITLE_MATCH_MAX_DOCS);

      const chunkResults = await Promise.all(scoredDocs.map(async ({ doc }) => {
        // Two link paths between library_documents and documents chunks:
        //   - New ingestion path: chunk metadata.library_document_id = doc.id
        //   - Legacy promotion path: chunk row's SQL column migrated_to_library_id = doc.id
        // Title-match was only checking the first, so chunks for legacy-promoted
        // documents were invisible to title-match. Both paths are now queried
        // and deduped. Ed 2026-06-16.
        const [byMeta, byCol] = await Promise.all([
          supabase
            .from('documents')
            .select('content, metadata')
            .eq('metadata->>library_document_id', doc.id)
            .limit(TITLE_MATCH_PER_DOC),
          supabase
            .from('documents')
            .select('content, metadata')
            .eq('migrated_to_library_id', doc.id)
            .limit(TITLE_MATCH_PER_DOC),
        ]);
        if (byMeta.error) console.warn(`[hybrid-retrieval] title-match chunks (meta) for "${doc.title}" failed:`, byMeta.error.message);
        if (byCol.error)  console.warn(`[hybrid-retrieval] title-match chunks (column) for "${doc.title}" failed:`, byCol.error.message);
        const combined = [...(byMeta.data || []), ...(byCol.data || [])];
        const seen = new Set();
        const deduped = combined.filter((c) => {
          const key = (c.content || '').slice(0, 240);
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        // Rank the matched doc's chunks by QUERY RELEVANCE (how many query
        // keywords the chunk contains), not by position in the document. Title-
        // match RRF scores by list position, and the per-doc cap keeps only the
        // top few — so a position-ordered list surfaces front matter and buries
        // the deep section that actually answers the question (Waterview
        // Declaration §3.12 "Lot and Building Maintenance" is on p23 of 47 —
        // front-matter chunks were taking all its slots). Relevance-first
        // ordering puts the answering section at the top of the doc's
        // contribution. Ed 2026-07-01.
        const scored = deduped.map((c) => {
          const lc = (c.content || '').toLowerCase();
          const s = keywords.reduce((n, kw) => n + (lc.includes(kw) ? 1 : 0), 0);
          return { c, s };
        }).sort((a, b) => b.s - a.s);
        return scored.slice(0, TITLE_MATCH_PER_DOC).map((x) => x.c);
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
    const keywords = extractKeywords(rtext);
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

  // Amendment supersession (migration 228, Ed 2026-06-18). SECTION-LEVEL
  // granularity: only deprioritize the chunks whose section was actually
  // amended; leave the rest of the parent doc at full score (those sections
  // are still current). Falls back to doc-level when an amendment has no
  // amended_sections recorded (whole-doc supersession).
  //
  // Strategy:
  //   1. Collect all library_document_ids in the candidate pool.
  //   2. Fetch supersession links + amended_sections for each.
  //   3. Build parentId -> Set of normalized amended section IDs.
  //   4. Build set of confirmed amendment doc IDs (their chunks get boosted).
  //   5. For each chunk in the merge pool:
  //      - If chunk's doc IS a confirmed amendment -> boost by 1.5x.
  //      - Else if chunk's doc has amendments AND chunk's metadata.section
  //        is in the amended set -> derank by 0.10 (severe; the section is
  //        literally replaced by the amendment).
  //      - Else if chunk's doc has WHOLE-doc supersession (empty/null
  //        amended_sections on the amendment) -> derank by 0.20 (the whole
  //        parent doc is stale).
  //      - Else (chunk is from an unamended section of an amended doc) ->
  //        leave the score alone. Those sections are still current.
  // Candidate library_document_ids, computed ONCE up here — both the amendment
  // supersession block (below) AND the legal-updates enrichment need them.
  // Was declared ~70 lines further down, so the amendment block referenced it
  // in its temporal dead zone → "Cannot access 'libDocIds' before
  // initialization" → the whole amendment adjust silently no-op'd on EVERY
  // query (amendments never boosted/deranked). Ed 2026-07-01.
  const libDocIds = Array.from(new Set(
    Array.from(byKey.values())
      .map((e) => e.row?.metadata?.library_document_id)
      .filter(Boolean)
  ));

  try {
    const allLibIds = new Set(libDocIds);
    if (allLibIds.size > 0) {
      const { data: superRows } = await supabase
        .from('library_documents')
        .select('id, supersedes_library_document_id, supersession_recorded_at, amended_sections')
        .in('id', [...allLibIds]);

      // Section ID normalizer -- "Section 3.3" -> "3.3", "3.3(a)" -> "3.3(a)",
      // strip leading "Section " / "Article " / "§ ". Lowercase + trim.
      const normSection = (s) => String(s || '').toLowerCase()
        .replace(/^\s*(section|article|§)\s+/i, '')
        .trim();

      // parent_doc_id -> { sections: Set, wholeDoc: boolean }
      const parentSupersession = new Map();
      // amendment_doc_id -> true
      const confirmedAmendments = new Set();
      for (const r of (superRows || [])) {
        if (!r.supersedes_library_document_id || !r.supersession_recorded_at) continue;
        confirmedAmendments.add(r.id);
        const sections = Array.isArray(r.amended_sections) ? r.amended_sections.filter(Boolean).map(normSection) : [];
        const existing = parentSupersession.get(r.supersedes_library_document_id) || { sections: new Set(), wholeDoc: false };
        if (sections.length === 0) {
          // Empty/null amended_sections = whole-doc supersession
          existing.wholeDoc = true;
        } else {
          for (const s of sections) existing.sections.add(s);
        }
        parentSupersession.set(r.supersedes_library_document_id, existing);
      }

      if (parentSupersession.size > 0 || confirmedAmendments.size > 0) {
        let derankedSection = 0, derankedWhole = 0, boostedAsAmend = 0, untouchedNonAmended = 0;
        for (const entry of byKey.values()) {
          const libId = entry.row?.metadata?.library_document_id;
          if (!libId) continue;
          if (confirmedAmendments.has(libId)) {
            entry.score *= AMENDMENT_BOOST_FACTOR;
            entry.sources.add('is-amendment');
            boostedAsAmend += 1;
            continue;
          }
          const supers = parentSupersession.get(libId);
          if (!supers) continue;
          if (supers.wholeDoc) {
            entry.score *= SUPERSEDED_BY_AMENDMENT_DERANK;
            entry.sources.add('whole-doc-superseded');
            derankedWhole += 1;
            continue;
          }
          // Section-level: check the chunk's section against the amended set.
          const chunkSection = normSection(entry.row?.metadata?.section);
          if (chunkSection && supers.sections.has(chunkSection)) {
            entry.score *= SECTION_SUPERSEDED_DERANK;
            entry.sources.add('section-superseded');
            derankedSection += 1;
          } else {
            untouchedNonAmended += 1;
          }
        }
        console.log(`[hybrid-retrieval] amendment adjust: section-deranked ${derankedSection}, whole-doc-deranked ${derankedWhole}, boosted ${boostedAsAmend} amendment chunks, left ${untouchedNonAmended} unamended-section chunks at full score`);
      }
    }
  } catch (e) {
    console.warn('[hybrid-retrieval] amendment supersession adjust failed:', e.message);
  }

  // Legal-update enrichment. Any chunk whose library_document_id has a
  // legal_updates sidecar gets its breadcrumb header enriched with source
  // publisher + date + topics + key holding — so the model sees a
  // citation-ready label and can cite it verbatim. Ed 2026-06-04 build.
  // Done in a single batched query for all retrieved library_document_ids
  // so retrieval stays under one round-trip.
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

  // Per-document cap. Without it, one doc that matches strongly on an
  // incidental word can eat ALL of the final slots and starve the doc that
  // actually holds the answer. Real case (Ed 2026-07-01): a Waterview leak/
  // enforcement question filled all 18 slots with Bylaws chunks — the query
  // word "homeowner" title-matched "Homeowners Association" (3× weight) — so
  // the Declaration's Lot-and-Building-Maintenance provision never surfaced,
  // even though it was in the candidate pool. Cap each doc to a minority of
  // the final set so multiple docs are represented; backfill (ignoring the
  // cap) only if too few distinct docs exist to fill HYBRID_K. Same family as
  // the "18 chunks all TOC" and "all one bylaws doc" scars.
  const PER_DOC_CAP = 6;
  const sortedEntries = Array.from(byKey.values()).sort((a, b) => b.score - a.score);
  // Key the cap on FILENAME (not library_document_id): the same file can be
  // ingested more than once with different ids, and an id-keyed cap would let
  // each copy fill its own quota. Filename groups those copies together.
  const docKeyOf = (e) => e.row?.metadata?.filename || e.row?.metadata?.library_document_id || 'unknown';
  const perDocCount = new Map();
  const merged = [];
  for (const e of sortedEntries) {
    if (merged.length >= HYBRID_K) break;
    const dk = docKeyOf(e);
    const n = perDocCount.get(dk) || 0;
    if (n >= PER_DOC_CAP) continue;
    perDocCount.set(dk, n + 1);
    merged.push(e);
  }
  if (merged.length < HYBRID_K) {
    const have = new Set(merged);
    for (const e of sortedEntries) { if (merged.length >= HYBRID_K) break; if (!have.has(e)) merged.push(e); }
  }

  const dualHits = merged.filter((m) => m.sources.size >= 2).length;
  const survivingTOC = merged.filter((m) => m.sources.has('toc-derank')).length;
  console.log(`[hybrid-retrieval] community="${community || '(all)'}" vector=${vectorChunks.length} keyword=${keywordChunks.length} title=${titleMatchChunks.length} merged=${merged.length} multi-source=${dualHits} toc-deranked=${derankedCount} toc-in-final=${survivingTOC}`);

  return merged.map(({ row, sources }) => {
    const ocrTag = row.metadata?.ocr ? " — OCR'd scan, may have minor errors" : '';
    // Filter out internal merge-step signals before exposing sources to the
    // UI/prompt. Amendment status flags are handled separately below so the
    // synthesis layer sees a structured, actionable tag instead of cryptic
    // 'section-superseded' / 'is-amendment' jargon mixed in.
    const internalSignals = new Set(['toc-derank', 'is-amendment', 'section-superseded', 'whole-doc-superseded', 'superseded-by-amendment']);
    const sources_arr = [...sources].filter((s) => !internalSignals.has(s));
    const sourceTag = sources_arr.length >= 2 ? ` — matched ${sources_arr.join('+')}` : '';

    // Amendment supersession tag (migration 228 + section-level retrieval).
    // Synthesis layer needs an EXPLICIT instruction inline with each chunk so
    // it knows whether to (a) quote this as current, (b) skip it because the
    // section is superseded, or (c) disclose the supersession to the user.
    // Without this tag the AI sees "two versions of Section 3.3" and picks
    // one silently -- the cardinal failure mode for governing-doc retrieval.
    const amendmentTag = (() => {
      if (sources.has('is-amendment')) {
        return ' · ✨ AMENDMENT — this is the current language for the sections it covers; CITE THIS VERSION';
      }
      if (sources.has('section-superseded')) {
        return ' · ⚠ SUPERSEDED SECTION — this is the ORIGINAL text; the current language is in an AMENDMENT chunk also retrieved. CITE THE AMENDMENT and explicitly disclose to the user that this section was amended.';
      }
      if (sources.has('whole-doc-superseded')) {
        return ' · ⚠ SUPERSEDED DOC — this entire document was superseded by a newer one also retrieved. Cite the newer version and disclose the supersession.';
      }
      return '';
    })();
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
    return `[From: ${row.metadata?.filename} - ${row.metadata?.community}${breadcrumb}${legalTag}${amendmentTag}${ocrTag}${sourceTag}]\n${row.content}`;
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
