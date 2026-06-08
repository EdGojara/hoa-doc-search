// ============================================================================
// api/kb.js — Knowledge Base API
// ----------------------------------------------------------------------------
// Endpoints under /api/kb/*. Backs the KB tab in the operator UI and the
// askEd/Claire retrieval surfaces (transparently — chunks land in the
// unified substrate, retrieval picks them up via existing hybrid retriever).
//
//   POST   /api/kb/articles         — ingest article (text + metadata)
//   GET    /api/kb/articles         — list articles (filter by status/topic/jurisdiction)
//   GET    /api/kb/articles/:id     — full article + chunk count
//   PATCH  /api/kb/articles/:id     — edit metadata (NOT content; re-ingest for that)
//   POST   /api/kb/articles/:id/archive — archive (chunks stay but archived)
//   GET    /api/kb/topics           — distinct topic list (admin helper)
// ============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { ingestArticle } = require('../lib/kb/ingest');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

router.use(express.json({ limit: '2mb' }));

// ---------------------------------------------------------------------------
// POST /api/kb/articles — ingest an article
// ---------------------------------------------------------------------------
router.post('/articles', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title || !b.content_md || !b.source_quality) {
      return res.status(400).json({ error: 'title_content_quality_required' });
    }
    const result = await ingestArticle(supabase, {
      title: b.title,
      content_md: b.content_md,
      source_url: b.source_url,
      source_publisher: b.source_publisher,
      jurisdiction: b.jurisdiction || 'TX',
      source_quality: b.source_quality,
      topics: Array.isArray(b.topics) ? b.topics : [],
      summary: b.summary,
      published_at: b.published_at || null,
      ingested_by: b.ingested_by || req.headers['x-user-email'] || null,
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error('[kb] ingest failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/kb/articles — list (paginated, filterable)
// ---------------------------------------------------------------------------
router.get('/articles', async (req, res) => {
  try {
    const status = req.query.status || 'active';
    const jurisdiction = req.query.jurisdiction || null;
    const topic = req.query.topic || null;
    const search = (req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;

    let query = supabase
      .from('kb_articles')
      .select('id, title, source_url, source_publisher, jurisdiction, source_quality, topics, summary, published_at, ingested_at, ingested_by, chunk_count, status', { count: 'exact' })
      .order('ingested_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status !== 'all') query = query.eq('status', status);
    if (jurisdiction) query = query.eq('jurisdiction', jurisdiction);
    if (topic) query = query.contains('topics', [topic]);
    if (search) query = query.ilike('title', `%${search}%`);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ ok: true, articles: data || [], total: count || 0 });
  } catch (err) {
    console.error('[kb] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/kb/articles/:id — full article
// ---------------------------------------------------------------------------
router.get('/articles/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('kb_articles')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, article: data });
  } catch (err) {
    console.error('[kb] get failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/kb/articles/:id — edit metadata only (not content)
// ---------------------------------------------------------------------------
router.patch('/articles/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const allowed = ['title', 'source_url', 'source_publisher', 'jurisdiction',
                     'source_quality', 'topics', 'summary', 'published_at'];
    const patch = {};
    for (const k of allowed) if (k in b) patch[k] = b[k];
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'no_editable_fields_provided' });
    }
    const { error } = await supabase
      .from('kb_articles')
      .update(patch)
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[kb] patch failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/kb/articles/:id/archive — archive
// ---------------------------------------------------------------------------
router.post('/articles/:id/archive', async (req, res) => {
  try {
    const reason = (req.body && req.body.reason) || 'archived_by_operator';
    const { error } = await supabase
      .from('kb_articles')
      .update({
        status: 'archived',
        archived_at: new Date().toISOString(),
        archived_reason: reason,
      })
      .eq('id', req.params.id);
    if (error) throw error;

    // Also flag the parent knowledge_documents row so retrieval can exclude
    // archived KB articles. (hybrid_retrieval reads from documents table
    // which doesn't have a status flag — for v1 the chunks remain
    // retrievable. Phase 2 wires a metadata.status filter into the retriever.)
    const { data: art } = await supabase
      .from('kb_articles')
      .select('parent_knowledge_doc_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (art?.parent_knowledge_doc_id) {
      await supabase
        .from('knowledge_documents')
        .update({ status: 'archived' })
        .eq('id', art.parent_knowledge_doc_id);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[kb] archive failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/kb/topics — distinct topic list across active articles
// ---------------------------------------------------------------------------
router.get('/topics', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('kb_articles')
      .select('topics')
      .eq('status', 'active');
    if (error) throw error;
    const counter = new Map();
    for (const row of (data || [])) {
      for (const t of (row.topics || [])) {
        counter.set(t, (counter.get(t) || 0) + 1);
      }
    }
    const topics = [...counter.entries()]
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count);
    res.json({ ok: true, topics });
  } catch (err) {
    console.error('[kb] topics failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
