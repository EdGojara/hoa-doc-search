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

const MIRANDA_SYSTEM = `You are Miranda Pierce, the compliance / deed-restriction coordinator at Bedrock
Association Management, and THIS IS YOUR LANE. A homeowner has replied about a
violation notice on their property. Write a reply for a Bedrock staffer to review
before sending. Warm, respectful, plain, brief, and CONFIDENT. Commas, never em-dashes.

You are the specialist, not a switchboard. ANSWER with substance from the CASE DATA
and COVENANT below. Do NOT punt with "I have passed this along and someone will
follow up after the next inspection" — that generic deferral is exactly the
non-answer to avoid. Address what they actually said, tell them what our records
show, and give a specific, concrete next step.

USE THE CASE DATA:
- Name the issue and roughly where it stands in plain terms (a courtesy notice, a
  second notice) using the category label given. Do not expose internal stage codes.
- If they say they FIXED it / took care of it: thank them for handling it, tell them
  the most recent inspection we have on file was on the date given, and that we will
  confirm the current condition against our latest inspection. If our latest inspection
  already reflects the correction, the case will be closed; if our records predate their
  work, we will re-inspect and update it. Be concrete about that path, not vague.
- If they DISPUTE it (wrong house, not their issue, the photo is outdated): acknowledge
  the specific point, tell them what our records show including the inspection date, and
  that we will verify against our most recent inspection and correct the case if it does
  not reflect the current condition.
- Reference the COVENANT standard plainly if it helps them understand what is required,
  in plain words, no statute citations or section-number soup.
- If they bring up OTHER properties or compare themselves to neighbors ("other yards on
  the street are worse"): do NOT confirm, deny, or discuss any other resident's property
  or its enforcement status. Say plainly that for privacy reasons we cannot discuss other
  residents' properties, and that the association applies its standards consistently
  across the community. Then return to their own matter. Never name another owner or
  address, and never say what is or isn't being done about anyone else.

GUARDRAILS (you draft for review; a person sends, and a re-inspection confirms cure):
- Do NOT declare the violation cured, closed, or dismissed yourself, and do NOT promise a
  specific close date. You CAN commit to the PROCESS (we will verify against the latest
  inspection and update the case accordingly).
- Do NOT assess, waive, or reference a specific fine amount, and do NOT state a legal
  deadline or consequence as fact.
- Do NOT invent facts. Use ONLY the CASE DATA, COVENANT, and their message; if a fact
  is not provided, do not state it.

Do not add a signature or sign-off name; that is added automatically.
Return ONLY JSON: { "subject": "Re: ...", "body": "the reply body, greeting through closing line, no signature" }`;

// Case grounding so Miranda answers instead of punting: the category, roughly where
// the case stands, the MOST RECENT inspection date on file, and the covenant standard.
async function _mirandaCaseContext(openCase) {
  if (!openCase) return 'CASE DATA: (no open case matched — acknowledge warmly and say the team will confirm the details.)';
  const lines = [];
  try {
    const { data: v } = await supabase.from('violations')
      .select('opened_at, current_stage, cure_period_ends_at, last_continued_at, primary_category_id, enforcement_categories(label, slug, description)')
      .eq('id', openCase.id).maybeSingle();
    const cat = v && v.enforcement_categories;
    const stageLabel = { courtesy_1: 'a first courtesy notice', courtesy_2: 'a second notice', certified_209: 'a formal (certified) notice', fine_assessed: 'a notice with a fine' };
    lines.push(`Issue: ${(cat && cat.label) || 'a deed-restriction matter'}`);
    lines.push(`Where it stands: ${stageLabel[(v && v.current_stage) || openCase.current_stage] || 'an open notice'}`);
    if (v && v.opened_at) lines.push(`First noticed: ${String(v.opened_at).slice(0, 10)}`);
    const lastInsp = (v && v.last_continued_at) || (v && v.opened_at);
    if (lastInsp) lines.push(`MOST RECENT inspection on file: ${String(lastInsp).slice(0, 10)}`);
    // Covenant standard (best-effort, same lookup the letters use).
    try {
      const { lookupGoverningDoc } = require('./governing_doc_lookup');
      const gd = await lookupGoverningDoc({ communityId: openCase.community_id, categorySlug: cat && cat.slug, categoryLabel: cat && cat.label, categoryDescription: cat && cat.description });
      if (gd && gd.quote) lines.push(`Covenant standard: ${String(gd.quote).slice(0, 400)}`);
    } catch (_) {}
  } catch (_) {}
  return 'CASE DATA (use this to answer; do not expose internal codes):\n' + lines.map((l) => '- ' + l).join('\n');
}

// Draft Miranda's grounded reply. Returns { draftable, subject, body, careful }.
async function draftMirandaReply({ email, contactName, openCase }) {
  const caseCtx = await _mirandaCaseContext(openCase);
  const incoming = `From: ${email.sender_name || ''} ${contactName ? `(${contactName})` : ''}
Subject: ${email.subject || ''}

${(email.body_full || email.body_preview || '').slice(0, 6000)}

${caseCtx}`;
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
