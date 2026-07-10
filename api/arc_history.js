// ============================================================================
// ARC History API
// ----------------------------------------------------------------------------
// Mounted at /api/arc-history.
//
// Workflow:
//   1. Staff drags a PDF / image / .eml of a past ARC letter
//   2. the AI extracts structured fields (project_type, decision_type,
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
const { resolveProperty, resolveContact } = require('../lib/entity_resolution');

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

// Compose the display title + chunk text used by the unified knowledge
// substrate (project_unified_architecture.md). Same algorithm migration 074
// uses for historical rows so re-runs across the two paths produce
// equivalent content.
function buildArcSubstrateBody(decision) {
  const title = [
    decision.property_address && String(decision.property_address).trim(),
    decision.project_type && String(decision.project_type)[0].toUpperCase() + String(decision.project_type).slice(1),
    decision.decision_type && String(decision.decision_type)[0].toUpperCase() + String(decision.decision_type).slice(1),
  ].filter(Boolean).join(' — ') || (`ARC decision ${decision.decided_at || decision.created_at || ''}`).trim();

  const lines = [];
  lines.push(`Project: ${decision.project_type || 'unspecified'}`);
  if (decision.property_address) lines.push(`Property: ${decision.property_address}`);
  if (decision.homeowner_name)   lines.push(`Homeowner: ${decision.homeowner_name}`);
  if (decision.decided_at)       lines.push(`Decided: ${decision.decided_at}`);
  if (decision.decision_type)    lines.push(`Outcome: ${decision.decision_type}`);
  if (decision.decided_by)       lines.push(`Decided by: ${decision.decided_by}`);
  if (decision.project_description) lines.push(`\nDescription: ${decision.project_description}`);
  if (decision.summary)             lines.push(`\nSummary: ${decision.summary}`);
  if (decision.conditions)          lines.push(`\nConditions: ${decision.conditions}`);
  if (decision.reasoning)           lines.push(`\nReasoning: ${decision.reasoning}`);
  return { title, text: lines.join('\n') };
}

// Dual-write an ARC decision into the unified substrate. Idempotent on
// source_record_id so re-saves update the existing parent + chunk in place.
// Non-fatal: failures here never block the primary arc_historical_decisions
// write.
async function upsertArcDecisionIntoSubstrate(decision) {
  if (!decision || !decision.id || !decision.embedding) return null;
  const { title, text } = buildArcSubstrateBody(decision);

  try {
    const { data: existing } = await supabase
      .from('knowledge_documents')
      .select('id')
      .eq('source_type', 'arc_decision')
      .eq('source_record_id', decision.id)
      .maybeSingle();

    let parentId = existing && existing.id;
    if (parentId) {
      await supabase
        .from('knowledge_documents')
        .update({
          title,
          community_id: decision.community_id || null,
          property_id: decision.property_id || null,
          contact_id: decision.contact_id || null,
          effective_date: decision.decided_at || null,
          chunk_count: 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', parentId);
    } else {
      const { data: newParent, error: parentErr } = await supabase
        .from('knowledge_documents')
        .insert({
          management_company_id: decision.management_company_id || BEDROCK_MGMT_CO_ID,
          title,
          source_type: 'arc_decision',
          community_id: decision.community_id || null,
          property_id: decision.property_id || null,
          contact_id: decision.contact_id || null,
          source_record_id: decision.id,
          status: 'active',
          ingested_at: decision.created_at || new Date().toISOString(),
          effective_date: decision.decided_at || null,
          model_version: 'text-embedding-ada-002@v1',
          access_level: 'staff_internal',
          notes: [decision.source_filename, decision.extraction_confidence ? `extraction:${decision.extraction_confidence}` : null].filter(Boolean).join(' · ') || null,
          file_name: decision.source_filename || null,
          chunk_count: 1,
        })
        .select('id')
        .single();
      if (parentErr) throw parentErr;
      parentId = newParent.id;
    }

    // Wipe + reinsert single chunk so text/embedding stay in sync with edits
    await supabase.from('knowledge_chunks').delete().eq('document_id', parentId);
    const { error: chunkErr } = await supabase.from('knowledge_chunks').insert({
      document_id:   parentId,
      chunk_index:   0,
      text,
      embedding:     decision.embedding,
      model_version: 'text-embedding-ada-002@v1',
    });
    if (chunkErr) throw chunkErr;

    return parentId;
  } catch (e) {
    console.warn('[arc-history] substrate upsert failed (non-fatal):', e.message);
    return null;
  }
}

async function extractFileText(file) {
  const mime = file.mimetype || '';
  const name = (file.originalname || '').toLowerCase();
  if (mime === 'application/pdf' || name.endsWith('.pdf')) {
    const parsed = await pdfParse(file.buffer);
    return parsed.text || '';
  }
  // For images, defer to the AI vision in extractWithAi.
  if (mime.startsWith('image/')) return null;
  // .eml / .txt / anything else as text
  return file.buffer.toString('utf8');
}

async function extractWithAi({ text, file, communityName }) {
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
    const { data: extracted } = await extractWithAi({ text, file: req.file, communityName });

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

    // Store the decision LETTER itself (the PDF/image that went to the homeowner)
    // so the exact approval is retrievable + linkable from the record and the
    // board report. Non-fatal on storage failure.
    let sourceDocumentPath = null;
    if (req.file && req.file.buffer) {
      try {
        const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 16);
        const safe = (req.file.originalname || 'arc_decision').replace(/[^a-zA-Z0-9._\-]/g, '_');
        sourceDocumentPath = `arc_decisions/${communityId}/${hash}_${safe}`;
        await supabase.storage.from('documents').upload(sourceDocumentPath, req.file.buffer, {
          contentType: req.file.mimetype || 'application/octet-stream', upsert: true,
        });
      } catch (e) {
        console.warn('[arc-history] letter storage upload failed (non-fatal):', e.message);
        sourceDocumentPath = null;
      }
    }

    // Build text for embedding (project + reasoning + summary)
    const embedSource = [
      extracted.project_type,
      extracted.project_description,
      extracted.conditions,
      extracted.reasoning,
      extracted.summary
    ].filter(Boolean).join(' — ').slice(0, 6000);

    const embedding = await embed(embedSource);

    // Dedup pre-check: same community + same normalized address + same
    // decided_at + same project_type → almost certainly a duplicate.
    // Skip the insert and return the existing row.
    if (extracted.property_address && extracted.decided_at && extracted.project_type) {
      const addrNorm = String(extracted.property_address).toLowerCase().replace(/\s+/g, ' ').trim();
      const { data: existing } = await supabase
        .from('arc_historical_decisions')
        .select('id, property_address, decided_at, project_type, decision_type, summary, source_filename, created_at')
        .eq('community_id', communityId)
        .eq('management_company_id', BEDROCK_MGMT_CO_ID)
        .eq('decided_at', extracted.decided_at)
        .eq('project_type', extracted.project_type);
      const dupe = (existing || []).find((r) =>
        String(r.property_address || '').toLowerCase().replace(/\s+/g, ' ').trim() === addrNorm
      );
      if (dupe) {
        return res.json({
          ok: true,
          duplicate: true,
          decision: dupe,
          message: `Skipped — a decision for ${dupe.property_address} on ${dupe.decided_at} (${dupe.project_type}) is already in the library.`
        });
      }
    }

    // Entity-graph resolution. Match address → properties.id; match
    // homeowner_name (with property scope when we found one) → contacts.id.
    // Match-only — we do NOT createIfMissing here. If a row arrives with an
    // address that doesn't match a Vantaca-synced property, that's a flag
    // for staff to investigate, not a reason to fabricate a property row.
    let propertyRow = null;
    let contactRow = null;
    if (extracted.property_address) {
      propertyRow = await resolveProperty(supabase, communityId, extracted.property_address);
    }
    if (extracted.homeowner_name) {
      contactRow = await resolveContact(supabase, {
        name: extracted.homeowner_name,
        email: extracted.homeowner_email || null,
        communityId,
        propertyId: propertyRow && propertyRow.id,
      });
    }

    const insert = {
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id: communityId,
      source_filename: sourceFilename,
      source_document_path: sourceDocumentPath,
      source_excerpt: req.body.source_excerpt || null,
      property_address: extracted.property_address || null,
      homeowner_name: extracted.homeowner_name || null,
      property_id: propertyRow && propertyRow.id ? propertyRow.id : null,
      contact_id: contactRow && contactRow.id && !contactRow.ambiguous ? contactRow.id : null,
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

    // Dual-write into the unified substrate so askEd can retrieve this
    // decision alongside library docs + emails. Non-fatal if it fails.
    await upsertArcDecisionIntoSubstrate(data);

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
// GET /api/arc-history/:id/document — open the stored decision letter (the PDF
// that went to the homeowner). Redirects to a short-lived signed URL.
// ----------------------------------------------------------------------------
router.get('/:id/document', async (req, res) => {
  try {
    const { data: row } = await supabase.from('arc_historical_decisions')
      .select('source_document_path').eq('id', req.params.id).maybeSingle();
    if (!row || !row.source_document_path) return res.status(404).json({ error: 'no_document_on_file' });
    const { data, error } = await supabase.storage.from('documents')
      .createSignedUrl(String(row.source_document_path), 60 * 60);
    if (error || !data || !data.signedUrl) return res.status(404).json({ error: 'file_not_found' });
    res.redirect(data.signedUrl);
  } catch (err) {
    console.error('[arc-history] document fetch failed:', err.message);
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

    // Re-resolve property/contact when address or homeowner_name was edited.
    // Edits often correct a misread address ('123 Forest Ln' → '123 Forest
    // Lane'); re-running the resolver lets us catch a match that wasn't found
    // before. Match-only — no createIfMissing on edits.
    if ('property_address' in patch || 'homeowner_name' in patch) {
      const { data: row } = await supabase
        .from('arc_historical_decisions')
        .select('community_id, property_address, homeowner_name')
        .eq('id', req.params.id)
        .single();
      const merged = { ...row, ...patch };
      if (merged.property_address) {
        const p = await resolveProperty(supabase, merged.community_id, merged.property_address);
        patch.property_id = p && p.id ? p.id : null;
      } else {
        patch.property_id = null;
      }
      if (merged.homeowner_name) {
        const c = await resolveContact(supabase, {
          name: merged.homeowner_name,
          communityId: merged.community_id,
          propertyId: patch.property_id || null,
        });
        patch.contact_id = c && c.id && !c.ambiguous ? c.id : null;
      } else {
        patch.contact_id = null;
      }
    }

    const { data, error } = await supabase
      .from('arc_historical_decisions')
      .update(patch)
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .select()
      .single();
    if (error) throw error;

    // Mirror the edit into the unified substrate (title may have changed,
    // text may have changed, embedding may have changed if textChanged).
    await upsertArcDecisionIntoSubstrate(data);

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
    // Also remove the substrate parent so deleted decisions stop appearing
    // in askEd results. knowledge_chunks cascade via the FK on document_id.
    try {
      await supabase
        .from('knowledge_documents')
        .delete()
        .eq('source_type', 'arc_decision')
        .eq('source_record_id', req.params.id);
    } catch (e) { console.warn('[arc-history] substrate cleanup failed (non-fatal):', e.message); }

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

// ----------------------------------------------------------------------------
// GET /api/arc-history/find-duplicates — list groups of likely duplicates
// Query: ?community_id= (optional)
// Returns groups where (community + normalized_address + decided_at + project_type) collide
// ----------------------------------------------------------------------------
router.get('/find-duplicates', async (req, res) => {
  try {
    let q = supabase
      .from('arc_historical_decisions')
      .select('id, community_id, property_address, homeowner_name, project_type, decision_type, decided_at, summary, source_filename, manually_edited, extraction_confidence, created_at, community:communities(name)')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    const { data, error } = await q;
    if (error) throw error;

    // Group client-side by (community_id, normalized address, decided_at, project_type)
    const groups = new Map();
    for (const r of data || []) {
      const addr = String(r.property_address || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!addr || !r.decided_at || !r.project_type) continue;
      const key = `${r.community_id}|${addr}|${r.decided_at}|${r.project_type}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }

    // Only return groups with >1 row
    const dupes = [];
    for (const [key, rows] of groups.entries()) {
      if (rows.length < 2) continue;
      dupes.push({
        key,
        sample: rows[0],
        rows: rows.sort(rankByKeepPreference)
      });
    }

    res.json({ groups: dupes, total_groups: dupes.length, total_duplicates: dupes.reduce((sum, g) => sum + g.rows.length - 1, 0) });
  } catch (err) {
    console.error('[arc-history] find-duplicates failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// rankByKeepPreference — prefer manually-edited, then high confidence, then oldest
function rankByKeepPreference(a, b) {
  if (a.manually_edited !== b.manually_edited) return a.manually_edited ? -1 : 1;
  const confOrder = { high: 0, medium: 1, low: 2 };
  const ca = confOrder[a.extraction_confidence] ?? 3;
  const cb = confOrder[b.extraction_confidence] ?? 3;
  if (ca !== cb) return ca - cb;
  return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
}

// ----------------------------------------------------------------------------
// POST /api/arc-history/auto-dedupe — keep best row in each group, delete rest
// Body (optional): { community_id, dry_run: true|false }
// ----------------------------------------------------------------------------
router.post('/auto-dedupe', express.json(), async (req, res) => {
  try {
    const { community_id, dry_run } = req.body || {};
    let q = supabase
      .from('arc_historical_decisions')
      .select('id, community_id, property_address, project_type, decision_type, decided_at, manually_edited, extraction_confidence, created_at')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    if (community_id) q = q.eq('community_id', community_id);
    const { data, error } = await q;
    if (error) throw error;

    // Group
    const groups = new Map();
    for (const r of data || []) {
      const addr = String(r.property_address || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!addr || !r.decided_at || !r.project_type) continue;
      const key = `${r.community_id}|${addr}|${r.decided_at}|${r.project_type}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }

    // Build delete list: in each group with >1 row, sort by keep-preference,
    // mark all but the first for deletion.
    const toDelete = [];
    const kept = [];
    let groupsProcessed = 0;
    for (const rows of groups.values()) {
      if (rows.length < 2) continue;
      groupsProcessed++;
      const sorted = rows.sort(rankByKeepPreference);
      kept.push(sorted[0].id);
      for (let i = 1; i < sorted.length; i++) toDelete.push(sorted[i].id);
    }

    if (dry_run) {
      return res.json({
        dry_run: true,
        groups_processed: groupsProcessed,
        would_delete: toDelete.length,
        would_keep: kept.length
      });
    }

    if (toDelete.length === 0) {
      return res.json({ groups_processed: 0, deleted: 0, kept: 0, message: 'No duplicates found.' });
    }

    const { error: delErr } = await supabase
      .from('arc_historical_decisions')
      .delete()
      .in('id', toDelete);
    if (delErr) throw delErr;

    res.json({
      ok: true,
      groups_processed: groupsProcessed,
      deleted: toDelete.length,
      kept: kept.length
    });
  } catch (err) {
    console.error('[arc-history] auto-dedupe failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /api/arc-history/backfill-entities
// One-shot (re-runnable) backfill of property_id + contact_id on historic
// arc_historical_decisions rows that pre-date the entity-linkage save path.
// Walks rows that still have a NULL FK, resolves via the entity resolver,
// updates the row + the substrate parent. Batched with offset/limit so the
// operator can watch progress and so we never block on a single huge run.
//
// Idempotent: rows that already have both FKs filled are skipped. Re-running
// after Vantaca sync picks up new properties/contacts that weren't there
// on a previous pass.
//
// Query params:
//   ?offset=0       paging offset (default 0)
//   ?limit=25       rows per batch (default 25, max 100)
//   ?community_id=  optional scope to one community
//   ?force=1        also re-resolve rows that already have FKs (e.g., after
//                   a property/contact merge or address correction)
// ----------------------------------------------------------------------------
router.post('/backfill-entities', async (req, res) => {
  const t0 = Date.now();
  try {
    const offset = Math.max(0, parseInt(req.query.offset || req.body?.offset || 0, 10));
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || req.body?.limit || 25, 10)));
    const force = (req.query.force === '1' || req.body?.force === true);

    let q = supabase
      .from('arc_historical_decisions')
      .select('id, community_id, property_address, homeowner_name, property_id, contact_id, decided_at, source_filename, extraction_confidence, created_at, embedding', { count: 'exact' })
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('created_at', { ascending: true });

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

      let propertyId = row.property_id;
      let contactId = row.contact_id;
      let propStatus = propertyId ? 'kept' : 'unmatched';
      let contactStatus = contactId ? 'kept' : 'unmatched';

      if ((!propertyId || force) && row.property_address) {
        const p = await resolveProperty(supabase, row.community_id, row.property_address);
        if (p && p.id) {
          propertyId = p.id;
          propStatus = 'matched';
          results.indexed_property += 1;
        } else {
          results.unmatched_property += 1;
        }
      }

      if ((!contactId || force) && row.homeowner_name) {
        const c = await resolveContact(supabase, {
          name: row.homeowner_name,
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

      // Persist FKs if anything changed
      if (propertyId !== row.property_id || contactId !== row.contact_id) {
        await supabase
          .from('arc_historical_decisions')
          .update({ property_id: propertyId, contact_id: contactId })
          .eq('id', row.id);

        // Mirror to substrate parent
        await supabase
          .from('knowledge_documents')
          .update({ property_id: propertyId, contact_id: contactId })
          .eq('source_type', 'arc_decision')
          .eq('source_record_id', row.id);
      }

      results.processed_this_batch += 1;
      if (propStatus !== 'matched' || contactStatus !== 'matched') {
        results.details.push({
          id: row.id,
          address: row.property_address,
          name: row.homeowner_name,
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
    console.error('[arc-history] backfill-entities failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
