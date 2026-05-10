// ============================================================================
// Operational Training Layer (Help)
// ----------------------------------------------------------------------------
// Endpoints under /api/help for:
//   - POST /ingest    Drop a PDF (admin guide, SOP, agreement). Claude
//                     extracts text page-by-page, chunks it, OpenAI embeds
//                     each chunk, results stored for semantic search.
//   - POST /query     Ask a question (with optional workflow context). Top
//                     chunks retrieved by cosine similarity, Claude
//                     synthesizes answer in askEd 4-part template (Action /
//                     Output / Reasoning / Watch Outs) with source citations.
//   - GET  /documents List ingested documents (what knowledge is loaded).
//   - DELETE /documents/:id  Remove a document (and its chunks via cascade).
//
// Design principles applied (from locked-in standards):
//   - askEd 4-part template — every Claude answer follows this structure
//   - Proactive Guidance — answers cite specific pages; no "see the docs"
//   - Frustration Test — query latency budget < 6s; clear empty states
//   - Fire-Myself Test — answers in Bedrock voice, not generic AI
// ============================================================================

const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const multer = require('multer');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const EMBEDDING_MODEL = 'text-embedding-ada-002';   // matches existing askEd stack
const EMBEDDING_DIMS = 1536;

const router = express.Router();

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Ask Claude to extract structured text from a PDF, page by page, with
 * section headings preserved. Returns an array of page objects.
 */
async function extractPdfPages(pdfBuffer) {
  const pdfBase64 = pdfBuffer.toString('base64');
  const completion = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text:
          `Extract the text content of this PDF page by page. Return a JSON array where each element is:
{ "page_number": <int>, "section_heading": <string or null>, "text": <string> }

Rules:
- One element per page
- section_heading: the most recent heading/section title that applies to this page's content. Look for bold headers, capitalized titles, or numbered section markers. If unclear, use null.
- text: clean, plain-text content of the page. Strip page numbers, headers/footers, and "Updated MM.YYYY" timestamps. Preserve list structure with "- " for bullets and numbered items.
- If a page is a TOC, cover, or blank, still include it but mark the section_heading as "Table of Contents", "Cover", or "Blank" and put the literal content in text.

Return ONLY the JSON array, no preamble, no code fence.`
        }
      ]
    }]
  });

  const raw = completion.content?.[0]?.text || '';
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return { pages: JSON.parse(cleaned), usage: completion.usage };
}

/**
 * Split a string into ~targetTokens-sized chunks with overlap. Token count
 * is approximated as words × 1.3 (rough heuristic that works well enough
 * for English admin docs).
 */
function chunkText(text, targetTokens = 500, overlapTokens = 60) {
  const words = text.split(/\s+/).filter(Boolean);
  const targetWords = Math.round(targetTokens / 1.3);
  const overlapWords = Math.round(overlapTokens / 1.3);
  const stride = Math.max(1, targetWords - overlapWords);

  const chunks = [];
  for (let i = 0; i < words.length; i += stride) {
    const slice = words.slice(i, i + targetWords);
    if (slice.length === 0) break;
    chunks.push(slice.join(' '));
    if (i + targetWords >= words.length) break;
  }
  return chunks.length > 0 ? chunks : [text];
}

/**
 * Generate embeddings for an array of texts. OpenAI's API supports batching.
 */
async function embedBatch(texts) {
  if (texts.length === 0) return [];
  const res = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts.map(t => t.replace(/\n/g, ' ').slice(0, 8000))
  });
  return res.data.map(d => d.embedding);
}

// ----------------------------------------------------------------------------
// POST /api/help/ingest — multipart upload (field: pdf) + body metadata
// ----------------------------------------------------------------------------
router.post('/ingest', upload.single('pdf'), async (req, res) => {
  const t0 = Date.now();
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded (expected field "pdf")' });
  if (req.file.mimetype !== 'application/pdf') {
    return res.status(400).json({ error: `Unsupported file type: ${req.file.mimetype}` });
  }

  const { title, source_type, vendor, notes } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });
  if (!source_type) return res.status(400).json({ error: 'source_type is required' });

  try {
    // Dedup check by file hash. Check returns ANY existing record (regardless of status)
    // because the unique constraint is unconditional on (mgmt_co, file_hash).
    const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const { data: existing, error: existingErr } = await supabase
      .from('knowledge_documents')
      .select('id, title, status')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('file_hash', fileHash)
      .maybeSingle();
    if (existingErr) console.warn('[help] dedup pre-check error:', existingErr.message);
    if (existing) {
      return res.status(409).json({
        duplicate: true,
        message: `That exact PDF is already ingested as "${existing.title}" (status: ${existing.status}). To replace it, delete the existing document from the list below first, then re-upload.`,
        existing
      });
    }

    // Extract page-level text from PDF via Claude
    const { pages, usage } = await extractPdfPages(req.file.buffer);
    if (!Array.isArray(pages) || pages.length === 0) {
      return res.status(422).json({ error: 'Claude returned no pages from the PDF.' });
    }

    // Insert the document row
    const { data: doc, error: docErr } = await supabase
      .from('knowledge_documents')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        title,
        source_type,
        vendor: vendor || null,
        file_name: req.file.originalname,
        file_hash: fileHash,
        page_count: pages.length,
        notes: notes || null,
        status: 'active'
      })
      .select()
      .single();
    if (docErr) {
      // Postgres unique violation = duplicate file_hash slipped past the pre-check
      // (race condition, RLS read/write asymmetry, etc.). Render the same friendly 409.
      if (docErr.code === '23505') {
        const { data: dup } = await supabase
          .from('knowledge_documents')
          .select('id, title, status')
          .eq('management_company_id', BEDROCK_MGMT_CO_ID)
          .eq('file_hash', fileHash)
          .maybeSingle();
        return res.status(409).json({
          duplicate: true,
          message: dup
            ? `That exact PDF is already ingested as "${dup.title}" (status: ${dup.status}). To replace it, delete the existing document from the list below first, then re-upload.`
            : 'That exact PDF is already ingested. Delete the existing one first, then re-upload.',
          existing: dup || null
        });
      }
      throw docErr;
    }

    // Chunk each page, then embed all chunks in batches of 50 (OpenAI limit-friendly)
    const allChunkRows = [];
    let chunkIndex = 0;
    for (const page of pages) {
      const pageText = (page.text || '').trim();
      if (!pageText) continue;
      const chunks = chunkText(pageText, 500, 60);
      for (const chunkBody of chunks) {
        allChunkRows.push({
          document_id: doc.id,
          chunk_index: chunkIndex++,
          text: chunkBody,
          page_number: page.page_number || null,
          section_heading: page.section_heading || null,
          token_count: Math.round(chunkBody.split(/\s+/).length * 1.3),
          embedding: null   // filled in below
        });
      }
    }

    // Batch embedding
    const BATCH = 50;
    for (let i = 0; i < allChunkRows.length; i += BATCH) {
      const slice = allChunkRows.slice(i, i + BATCH);
      const embeddings = await embedBatch(slice.map(r => r.text));
      slice.forEach((row, j) => { row.embedding = embeddings[j]; });
    }

    if (allChunkRows.length > 0) {
      const { error: chErr } = await supabase.from('knowledge_chunks').insert(allChunkRows);
      if (chErr) throw chErr;
    }

    // Update chunk_count on the document
    await supabase
      .from('knowledge_documents')
      .update({ chunk_count: allChunkRows.length })
      .eq('id', doc.id);

    // Trade-tape entry
    await supabase.from('agent_runs').insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      module: 'help',
      endpoint: 'POST /api/help/ingest',
      request_input: {
        file_name: req.file.originalname,
        file_size: req.file.size,
        file_hash: fileHash,
        title, source_type, vendor: vendor || null
      },
      retrieved_context: null,
      prompt: 'extractPdfPages',
      model: 'claude-sonnet-4-5 + openai-ada-002',
      response: { document_id: doc.id, pages: pages.length, chunks: allChunkRows.length },
      input_tokens: usage?.input_tokens || null,
      output_tokens: usage?.output_tokens || null,
      duration_ms: Date.now() - t0
    });

    res.json({
      ok: true,
      document: { ...doc, chunk_count: allChunkRows.length },
      pages: pages.length,
      chunks: allChunkRows.length,
      duration_ms: Date.now() - t0
    });
  } catch (err) {
    console.error('[help] ingest failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/help/query — ask a question, get askEd-format answer + citations
// Body: { question, vendor_filter?, source_filter?, match_count?, context? }
// ----------------------------------------------------------------------------
router.post('/query', async (req, res) => {
  const t0 = Date.now();
  const { question, vendor_filter, source_filter, match_count, context } = req.body || {};
  if (!question || !question.trim()) return res.status(400).json({ error: 'question is required' });

  try {
    // 1. Embed the question
    const qEmbedResp = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: question.replace(/\n/g, ' ').slice(0, 8000)
    });
    const qEmbedding = qEmbedResp.data[0].embedding;

    // 2. Vector search
    const { data: chunks, error: searchErr } = await supabase.rpc('match_knowledge_chunks', {
      query_embedding: qEmbedding,
      mgmt_co_id: BEDROCK_MGMT_CO_ID,
      match_count: match_count || 8,
      vendor_filter: vendor_filter && vendor_filter.length ? vendor_filter : null,
      source_filter: source_filter && source_filter.length ? source_filter : null
    });
    if (searchErr) throw searchErr;

    if (!chunks || chunks.length === 0) {
      return res.json({
        question,
        answer: null,
        no_results: true,
        message: "I don't have anything in the knowledge base that addresses this. Try uploading a relevant guide (admin guide, user guide, SOP) on the Help tab, or rephrase the question.",
        citations: [],
        duration_ms: Date.now() - t0
      });
    }

    // 3. Build context + prompt for Claude
    const contextBlocks = chunks.map((c, i) => `[Source ${i + 1}: ${c.document_title}${c.page_number ? `, p. ${c.page_number}` : ''}${c.section_heading ? ` — ${c.section_heading}` : ''}]
${c.text}`).join('\n\n---\n\n');

    const workflowContext = context ? `\n\nCURRENT WORKFLOW CONTEXT: ${context}` : '';

    const synthesisPrompt = `You are answering an operational question for a Bedrock Association Management staff member. Use ONLY the source material provided below. If the sources don't fully answer the question, say so honestly — don't invent steps.

QUESTION: ${question}${workflowContext}

SOURCE MATERIAL:
${contextBlocks}

Format your answer using this exact 4-part template (the "askEd template"). Use markdown headings. Be specific. Reference source numbers in parentheses like (Source 1, p. 5) when citing.

## ✅ Action

Concrete numbered steps to do this. Each step short and verb-first. If a step happens IN HomeWise or Vantaca specifically, name the menu / button / click path exactly. If there's a draft / template / output, include it.

## 📋 Output

If the action produces a deliverable (email, form, file), show the draft here in the Bedrock voice — warm, clear, respectful, path-forward-oriented. If the action doesn't produce a deliverable, write "Not applicable — this is a configuration/operational action."

## 💡 Reasoning

Why this matters. Why these steps in this order. Any HOA-industry context that helps a new staffer understand. Keep to 2-4 sentences.

## ⚠️ Watch Outs

Common pitfalls. Things that will make the action fail or backfire. Vendor-specific gotchas. Where the source explicitly warns about something, surface it.

If the source material genuinely doesn't address the question well, your Action section should say: "I don't have a confident answer for this in the loaded knowledge base. Best next step: [contact the right team / search for a different doc to upload / ask Ed]."`;

    const completion = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: synthesisPrompt }]
    });

    const answer = completion.content?.[0]?.text || '';

    // 4. Compose citations
    const citations = chunks.map((c, i) => ({
      index: i + 1,
      document_id: c.document_id,
      document_title: c.document_title,
      vendor: c.vendor,
      page_number: c.page_number,
      section_heading: c.section_heading,
      similarity: c.similarity,
      preview: c.text.slice(0, 200)
    }));

    // Trade-tape entry
    await supabase.from('agent_runs').insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      module: 'help',
      endpoint: 'POST /api/help/query',
      request_input: { question, vendor_filter, source_filter, context: context || null },
      retrieved_context: { chunk_ids: chunks.map(c => c.chunk_id), top_similarity: chunks[0]?.similarity },
      prompt: 'askEd-template synthesis',
      model: 'claude-sonnet-4-5 + openai-ada-002',
      response: { answer_length: answer.length, citation_count: citations.length },
      input_tokens: completion.usage?.input_tokens || null,
      output_tokens: completion.usage?.output_tokens || null,
      duration_ms: Date.now() - t0
    });

    res.json({
      question,
      answer,
      citations,
      duration_ms: Date.now() - t0
    });
  } catch (err) {
    console.error('[help] query failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/help/documents — list ingested docs
// ----------------------------------------------------------------------------
router.get('/documents', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('knowledge_documents')
      .select('id, title, source_type, vendor, file_name, page_count, chunk_count, status, notes, ingested_at')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('ingested_at', { ascending: false });
    if (error) throw error;
    res.json({ documents: data || [] });
  } catch (err) {
    console.error('[help] list documents failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// DELETE /api/help/documents/:id — remove a document (chunks cascade)
// ----------------------------------------------------------------------------
router.delete('/documents/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('knowledge_documents')
      .delete()
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[help] delete failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
