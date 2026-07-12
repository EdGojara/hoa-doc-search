// ============================================================================
// lib/enforcement/drv_reply.js  (Ed 2026-07-12)
// ----------------------------------------------------------------------------
// Miranda Pierce — DRV / compliance specialist. When a homeowner replies to
// their violation notice ("I mowed it," a dispute, a photo of the fix), Claire
// hands it here. Miranda:
//   1. finds the property's open enforcement case,
//   2. logs the homeowner's response + any photos ONTO that case (interactions),
//   3. drafts a careful reply for a human to review and send.
//
// She HOLDS. She never states a violation is cured/closed, never assesses a
// fine, never quotes §209 or makes a legal determination. Cure is confirmed by
// re-inspection, by a person. This module only reads the case and drafts words;
// it changes no enforcement state. (Autonomy rule Ed set: acknowledge + assess,
// hold the decision. §209 is a catastrophic-output surface — see CLAUDE.md.)
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { fetchAllAttachmentBuffers } = require('../email/graph_attachments');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const OPEN_STAGE_ORDER = ['courtesy_1', 'courtesy_2', 'certified_209', 'fine_assessed'];

// The property's most-advanced OPEN violation (never a cured/closed/voided one).
// Furthest-advanced so a reply is answered against the real state of the case,
// mirroring the enforcement chokepoint's "furthest stage wins" rule.
async function findOpenCaseForProperty(propertyId) {
  if (!propertyId) return null;
  const { data, error } = await supabase.from('violations')
    .select('id, property_id, community_id, primary_category_id, current_stage, opened_at, cure_period_ends_at')
    .eq('property_id', propertyId)
    .not('current_stage', 'in', '(cured,closed,voided)')
    .order('opened_at', { ascending: false });
  if (error || !data || !data.length) return null;
  data.sort((a, b) => OPEN_STAGE_ORDER.indexOf(b.current_stage) - OPEN_STAGE_ORDER.indexOf(a.current_stage));
  return data[0];
}

// Does this email actually read like a response to a notice? An open case plus
// a homeowner writing in is a strong signal on its own; a violation_report
// classification or compliance keywords confirm it. Guards against hijacking an
// unrelated email from someone who merely happens to have an open case.
// Deliberately precise: violation-specific terms plus concrete cure activities.
// Ambiguous short words ("can", "done", "complete") are excluded — they match
// ordinary requests ("Can I get a pool tag") and would mis-route.
const DRV_KEYWORDS = /\b(mow|mowed|mowing|weeds?|overgrown|yard|lawn|grass|trash cans?|recycl|garbage|parked|trailer|deed[- ]?restriction|restriction|violation|compliance|complied|comply|cure|curing|cured it|dispute|disput|disagree|appeal|hearing|the fine|extension|the notice|notice you sent|your letter|the letter you|taken care of|fixed it|corrected it|removed it|cleaned it up|already (mowed|fixed|removed|cleaned|taken))\b/i;
function looksLikeDrvResponse(email, classification) {
  if (classification === 'violation_report') return true;
  const text = `${email.subject || ''} ${email.body_full || email.body_preview || ''}`;
  return DRV_KEYWORDS.test(text);
}

const MIRANDA_SYSTEM = `You are Miranda Pierce, the compliance coordinator at Bedrock Association
Management. A homeowner has replied about a deed-restriction (violation) notice
on their property. Write a reply for a Bedrock staffer to review before it is
sent. Warm, respectful, plain, and brief. Use commas, never em-dashes.

HARD RULES — you are drafting for review, you do NOT decide anything:
- NEVER say the violation is resolved, cured, cleared, closed, or dismissed.
- NEVER assess, waive, reduce, or reference a specific fine amount.
- NEVER quote or paraphrase statute (Texas §209 or otherwise) or state any
  legal position, deadline, or consequence as fact.
- NEVER promise an outcome or a specific date. "We will follow up" is fine.
- Do NOT invent facts about their property or the case.

WHAT TO DO, by what they said:
- They say they fixed it / took care of it: thank them, tell them you have noted
  their update and passed it to the team, and that the team will confirm at the
  next inspection. Do not declare it resolved yourself.
- They dispute it or ask for more time: acknowledge their message, tell them you
  have recorded their response and shared it with the team, and that someone will
  follow up. Do not rule on the dispute.
- They ask a question you cannot answer without deciding the case: acknowledge,
  say you have flagged it for the team, and that a person will get back to them.

Do not add a signature or sign-off name; that is added automatically.

Return ONLY JSON: { "subject": "Re: ...", "body": "the reply body, greeting through closing line, no signature" }`;

// Draft Miranda's careful reply. Returns { draftable, subject, body, careful }.
async function draftMirandaReply({ email, contactName }) {
  const incoming = `From: ${email.sender_name || ''} ${contactName ? `(${contactName})` : ''}
Subject: ${email.subject || ''}

${(email.body_full || email.body_preview || '').slice(0, 6000)}`;
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 1200, system: MIRANDA_SYSTEM,
      messages: [{ role: 'user', content: incoming }],
    });
    const t = (resp.content?.[0]?.text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const p = JSON.parse(t);
    if (!p.body) return { draftable: false };
    return { draftable: true, subject: p.subject || `Re: ${email.subject || 'your message'}`, body: p.body, careful: true, persona: 'miranda' };
  } catch (e) {
    console.warn('[drv_reply] draft failed:', e.message);
    return { draftable: false };
  }
}

// Log the homeowner's inbound response (and any photos) ONTO the case, plus
// Miranda's held draft, so the response lives in the case history (Homeowner
// 360 / board portal / memory layer) instead of an inbox. Best-effort.
async function logDrvInbound({ email, openCase, propertyId, contactId, draft }) {
  if (!openCase) return;
  // Save any photos to storage and reference them on the interaction.
  const attachments = [];
  try {
    if (email.has_attachments && email.graph_id) {
      const files = await fetchAllAttachmentBuffers(email.mailbox, email.graph_id);
      for (const f of files.filter((x) => x.isImage).slice(0, 8)) {
        const safeName = (f.filename || 'photo.jpg').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
        const storagePath = `drv/${openCase.id}/${Date.now()}_${safeName}`;
        const { error } = await supabase.storage.from('documents').upload(storagePath, f.buffer, { contentType: f.contentType, upsert: false });
        if (!error) attachments.push({ type: 'photo', storage_path: storagePath, label: f.filename || 'photo' });
      }
    }
  } catch (e) { console.warn('[drv_reply] photo save skipped:', e.message); }

  try {
    await supabase.from('interactions').insert({
      community_id: openCase.community_id, property_id: propertyId || openCase.property_id,
      contact_id: contactId || null, violation_id: openCase.id,
      type: 'email_inbound', direction: 'inbound', status: 'received',
      subject: email.subject || null, content: (email.body_full || email.body_preview || '').slice(0, 8000),
      delivery_method: 'email', attachments: attachments.length ? attachments : null,
      received_at: email.received_at || new Date().toISOString(),
    });
  } catch (e) { console.warn('[drv_reply] inbound log failed:', e.message); }

  if (draft && draft.body) {
    try {
      await supabase.from('interactions').insert({
        community_id: openCase.community_id, property_id: propertyId || openCase.property_id,
        contact_id: contactId || null, violation_id: openCase.id,
        type: 'ai_draft', direction: 'outbound', status: 'draft',
        subject: draft.subject || null, content: draft.body,
        ai_drafted: true, ai_model: 'claude-sonnet-4-5',
      });
    } catch (e) { console.warn('[drv_reply] draft log failed:', e.message); }
  }
  return { photos: attachments.length };
}

// Log Miranda's sent reply onto the case (called from the send handler).
async function logDrvOutbound({ violationId, communityId, propertyId, contactId, subject, body, sentBy }) {
  if (!violationId) return;
  try {
    await supabase.from('interactions').insert({
      community_id: communityId || null, property_id: propertyId || null, contact_id: contactId || null,
      violation_id: violationId, type: 'email_outbound', direction: 'outbound', status: 'sent',
      subject: subject || null, content: (body || '').slice(0, 8000), delivery_method: 'email',
      ai_drafted: true, ai_model: 'claude-sonnet-4-5', sent_at: new Date().toISOString(),
    });
  } catch (e) { console.warn('[drv_reply] outbound log failed:', e.message); }
}

module.exports = { findOpenCaseForProperty, looksLikeDrvResponse, draftMirandaReply, logDrvInbound, logDrvOutbound };
