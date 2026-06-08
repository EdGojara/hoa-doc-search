// ============================================================================
// lib/kb/ingest.js — Knowledge Base article ingest pipeline
// ----------------------------------------------------------------------------
// Ed 2026-06-08 — Take an article (pasted text), chunk it, embed each chunk,
// and write to the unified knowledge substrate so the hybrid retriever finds
// it for both Claire (voice) and askEd (chat).
//
// DUAL-WRITE PATTERN (mirrors lib/library_reindex.js):
//   1. INSERT kb_articles row (metadata + raw content)
//   2. INSERT knowledge_documents parent (so chunks share the unified parent FK)
//   3. For each chunk: INSERT into knowledge_chunks (unified read path) AND
//      into documents (legacy read path — what hybrid_retrieval.js queries today)
//   4. Update kb_articles.parent_knowledge_doc_id + chunk_count
//
// CHUNKING STRATEGY:
//   - Heading-aware: split on markdown H1/H2/H3 (or all-caps lines), then
//     pack paragraphs into ~1000-char windows with 200-char overlap.
//   - Each chunk carries its heading breadcrumb in metadata, surfaced by
//     hybrid_retrieval as "<KB: Title — Heading>".
//
// FAILURE HANDLING:
//   - Idempotent on content_hash: re-ingesting the same article body returns
//     the existing row (no duplicate chunks).
//   - If embedding fails for a chunk, the others still write; the failed
//     chunk is logged and the article's chunk_count reflects what actually
//     persisted.
// ============================================================================

const crypto = require('crypto');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMBEDDING_MODEL = 'text-embedding-ada-002';
const MODEL_VERSION = `${EMBEDDING_MODEL}@v1`;
const MAX_CHUNK_CHARS = 1100;
const OVERLAP_CHARS = 200;
const MIN_CHUNK_CHARS = 60;

// Bedrock management company id — used as the tenant key on knowledge_documents.
// Same constant used elsewhere in the codebase.
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

// ----------------------------------------------------------------------------
// chunkArticle — heading-aware paragraph chunker.
// Returns [{ content, heading_path, char_offset }]
// ----------------------------------------------------------------------------
function chunkArticle(content) {
  const text = String(content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text.trim()) return [];

  // Identify heading positions. Recognize:
  //   - Markdown: '# Heading', '## Heading', '### Heading'
  //   - All-caps single-line that looks like a heading (60 char max)
  //   - Title Case Lines With No Trailing Punctuation under ~80 chars
  const lines = text.split('\n');
  const headings = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (!ln) continue;
    // Markdown heading
    const mdMatch = /^(#{1,3})\s+(.+?)\s*$/.exec(ln);
    if (mdMatch) {
      headings.push({ lineIdx: i, level: mdMatch[1].length, text: mdMatch[2].trim() });
      continue;
    }
    // Sentence-cased short line that isn't a paragraph or list — likely a heading
    if (ln.length > 0 && ln.length <= 80 && !/[.!?,:;]$/.test(ln) && !/^[-•*\d]/.test(ln)) {
      // Heuristic: must have at least one capital letter and be followed by a blank line OR content
      const isCapitalish = /[A-Z]/.test(ln) && (ln === ln.toUpperCase() || /^[A-Z][a-z]/.test(ln));
      const next = (lines[i + 1] || '').trim();
      const prev = (lines[i - 1] || '').trim();
      if (isCapitalish && (prev === '' || next === '' || /^[A-Z]/.test(next))) {
        headings.push({ lineIdx: i, level: 2, text: ln });
      }
    }
  }

  // Walk segments between heading boundaries
  const segments = [];
  if (headings.length === 0) {
    segments.push({ heading_path: [], body: text });
  } else {
    // Pre-heading body (intro)
    if (headings[0].lineIdx > 0) {
      const intro = lines.slice(0, headings[0].lineIdx).join('\n').trim();
      if (intro) segments.push({ heading_path: [], body: intro });
    }
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      const endIdx = i + 1 < headings.length ? headings[i + 1].lineIdx : lines.length;
      const body = lines.slice(h.lineIdx + 1, endIdx).join('\n').trim();
      if (!body) continue;
      // Build heading path from current + ancestor headings (level-based)
      const path = [];
      for (let j = 0; j <= i; j++) {
        const candidate = headings[j];
        if (candidate.level <= h.level) {
          // Replace any previous at this or deeper level
          while (path.length && path[path.length - 1].level >= candidate.level) path.pop();
          path.push(candidate);
        }
      }
      segments.push({ heading_path: path.map(p => p.text), body });
    }
  }

  // Pack each segment into ~1000-char windows with overlap
  const chunks = [];
  for (const seg of segments) {
    const body = seg.body;
    if (body.length <= MAX_CHUNK_CHARS) {
      if (body.length >= MIN_CHUNK_CHARS) {
        chunks.push({ content: body, heading_path: seg.heading_path });
      }
      continue;
    }
    let pos = 0;
    while (pos < body.length) {
      let end = Math.min(pos + MAX_CHUNK_CHARS, body.length);
      // Snap to nearest sentence boundary if possible
      if (end < body.length) {
        const snap = body.lastIndexOf('. ', end);
        if (snap > pos + MIN_CHUNK_CHARS) end = snap + 1;
      }
      const piece = body.slice(pos, end).trim();
      if (piece.length >= MIN_CHUNK_CHARS) {
        chunks.push({ content: piece, heading_path: seg.heading_path });
      }
      if (end >= body.length) break;
      pos = end - OVERLAP_CHARS;
      if (pos < 0) pos = 0;
    }
  }

  return chunks;
}

// ----------------------------------------------------------------------------
// embedBatch — embed up to N strings in one OpenAI call.
// ----------------------------------------------------------------------------
async function embedBatch(texts) {
  const res = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  return res.data.map(d => d.embedding);
}

// ----------------------------------------------------------------------------
// ingestArticle — orchestration
//
// @param {object} supabase
// @param {{
//   title: string,
//   content_md: string,
//   source_url?: string,
//   source_publisher?: string,
//   jurisdiction?: 'TX'|'federal'|'multi_state'|'other',
//   source_quality: 'primary_statute'|'court_opinion'|'regulator_guidance'|'attorney_alert'|'commentary'|'internal',
//   topics?: string[],
//   summary?: string,
//   published_at?: string (YYYY-MM-DD),
//   ingested_by?: string,
// }} opts
// @returns {Promise<{ ok: boolean, article_id: string, chunk_count: number,
//                     deduped?: boolean, error?: string }>}
// ----------------------------------------------------------------------------
async function ingestArticle(supabase, opts) {
  const required = ['title', 'content_md', 'source_quality'];
  for (const k of required) {
    if (!opts[k]) return { ok: false, error: `${k}_required` };
  }
  const content = String(opts.content_md).trim();
  if (content.length < 200) {
    return { ok: false, error: 'content_too_short', detail: 'Need at least 200 characters of content.' };
  }

  const contentHash = crypto.createHash('sha256').update(content).digest('hex');

  // Dedup check
  const { data: existing } = await supabase
    .from('kb_articles')
    .select('id, title, chunk_count, status')
    .eq('content_hash', contentHash)
    .maybeSingle();
  if (existing) {
    return { ok: true, article_id: existing.id, chunk_count: existing.chunk_count, deduped: true };
  }

  // 1. Insert kb_articles row
  const { data: article, error: artErr } = await supabase
    .from('kb_articles')
    .insert({
      title: opts.title.trim(),
      source_url: opts.source_url || null,
      source_publisher: opts.source_publisher || null,
      jurisdiction: opts.jurisdiction || 'TX',
      source_quality: opts.source_quality,
      topics: opts.topics || [],
      summary: opts.summary || null,
      content_md: content,
      content_hash: contentHash,
      published_at: opts.published_at || null,
      ingested_by: opts.ingested_by || null,
    })
    .select('id')
    .single();
  if (artErr) return { ok: false, error: 'article_insert_failed', detail: artErr.message };

  // 2. Insert knowledge_documents parent
  let parentId = null;
  try {
    const { data: parent, error: pErr } = await supabase
      .from('knowledge_documents')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        title: opts.title.trim(),
        source_type: 'kb_article',
        vendor: opts.source_publisher || null,
        file_name: opts.title.trim().slice(0, 200),
        status: 'active',
        access_level: 'staff_internal',
        source_record_id: article.id,
        model_version: MODEL_VERSION,
        ingested_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (pErr) throw pErr;
    parentId = parent.id;
  } catch (e) {
    console.warn('[kb-ingest] knowledge_documents parent insert failed (non-fatal):', e.message);
  }

  // 3. Chunk + embed + write
  const chunks = chunkArticle(content);
  if (chunks.length === 0) {
    return { ok: true, article_id: article.id, chunk_count: 0, warning: 'no_chunks_extracted' };
  }

  let inserted = 0;
  const concurrency = 3;
  for (let i = 0; i < chunks.length; i += concurrency) {
    const batch = chunks.slice(i, i + concurrency);
    let embeddings;
    try {
      embeddings = await embedBatch(batch.map(c => c.content));
    } catch (e) {
      console.warn(`[kb-ingest] embed batch failed at i=${i}:`, e.message);
      continue;
    }

    // Build rows for both tables
    const legacyRows = batch.map((c, j) => ({
      content: c.content,
      embedding: embeddings[j],
      metadata: {
        kb_article_id: article.id,
        title: opts.title.trim(),
        source_publisher: opts.source_publisher || null,
        source_url: opts.source_url || null,
        jurisdiction: opts.jurisdiction || 'TX',
        source_quality: opts.source_quality,
        topics: opts.topics || [],
        heading_path: c.heading_path || [],
        source_type: 'kb_article',
      },
    }));

    // Write to legacy `documents` (hybrid_retrieval reads here)
    const { error: legacyErr } = await supabase.from('documents').insert(legacyRows);
    if (legacyErr) {
      console.warn('[kb-ingest] legacy documents insert failed:', legacyErr.message);
      // Don't continue — without legacy insert the chunks won't be retrievable.
      continue;
    }

    // Write to unified knowledge_chunks if parent exists
    if (parentId) {
      const kchunkRows = batch.map((c, j) => ({
        document_id: parentId,
        chunk_index: inserted + j,
        text: c.content,
        section_heading: (c.heading_path || []).join(' › ') || null,
        embedding: embeddings[j],
        model_version: MODEL_VERSION,
      }));
      const { error: kErr } = await supabase.from('knowledge_chunks').insert(kchunkRows);
      if (kErr) {
        console.warn('[kb-ingest] knowledge_chunks insert failed (non-fatal):', kErr.message);
      }
    }

    inserted += batch.length;
  }

  // 4. Update kb_articles + knowledge_documents with chunk counts
  await supabase
    .from('kb_articles')
    .update({ parent_knowledge_doc_id: parentId, chunk_count: inserted })
    .eq('id', article.id);
  if (parentId) {
    await supabase
      .from('knowledge_documents')
      .update({ chunk_count: inserted })
      .eq('id', parentId);
  }

  return { ok: true, article_id: article.id, chunk_count: inserted };
}

module.exports = {
  ingestArticle,
  chunkArticle,
  EMBEDDING_MODEL,
};
