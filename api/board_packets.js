// ============================================================================
// Board Packets — Bedrock board packet generator
// ----------------------------------------------------------------------------
// Endpoints under /api/board-packets to assemble Bedrock-branded board meeting
// packets. "Build the workflow, stub the data" pattern: each section accepts
// manual / upload / auto-from-trustEd input modes. The "auto" mode is stubbed
// today; gets wired to live modules (financials, vendors, contracts) later.
//
//   POST   /                              create new draft packet
//   GET    /                              list packets (filter by community/status)
//   GET    /:id                           packet + sections detail
//   PATCH  /:id                           update packet metadata
//   DELETE /:id                           delete packet
//
//   GET    /templates                     canonical section templates
//
//   PATCH  /:id/sections/:section_key     update a section's input_data / mode
//   POST   /:id/sections/:section_key/upload     upload PDF for a section
//   POST   /:id/sections/:section_key/auto-fill  auto-fill from trustEd (stub today)
//   POST   /:id/sections/:section_key/ai-generate  AI writes the section content
//
//   POST   /:id/render                    generate final HTML packet
//   GET    /:id/preview                   view rendered HTML inline
//   GET    /:id/download                  download rendered PDF (Day 3)
//
//   POST   /:id/distribute                log a distribution event
//   GET    /:id/distribution              distribution log
//
// Design principles applied:
//   - Frustration Test: pick community + period, get 11 sections waiting, fill or skip
//   - Calm Test: section status indicators show what's done / pending at a glance
//   - Proactive Guidance: AI watch-outs surface issues before the meeting
//   - askEd template voice: AI-generated copy uses Action/Output/Reasoning/Watch Outs
// ============================================================================

const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const router = express.Router();

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

// Per-section extraction prompts. Each returns structured JSON matching the
// section's data_schema_hint. Keep these short and concrete.
const SECTION_EXTRACTION_PROMPTS = {
  agenda: `Extract the meeting agenda from this PDF. Return JSON:
{
  "items": [
    { "topic": "string", "presenter": "string or null", "duration_min": <int or null>, "notes": "string or null" }
  ]
}
Return ONLY the JSON, no preamble.`,

  prior_minutes: `This is the previous board meeting minutes. Extract:
{
  "prior_meeting_date": "YYYY-MM-DD or null",
  "summary": "2-3 sentence summary of what happened",
  "motions": [{ "motion": "string", "moved_by": "string", "seconded_by": "string", "result": "passed|failed|tabled" }],
  "action_items_status": [{ "item": "string", "status": "complete|in_progress|carried_forward" }]
}
Return ONLY the JSON, no preamble.`,

  financials: `Extract financial statement data from this PDF (P&L, Balance Sheet, or both):
{
  "period_start": "YYYY-MM-DD or null",
  "period_end": "YYYY-MM-DD or null",
  "total_revenue": <number or null>,
  "total_expense": <number or null>,
  "net_income": <number or null>,
  "cash_operating": <number or null>,
  "cash_reserves": <number or null>,
  "line_items": [{ "account": "string", "amount": <number>, "budget": <number or null>, "type": "revenue|expense|asset|liability|equity" }]
}
Money values are NUMBERS not strings. Use null for missing. Return ONLY the JSON.`,

  drv: `Extract the budget-to-actual variance analysis (Doctivity Variance Report):
{
  "variances": [
    { "category": "string", "budget": <number>, "actual": <number>, "variance": <number>, "variance_pct": <number>, "commentary": "string or null" }
  ]
}
Return ONLY the JSON.`,

  ar_aging: `Extract the AR aging / delinquencies data:
{
  "total_ar": <number>,
  "buckets": { "0_30": <number>, "31_60": <number>, "61_90": <number>, "over_90": <number> },
  "top_delinquent": [{ "unit": "string", "owner": "string or null", "balance": <number>, "oldest_charge_days": <int> }]
}
Return ONLY the JSON.`,

  arc_decisions: `Extract ARC (Architectural Review Committee) decisions from this PDF:
{
  "decisions": [
    { "address": "string", "request": "string", "status": "approved|denied|tabled|withdrawn", "date": "YYYY-MM-DD or null", "notes": "string or null" }
  ]
}
Return ONLY the JSON.`,

  appendix: `This is a supporting document for the board packet. Return a brief description:
{
  "title": "string (short title)",
  "summary": "1-2 sentence description of what this document contains",
  "doc_type": "string (e.g., 'insurance certificate', 'vendor proposal', 'legal notice')"
}
Return ONLY the JSON.`
};

async function extractSectionFromPdf(sectionKey, pdfBuffer) {
  const prompt = SECTION_EXTRACTION_PROMPTS[sectionKey];
  if (!prompt) throw new Error(`No extraction prompt defined for section: ${sectionKey}`);
  const pdfBase64 = pdfBuffer.toString('base64');
  const RETRY_DELAYS_MS = [30000, 60000, 90000];
  let lastError = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const completion = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
            { type: 'text', text: prompt }
          ]
        }]
      });
      const text = completion.content?.[0]?.text || '';
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      return { parsed: JSON.parse(cleaned), usage: completion.usage };
    } catch (err) {
      lastError = err;
      const isRetryable = err.status === 429 || err.status === 529 ||
                          /rate_limit|overloaded/i.test(err.message || '');
      if (!isRetryable || attempt >= RETRY_DELAYS_MS.length) throw err;
      const delay = RETRY_DELAYS_MS[attempt];
      console.warn(`[board_packets] Claude rate-limited, retrying in ${delay/1000}s (attempt ${attempt+1})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// Seed sections for a newly-created packet from the section templates.
// If includedSectionKeys is provided (array of section_key strings), only
// those sections get status='pending'; the rest get status='skipped'.
// If not provided, falls back to the template's required_default flag.
async function seedSectionsForPacket(packetId, includedSectionKeys = null) {
  const { data: templates } = await supabase
    .from('board_packet_section_templates')
    .select('*')
    .order('default_order');
  if (!templates || templates.length === 0) return;
  const rows = templates.map(t => {
    let status;
    if (Array.isArray(includedSectionKeys)) {
      status = includedSectionKeys.includes(t.section_key) ? 'pending' : 'skipped';
    } else {
      status = t.required_default ? 'pending' : 'skipped';
    }
    return {
      packet_id: packetId,
      section_key: t.section_key,
      section_order: t.default_order,
      input_mode: t.supports_ai_generated ? 'ai_generated' :
                  t.supports_manual ? 'manual' :
                  t.supports_upload ? 'upload' : 'manual',
      status
    };
  });
  await supabase.from('board_packet_sections').insert(rows);
}

// ----------------------------------------------------------------------------
// GET /api/board-packets/templates  — canonical section templates
// ----------------------------------------------------------------------------
router.get('/templates', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('board_packet_section_templates')
      .select('*')
      .order('default_order');
    if (error) throw error;
    res.json({ templates: data || [] });
  } catch (err) {
    console.error('[board_packets] templates fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/board-packets  — create a new draft packet
// Body: { community_id, period_label, meeting_date?, meeting_time?,
//         meeting_type?, meeting_format?, meeting_location? }
// ----------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const { community_id, period_label, meeting_date, meeting_time,
            meeting_type, meeting_format, meeting_location, notes,
            included_sections } = req.body || {};
    if (!community_id || !period_label) {
      return res.status(400).json({ error: 'community_id and period_label required' });
    }
    // Check for duplicate (community, period_label)
    const { data: existing } = await supabase
      .from('board_packets')
      .select('id, status')
      .eq('community_id', community_id)
      .eq('period_label', period_label)
      .maybeSingle();
    if (existing) {
      return res.status(409).json({
        error: `Packet already exists for this community + period (status: ${existing.status})`,
        existing_id: existing.id
      });
    }
    const packetId = crypto.randomUUID();
    const { data: packet, error } = await supabase
      .from('board_packets')
      .insert({
        id: packetId,
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id,
        period_label,
        meeting_date: meeting_date || null,
        meeting_time: meeting_time || null,
        meeting_type: meeting_type || 'regular',
        meeting_format: meeting_format || null,
        meeting_location: meeting_location || null,
        notes: notes || null,
        status: 'draft'
      })
      .select()
      .single();
    if (error) throw error;
    await seedSectionsForPacket(
      packetId,
      Array.isArray(included_sections) && included_sections.length > 0 ? included_sections : null
    );

    // Trade tape
    await supabase.from('agent_runs').insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id,
      module: 'board_packets',
      endpoint: 'POST /api/board-packets',
      request_input: { community_id, period_label, meeting_date },
      response: { packet_id: packetId }
    });

    res.json({ ok: true, packet });
  } catch (err) {
    console.error('[board_packets] create failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/board-packets  — list packets (filter by community, status)
// ----------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    let q = supabase
      .from('v_board_packet_summary')
      .select('*')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('meeting_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    if (req.query.status) q = q.eq('status', req.query.status);
    const { data, error } = await q.limit(Number(req.query.limit) || 100);
    if (error) throw error;
    res.json({ packets: data || [] });
  } catch (err) {
    console.error('[board_packets] list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/board-packets/:id  — packet + ordered sections
// ----------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const { data: packet, error: pErr } = await supabase
      .from('board_packets')
      .select('*, community:communities(id, name, legal_name)')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!packet) return res.status(404).json({ error: 'Packet not found' });
    const { data: sections, error: sErr } = await supabase
      .from('board_packet_sections')
      .select('*, template:board_packet_section_templates(*)')
      .eq('packet_id', req.params.id)
      .order('section_order');
    if (sErr) throw sErr;
    res.json({ packet, sections: sections || [] });
  } catch (err) {
    console.error('[board_packets] detail failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// PATCH /api/board-packets/:id  — update packet metadata
// ----------------------------------------------------------------------------
router.patch('/:id', async (req, res) => {
  try {
    const allowed = ['period_label', 'meeting_date', 'meeting_time', 'meeting_type',
                     'meeting_format', 'meeting_location', 'status', 'notes',
                     'ai_exec_summary', 'ai_watch_outs', 'ai_action_items'];
    const update = {};
    for (const k of allowed) if (k in (req.body || {})) update[k] = req.body[k];
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'no updatable fields' });
    const { data, error } = await supabase
      .from('board_packets')
      .update(update)
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .select()
      .single();
    if (error) throw error;
    res.json({ packet: data });
  } catch (err) {
    console.error('[board_packets] patch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// DELETE /api/board-packets/:id
// ----------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('board_packets')
      .delete()
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[board_packets] delete failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// PATCH /api/board-packets/:id/sections/:section_key
// Body: { input_data?, input_mode?, status?, notes? }
// ----------------------------------------------------------------------------
router.patch('/:id/sections/:section_key', async (req, res) => {
  try {
    const allowed = ['input_data', 'input_mode', 'status', 'notes', 'rendered_html'];
    const update = {};
    for (const k of allowed) if (k in (req.body || {})) update[k] = req.body[k];
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'no updatable fields' });
    // If they're providing input_data and no explicit status, flip to 'ready'
    if (update.input_data && !update.status) update.status = 'ready';
    const { data, error } = await supabase
      .from('board_packet_sections')
      .update(update)
      .eq('packet_id', req.params.id)
      .eq('section_key', req.params.section_key)
      .select()
      .single();
    if (error) throw error;
    res.json({ section: data });
  } catch (err) {
    console.error('[board_packets] section patch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/board-packets/:id/sections/:section_key/upload
// Upload a PDF for a section. Claude extracts structured data using the
// section-specific prompt.
// ----------------------------------------------------------------------------
router.post('/:id/sections/:section_key/upload', upload.single('pdf'), async (req, res) => {
  const t0 = Date.now();
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded (expected field "pdf")' });
    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: `Unsupported file type: ${req.file.mimetype}` });
    }
    const sectionKey = req.params.section_key;
    if (!SECTION_EXTRACTION_PROMPTS[sectionKey]) {
      return res.status(400).json({ error: `Section "${sectionKey}" does not support upload extraction` });
    }
    // Run Claude
    const { parsed, usage } = await extractSectionFromPdf(sectionKey, req.file.buffer);
    // Save to the section row
    const { data: section, error } = await supabase
      .from('board_packet_sections')
      .update({
        input_mode: 'upload',
        input_data: parsed,
        status: 'ready',
        extraction_model: 'claude-sonnet-4-5',
        extraction_confidence: 'medium',
        extraction_notes: `Uploaded ${req.file.originalname} (${req.file.size} bytes)`
      })
      .eq('packet_id', req.params.id)
      .eq('section_key', sectionKey)
      .select()
      .single();
    if (error) throw error;

    // Trade tape
    await supabase.from('agent_runs').insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      module: 'board_packets',
      endpoint: `POST /api/board-packets/${req.params.id}/sections/${sectionKey}/upload`,
      request_input: { filename: req.file.originalname, size: req.file.size, section: sectionKey },
      prompt: `SECTION_EXTRACTION_PROMPTS[${sectionKey}]`,
      model: 'claude-sonnet-4-5',
      response: { parsed },
      input_tokens: usage?.input_tokens || null,
      output_tokens: usage?.output_tokens || null,
      duration_ms: Date.now() - t0
    });

    res.json({ ok: true, section, extracted: parsed, duration_ms: Date.now() - t0 });
  } catch (err) {
    console.error('[board_packets] section upload failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/board-packets/:id/sections/:section_key/auto-fill
// STUB today. Once universal askEd / module integrations ship, this calls the
// appropriate trustEd module to pull live data (financials, vendors, etc.).
// ----------------------------------------------------------------------------
router.post('/:id/sections/:section_key/auto-fill', async (req, res) => {
  try {
    // Day 1 stub: return a friendly "not yet" message rather than failing.
    res.status(501).json({
      error: 'auto_fill_not_yet_available',
      message: 'Auto-fill from trustEd modules ships after the universal askEd build (next push). For now, use Manual or Upload mode.',
      section_key: req.params.section_key
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/board-packets/:id/sections/:section_key/ai-generate
// AI-generates content for sections like exec_summary, action_items.
// Reads all OTHER sections' input_data, gives Claude full context, asks for
// the section in Bedrock voice using askEd 4-part template structure.
// ----------------------------------------------------------------------------
router.post('/:id/sections/:section_key/ai-generate', async (req, res) => {
  const t0 = Date.now();
  try {
    const sectionKey = req.params.section_key;
    // Get the packet + all sections for context
    const { data: packet } = await supabase
      .from('board_packets')
      .select('*, community:communities(name)')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!packet) return res.status(404).json({ error: 'Packet not found' });
    const { data: sections } = await supabase
      .from('board_packet_sections')
      .select('section_key, input_data, status')
      .eq('packet_id', req.params.id);

    // Build context from ready sections (excluding this one)
    const contextSections = (sections || [])
      .filter(s => s.section_key !== sectionKey && s.status === 'ready' && s.input_data)
      .map(s => `[${s.section_key}]\n${JSON.stringify(s.input_data, null, 2)}`)
      .join('\n\n');

    let prompt;
    if (sectionKey === 'exec_summary') {
      prompt = `You are writing the Executive Summary for the ${packet.community?.name} board meeting on ${packet.meeting_date || packet.period_label}.

Use Bedrock voice: confident, plain English, CFE-grade clarity. NOT corporate jargon. The audience is volunteer board members who may not be financial experts. Write what they NEED to know, not what you CAN say.

Length: 3-4 short paragraphs.

The packet data assembled so far:
${contextSections || '(no sections completed yet)'}

Return JSON:
{
  "text": "the full executive summary, paragraph-broken with \\n\\n",
  "key_points": ["3-5 bullet points highlighting the most important items"]
}

Return ONLY the JSON, no preamble.`;
    } else if (sectionKey === 'action_items') {
      prompt = `You are consolidating Action Items & Watch Outs for the ${packet.community?.name} board meeting.

Look across all the packet data and identify:
- Items requiring board decision or approval
- Items that need follow-up from a prior meeting
- Issues that should be on the board's radar (variances >10%, expiring contracts, delinquencies trending up, etc.)

Use askEd voice for Watch Outs: each one should explain WHAT, WHY IT MATTERS, and WHAT TO DO.

Packet data:
${contextSections || '(no sections completed yet)'}

Return JSON:
{
  "items": [
    { "item": "string (concise action)", "owner": "Board|Manager|Treasurer|Ed|Other (string)", "due_date": "YYYY-MM-DD or null", "priority": "high|medium|low", "source": "which section this came from (string)" }
  ]
}

Return ONLY the JSON.`;
    } else if (sectionKey === 'cover') {
      // Cover is structured metadata, not AI-generated narrative. Just assemble.
      const coverData = {
        community: packet.community?.name,
        meeting_date: packet.meeting_date,
        meeting_time: packet.meeting_time,
        meeting_type: packet.meeting_type,
        meeting_format: packet.meeting_format,
        meeting_location: packet.meeting_location,
        period_label: packet.period_label
      };
      const { data: section, error } = await supabase
        .from('board_packet_sections')
        .update({
          input_mode: 'ai_generated',
          input_data: coverData,
          status: 'ready'
        })
        .eq('packet_id', req.params.id)
        .eq('section_key', sectionKey)
        .select()
        .single();
      if (error) throw error;
      return res.json({ ok: true, section, generated: coverData, duration_ms: Date.now() - t0 });
    } else {
      return res.status(400).json({ error: `Section "${sectionKey}" does not support AI generation` });
    }

    const completion = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2500,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = completion.content?.[0]?.text || '';
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);

    const { data: section, error } = await supabase
      .from('board_packet_sections')
      .update({
        input_mode: 'ai_generated',
        input_data: parsed,
        status: 'ready',
        extraction_model: 'claude-sonnet-4-5',
        extraction_confidence: 'medium'
      })
      .eq('packet_id', req.params.id)
      .eq('section_key', sectionKey)
      .select()
      .single();
    if (error) throw error;

    await supabase.from('agent_runs').insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id: packet.community_id,
      module: 'board_packets',
      endpoint: `POST /api/board-packets/${req.params.id}/sections/${sectionKey}/ai-generate`,
      request_input: { section: sectionKey },
      prompt: 'AI section generation',
      model: 'claude-sonnet-4-5',
      response: parsed,
      input_tokens: completion.usage?.input_tokens || null,
      output_tokens: completion.usage?.output_tokens || null,
      duration_ms: Date.now() - t0
    });

    res.json({ ok: true, section, generated: parsed, duration_ms: Date.now() - t0 });
  } catch (err) {
    console.error('[board_packets] AI generate failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/board-packets/:id/render
// Day 1 stub: returns the assembled HTML using the design language. Day 3
// will store the rendered HTML/PDF in Supabase Storage and update
// rendered_html_path / rendered_pdf_path.
// ----------------------------------------------------------------------------
router.post('/:id/render', async (req, res) => {
  try {
    // Day 1: thin stub — just mark rendered_at, return placeholder
    const { data: packet, error } = await supabase
      .from('board_packets')
      .update({ rendered_at: new Date().toISOString(), status: 'in_review' })
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .select()
      .single();
    if (error) throw error;
    res.json({
      ok: true,
      packet,
      message: 'Render scaffolded. Full HTML/PDF renderer ships Day 3 — sections are saved and ready for assembly.'
    });
  } catch (err) {
    console.error('[board_packets] render failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/board-packets/:id/preview
// Day 1: returns a minimal HTML preview showing what sections are ready.
// Day 3: returns the full rendered Bedrock-branded HTML.
// ----------------------------------------------------------------------------
router.get('/:id/preview', async (req, res) => {
  try {
    const { data: packet } = await supabase
      .from('board_packets')
      .select('*, community:communities(name)')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (!packet) return res.status(404).send('Packet not found');
    const { data: sections } = await supabase
      .from('board_packet_sections')
      .select('*, template:board_packet_section_templates(display_name)')
      .eq('packet_id', req.params.id)
      .order('section_order');

    // Day 1 minimal preview — just a status page. Day 3 wires the real template.
    const html = `<!DOCTYPE html><html><head>
      <meta charset="UTF-8"><title>${packet.community?.name} — ${packet.period_label}</title>
      <style>
        body { font-family: -apple-system, Inter, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; color: #1a1a1a; }
        h1 { color: #315A87; border-bottom: 2px solid #315A87; padding-bottom: 8px; }
        .section { padding: 12px; border: 1px solid #e0e0e0; border-radius: 6px; margin-bottom: 8px; }
        .status-ready { border-left: 4px solid #2e7d32; }
        .status-pending { border-left: 4px solid #aaa; }
        .status-error { border-left: 4px solid #d32f2f; }
        .status-skipped { border-left: 4px solid #ccc; opacity: 0.5; }
        .status-label { display: inline-block; padding: 2px 8px; font-size: 11px; border-radius: 10px; font-weight: 600; }
        .ready { background: #dff5e0; color: #2e7d32; }
        .pending { background: #f0f0f0; color: #666; }
        pre { background: #fafafa; padding: 8px; font-size: 11px; overflow-x: auto; }
      </style></head><body>
      <h1>${packet.community?.name} — ${packet.period_label}</h1>
      <p><strong>Meeting:</strong> ${packet.meeting_date || '(date TBD)'} ${packet.meeting_type ? '· ' + packet.meeting_type : ''} ${packet.meeting_location ? '· ' + packet.meeting_location : ''}</p>
      <p style="color:#888; font-size:13px;">Day 1 preview. Bedrock-branded rendering ships Day 3.</p>
      ${(sections || []).map(s => `
        <div class="section status-${s.status}">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <strong>${s.template?.display_name || s.section_key}</strong>
            <span class="status-label ${s.status === 'ready' ? 'ready' : 'pending'}">${s.status}</span>
          </div>
          ${s.input_data ? `<pre>${JSON.stringify(s.input_data, null, 2).slice(0, 400)}${JSON.stringify(s.input_data).length > 400 ? '...' : ''}</pre>` : '<div style="color:#aaa; font-size:12px; margin-top:4px;">No data yet</div>'}
        </div>`).join('')}
    </body></html>`;
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('[board_packets] preview failed:', err.message);
    res.status(500).send('Preview failed: ' + err.message);
  }
});

// ----------------------------------------------------------------------------
// POST /api/board-packets/:id/distribute
// Body: { recipients: [...], method: 'email'|'download'|'print'|'share_link', notes? }
// ----------------------------------------------------------------------------
router.post('/:id/distribute', async (req, res) => {
  try {
    const { recipients, method, notes } = req.body || {};
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'recipients array required' });
    }
    if (!method) return res.status(400).json({ error: 'method required' });
    const rows = recipients.map(r => ({
      packet_id: req.params.id,
      distributed_to: typeof r === 'string' ? r : (r.email || r.name || 'unknown'),
      distribution_method: method,
      notes: notes || null
    }));
    const { error } = await supabase.from('board_packet_distribution_log').insert(rows);
    if (error) throw error;
    // Optionally bump packet status to distributed
    if (method === 'email' || method === 'share_link') {
      await supabase
        .from('board_packets')
        .update({ status: 'distributed' })
        .eq('id', req.params.id);
    }
    res.json({ ok: true, distributed: rows.length });
  } catch (err) {
    console.error('[board_packets] distribute failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/board-packets/:id/distribution
// ----------------------------------------------------------------------------
router.get('/:id/distribution', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('board_packet_distribution_log')
      .select('*')
      .eq('packet_id', req.params.id)
      .order('distributed_at', { ascending: false });
    if (error) throw error;
    res.json({ events: data || [] });
  } catch (err) {
    console.error('[board_packets] distribution log failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
