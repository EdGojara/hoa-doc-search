// ============================================================================
// lib/correspondence/classify.js
// ----------------------------------------------------------------------------
// AI classifier for inbound homeowner interactions (email, portal request,
// voice call summary, SMS). Runs on every inbound write — populates
// interactions.ai_classification JSONB column with structured triage data
// the operator UI uses to route + prioritize.
//
// Cheap + fast: Haiku, ~1-2 seconds per call, ~$0.001 per classification.
// At Bedrock's current ~200 touches/day volume = ~$6/mo. At 50-community
// franchise scale = ~$50/mo. Effectively free.
//
// Returns null on parse failure — caller decides whether to retry or skip.
// Classifier validates output against allowed enums; rejects + normalizes
// out-of-band values so the column doesn't get junked.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Allowed enum values — keep aligned with operator-facing taxonomy used
// in the Homeowner Profile UI + inbox routing rules.
const CATEGORIES = [
  'billing_question',
  'service_request',
  'maintenance_request',
  'arc_request',
  'general_inquiry',
  'complaint',
  'compliance_question',
  'compliment',
  'broadcast_acknowledgment',
  'access_request',         // key fob, gate access, etc.
  'document_request',
  'spam',
  'other',
];
const URGENCIES = ['low', 'normal', 'high', 'critical'];
const LENS_TRIGGERS = [
  'legal',                  // statute / attorney / fair housing / ADA
  'ccr',                    // covenants / deed restrictions
  'financial',              // payment / balance / collections / lien
  'operational',            // scheduling / vendor / maintenance / access
  'homeowner_experience',   // tone, frustration, escalation potential
  'risk',                   // harassment / safety / threats
  'precedent',              // similar cases we should reference
];
const SUGGESTED_ROUTING = [
  'violations@',
  'acc@',
  'accounting@',
  'scans@',
  'builders@',
  'info@',
  'attorney_review',
];

const MODEL = 'claude-haiku-4-5-20251001';

/**
 * Classify an inbound interaction. Returns ai_classification object suitable
 * for direct write to interactions.ai_classification (JSONB), or null on
 * extraction/parse failure.
 *
 * @param {object} interaction — must have at least: subject, content, type.
 *                               Optionally: contact_name, from_email, community_name
 * @param {object} [opts]
 * @param {object} [opts.logger=console]
 * @returns {Promise<object|null>}
 */
async function classifyInteraction(interaction, { logger = console } = {}) {
  const prompt = `You're triaging an inbound homeowner communication for Bedrock Association Management. Read the subject and body, then return a JSON classification.

Subject: ${interaction.subject || '(no subject)'}
From: ${interaction.contact_name || interaction.from_email || '(unknown)'}
Channel: ${interaction.type || 'unknown'}
${interaction.community_name ? `Community: ${interaction.community_name}` : ''}

Body:
${(interaction.content || '(empty)').slice(0, 2500)}

Return ONLY a JSON object (no markdown fences, no commentary):
{
  "category": "billing_question" | "service_request" | "maintenance_request" | "arc_request" | "general_inquiry" | "complaint" | "compliance_question" | "compliment" | "broadcast_acknowledgment" | "access_request" | "document_request" | "spam" | "other",
  "urgency": "low" | "normal" | "high" | "critical",
  "lens_triggers": ["legal" | "ccr" | "financial" | "operational" | "homeowner_experience" | "risk" | "precedent"],
  "suggested_routing": "violations@" | "acc@" | "accounting@" | "scans@" | "builders@" | "info@" | "attorney_review",
  "summary_one_line": "string — the gist in 1 sentence",
  "needs_legal_review": true | false
}

Urgency guide:
- critical: imminent legal/safety risk; fair-housing exposure; threats; lawsuit mentions
- high: payment dispute with collections risk; ARC denial appeal; board-member escalation; angry tone
- normal: routine question; service request; general inquiry
- low: compliment; broadcast acknowledgment; spam

Lens triggers fire on these signals (multi-select):
- legal: lawsuit, attorney, statute citation, fair housing, ADA, §209
- ccr: deed restrictions, covenant violations, modification rules
- financial: payment, balance, fee waiver, collections, lien, assessment
- operational: scheduling, vendor, maintenance, access, fob, gate
- homeowner_experience: frustrated tone, long-standing issue, multiple touches mentioned
- risk: harassment, safety threats, escalation potential, vendor dispute
- precedent: situation likely matches prior cases worth referencing

Suggested routing (single value):
- violations@ for DRV / compliance topics
- acc@ for ARC / architectural request / exterior modification
- accounting@ for billing / payment / AR / assessment topics
- scans@ for mailed document submissions
- builders@ for new-construction builder topics
- info@ for general inquiries
- attorney_review when needs_legal_review=true`;

  let resp;
  try {
    resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    logger.warn(`[classify] API call failed: ${err.message}`);
    return null;
  }

  const text = (resp.content[0]?.text || '').trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.warn(`[classify] JSON parse failed: ${err.message}; raw: ${cleaned.slice(0, 200)}`);
    return null;
  }

  // Validate + normalize against allowed enums. The model is generally
  // disciplined but occasionally invents values — coerce to safe defaults
  // rather than poison the column.
  if (!CATEGORIES.includes(parsed.category)) parsed.category = 'other';
  if (!URGENCIES.includes(parsed.urgency)) parsed.urgency = 'normal';
  if (!Array.isArray(parsed.lens_triggers)) parsed.lens_triggers = [];
  parsed.lens_triggers = parsed.lens_triggers.filter((l) => LENS_TRIGGERS.includes(l));
  if (parsed.suggested_routing && !SUGGESTED_ROUTING.includes(parsed.suggested_routing)) {
    parsed.suggested_routing = parsed.needs_legal_review ? 'attorney_review' : 'info@';
  }
  parsed.summary_one_line = String(parsed.summary_one_line || '').slice(0, 250);
  parsed.needs_legal_review = !!parsed.needs_legal_review;

  parsed.classified_at = new Date().toISOString();
  parsed.classified_by_model = MODEL;

  return parsed;
}

module.exports = {
  classifyInteraction,
  CATEGORIES,
  URGENCIES,
  LENS_TRIGGERS,
  SUGGESTED_ROUTING,
  MODEL,
};
