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
  const nameHay = `${filename || ''} ${subject || ''}`.toLowerCase();
  const hay = `${nameHay} ${String(text || '').slice(0, 2000)}`.toLowerCase();
  if (/minutes/.test(hay)) return 'minutes';
  if (/call for nomination|nomination/.test(hay)) return 'nominations';
  if (/agenda/.test(hay)) return 'agenda';
  // Contract BEFORE notice — a services agreement often says "notice" inside it.
  // The filename or subject naming it a contract/agreement is enough on its own;
  // otherwise fall back to contract-body signals.
  if (/\b(contract|agreement|services agreement|master service|statement of work|\bsow\b|\bmsa\b|engagement letter)\b/.test(nameHay)) return 'contract';
  if (/\b(contract|agreement)\b/.test(hay) && /(indemnif|the parties|hereby agree|whereas|scope of (work|services)|term of this agreement|shall (not )?be liable|services? (shall|will) commence)/.test(hay)) return 'contract';
  if (/notice/.test(hay)) return 'notice';
  return 'general';
}

// What a senior manager reads a VENDOR CONTRACT for before it goes to a board.
// A checklist, so the first pass is systematically thorough instead of noticing
// whatever happens to catch its eye. Written from real HOA contract failure
// modes (Ed + the UPS security contract review, 2026-09-01).
function contractReviewChecklist() {
  return [
    'This is a vendor/third-party CONTRACT the board will be asked to approve. Read it CRITICALLY for risk to the association, not just business terms. Work through every item below and raise the ones that apply, ordered by consequence:',
    '1. INDEMNIFICATION / LIABILITY ALLOCATION. Who indemnifies whom, and for whose negligence? A clause where the association indemnifies the vendor for the VENDOR\'s own negligence or alleged misconduct is the single most serious problem — quote it and flag it must-change (mutual, or each party covers its own negligence). Note that Texas applies an "express negligence" doctrine to indemnity for one\'s own negligence, so this belongs with counsel.',
    '2. LIMITATION OF LIABILITY / WAIVERS. Does the vendor cap its liability to gross negligence / willful misconduct while the association waives ordinary-negligence remedies? Any near-impossible condition on recovery (e.g. theft recovery requiring a criminal CONVICTION)? The association may be buying a service and waiving the remedy if it fails.',
    '3. TERM, RENEWAL, AND TERMINATION — CHECK FOR CONTRADICTIONS. Compare EVERY term/renewal/termination clause against each other. Month-to-month vs automatic annual renewal in two different sections is a real conflict that changes exit rights. Confirm the association has a clean right to terminate on notice (ideally without cause). Flag any conflict explicitly by section.',
    '4. CLIENT-DIRECTION / SUPERVISION LIABILITY. Does a clause make the association liable if it "directs," "alters policies," or "assumes supervision"? For an HOA this is a trap — staff WILL tell an officer where to patrol or what to watch, and the vendor could recast routine direction as "assuming supervision" to shift liability. Push to narrow it so ordinary service direction does not transfer responsibility for the vendor\'s personnel.',
    '5. MISSING EXHIBITS / INCORPORATED-BY-REFERENCE TERMS. Does the contract reference an Exhibit (rates, schedule) or "policies and rules" that are not attached? The board cannot approve what it cannot see. Flag every referenced-but-absent exhibit as must-have.',
    '6. SCOPE OF WORK. Are the actual duties defined (post orders, patrols, access control, reporting), or left to something outside the agreement? Undefined scope means nothing to hold the vendor to.',
    '7. PRICING / RATE CHANGES. Can the vendor raise rates unilaterally? Any open-ended trigger ("inflationary trends", "any legislation")? Push for a fixed rate or a capped, index-tied increase with notice.',
    '8. INSURANCE. Are specific limits stated, or just "as required by law" (which can be little)? Recommend specific minimums and the association named as additional insured, plus a current COI.',
    '9. NON-SOLICIT / NO-HIRE + LIQUIDATED DAMAGES. Note any restriction on hiring the vendor\'s personnel and the penalty. Do NOT state flatly that it "is enforceable in Texas" — say it MAY be enforceable depending on circumstances and should be treated as real risk unless counsel advises otherwise.',
    '10. PAYMENT TERMS. Net-14 is tight for an HOA on a board-approval cycle. Note penalties, interest, attorney-fee shifting, and default/cancellation triggers.',
    '11. EFFECTIVE DATE SANITY. Does the agreement date and the stated start date agree, and is the start date achievable AFTER board approval? A start date before the execution date must be corrected or consciously ratified.',
    'For any point that states a legal conclusion, hedge it to counsel ("treat as real risk unless counsel advises otherwise") rather than telling the board something definitive. End by recommending a redline/requested-changes list to the vendor, and separate the MUST-CHANGE items (that block a recommendation to approve) from the ones you would simply like improved, so the vendor cannot turn it into fifteen rounds over every sentence.',
  ].join('\n');
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
    : docType === 'contract'
    ? contractReviewChecklist()
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
- This document was sent to you FOR REVIEW before it goes further, so treat it as a DRAFT or PROPOSAL, never a signed, executed, or approved record, even if it contains an effective date, a start date, or signature lines. Those are PROPOSED terms for you to assess. Do not assert that it has already been executed, is in force, or was approved or signed without authority. If a proposed effective date is a problem (for example it predates when the board could realistically approve it), say it should be changed BEFORE signing, not that it was already wrongly signed.
- If this is a VENDOR contract or a third party's document (not something a teammate drafted), your job is to flag the terms that expose the association before it goes to the board or to counsel: one sided indemnification, unilateral price increases, auto renewal, termination and liability, and anything missing that the board needs to decide (rates, scope, term). Frame it as what to negotiate or get answered, not as staff error.
- No em-dashes. Use commas.
- Write it as a plain email, the way you would actually type it in Outlook. Do NOT use any markdown: no asterisks for bold (never **like this**), no ## or bold headings, no markdown bullet characters. For a section label (the clause or topic you are discussing), just put it on its own short line in plain words, for example "Indemnification, Section 11.b" then the paragraph underneath. A simple numbered list (1., 2., 3.) is fine for a short set of next steps or questions. It must read like a person wrote it, not like a formatted document or an AI output. Separate sections with a blank line, nothing else.
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
The findings array must list every problem you raise in the body, and nothing you do not raise.
RULE IDS BELONG ONLY IN THE findings ARRAY. Never write a rule id in the body — not in
brackets, not in parentheses, not anywhere. Martha reads the body; a tag like
[no_gl_codes] is internal machinery and reads as debug output in an email to a colleague.`;

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
        // Strip any rule id that leaked into the prose. The model is asked not
        // to, but 'asked not to' is not a control and this goes to a person.
        // A bracketed or parenthesised snake_case token is always a rule id —
        // real prose does not contain "[no_gl_codes]". Ordinary parentheses
        // survive because they contain spaces or capitals.
        body = j.body.trim()
          .replace(/\s*[[(]\s*[a-z][a-z0-9_]{4,}\s*[\])]/g, '')
          // Strip markdown so the email reads like a person typed it, not an AI
          // thread: bold markers, ATX headings, and leading bullet stars (a
          // literal ** or * survives into Outlook and looks like debug output).
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/__([^_]+)__/g, '$1')
          .replace(/^\s{0,3}#{1,6}\s+/gm, '')
          .replace(/^\s*[*•]\s+/gm, '')
          .replace(/\*/g, '')
          .replace(/[^\S\n]+\n/g, '\n')
          .replace(/[^\S\n]{2,}/g, ' ')
          .trim();
        findings = Array.isArray(j.findings) ? j.findings : [];
        fixedSince = Array.isArray(j.fixed_since_last) ? j.fixed_since_last : [];
      }
    } catch (_) {
      console.warn('[amanda_review] model did not return JSON — review still usable, no memory recorded');
    }

    // ADVERSARIAL SECOND PASS. One generation misses things — her first contract
    // review caught the indemnification but dropped a renewal contradiction
    // between two sections, and stated a legal conclusion too categorically
    // (Ed 2026-09-01). A critic re-reads the DOCUMENT against her draft, finds
    // what was missed, what is overstated, and any internal contradiction she
    // did not flag, then rewrites the review complete and properly hedged.
    // Best-effort: any failure keeps the first-pass review (never worse).
    try {
      const criticPrompt = `You are a second senior reviewer at Bedrock, checking a colleague's review of a document before it reaches the operator. Make the review COMPLETE and DEFENSIBLE without changing its voice.

Do three things:
1. MISSES. Add anything material in the document the review did not raise: a clause, a risk, a referenced-but-missing exhibit, and especially an internal CONTRADICTION between two sections (compare term, renewal, termination, and liability clauses against each other by section number).
2. OVERSTATEMENTS. Soften any statement that is too categorical, above all a legal conclusion stated as fact. Rewrite it to "may be X depending on the circumstances, treat as real risk unless counsel advises otherwise."
3. KEEP every valid point already in the draft. Never drop a finding to shorten it.

Order the points by consequence. Where it helps, separate the MUST-CHANGE items that block a recommendation to approve from the ones to simply improve.
${docType === 'contract' ? '\nCHECK THE DRAFT AGAINST THIS CONTRACT CHECKLIST and add every item it missed:\n' + standards + '\n' : ''}
THE DOCUMENT
"""
${doc.text.slice(0, 12000)}
"""

THE DRAFT REVIEW (keep its voice exactly: plain email, no markdown, no asterisks, no headings, sign off as "Amanda")
"""
${body}
"""

Return STRICT JSON, no code fences, shaped exactly:
{"findings":[{"rule_id":"general","severity":"blocking|should_fix|minor","note":"<8 words max>"}],"body":"<the complete improved review email>"}
The findings array must list every problem raised in the body. Never write a rule id in the body.`;
      const cr = await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 2600, messages: [{ role: 'user', content: criticPrompt }] });
      const craw = String(cr.content?.[0]?.text || '').trim();
      if (craw) {
        const cj = JSON.parse(craw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
        // Only accept the revision if it is at least as substantial as the draft,
        // so a truncated or lazy second pass can never shrink the review.
        if (cj && typeof cj.body === 'string' && cj.body.trim().length >= body.length * 0.9) {
          body = cj.body.trim()
            .replace(/\s*[[(]\s*[a-z][a-z0-9_]{4,}\s*[\])]/g, '')
            .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1')
            .replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s*[*•]\s+/gm, '').replace(/\*/g, '')
            .replace(/[^\S\n]+\n/g, '\n').replace(/[^\S\n]{2,}/g, ' ').trim();
          if (Array.isArray(cj.findings) && cj.findings.length >= findings.length) findings = cj.findings;
        }
      }
    } catch (e) { console.warn('[amanda_review] second pass skipped:', e.message); }

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
