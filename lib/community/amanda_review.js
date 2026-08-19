// ============================================================================
// lib/community/amanda_review.js  (Ed 2026-08-19)
// ----------------------------------------------------------------------------
// Amanda reviews a document a STAFF MEMBER sent her, and replies to them.
//
// This is a different job from lib/community/amanda_reply.js. That one answers
// an escalated HOMEOWNER thread. This one is a senior manager reading a junior
// manager's draft and giving feedback. Without it, minutes emailed to amanda@
// would run through the homeowner-escalation path: she would never open the
// attachment and would draft something warm and empathetic about a community
// issue that does not exist. A confidently wrong reply is worse than silence.
//
// WHY IT EXISTS. Martha sends Ed documents for approval — minutes, notices,
// letters. Most of what he catches is checkable against written standards, and
// the checkable part does not need him. What genuinely needs Ed is the judgment
// call underneath ("am I over-disclosing?"), and that survives this.
//
// TEACHING, NOT JUST CORRECTING. Amanda explains WHY each time. If she silently
// fixes things, the junior manager is equally junior in a year and the review
// load never falls. The explanation is the point.
//
// TONE, per feedback_ai_disclosure_scope: this is internal mail to a colleague
// who knows the roster. No AI disclosure, no full names, no title block. Three
// announcements nobody needs.
// ============================================================================
const { reviewGuidance } = require('../minutes/standards');

const STAFF_DOMAIN = /@bedrocktx\.com$/i;
const BR = String.fromCharCode(10);

// What kind of document is this, from filename + subject + body. Only minutes
// have a written standard today; everything else gets a general read so Amanda
// never silently ignores something she was sent.
function classifyDocument({ filename, subject, text }) {
  const hay = `${filename || ''} ${subject || ''} ${String(text || '').slice(0, 1500)}`.toLowerCase();
  if (/minutes/.test(hay)) return 'minutes';
  if (/call for nomination|nomination/.test(hay)) return 'nominations';
  if (/agenda/.test(hay)) return 'agenda';
  if (/notice/.test(hay)) return 'notice';
  return 'general';
}


// ---------------------------------------------------------------------------
// Memory. Two tiny functions, and the reason they are worth a table.
// ---------------------------------------------------------------------------
// A grader restates the same seven problems every month. A manager says "the
// seconder is still missing" and "you fixed the GL codes, thank you." The only
// difference is memory, and it has to be STRUCTURED: prior findings come back
// as rule ids, never as old prose, so Amanda cannot invent a conversation. She
// already shipped one invented compliment on her first draft; this is the same
// failure mode with a longer fuse.
// Both degrade quietly. A review that cannot read history is still a good
// review, and a review that cannot be saved has still been sent.
function _sb() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

// History means FEEDBACK THE PERSON ACTUALLY RECEIVED. Two filters, both learned
// the hard way (Ed 2026-08-19).
//
//   sent_at NOT NULL — a review sitting unsent in the draft queue is not
//     something Martha ignored. Without this, re-running the reviewer on the
//     same file made Amanda write "this draft has the same seven issues we
//     talked about on August 19th" about a conversation that never happened,
//     and then ask a real employee why the feedback was not landing. A memory
//     feature that invents history is worse than no memory at all.
//
//   different document — re-reviewing the SAME file is one occasion, not two.
//     Recurrence means the problem came back in NEW work.
async function loadPriorReviews({ staffEmail, documentType, limit = 3, excludeFilename = null }) {
  if (!staffEmail) return [];
  try {
    let q = _sb().from('staff_document_reviews')
      .select('created_at, finding_ids, document_filename')
      .eq('staff_email', String(staffEmail).toLowerCase())
      .eq('document_type', documentType)
      .not('sent_at', 'is', null)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (excludeFilename) q = q.neq('document_filename', excludeFilename);
    const { data, error } = await q;
    if (error) { console.warn('[amanda_review] history unavailable:', error.message); return []; }
    return data || [];
  } catch (e) { console.warn('[amanda_review] history unavailable:', e.message); return []; }
}

/** Persist what she found so the NEXT review can diff against it. */
async function recordReview({ email, docType, filename, findings = [], reply, communityId = null, sourceEmailId = null }) {
  try {
    const ids = [...new Set((findings || []).map((f) => String(f && f.rule_id || '')).filter(Boolean))];
    const { error } = await _sb().from('staff_document_reviews').insert({
      reviewer_persona: 'amanda',
      staff_email: String(email.sender_email || '').toLowerCase(),
      staff_name: email.sender_name || null,
      document_type: docType,
      document_filename: filename || null,
      community_id: communityId,
      findings, finding_ids: ids,
      reply_subject: reply && reply.subject || null,
      reply_body: reply && reply.body || null,
      source_email_id: sourceEmailId,
    });
    if (error) console.warn('[amanda_review] could not record review:', error.message);
    return !error;
  } catch (e) { console.warn('[amanda_review] could not record review:', e.message); return false; }
}

/** Pull readable text out of a .docx or .pdf buffer. Returns '' on failure. */
async function extractText({ filename, buffer, contentType }) {
  const name = String(filename || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  try {
    if (name.endsWith('.docx') || ct.includes('wordprocessingml')) {
      const mammoth = require('mammoth');
      const r = await mammoth.extractRawText({ buffer });
      return String(r && r.value || '').trim();
    }
    if (name.endsWith('.pdf') || ct.includes('pdf')) {
      const pdf = require('pdf-parse');
      const r = await pdf(buffer);
      return String(r && r.text || '').trim();
    }
  } catch (e) {
    console.warn('[amanda_review] extract failed for', filename, e.message);
  }
  return '';
}

/**
 * Review a staff-submitted document and draft a reply to the sender.
 *
 * @returns { draftable, subject, body, docType, reviewed } — draftable false
 *          when this is not a staff document review (so the caller falls
 *          through to the normal homeowner path rather than guessing).
 */
async function draftAmandaDocumentReview({ email, attachments = [], senderFirstName = null }) {
  // Only staff mail. A homeowner emailing amanda@ with a PDF is an escalation,
  // not a review request, and must NOT land here.
  if (!email || !STAFF_DOMAIN.test(String(email.sender_email || ''))) {
    return { draftable: false, reason: 'not_staff_sender' };
  }
  const docs = [];
  for (const a of attachments) {
    const text = await extractText(a);
    if (text && text.length > 200) docs.push({ filename: a.filename, text });
  }
  if (!docs.length) return { draftable: false, reason: 'no_readable_document' };

  const doc = docs[0];
  const docType = classifyDocument({ filename: doc.filename, subject: email.subject, text: doc.text });

  const standards = docType === 'minutes'
    ? reviewGuidance()
    : 'No written house standard exists for this document type yet. Review it on general professional grounds: accuracy, completeness, tone, anything that would embarrass the association if a homeowner or an attorney read it, and anything that states a conclusion the association should not be putting in writing.';

  const first = senderFirstName || String(email.sender_name || '').split(/\s+/)[0] || 'there';

  // WHAT SHE TOLD THIS PERSON BEFORE. This is what separates a manager from a
  // grader: "the seconder is still missing" only exists if she remembers. The
  // history is passed as RULE IDS, never as old prose, so she cannot invent a
  // conversation that did not happen. (Ed 2026-08-19.)
  const history = await loadPriorReviews({
    staffEmail: email.sender_email, documentType: docType,
    excludeFilename: doc.filename || null,
  });
  const historyBlock = history.length
    ? ['WHAT YOU TOLD HER ON HER LAST ' + history.length + ' ' + docType.toUpperCase() + ' DRAFT(S), newest first.',
       'Each line is a date and the rule ids you flagged. Use this to say what she has FIXED and what is RECURRING.',
       'Never claim to have said something that is not on this list.',
       ...history.map((h) => `- ${String(h.created_at).slice(0, 10)}: ${(h.finding_ids || []).join(', ') || 'nothing flagged'}`),
      ].join(BR)
    : 'This is the first draft of this type you have reviewed from her. Do not imply any history.';

  const prompt = `You are Amanda, the Senior Community Manager at Bedrock Association Management. A community manager on your team has sent you a document and asked you to look at it before it goes further.

Write her a reply. She is a colleague who knows you and knows the team, so:
- No greeting formalities beyond "Hi ${first},". No sign-off block, no title, no mention of AI.
- Supportive and direct. She is inexperienced, not careless.
- EXPLAIN WHY for every point. If she only learns what to change, she needs you again next month. If she learns why, she does not.
- Lead by ANSWERING HER ACTUAL QUESTION if she asked one in her email. Do not make her wait through a checklist for it.
- Say what she got RIGHT, specifically, where she did. Especially anything commonly done wrong.
- CRITICAL: only credit her for words that are ACTUALLY IN THE DOCUMENT. Quote the
  phrase you are praising. Never praise a correction she has not made yet, and never
  attribute suggested wording to her. Doing so contradicts your own findings later in
  the same email and destroys her trust in the review.
- Order the problems by consequence. Something that costs money or creates legal exposure comes before a typo.
- No em-dashes. Use commas.
- If nothing is wrong, say so plainly and briefly. Do not manufacture findings.
- End with a short closing line and sign off as "Amanda" and nothing else. Never sign
  with the recipient's name. No title, no company, no AI mention.

HER EMAIL
Subject: ${email.subject || '(no subject)'}
${String(email.body_full || email.body_preview || '').slice(0, 1200)}

DOCUMENT: ${doc.filename}
"""
${doc.text.slice(0, 12000)}
"""

STANDARDS TO CHECK AGAINST
${standards}

${historyBlock}

WHAT YOU CANNOT DO. You are an AI teammate. You have no calendar and cannot
attend anything. NEVER propose a meeting, a call, a sit-down, "20 minutes",
"let's walk through this", or any synchronous time. Offering a colleague time
you cannot keep is worse than unhelpful, it is a promise that will be noticed
when it cannot happen. If a pattern needs more than written feedback, say so
plainly and hand it to Ed: "if this keeps recurring it is worth Ed walking
through it with you." What you CAN offer: reviewing the next draft, explaining
a rule in more depth in writing, or pointing at where the platform produces the
document for her.

TONE ON RECURRENCE. Only claim something is recurring if the history block
above actually shows it. If there is no history, treat this as the first time
and do not imply otherwise. Never ask why feedback "is not landing" unless the
history shows the same rule id flagged on a DIFFERENT document more than once.

RETURN STRICT JSON, no code fences, shaped exactly:
{"findings":[{"rule_id":"<id from the standards above, or 'general'>","severity":"blocking|should_fix|minor","note":"<8 words max>"}],
 "fixed_since_last":["<rule_id she has corrected since the last review>"],
 "body":"<the reply email body>"}
The findings array must list every problem you raise in the body, and nothing you do not raise.`;

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const r = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1800,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = String(r.content?.[0]?.text || '').trim();
    if (!raw) return { draftable: false, reason: 'empty_draft' };

    // Prefer the structured shape; a model that answers in prose anyway still
    // produces a usable review, it just contributes no memory for next time.
    let findings = [], fixedSince = [], body = raw;
    try {
      const j = JSON.parse(raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
      if (j && typeof j.body === 'string' && j.body.trim()) {
        body = j.body.trim();
        findings = Array.isArray(j.findings) ? j.findings : [];
        fixedSince = Array.isArray(j.fixed_since_last) ? j.fixed_since_last : [];
      }
    } catch (_) {
      console.warn('[amanda_review] model did not return JSON — review still usable, no memory recorded');
    }

    return {
      draftable: true,
      docType,
      reviewed: doc.filename,
      subject: /^re:/i.test(email.subject || '') ? email.subject : `Re: ${email.subject || 'your draft'}`,
      body,
      findings,
      fixed_since_last: fixedSince,
      priorReviews: history.length,
    };
  } catch (e) {
    console.warn('[amanda_review] draft failed:', e.message);
    return { draftable: false, reason: e.message };
  }
}

module.exports = { draftAmandaDocumentReview, classifyDocument, extractText, loadPriorReviews, recordReview };
