// ============================================================================
// lib/collections/winstead_extract.js  (Ed 2026-07-08)
// ----------------------------------------------------------------------------
// Extract the Winstead PC "Matter Detail Portrait" collections status report
// (one section per delinquent account) into structured matters, and map each
// matter's signals to a canonical ar_account_collections.collection_status.
//
// The STATUS MAPPING lives here, in code — not in the model and not duplicated
// per caller — so every ingest classifies the same way (consistent enforcement).
// The model reads each matter and returns evidence/signals; this file turns
// signals into the enum. The operator still reviews + can override before the
// upsert commits.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Allowed collection_status values (must match migration 232's CHECK).
const COLLECTION_STATUSES = [
  'none', 'late_notice', 'delinquent_reminder', 'certified_demand',
  'board_review', 'payment_plan', 'with_attorney', 'bankruptcy',
  'lien_filed', 'foreclosure', 'written_off',
];

// ----------------------------------------------------------------------------
// mapWinsteadStatus — signals → enum. Order matters (most-decisive first).
//   m: { latest_action, latest_note, foreclosure_recommended, bankruptcy_pending,
//        payment_plan_active, lien_recorded }
// Rules mirror the manual mapping used to seed Eaglewood 2026-07-08:
//  - bankruptcy note present            -> bankruptcy   (automatic stay; hands off)
//  - active payment plan, paying        -> payment_plan
//  - foreclosure suit recommended OR the latest action is the Lien Enforcement
//    Notice w/ Draft Petition, and it has NOT since been superseded by a
//    balance-due/paydown notice         -> foreclosure
//  - a lien has been recorded           -> lien_filed
//  - otherwise (at the firm, pre-lien)  -> with_attorney
// ----------------------------------------------------------------------------
function mapWinsteadStatus(m) {
  const latest = String(m.latest_action || '').toLowerCase();
  const paidDown = /balance due|payment/.test(latest); // latest step is a paydown/balance-due notice
  if (m.bankruptcy_pending) return 'bankruptcy';
  if (m.payment_plan_active) return 'payment_plan';
  const onForeclosureTrack = m.foreclosure_recommended
    || /lien enforcement notice.*(draft )?petition|draft petition/.test(latest);
  if (onForeclosureTrack && !paidDown) return 'foreclosure';
  if (m.lien_recorded) return 'lien_filed';
  return 'with_attorney';
}

const WINSTEAD_PROMPT = `You are reading a Winstead PC "Matter Detail Portrait" collections status
report for a single homeowners association. Each section is ONE delinquent
account and contains: a Firm File #, Debtor(s), a Subject Property address, an
Accounting Information table (Assessment / Attorney Costs / Attorney Fee /
Collection Cost / Total), an Actions list (dated), and Notes.

Return ONLY a JSON object of this exact shape (no prose, no markdown fence):

{
  "report_as_of":   "YYYY-MM-DD — the 'As Of' date in the report header",
  "association_name":"string — the HOA name in the header, or null",
  "matters": [
    {
      "firm_file":       "string e.g. 71335-14",
      "debtors":         "string — full debtor name(s)",
      "property_address":"string — the Subject Property street address exactly as printed",
      "balance_total":   <number>,
      "assessment":      <number>,
      "attorney_fee":    <number>,
      "attorney_costs":  <number>,
      "collection_cost": <number>,
      "latest_action":   "string — the most recent (top) row's Action Taken",
      "latest_action_date":"YYYY-MM-DD — that row's date",
      "latest_note":     "string — the most recent Note description, or null",
      "foreclosure_recommended": <true|false — does a note recommend filing a foreclosure suit / seeking board authorization to foreclose?>,
      "bankruptcy_pending":      <true|false — does a note say a bankruptcy case is pending / hold for bankruptcy?>,
      "payment_plan_active":     <true|false — is there a payment plan the owner is currently paying under?>,
      "lien_recorded":           <true|false — has a lien been recorded/filed (any 'Lien Notice Letter w/ Recorded Lien' or 'Notice of Unpaid Assessment Lien' action)?>,
      "closing_removed":         <true|false — does a note say Winstead will close the account / remove from collections?>
    }
  ]
}

Extract EVERY matter section in the report. Numbers are plain (no $ or commas).`;

async function extractWinsteadMatters(pdfBuffer) {
  const t0 = Date.now();
  const completion = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
        { type: 'text', text: WINSTEAD_PROMPT },
      ],
    }],
  });
  const text = completion.content?.[0]?.text || '';
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const hint = completion.stop_reason === 'max_tokens'
      ? ' Model hit max_tokens; output truncated — split the report or raise the cap.' : '';
    throw new Error(`Winstead extraction returned malformed JSON.${hint} ${err.message}`);
  }
  const matters = Array.isArray(parsed.matters) ? parsed.matters : [];
  // Attach the mapped status to each matter.
  for (const m of matters) m.mapped_status = mapWinsteadStatus(m);
  return { parsed, matters, usage: completion.usage, duration_ms: Date.now() - t0 };
}

module.exports = { COLLECTION_STATUSES, mapWinsteadStatus, extractWinsteadMatters };
