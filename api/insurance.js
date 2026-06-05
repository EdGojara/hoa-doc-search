// ============================================================================
// Insurance Comparison — board-facing quote-comparison module
// ----------------------------------------------------------------------------
// Endpoints under /api/insurance for the renewal-quote comparison workflow:
//
//   POST   /comparisons                          create comparison shell
//   GET    /comparisons?community_id&status      list (paged)
//   GET    /comparisons/:id                      detail incl. all quotes
//   PATCH  /comparisons/:id                      update meta / status / decision
//   DELETE /comparisons/:id                      delete (cascades to quotes)
//
//   POST   /comparisons/:id/quotes               upload PDF → Claude extract → save
//   PATCH  /comparisons/:id/quotes/:qid          manual override of extracted fields
//   DELETE /comparisons/:id/quotes/:qid          remove a quote
//
//   POST   /comparisons/:id/synthesize           run Bedrock recommendation lens
//
// Architecture (per CLAUDE.md):
//   - Quote PDFs live in library_documents (category='insurance_quote').
//   - insurance_quotes mirrors structured extraction; the PDF is the source.
//   - Extract → Validate → Render: Claude binary-PDF extract per Swim Houston
//     scar (pdf-parse cannot read form-field overlays on insurance quotes).
//   - Catastrophic-output surface: every synthesis paragraph is hedged with
//     "informational summary — coverage decisions remain with the licensed
//     agent + board" boilerplate; we never assert coverage adequacy as a
//     legal position.
//   - record_ownership: 'mixed'. The structured rows + synthesis text on the
//     board packet = association_record; the extraction_raw + warnings =
//     workpaper. Termination export filters accordingly.
// ============================================================================

const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },   // 25MB — insurance quote PDFs can be long
});

const router = express.Router();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const POLICY_TYPES = [
  'property_master', 'general_liability', 'd_and_o', 'fidelity_crime',
  'umbrella', 'workers_comp', 'cyber', 'flood', 'package',
];
const POLICY_TYPE_LABELS = {
  property_master: 'Property / Master',
  general_liability: 'General Liability',
  d_and_o: 'Directors & Officers',
  fidelity_crime: 'Fidelity / Crime',
  umbrella: 'Umbrella',
  workers_comp: 'Workers Comp',
  cyber: 'Cyber',
  flood: 'Flood',
  package: 'Package (Bundled)',
};

const EXTRACTION_MODEL = 'claude-sonnet-4-5';
const SYNTHESIS_MODEL  = 'claude-sonnet-4-5';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Parse a dollar string like "$1,234.56" or "1,000,000" → cents (bigint).
// Returns null for unparseable. Used as a safety net when the model returns
// a string instead of the requested integer cents.
function dollarsToCents(input) {
  if (input == null || input === '') return null;
  if (typeof input === 'number') {
    return Math.round(input * 100);
  }
  const s = String(input).replace(/[$,\s]/g, '');
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}

function centsOrNull(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  const n = dollarsToCents(v);
  return n;
}

function isoOrNull(v) {
  if (!v) return null;
  // Accept YYYY-MM-DD straight through.
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function arrOrNull(v) {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x) => x != null && String(x).trim() !== '').map((x) => String(x).trim());
  return out.length > 0 ? out : null;
}

// Confidence assigned by counting how many critical fields the model filled.
function gradeConfidence(extracted) {
  const must = [
    extracted.carrier_name,
    extracted.annual_premium_cents,
    extracted.effective_date,
  ];
  const helpful = [
    extracted.am_best_rating,
    extracted.deductible_cents,
    extracted.per_occurrence_limit_cents || extracted.liability_limit_cents
      || extracted.property_limit_cents || extracted.d_and_o_limit_cents,
  ];
  const mustHit = must.filter(Boolean).length;
  const helpHit = helpful.filter(Boolean).length;
  if (mustHit === 3 && helpHit >= 2) return 'high';
  if (mustHit >= 2 && helpHit >= 1) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Claude extraction
// ---------------------------------------------------------------------------
async function extractQuoteFromPdf({ pdfBuffer, policyType }) {
  const typeLabel = POLICY_TYPE_LABELS[policyType] || policyType;
  const prompt = `You are reading an HOA insurance quote PDF (policy type: ${typeLabel}).

Extract the policy facts into the JSON schema below. Return ONLY valid JSON — no prose, no markdown fences, no commentary.

CRITICAL RULES:
- All money values must be integers in CENTS (e.g. 250000 for "$2,500.00"). Never return strings or decimals.
- For dates use ISO YYYY-MM-DD format.
- If a field is genuinely not present in the PDF, return null for that field. DO NOT GUESS. DO NOT FREESTYLE.
- For policies with separate wind/hail deductibles common in Texas: capture wind_hail_deductible_pct (e.g. 2.0 for "2%") OR wind_hail_deductible_cents if it's a flat dollar, not both.
- am_best_rating: report the carrier's A.M. Best rating as printed (e.g. "A+", "A", "A-"). Null if not stated.
- notable_endorsements: short array of named endorsements that materially expand coverage (Equipment Breakdown, Ordinance & Law, Service Line, etc.). Include limits inline if shown ("Ordinance & Law $50k").
- notable_exclusions: short array of carve-outs the board needs to know about (mold caps, asbestos, fungus, cyber, terrorism, named-storm sublimit). Include cap dollar amounts inline.
- notable_sublimits: a JSON object mapping sublimit name (lowercase, snake_case) to cents value. E.g. {"mold": 2500000, "fungus": 2500000}.
- extraction_warnings: array of plain-English notes when a critical field could not be confidently located. Example: ["aggregate_limit not visible — only per-occurrence shown", "effective_date inferred from quote_date + 1 year"].

JSON schema:
{
  "carrier_name": string | null,
  "agent_name": string | null,
  "agent_email": string | null,
  "agent_phone": string | null,
  "policy_number": string | null,
  "quote_number": string | null,
  "annual_premium_cents": integer | null,
  "effective_date": "YYYY-MM-DD" | null,
  "expiration_date": "YYYY-MM-DD" | null,
  "am_best_rating": string | null,
  "deductible_cents": integer | null,
  "per_occurrence_limit_cents": integer | null,
  "aggregate_limit_cents": integer | null,
  "property_limit_cents": integer | null,
  "liability_limit_cents": integer | null,
  "d_and_o_limit_cents": integer | null,
  "fidelity_limit_cents": integer | null,
  "umbrella_limit_cents": integer | null,
  "flood_limit_cents": integer | null,
  "coinsurance_pct": number | null,
  "replacement_cost": boolean | null,
  "blanket_limit": boolean | null,
  "wind_hail_deductible_pct": number | null,
  "wind_hail_deductible_cents": integer | null,
  "notable_endorsements": string[] | null,
  "notable_exclusions": string[] | null,
  "notable_sublimits": object | null,
  "payment_options": string[] | null,
  "extraction_warnings": string[] | null
}`;

  const response = await anthropic.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 3500,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') },
        },
        { type: 'text', text: prompt },
      ],
    }],
  });

  const raw = response?.content?.[0]?.text || '';
  // Diagnostic-first: log raw model output before parsing.
  console.log('[insurance.extract] raw model output (first 1500 chars):', raw.slice(0, 1500));

  // Strip markdown fences if the model added them despite instruction.
  let jsonText = raw.trim();
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    const e = new Error('Extraction returned non-JSON output');
    e.raw_extracted = raw;
    e.parse_error = err.message;
    throw e;
  }

  // Coerce types defensively in case model returned strings for cents.
  const moneyFields = [
    'annual_premium_cents', 'deductible_cents', 'per_occurrence_limit_cents',
    'aggregate_limit_cents', 'property_limit_cents', 'liability_limit_cents',
    'd_and_o_limit_cents', 'fidelity_limit_cents', 'umbrella_limit_cents',
    'flood_limit_cents', 'wind_hail_deductible_cents',
  ];
  for (const k of moneyFields) parsed[k] = centsOrNull(parsed[k]);
  parsed.effective_date = isoOrNull(parsed.effective_date);
  parsed.expiration_date = isoOrNull(parsed.expiration_date);
  parsed.notable_endorsements = arrOrNull(parsed.notable_endorsements);
  parsed.notable_exclusions = arrOrNull(parsed.notable_exclusions);
  parsed.payment_options = arrOrNull(parsed.payment_options);
  parsed.extraction_warnings = arrOrNull(parsed.extraction_warnings) || [];

  return { extracted: parsed, raw };
}

// ---------------------------------------------------------------------------
// Synthesis (the Bedrock recommendation paragraph)
// ---------------------------------------------------------------------------
function centsFmt(c) {
  if (c == null) return 'not stated';
  return '$' + (Number(c) / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function quoteSummaryLine(q) {
  const parts = [
    `Carrier: ${q.carrier_name || '(unknown)'}`,
    `AM Best: ${q.am_best_rating || '—'}`,
    `Premium: ${centsFmt(q.annual_premium_cents)}`,
    `Deductible: ${centsFmt(q.deductible_cents)}`,
  ];
  if (q.per_occurrence_limit_cents) parts.push(`Per-occ: ${centsFmt(q.per_occurrence_limit_cents)}`);
  if (q.aggregate_limit_cents) parts.push(`Aggregate: ${centsFmt(q.aggregate_limit_cents)}`);
  if (q.property_limit_cents) parts.push(`Property: ${centsFmt(q.property_limit_cents)}`);
  if (q.liability_limit_cents) parts.push(`Liability: ${centsFmt(q.liability_limit_cents)}`);
  if (q.d_and_o_limit_cents) parts.push(`D&O: ${centsFmt(q.d_and_o_limit_cents)}`);
  if (q.wind_hail_deductible_pct) parts.push(`Wind/hail: ${q.wind_hail_deductible_pct}%`);
  if (q.notable_endorsements?.length) parts.push(`Endorsements: ${q.notable_endorsements.join('; ')}`);
  if (q.notable_exclusions?.length) parts.push(`Exclusions: ${q.notable_exclusions.join('; ')}`);
  return parts.join(' · ');
}

async function generateSynthesis({ comparison, quotes, communityName }) {
  const summaries = quotes
    .map((q, i) => `Quote ${i + 1} — ${quoteSummaryLine(q)}`)
    .join('\n\n');

  const typeLabel = POLICY_TYPE_LABELS[comparison.policy_type] || comparison.policy_type;
  const prompt = `You are Bedrock's insurance-quote analyst preparing a board-packet summary for ${communityName}.

Policy type: ${typeLabel}
Policy year: ${comparison.policy_year || 'TBD'}
Effective date target: ${comparison.effective_date || 'TBD'}

Quotes received:

${summaries}

Write a board-packet recommendation in 4-6 short paragraphs. Cover:

1. Apples-to-apples comparison — what's actually different between the quotes, in plain language. Premium delta only matters if limits + deductibles + exclusions are comparable; flag where they aren't.
2. Carrier financial strength — note A.M. Best ratings; flag anything below A-.
3. Texas-specific concerns — wind/hail deductible structure (% vs flat $), named-storm sublimits, mold/fungus caps. These are where Texas HOAs get hurt at claim time.
4. Notable exclusions or sublimits the board should know about before they decide.
5. Bedrock's recommendation — frame as "we'd lead with Carrier X because..." with reasoning. If the quotes aren't comparable enough to recommend, say so and tell the board what to ask the agent for.

HARD RULES:
- This is informational analysis for the board's fiduciary decision. The licensed agent of record makes the actual coverage decision and binds. Never assert that any quote provides "adequate" coverage as a legal conclusion.
- Treasurer-grade tone — concrete numbers, no jargon, no marketing copy. Specific dollar amounts and named carriers, not "competitive pricing" or "strong coverage."
- No invented facts. If a field wasn't extracted, say "not stated in the quote — confirm with the agent." Do not freestyle limits or endorsements.
- End with one sentence: "Final coverage decisions remain with the agent of record and the board."`;

  const response = await anthropic.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: 2500,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response?.content?.[0]?.text || '';
  return text.trim();
}

// ---------------------------------------------------------------------------
// CRUD: comparisons
// ---------------------------------------------------------------------------

router.post('/comparisons', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const { community_id, policy_type, title, policy_year, effective_date } = req.body || {};
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    if (!policy_type || !POLICY_TYPES.includes(policy_type)) {
      return res.status(400).json({ error: 'policy_type_required', allowed: POLICY_TYPES });
    }
    const { data, error } = await supabase
      .from('insurance_comparisons')
      .insert({
        community_id,
        policy_type,
        title: title || `${POLICY_TYPE_LABELS[policy_type]} — ${policy_year || new Date().getFullYear() + 1}`,
        policy_year: policy_year || null,
        effective_date: isoOrNull(effective_date),
        status: 'draft',
      })
      .select('*')
      .single();
    if (error) throw error;
    res.json({ comparison: data });
  } catch (err) {
    console.error('[insurance] create comparison failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/comparisons', async (req, res) => {
  try {
    const { community_id, status, limit = '50' } = req.query;
    let q = supabase
      .from('insurance_comparisons')
      .select('*, communities(name, slug)')
      .order('updated_at', { ascending: false })
      .limit(Math.min(parseInt(limit, 10) || 50, 200));
    if (community_id) q = q.eq('community_id', community_id);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;

    // Decorate each with a quote count (small N — fine to do per-row;
    // when this gets big we'll add a count_view).
    const ids = (data || []).map((c) => c.id);
    let counts = {};
    if (ids.length > 0) {
      const { data: countRows } = await supabase
        .from('insurance_quotes')
        .select('comparison_id')
        .in('comparison_id', ids);
      for (const r of countRows || []) {
        counts[r.comparison_id] = (counts[r.comparison_id] || 0) + 1;
      }
    }
    const decorated = (data || []).map((c) => ({ ...c, quote_count: counts[c.id] || 0 }));
    res.json({ comparisons: decorated });
  } catch (err) {
    console.error('[insurance] list comparisons failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/comparisons/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: comp, error: cErr } = await supabase
      .from('insurance_comparisons')
      .select('*, communities(name, slug)')
      .eq('id', id)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!comp) return res.status(404).json({ error: 'not_found' });

    const { data: quotes, error: qErr } = await supabase
      .from('insurance_quotes')
      .select('*, library_documents(id, title, storage_path, original_filename)')
      .eq('comparison_id', id)
      .order('annual_premium_cents', { ascending: true, nullsFirst: false })
      .limit(20);
    if (qErr) throw qErr;

    res.json({ comparison: comp, quotes: quotes || [] });
  } catch (err) {
    console.error('[insurance] get comparison failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.patch('/comparisons/:id', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = [
      'title', 'policy_year', 'effective_date', 'status',
      'selected_quote_id', 'board_decision_date', 'board_decision_notes',
    ];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    if (patch.effective_date) patch.effective_date = isoOrNull(patch.effective_date);
    if (patch.board_decision_date) patch.board_decision_date = isoOrNull(patch.board_decision_date);
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no_fields_to_update' });

    const { data, error } = await supabase
      .from('insurance_comparisons')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw error;
    res.json({ comparison: data });
  } catch (err) {
    console.error('[insurance] update comparison failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.delete('/comparisons/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('insurance_comparisons').delete().eq('id', id);
    if (error) throw error;
    res.json({ deleted: true });
  } catch (err) {
    console.error('[insurance] delete comparison failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// Quote upload + extract
// ---------------------------------------------------------------------------
router.post('/comparisons/:id/quotes', upload.single('pdf'), async (req, res) => {
  try {
    const { id: comparisonId } = req.params;
    if (!req.file) return res.status(400).json({ error: 'pdf_required' });

    // Look up the comparison shell — we need community_id + policy_type
    const { data: comp, error: cErr } = await supabase
      .from('insurance_comparisons')
      .select('id, community_id, policy_type, title')
      .eq('id', comparisonId)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!comp) return res.status(404).json({ error: 'comparison_not_found' });

    // STEP 1 — store the PDF in library_documents (single source of truth)
    const sha = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const safeName = (req.file.originalname || 'insurance-quote.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `insurance/${comp.community_id}/${comparisonId}/${sha.slice(0, 12)}-${safeName}`;

    const { error: upErr } = await supabase.storage
      .from('library')
      .upload(storagePath, req.file.buffer, { contentType: 'application/pdf', upsert: false });
    if (upErr && !/already exists/i.test(upErr.message)) {
      throw upErr;
    }

    const { data: libDoc, error: libErr } = await supabase
      .from('library_documents')
      .insert({
        community_id: comp.community_id,
        title: `Insurance quote — ${comp.title || POLICY_TYPE_LABELS[comp.policy_type]}`,
        original_filename: req.file.originalname || 'quote.pdf',
        storage_path: storagePath,
        category: 'insurance_quote',
        file_size_bytes: req.file.size,
        sha256: sha,
      })
      .select('id')
      .single();
    if (libErr) throw libErr;

    // STEP 2 — Claude binary-PDF extract (Swim Houston scar: never pdf-parse here)
    let extracted = {};
    let rawText = '';
    let extractFailed = false;
    try {
      const r = await extractQuoteFromPdf({
        pdfBuffer: req.file.buffer,
        policyType: comp.policy_type,
      });
      extracted = r.extracted;
      rawText = r.raw;
    } catch (e) {
      console.error('[insurance] extraction failed:', e.message);
      extractFailed = true;
      rawText = e.raw_extracted || '';
      // We still insert the quote row so staff can fill it in manually.
    }

    // STEP 3 — insert quote row (or empty shell if extraction failed)
    const confidence = extractFailed ? 'low' : gradeConfidence(extracted);
    const warnings = extracted.extraction_warnings || [];
    if (extractFailed) warnings.unshift('Automatic extraction failed — please fill in fields manually.');

    const { data: quote, error: qErr } = await supabase
      .from('insurance_quotes')
      .insert({
        comparison_id: comparisonId,
        community_id: comp.community_id,
        library_document_id: libDoc.id,
        carrier_name: extracted.carrier_name || null,
        agent_name: extracted.agent_name || null,
        agent_email: extracted.agent_email || null,
        agent_phone: extracted.agent_phone || null,
        policy_number: extracted.policy_number || null,
        quote_number: extracted.quote_number || null,
        annual_premium_cents: extracted.annual_premium_cents || null,
        effective_date: extracted.effective_date || null,
        expiration_date: extracted.expiration_date || null,
        am_best_rating: extracted.am_best_rating || null,
        deductible_cents: extracted.deductible_cents || null,
        per_occurrence_limit_cents: extracted.per_occurrence_limit_cents || null,
        aggregate_limit_cents: extracted.aggregate_limit_cents || null,
        property_limit_cents: extracted.property_limit_cents || null,
        liability_limit_cents: extracted.liability_limit_cents || null,
        d_and_o_limit_cents: extracted.d_and_o_limit_cents || null,
        fidelity_limit_cents: extracted.fidelity_limit_cents || null,
        umbrella_limit_cents: extracted.umbrella_limit_cents || null,
        flood_limit_cents: extracted.flood_limit_cents || null,
        coinsurance_pct: extracted.coinsurance_pct || null,
        replacement_cost: extracted.replacement_cost ?? null,
        blanket_limit: extracted.blanket_limit ?? null,
        wind_hail_deductible_pct: extracted.wind_hail_deductible_pct || null,
        wind_hail_deductible_cents: extracted.wind_hail_deductible_cents || null,
        notable_endorsements: extracted.notable_endorsements || null,
        notable_exclusions: extracted.notable_exclusions || null,
        notable_sublimits: extracted.notable_sublimits || null,
        payment_options: extracted.payment_options || null,
        extracted_at: new Date().toISOString(),
        extraction_raw: { raw_text: rawText, parsed: extracted, failed: extractFailed },
        extraction_confidence: confidence,
        extraction_warnings: warnings,
      })
      .select('*')
      .single();
    if (qErr) throw qErr;

    res.json({
      quote,
      extraction_confidence: confidence,
      extraction_warnings: warnings,
      raw_extracted: rawText.slice(0, 2000),   // diagnostic-first
    });
  } catch (err) {
    console.error('[insurance] upload+extract failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.patch('/comparisons/:id/quotes/:qid', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const { qid } = req.params;
    const allowed = [
      'carrier_name', 'agent_name', 'agent_email', 'agent_phone',
      'policy_number', 'quote_number',
      'annual_premium_cents', 'effective_date', 'expiration_date',
      'am_best_rating', 'deductible_cents',
      'per_occurrence_limit_cents', 'aggregate_limit_cents',
      'property_limit_cents', 'liability_limit_cents',
      'd_and_o_limit_cents', 'fidelity_limit_cents',
      'umbrella_limit_cents', 'flood_limit_cents',
      'coinsurance_pct', 'replacement_cost', 'blanket_limit',
      'wind_hail_deductible_pct', 'wind_hail_deductible_cents',
      'notable_endorsements', 'notable_exclusions', 'notable_sublimits',
      'payment_options', 'notes',
    ];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    // Coerce money fields if user typed "$1,000,000"
    const moneyFields = [
      'annual_premium_cents', 'deductible_cents', 'per_occurrence_limit_cents',
      'aggregate_limit_cents', 'property_limit_cents', 'liability_limit_cents',
      'd_and_o_limit_cents', 'fidelity_limit_cents', 'umbrella_limit_cents',
      'flood_limit_cents', 'wind_hail_deductible_cents',
    ];
    for (const k of moneyFields) {
      if (k in patch) patch[k] = centsOrNull(patch[k]);
    }
    if ('effective_date' in patch) patch.effective_date = isoOrNull(patch.effective_date);
    if ('expiration_date' in patch) patch.expiration_date = isoOrNull(patch.expiration_date);
    patch.manual_override = true;
    patch.extraction_confidence = 'manual';

    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no_fields_to_update' });
    const { data, error } = await supabase
      .from('insurance_quotes')
      .update(patch)
      .eq('id', qid)
      .select('*')
      .single();
    if (error) throw error;
    res.json({ quote: data });
  } catch (err) {
    console.error('[insurance] update quote failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.delete('/comparisons/:id/quotes/:qid', async (req, res) => {
  try {
    const { qid } = req.params;
    const { error } = await supabase.from('insurance_quotes').delete().eq('id', qid);
    if (error) throw error;
    res.json({ deleted: true });
  } catch (err) {
    console.error('[insurance] delete quote failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------
router.post('/comparisons/:id/synthesize', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: comp, error: cErr } = await supabase
      .from('insurance_comparisons')
      .select('*, communities(name)')
      .eq('id', id)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!comp) return res.status(404).json({ error: 'comparison_not_found' });

    const { data: quotes, error: qErr } = await supabase
      .from('insurance_quotes')
      .select('*')
      .eq('comparison_id', id)
      .order('annual_premium_cents', { ascending: true, nullsFirst: false })
      .limit(10);
    if (qErr) throw qErr;
    if (!quotes || quotes.length < 2) {
      return res.status(400).json({ error: 'need_at_least_two_quotes' });
    }

    const synthesis = await generateSynthesis({
      comparison: comp,
      quotes,
      communityName: comp.communities?.name || 'this community',
    });

    const nowIso = new Date().toISOString();
    const { data: updated, error: uErr } = await supabase
      .from('insurance_comparisons')
      .update({
        synthesis_text: synthesis,
        synthesis_model: SYNTHESIS_MODEL,
        synthesis_generated_at: nowIso,
        status: comp.status === 'draft' ? 'synthesized' : comp.status,
      })
      .eq('id', id)
      .select('*')
      .single();
    if (uErr) throw uErr;

    res.json({ comparison: updated, synthesis });
  } catch (err) {
    console.error('[insurance] synthesize failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
