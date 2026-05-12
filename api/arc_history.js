// ============================================================================
// ARC History API
// ----------------------------------------------------------------------------
// Mounted at /api/arc-history.
//
// Workflow:
//   1. Staff drags a PDF / image / .eml of a past ARC letter
//   2. Claude extracts structured fields (project_type, decision_type,
//      decided_at, conditions, reasoning, summary)
//   3. Staff reviews the extracted preview, edits if needed, approves
//   4. Row inserts into arc_historical_decisions (with embedding) — and
//      a generic documents row is also created (category=arc_historical_decision)
//      so the existing chunk-based AskEd retrieval keeps working
//   5. AI assessment engine later does semantic match against this table
//      when a new application comes in.
//
// Always treated as INFORMATIONAL CONTEXT — never as binding precedent.
// ============================================================================

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const EMBEDDING_MODEL = 'text-embedding-ada-002';
const EXTRACTION_MODEL = 'claude-sonnet-4-6';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = express.Router();

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function embed(text) {
  if (!text || !text.trim()) return null;
  const r = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.replace(/\n+/g, ' ').slice(0, 8000)
  });
  return r.data[0].embedding;
}

async function extractFileText(file) {
  const mime = file.mimetype || '';
  const name = (file.originalname || '').toLowerCase();
  if (mime === 'application/pdf' || name.endsWith('.pdf')) {
    const parsed = await pdfParse(file.buffer);
    return parsed.text || '';
  }
  // For images, defer to Claude vision in extractWithClaude.
  if (mime.startsWith('image/')) return null;
  // .eml / .txt / anything else as text
  return file.buffer.toString('utf8');
}

async function extractWithClaude({ text, file, communityName }) {
  const system = `You extract structured fields from a single historical ARC (Architectural Control Committee) decision letter or meeting-minute excerpt for an HOA.

Your job: read the document carefully and return strict JSON in this exact shape (no commentary, no markdown, just JSON):

{
  "property_address": "<the address where the work was/is to be done, e.g. '8201 Pine Forest Ln'>" | null,
  "homeowner_name": "<owner's name>" | null,
  "project_type": "<one of: fence | paint | addition | pool | deck | landscaping | roof | door | window | shed | mailbox | driveway | tree | other>",
  "project_description": "<1-2 sentence description of what was being requested>",
  "decision_type": "<one of: approved | denied | conditional | withdrawn | pending | tabled>",
  "decided_at": "<YYYY-MM-DD if stated, else null>",
  "decided_by": "<ACC committee | board | manager | a proper name>" | null,
  "conditions": "<if conditional approval, the conditions imposed; else null>",
  "reasoning": "<the stated reason for the decision, if given; else null>",
  "summary": "<your own 1-2 sentence digest combining what was asked and what was decided>",
  "confidence": "<high | medium | low — your confidence in this extraction>"
}

RULES:
- If a field is genuinely absent, use null. Do not guess.
- Date format MUST be YYYY-MM-DD when present.
- project_type must be one of the listed values — pick "other" if nothing fits.
- Keep summary concrete: include what + decision + any key condition.
- For meeting-minute excerpts that mention multiple decisions: focus on the SINGLE clearest one. (We process multi-decision documents as separate uploads.)

Return ONLY the JSON object.`;

  let userContent;
  if (file && file.mimetype && file.mimetype.startsWith('image/')) {
    userContent = [
      { type: 'image', source: { type: 'base64', media_type: file.mimetype, data: file.buffer.toString('base64') } },
      { type: 'text', text: `Community: ${communityName || 'unknown'}\n\nExtract the ARC decision from the attached image.` }
    ];
  } else if (file && file.mimetype === 'application/pdf') {
    userContent = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.buffer.toString('base64') } },
      { type: 'text', text: `Community: ${communityName || 'unknown'}\n\nExtract the ARC decision from the attached PDF.` }
    ];
  } else {
    userContent = `Community: ${communityName || 'unknown'}\n\nARC decision document:\n\n${text || ''}`;
  }

  const response = await anthropic.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 2000,
    system,
    messages: [{ role: 'user', content: userContent }]
  });

  const raw = response.content[0]?.text || '';
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return { data: JSON.parse(cleaned), usage: response.usage };
  } catch (err) {
    throw new Error('Extractor returned invalid JSON: ' + err.message);
  }
}

// ----------------------------------------------------------------------------
// POST /api/arc-history/extract — preview only, no save
// Body (multipart): file=<PDF | image | text>, community_id (required)
// Response: { preview: {extracted_fields}, source_excerpt, source_filename }
// ----------------------------------------------------------------------------
router.post('/extract', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    const communityId = req.body.community_id;
    if (!communityId) return res.status(400).json({ error: 'community_id is required' });

    const { data: comm } = await supabase
      .from('communities')
      .select('name')
      .eq('id', communityId)
      .maybeSingle();
    const communityName = comm?.name;

    const text = await extractFileText(req.file);
    const { data: extracted } = await extractWithClaude({ text, file: req.file, communityName });

    res.json({
      preview: extracted,
      source_excerpt: text ? text.slice(0, 600) : null,
      source_filename: req.file.originalname,
      content_hash: crypto.createHash('sha256').update(req.file.buffer).digest('hex')
    });
  } catch (err) {
    console.error('[arc-history] extract failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /api/arc-history — save a reviewed/approved extraction
// Body (multipart):
//   file (optional — to ALSO create a documents row for chunk-based retrieval)
//   community_id, extracted (JSON string of approved fields), source_filename
// ----------------------------------------------------------------------------
router.post('/', upload.single('file'), async (req, res) => {
  try {
    const communityId = req.body.community_id;
    if (!communityId) return res.status(400).json({ error: 'community_id is required' });

    let extracted = req.body.extracted;
    if (typeof extracted === 'string') extracted = JSON.parse(extracted);
    if (!extracted) return res.status(400).json({ error: 'extracted fields required' });

    const sourceFilename = req.body.source_filename || req.file?.originalname || null;

    // Build text for embedding (project + reasoning + summary)
    const embedSource = [
      extracted.project_type,
      extracted.project_description,
      extracted.conditions,
      extracted.reasoning,
      extracted.summary
    ].filter(Boolean).join(' — ').slice(0, 6000);

    const embedding = await embed(embedSource);

    const insert = {
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id: communityId,
      source_filename: sourceFilename,
      source_excerpt: req.body.source_excerpt || null,
      property_address: extracted.property_address || null,
      homeowner_name: extracted.homeowner_name || null,
      project_type: extracted.project_type || null,
      project_description: extracted.project_description || null,
      decision_type: extracted.decision_type || null,
      decided_at: extracted.decided_at || null,
      decided_by: extracted.decided_by || null,
      conditions: extracted.conditions || null,
      reasoning: extracted.reasoning || null,
      summary: extracted.summary || null,
      embedding,
      extracted_by_model: EXTRACTION_MODEL,
      extraction_confidence: extracted.confidence || null,
      raw_extraction: extracted,
      manually_edited: !!req.body.manually_edited
    };

    const { data, error } = await supabase
      .from('arc_historical_decisions')
      .insert(insert)
      .select()
      .single();
    if (error) throw error;

    res.json({ decision: data });
  } catch (err) {
    console.error('[arc-history] save failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /api/arc-history — list with filters
// Query: community_id, project_type, decision_type, q (search), limit
// ----------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    let q = supabase
      .from('arc_historical_decisions')
      .select(`
        id, community_id, property_address, homeowner_name, project_type,
        project_description, decision_type, decided_at, decided_by, conditions,
        summary, extraction_confidence, source_filename, created_at,
        community:communities(id, name)
      `)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('decided_at', { ascending: false, nullsFirst: false })
      .limit(Math.min(Number(req.query.limit) || 200, 500));

    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    if (req.query.project_type) q = q.eq('project_type', req.query.project_type);
    if (req.query.decision_type) q = q.eq('decision_type', req.query.decision_type);
    if (req.query.q) {
      const like = `%${String(req.query.q).replace(/[%_]/g, '')}%`;
      q = q.or(`property_address.ilike.${like},homeowner_name.ilike.${like},summary.ilike.${like},project_description.ilike.${like}`);
    }
    const { data, error } = await q;
    if (error) throw error;
    res.json({ decisions: data || [] });
  } catch (err) {
    console.error('[arc-history] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /api/arc-history/summary — per-community counts (used by the dashboard)
// ----------------------------------------------------------------------------
router.get('/summary', async (req, res) => {
  try {
    let q = supabase
      .from('v_arc_history_summary')
      .select('*, community:communities(id, name)');
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ summaries: data || [] });
  } catch (err) {
    console.error('[arc-history] summary failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /api/arc-history/:id — full detail
// ----------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('arc_historical_decisions')
      .select('*, community:communities(id, name)')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .single();
    if (error) throw error;
    res.json({ decision: data });
  } catch (err) {
    console.error('[arc-history] get failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// PATCH /api/arc-history/:id — edit fields (re-embed if text changed)
// ----------------------------------------------------------------------------
router.patch('/:id', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const allowed = [
      'property_address', 'homeowner_name', 'project_type', 'project_description',
      'decision_type', 'decided_at', 'decided_by', 'conditions', 'reasoning',
      'summary', 'notes'
    ];
    const patch = {};
    let textChanged = false;
    for (const k of allowed) {
      if (k in req.body) {
        patch[k] = req.body[k];
        if (['project_description', 'conditions', 'reasoning', 'summary', 'project_type'].includes(k)) {
          textChanged = true;
        }
      }
    }
    patch.manually_edited = true;
    patch.updated_at = new Date().toISOString();

    if (textChanged) {
      const { data: row } = await supabase
        .from('arc_historical_decisions')
        .select('project_type, project_description, conditions, reasoning, summary')
        .eq('id', req.params.id)
        .single();
      const merged = { ...row, ...patch };
      const embedSource = [
        merged.project_type, merged.project_description, merged.conditions,
        merged.reasoning, merged.summary
      ].filter(Boolean).join(' — ').slice(0, 6000);
      patch.embedding = await embed(embedSource);
    }

    const { data, error } = await supabase
      .from('arc_historical_decisions')
      .update(patch)
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .select()
      .single();
    if (error) throw error;
    res.json({ decision: data });
  } catch (err) {
    console.error('[arc-history] patch failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// DELETE /api/arc-history/:id
// ----------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('arc_historical_decisions')
      .delete()
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[arc-history] delete failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
