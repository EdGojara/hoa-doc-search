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

async function extractFullTextFromFile(buffer, filename) {
  const ext = (filename || '').toLowerCase().match(/\.(\w+)$/)?.[1] || 'pdf';
  if (ext === 'pdf') {
    try {
      const data = await pdfParse(buffer);
      return data.text || '';
    } catch (e) {
      console.warn('[reindex] pdf-parse failed for', filename, e.message);
      return '';
    }
  }
  if (ext === 'docx' || ext === 'doc') {
    try {
      const mammoth = _lazyMammoth();
      const result = await mammoth.extractRawText({ buffer });
      return result.value || '';
    } catch (e) {
      console.warn('[reindex] mammoth failed for', filename, e.message);
      return '';
    }
  }
  if (ext === 'txt') {
    try { return buffer.toString('utf8'); } catch (_) { return ''; }
  }
  return '';
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

  // 2. Extract text
  const filename = libraryDoc.file_name_normalized || libraryDoc.file_name_original || `${libraryDoc.id}.pdf`;
  const text = await extractFullTextFromFile(buffer, filename);
  if (!text || text.replace(/\s+/g, '').length < 50) {
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
  try {
    await supabase
      .from('documents')
      .delete()
      .filter('metadata->>library_document_id', 'eq', libraryDoc.id);
  } catch (e) { console.warn('[reindex] delete prior chunks failed:', e.message); }

  // 5. Chunk + embed + insert (concurrency 3 to respect OpenAI rate limits)
  const chunks = chunkText(text);
  let inserted = 0;
  const concurrency = 3;
  for (let i = 0; i < chunks.length; i += concurrency) {
    const batch = chunks.slice(i, i + concurrency).filter((c) => c.trim().length > 20);
    const rows = await Promise.all(batch.map(async (chunk) => {
      try {
        const embedding = await getEmbedding(openai, chunk);
        return {
          content: chunk,
          metadata: {
            filename,
            community: communityName,
            library_document_id: libraryDoc.id,
            category: libraryDoc.category || null,
            period: libraryDoc.period_label || null,
          },
          embedding,
        };
      } catch (e) {
        console.warn('[reindex] embed failed:', e.message);
        return null;
      }
    }));
    const goodRows = rows.filter(Boolean);
    if (goodRows.length === 0) continue;
    const { error: insErr } = await supabase.from('documents').insert(goodRows);
    if (insErr) { console.warn('[reindex] insert failed:', insErr.message); continue; }
    inserted += goodRows.length;
  }

  return {
    ok: inserted > 0,
    reason: inserted > 0 ? null : 'no_chunks_inserted',
    chunks_inserted: inserted,
    community: communityName,
  };
}

module.exports = {
  communityNameVariations,
  extractFullTextFromFile,
  chunkText,
  getEmbedding,
  indexLibraryDoc,
};
