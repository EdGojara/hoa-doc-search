// ============================================================================
// HOA Monthly Financial Review API
// ----------------------------------------------------------------------------
// Endpoints under /api/financial-review for the analytical-review pipeline.
//
// Workflow (v0):
//   1. Accountant clerk uploads a rolling-12 income statement (PDF).
//   2. the AI parses the PDF into structured GL data
//      (account lines + month-by-month actuals/budgets).
//   3. Check engine runs analytical procedures and emits findings:
//        - zero_where_never_zero       silent line vs. baseline
//        - trend_break                 variance from recent baseline (>1.5 SD)
//        - materiality_threshold       line above $X for board attention
//        - contract_cross_tie          GL line doesn't match contract rate
//                                      (management fee, website, onsite staff)
//        - ai_observed                 free-form judgment findings from the AI
//   4. Findings appear in a queue ranked by severity for clerk to address.
//
// Same trade-tape discipline as billing: every the AI call is recorded in
// agent_runs + analytical_review_runs so the analysis is replayable and
// auditable. Layer-3 defensibility from day one.
// ============================================================================

const express = require('express');
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
function money(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function lastDayOfMonth(yyyy, mm) {
  return new Date(Date.UTC(yyyy, mm, 0)).toISOString().slice(0, 10);
}

function firstOfMonth(d) {
  const dt = typeof d === 'string' ? new Date(d) : d;
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

// Pearson-style baseline stats with outliers excluded.
// Used by trend-break and zero-where-never-zero.
function baselineStats(values) {
  const arr = (values || []).map(v => Number(v || 0));
  if (arr.length === 0) return { mean: 0, sd: 0, nonZeroFraction: 0, n: 0 };
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  const sd = Math.sqrt(variance);
  const nonZero = arr.filter(v => Math.abs(v) > 0.01).length;
  return { mean, sd, nonZeroFraction: nonZero / arr.length, n: arr.length };
}

// ============================================================================
// AI parse: PDF -> structured GL data
// ============================================================================
async function parseFinancialPDF(pdfBuffer, periodLabel) {
  const promptText = `Extract the financial statement data from this PDF into structured JSON.

This is an HOA financial statement (likely a rolling 12-month income statement). Return ONLY a JSON object in this exact shape:

{
  "report_type": "rolling_12_income_statement" | "single_period_income_statement" | "balance_sheet" | "other",
  "report_period_end": "<YYYY-MM-DD or null>",
  "community_name": "<string or null>",
  "months": ["<YYYY-MM-DD first-of-month>", ...],   // months represented in the report; for rolling-12, list all 12 in chronological order
  "lines": [
    {
      "account_code": "<string or null>",            // e.g. "5770" or "4000"
      "account_name": "<string>",                    // e.g. "Security Services"
      "section": "revenue" | "expense" | "reserve" | "savings" | "other",
      "category_label": "<string or null>",          // subgroup heading from the report, e.g. "Office/Administrative Expenses"
      "is_subtotal": <boolean>,                      // true for total/subtotal rows
      "monthly_actuals": [<number or null>, ...]     // same length as months[]; null when no value
    }
  ]
}

Rules:
- Skip blank rows and pure header rows (sections like "Operating Income" with no figures)
- Include subtotals (e.g., "Total Revenue", "Total Expense", "Operating Net Total") with is_subtotal=true
- For rolling-12 reports: monthly_actuals has 12 entries in the same order as months[]
- For single-period reports: monthly_actuals has 1 entry
- Numbers may include parentheses for negatives — convert to negative numbers
- If a value is "-" or blank, use null
- Do not invent figures. If a value is unreadable, use null.

Return ONLY the JSON object. No markdown fences, no preamble.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: pdfBuffer.toString('base64')
          }
        },
        { type: 'text', text: promptText }
      ]
    }]
  });

  const rawText = (response.content[0] && response.content[0].text) || '';
  const cleanText = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleanText);
  } catch (e) {
    throw new Error(`AI returned non-JSON: ${cleanText.slice(0, 300)}`);
  }
  return { parsed, usage: response.usage, rawText };
}

// ============================================================================
// AI free-form judgment pass — produce 0-5 ai_observed findings
// ============================================================================
async function aiJudgmentPass(parsedData, contractContext, periodLabel) {
  const condensed = {
    period: periodLabel,
    months: parsedData.months,
    lines: (parsedData.lines || []).map(l => ({
      code: l.account_code,
      name: l.account_name,
      section: l.section,
      monthly: l.monthly_actuals
    }))
  };

  const promptText = `You are a CPA + CFE reviewing this rolling-12 financial statement before it goes to the HOA board. Use a hedge-fund-desk analytical mindset: variance is the enemy, look for what's off, flag what should be questioned.

Period: ${periodLabel}
${contractContext ? '\nContract context:\n' + contractContext + '\n' : ''}

Financial data (JSON):
${JSON.stringify(condensed)}

Identify up to 5 analytical findings that warrant the clerk's attention. For each, return:
- title: one-line headline (under 80 chars)
- severity: critical | high | medium | low | info
- account_codes: [list of GL codes involved, if any]
- months_involved: [list of YYYY-MM-DD month-starts, if any]
- finding_text: 1-3 sentences of analysis explaining what's off
- suggested_question: what to ask the clerk to resolve

Look for:
- Unusual single-month spikes (e.g., security services 2x normal in one month)
- Lines that went silent in recent months (interest accrual stopped, MUD contribution missing)
- Reversal entries (+N then -N) that may hide misclassifications
- Material payments (>$50k) that might be capital vs expense
- Round-number duplicates across different accounts (potential dupe posting)
- Presentation issues (transfers netted into revenue rather than below the line)

Return ONLY a JSON array (no markdown, no preamble):
[
  {"title": "...", "severity": "high", "account_codes": ["5770"], "months_involved": ["2026-04-01"], "finding_text": "...", "suggested_question": "..."}
]

If no findings warrant attention, return [].`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: promptText }]
  });

  const rawText = (response.content[0] && response.content[0].text) || '[]';
  const cleanText = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
  let findings;
  try {
    findings = JSON.parse(cleanText);
  } catch (e) {
    console.error('[fin-rev] aiJudgmentPass JSON parse failed:', cleanText.slice(0, 300));
    findings = [];
  }
  return { findings, usage: response.usage };
}

// ============================================================================
// Deterministic check engine — programmatic analytical procedures
// ============================================================================

function checkZeroWhereNeverZero(linesWithBalances) {
  const findings = [];
  const ZERO_TOLERANCE = 0.01;
  for (const line of linesWithBalances) {
    if (line.is_subtotal) continue;
    if (line.section === 'other') continue;
    const months = line.balances || [];
    if (months.length < 4) continue;
    // Split into baseline (all but last 3 months) vs recent (last 3 months)
    const recent = months.slice(-3);
    const baseline = months.slice(0, -3);
    if (baseline.length === 0) continue;
    const baselineStats0 = baselineStats(baseline.map(m => m.actual));
    const recentNonZero = recent.filter(m => Math.abs(Number(m.actual || 0)) > ZERO_TOLERANCE).length;
    // Flag when baseline has ≥ 80% non-zero AND last 3 months are all zero/null
    if (baselineStats0.nonZeroFraction >= 0.8 && recentNonZero === 0) {
      const baselineMean = baselineStats0.mean;
      findings.push({
        check_type: 'zero_where_never_zero',
        severity: Math.abs(baselineMean) > 1000 ? 'high' : 'medium',
        title: `${line.account_name} went silent in last 3 months`,
        finding_text: `${line.account_name} (${line.account_code || 'no code'}) had non-zero activity in ${baselineStats0.n} of the prior baseline months with an average of $${baselineMean.toFixed(2)}/month. The last 3 months show $0. Most likely cause: monthly accrual not yet booked, or the underlying activity stopped without a recorded reason.`,
        account_codes: line.account_code ? [line.account_code] : [],
        months_involved: recent.map(m => m.month),
        amount_at_issue: baselineMean * 3,
        suggested_question: `Was the ${line.account_name.toLowerCase()} entry for the last 3 months booked? If activity actually stopped, what's the reason?`,
        evidence: { baseline_mean: baselineMean, baseline_months: baselineStats0.n, recent_zeros: recent.length }
      });
    }
  }
  return findings;
}

function checkTrendBreak(linesWithBalances) {
  const findings = [];
  for (const line of linesWithBalances) {
    if (line.is_subtotal) continue;
    if (line.section === 'other') continue;
    const months = line.balances || [];
    if (months.length < 6) continue;
    const values = months.map(m => Number(m.actual || 0));
    const last = values[values.length - 1];
    const baseline = values.slice(0, -1);
    const stats = baselineStats(baseline);
    if (stats.sd < 1) continue;            // skip lines that are constant or near-constant
    if (Math.abs(stats.mean) < 100) continue;  // skip immaterial lines
    const z = (last - stats.mean) / stats.sd;
    if (Math.abs(z) >= 2.0 && Math.abs(last - stats.mean) > 500) {
      const direction = z > 0 ? 'higher' : 'lower';
      findings.push({
        check_type: 'trend_break',
        severity: Math.abs(z) >= 3 ? 'high' : 'medium',
        title: `${line.account_name} is ${Math.abs(z).toFixed(1)}σ ${direction} than baseline`,
        finding_text: `${line.account_name} (${line.account_code || 'no code'}) most-recent month: $${last.toFixed(2)}. Baseline mean across prior ${stats.n} months: $${stats.mean.toFixed(2)} (σ $${stats.sd.toFixed(2)}). The latest value is ${Math.abs(z).toFixed(1)} standard deviations from the baseline mean — outside the normal range.`,
        account_codes: line.account_code ? [line.account_code] : [],
        months_involved: [months[months.length - 1].month],
        amount_at_issue: last - stats.mean,
        suggested_question: `What drove the ${direction}-than-typical ${line.account_name.toLowerCase()} this month? Pull the underlying invoice/transaction.`,
        evidence: { latest: last, baseline_mean: stats.mean, baseline_sd: stats.sd, z_score: Number(z.toFixed(2)) }
      });
    }
  }
  return findings;
}

function checkMaterialityThreshold(linesWithBalances, threshold = 50000) {
  const findings = [];
  for (const line of linesWithBalances) {
    if (line.is_subtotal) continue;
    if (line.section !== 'expense') continue;
    const months = line.balances || [];
    for (const m of months) {
      const v = Math.abs(Number(m.actual || 0));
      if (v >= threshold) {
        findings.push({
          check_type: 'materiality_threshold',
          severity: 'high',
          title: `${line.account_name}: $${Math.round(v).toLocaleString()} in single month — capital vs. expense?`,
          finding_text: `Single-month charge of $${v.toFixed(2)} in ${line.account_name} (${line.account_code || 'no code'}) for the month of ${m.month}. At this magnitude, GAAP treatment depends on whether the work extends useful life (capitalize) or is repair-of-existing (expense). Worth confirming the nature of the work and that competitive-bid + board-approval procedures were followed.`,
          account_codes: line.account_code ? [line.account_code] : [],
          months_involved: [m.month],
          amount_at_issue: v,
          suggested_question: `Confirm with the board: capital improvement (capitalize) or repair-of-existing (expense)? Pull the vendor invoice and confirm board-approval documentation. Was the disclosure clause in the management contract honored?`,
          evidence: { month: m.month, amount: v }
        });
      }
    }
  }
  return findings;
}

async function checkContractCrossTie(linesWithBalances, communityId) {
  const findings = [];
  // Get the active contract's fixed items + key categories.
  const { data: contractRows } = await supabase
    .from('contracts')
    .select('id, contract_fixed_items(*)')
    .eq('community_id', communityId)
    .eq('status', 'active')
    .limit(1);
  const fixedItems = (contractRows && contractRows[0] && contractRows[0].contract_fixed_items) || [];
  if (fixedItems.length === 0) return findings;

  // Heuristic name matching to GL accounts.
  const nameTokens = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const overlap = (a, b) => {
    const setB = new Set(nameTokens(b));
    return nameTokens(a).filter(t => setB.has(t)).length;
  };

  for (const fixed of fixedItems) {
    // Find best-matching GL line
    let best = null, bestScore = 0;
    for (const line of linesWithBalances) {
      if (line.is_subtotal) continue;
      const score = overlap(fixed.description, line.account_name);
      if (score > bestScore) { best = line; bestScore = score; }
    }
    if (!best || bestScore < 1) continue;
    // Compare the most-recent month's actual to the contract monthly amount.
    const months = best.balances || [];
    const last = months.length > 0 ? Number(months[months.length - 1].actual || 0) : null;
    if (last === null) continue;
    const expected = Number(fixed.monthly_amount);
    const diff = last - expected;
    if (Math.abs(diff) > Math.max(50, expected * 0.05)) {
      findings.push({
        check_type: 'contract_cross_tie',
        severity: Math.abs(diff) > expected * 0.20 ? 'high' : 'medium',
        title: `${best.account_name}: GL $${last.toFixed(2)} vs. contract $${expected.toFixed(2)}`,
        finding_text: `GL account ${best.account_code || ''} (${best.account_name}) for the most-recent month is $${last.toFixed(2)}. The active management contract specifies $${expected.toFixed(2)}/month for "${fixed.description}". Difference of $${diff.toFixed(2)} — either a posting error, a vendor outside Bedrock's billing line, or a contract update not yet propagated.`,
        account_codes: best.account_code ? [best.account_code] : [],
        months_involved: months.length ? [months[months.length - 1].month] : [],
        amount_at_issue: Math.abs(diff),
        suggested_question: `Reconcile ${best.account_name.toLowerCase()} for the month: what's in the GL row vs. what we billed under the contract? If GL captures additional vendors (hosting, contractor, etc.), we should split the line for clarity.`,
        evidence: { contract_monthly: expected, gl_actual: last, contract_description: fixed.description }
      });
    }
  }
  return findings;
}

// ============================================================================
// API endpoints
// ============================================================================

// List packages, optionally scoped to a community.
router.get('/packages', async (req, res) => {
  try {
    const { community_id, limit } = req.query;
    let q = supabase
      .from('financial_packages')
      .select(`
        id, community_id, fiscal_period, period_label, status, uploaded_at,
        parsed_at, reviewed_at, approved_at, notes,
        community:communities(name, vantaca_code)
      `)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('fiscal_period', { ascending: false })
      .limit(Number(limit) || 50);
    if (community_id) q = q.eq('community_id', community_id);
    const { data, error } = await q;
    if (error) throw error;

    // Add open-finding count for each package.
    const ids = (data || []).map(p => p.id);
    const counts = {};
    if (ids.length > 0) {
      const { data: openCounts } = await supabase
        .from('analytical_findings')
        .select('package_id, severity')
        .in('package_id', ids)
        .eq('status', 'open');
      (openCounts || []).forEach(f => {
        counts[f.package_id] = counts[f.package_id] || { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: 0 };
        counts[f.package_id][f.severity] = (counts[f.package_id][f.severity] || 0) + 1;
        counts[f.package_id].total += 1;
      });
    }
    const enriched = (data || []).map(p => ({ ...p, open_findings: counts[p.id] || { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: 0 } }));
    res.json({ packages: enriched });
  } catch (err) {
    console.error('[fin-rev] /packages failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Upload + parse + check in one synchronous call.
router.post('/packages', upload.single('pdf'), async (req, res) => {
  const t0 = Date.now();
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded (expected field "pdf")' });
  if (req.file.mimetype !== 'application/pdf') {
    return res.status(400).json({ error: `Unsupported file type: ${req.file.mimetype}` });
  }
  const { community_id, fiscal_period, period_label } = req.body || {};
  if (!community_id) return res.status(400).json({ error: 'community_id required' });
  if (!fiscal_period) return res.status(400).json({ error: 'fiscal_period (YYYY-MM-DD) required' });

  try {
    // 1. Parse PDF via the AI
    const { parsed: parsedData, usage: parseUsage } = await parseFinancialPDF(req.file.buffer, period_label || fiscal_period);
    const parseDuration = Date.now() - t0;

    // 2. Create the financial_package row
    const { data: pkg, error: pkgErr } = await supabase
      .from('financial_packages')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id,
        fiscal_period,
        period_label: period_label || fiscal_period,
        status: 'parsed',
        parsed_at: new Date().toISOString()
      })
      .select()
      .single();
    if (pkgErr) throw pkgErr;

    // 3. Insert GL lines + monthly balances
    const lines = parsedData.lines || [];
    const months = (parsedData.months || []).map(m => firstOfMonth(m));
    const lineRows = lines.map((l, idx) => ({
      package_id: pkg.id,
      account_code: l.account_code || null,
      account_name: l.account_name || `(unnamed line ${idx})`,
      section: ['revenue','expense','reserve','savings','other'].includes(l.section) ? l.section : 'other',
      category_label: l.category_label || null,
      sort_order: idx,
      is_subtotal: !!l.is_subtotal
    }));
    const { data: insertedLines, error: lineErr } = await supabase
      .from('gl_account_lines')
      .insert(lineRows)
      .select();
    if (lineErr) throw lineErr;

    const balanceRows = [];
    insertedLines.forEach((insertedLine, idx) => {
      const sourceLine = lines[idx];
      const monthly = sourceLine.monthly_actuals || [];
      months.forEach((m, mi) => {
        if (mi < monthly.length && monthly[mi] !== null && monthly[mi] !== undefined) {
          balanceRows.push({
            line_id: insertedLine.id,
            month: m,
            actual: Number(monthly[mi]),
            budget: null
          });
        }
      });
    });
    if (balanceRows.length > 0) {
      const { error: balErr } = await supabase
        .from('gl_monthly_balances')
        .insert(balanceRows);
      if (balErr) throw balErr;
    }

    // 4. Build the lines+balances structure for the check engine
    const linesWithBalances = insertedLines.map((il, idx) => {
      const monthly = lines[idx].monthly_actuals || [];
      return {
        id: il.id,
        account_code: il.account_code,
        account_name: il.account_name,
        section: il.section,
        is_subtotal: il.is_subtotal,
        balances: months.map((m, mi) => ({
          month: m,
          actual: mi < monthly.length ? monthly[mi] : null
        }))
      };
    });

    // 5. Run the deterministic check engine
    const allFindings = [];
    allFindings.push(...checkZeroWhereNeverZero(linesWithBalances));
    allFindings.push(...checkTrendBreak(linesWithBalances));
    allFindings.push(...checkMaterialityThreshold(linesWithBalances));
    const ctxFindings = await checkContractCrossTie(linesWithBalances, community_id);
    allFindings.push(...ctxFindings);

    // 6. Run the AI judgment pass (free-form CFE-flavor analysis)
    const contractCtxText = ctxFindings.length === 0
      ? 'No contract cross-tie findings from deterministic check.'
      : `Deterministic checks found ${ctxFindings.length} contract cross-tie issues; consider these resolved for your judgment pass.`;
    const aiResult = await aiJudgmentPass(parsedData, contractCtxText, period_label || fiscal_period);
    (aiResult.findings || []).forEach(f => {
      allFindings.push({
        check_type: 'ai_observed',
        severity: ['critical','high','medium','low','info'].includes(f.severity) ? f.severity : 'medium',
        title: f.title || '(AI finding)',
        finding_text: f.finding_text || '',
        account_codes: f.account_codes || [],
        months_involved: f.months_involved || [],
        amount_at_issue: f.amount_at_issue || null,
        suggested_question: f.suggested_question || null,
        evidence: { source: 'ai_judgment_pass' }
      });
    });

    // 7. Insert findings + run record
    const { data: runRow } = await supabase.from('analytical_review_runs').insert({
      package_id: pkg.id,
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id,
      run_kind: 'standard_review',
      model: 'claude-sonnet-4-6',
      input_token_count: (parseUsage?.input_tokens || 0) + (aiResult.usage?.input_tokens || 0),
      output_token_count: (parseUsage?.output_tokens || 0) + (aiResult.usage?.output_tokens || 0),
      duration_ms: Date.now() - t0,
      finding_count: allFindings.length,
      raw_response: { parse: parsedData, ai_findings: aiResult.findings }
    }).select().single();

    if (allFindings.length > 0) {
      const findingRows = allFindings.map((f, idx) => ({
        package_id: pkg.id,
        run_id: runRow ? runRow.id : null,
        severity: f.severity,
        check_type: f.check_type,
        title: f.title,
        finding_text: f.finding_text,
        account_codes: f.account_codes || [],
        months_involved: f.months_involved || [],
        amount_at_issue: f.amount_at_issue !== null && f.amount_at_issue !== undefined ? Number(f.amount_at_issue) : null,
        suggested_question: f.suggested_question || null,
        evidence: f.evidence || {},
        sort_order: idx
      }));
      await supabase.from('analytical_findings').insert(findingRows);
    }

    res.json({
      package: pkg,
      lines_inserted: insertedLines.length,
      balances_inserted: balanceRows.length,
      findings_count: allFindings.length,
      duration_ms: Date.now() - t0,
      summary: {
        report_type: parsedData.report_type,
        report_period_end: parsedData.report_period_end,
        community_name: parsedData.community_name,
        months_count: months.length,
        line_count: lines.length
      }
    });
  } catch (err) {
    console.error('[fin-rev] upload failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get a single package with summary stats.
router.get('/packages/:packageId', async (req, res) => {
  const { packageId } = req.params;
  try {
    const { data: pkg, error: pkgErr } = await supabase
      .from('financial_packages')
      .select(`*, community:communities(name, vantaca_code, legal_name)`)
      .eq('id', packageId)
      .single();
    if (pkgErr || !pkg) return res.status(404).json({ error: 'Package not found' });

    const { data: lines } = await supabase
      .from('gl_account_lines')
      .select('id, account_code, account_name, section, category_label, is_subtotal, sort_order')
      .eq('package_id', packageId)
      .order('sort_order');

    const lineIds = (lines || []).map(l => l.id);
    let balances = [];
    if (lineIds.length > 0) {
      const { data: bals } = await supabase
        .from('gl_monthly_balances')
        .select('line_id, month, actual, budget, variance')
        .in('line_id', lineIds);
      balances = bals || [];
    }

    const { data: findings } = await supabase
      .from('analytical_findings')
      .select('*')
      .eq('package_id', packageId)
      .order('severity')
      .order('sort_order');

    res.json({ package: pkg, lines: lines || [], balances, findings: findings || [] });
  } catch (err) {
    console.error('[fin-rev] /packages/:id failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update a finding's status.
router.patch('/findings/:findingId', async (req, res) => {
  const { findingId } = req.params;
  const { status } = req.body || {};
  if (!['open','answered','dismissed','escalated'].includes(status)) {
    return res.status(400).json({ error: "status must be one of open|answered|dismissed|escalated" });
  }
  try {
    const { data, error } = await supabase
      .from('analytical_findings')
      .update({ status })
      .eq('id', findingId)
      .select()
      .single();
    if (error) throw error;
    res.json({ finding: data });
  } catch (err) {
    console.error('[fin-rev] PATCH finding failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Add a clerk's response to a finding.
router.post('/findings/:findingId/responses', async (req, res) => {
  const { findingId } = req.params;
  const { response_text, action_taken, resolved } = req.body || {};
  if (!response_text || !response_text.trim()) {
    return res.status(400).json({ error: 'response_text required' });
  }
  try {
    const { data: response } = await supabase
      .from('finding_responses')
      .insert({
        finding_id: findingId,
        response_text: response_text.trim(),
        action_taken: action_taken || null,
        resolved: !!resolved
      })
      .select()
      .single();

    if (resolved) {
      await supabase
        .from('analytical_findings')
        .update({ status: 'answered' })
        .eq('id', findingId);
    }
    res.json({ response });
  } catch (err) {
    console.error('[fin-rev] POST response failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
