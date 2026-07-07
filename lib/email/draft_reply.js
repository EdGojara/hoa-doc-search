// ============================================================================
// lib/email/draft_reply.js  (Ed 2026-07-06) — Claire drafts the RIGHT answer
// ----------------------------------------------------------------------------
// Ed's direction: Claire should put together what she thinks is the correct
// answer using everything the system knows — the homeowner's account data,
// Texas §209, the community's governing documents — and Ed reviews every one;
// NOTHING is released until he's read it and agreed or edited it.
//
// So this drafts a SUBSTANTIVE, grounded reply, not a punt:
//   1. ACCOUNT DATA — the homeowner's open violations (stage + cure date),
//      balance, property — so account-specific answers are correct.
//   2. KNOWLEDGE — getRelevantChunks() over the community's governing docs +
//      Texas §209 (the SAME hybrid retrieval askEd + voice-Claire use — one
//      source of truth, no parallel silo).
//   3. Claire answers grounded in both, in Bedrock's voice, never inventing a
//      fee/rule/deadline that isn't in the retrieved knowledge.
//
// Guardrails (the human gate does the rest — approve-to-send, Ed reads all):
//   - `careful:true` on compliance classes (legal / violation / ACC / financial)
//     so the board flags them for extra scrutiny.
//   - Even grounded, the draft EXPLAINS/RECOMMENDS the §209 or governing-doc
//     basis; it does not autonomously issue a final binding ruling, grant/deny
//     an approval, or waive a fee — Ed makes that call on review. The formal
//     §209 letters / ACC decisions still go through their own renderers.
//   - spam / internal → no draft.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const { CASUAL_TONE } = require('../tone');
const { getRelevantChunks } = require('../hybrid_retrieval');
const { createClient } = require('@supabase/supabase-js');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const MODEL = 'claude-sonnet-4-5';

const NO_DRAFT = new Set(['spam', 'internal']);
const CAREFUL = new Set(['legal_privileged', 'violation_report', 'acc_request', 'vendor_financial']);
const DRAFTABLE = new Set(['homeowner_request', 'vendor_general', ...CAREFUL]);

const money = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Pull the homeowner's live account context (grounds account-specific answers).
async function accountContext({ contactId, propertyId, contactName }) {
  if (!propertyId && !contactId) return '';
  const lines = [];
  if (propertyId) {
    const { data: v } = await supabase.from('violations')
      .select('current_stage, opened_at, cure_period_ends_at, primary_category_id, enforcement_categories(label)')
      .eq('property_id', propertyId).is('resolved_at', null).limit(20);
    if (v && v.length) lines.push('Open violations: ' + v.map((x) => `${x.enforcement_categories ? x.enforcement_categories.label : 'violation'} at stage ${x.current_stage}${x.cure_period_ends_at ? ` (cure by ${String(x.cure_period_ends_at).slice(0, 10)})` : ''}, opened ${String(x.opened_at || '').slice(0, 10)}`).join('; '));
    else lines.push('Open violations: none');
    const { data: bal } = await supabase.from('v_homeowner_current_balance').select('balance_cents').eq('property_id', propertyId).maybeSingle();
    if (bal) lines.push(`Account balance: ${money(Number(bal.balance_cents) || 0)}${bal.balance_cents > 0 ? ' (owes)' : bal.balance_cents < 0 ? ' (credit)' : ' (current)'}`);
  }
  return lines.length ? `ACCOUNT DATA for ${contactName || 'this homeowner'}:\n- ${lines.join('\n- ')}` : '';
}

async function draftReply({ email, classification, contactId, propertyId, communityId, contactName, communityName }) {
  if (NO_DRAFT.has(classification)) {
    return { draftable: false, careful: false, reason: classification === 'spam' ? 'spam — no reply' : 'internal / system notification — no reply' };
  }
  const careful = CAREFUL.has(classification);
  const firstName = (contactName || '').trim().split(/\s+/)[0] || '';
  const emailText = `${email.subject || ''} ${email.body_full || email.body_preview || ''}`.trim();

  // Gather grounding — account data + governing-doc/§209 knowledge (best-effort).
  let acct = '', docs = '';
  try { acct = await accountContext({ contactId, propertyId, contactName }); } catch (_) {}
  try { docs = (await getRelevantChunks(emailText, communityName || '')) || ''; } catch (_) {}

  const sys = `You are Claire, Bedrock Association Management's AI assistant, drafting a reply for a team member to review. This is a DRAFT — a human reads it and approves, edits, or holds it. Your job is to put together the RIGHT answer the way an expert HOA manager who knows Texas Property Code Chapter 209 and this community's governing documents would.
${CASUAL_TONE}

GROUNDING — use the ACCOUNT DATA and KNOWLEDGE provided in the message:
- Base every factual claim (a fee, a rule, a deadline, a §209 cure right, an amount owed, a violation stage) on the ACCOUNT DATA or KNOWLEDGE given. Do NOT invent numbers, rules, or citations.
- If the answer needs a specific fact that ISN'T in what you were given, don't guess — say you'll confirm it and follow up.
- Reference the basis in plain language a homeowner understands (e.g. "under Texas §209 you have 30 days to cure" ONLY if the knowledge supports it) — no section-number soup, no document-citation voice.
${careful ? `- COMPLIANCE-SENSITIVE (${classification}): give the accurate grounded answer, but do NOT issue a final binding decision, grant or deny an approval, or waive a fee/fine on your own — explain what applies and the next step. The formal letter/decision follows separately. A person will decide.` : ''}
- Address the SPECIFIC thing they wrote (name the issue/address/request) so it's clear a real person read it.
- If they're NOT asking a question — a thank-you, a friendly reply, or an update that they've corrected/resolved the issue — don't force an answer. Reply warmly and briefly: thank them for letting us know, tell them we'll note it (and that the team will confirm the correction and close it out where that applies), and invite them to reach out if they need anything else.
- Sign off with "Bedrock Association Management" on its own line (Claire's AI signature is appended at send). No AI disclaimer in the body, no boilerplate.
- Return ONLY the email body text — no subject line, no preamble, no quotes.`;

  const ctx = `Community: ${communityName || '(unknown)'}
Contact: ${contactName || '(name unknown — do not guess a name)'}${firstName ? ` (first name: ${firstName})` : ''}
Classification: ${classification}

${acct || 'ACCOUNT DATA: (none linked)'}

KNOWLEDGE (governing docs / Texas §209 / policies retrieved for this question):
${docs ? docs.slice(0, 9000) : '(no matching documents found)'}

THEY WROTE:
Subject: ${email.subject || ''}
${(email.body_full || email.body_preview || '').slice(0, 4000)}

Draft Claire's reply body now.`;

  const resp = await anthropic.messages.create({
    model: MODEL, max_tokens: 800, system: sys,
    messages: [{ role: 'user', content: [{ type: 'text', text: ctx }] }],
  });
  const body = ((resp.content[0] && resp.content[0].text) || '').trim();
  const subject = /^re:/i.test(email.subject || '') ? email.subject : `Re: ${email.subject || 'your message'}`;
  return { draftable: true, careful, subject, body, grounded: { account: !!acct, knowledge: !!docs } };
}

module.exports = { draftReply, DRAFTABLE, CAREFUL, NO_DRAFT };
