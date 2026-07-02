// ============================================================================
// library_reindex.js
// ----------------------------------------------------------------------------
// Bridge from library_documents (Documents Tracker) → documents (askEd's
// vector index). Without this bridge, anything uploaded via the UI gets a
// green checkmark in the matrix but is invisible to askEd.
//
// Caught when askEd told Ed: "the By-Laws aren't in the current document set"
// for Canyon Gate at Cinco Ranch — even though the matrix showed them present.
//
// Used by:
//   • api/documents.js — auto-indexes every newly uploaded doc after the
//     library row is created (so upload → askEd sees it, no buttons)
//   • server.js — exposes manual reindex routes for one-time backfill of
//     pre-existing docs + community variation logic for retrieval
// ============================================================================

const pdfParse = require('pdf-parse');
const _lazyMammoth = () => require('mammoth');
const { ocrPdfWithAi } = require('./ocr_pdf');

// pdf-parse can succeed on a scanned PDF but return only header noise. ~50
// non-whitespace chars is the floor that distinguishes "real text was found"
// from "this is image-only and we need OCR."
const MIN_TEXT_CHARS = 50;

// Categories that are the association's financial RECORDS / transaction data,
// not narrative Q&A content. askEd answers from governing docs, policies, and
// contracts; any actual financial FIGURE must come LIVE from the accounting
// module (GL / AR), never from a stale PDF snapshot that's wrong the moment the
// next month posts. These categories are excluded from askEd indexing AND from
// the coverage metric so they don't show as a false "not indexed" backlog.
// Insurance (policy / dec page) is intentionally NOT here — coverage terms are
// narrative and a legitimate askEd question.
const ASKED_SKIP_CATEGORIES = [
  'ar_aging', 'bank_rec_source', 'bank_reconciliation', 'bank_register',
  'bank_statement', 'gl_trial_balance', 'financial_statement',
  'current_unaudited_financials', 'annual_financial_statements', 'unit_ledger',
];

// Community-name variations so a question filed under "Canyon Gate at Cinco
// Ranch" still pulls chunks tagged "Canyon Gate" (an earlier ingest may have
// used a shorter name). Generates the full name, leading segment before " at ",
// and the same with trailing entity types stripped.
function communityNameVariations(name) {
  const out = new Set();
  if (!name) return [];
  out.add(name);
  const head = name.split(/\s+at\s+|\s+—\s+/i)[0].trim();
  if (head) out.add(head);
  const stripped = head.replace(/\s+(?:HOA|Inc\.?|LLC|Homeowners?\s+Association)$/i, '').trim();
  if (stripped) out.add(stripped);
  return [...out];
}

// extractFullTextFromFile — returns { text, ocrUsed }. ocrUsed=true means the
// text came from the AI vision OCR rather than embedded text in the PDF, so
// callers can tag chunks and downstream askEd can surface a "double-check the
// original scan" caveat.
async function extractFullTextFromFile(buffer, filename, opts = {}) {
  const ext = (filename || '').toLowerCase().match(/\.(\w+)$/)?.[1] || 'pdf';
  if (ext === 'pdf') {
    // forceOcr: skip the embedded text layer and OCR with the vision model.
    // Recorded governing docs are scans whose embedded text layer is often
    // garbled OCR — pdf-parse "succeeds" on that garbage (>= MIN_TEXT_CHARS) so
    // the clean vision-OCR path never runs, and the garbled text is what gets
    // chunked/embedded (Ed 2026-07-02, Waterview §3.12 miss). Re-indexing a
    // governing doc with forceOcr replaces it with clean, citation-grade text.
    if (!opts.forceOcr) {
      let text = '';
      try {
        const data = await pdfParse(buffer);
        text = data.text || '';
      } catch (e) {
        console.warn('[reindex] pdf-parse failed for', filename, e.message);
      }
      if (text.replace(/\s+/g, '').length >= MIN_TEXT_CHARS) {
        return { text, ocrUsed: false };
      }
      console.log('[reindex] pdf-parse yielded no usable text for', filename, '— attempting OCR');
    } else {
      console.log('[reindex] forceOcr — bypassing pdf-parse text layer for', filename);
    }
    try {
      const ocrText = await ocrPdfWithAi(buffer, filename);
      if (ocrText && ocrText.replace(/\s+/g, '').length >= MIN_TEXT_CHARS) {
        return { text: ocrText, ocrUsed: true };
      }
    } catch (e) {
      console.warn('[reindex] OCR failed for', filename, e.message);
    }
    return { text: '', ocrUsed: false };
  }
  if (ext === 'docx' || ext === 'doc') {
    try {
      const mammoth = _lazyMammoth();
      const result = await mammoth.extractRawText({ buffer });
      return { text: result.value || '', ocrUsed: false };
    } catch (e) {
      console.warn('[reindex] mammoth failed for', filename, e.message);
      return { text: '', ocrUsed: false };
    }
  }
  if (ext === 'txt') {
    try { return { text: buffer.toString('utf8'), ocrUsed: false }; }
    catch (_) { return { text: '', ocrUsed: false }; }
  }
  return { text: '', ocrUsed: false };
}

// ----------------------------------------------------------------------------
// Structure-aware chunking (Ed 2026-06-04, "stakes high — bulletproof")
//
// Old behavior: 1000-char sliding window with 200-char overlap, no awareness
// of where each chunk lives inside the document. When askEd retrieved a chunk
// containing "...shall not be used for trade, business, or commercial
// purposes..." it had no breadcrumb back to "ARTICLE VII — USE RESTRICTIONS /
// Section 7.2 Commercial Use Prohibited" — that heading lived 6000 characters
// earlier in the file, in a different chunk. The model knew it should cite
// "Section [X] of Article [X]" but couldn't fill the brackets. The Quail
// Ridge Airbnb letter 2026-06-04 was the canonical failure: shipped to
// staff with bracketed placeholders that would have hit a homeowner.
//
// New behavior: pre-pass walks the document line-by-line tracking the
// current Article + Section + heading text. Each chunk gets stamped with the
// breadcrumb in effect at its start position. Retrieval surfaces the
// breadcrumb in the chunk header so the model sees "Article VII / Section
// 7.2 / Commercial Use Prohibited" and cites it verbatim.
//
// Patterns are intentionally permissive — declarations vary in formatting:
//   - "ARTICLE VII"           (all caps, Roman)
//   - "Article 5"              (Arabic)
//   - "Article V — Use Restrictions"  (with dash heading)
//   - "Article 5. Definitions" (with period heading)
//   - "SECTION 7.2"            (all caps)
//   - "Section 7.2 Commercial Use Prohibited"
//   - "Section 7.2.1"          (subsection numbering)
// Headings on a separate line (common in older docs) are NOT captured by
// v1 — the article/section number alone is the load-bearing data. If a doc
// uses an unrecognized format the chunker falls back gracefully: chunks
// ship without breadcrumb metadata and retrieval still works (just less
// precise citations from the model).
// ----------------------------------------------------------------------------
// Heading-text capture is generous about what counts as a separator: any
// combination of whitespace, period, dash, em-dash, en-dash, or colon. Real
// declarations use all of these inconsistently:
//   "Section 7.1 Residential Use Only."   (just whitespace)
//   "Section 7.1. Use Restrictions."       (period)
//   "Section 7.1 — Definitions"            (em-dash)
//   "Section 7.1: Trade or Business."       (colon)
//   "Section 7.1"                          (no heading at all)
// Article number accepts Roman ("VII"), Arabic ("5"), or dotted-decimal
// ("5.7") — Canyon Gate's bylaws use dotted Article numbers as a primary
// citation scheme. The regex captures the full string, which retrieval
// surfaces as-is so the model cites verbatim.
const ARTICLE_RE = /^\s*(?:ARTICLE|Article)\s+([IVXLCDM]+|\d+(?:\.\d+)*)\b(?:[\s.\-–—:]+(.{1,80}?))?\s*$/;
const SECTION_RE = /^\s*(?:SECTION|Section|Sec\.)\s+(\d+(?:\.\d+)*)\b(?:[\s.\-–—:]+(.{1,80}?))?\s*$/;

function chunkText(text, chunkSize = 1000, overlap = 200) {
  if (!text) return [];

  // Pre-pass: walk lines, build a position-indexed breadcrumb timeline.
  // Each entry holds the article + section state as of that line start.
  // When an Article transitions, the Section state resets (we're in a new
  // article, the prior section context is no longer current).
  const breadcrumbs = [];
  let pos = 0;
  let article = null, articleHeading = null;
  let section = null, sectionHeading = null;

  const lines = text.split('\n');
  for (const line of lines) {
    const am = line.match(ARTICLE_RE);
    if (am) {
      article = am[1];
      articleHeading = (am[2] || '').trim() || null;
      section = null;
      sectionHeading = null;
    } else {
      const sm = line.match(SECTION_RE);
      if (sm) {
        section = sm[1];
        sectionHeading = (sm[2] || '').trim() || null;
      }
    }
    breadcrumbs.push({ startPos: pos, article, articleHeading, section, sectionHeading });
    pos += line.length + 1; // +1 for the \n consumed by split
  }

  // Binary-search helper: find the most recent breadcrumb at or before pos.
  function breadcrumbAt(targetPos) {
    let lo = 0, hi = breadcrumbs.length - 1, best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (breadcrumbs[mid].startPos <= targetPos) {
        best = breadcrumbs[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best || { article: null, articleHeading: null, section: null, sectionHeading: null };
  }

  // Diagnostic: count distinct articles + sections detected. Lets the
  // operator see at index time whether the chunker found real structure
  // or whether the doc's formatting evaded the patterns (chunks ship
  // either way — graceful fallback).
  const distinctArticles = new Set(breadcrumbs.filter((b) => b.article).map((b) => b.article)).size;
  const distinctSections = new Set(
    breadcrumbs.filter((b) => b.section).map((b) => `${b.article || '_'}::${b.section}`)
  ).size;
  console.log(`[chunkText] ${text.length} chars → ${distinctArticles} articles, ${distinctSections} sections detected`);

  // Main chunking pass — slide the window, attach the breadcrumb at the
  // END of each chunk. End-anchored (not start or middle) is correct:
  //   - If the chunk contains a heading transition, the breadcrumb after
  //     that transition wins — the chunk's body content is anchored on
  //     the newest heading it saw.
  //   - If the chunk is pure body with no heading inside, the breadcrumb
  //     inherits from the prior section (correct — that's the section
  //     this body belongs to).
  //   - Start-anchored failed when a chunk straddled a boundary mid-text.
  //   - Mid-anchored failed when a heading transition fell after the
  //     middle of the chunk (Test 5 — Section 2.1 chunk).
  // Validated by scripts/test_chunker_structure.js — end-anchored passes
  // all 16 assertions across the 5 declaration shapes.
  const out = [];
  let start = 0;
  while (start < text.length) {
    const content = text.slice(start, start + chunkSize);
    const endPos = start + Math.max(0, content.length - 1);
    const bc = breadcrumbAt(endPos);
    out.push({
      content,
      article: bc.article,
      articleHeading: bc.articleHeading,
      section: bc.section,
      sectionHeading: bc.sectionHeading,
    });
    start += chunkSize - overlap;
  }
  return out;
}

async function getEmbedding(openai, text) {
  const r = await openai.embeddings.create({
    model: 'text-embedding-ada-002',
    input: text.replace(/\n/g, ' ').slice(0, 8000),
  });
  return r.data[0].embedding;
}

// Insert with retry. A single transient `fetch failed` to Supabase silently
// dropped ~3 governing-doc chunks from knowledge_chunks (the LETTER-citation
// store) on 2026-07-02 — the exact store we re-OCR to fix. A dropped §3.12
// chunk = a silent citation gap. Retry transient errors with backoff; return
// the final error so the caller can decide (documents = fatal, knowledge_chunks
// = warn) rather than letting one blip corrupt the index.
async function insertWithRetry(supabase, table, rows, attempts = 4) {
  let lastErr = null;
  for (let a = 0; a < attempts; a++) {
    const { error } = await supabase.from(table).insert(rows);
    if (!error) return { error: null };
    lastErr = error;
    // Only retry TRANSIENT failures (network blips, timeouts, 5xx). A
    // constraint violation (duplicate key, FK, check) is PERMANENT — retrying
    // it 4× just wastes time and masks the real cause. Seen 2026-07-02 when a
    // double-launched re-OCR raced and produced duplicate (document_id,
    // chunk_index) keys; the retries were pointless.
    const msg = (error.message || '').toLowerCase();
    const transient = /fetch failed|timeout|timed out|network|socket|econn|terminated|503|502|429|too many|temporarily/.test(msg);
    if (!transient) return { error };
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 400 * (a + 1)));
  }
  return { error: lastErr };
}

// indexLibraryDoc — download + extract + chunk + embed + insert into the
// chunks table askEd reads from. Idempotent: deletes prior chunks for this
// library_documents.id before inserting so re-runs don't duplicate.
//
// Also writes index lifecycle state back to library_documents:
//   - success                → index_status='indexed', last_index_error=null
//   - failure                → index_attempt_count++, last_index_error set,
//                              index_status='failed' (or 'failed_permanent'
//                              after MAX_INDEX_ATTEMPTS to stop poison-pill
//                              docs from monopolizing the queue budget)
//   - last_index_attempt_at  → set on every call (success or failure)
//
// Inputs:
//   supabase  — Supabase client (service-role)
//   openai    — OpenAI client
//   libraryDoc — row from library_documents with at minimum {id, file_path,
//                file_name_original, file_name_normalized, category,
//                period_label, community_id, community_name?}
//
// Returns: { ok, reason, chunks_inserted, community }
const MAX_INDEX_ATTEMPTS = 3;

async function _markIndexed(supabase, libraryDocId) {
  try {
    await supabase
      .from('library_documents')
      .update({
        index_status: 'indexed',
        last_index_attempt_at: new Date().toISOString(),
        last_index_error: null,
      })
      .eq('id', libraryDocId);
  } catch (e) {
    console.warn('[reindex] mark indexed failed:', e.message);
  }
}

async function _markFailed(supabase, libraryDocId, reason, error) {
  try {
    // Read current attempt count to decide pending-vs-permanent. Single
    // round trip — small price for the right gating behavior.
    const { data: cur } = await supabase
      .from('library_documents')
      .select('index_attempt_count')
      .eq('id', libraryDocId)
      .maybeSingle();
    const nextCount = ((cur && cur.index_attempt_count) || 0) + 1;
    const nextStatus = nextCount >= MAX_INDEX_ATTEMPTS ? 'failed_permanent' : 'failed';
    const errMsg = (error && error.message) || error || reason || 'unknown_error';
    await supabase
      .from('library_documents')
      .update({
        index_status: nextStatus,
        index_attempt_count: nextCount,
        last_index_attempt_at: new Date().toISOString(),
        last_index_error: String(errMsg).slice(0, 2000),
      })
      .eq('id', libraryDocId);
  } catch (e) {
    console.warn('[reindex] mark failed failed:', e.message);
  }
}

async function indexLibraryDoc(supabase, openai, libraryDoc, opts = {}) {
  if (!libraryDoc || !libraryDoc.file_path) {
    return { ok: false, reason: 'no_file_path', chunks_inserted: 0 };
  }
  // Wrap the meat of the pipeline in try/catch so that ANY thrown error
  // (storage 500, OpenAI rate limit, OOM during PDF page split, etc.) still
  // updates library_documents.index_status — otherwise the doc would silently
  // re-queue forever. The catch re-throws so callers (drainUnindexedQueue)
  // still see the exception in their summary counters.
  try {
  // 1. Download from storage
  const { data: blob, error: dlErr } = await supabase.storage
    .from('documents')
    .download(libraryDoc.file_path);
  if (dlErr || !blob) {
    await _markFailed(supabase, libraryDoc.id, 'download_failed', dlErr);
    return { ok: false, reason: 'download_failed', error: dlErr && dlErr.message, chunks_inserted: 0 };
  }
  const buffer = Buffer.from(await blob.arrayBuffer());

  // 2. Extract text (with OCR fallback for image-only scanned PDFs)
  const filename = libraryDoc.file_name_normalized || libraryDoc.file_name_original || `${libraryDoc.id}.pdf`;
  const { text, ocrUsed } = await extractFullTextFromFile(buffer, filename, { forceOcr: !!opts.forceOcr });
  if (!text || text.replace(/\s+/g, '').length < MIN_TEXT_CHARS) {
    await _markFailed(supabase, libraryDoc.id, 'no_text_extracted');
    return { ok: false, reason: 'no_text_extracted', chunks_inserted: 0 };
  }

  // 3. Resolve community name (chunks table stores name, not id).
  // Audit 2026-06-04: previously this stamped TWO different sentinels for
  // the same not-found condition — 'Unknown' (community_id set but join
  // missed) and 'General' (no community_id at all). The hybrid retrieval
  // includes 'General' in every query's fallback array but NEVER 'Unknown',
  // so 'Unknown'-tagged chunks were permanently invisible to search. The
  // Quail Ridge Declaration 2026-06-04 STR-question miss was this exact
  // failure mode. Now: single fallback to 'General' with a loud warning
  // when a doc's community_id can't be resolved, so the operator sees the
  // orphan in logs and the chunks are at least retrievable.
  let communityName = libraryDoc.community_name || null;
  if (!communityName && libraryDoc.community_id) {
    const { data: c } = await supabase
      .from('communities')
      .select('name')
      .eq('id', libraryDoc.community_id)
      .maybeSingle();
    if (c && c.name) {
      communityName = c.name;
    } else {
      console.warn(`[reindex] library_doc ${libraryDoc.id} has community_id=${libraryDoc.community_id} but no matching communities row — tagging as General; fix the FK or null community_id.`);
    }
  }
  if (!communityName) communityName = 'General';

  // 4. Wipe prior chunks for THIS library doc so re-indexes don't duplicate.
  //    Dual-target wipe: legacy `documents` (where callers still read via
  //    match_documents) AND the unified substrate's `knowledge_chunks` (where
  //    askEd reads via match_knowledge_chunks). Migration 072 created the
  //    parent knowledge_documents row; we resolve it here, then delete its
  //    chunks. Idempotent on re-index.
  // Two link paths to delete (new-ingestion metadata blob + legacy-promotion
  // SQL column). Without the second, a reindex of a legacy-promoted doc
  // leaves the old chunks orphaned, which then double-count in retrieval.
  // Ed 2026-06-16 class audit.
  try {
    await Promise.all([
      supabase.from('documents').delete().filter('metadata->>library_document_id', 'eq', libraryDoc.id),
      supabase.from('documents').delete().eq('migrated_to_library_id', libraryDoc.id),
    ]);
  } catch (e) { console.warn('[reindex] delete prior chunks (legacy) failed:', e.message); }

  // Find existing parent knowledge_documents row for this library doc, if any.
  let parentKdocId = null;
  try {
    const { data: existingParent } = await supabase
      .from('knowledge_documents')
      .select('id')
      .eq('source_type', 'library_doc')
      .eq('source_record_id', libraryDoc.id)
      .maybeSingle();
    parentKdocId = existingParent?.id || null;
    if (parentKdocId) {
      await supabase.from('knowledge_chunks').delete().eq('document_id', parentKdocId);
    }
  } catch (e) { console.warn('[reindex] prior knowledge_chunks cleanup failed:', e.message); }

  // 4b. Ensure a parent knowledge_documents row exists for this library doc.
  //     Migration 072 backfilled existing rows; this branch handles brand-new
  //     library uploads that ran indexLibraryDoc for the first time.
  if (!parentKdocId) {
    try {
      const { data: newParent, error: parentErr } = await supabase
        .from('knowledge_documents')
        .insert({
          management_company_id: libraryDoc.management_company_id,
          title: libraryDoc.file_name_original || filename,
          source_type: 'library_doc',
          file_name: libraryDoc.file_name_original || filename,
          community_id: libraryDoc.community_id || null,
          source_record_id: libraryDoc.id,
          status: 'active',
          ingested_at: new Date().toISOString(),
          model_version: 'text-embedding-ada-002@v1',
          access_level: 'staff_internal',
        })
        .select('id')
        .single();
      if (parentErr) throw parentErr;
      parentKdocId = newParent.id;
    } catch (e) {
      console.warn('[reindex] knowledge_documents parent create failed:', e.message);
      parentKdocId = null; // dual-write fails open — legacy `documents` still gets the chunks
    }
  }

  // 5. Chunk + embed + insert (concurrency 3 to respect OpenAI rate limits).
  // chunkText now returns {content, article, articleHeading, section,
  // sectionHeading} objects (Ed 2026-06-04, structure-aware chunking). Each
  // chunk's breadcrumb metadata gets stamped onto the documents row so
  // hybrid_retrieval can surface "Article VII / Section 7.2" in the chunk
  // header and the model can cite verbatim.
  const chunks = chunkText(text);
  let inserted = 0;
  let kchunkIndex = 0;
  let kInsertFailures = 0;
  let sampleLogged = false;
  const concurrency = 3;
  for (let i = 0; i < chunks.length; i += concurrency) {
    const batch = chunks.slice(i, i + concurrency).filter((c) => c.content.trim().length > 20);
    const embedded = await Promise.all(batch.map(async (chunk) => {
      try {
        const embedding = await getEmbedding(openai, chunk.content);
        return { chunk, embedding };
      } catch (e) {
        console.warn('[reindex] embed failed:', e.message);
        return null;
      }
    }));
    const good = embedded.filter(Boolean);
    if (good.length === 0) continue;

    // Diagnostic: log the first batch's breadcrumb assignments so we can see
    // immediately whether the chunker latched onto real structure for this
    // doc, or whether the formatting evaded the patterns (in which case
    // article/section will be null and we'll know to add a pattern variant).
    if (!sampleLogged && good.length > 0) {
      const samples = good.slice(0, 3).map(({ chunk }) => ({
        article: chunk.article,
        section: chunk.section,
        head: chunk.sectionHeading || chunk.articleHeading || null,
        preview: chunk.content.slice(0, 80).replace(/\s+/g, ' ').trim(),
      }));
      console.log(`[reindex] "${filename}" first chunks:`, JSON.stringify(samples));
      sampleLogged = true;
    }

    // Write to legacy `documents` (existing read-path).
    const legacyRows = good.map(({ chunk, embedding }) => {
      const metadata = {
        filename,
        community: communityName,
        library_document_id: libraryDoc.id,
        category: libraryDoc.category || null,
        period: libraryDoc.period_label || null,
      };
      if (ocrUsed) metadata.ocr = true;
      // Stamp structural breadcrumb if the chunker detected one. Only set
      // non-null values so chunks from docs without article/section structure
      // (e.g., a vendor invoice) don't carry meaningless nulls.
      if (chunk.article) metadata.article = chunk.article;
      if (chunk.articleHeading) metadata.article_heading = chunk.articleHeading;
      if (chunk.section) metadata.section = chunk.section;
      if (chunk.sectionHeading) metadata.section_heading = chunk.sectionHeading;
      return { content: chunk.content, metadata, embedding };
    });
    const { error: legacyErr } = await insertWithRetry(supabase, 'documents', legacyRows);
    if (legacyErr) { console.warn('[reindex] legacy insert failed:', legacyErr.message); continue; }

    // Dual-write to `knowledge_chunks` (unified substrate, askEd search).
    // knowledge_chunks has no metadata column so structure breadcrumbs only
    // live in the legacy `documents` table for now — that's the table the
    // hybrid retrieval reads from, so the breadcrumb is surfaced correctly.
    // If/when the unified substrate becomes the read-path, add a metadata
    // jsonb column to knowledge_chunks and mirror these fields here.
    if (parentKdocId) {
      const kchunkRows = good.map(({ chunk, embedding }) => ({
        document_id:   parentKdocId,
        chunk_index:   kchunkIndex++,
        text:          chunk.content,
        embedding,
        model_version: 'text-embedding-ada-002@v1',
      }));
      const { error: kErr } = await insertWithRetry(supabase, 'knowledge_chunks', kchunkRows);
      if (kErr) {
        console.warn('[reindex] knowledge_chunks insert failed after retries:', kErr.message);
        kInsertFailures += kchunkRows.length;
      }
    }

    inserted += good.length;
  }

  // Update chunk_count on parent for accurate reporting / coverage queries.
  if (parentKdocId && inserted > 0) {
    try {
      await supabase
        .from('knowledge_documents')
        .update({ chunk_count: inserted, updated_at: new Date().toISOString() })
        .eq('id', parentKdocId);
    } catch (e) { /* non-critical */ }
  }

  if (inserted > 0) {
    await _markIndexed(supabase, libraryDoc.id);
  } else {
    await _markFailed(supabase, libraryDoc.id, 'no_chunks_inserted');
  }

  return {
    ok: inserted > 0,
    reason: inserted > 0 ? null : 'no_chunks_inserted',
    chunks_inserted: inserted,
    knowledge_chunk_failures: kInsertFailures,
    community: communityName,
    ocr_used: ocrUsed,
    parent_knowledge_doc_id: parentKdocId,
  };
  } catch (err) {
    await _markFailed(supabase, libraryDoc.id, 'exception', err);
    throw err;
  }
}

module.exports = {
  communityNameVariations,
  extractFullTextFromFile,
  chunkText,
  getEmbedding,
  indexLibraryDoc,
  ASKED_SKIP_CATEGORIES,
};
