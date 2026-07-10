// ============================================================================
// lib/payment_plans/extract.js  (Ed 2026-07-10)
// ----------------------------------------------------------------------------
// Extract payment-plan terms from an uploaded document. Works for a single
// signed plan agreement (one plan) OR a firm/attorney report listing several
// (many plans) — the prompt asks for EVERY plan in the document, so a single
// agreement simply returns an array of length 1.
//
// The PDF binary is sent straight to Claude (never pdf-parse — that reads only
// base text and returns blank underscores on Adobe form fields; CLAUDE.md scar).
// Amounts come back as plain dollar numbers; the API layer converts to cents.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly'];
const PLAN_STATUSES = ['active', 'completed', 'defaulted', 'cancelled'];

const PROMPT = `You are reading a homeowners-association PAYMENT PLAN document. It may be a
single signed payment-plan agreement for one owner, or a report/spreadsheet
listing several owners on payment plans. Extract EVERY payment plan you find.

For each plan, read the terms the owner agreed to: the total balance being paid
down, any up-front down payment, the recurring installment amount and how often
it's due, how many installments, and the key dates.

Return ONLY a JSON object of this exact shape (no prose, no markdown fence):

{
  "document_date": "YYYY-MM-DD — the agreement/report date, or null",
  "association_name": "string — the HOA name if printed, or null",
  "plans": [
    {
      "debtor_name":        "string — the owner(s) on the plan",
      "property_address":   "string — the property street address exactly as printed",
      "total_amount":       <number — total balance the plan covers, or null>,
      "down_payment":       <number — up-front payment, or null>,
      "installment_amount": <number — each scheduled payment, or null>,
      "num_installments":   <integer — number of payments, or null>,
      "frequency":          "one of: weekly, biweekly, semimonthly, monthly, quarterly (default monthly if unclear)",
      "start_date":         "YYYY-MM-DD — when the plan starts, or null",
      "first_payment_date": "YYYY-MM-DD — first installment due, or null",
      "next_due_date":      "YYYY-MM-DD — next payment due if stated, or null",
      "end_date":           "YYYY-MM-DD — expected completion, or null",
      "balance_remaining":  <number — remaining balance if stated, else null>,
      "status_hint":        "one of: active, completed, defaulted, cancelled — best read of the plan's current state (default active)",
      "terms_summary":      "one or two plain sentences summarizing the arrangement (no legalese)"
    }
  ]
}

Numbers are plain (no $ or commas). Use null for anything not stated — never guess an amount or date.`;

async function extractPaymentPlans(pdfBuffer) {
  const t0 = Date.now();
  const completion = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 12000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
        { type: 'text', text: PROMPT },
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
      ? ' Model hit max_tokens; output truncated — split the document or raise the cap.' : '';
    throw new Error(`Payment-plan extraction returned malformed JSON.${hint} ${err.message}`);
  }
  const plans = Array.isArray(parsed.plans) ? parsed.plans : [];
  // Normalize frequency + status to the allowed enums (never emit an invalid value).
  for (const p of plans) {
    p.frequency = FREQUENCIES.includes(String(p.frequency || '').toLowerCase()) ? String(p.frequency).toLowerCase() : 'monthly';
    p.status_hint = PLAN_STATUSES.includes(String(p.status_hint || '').toLowerCase()) ? String(p.status_hint).toLowerCase() : 'active';
  }
  return { parsed, plans, raw_extracted: parsed, usage: completion.usage, duration_ms: Date.now() - t0 };
}

module.exports = { extractPaymentPlans, FREQUENCIES, PLAN_STATUSES };
