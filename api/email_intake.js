// ============================================================================
// Email Intelligence — email intake + extraction + recap generation
// ----------------------------------------------------------------------------
// Mounted at /api/email-intelligence in server.js.
//
// Two halves:
//
// 1. INTAKE  — paste an email thread, the AI extracts structured data,
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
// 2. RECAPS  — pick community + audience + date range, the AI synthesizes
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
const { safeErrorMessage } = require('./_safe_error');
const { resolveProperty, resolveContact } = require('../lib/entity_resolution');

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
// UNIFIED SUBSTRATE WRITES — keep emails askEd-visible alongside library docs.
// Per project_unified_architecture.md / feedback_no_new_silos.md, every email
// that gets a usable embedding lands in knowledge_documents + knowledge_chunks
// with source_type='email'. The email_intake table stays — its embedding
// continues to power dedup (legitimate feature-local exception). This helper
// writes the SAME content into the substrate so match_knowledge_chunks finds
// it. Idempotent: re-writes update the existing parent on re-extract.
// Access default is staff_internal — the board portal will not surface
// emails unless an explicit operator action re-tags them.
// ============================================================================
async function upsertEmailIntoSubstrate(intake) {
  if (!intake || !intake.id) return null;
  // Skip rows that have no useful retrieval signal
  if (!intake.embedding || !intake.raw_content) return null;
  if (intake.extraction_status === 'error') return null;

  const title = (intake.subject && intake.subject.trim())
    || String(intake.raw_content).replace(/\s+/g, ' ').slice(0, 80).trim()
    || 'Email (no subject)';

  const notes = [intake.sender_hint, intake.source].filter((x) => x && String(x).trim()).join(' · ') || null;
  const status = intake.extraction_status === 'superseded' ? 'superseded' : 'active';

  try {
    // Look up existing parent — idempotency for re-extract / re-edit flows.
    const { data: existing } = await supabase
      .from('knowledge_documents')
      .select('id')
      .eq('source_type', 'email')
      .eq('source_record_id', intake.id)
      .maybeSingle();

    let parentId = existing && existing.id;
    if (parentId) {
      await supabase
        .from('knowledge_documents')
        .update({
          title,
          community_id: intake.community_id || null,
          property_id: intake.property_id || null,
          contact_id: intake.contact_id || null,
          status,
          notes,
          chunk_count: 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', parentId);
    } else {
      const { data: newParent, error: parentErr } = await supabase
        .from('knowledge_documents')
        .insert({
          management_company_id: intake.management_company_id || BEDROCK_MGMT_CO_ID,
          title,
          source_type: 'email',
          community_id: intake.community_id || null,
          property_id: intake.property_id || null,
          contact_id: intake.contact_id || null,
          source_record_id: intake.id,
          status,
          ingested_at: intake.ingested_at || new Date().toISOString(),
          model_version: 'text-embedding-ada-002@v1',
          access_level: 'staff_internal',
          notes,
          chunk_count: 1,
        })
        .select('id')
        .single();
      if (parentErr) throw parentErr;
      parentId = newParent.id;
    }

    // Wipe + reinsert the single chunk so text/embedding stay in sync with
    // the email_intake row through edits.
    await supabase.from('knowledge_chunks').delete().eq('document_id', parentId);
    const { error: chunkErr } = await supabase.from('knowledge_chunks').insert({
      document_id:   parentId,
      chunk_index:   0,
      text:          intake.raw_content,
      embedding:     intake.embedding,
      model_version: 'text-embedding-ada-002@v1',
    });
    if (chunkErr) throw chunkErr;

    return parentId;
  } catch (e) {
    console.warn('[email-intake] substrate upsert failed (non-fatal):', e.message);
    return null;
  }
}

// When a new email supersedes an old one, mark the old substrate parent
// 'superseded' so askEd stops returning it as a live result.
async function markEmailSupersededInSubstrate(supersededIntakeId, supersedingIntakeId) {
  try {
    await supabase
      .from('knowledge_documents')
      .update({ status: 'superseded', superseded_by_id: null /* see note */, updated_at: new Date().toISOString() })
      .eq('source_type', 'email')
      .eq('source_record_id', supersededIntakeId);
    // Note: superseded_by_id on knowledge_documents takes a knowledge_documents.id.
    // We could look up the superseding email's parent and link it, but that
    // adds a query for a non-critical audit field. Skipping for now —
    // status='superseded' is the load-bearing part for retrieval filtering.
  } catch (e) {
    console.warn('[email-intake] substrate supersede mark failed (non-fatal):', e.message);
  }
}

// ============================================================================
// EXTRACTION — the AI prompt + response parsing
// ============================================================================

async function extractEmailWithAi(rawContent, communityName) {
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
    res.status(500).json({ error: safeErrorMessage(err) });
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
      const result = await extractEmailWithAi(raw_content, communityName);
      extracted = result.data;
    } catch (err) {
      extractionError = err.message;
    }

    // Entity-graph resolution from the AI extraction. We look at common
    // fields the extractor produces: sender_email + sender_name for the
    // contact, mentioned property addresses for the property. Match-only
    // — no createIfMissing on emails (sender names can be noisy).
    let resolvedPropertyId = null;
    let resolvedContactId = null;
    if (extracted && !extractionError) {
      const senderEmail = extracted.sender_email || extracted.from_email || extracted.email_from || null;
      const senderName = extracted.sender_name || extracted.from_name || extracted.sender || sender_hint || null;
      const propertyAddress = extracted.property_address || extracted.address || (Array.isArray(extracted.mentioned_addresses) && extracted.mentioned_addresses[0]) || null;

      if (propertyAddress && community_id) {
        const p = await resolveProperty(supabase, community_id, propertyAddress);
        resolvedPropertyId = p && p.id ? p.id : null;
      }
      if (senderEmail || senderName) {
        const c = await resolveContact(supabase, {
          email: senderEmail,
          name: senderName,
          communityId: community_id,
          propertyId: resolvedPropertyId,
        });
        resolvedContactId = c && c.id && !c.ambiguous ? c.id : null;
      }
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
          property_id: resolvedPropertyId,
          contact_id: resolvedContactId,
          extracted_at: new Date().toISOString(),
          extraction_model: EXTRACTION_MODEL
        };

    const { data: updated } = await supabase
      .from('email_intake')
      .update(patch)
      .eq('id', intake.id)
      .select()
      .single();

    // Dual-write into the unified knowledge substrate so askEd can retrieve
    // this email alongside library docs. Non-fatal if it fails — the
    // email_intake row is the source of truth; substrate is a derived index.
    await upsertEmailIntoSubstrate(updated || intake);
    if (supersedesId) {
      await markEmailSupersededInSubstrate(supersedesId, intake.id);
    }

    res.status(201).json({
      intake: updated,
      supersedes: supersedesId ? { id: supersedesId } : null
    });
  } catch (err) {
    console.error('[email-intake] create failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
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

    const result = await extractEmailWithAi(intake.raw_content, intake.community?.name);

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

    // Keep the unified substrate in sync after re-extract (title may have
    // changed, status may have flipped from error → extracted, etc.).
    await upsertEmailIntoSubstrate(updated || intake);

    res.json({ intake: updated });
  } catch (err) {
    console.error('[email-intake] re-extract failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
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
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /api/email-intelligence/:id — full detail incl raw + extracted + supersession links
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('email_intake')
      .select(`*,
        community:communities(id, name, slug),
        supersedes:supersedes_id(id, subject, extracted_summary, ingested_at, extraction_status),
        superseded_by:superseded_by_id(id, subject, extracted_summary, ingested_at, extraction_status),
        attached_violation:attached_violation_id(id, current_stage, opened_at, primary_category_id, enforcement_categories(label, code))
      `)
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .single();
    if (error) throw error;

    // Enrich attached-violation with property address so the UI can show
    // "Attached to violation at 1234 Oak St" without an extra round-trip.
    let attachedProperty = null;
    if (data && data.attached_property_id) {
      const { data: pRow } = await supabase
        .from('v_current_property_owners')
        .select('property_id, street_address, unit, owner_name')
        .eq('property_id', data.attached_property_id)
        .maybeSingle();
      attachedProperty = pRow || null;
    }
    res.json({ intake: { ...data, attached_property: attachedProperty } });
  } catch (err) {
    console.error('[email-intake] get failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
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
    res.status(500).json({ error: safeErrorMessage(err) });
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
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// OWNER REPLY ATTACHMENT — link an intake to an open violation
// ----------------------------------------------------------------------------
// When a homeowner emails about a violation, the operator attaches the intake
// to that violation. We insert a fresh interactions row (the single source of
// truth for property + violation timeline) and tag the intake.
// ============================================================================

// Cheap string-scan to score a candidate violation against the email body.
// Higher score = more likely the email is about this violation.
function scoreCandidate({ violation, property, owner, contact, normalizedBody, senderHint }) {
  let score = 0;
  const reasons = [];

  const addr = (property.street_address || '').toLowerCase();
  // Match the numeric street + first word of the street name (e.g. "1234 oak").
  // Full-address match is brittle (apt suffixes, formatting differ).
  if (addr) {
    const tokens = addr.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2) {
      const head = `${tokens[0]} ${tokens[1]}`;
      if (normalizedBody.includes(head)) {
        score += 10;
        reasons.push(`address "${head}" mentioned`);
      } else if (tokens[0].match(/^\d+$/) && normalizedBody.includes(tokens[0])) {
        // Just the house number — weaker signal
        score += 3;
        reasons.push(`house number ${tokens[0]} mentioned`);
      }
    }
    if (property.unit && normalizedBody.includes(String(property.unit).toLowerCase())) {
      score += 2;
      reasons.push(`unit ${property.unit} mentioned`);
    }
  }

  if (senderHint && owner && owner.email) {
    if (senderHint.toLowerCase().includes(owner.email.toLowerCase())) {
      score += 8;
      reasons.push('sender matches owner email');
    }
  }
  if (senderHint && contact && contact.email) {
    if (senderHint.toLowerCase().includes(contact.email.toLowerCase())) {
      score += 8;
      reasons.push('sender matches contact email');
    }
  }

  if (owner && owner.full_name) {
    const lastName = owner.full_name.split(/\s+/).pop().toLowerCase();
    if (lastName && lastName.length >= 3 && normalizedBody.includes(lastName)) {
      score += 2;
      reasons.push(`owner last name "${lastName}" mentioned`);
    }
  }

  // Recency boost — newer violations are likelier to receive replies
  const days = (Date.now() - new Date(violation.opened_at).getTime()) / (24 * 60 * 60 * 1000);
  if (days <= 30) score += 2;
  else if (days <= 90) score += 1;

  return { score, reasons };
}

// GET /api/email-intelligence/:id/violation-candidates
// Returns ranked open violations the intake might be about. Used by the UI
// to suggest matches when the operator views an intake.
router.get('/:id/violation-candidates', async (req, res) => {
  try {
    const { data: intake, error } = await supabase
      .from('email_intake')
      .select('id, community_id, raw_content, sender_hint, subject, attached_violation_id')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .single();
    if (error) throw error;
    if (!intake) return res.status(404).json({ error: 'not found' });
    if (!intake.community_id) {
      return res.json({ candidates: [], message: 'Set a community on the intake to see violation matches.' });
    }

    // Pull open violations + the joined data we need to score
    const { data: violations, error: vErr } = await supabase
      .from('violations')
      .select('id, property_id, primary_category_id, current_stage, current_stage_started_at, opened_at, cure_period_ends_at, enforcement_categories(label, code)')
      .eq('community_id', intake.community_id)
      .not('current_stage', 'in', '(cured,closed,voided)')
      .order('opened_at', { ascending: false })
      .limit(200);
    if (vErr) throw vErr;
    if (!violations || violations.length === 0) {
      return res.json({ candidates: [] });
    }

    // Pull property/owner/contact info in bulk
    const propIds = [...new Set(violations.map((v) => v.property_id))];
    const { data: propRows } = await supabase
      .from('v_current_property_owners')
      .select('property_id, street_address, unit, owner_contact_id, owner_name, owner_email, owner_phone')
      .in('property_id', propIds);
    const propMap = new Map((propRows || []).map((p) => [p.property_id, p]));

    const normalizedBody = (intake.raw_content || '').toLowerCase();
    const senderHint = intake.sender_hint || '';

    const scored = violations.map((v) => {
      const p = propMap.get(v.property_id) || { property_id: v.property_id, street_address: null };
      const owner = p.owner_contact_id ? { full_name: p.owner_name, email: p.owner_email } : null;
      const s = scoreCandidate({
        violation: v,
        property: p,
        owner,
        contact: null,
        normalizedBody,
        senderHint,
      });
      return {
        violation_id:     v.id,
        property_id:      v.property_id,
        street_address:   p.street_address,
        unit:             p.unit,
        owner_name:       p.owner_name,
        owner_email:      p.owner_email,
        owner_contact_id: p.owner_contact_id,
        category_label:   v.enforcement_categories && v.enforcement_categories.label,
        current_stage:    v.current_stage,
        opened_at:        v.opened_at,
        cure_period_ends_at: v.cure_period_ends_at,
        score:            s.score,
        reasons:          s.reasons,
      };
    });

    // Sort by score desc, then opened_at desc. Cap at 10. Drop zeros unless
    // there are < 3 non-zero hits (so the operator always has SOMETHING to pick).
    scored.sort((a, b) => (b.score - a.score) || (new Date(b.opened_at) - new Date(a.opened_at)));
    const positive = scored.filter((c) => c.score > 0);
    const top = positive.length >= 3 ? positive.slice(0, 10) : scored.slice(0, 10);

    res.json({
      candidates: top,
      attached_violation_id: intake.attached_violation_id,
      total_open_violations: violations.length,
    });
  } catch (err) {
    console.error('[email-intake] violation-candidates failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /api/email-intelligence/:id/attach-to-violation
// Body: { violation_id }
// Creates an interactions row (type=email_inbound, status=received) linked to
// the violation, then sets the attached_* fields on the intake.
router.post('/:id/attach-to-violation', express.json(), async (req, res) => {
  try {
    const { violation_id } = req.body || {};
    if (!violation_id) return res.status(400).json({ error: 'violation_id is required' });

    const { data: intake, error: iErr } = await supabase
      .from('email_intake')
      .select('id, community_id, subject, raw_content, sender_hint, ingested_at, attached_violation_id, attached_interaction_id')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .single();
    if (iErr) throw iErr;
    if (!intake) return res.status(404).json({ error: 'intake not found' });

    if (intake.attached_violation_id) {
      return res.status(400).json({
        error: 'already attached',
        attached_violation_id: intake.attached_violation_id,
        attached_interaction_id: intake.attached_interaction_id,
      });
    }

    const { data: violation, error: vErr } = await supabase
      .from('violations')
      .select('id, community_id, property_id')
      .eq('id', violation_id)
      .single();
    if (vErr) throw vErr;
    if (!violation) return res.status(404).json({ error: 'violation not found' });

    // Sanity: violation must be in the same community as the intake
    if (intake.community_id && violation.community_id !== intake.community_id) {
      return res.status(400).json({ error: 'violation belongs to a different community than the intake' });
    }

    // Best-effort contact lookup from the property's current owner so the
    // interaction shows up under their contact history too.
    let contactId = null;
    try {
      const { data: pRow } = await supabase
        .from('v_current_property_owners')
        .select('owner_contact_id')
        .eq('property_id', violation.property_id)
        .maybeSingle();
      contactId = pRow && pRow.owner_contact_id;
    } catch (_) {}

    const receivedAt = intake.ingested_at || new Date().toISOString();

    const { data: interaction, error: insErr } = await supabase
      .from('interactions')
      .insert({
        community_id:    violation.community_id,
        property_id:     violation.property_id,
        contact_id:      contactId,
        violation_id:    violation.id,
        type:            'email_inbound',
        direction:       'inbound',
        subject:         intake.subject || '(owner email)',
        content:         intake.raw_content,
        delivery_method: 'email',
        status:          'received',
        sent_at:         receivedAt,
        received_at:     receivedAt,
        source:          'manual',
        original_external_id: `email_intake:${intake.id}`,
        notes:           intake.sender_hint ? `From: ${intake.sender_hint}` : null,
      })
      .select('id')
      .single();
    if (insErr) throw insErr;

    const { data: updated, error: upErr } = await supabase
      .from('email_intake')
      .update({
        attached_violation_id:   violation.id,
        attached_interaction_id: interaction.id,
        attached_property_id:    violation.property_id,
        attached_at:             new Date().toISOString(),
        updated_at:              new Date().toISOString(),
      })
      .eq('id', intake.id)
      .select()
      .single();
    if (upErr) throw upErr;

    res.json({
      intake: updated,
      interaction_id: interaction.id,
      violation_id: violation.id,
      property_id: violation.property_id,
    });
  } catch (err) {
    console.error('[email-intake] attach-to-violation failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /api/email-intelligence/:id/detach-violation
// Undoes the attach. Deletes the interaction row + clears the intake link.
router.post('/:id/detach-violation', async (req, res) => {
  try {
    const { data: intake, error: iErr } = await supabase
      .from('email_intake')
      .select('id, attached_interaction_id, attached_violation_id')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .single();
    if (iErr) throw iErr;
    if (!intake) return res.status(404).json({ error: 'intake not found' });
    if (!intake.attached_violation_id) {
      return res.status(400).json({ error: 'not attached to a violation' });
    }

    if (intake.attached_interaction_id) {
      await supabase
        .from('interactions')
        .delete()
        .eq('id', intake.attached_interaction_id)
        .eq('original_external_id', `email_intake:${intake.id}`); // safety
    }

    const { data: updated, error: upErr } = await supabase
      .from('email_intake')
      .update({
        attached_violation_id:   null,
        attached_interaction_id: null,
        attached_property_id:    null,
        attached_at:             null,
        updated_at:              new Date().toISOString(),
      })
      .eq('id', intake.id)
      .select()
      .single();
    if (upErr) throw upErr;

    res.json({ intake: updated });
  } catch (err) {
    console.error('[email-intake] detach-violation failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
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
    res.status(500).json({ error: safeErrorMessage(err) });
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
    res.status(500).json({ error: safeErrorMessage(err) });
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
    res.status(500).json({ error: safeErrorMessage(err) });
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
  let recap = response.content[0]?.text || '';

  // IP-leak guard: recaps land in front of the board, which includes
  // members with documented competitor conflicts. Scrub before return —
  // auto-rewrite the soft phrases; if a hard-banned phrase remains
  // (e.g., model started narrating Bedrock's methodology), append a
  // BLOCKED warning so the caller can refuse to send.
  try {
    const { screenForLeaks } = require('../lib/voice/leak_filter');
    const screen = screenForLeaks(recap, { audience: 'board', autoRewrite: true });
    if (screen.blocks.length > 0) {
      console.warn('[email_intake/recap] recap BLOCKED by leak filter:',
        screen.blocks.map((b) => `${b.reason} ("${b.matches.slice(0, 2).join('", "')}")`).join('; '));
      recap = '⚠ This recap was blocked by the IP-leak filter because the AI included internal methodology language. Please regenerate or rewrite by hand. Detected: '
        + screen.blocks.map((b) => `"${b.matches.slice(0, 2).join('", "')}"`).join(', ');
    } else if (screen.rewrites.length > 0) {
      recap = screen.text;
    }
  } catch (e) { console.warn('[email_intake/recap] leak filter threw:', e.message); }

  return recap;
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
    res.status(500).json({ error: safeErrorMessage(err) });
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
    res.status(500).json({ error: safeErrorMessage(err) });
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
    res.status(500).json({ error: safeErrorMessage(err) });
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
    res.status(500).json({ error: safeErrorMessage(err) });
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
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /api/email-intelligence/backfill-entities
// One-shot (re-runnable) backfill of property_id + contact_id on historic
// email_intake rows that pre-date the entity-linkage save path. Same pattern
// as arc-history/backfill-entities — batched, idempotent, mirrors FKs onto
// the knowledge_documents substrate parent so askEd can filter by property
// or person from the moment a row gets linked.
//
// Query params: offset, limit (max 100), community_id, force
// ----------------------------------------------------------------------------
router.post('/backfill-entities', async (req, res) => {
  const t0 = Date.now();
  try {
    const offset = Math.max(0, parseInt(req.query.offset || req.body?.offset || 0, 10));
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || req.body?.limit || 25, 10)));
    const force = (req.query.force === '1' || req.body?.force === true);

    let q = supabase
      .from('email_intake')
      .select('id, community_id, subject, sender_hint, extracted_data, property_id, contact_id', { count: 'exact' })
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .neq('extraction_status', 'error')
      .order('ingested_at', { ascending: true });

    if (!force) q = q.or('property_id.is.null,contact_id.is.null');
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);

    const { data: rows, error, count } = await q.range(offset, offset + limit - 1);
    if (error) throw error;

    const results = {
      queue_total: count || 0,
      offset,
      limit,
      processed_this_batch: 0,
      indexed_property: 0,
      indexed_contact: 0,
      already_linked: 0,
      unmatched_property: 0,
      unmatched_contact: 0,
      ambiguous_contact: 0,
      details: [],
    };

    for (const row of (rows || [])) {
      const wasFullyLinked = row.property_id && row.contact_id;
      if (wasFullyLinked && !force) {
        results.already_linked += 1;
        continue;
      }

      const ed = row.extracted_data || {};
      const senderEmail = ed.sender_email || ed.from_email || ed.email_from || null;
      const senderName = ed.sender_name || ed.from_name || ed.sender || row.sender_hint || null;
      const propertyAddress = ed.property_address || ed.address
        || (Array.isArray(ed.mentioned_addresses) && ed.mentioned_addresses[0])
        || null;

      let propertyId = row.property_id;
      let contactId = row.contact_id;
      let propStatus = propertyId ? 'kept' : (propertyAddress ? 'unmatched' : 'no_address');
      let contactStatus = contactId ? 'kept' : ((senderEmail || senderName) ? 'unmatched' : 'no_sender');

      if ((!propertyId || force) && propertyAddress && row.community_id) {
        const p = await resolveProperty(supabase, row.community_id, propertyAddress);
        if (p && p.id) {
          propertyId = p.id;
          propStatus = 'matched';
          results.indexed_property += 1;
        } else {
          results.unmatched_property += 1;
        }
      }

      if ((!contactId || force) && (senderEmail || senderName)) {
        const c = await resolveContact(supabase, {
          email: senderEmail,
          name: senderName,
          communityId: row.community_id,
          propertyId,
        });
        if (c && c.id && !c.ambiguous) {
          contactId = c.id;
          contactStatus = 'matched';
          results.indexed_contact += 1;
        } else if (c && c.ambiguous) {
          contactStatus = 'ambiguous';
          results.ambiguous_contact += 1;
        } else {
          results.unmatched_contact += 1;
        }
      }

      if (propertyId !== row.property_id || contactId !== row.contact_id) {
        await supabase
          .from('email_intake')
          .update({ property_id: propertyId, contact_id: contactId })
          .eq('id', row.id);

        await supabase
          .from('knowledge_documents')
          .update({ property_id: propertyId, contact_id: contactId })
          .eq('source_type', 'email')
          .eq('source_record_id', row.id);
      }

      results.processed_this_batch += 1;
      if (propStatus !== 'matched' && contactStatus !== 'matched') {
        results.details.push({
          id: row.id,
          subject: row.subject ? row.subject.slice(0, 80) : null,
          sender: senderName,
          email: senderEmail,
          address: propertyAddress,
          property: propStatus,
          contact: contactStatus,
        });
      }
    }

    results.next_offset = offset + (rows || []).length;
    results.done = (rows || []).length < limit;
    results.duration_ms = Date.now() - t0;
    res.json(results);
  } catch (err) {
    console.error('[email-intake] backfill-entities failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
