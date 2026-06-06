// ============================================================================
// lib/vantaca/classifier.js — single-shot classifier for any Vantaca export
// ----------------------------------------------------------------------------
// Given a file (PDF or Excel/CSV) dropped into the Vantaca Imports module,
// figure out:
//   - community_id (which community is this report for?)
//   - report_type (AR Aging? GL Export? AP Ledger? etc.)
//   - as_of_date (the date the report claims to represent)
//   - confidence (high / medium / low)
//   - signals (which detection paths fired, for the audit trail)
//
// MULTI-SIGNAL DESIGN (per CLAUDE.md diagnostic-first discipline):
//   1. Filename pattern — fast, deterministic when present
//      e.g. "AR_Aging_Waterview_Estates_20260606.xlsx"
//   2. File-header content sniff — Excel headers / PDF first-page text
//      e.g. "Account Aging Summary" + columns "Current | 1-30 | 31-60..."
//   3. Claude binary read (for PDFs only) — fallback when 1+2 are weak,
//      OR confirms when 1+2 agree
//
// CONFIDENCE GATING:
//   - High: filename pattern matches AND content signals agree
//   - Medium: ONE strong signal (filename OR content), other ambiguous
//   - Low: neither matched cleanly; operator MUST manually classify
//
// Never silent-misroutes. Low confidence routes to 'needs_review' workflow,
// not auto-extraction. Better one operator click than a wrong route.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLASSIFIER_MODEL = 'claude-sonnet-4-5';

const VALID_REPORT_TYPES = [
  'ar_aging', 'gl_export', 'ap_ledger', 'bank_reconciliation',
  'owner_statement', 'vendor_history', 'budget_actual', 'unknown',
];

// ---------------------------------------------------------------------------
// Signal 1 — filename pattern
// ---------------------------------------------------------------------------
// Match common Vantaca export filename shapes. Patterns intentionally
// loose — we want filename to be a SIGNAL, not a gate. Caller may have
// renamed the file; the content sniff is the safety net.
const FILENAME_PATTERNS = [
  // AR Aging variants
  { re: /\bar[\s_-]?aging\b/i, report_type: 'ar_aging', weight: 0.85 },
  { re: /\bar[\s_-]?summary\b/i, report_type: 'ar_aging', weight: 0.7 },
  { re: /\bowner[\s_-]?(?:receiv|aging)/i, report_type: 'ar_aging', weight: 0.7 },
  { re: /\b(?:delinquent|delinquency)[\s_-]?(?:report|summary|list)/i, report_type: 'ar_aging', weight: 0.6 },
  // GL Export
  { re: /\bgl[\s_-]?(?:export|listing|detail)\b/i, report_type: 'gl_export', weight: 0.85 },
  { re: /\bgeneral[\s_-]?ledger\b/i, report_type: 'gl_export', weight: 0.85 },
  { re: /\btrial[\s_-]?balance\b/i, report_type: 'gl_export', weight: 0.7 },
  // AP / Vendor invoices
  { re: /\bap[\s_-]?(?:ledger|register|listing|aging)\b/i, report_type: 'ap_ledger', weight: 0.85 },
  { re: /\baccounts?[\s_-]?payable\b/i, report_type: 'ap_ledger', weight: 0.8 },
  { re: /\bvendor[\s_-]?(?:invoice|ledger|payment)/i, report_type: 'ap_ledger', weight: 0.7 },
  // Bank rec
  { re: /\bbank[\s_-]?(?:rec|reconciliation)\b/i, report_type: 'bank_reconciliation', weight: 0.9 },
  // Owner statement
  { re: /\bowner[\s_-]?statement\b/i, report_type: 'owner_statement', weight: 0.85 },
  { re: /\bhomeowner[\s_-]?statement\b/i, report_type: 'owner_statement', weight: 0.85 },
  // Vendor 1099 history
  { re: /\bvendor[\s_-]?history\b/i, report_type: 'vendor_history', weight: 0.7 },
  { re: /\b1099\b/i, report_type: 'vendor_history', weight: 0.5 },
  // Budget vs Actual
  { re: /\bbudget[\s_-]?(?:vs|actual|variance)/i, report_type: 'budget_actual', weight: 0.85 },
  { re: /\bvariance[\s_-]?report\b/i, report_type: 'budget_actual', weight: 0.6 },
];

// Match a community name from filename. Returns the community row that
// matches, or null. Case-insensitive substring with the community names.
function matchCommunityFromFilename(filename, communities) {
  if (!filename || !communities) return null;
  const lower = filename.toLowerCase();
  // Try exact normalized name match first (longest first to prefer
  // "Waterview Estates" over "Waterview").
  const sorted = communities.slice().sort((a, b) => (b.name || '').length - (a.name || '').length);
  for (const c of sorted) {
    const norm = (c.name || '').toLowerCase().replace(/\s+/g, '[_\\s-]?');
    if (norm && new RegExp(norm, 'i').test(lower)) return c;
    // Also try slug
    if (c.slug && lower.includes(c.slug.toLowerCase())) return c;
  }
  return null;
}

// Extract YYYY-MM-DD or YYYYMMDD or M/D/YYYY from filename
function matchDateFromFilename(filename) {
  if (!filename) return null;
  // YYYYMMDD or YYYY-MM-DD or YYYY_MM_DD
  let m = filename.match(/\b(20\d{2})[-_]?(\d{2})[-_]?(\d{2})\b/);
  if (m) {
    const [, y, mo, d] = m;
    return `${y}-${mo}-${d}`;
  }
  // M/D/YYYY or MM-DD-YYYY
  m = filename.match(/\b(\d{1,2})[-_\/](\d{1,2})[-_\/](20\d{2})\b/);
  if (m) {
    const [, mo, d, y] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

function classifyByFilename(filename, communities) {
  if (!filename) return null;
  const matches = FILENAME_PATTERNS
    .filter((p) => p.re.test(filename))
    .sort((a, b) => b.weight - a.weight);
  const best = matches[0];
  return {
    report_type: best?.report_type || null,
    report_type_confidence: best?.weight || 0,
    community: matchCommunityFromFilename(filename, communities),
    as_of_date: matchDateFromFilename(filename),
  };
}

// ---------------------------------------------------------------------------
// Signal 2 — content sniff (Excel header / PDF first-page)
// ---------------------------------------------------------------------------
// For Excel/CSV: read the first ~50 rows and look for header signatures.
// For PDF: skip to Claude binary read (Signal 3) — pdf-parse is unreliable
// on Vantaca's form-overlay PDFs (Swim Houston scar in CLAUDE.md).
//
// Header signatures are intentionally loose substring matches. Different
// Vantaca report variants may use slightly different column names.
const HEADER_SIGNATURES = [
  { needs: ['current', '1-30', '31-60', '61-90'], report_type: 'ar_aging', weight: 0.9 },
  { needs: ['aging', 'balance', 'unit'], report_type: 'ar_aging', weight: 0.6 },
  { needs: ['account', 'debit', 'credit', 'balance'], report_type: 'gl_export', weight: 0.85 },
  { needs: ['trial balance'], report_type: 'gl_export', weight: 0.85 },
  { needs: ['vendor', 'invoice', 'due'], report_type: 'ap_ledger', weight: 0.8 },
  { needs: ['bank', 'reconciliation'], report_type: 'bank_reconciliation', weight: 0.9 },
  { needs: ['owner', 'statement', 'period'], report_type: 'owner_statement', weight: 0.8 },
  { needs: ['budget', 'actual', 'variance'], report_type: 'budget_actual', weight: 0.85 },
];

function classifyByExcelContent(rows) {
  if (!rows || rows.length === 0) return null;
  // Flatten first 50 rows into a single lowercased blob.
  const blob = rows.slice(0, 50)
    .map((r) => Array.isArray(r) ? r.join('|') : String(r))
    .join('\n').toLowerCase();
  let best = null;
  for (const sig of HEADER_SIGNATURES) {
    const hits = sig.needs.filter((needle) => blob.includes(needle.toLowerCase())).length;
    if (hits === sig.needs.length) {
      const score = sig.weight;
      if (!best || score > best.weight) {
        best = { report_type: sig.report_type, weight: score };
      }
    }
  }
  return best ? { report_type: best.report_type, report_type_confidence: best.weight } : null;
}

// ---------------------------------------------------------------------------
// Signal 3 — Claude binary read (PDF fallback or confirmation)
// ---------------------------------------------------------------------------
// One Claude call returns: report_type guess + community name guess +
// as-of date + confidence + reasoning. Used when filename + content
// signals are weak, OR as a confirmation check when they're strong.
async function classifyByClaude({ fileBuffer, mime, filename, communities }) {
  const communityList = (communities || []).map((c) => c.name).slice(0, 50).join(', ');

  const prompt = `You are classifying a financial report dropped into Bedrock Association Management's Vantaca Imports module. Identify the report type, the community it's for, and the as-of date. Return JSON only.

Possible report_type values:
- "ar_aging" — accounts receivable aging summary by property/owner
- "gl_export" — general ledger export / trial balance
- "ap_ledger" — accounts payable / vendor invoice register
- "bank_reconciliation" — bank rec statement
- "owner_statement" — individual owner statement
- "vendor_history" — vendor payment history / 1099 detail
- "budget_actual" — budget vs actual / variance report
- "unknown" — none of the above

Bedrock manages these communities (match the report's community to ONE of these by name):
${communityList || '(no community list provided)'}

Original filename (may or may not be informative): ${filename || '(none)'}

Return JSON:
{
  "report_type": "<one of the values above>",
  "report_type_confidence": "high" | "medium" | "low",
  "community_name": "<matched community name or empty string if unclear>",
  "as_of_date": "YYYY-MM-DD or empty string if unclear",
  "reasoning": "<short phrase explaining what you saw>"
}

If you can't identify the report with reasonable confidence, return report_type="unknown" and report_type_confidence="low" — do not guess. Only return "high" confidence when the report's structure is unmistakable.`;

  const isPdf = mime === 'application/pdf';
  const messageContent = isPdf
    ? [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: fileBuffer.toString('base64') },
        },
        { type: 'text', text: prompt },
      ]
    : [
        // For non-PDF (Excel/CSV), we already have row-level access via
        // xlsx parsing — this path shouldn't typically fire. Defensive
        // fallback: send a textual preview of the first 30 rows.
        { type: 'text', text: prompt + '\n\nFirst 30 rows of the file:\n' + fileBuffer.toString('utf-8').slice(0, 4000) },
      ];

  try {
    const response = await anthropic.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 600,
      messages: [{ role: 'user', content: messageContent }],
    });
    const raw = (response.content || []).map((b) => b.text || '').join('').trim();
    // Diagnostic-first: log raw output before parse.
    console.log('[vantaca-classifier] Claude raw (first 800 chars):', raw.slice(0, 800));
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    const community = (communities || []).find((c) =>
      c.name && parsed.community_name &&
      c.name.toLowerCase() === parsed.community_name.toLowerCase()
    ) || null;
    return {
      report_type: VALID_REPORT_TYPES.includes(parsed.report_type) ? parsed.report_type : 'unknown',
      report_type_confidence_text: parsed.report_type_confidence,
      community,
      as_of_date: parsed.as_of_date || null,
      reasoning: parsed.reasoning || '',
    };
  } catch (e) {
    console.warn('[vantaca-classifier] Claude call failed:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public: classify(file, communities, opts) → unified classification
// ---------------------------------------------------------------------------
/**
 * @param {object} args
 * @param {Buffer} args.fileBuffer
 * @param {string} args.filename
 * @param {string} args.mime
 * @param {Array}  args.communities — [{id, name, slug}, ...]
 * @param {Array<Array>} [args.excelRows] — first N parsed rows if Excel/CSV
 * @param {boolean} [args.useClaude] — call Claude even when filename+content agree (default true)
 * @returns {Promise<{community, report_type, as_of_date, confidence, signals}>}
 */
async function classifyVantacaFile(args) {
  const { fileBuffer, filename, mime, communities, excelRows, useClaude = true } = args;
  const signals = {};

  // Signal 1 — filename
  const fn = classifyByFilename(filename, communities);
  signals.filename = fn;

  // Signal 2 — content header (Excel only; PDFs skip to Claude)
  let content = null;
  if (excelRows && excelRows.length > 0) {
    content = classifyByExcelContent(excelRows);
    signals.content = content;
  }

  // Decide whether to call Claude — call ALWAYS for PDFs (since content
  // sniff isn't reliable). For Excel, call if filename + content disagree
  // or if either is weak (< 0.7).
  const filenameStrong = fn && fn.report_type && fn.report_type_confidence >= 0.7;
  const contentStrong = content && content.report_type_confidence >= 0.7;
  const agree = filenameStrong && contentStrong && fn.report_type === content.report_type;

  let claudeResult = null;
  if (useClaude && (!agree || mime === 'application/pdf')) {
    claudeResult = await classifyByClaude({ fileBuffer, mime, filename, communities });
    signals.claude = claudeResult;
  }

  // Combine signals — voting + confidence grading.
  const votes = [];
  if (fn?.report_type) votes.push({ type: fn.report_type, weight: fn.report_type_confidence });
  if (content?.report_type) votes.push({ type: content.report_type, weight: content.report_type_confidence });
  if (claudeResult?.report_type && claudeResult.report_type !== 'unknown') {
    const w = claudeResult.report_type_confidence_text === 'high' ? 0.95
            : claudeResult.report_type_confidence_text === 'medium' ? 0.7
            : 0.4;
    votes.push({ type: claudeResult.report_type, weight: w });
  }

  // Tally weights per type
  const tally = {};
  for (const v of votes) tally[v.type] = (tally[v.type] || 0) + v.weight;
  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const winner = sorted[0] || ['unknown', 0];

  // Confidence: how dominant was the winner?
  let confidence = 'low';
  if (winner[1] >= 1.5 && (!sorted[1] || winner[1] - sorted[1][1] >= 0.5)) confidence = 'high';
  else if (winner[1] >= 0.8) confidence = 'medium';

  // Community resolution — prefer Claude (it saw the report's interior),
  // fall back to filename match.
  const community = claudeResult?.community || fn?.community || null;
  if (!community) confidence = confidence === 'high' ? 'medium' : 'low';

  // As-of date — prefer Claude, fall back to filename
  const as_of_date = claudeResult?.as_of_date || fn?.as_of_date || null;
  if (!as_of_date) confidence = confidence === 'high' ? 'medium' : confidence;

  return {
    community,                                // {id, name, slug} or null
    report_type: winner[0],
    as_of_date,                               // 'YYYY-MM-DD' or null
    confidence,                               // 'high' | 'medium' | 'low'
    signals,                                  // for audit trail / debug
  };
}

module.exports = {
  classifyVantacaFile,
  VALID_REPORT_TYPES,
};
