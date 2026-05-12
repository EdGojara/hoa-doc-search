// ============================================================================
// Email Intelligence — email intake + extraction + recap generation
// ----------------------------------------------------------------------------
// Mounted at /api/email-intelligence in server.js.
//
// Two halves:
//
// 1. INTAKE  — paste an email thread, Claude extracts structured data,
//              staff reviews + approves, approved facts flow into
//              community_facts (existing table from migration 023) and
//              decisions flow into community_decisions.
//
//              Routes:
//                POST   /                      create new intake (extracts inline)
//                GET    /                      list intakes (filter by community/status)
//                GET    /:id                   get one intake (raw + extracted)
//                POST   /:id/re-extract        re-run extraction (after raw edit)
//                POST   /:id/approve           promote extracted to facts + decisions
//                PATCH  /:id                   edit extracted_data before approval
//                DELETE /:id                   throw away
//
// 2. RECAPS  — pick community + audience + date range, Claude synthesizes
//              a markdown report from approved intakes, decisions, facts,
//              events in that window. Manager-controlled board_visible
//              filter on each decision controls what reaches boards.
//
//              Routes:
//                POST   /recaps                generate a new recap
//                GET    /recaps                list recaps
//                GET    /recaps/:id            full recap detail
//                PATCH  /recaps/:id            edit / re-status
//                DELETE /recaps/:id            archive
//
// All routes scoped to BEDROCK_MGMT_CO_ID.
// ============================================================================

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ----------------------------------------------------------------------------
// Dedup helpers
// ----------------------------------------------------------------------------

// Normalize content for hashing + embedding so superficial differences
// (whitespace, signature lines, "On <date>, X wrote:" wrappers) don't
// hide real duplicates.
function normalizeForDedup(raw) {
  if (!raw) return '';
  let t = String(raw);
  // Strip common email scaffolding
  t = t.replace(/^\s*On .+ wrote:\s*$/gm, '');                  // "On Mon, May 12, 2026 at 2:34 PM Ed Gojara wrote:"
  t = t.replace(/^\s*Sent from my (iPhone|Android|iPad).*$/gm, '');
  t = t.replace(/^\s*-{2,}\s*Original Message\s*-{2,}.*$/gm, '');
  t = t.replace(/^\s*Begin forwarded message:.*$/gm, '');
  t = t.replace(/^\s*From:.*$/gm, '');
  t = t.replace(/^\s*To:.*$/gm, '');
  t = t.replace(/^\s*Cc:.*$/gm, '');
  t = t.replace(/^\s*Subject:.*$/gm, '');
  t = t.replace(/^\s*Date:.*$/gm, '');
  t = t.replace(/^\s*Reply-To:.*$/gm, '');
  t = t.replace(/^>+\s?/gm, '');                                 // strip reply quote markers
  t = t.replace(/\s+/g, ' ').trim().toLowerCase();
  return t;
}

function hashContent(raw) {
  return crypto.createHash('sha256').update(normalizeForDedup(raw)).digest('hex');
}

const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const EMBEDDING_MODEL = 'text-embedding-ada-002';
const EXTRACTION_MODEL = 'claude-sonnet-4-6';
const RECAP_MODEL = 'claude-sonnet-4-6';

const router = express.Router();

// ============================================================================
// EXTRACTION — Claude prompt + response parsing
// ============================================================================

async function extractEmailWithClaude(rawContent, communityName) {
  const system = `You are a structured-data extractor working for Bedrock Association Management. You read email threads about community matters and extract operational knowledge in clean JSON.

The goal: turn unstructured email noise into structured facts, decisions, contacts, and tasks that go into a permanent community knowledge library. Staff will review your extraction before saving — be accurate, but err on the side of capturing more rather than missing things.

Output strict JSON with this shape (no markdown, no commentary, just JSON):

{
  "summary": "<one-sentence summary of what this thread is about>",
  "topic": "<short topic label, lowercase, e.g. 'pool_hours', 'landscape_renewal', 'security_camera_quote'>",
  "vendor_mentions": [
    {
      "name": "<vendor company name>",
      "role": "<service category — catering | pool | landscape | security | hvac | plumbing | electrical | pest | lifeguard | dj | photography | janitorial | other>",
      "contact_name": "<person's name if mentioned, else null>",
      "phone": "<phone if mentioned, else null>",
      "email": "<email if mentioned, else null>",
      "notes": "<anything else worth knowing, else null>"
    }
  ],
  "facts": [
    {
      "category": "<pool | parking | pets | amenities | office | rules | seasonal | vendor | other>",
      "label": "<short human-friendly heading — 'Pool hours — 2026 season'>",
      "value": "<the actual fact text — 'M-Sun 6am-10pm, lifeguard on duty Sat/Sun'>",
      "expires_at": "<YYYY-MM-DD if this is seasonal/time-bound, else null>",
      "confidence": "<high | medium | low>"
    }
  ],
  "decisions": [
    {
      "summary": "<one-sentence: 'Board approved 8pm closing for August'>",
      "category": "<same vocabulary as facts>",
      "decided_by": "<'board' | 'manager' | 'vendor' | proper name>",
      "decided_at": "<YYYY-MM-DD if known, else null>",
      "board_visible": "<true if a board member should know about this in a recap, else false>",
      "internal_visible": true
    }
  ],
  "action_items": [
    {
      "task": "<what needs to happen>",
      "owner": "<'manager' | 'board' | 'vendor' | proper name>",
      "due": "<YYYY-MM-DD if known, else null>"
    }
  ],
  "board_relevant": <true if this thread overall is something boards would care about, else false>,
  "urgency": "<'high' | 'medium' | 'low'>",
  "extraction_confidence": "<'high' | 'medium' | 'low' — how confident are you in this extraction overall>",
  "open_questions": [
    "<any questions a human reviewer should ask before approving — e.g. 'Is this vendor under contract or one-time?'>"
  ]
}

EXTRACTION RULES:
- Treat "I confirmed with X" as a confirmed fact, not a decision.
- A "decision" requires a decision-maker (board, manager, owner). A scheduled appointment is a fact, not a decision.
- For vendor contacts: extract even one-line mentions; staff will dedupe later.
- For facts: if the email says "pool open 6-9 until October," set expires_at to the October date.
- For board_visible: things that affect homeowners visibly (rule changes, big spends, schedule shifts) are visible. Operational/staff noise (vendor follow-ups, internal scheduling) is not.
- urgency: 'high' = needs action this week, 'medium' = this month, 'low' = informational.
- If a field has no data, use null. Don't invent.
- Return ONLY the JSON object.`;

  const userMessage = `COMMUNITY: ${communityName || 'unknown'}

EMAIL THREAD:
${rawContent}`;

  const response = await anthropic.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 4000,
    system,
    messages: [{ role: 'user', content: userMessage }]
  });

  const text = response.content[0]?.text || '';
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return { data: JSON.parse(cleaned), usage: response.usage };
  } catch (err) {
    throw new Error('Extractor returned invalid JSON: ' + err.message + '\n---\n' + cleaned.slice(0, 500));
  }
}

async function embed(text) {
  if (!text || !text.trim()) return null;
  const r = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.replace(/\n+/g, ' ').slice(0, 8000)
  });
  return r.data[0].embedding;
}

function slugifyKey(s) {
  return (s || 'fact').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .slice(0, 50) + '_' + Date.now().toString(36).slice(-6);
}

// ============================================================================
// Utility: extract text from PDF (used by drag-and-drop on the intake tab)
// ============================================================================
router.post('/extract-pdf-text', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    if (req.file.mimetype !== 'application/pdf' && !(req.file.originalname || '').toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({ error: 'Only PDF files supported on this endpoint' });
    }
    const parsed = await pdfParse(req.file.buffer);
    res.json({ text: parsed.text || '', pages: parsed.numpages || null });
  } catch (err) {
    console.error('[email-intake] extract-pdf-text failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// INTAKE ROUTES
// ============================================================================

// POST /api/email-intelligence — create + extract a new intake
// Body: { community_id?, subject?, raw_content, sender_hint?, source?, force? }
//   force=true bypasses near-duplicate warning (still blocks exact duplicates)
//
// Response:
//   201 { intake }                  on success
//   409 { duplicate: 'exact', existing }     exact hash match
//   200 { warning: 'near_duplicate', candidates, draft }
//                                   near-dupe; caller decides whether to re-POST with force=true
router.post('/', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const { community_id, subject, raw_content, sender_hint, source, force } = req.body || {};
    if (!raw_content || !raw_content.trim()) {
      return res.status(400).json({ error: 'raw_content is required' });
    }

    // Resolve community name for the prompt
    let communityName = null;
    if (community_id) {
      const { data } = await supabase.from('communities').select('name').eq('id', community_id).maybeSingle();
      communityName = data?.name || null;
    }

    // 1. Hash + embedding for dedup
    const contentHash = hashContent(raw_content);
    const normalizedExcerpt = normalizeForDedup(raw_content).slice(0, 500);
    let embedding = null;
    try { embedding = await embed(raw_content); } catch (e) { console.warn('[dedup] embed failed', e.message); }

    // 2. Exact duplicate check (only when community is set — cross-community
    //    same-text is rare and might be intentional, allow it)
    if (community_id) {
      const { data: exact } = await supabase
        .from('email_intake')
        .select('id, subject, extracted_summary, extraction_status, ingested_at')
        .eq('management_company_id', BEDROCK_MGMT_CO_ID)
        .eq('community_id', community_id)
        .eq('content_hash', contentHash)
        .neq('extraction_status', 'superseded')
        .maybeSingle();
      if (exact) {
        return res.status(409).json({
          duplicate: 'exact',
          message: 'This exact email thread is already in the intake list. Open the existing one instead.',
          existing: exact
        });
      }
    }

    // 3. Near-duplicate / supersedes check (similarity ≥ 0.85)
    let supersedesId = null;
    let nearDupes = [];
    if (embedding && community_id) {
      const { data: matches } = await supabase.rpc('match_email_intakes', {
        query_embedding: embedding,
        community_id_in: community_id,
        match_count: 5,
        similarity_threshold: 0.85
      });
      nearDupes = matches || [];

      // Supersession: high similarity AND new content is meaningfully longer than the matched one
      const newRawLength = raw_content.length;
      const supersedesMatch = nearDupes.find((m) => m.similarity >= 0.85 && newRawLength > (m.raw_length || 0) * 1.3);
      if (supersedesMatch) supersedesId = supersedesMatch.id;

      // Near-duplicate (no supersession): similarity ≥ 0.95 AND not yet flagged via force
      const nearMatch = nearDupes.find((m) => m.similarity >= 0.95);
      if (nearMatch && !force && !supersedesId) {
        return res.status(200).json({
          warning: 'near_duplicate',
          message: 'Found a very similar email already in the system. Review before re-ingesting.',
          candidates: nearDupes.slice(0, 3),
          draft: { community_id, subject, raw_content, sender_hint }
        });
      }
    }

    // 4. Insert pending row
    const { data: intake, error: insErr } = await supabase
      .from('email_intake')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id: community_id || null,
        subject: subject || null,
        raw_content,
        sender_hint: sender_hint || null,
        source: source || 'manual_paste',
        extraction_status: 'pending',
        content_hash: contentHash,
        normalized_excerpt: normalizedExcerpt,
        embedding,
        supersedes_id: supersedesId
      })
      .select()
      .single();
    if (insErr) {
      // unique violation = race between dedup pre-check and insert; same response shape
      if (insErr.code === '23505') {
        const { data: existing } = await supabase
          .from('email_intake')
          .select('id, subject, extracted_summary, extraction_status, ingested_at')
          .eq('management_company_id', BEDROCK_MGMT_CO_ID)
          .eq('community_id', community_id)
          .eq('content_hash', contentHash)
          .maybeSingle();
        return res.status(409).json({
          duplicate: 'exact',
          message: 'This exact email thread is already in the intake list.',
          existing
        });
      }
      throw insErr;
    }

    // 5. If we supersede something, mark the older one
    if (supersedesId) {
      await supabase
        .from('email_intake')
        .update({ superseded_by_id: intake.id, extraction_status: 'superseded' })
        .eq('id', supersedesId);
    }

    // 6. Run extraction
    let extracted, extractionError = null;
    try {
      const result = await extractEmailWithClaude(raw_content, communityName);
      extracted = result.data;
    } catch (err) {
      extractionError = err.message;
    }

    const patch = extractionError
      ? {
          extraction_status: 'error',
          extraction_error: extractionError,
          extracted_at: new Date().toISOString(),
          extraction_model: EXTRACTION_MODEL
        }
      : {
          extraction_status: 'extracted',
          extracted_summary: extracted.summary || null,
          extracted_data: extracted,
          extraction_confidence: extracted.extraction_confidence || null,
          board_relevant: !!extracted.board_relevant,
          urgency: extracted.urgency || null,
          extracted_at: new Date().toISOString(),
          extraction_model: EXTRACTION_MODEL
        };

    const { data: updated } = await supabase
      .from('email_intake')
      .update(patch)
      .eq('id', intake.id)
      .select()
      .single();

    res.status(201).json({
      intake: updated,
      supersedes: supersedesId ? { id: supersedesId } : null
    });
  } catch (err) {
    console.error('[email-intake] create failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/email-intelligence/:id/re-extract — re-run after editing raw_content
router.post('/:id/re-extract', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: intake, error } = await supabase
      .from('email_intake')
      .select('*, community:communities(name)')
      .eq('id', id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .single();
    if (error) throw error;
    if (!intake) return res.status(404).json({ error: 'not found' });

    const result = await extractEmailWithClaude(intake.raw_content, intake.community?.name);

    const { data: updated } = await supabase
      .from('email_intake')
      .update({
        extraction_status: 'extracted',
        extracted_summary: result.data.summary || null,
        extracted_data: result.data,
        extraction_confidence: result.data.extraction_confidence || null,
        board_relevant: !!result.data.board_relevant,
        urgency: result.data.urgency || null,
        extraction_error: null,
        extracted_at: new Date().toISOString(),
        extraction_model: EXTRACTION_MODEL
      })
      .eq('id', id)
      .select()
      .single();

    res.json({ intake: updated });
  } catch (err) {
    console.error('[email-intake] re-extract failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/email-intelligence — list intakes
router.get('/', async (req, res) => {
  try {
    let q = supabase.from('email_intake')
      .select('id, subject, sender_hint, community_id, extraction_status, extracted_summary, extraction_confidence, urgency, board_relevant, ingested_at, approved_at, community:communities(id, name)')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('ingested_at', { ascending: false })
      .limit(100);
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    if (req.query.status) q = q.eq('extraction_status', req.query.status);

    const { data, error } = await q;
    if (error) throw error;
    res.json({ intakes: data || [] });
  } catch (err) {
    console.error('[email-intake] list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/email-intelligence/:id — full detail incl raw + extracted + supersession links
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('email_intake')
      .select(`*,
        community:communities(id, name, slug),
        supersedes:supersedes_id(id, subject, extracted_summary, ingested_at, extraction_status),
        superseded_by:superseded_by_id(id, subject, extracted_summary, ingested_at, extraction_status)
      `)
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .single();
    if (error) throw error;
    res.json({ intake: data });
  } catch (err) {
    console.error('[email-intake] get failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/email-intelligence/:id — edit extracted_data before approval
router.patch('/:id', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const allowed = ['extracted_data', 'extracted_summary', 'board_relevant', 'urgency', 'extraction_confidence', 'community_id', 'subject', 'sender_hint'];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    patch.updated_at = new Date().toISOString();

    const { data, error } = await supabase.from('email_intake')
      .update(patch)
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .select()
      .single();
    if (error) throw error;
    res.json({ intake: data });
  } catch (err) {
    console.error('[email-intake] patch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/email-intelligence/:id/approve — promote to facts + decisions
router.post('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: intake, error } = await supabase
      .from('email_intake')
      .select('*')
      .eq('id', id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .single();
    if (error) throw error;
    if (!intake) return res.status(404).json({ error: 'not found' });
    if (intake.extraction_status === 'approved') {
      return res.status(400).json({ error: 'already approved' });
    }
    if (!intake.community_id) {
      return res.status(400).json({ error: 'set a community before approving' });
    }

    const data = intake.extracted_data || {};
    const promotedFactIds = [];
    const promotedDecisionIds = [];

    // 1. Promote facts → community_facts
    for (const f of data.facts || []) {
      try {
        const labelOrCat = f.label || f.category || 'fact';
        const key = slugifyKey(labelOrCat);
        const embedding = await embed(`${f.label || ''}. ${f.value || ''}`);
        const { data: factRow, error: factErr } = await supabase
          .from('community_facts')
          .insert({
            community_id: intake.community_id,
            category: f.category || null,
            key,
            label: f.label || null,
            value: f.value,
            details: null,
            source_type: 'manual',
            source_ref: `email_intake:${intake.id}`,
            expires_at: f.expires_at || null,
            embedding
          })
          .select('id')
          .single();
        if (factErr) {
          // unique violation = key clash, skip
          if (factErr.code !== '23505') throw factErr;
        } else if (factRow) {
          promotedFactIds.push(factRow.id);
        }
      } catch (e) {
        console.warn('[email-intake] fact promote failed:', e.message);
      }
    }

    // 2. Promote decisions → community_decisions
    for (const d of data.decisions || []) {
      try {
        const { data: decRow, error: decErr } = await supabase
          .from('community_decisions')
          .insert({
            management_company_id: BEDROCK_MGMT_CO_ID,
            community_id: intake.community_id,
            decision_summary: d.summary,
            category: d.category || null,
            decided_at: d.decided_at ? new Date(d.decided_at).toISOString() : null,
            decided_by: d.decided_by || null,
            source_email_intake_id: intake.id,
            board_visible: !!d.board_visible,
            internal_visible: d.internal_visible !== false
          })
          .select('id')
          .single();
        if (decErr) throw decErr;
        if (decRow) promotedDecisionIds.push(decRow.id);
      } catch (e) {
        console.warn('[email-intake] decision promote failed:', e.message);
      }
    }

    // 3. Update the intake
    const { data: updated } = await supabase.from('email_intake')
      .update({
        extraction_status: 'approved',
        approved_at: new Date().toISOString(),
        promoted_fact_ids: promotedFactIds,
        promoted_decision_ids: promotedDecisionIds
      })
      .eq('id', id)
      .select()
      .single();

    res.json({
      intake: updated,
      promoted: {
        facts: promotedFactIds.length,
        decisions: promotedDecisionIds.length,
        action_items_recorded: (data.action_items || []).length,
        vendor_mentions_noted: (data.vendor_mentions || []).length
      }
    });
  } catch (err) {
    console.error('[email-intake] approve failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/email-intelligence/:id
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('email_intake')
      .delete()
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[email-intake] delete failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// DECISIONS — list + edit (used by recap filter UI)
// ============================================================================

router.get('/decisions/list', async (req, res) => {
  try {
    let q = supabase.from('community_decisions')
      .select('*, source_email_intake:email_intake(id, subject)')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('decided_at', { ascending: false, nullsFirst: false })
      .limit(200);
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    if (req.query.board_visible === 'true') q = q.eq('board_visible', true);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ decisions: data || [] });
  } catch (err) {
    console.error('[decisions] list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/decisions/:id', express.json(), async (req, res) => {
  try {
    const allowed = ['decision_summary', 'decision_detail', 'category', 'decided_at', 'decided_by', 'board_visible', 'internal_visible', 'community_visible', 'notes'];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    patch.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from('community_decisions')
      .update(patch)
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .select()
      .single();
    if (error) throw error;
    res.json({ decision: data });
  } catch (err) {
    console.error('[decisions] patch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// RECAPS — generate + list + send
// ============================================================================

async function generateRecapMarkdown({ communityName, audience, periodStart, periodEnd, decisions, intakes, newFacts, events }) {
  const audienceFraming = {
    board: `You are writing a recap for the BOARD of directors of ${communityName}. Tone: respectful of their time, high-level, no operational noise. Group items by category. Highlight financial / governance / homeowner-impact items. Keep under 400 words. Use markdown headings (##) and bullet lists.`,
    internal: `You are writing a recap for the BEDROCK MANAGEMENT TEAM about ${communityName}. Tone: practical, detailed, action-oriented. Include open action items, vendor follow-ups, decisions made. Use markdown headings.`,
    community: `You are writing a recap for the HOMEOWNERS of ${communityName}. Tone: friendly, welcoming, no enforcement or vendor noise. Highlight events, amenity updates, positive news. Keep warm and brief.`
  };

  const decisionsBlock = decisions.length > 0
    ? decisions.map((d) => `- ${d.decision_summary}${d.decided_at ? ` (decided ${d.decided_at.slice(0,10)} by ${d.decided_by || 'unspecified'})` : ''}`).join('\n')
    : '(no decisions in this period)';

  const factsBlock = newFacts.length > 0
    ? newFacts.map((f) => `- ${f.label || f.category}: ${f.value}${f.expires_at ? ` (valid through ${f.expires_at.slice(0,10)})` : ''}`).join('\n')
    : '(no new facts in this period)';

  const intakesBlock = intakes.length > 0
    ? intakes.map((i) => `- ${i.extracted_summary || i.subject || '(no summary)'}`).join('\n')
    : '(no notable correspondence)';

  const eventsBlock = events.length > 0
    ? events.map((e) => `- ${e.name} — ${new Date(e.scheduled_start_at).toLocaleDateString()} (${e.status})`).join('\n')
    : '(no events scheduled or completed)';

  const prompt = `${audienceFraming[audience] || audienceFraming.internal}

PERIOD: ${periodStart} to ${periodEnd}

DECISIONS (already filtered for this audience):
${decisionsBlock}

NEW FACTS RECORDED:
${factsBlock}

EVENTS:
${eventsBlock}

EMAIL ACTIVITY:
${intakesBlock}

Write the recap. Lead with a one-sentence overview. Then sections. Then close with a one-line "what's next" if appropriate. Use markdown.`;

  const response = await anthropic.messages.create({
    model: RECAP_MODEL,
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  });
  return response.content[0]?.text || '';
}

// POST /api/email-intelligence/recaps — generate a new recap
router.post('/recaps', express.json(), async (req, res) => {
  try {
    const { community_id, audience, period_start, period_end } = req.body || {};
    if (!community_id || !audience || !period_start || !period_end) {
      return res.status(400).json({ error: 'community_id, audience, period_start, period_end required' });
    }

    const { data: comm } = await supabase.from('communities').select('name').eq('id', community_id).maybeSingle();
    const communityName = comm?.name || 'this community';

    // Gather data in the period
    const startIso = new Date(period_start).toISOString();
    const endIso = new Date(period_end + 'T23:59:59').toISOString();

    // Decisions — filtered by audience visibility
    let decQ = supabase.from('community_decisions')
      .select('*')
      .eq('community_id', community_id)
      .gte('decided_at', startIso).lte('decided_at', endIso);
    if (audience === 'board') decQ = decQ.eq('board_visible', true);
    if (audience === 'community') decQ = decQ.eq('community_visible', true);
    if (audience === 'internal') decQ = decQ.eq('internal_visible', true);
    const [{ data: decisions }, { data: intakes }, { data: newFacts }, { data: events }] = await Promise.all([
      decQ,
      supabase.from('email_intake')
        .select('id, subject, extracted_summary, ingested_at')
        .eq('community_id', community_id)
        .eq('extraction_status', 'approved')
        .gte('approved_at', startIso).lte('approved_at', endIso),
      supabase.from('community_facts')
        .select('id, label, category, value, expires_at, last_updated_at')
        .eq('community_id', community_id)
        .gte('last_updated_at', startIso).lte('last_updated_at', endIso),
      supabase.from('events')
        .select('id, name, scheduled_start_at, status')
        .eq('community_id', community_id)
        .gte('scheduled_start_at', startIso).lte('scheduled_start_at', endIso)
    ]);

    const summary = await generateRecapMarkdown({
      communityName, audience, periodStart: period_start, periodEnd: period_end,
      decisions: decisions || [],
      intakes: intakes || [],
      newFacts: newFacts || [],
      events: events || []
    });

    const { data: recap, error } = await supabase.from('community_recaps').insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id,
      audience,
      period_start,
      period_end,
      title: `${communityName} — ${audience.charAt(0).toUpperCase() + audience.slice(1)} Recap (${period_start} to ${period_end})`,
      summary_markdown: summary,
      included_decision_ids: (decisions || []).map((d) => d.id),
      included_fact_ids: (newFacts || []).map((f) => f.id),
      included_event_ids: (events || []).map((e) => e.id),
      included_intake_ids: (intakes || []).map((i) => i.id),
      generation_model: RECAP_MODEL,
      status: 'draft'
    }).select().single();
    if (error) throw error;

    res.json({ recap });
  } catch (err) {
    console.error('[recaps] generate failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/email-intelligence/recaps — list
router.get('/recaps/list', async (req, res) => {
  try {
    let q = supabase.from('community_recaps')
      .select('id, community_id, audience, period_start, period_end, title, status, generated_at, sent_at, community:communities(name)')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('generated_at', { ascending: false })
      .limit(100);
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    if (req.query.audience) q = q.eq('audience', req.query.audience);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ recaps: data || [] });
  } catch (err) {
    console.error('[recaps] list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/email-intelligence/recaps/:id — full
router.get('/recaps/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('community_recaps')
      .select('*, community:communities(id, name, slug)')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .single();
    if (error) throw error;
    res.json({ recap: data });
  } catch (err) {
    console.error('[recaps] get failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/email-intelligence/recaps/:id — edit markdown / status
router.patch('/recaps/:id', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const allowed = ['title', 'summary_markdown', 'status', 'sent_to', 'sent_at'];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    patch.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from('community_recaps')
      .update(patch)
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .select()
      .single();
    if (error) throw error;
    res.json({ recap: data });
  } catch (err) {
    console.error('[recaps] patch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/email-intelligence/recaps/:id
router.delete('/recaps/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('community_recaps')
      .delete()
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[recaps] delete failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
