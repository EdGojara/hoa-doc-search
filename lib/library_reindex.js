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
async function extractFullTextFromFile(buffer, filename) {
  const ext = (filename || '').toLowerCase().match(/\.(\w+)$/)?.[1] || 'pdf';
  if (ext === 'pdf') {
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

function chunkText(text, chunkSize = 1000, overlap = 200) {
  const out = [];
  if (!text) return out;
  let start = 0;
  while (start < text.length) {
    out.push(text.slice(start, start + chunkSize));
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

// indexLibraryDoc — download + extract + chunk + embed + insert into the
// chunks table askEd reads from. Idempotent: deletes prior chunks for this
// library_documents.id before inserting so re-runs don't duplicate.
//
// Inputs:
//   supabase  — Supabase client (service-role)
//   openai    — OpenAI client
//   libraryDoc — row from library_documents with at minimum {id, file_path,
//                file_name_original, file_name_normalized, category,
//                period_label, community_id, community_name?}
//
// Returns: { ok, reason, chunks_inserted, community }
async function indexLibraryDoc(supabase, openai, libraryDoc) {
  if (!libraryDoc || !libraryDoc.file_path) {
    return { ok: false, reason: 'no_file_path', chunks_inserted: 0 };
  }
  // 1. Download from storage
  const { data: blob, error: dlErr } = await supabase.storage
    .from('documents')
    .download(libraryDoc.file_path);
  if (dlErr || !blob) {
    return { ok: false, reason: 'download_failed', error: dlErr && dlErr.message, chunks_inserted: 0 };
  }
  const buffer = Buffer.from(await blob.arrayBuffer());

  // 2. Extract text (with OCR fallback for image-only scanned PDFs)
  const filename = libraryDoc.file_name_normalized || libraryDoc.file_name_original || `${libraryDoc.id}.pdf`;
  const { text, ocrUsed } = await extractFullTextFromFile(buffer, filename);
  if (!text || text.replace(/\s+/g, '').length < MIN_TEXT_CHARS) {
    return { ok: false, reason: 'no_text_extracted', chunks_inserted: 0 };
  }

  // 3. Resolve community name (chunks table stores name, not id)
  let communityName = libraryDoc.community_name || null;
  if (!communityName && libraryDoc.community_id) {
    const { data: c } = await supabase
      .from('communities')
      .select('name')
      .eq('id', libraryDoc.community_id)
      .maybeSingle();
    communityName = (c && c.name) || 'Unknown';
  }
  if (!communityName) communityName = 'General';

  // 4. Wipe prior chunks for THIS library doc so re-indexes don't duplicate.
  //    Dual-target wipe: legacy `documents` (where callers still read via
  //    match_documents) AND the unified substrate's `knowledge_chunks` (where
  //    askEd reads via match_knowledge_chunks). Migration 072 created the
  //    parent knowledge_documents row; we resolve it here, then delete its
  //    chunks. Idempotent on re-index.
  try {
    await supabase
      .from('documents')
      .delete()
      .filter('metadata->>library_document_id', 'eq', libraryDoc.id);
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

  // 5. Chunk + embed + insert (concurrency 3 to respect OpenAI rate limits)
  const chunks = chunkText(text);
  let inserted = 0;
  let kchunkIndex = 0;
  const concurrency = 3;
  for (let i = 0; i < chunks.length; i += concurrency) {
    const batch = chunks.slice(i, i + concurrency).filter((c) => c.trim().length > 20);
    const embedded = await Promise.all(batch.map(async (chunk) => {
      try {
        const embedding = await getEmbedding(openai, chunk);
        return { chunk, embedding };
      } catch (e) {
        console.warn('[reindex] embed failed:', e.message);
        return null;
      }
    }));
    const good = embedded.filter(Boolean);
    if (good.length === 0) continue;

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
      return { content: chunk, metadata, embedding };
    });
    const { error: legacyErr } = await supabase.from('documents').insert(legacyRows);
    if (legacyErr) { console.warn('[reindex] legacy insert failed:', legacyErr.message); continue; }

    // Dual-write to `knowledge_chunks` (unified substrate, askEd search).
    if (parentKdocId) {
      const kchunkRows = good.map(({ chunk, embedding }) => ({
        document_id:   parentKdocId,
        chunk_index:   kchunkIndex++,
        text:          chunk,
        embedding,
        model_version: 'text-embedding-ada-002@v1',
      }));
      const { error: kErr } = await supabase.from('knowledge_chunks').insert(kchunkRows);
      if (kErr) console.warn('[reindex] knowledge_chunks insert failed:', kErr.message);
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

  return {
    ok: inserted > 0,
    reason: inserted > 0 ? null : 'no_chunks_inserted',
    chunks_inserted: inserted,
    community: communityName,
    ocr_used: ocrUsed,
    parent_knowledge_doc_id: parentKdocId,
  };
}

module.exports = {
  communityNameVariations,
  extractFullTextFromFile,
  chunkText,
  getEmbedding,
  indexLibraryDoc,
};
