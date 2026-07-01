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
const { renderInsuranceRfpHTML } = require('../lib/insurance_rfp');
const { extractInsuranceProgram } = require('../lib/insurance_extract');
const { normalizeInsuranceProgram } = require('../lib/insurance_rfp');

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

async function generateSynthesis({ comparison, quotes, priorComp, priorQuotes, benchmark, communityName }) {
  const summaries = quotes
    .map((q, i) => `Quote ${i + 1} — ${quoteSummaryLine(q)}`)
    .join('\n\n');

  const priorBlock = priorComp && priorQuotes && priorQuotes.length > 0
    ? `PRIOR YEAR (${priorComp.policy_year || 'unknown year'}) — ${priorQuotes.map((q) => quoteSummaryLine(q)).join(' | ')}`
    : 'PRIOR YEAR — no record on file. Year-over-year analysis not possible.';

  const benchmarkBlock = benchmark && benchmark.sample_size >= 3
    ? `PORTFOLIO BENCHMARK (Bedrock-managed communities, same policy type, current renewal cycle):
- Sample size: ${benchmark.sample_size} communities
- Median premium % change YoY: ${benchmark.median_change_pct != null ? benchmark.median_change_pct.toFixed(1) + '%' : 'insufficient prior-year data'}
- Range (min → max): ${benchmark.min_change_pct != null ? benchmark.min_change_pct.toFixed(1) + '% → ' + benchmark.max_change_pct.toFixed(1) + '%' : 'n/a'}`
    : `PORTFOLIO BENCHMARK — not enough comparable communities in the portfolio yet (need 3+ with prior-year data). Skip the benchmark section if so.`;

  const typeLabel = POLICY_TYPE_LABELS[comparison.policy_type] || comparison.policy_type;
  const prompt = `You are Bedrock's insurance-renewal ANALYST writing a board-packet summary for ${communityName}.

CRITICAL FRAMING: You are an ANALYST, not a broker. You do NOT recommend which carrier to buy. The licensed agent of record makes that decision. Your job is to:
- Compare current-year renewal to prior year
- Contextualize against Bedrock's portfolio benchmark
- Surface specific questions for the board to ask their agent
- Flag anything unusual the board should not let slide

Policy type: ${typeLabel}
Policy year: ${comparison.policy_year || 'TBD'}
Effective date target: ${comparison.effective_date || 'TBD'}

CURRENT YEAR QUOTE(S):

${summaries}

${priorBlock}

${benchmarkBlock}

Write 4-6 short paragraphs structured as:

1. **Year-over-year summary.** Premium change in dollars AND %. Any limit changes (up, down, same). Any deductible structure changes. Any exclusions added or dropped. If no prior year on file, say so plainly and skip the rest of this section.

2. **Portfolio context.** Where this community's premium % change sits relative to Bedrock's portfolio median for the same policy type. "In line", "below market", "above market — outlier". If benchmark sample is too small, skip this paragraph.

3. **Texas-specific items to verify.** Wind/hail deductible structure (% vs flat $) — did it change? Named-storm sublimits. Mold/fungus caps. Replacement cost vs ACV. These are where TX HOAs get hurt at claim time.

4. **Questions for the agent of record.** 3-5 specific questions the board should ask before binding. Frame as "ask the agent…" not "we recommend…". Example: "Ask the agent why the wind/hail deductible moved from 1% to 2% — is that a market move across all carriers or specific to this quote?"

5. **What's normal vs what's flagged.** Wrap with: "Routine renewal items the board can approve at the meeting" vs "Items the board should not let slide until the agent answers". Helps a board run the meeting without getting lost in the weeds.

HARD RULES:
- You are an ANALYST, not a broker. Never write "we recommend Carrier X" or "you should buy this quote". Frame everything as "the board should ask…", "compared to prior year…", "vs the portfolio median…".
- Treasurer-grade tone. Concrete numbers and named carriers — no "competitive pricing" / "strong coverage" / marketing copy.
- No invented facts. If a field wasn't extracted from the quote, say "not stated — confirm with agent." Do not freestyle limits or endorsements.
- If prior year is missing, do not invent comparisons. Note the gap and move on.
- End with exactly one sentence: "The agent of record is the source of truth on coverage adequacy and binds the policy; this analysis is informational only."`;

  const response = await anthropic.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: 2500,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response?.content?.[0]?.text || '';
  return text.trim();
}

// ---------------------------------------------------------------------------
// Portfolio benchmark — computes median/range of YoY premium % change
// across Bedrock-managed communities for a given (policy_type, current_year).
//
// "Comparable" means: same policy_type, same current year, AND has a prior-
// year comparison record on file (either explicit FK or auto-detected).
// Includes only quotes with annual_premium_cents populated.
//
// Used by:
//   - GET /portfolio-benchmarks (UI card)
//   - generateSynthesis() (synthesis prompt context)
//
// This is workpaper data (Bedrock's cross-community knowledge) — NEVER
// expose individual community premiums in the response. Only aggregates.
// Even the community that asked sees its own delta in the YoY card; the
// benchmark surfaces ONLY median/range/sample size of OTHER communities.
// ---------------------------------------------------------------------------
async function computePortfolioBenchmark({ policyType, policyYear, excludeCommunityId }) {
  if (!policyType || !policyYear) return { sample_size: 0 };

  // Fetch all current-year comparisons for this policy type with at least
  // one priced quote. Use pagination helper pattern (CLAUDE.md scar:
  // Supabase 1000-row truncation). Today's portfolio is 7 communities so
  // a single page is fine, but the helper-style insulates us at scale.
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('insurance_comparisons')
      .select('id, community_id, policy_year, prior_year_comparison_id')
      .eq('policy_type', policyType)
      .eq('policy_year', policyYear)
      .range(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  if (all.length === 0) return { sample_size: 0 };

  // For each, find the prior-year comparison (FK or auto-detect).
  const changes = [];
  for (const cur of all) {
    if (excludeCommunityId && cur.community_id === excludeCommunityId) continue;

    let priorId = cur.prior_year_comparison_id;
    if (!priorId) {
      const { data: auto } = await supabase
        .from('insurance_comparisons')
        .select('id')
        .eq('community_id', cur.community_id)
        .eq('policy_type', policyType)
        .eq('policy_year', policyYear - 1)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      priorId = auto?.id || null;
    }
    if (!priorId) continue;

    // Pull lowest-premium quote from each side (the renewal carrier's
    // primary quote — typically the bound or about-to-bind one).
    const [{ data: curQ }, { data: priorQ }] = await Promise.all([
      supabase.from('insurance_quotes').select('annual_premium_cents')
        .eq('comparison_id', cur.id)
        .not('annual_premium_cents', 'is', null)
        .order('annual_premium_cents', { ascending: true })
        .limit(1).maybeSingle(),
      supabase.from('insurance_quotes').select('annual_premium_cents')
        .eq('comparison_id', priorId)
        .not('annual_premium_cents', 'is', null)
        .order('annual_premium_cents', { ascending: true })
        .limit(1).maybeSingle(),
    ]);
    if (!curQ?.annual_premium_cents || !priorQ?.annual_premium_cents) continue;
    const pct = ((curQ.annual_premium_cents - priorQ.annual_premium_cents) / priorQ.annual_premium_cents) * 100;
    if (Number.isFinite(pct)) changes.push(pct);
  }

  if (changes.length === 0) return { sample_size: 0 };

  changes.sort((a, b) => a - b);
  const median = changes.length % 2 === 0
    ? (changes[changes.length / 2 - 1] + changes[changes.length / 2]) / 2
    : changes[Math.floor(changes.length / 2)];
  const min = changes[0];
  const max = changes[changes.length - 1];
  const mean = changes.reduce((a, b) => a + b, 0) / changes.length;

  return {
    sample_size: changes.length,
    median_change_pct: median,
    mean_change_pct: mean,
    min_change_pct: min,
    max_change_pct: max,
  };
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

    // Resolve prior-year comparison + its quote (for YoY analyst view).
    // Use explicit FK if linked; otherwise auto-detect by
    // (community_id, policy_type, policy_year = current - 1). Auto-detect
    // is a fallback — operator can override via PATCH prior_year_comparison_id.
    let priorComp = null;
    let priorQuotes = [];
    let priorAutoDetected = false;
    if (comp.prior_year_comparison_id) {
      const { data: pc } = await supabase
        .from('insurance_comparisons')
        .select('*')
        .eq('id', comp.prior_year_comparison_id)
        .maybeSingle();
      priorComp = pc || null;
    } else if (comp.policy_year && comp.community_id) {
      const { data: pc } = await supabase
        .from('insurance_comparisons')
        .select('*')
        .eq('community_id', comp.community_id)
        .eq('policy_type', comp.policy_type)
        .eq('policy_year', comp.policy_year - 1)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      priorComp = pc || null;
      priorAutoDetected = !!priorComp;
    }
    if (priorComp) {
      const { data: pq } = await supabase
        .from('insurance_quotes')
        .select('*')
        .eq('comparison_id', priorComp.id)
        .order('annual_premium_cents', { ascending: true, nullsFirst: false })
        .limit(20);
      priorQuotes = pq || [];
    }

    res.json({
      comparison: comp,
      quotes: quotes || [],
      prior: priorComp
        ? { comparison: priorComp, quotes: priorQuotes, auto_detected: priorAutoDetected }
        : null,
    });
  } catch (err) {
    console.error('[insurance] get comparison failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// Prior-year picker — list candidate comparisons the operator can link as
// "this year's prior year." Filters to same community + same policy_type +
// policy_year < current. Returned newest-first.
// ---------------------------------------------------------------------------
router.get('/comparisons/:id/prior-year-options', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: comp } = await supabase
      .from('insurance_comparisons')
      .select('community_id, policy_type, policy_year')
      .eq('id', id)
      .maybeSingle();
    if (!comp) return res.status(404).json({ error: 'not_found' });
    let q = supabase
      .from('insurance_comparisons')
      .select('id, title, policy_year, effective_date, status, updated_at')
      .eq('community_id', comp.community_id)
      .eq('policy_type', comp.policy_type)
      .neq('id', id)
      .order('policy_year', { ascending: false, nullsFirst: false })
      .limit(10);
    if (comp.policy_year) q = q.lt('policy_year', comp.policy_year);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ options: data || [] });
  } catch (err) {
    console.error('[insurance] prior-year options failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.patch('/comparisons/:id', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = [
      'title', 'policy_year', 'effective_date', 'status',
      'selected_quote_id', 'board_decision_date', 'board_decision_notes',
      'prior_year_comparison_id',
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
    if (!quotes || quotes.length < 1) {
      // PIVOTED: analyst tool, not broker — a single quote is the COMMON
      // case (renewal carrier presents 1 quote). YoY + portfolio benchmark
      // is the value. Require ≥1 quote, not ≥2.
      return res.status(400).json({ error: 'need_at_least_one_quote' });
    }

    // Resolve prior-year comparison (explicit FK or auto-detect)
    let priorComp = null;
    let priorQuotes = [];
    if (comp.prior_year_comparison_id) {
      const { data: pc } = await supabase
        .from('insurance_comparisons')
        .select('*').eq('id', comp.prior_year_comparison_id).maybeSingle();
      priorComp = pc || null;
    } else if (comp.policy_year && comp.community_id) {
      const { data: pc } = await supabase
        .from('insurance_comparisons')
        .select('*')
        .eq('community_id', comp.community_id)
        .eq('policy_type', comp.policy_type)
        .eq('policy_year', comp.policy_year - 1)
        .order('updated_at', { ascending: false })
        .limit(1).maybeSingle();
      priorComp = pc || null;
    }
    if (priorComp) {
      const { data: pq } = await supabase
        .from('insurance_quotes').select('*')
        .eq('comparison_id', priorComp.id)
        .order('annual_premium_cents', { ascending: true, nullsFirst: false })
        .limit(10);
      priorQuotes = pq || [];
    }

    // Portfolio benchmark — excludes this community to keep the comparison
    // honest ("you vs everyone else", not "you vs everyone including you")
    let benchmark = { sample_size: 0 };
    try {
      benchmark = await computePortfolioBenchmark({
        policyType: comp.policy_type,
        policyYear: comp.policy_year,
        excludeCommunityId: comp.community_id,
      });
    } catch (e) {
      console.warn('[insurance] benchmark compute failed:', e.message);
    }

    const synthesis = await generateSynthesis({
      comparison: comp,
      quotes,
      priorComp,
      priorQuotes,
      benchmark,
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

    res.json({ comparison: updated, synthesis, benchmark });
  } catch (err) {
    console.error('[insurance] synthesize failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// Portfolio benchmark for a comparison — used by the YoY card.
// Returns aggregate only (median, mean, range, sample size). NEVER exposes
// individual community premiums.
// ---------------------------------------------------------------------------
router.get('/comparisons/:id/benchmark', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: comp } = await supabase
      .from('insurance_comparisons')
      .select('community_id, policy_type, policy_year')
      .eq('id', id).maybeSingle();
    if (!comp) return res.status(404).json({ error: 'not_found' });
    const benchmark = await computePortfolioBenchmark({
      policyType: comp.policy_type,
      policyYear: comp.policy_year,
      excludeCommunityId: comp.community_id,
    });
    res.json({ benchmark });
  } catch (err) {
    console.error('[insurance] benchmark failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ===========================================================================
// POLICY OF RECORD — the community's in-force insurance program (SSOT).
// The system maintains all of the association's coverage information here:
// upload the current/prior policies -> extract -> file into
// insurance_programs + insurance_policies. The RFP generates FROM this;
// incoming quotes (above) get compared AGAINST it. (Ed 2026-07-01)
// ===========================================================================

function centsToStr(c) {
  if (c == null) return null;
  const n = Number(c) / 100;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
}

// Turn stored program + policy rows into the shape lib/insurance_rfp expects.
function dbToRendererProgram(program, policies) {
  const entity = program.entity && Object.keys(program.entity).length ? program.entity : {
    named_insured: program.named_insured, mailing_address: program.mailing_address,
    property_location: program.property_location, association_type: program.association_type,
    units_or_lots: program.units_or_lots,
  };
  return {
    entity,
    coverages: (policies || []).map((p) => ({
      line: p.coverage_line, carrier: p.carrier, policy_number: p.policy_number,
      effective_date: p.effective_date, expiration_date: p.expiration_date,
      limits: p.limits || [], deductibles: p.deductibles || [], key_terms: p.key_terms || [],
      annual_premium: centsToStr(p.annual_premium_cents),
    })),
    statement_of_values: program.statement_of_values || [],
    notes: program.notes || [],
  };
}

async function htmlToPdfBuffer(html) {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--single-process'],
  });
  try {
    const page = await browser.newPage();
    try { await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch (_) {}
    return await page.pdf({ format: 'Letter', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, preferCSSPageSize: true });
  } finally { try { await browser.close(); } catch (_) {} }
}

// GET /program?community_id=  -> active program + its policies + source docs, plus history list.
router.get('/program', async (req, res) => {
  try {
    const { community_id } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });

    const { data: programs, error: pErr } = await supabase
      .from('insurance_programs')
      .select('*, communities(name, slug)')
      .eq('community_id', community_id)
      .order('policy_period_start', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(50);
    if (pErr) throw pErr;

    const active = (programs || []).find((p) => p.status === 'active') || (programs || [])[0] || null;
    let policies = [];
    let sourceDocs = [];
    if (active) {
      const { data: pol, error: polErr } = await supabase
        .from('insurance_policies').select('*').eq('program_id', active.id)
        .order('sort_order', { ascending: true, nullsFirst: false }).limit(100);
      if (polErr) throw polErr;
      policies = pol || [];
      const ids = Array.isArray(active.source_document_ids) ? active.source_document_ids : [];
      if (ids.length) {
        const { data: docs } = await supabase.from('library_documents')
          .select('id, title, original_filename, storage_path').in('id', ids);
        sourceDocs = docs || [];
      }
    }
    res.json({ program: active, policies, source_documents: sourceDocs, history: programs || [] });
  } catch (err) {
    console.error('[insurance] get program failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /program/upload  (multipart: pdfs[] + community_id)
// Store each policy PDF in library_documents (SSOT), extract across all of
// them, dedupe, and file into insurance_programs + insurance_policies. Any
// prior active program for the community is marked superseded.
router.post('/program/upload', upload.array('pdfs', 12), async (req, res) => {
  try {
    const community_id = req.body?.community_id;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'pdfs_required' });

    // STEP 1 — file each PDF into library_documents (single source of truth)
    const files = [];
    for (const f of req.files) {
      const sha = crypto.createHash('sha256').update(f.buffer).digest('hex');
      const safeName = (f.originalname || 'policy.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `insurance/${community_id}/policy/${sha.slice(0, 12)}-${safeName}`;
      const { error: upErr } = await supabase.storage.from('library')
        .upload(storagePath, f.buffer, { contentType: 'application/pdf', upsert: false });
      if (upErr && !/already exists/i.test(upErr.message)) throw upErr;
      const { data: libDoc, error: libErr } = await supabase.from('library_documents').insert({
        community_id, title: `Insurance policy — ${f.originalname || 'policy.pdf'}`,
        original_filename: f.originalname || 'policy.pdf', storage_path: storagePath,
        category: 'insurance_policy', file_size_bytes: f.size, sha256: sha,
      }).select('id').single();
      if (libErr) throw libErr;
      files.push({ name: f.originalname || 'policy.pdf', buffer: f.buffer, documentId: libDoc.id });
    }

    // STEP 2 — extract + dedupe
    const rawProgram = await extractInsuranceProgram(anthropic, files);
    const program = normalizeInsuranceProgram(rawProgram);
    if (!program.coverages.length) {
      return res.status(422).json({ error: 'no_coverage_lines_extracted',
        diagnostic: { sources: rawProgram._sources, help: 'Could not read coverage lines from the uploaded PDFs. Confirm these are policy declarations, not a cover letter.' } });
    }

    // Derive program-level fields
    const effs = program.coverages.map((c) => c.effective_date).filter(Boolean).sort();
    const exps = program.coverages.map((c) => c.expiration_date).filter(Boolean).sort();
    const premiums = program.coverages.map((c) => dollarsToCents(c.annual_premium)).filter((v) => v != null);
    const totalPremium = premiums.length ? premiums.reduce((a, b) => a + b, 0) : null;

    // STEP 3 — supersede any current active program, then insert the new one
    await supabase.from('insurance_programs').update({ status: 'superseded' })
      .eq('community_id', community_id).eq('status', 'active');

    const { data: prog, error: progErr } = await supabase.from('insurance_programs').insert({
      community_id, status: 'active',
      policy_period_start: effs[0] || null, policy_period_end: exps[exps.length - 1] || null,
      named_insured: program.entity.named_insured || null,
      association_type: program.entity.association_type || null,
      units_or_lots: Number.isFinite(Number(program.entity.units_or_lots)) ? Number(program.entity.units_or_lots) : null,
      property_location: program.entity.property_location || null,
      mailing_address: program.entity.mailing_address || null,
      total_premium_cents: totalPremium,
      entity: program.entity || {}, statement_of_values: program.statement_of_values || [],
      notes: program.notes || [], source_document_ids: files.map((f) => f.documentId),
      source: 'extracted',
    }).select('*').single();
    if (progErr) throw progErr;

    const policyRows = program.coverages.map((c, i) => ({
      program_id: prog.id, community_id, coverage_line: c.line, carrier: c.carrier || null,
      policy_number: c.policy_number || null, effective_date: c.effective_date || null,
      expiration_date: c.expiration_date || null, annual_premium_cents: dollarsToCents(c.annual_premium),
      limits: c.limits || [], deductibles: c.deductibles || [], key_terms: c.key_terms || [],
      source_document_id: c._documentId || null, sort_order: i,
    }));
    const { error: polErr } = await supabase.from('insurance_policies').insert(policyRows);
    if (polErr) throw polErr;

    res.json({ program: prog, policies_filed: policyRows.length, sources: rawProgram._sources });
  } catch (err) {
    console.error('[insurance] program upload failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /program/:id/rfp  -> generate the Bedrock RFP PDF from the stored program.
// Body opts (all optional): includePremium (default false — withhold),
// includeCarrier, renewalDate, submissionDeadline, rfpDate, contactName, etc.
router.post('/program/:id/rfp', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const { id } = req.params;
    const { data: prog, error: pErr } = await supabase.from('insurance_programs')
      .select('*, communities(name)').eq('id', id).maybeSingle();
    if (pErr) throw pErr;
    if (!prog) return res.status(404).json({ error: 'program_not_found' });
    const { data: policies } = await supabase.from('insurance_policies').select('*')
      .eq('program_id', id).order('sort_order', { ascending: true, nullsFirst: false }).limit(100);

    const rendererProgram = dbToRendererProgram(prog, policies || []);
    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Chicago' });
    const opts = {
      community: prog.communities?.name || prog.named_insured || '',
      rfpDate: today, ...(req.body || {}),
    };
    const html = renderInsuranceRfpHTML(rendererProgram, opts);
    const pdf = await htmlToPdfBuffer(html);
    const fname = `${(opts.community || 'Community').replace(/[^a-zA-Z0-9]+/g, '_')}_Insurance_RFP.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(pdf);
  } catch (err) {
    console.error('[insurance] rfp generate failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// PATCH /policies/:id  -> manual correction of a filed coverage line.
router.patch('/policies/:id', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ['coverage_line', 'carrier', 'policy_number', 'effective_date', 'expiration_date',
      'annual_premium_cents', 'limits', 'deductibles', 'key_terms', 'sort_order'];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    if ('annual_premium_cents' in patch) patch.annual_premium_cents = centsOrNull(patch.annual_premium_cents);
    if ('effective_date' in patch) patch.effective_date = isoOrNull(patch.effective_date);
    if ('expiration_date' in patch) patch.expiration_date = isoOrNull(patch.expiration_date);
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'no_fields_to_update' });
    const { data, error } = await supabase.from('insurance_policies').update(patch).eq('id', id).select('*').single();
    if (error) throw error;
    res.json({ policy: data });
  } catch (err) {
    console.error('[insurance] patch policy failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
