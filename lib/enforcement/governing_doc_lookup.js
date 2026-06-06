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
 * @param {string}  [args.categorySlug]       canonical slug e.g. 'lawn_dead_patches' (drives subject map)
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
  categorySlug,
  categoryLabel,
  categoryDescription,
  aiDescription,
  matchCount = 6,
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

    // PRE-AI SUBJECT GATE — if NONE of the candidate chunks even mention
    // the violation's subject vocabulary, skip the AI call entirely and
    // return null (caller falls back to generic Authority Statement). This
    // is the "Lawn dead patches matched a Structures section" defense at
    // the cheapest layer. Saves the AI call on guaranteed-bad matches.
    if (categorySlug && !_anyCandidateHasSubject(categorySlug, candidates)) {
      console.log(`[governing_doc_lookup] community=${communityId} category="${categoryLabel}" (slug=${categorySlug}) → no candidate chunk contains the subject vocabulary. Falling back to generic.`);
      return null;
    }

    // Filter candidates to those that contain the subject vocabulary FIRST,
    // so the AI is only choosing among on-subject sections. Drops the
    // candidates that semantic search surfaced but that are actually about
    // a different subject (e.g., "structures maintenance" surfaced for a
    // "lawn maintenance" query).
    const onSubject = categorySlug
      ? candidates.filter(c => _subjectMatches(categorySlug, c.text))
      : candidates;
    const subjectFilteredCandidates = onSubject.length > 0 ? onSubject : candidates;

    // AI-driven citation extraction. Pass the top 3 subject-matched candidate
    // chunks to Claude with a focused prompt and let it return a structured
    // citation matching the document's own numbering style.
    const top = subjectFilteredCandidates.slice(0, 3);
    const ai = await _aiExtractCitation({ categorySlug, categoryLabel, categoryDescription, aiDescription, chunks: top });
    if (!ai || !ai.found) {
      console.log(`[governing_doc_lookup] community=${communityId} category="${categoryLabel}" → AI extraction returned not-found from ${top.length} candidate chunks (subject-gated)`);
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

// Category subject map — maps each canonical category slug to the vocabulary
// the matching CC&R section MUST contain. Used as a pre-AI gate AND a post-AI
// verification: if no candidate chunk contains any of the subject keywords,
// or if the AI's returned quote doesn't mention any subject keyword, we
// REJECT the match and fall back to the generic Authority Statement.
//
// Why hardcoded: the auto-lookup auto-matched a "structures maintenance"
// section for a "Lawn dead patches" violation because both use the words
// 'maintain' and 'shall.' Semantic search picked the wrong subject. The
// fix is to gate by SUBJECT vocabulary, not just verb vocabulary.
//
// must_match  = at least one of these words must appear in the chunk/quote
// veto_match  = if any of these appear AND none of must_match do, reject
const CATEGORY_SUBJECT_MAP = {
  tree_overgrowth:        { must_match: /\b(tree|trees|branch|branches|canopy|canopies|limb|limbs|foliage|vegetation)\b/i },
  tree_dead_dying:        { must_match: /\b(tree|trees|dead|dying|hazard|hazardous|decay|decaying)\b/i },
  mildew_mold_visible:    { must_match: /\b(mildew|mold|fungus|algae|stain|stains|discolor|discolored)\b/i },
  lawn_height:            { must_match: /\b(lawn|grass|yard|turf|landscape|landscaping|mow|mowed|mowing|height)\b/i, veto_match: /\b(structure|building|window|door|roof|siding)\b/i },
  lawn_dead_patches:      { must_match: /\b(lawn|grass|yard|turf|landscape|landscaping|vegetation|dead|patch|patches|bare|sparse)\b/i, veto_match: /\b(structure|building|window|door|roof|siding)\b/i },
  weeds:                  { must_match: /\b(weed|weeds|landscape|landscaping|lawn|garden|vegetation|growth)\b/i },
  landscaping_overgrown:  { must_match: /\b(landscape|landscaping|garden|shrub|shrubs|hedge|hedges|bed|beds|plant|plants|vegetation|sidewalk|sidewalks)\b/i },
  paint_peeling:          { must_match: /\b(paint|painted|painting|exterior|color|colors|finish|finishes|surface|surfaces)\b/i },
  siding_damage:          { must_match: /\b(siding|exterior|wall|walls|cladding|brick|brickwork|stucco|surface|surfaces)\b/i },
  roof_damage:            { must_match: /\b(roof|roofs|roofing|shingle|shingles|tile|tiles)\b/i },
  fence_damage:           { must_match: /\b(fence|fences|fencing|barrier|barriers)\b/i },
  fence_unauthorized:     { must_match: /\b(fence|fences|fencing|architectural|approval|approved|acc|barrier|barriers)\b/i },
  vehicle_inoperable:     { must_match: /\b(vehicle|vehicles|automobile|automobiles|car|cars|truck|trucks|motor|motorized|inoperable|abandoned)\b/i },
  vehicle_commercial:     { must_match: /\b(vehicle|vehicles|commercial|truck|trucks|trailer|trailers|parking)\b/i },
  trash_bulk:             { must_match: /\b(trash|garbage|refuse|waste|debris|rubbish|container|containers|receptacle|receptacles|bulk|bulky)\b/i },
  trash_bins_curb:        { must_match: /\b(trash|garbage|refuse|waste|bin|bins|container|containers|receptacle|curb|curbside|pickup)\b/i },
  rv_boat_trailer:        { must_match: /\b(recreational|rv|boat|boats|trailer|trailers|vehicle|vehicles|parking|stored|storage)\b/i },
  basketball_goal:        { must_match: /\b(basketball|goal|goals|hoop|hoops|backboard|sports|equipment|architectural)\b/i },
  pool_safety:            { must_match: /\b(pool|pools|swimming|fence|fencing|enclosure|gate|safety)\b/i },
  storage_visible:        { must_match: /\b(stored|storage|store|stores|visible|view|view|equipment|item|items|object|objects)\b/i },
  // Catch-all categories — accept anything (these are inherently broad)
  uncategorized:          { must_match: null },
  other:                  { must_match: null },
};

// Verify a candidate text (chunk or AI quote) is actually about the same
// SUBJECT as the violation category. Returns true if must_match satisfied
// (or category has no mapping — accept by default).
function _subjectMatches(categorySlug, text) {
  if (!text || typeof text !== 'string') return false;
  const map = CATEGORY_SUBJECT_MAP[categorySlug];
  if (!map || !map.must_match) return true;  // no mapping → accept
  if (map.must_match.test(text)) return true;
  return false;
}

// Pre-AI gate: do any of the candidate chunks contain the subject vocabulary?
// If NOT, we skip the AI call entirely and return null (caller falls back
// to generic). Saves the AI cost on guaranteed-bad matches.
function _anyCandidateHasSubject(categorySlug, chunks) {
  const map = CATEGORY_SUBJECT_MAP[categorySlug];
  if (!map || !map.must_match) return true;  // no mapping → accept
  return chunks.some(c => _subjectMatches(categorySlug, c.text));
}

// AI-driven citation extraction. Given the top candidate chunks from the
// semantic search, ask Claude to identify which section of which document
// actually creates the obligation the homeowner is violating, formatted in
// the document's own numbering style. Handles old CC&Rs that use any
// convention — "Section 4(c)", "Restriction 12", "Paragraph IV.A.2", etc.
//
// TIGHTENED 2026-06-07: prompt now explicitly requires SUBJECT matching
// (the section must be about the same subject as the violation, not just
// about a similar verb like 'maintain'). Confidence threshold raised to
// HIGH only — anything less falls back to the generic Authority Statement.
// Upgraded model from Haiku to Sonnet for better subject discrimination.
async function _aiExtractCitation({ categoryLabel, categoryDescription, aiDescription, categorySlug, chunks }) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const excerptsBlock = chunks.map((c, i) =>
      `[Excerpt ${i + 1} — from "${c.document_title || 'governing doc'}"${c.section_heading ? ' / heading: ' + c.section_heading : ''}]\n${(c.text || '').slice(0, 1200)}`
    ).join('\n\n---\n\n');

    const violationSummary = [categoryLabel, categoryDescription, aiDescription].filter(Boolean).join(' · ');

    const prompt = `You are helping draft an HOA covenant-violation letter. Read these excerpts from the Association's governing documents and identify the section that creates the obligation specifically being violated.

VIOLATION: ${violationSummary}

EXCERPTS:
${excerptsBlock}

CRITICAL — SUBJECT MATCHING:
The section you cite MUST be about the same SUBJECT as the violation, not just use similar verbs.

If the violation is about LANDSCAPING (lawn, grass, yard, trees, vegetation), the cited section must specifically address landscaping/yard/lot maintenance — NOT structures, buildings, roofs, walls, doors, etc.

If the violation is about EXTERIOR STRUCTURES (paint, siding, roof, windows, doors), the cited section must specifically address that structural element — NOT landscaping or yard.

If the violation is about VEHICLES, TRASH, OR STORAGE, the cited section must specifically address that subject — NOT general property maintenance.

A section that talks about "maintaining structures" (windows, doors, roofs, siding) is NOT a valid citation for a LAWN violation, even if it uses the word "maintain."

EXAMPLES OF BAD MATCHES (must return found=false):
- Violation: Lawn dead patches. Citation: "each Owner shall maintain in good condition all structures on the Lot including windows, doors, garage doors, roofs, siding..." → REJECT. This is about structures, not landscaping.
- Violation: Trash bins at curb. Citation: "owners shall maintain their lot in a neat condition." → REJECT. Too generic — doesn't specifically address trash/bins/refuse.
- Violation: RV in driveway. Citation: "owners shall keep landscaping in good condition." → REJECT. Wrong subject.

EXAMPLES OF GOOD MATCHES (return found=true with high confidence):
- Violation: Lawn dead patches. Citation: "each Owner shall keep the Lot, including all landscaping thereon, in a clean and well-maintained condition." → ACCEPT. Specifically mentions landscaping.
- Violation: Trash bins at curb. Citation: "trash receptacles shall not be placed at the curb earlier than 24 hours before scheduled pickup." → ACCEPT. Specifically addresses trash + curb.

Return ONLY valid JSON, no prose, in this exact shape:
{
  "found": true | false,
  "reference": "the exact reference using the document's own numbering — must include both article AND section when both exist. Examples: 'Article VII, Section 7.3', 'Article 11, Section 11.2'. Do NOT return a bare 'Section 2' or 'Paragraph 4' without the article context — that's an ambiguous citation and the homeowner can't find it.",
  "document_title": "Declaration of Covenants, Conditions and Restrictions" | "Bylaws" | "Rules and Regulations" | "Architectural Guidelines",
  "section_title": "short title from the source if present, like 'MAINTENANCE OF LOTS' — null if not present",
  "quote": "ONE sentence verbatim from the excerpt that states the specific obligation related to THIS violation's subject. Must contain language about the violation's specific subject (lawn/structure/trash/etc.) — not just generic maintenance language. Max 280 chars. null if no clean subject-matching sentence exists.",
  "subject_match_evidence": "explain in one sentence which words/phrases in the quote prove this section is about the violation's specific subject. If you can't point to specific subject words, return found=false instead.",
  "confidence": "high" | "medium" | "low"
}

REJECTION RULES:
- If the best matching section is about a different subject than the violation, return { "found": false }. Do NOT cite a generic 'maintenance' section when the violation is about a specific subject (lawn, paint, trash, etc.).
- If the reference would be ambiguous (e.g., 'Section 2' without an article), return { "found": false }. Better no citation than a confusing one.
- If your confidence is anything less than HIGH, return { "found": false }. We default to a generic, defensible Authority Statement when no specific citation is high-confidence.
- Do not invent references that aren't in the text.`;

    const resp = await client.messages.create({
      model: 'claude-sonnet-4-5',   // Upgraded from Haiku — subject discrimination matters here
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = resp.content && resp.content[0] && resp.content[0].text;
    if (!text) return null;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    let parsed;
    try { parsed = JSON.parse(jsonMatch[0]); }
    catch (_) { return null; }

    // Hard rejections regardless of what the AI returned:
    // 1. Confidence must be 'high' — anything less falls back to generic
    if (parsed.found && parsed.confidence !== 'high') {
      console.log(`[governing_doc_lookup] AI returned confidence='${parsed.confidence}' — rejecting (high required)`);
      return { found: false };
    }
    // 2. Reference must include both article AND section when available — bare
    //    'Section 2' / 'Paragraph 4' rejected as ambiguous
    if (parsed.found && parsed.reference) {
      const ref = String(parsed.reference);
      const hasArticle = /article/i.test(ref);
      const hasSection = /section|paragraph|restriction|§|art\b/i.test(ref);
      if (!hasArticle && hasSection && /^\s*(section|paragraph|restriction)\s+\d/i.test(ref)) {
        console.log(`[governing_doc_lookup] AI returned ambiguous bare section '${ref}' — rejecting`);
        return { found: false };
      }
    }
    // 3. Post-AI subject verification — does the QUOTE actually mention the
    //    violation's subject vocabulary? If not, reject.
    if (parsed.found && parsed.quote && categorySlug) {
      if (!_subjectMatches(categorySlug, parsed.quote)) {
        console.log(`[governing_doc_lookup] AI quote doesn't contain ${categorySlug} subject vocabulary — rejecting. Quote: "${parsed.quote.slice(0, 100)}..."`);
        return { found: false };
      }
    }

    return parsed;
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

// ============================================================================
// lookupEnforcementAuthority — finds the article/section that grants the
// Association the right to enforce the Declaration (typically Article 11 or
// Article XV "Enforcement" / "Remedies"). Distinct from lookupGoverningDoc
// (which finds the substantive obligation, e.g., "owners shall maintain
// their lot"). Both citations together = three-claim Authority Statement
// gold standard.
//
// Returns:
//   { reference, quote, document_title, source_excerpt, confidence } | null
//
// This is called once per community as a backfill exercise. Result gets
// stamped on communities.enforcement_authority_citation and drives the
// Authority Statement on every letter from that community going forward.
// ============================================================================

async function lookupEnforcementAuthority({ communityId, matchCount = 6, minSimilarity = 0.70 }) {
  try {
    if (!communityId) return null;
    const openai = _openai();
    if (!openai) return null;

    // Targeted query — anchor on the EXACT language enforcement sections use.
    // "shall have the right to enforce" + "may impose fines" + "lawful
    // remedies" pushes enforcement-power chunks to the top, away from the
    // substantive obligation chunks that lookupGoverningDoc finds.
    const query = `What article and section of the Declaration grants the Association the right to enforce the covenants and restrictions, pursue legal remedies, file liens, impose fines, or collect attorney fees from owners who violate the Declaration? This is the enforcement article — typically titled "Enforcement," "Remedies," "Right of the Association to Enforce," or similar — not the maintenance obligation. Cite the article and section.`;

    const embedRes = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: query,
    });
    const embedding = embedRes.data && embedRes.data[0] && embedRes.data[0].embedding;
    if (!embedding) return null;

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
      console.warn('[lookupEnforcementAuthority] RPC failed:', error.message);
      return null;
    }
    if (!Array.isArray(chunks) || chunks.length === 0) {
      console.log(`[lookupEnforcementAuthority] community=${communityId} → no chunks matched substrate`);
      return null;
    }

    const candidates = chunks
      .filter(ch => Number(ch.similarity) >= minSimilarity)
      .filter(ch => !_looksOcrDamaged(ch.text));
    if (candidates.length === 0) {
      console.log(`[lookupEnforcementAuthority] community=${communityId} → ${chunks.length} chunks, none passed quality filter`);
      return null;
    }

    // Pass top candidates to Claude to identify the exact enforcement citation.
    // Prompt is tuned to reject maintenance/architectural sections and only
    // accept actual ENFORCEMENT POWER sections.
    const top = candidates.slice(0, 4);
    const ai = await _aiExtractEnforcementCitation({ chunks: top });
    if (!ai || !ai.found) {
      console.log(`[lookupEnforcementAuthority] community=${communityId} → AI extraction returned not-found from ${top.length} candidates`);
      return null;
    }

    return {
      reference:      ai.reference,
      quote:          ai.quote || null,
      document_title: ai.document_title || top[0].document_title || 'Declaration',
      source_excerpt: (top[0].text || '').slice(0, 400),
      confidence:     ai.confidence || 'medium',
      candidates_seen: chunks.length,
      candidates_passed_quality: candidates.length,
    };
  } catch (err) {
    console.warn('[lookupEnforcementAuthority] failed:', err.message);
    return null;
  }
}

async function _aiExtractEnforcementCitation({ chunks }) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const excerptsBlock = chunks.map((c, i) =>
      `[Excerpt ${i + 1} — from "${c.document_title || 'governing doc'}"${c.section_heading ? ' / heading: ' + c.section_heading : ''}]\n${(c.text || '').slice(0, 1400)}`
    ).join('\n\n---\n\n');

    const prompt = `You are helping populate an HOA's enforcement authority citation. Read these excerpts from the Association's governing documents and identify the specific article/section that grants the Association the RIGHT TO ENFORCE the Declaration.

WHAT YOU ARE LOOKING FOR:
- An article or section titled "Enforcement," "Remedies," "Right of the Association to Enforce," "Violations," "Penalties," or similar
- Language like "the Association shall have the right to enforce," "the Association may pursue any lawful remedy," "the Board may impose fines," "the Association may file a lien," "any party may bring an action to enforce"
- The OVERARCHING enforcement power — not a specific maintenance obligation

WHAT YOU ARE NOT LOOKING FOR:
- Substantive obligations (e.g., "owners shall maintain their lot") — that's a different citation
- Architectural review procedures (unless they also include general enforcement language)
- Definitions

EXCERPTS:
${excerptsBlock}

Return ONLY valid JSON, no prose, in this exact shape:
{
  "found": true | false,
  "reference": "the citation in the document's own numbering style — examples: 'Article 11, Section 11.2', 'Article XV', 'Section 9.1', 'Paragraph IV.B.3'. Format consistently. Include both article AND section when both are present.",
  "document_title": "Declaration of Covenants, Conditions and Restrictions" | "Bylaws" | etc. — friendly name for citation,
  "quote": "ONE sentence verbatim from the excerpt that states the enforcement power, max 300 chars. null if no clean sentence exists.",
  "confidence": "high" | "medium" | "low"
}

If none of the excerpts contain a clear enforcement authority section, return { "found": false }. Do not invent references that aren't in the text. Prefer "high" confidence only when you're certain — when uncertain, return "medium" so the operator reviews.`;

    const resp = await client.messages.create({
      model: 'claude-sonnet-4-5',
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
    console.warn('[lookupEnforcementAuthority] AI extraction failed:', err.message);
    return null;
  }
}

module.exports = { lookupGoverningDoc, lookupEnforcementAuthority };
