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
    '1. INDEMNIFICATION / LIABILITY ALLOCATION. Who indemnifies whom, and for whose negligence? A clause where the association indemnifies the vendor for the VENDOR\'s own negligence or alleged misconduct is the single most serious problem — quote it and flag it must-change (mutual, or each party covers its own negligence). Note that Texas applies an "express negligence" doctrine to indemnity for one\'s own negligence, so this kind of language may be enforceable as written; treat it as a real risk and flag it plainly.',
    '2. LIMITATION OF LIABILITY / WAIVERS. Does the vendor cap its liability to gross negligence / willful misconduct while the association waives ordinary-negligence remedies? Any near-impossible condition on recovery (e.g. theft recovery requiring a criminal CONVICTION)? The association may be buying a service and waiving the remedy if it fails.',
    '3. TERM, RENEWAL, AND TERMINATION — CHECK FOR CONTRADICTIONS. Compare EVERY term/renewal/termination clause against each other. Month-to-month vs automatic annual renewal in two different sections is a real conflict that changes exit rights. Confirm the association has a clean right to terminate on notice (ideally without cause). Flag any conflict explicitly by section.',
    '4. CLIENT-DIRECTION / SUPERVISION LIABILITY. Does a clause make the association liable if it "directs," "alters policies," or "assumes supervision"? For an HOA this is a trap — staff WILL tell an officer where to patrol or what to watch, and the vendor could recast routine direction as "assuming supervision" to shift liability. Push to narrow it so ordinary service direction does not transfer responsibility for the vendor\'s personnel.',
    '5. MISSING EXHIBITS / INCORPORATED-BY-REFERENCE TERMS. Does the contract reference an Exhibit (rates, schedule) or "policies and rules" that are not attached? The board cannot approve what it cannot see. Flag every referenced-but-absent exhibit as must-have.',
    '6. SCOPE OF WORK. Are the actual duties defined (post orders, patrols, access control, reporting), or left to something outside the agreement? Undefined scope means nothing to hold the vendor to.',
    '7. PRICING / RATE CHANGES. Can the vendor raise rates unilaterally? Any open-ended trigger ("inflationary trends", "any legislation")? Push for a fixed rate or a capped, index-tied increase with notice.',
    '8. INSURANCE. Are specific limits stated, or just "as required by law" (which can be little)? Recommend specific minimums and the association named as additional insured, plus a current COI.',
    '9. NON-SOLICIT / NO-HIRE + LIQUIDATED DAMAGES. Note any restriction on hiring the vendor\'s personnel and the penalty. Do NOT state flatly that it "is enforceable in Texas" — say it MAY be enforceable depending on circumstances and should be treated as a real risk.',
    '10. PAYMENT TERMS. Net-14 is tight for an HOA on a board-approval cycle. Note penalties, interest, attorney-fee shifting, and default/cancellation triggers.',
    '11. EFFECTIVE DATE SANITY. Does the agreement date and the stated start date agree, and is the start date achievable AFTER board approval? A start date before the execution date must be corrected or consciously ratified.',
    'For any point that touches the law, give your professional read but keep it non-definitive: say a clause "may be" enforceable rather than "is", and never state a settled legal conclusion. Reviewing agreements like this is part of our management service, so do NOT refer the board to outside counsel. End by recommending a redline/requested-changes list to the vendor, and separate the MUST-CHANGE items (that block a recommendation to approve) from the ones you would simply like improved, so the vendor cannot turn it into fifteen rounds over every sentence.',
    'REQUIRED DISCLAIMER. You are a community manager, not an attorney, and this review must never read as legal advice. Include one short, plain sentence near the top (right after the opening) making clear this is your professional assessment of the agreement as the community manager and is not legal advice. Do not call it "business advice," and do NOT refer the board to outside counsel (reviewing agreements like this is part of our service). Keep it in your own voice, no disclaimer-boilerplate tone, and do not repeat it more than once.',
    'SIGN-OFF. End the body with a short closing and your first name only ("Amanda"). Do NOT type your full name, your title, or "Bedrock Association Management" as a sign-off — the email signature block adds all of that, and repeating it reads as a doubled signature.',
  ].join('\n');
}

// A document that comes back a second time is usually a REVISION of one Amanda
// already reviewed (the Canyon Gate / UPS contract came back as
// "...Contract RL.docx" after the board president incorporated her input —
// Ed 2026-09-01). Reviewing it cold restates issues that were already fixed and
// misses whether the CHANGES actually resolved what she raised. To recognise a
// revision we reduce a filename to a stable FAMILY KEY by stripping the version
// tokens people append (RL, redline, rev, v2, final, clean, dates, "(1)").
function _docFamilyKey(filename) {
  let s = String(filename || '').toLowerCase();
  s = s.replace(/\.(docx?|pdf|xlsx?)$/i, '');
  s = s.replace(/[_\-\s]*\(?\d+\)?$/,''); // trailing "(1)" / " 2"
  // strip version/status tokens anywhere (word-bounded)
  s = s.replace(/\b(rl|red[\s_-]?line|redlined?|rev(?:ised|ision)?|draft|final|clean|updated?|marked?[\s_-]?up|markup|v\d+|version\s*\d+)\b/gi, ' ');
  // strip leading date prefixes like 09012026 / 2026-09-01 / 9-1-26
  s = s.replace(/\b\d{6,8}\b/g, ' ').replace(/\b\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\b/g, ' ');
  return s.replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

// Find the most recent prior Amanda review of the SAME document family (a
// different file whose family key matches), so a revision can be assessed
// against what she said last time. Uses the stored reply_body as the baseline
// (it names every section and quote), so no re-fetch of the old file is needed.
// Prefers a same-community match; falls back to family key alone (the key is
// specific enough — "ups canyon gate contract" — that cross-community collisions
// are unlikely). Includes UNSENT prior reviews on purpose: the point is "did the
// revision fix what we raised", which holds whether or not the prior note was
// mailed. (This is the opposite of loadPriorReviews, which only counts SENT
// feedback for the recurrence memory.)
async function findPriorReviewForRevision({ docType, filename, communityId }) {
  const family = _docFamilyKey(filename);
  if (!family || family.length < 6) return null; // too generic to match safely
  try {
    // Do NOT require the same document_type. An earlier version can have been
    // classified differently (the Canyon Gate original was stored as 'general'
    // before the contract classifier caught it, while the revision is
    // 'contract'). The FAMILY KEY is the reliable identity; match on that.
    const q = _sb().from('staff_document_reviews')
      .select('created_at, document_filename, document_type, findings, reply_body, reply_subject, community_id')
      .eq('reviewer_persona', 'amanda')
      .order('created_at', { ascending: false })
      .limit(50);
    const { data, error } = await q;
    if (error) { console.warn('[amanda_review] revision lookup failed:', error.message); return null; }
    const candidates = (data || [])
      .filter((r) => r.document_filename && r.document_filename !== filename)
      .filter((r) => _docFamilyKey(r.document_filename) === family)
      .filter((r) => r.reply_body && r.reply_body.trim().length > 200);
    if (!candidates.length) return null;
    // Prefer a same-community prior review when we know the community.
    const scoped = communityId ? candidates.filter((r) => r.community_id === communityId) : [];
    return (scoped[0] || candidates[0]);
  } catch (e) { console.warn('[amanda_review] revision lookup failed:', e.message); return null; }
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

// Pull EMBEDDED IMAGES out of a document so the model can read exhibits, rate
// schedules and tables that were pasted in as pictures rather than typed as
// text. mammoth.extractRawText silently drops every image, which is how the
// Canyon Gate / UPS "Exhibit A - Schedule and Rates" (a pasted rate sheet) was
// invisible to Amanda and she wrongly reported it missing (Ed 2026-09-02). This
// is the .docx form of the pdf-parse scar in CLAUDE.md: never trust a text-only
// extractor to tell you what a document contains. Returns Anthropic image
// content blocks, capped so a photo-heavy file cannot blow the request.
async function extractDocImages({ filename, buffer, contentType }, { max = 6, maxBytes = 4 * 1024 * 1024 } = {}) {
  const name = String(filename || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  const out = [];
  try {
    if (name.endsWith('.docx') || ct.includes('wordprocessingml') || name.endsWith('.pptx') || name.endsWith('.xlsx')) {
      const JSZip = require('jszip');
      const z = await JSZip.loadAsync(buffer);
      const media = Object.keys(z.files)
        .filter((n) => /\/media\/.*\.(png|jpe?g|gif|webp)$/i.test(n))
        .sort();
      for (const n of media) {
        if (out.length >= max) break;
        const data = await z.files[n].async('nodebuffer');
        if (!data || !data.length || data.length > maxBytes) continue;
        const ext = (n.match(/\.([a-z0-9]+)$/i) || [])[1].toLowerCase();
        const media_type = ext === 'jpg' ? 'image/jpeg' : 'image/' + ext;
        out.push({ type: 'image', source: { type: 'base64', media_type, data: data.toString('base64') } });
      }
    }
  } catch (e) {
    console.warn('[amanda_review] image extract failed for', filename, e.message);
  }
  return out;
}

/**
 * Review a staff-submitted document and draft a reply to the sender.
 *
 * @returns { draftable, subject, body, docType, reviewed } — draftable false
 *          when this is not a staff document review (so the caller falls
 *          through to the normal homeowner path rather than guessing).
 */
async function draftAmandaDocumentReview({ email, attachments = [], senderFirstName = null, communityId = null }) {
  // Only staff mail. A homeowner emailing amanda@ with a PDF is an escalation,
  // not a review request, and must NOT land here.
  if (!email || !STAFF_DOMAIN.test(String(email.sender_email || ''))) {
    return { draftable: false, reason: 'not_staff_sender' };
  }
  const docs = [];
  for (const a of attachments) {
    const text = await extractText(a);
    const images = await extractDocImages(a);
    // Keep a doc if it has readable text OR embedded images (a contract whose
    // rate schedule is a pasted image still needs reviewing).
    if ((text && text.length > 200) || images.length) docs.push({ filename: a.filename, text: text || '', images });
  }
  if (!docs.length) return { draftable: false, reason: 'no_readable_document' };

  const doc = docs[0];
  const docImages = Array.isArray(doc.images) ? doc.images : [];
  const docType = classifyDocument({ filename: doc.filename, subject: email.subject, text: doc.text });

  // REVISION? If this document is a new version of one Amanda already reviewed,
  // assess the CHANGES against her prior review instead of reviewing it cold.
  const priorRevision = await findPriorReviewForRevision({ docType, filename: doc.filename, communityId });

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

  // WHO she is writing to changes the whole register. A junior manager who sent
  // her own draft gets COACHING (what is right, what to fix, and why). The
  // PRINCIPAL (Ed, the owner) who forwards a document for her assessment gets a
  // senior manager's ANALYSIS, written to be forwarded to the board — never a
  // graded coaching note. Amanda coaching the owner like a junior was exactly
  // wrong (Ed 2026-09-01). This is also how her senior-manager capability is
  // shown to a community: her analysis, attributed to her.
  const OWNER_EMAIL = String(process.env.OWNER_EMAIL || 'egojara@bedrocktx.com').toLowerCase();
  const isPrincipal = String(email.sender_email || '').toLowerCase() === OWNER_EMAIL;

  const audienceFrame = isPrincipal
    ? `The owner of the company has sent you this document for your assessment, and he will forward your analysis to the association's board. This is your senior-manager analysis, written to be shared with a board, not a coaching note.
- Read it with the experienced, skeptical lens of a principal who has reviewed many vendor agreements: how risk and liability are ALLOCATED between the parties, the buried clauses that quietly shift exposure onto the association, the internal contradictions, and what the board actually needs to decide, not just the surface business terms. Catch what a seasoned owner would catch.
- Address the reader directly and professionally as a peer principal. He is NOT a junior you are teaching. Do NOT grade him, do NOT tell him what he "got right", do NOT praise how he handled it, and never say he was correct to escalate or to copy you. Just give the assessment.
- Open with the bottom line in your own voice: your recommendation. For a contract, state plainly whether you would approve it as drafted and the path you recommend.
- Write it so it can be forwarded to the board largely as-is: clear, professional, substantive, no internal chatter, no "let me know how you would like to proceed" in a junior tone. Close with one clean recommendation stated as your professional judgment.`
    : `A community manager on your team has sent you her own draft and asked you to look at it before it goes further. Write her a coaching reply. She is a colleague, inexperienced but not careless, so:
- No greeting formalities beyond "Hi ${first},". No sign-off block, no title, no mention of AI.
- EXPLAIN WHY for every point, so she needs you less next time. Lead by answering her actual question if she asked one.
- Say what she got RIGHT, specifically, quoting the phrase. Only credit words ACTUALLY IN THE DOCUMENT; never praise a correction she has not made yet.`;

  const standardPrompt = `You are Amanda Albright, the Senior Community Manager at Bedrock Association Management. ${audienceFrame}
- Order the problems by consequence. Something that costs money or creates legal exposure comes before a typo.
- This document was sent to you FOR REVIEW before it goes further, so treat it as a DRAFT or PROPOSAL, never a signed, executed, or approved record, even if it contains an effective date, a start date, or signature lines. Those are PROPOSED terms for you to assess. Do not assert that it has already been executed, is in force, or was approved or signed without authority. If a proposed effective date is a problem (for example it predates when the board could realistically approve it), say it should be changed BEFORE signing, not that it was already wrongly signed.
- If this is a VENDOR contract or a third party's document (not something a teammate drafted), your job is to flag the terms that expose the association before it goes to the board or to counsel: one sided indemnification, unilateral price increases, auto renewal, termination and liability, and anything missing that the board needs to decide (rates, scope, term). Frame it as what to negotiate or get answered, not as staff error.
- No em-dashes. Use commas.
- Write it as a plain email, the way you would actually type it in Outlook. Do NOT use any markdown: no asterisks for bold (never **like this**), no ## or bold headings, no markdown bullet characters. For a section label (the clause or topic you are discussing), just put it on its own short line in plain words, for example "Indemnification, Section 11.b" then the paragraph underneath. A simple numbered list (1., 2., 3.) is fine for a short set of next steps or questions. It must read like a person wrote it, not like a formatted document or an AI output. Separate sections with a blank line, nothing else.
- If nothing is wrong, say so plainly and briefly. Do not manufacture findings.
${isPrincipal
  ? '- End with your recommendation and a short closing, then sign off with your first name only ("Amanda"). Do NOT type your full name, title, or company as a sign-off, the branded email signature block adds all of that and repeating it reads as a doubled signature. Never sign with the reader\'s name.'
  : '- End with a short closing line and sign off as "Amanda" and nothing else. Never sign with the recipient\'s name. No title, no company, no AI mention.'}

THE FORWARDED EMAIL (context — who sent it and why)
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

  // COMPARISON MODE. A revised version of a document Amanda already reviewed.
  // Assess the CHANGES against her prior review: what the revision resolved,
  // what it half-resolved and still needs cleaning up, and what it left open —
  // rather than reviewing it cold and restating fixed issues. The reviser is
  // often the board president with the board copied, so it is respectful of the
  // person who made the edits, and it frames the still-open VENDOR terms
  // (indemnification, liability waivers, the vendor's own protective clauses) as
  // items still to be negotiated WITH THE VENDOR, not as the reviser's mistakes,
  // because those require the vendor's agreement to change. (Ed 2026-09-01.)
  const externalRecipients = (Array.isArray(email.recipients) ? email.recipients : [])
    .map((x) => String(x || '').toLowerCase())
    .filter((x) => x && !/@bedrocktx\.com$/i.test(x));
  const boardFacing = isPrincipal || externalRecipients.length > 0 || docType === 'contract';
  const reviserName = String(email.sender_name || '').split(/\s+/)[0] || 'there';
  const comparisonPrompt = `You are Amanda Albright, the Senior Community Manager at Bedrock Association Management.

You reviewed an earlier version of this document and raised a set of issues. A REVISED version has now come back. Your job is to assess the REVISION against your prior review: say what the changes resolved, what they only partly resolved and still need cleaning up, and what they left open. Do not review it cold and do not restate an issue as unaddressed if the new text fixed it.

${boardFacing
  ? `This assessment will be read by the association's board, and the person who made the revisions may be a board member (often the president). So:
- Be respectful of the work the reviser did. Credit what the revision fixed, specifically, before turning to what remains. Never talk down to them, and never imply they did a poor job.
- Some of the open items are the VENDOR's own terms (indemnification, liability caps and waivers, the vendor's protective clauses). The reviser cannot fix those by editing the document, because the vendor must agree. Frame those as items still to be negotiated WITH THE VENDOR before the board adopts the agreement, not as something the reviser missed.
- Write it so the whole board can read it: professional, substantive, no internal chatter. End with a short closing and sign off with your first name only ("Amanda"). Do NOT type your full name, title, or company, the branded signature block adds that and repeating it reads as a doubled signature.`
  : `A teammate revised their own draft after your feedback and wants to know how the new version looks. Write a warm, direct coaching reply.
- Lead with what they fixed, specifically and by name, so they know it landed. Then what still needs work and why.
- Open with "Hi ${reviserName}," and sign off as "Amanda" only. No title, no company, no AI mention.`}

- Order everything by consequence. Money and legal exposure before wording and typos.
- Separate three groups clearly: what the revision resolved, what it partly resolved or introduced as a new problem (a sloppy edit that now reads two ways, a dangling editing note, a contradiction the change created), and what still blocks approval. Introduce each group with a short plain sentence, not a banner.
- Quote the NEW language when a change matters, so the reader can see exactly what moved.
- Treat this as a DRAFT/PROPOSAL still in negotiation, never an executed or approved record, even with dates or signature lines.
- For any legal point, give your professional read but keep it non-definitive (a clause "may be" enforceable, not that it "is"); never state a settled legal conclusion. Reviewing agreements like this is part of our service, so do NOT refer the board to outside counsel.
- CRITICAL FORMATTING. This must read like an email a person typed in Outlook, not a formatted memo or report. Open with a direct greeting to the reader (for a board thread, "Hugh, and board members,"; for a teammate, "Hi ${reviserName},") and then your bottom line in the first two sentences. Do NOT add a document title, and do NOT add a memo header block of any kind: no "To:", no "From:", no "Re:", no "Date:" lines. Do NOT use ALL-CAPS section banners. A clause label goes on its own short line in plain mixed-case words ("Indemnification, Section 11.b") with the paragraph beneath it. No markdown at all: no asterisks, no ## or bold headings, no markdown bullets. No em-dashes, use commas. A simple numbered list (1., 2., 3.) is fine only for the closing next-steps.
- End with one clear recommendation for the board (what to send back to the vendor / what still has to happen before adoption) and offer to prepare the next redline. If everything you raised is resolved, say so plainly and recommend it can proceed. Sign off exactly as instructed above and nothing after the signature.

YOUR PRIOR REVIEW (the earlier version you assessed: ${priorRevision ? priorRevision.document_filename : ''})
"""
${priorRevision ? String(priorRevision.reply_body || '').slice(0, 8000) : ''}
"""

THE REVISED DOCUMENT NOW IN FRONT OF YOU: ${doc.filename}
"""
${doc.text.slice(0, 12000)}
"""

THE COVERING EMAIL (who sent the revision and what they asked)
Subject: ${email.subject || '(no subject)'}
${String(email.body_full || email.body_preview || '').slice(0, 1000)}

STANDARDS (still apply to the revised text)
${standards}

RETURN STRICT JSON, no code fences, shaped exactly:
{"findings":[{"rule_id":"general","severity":"blocking|should_fix|minor","note":"<8 words max>"}],"body":"<the reply email body>"}
The findings array lists only what STILL needs action (open or cleanup), not what is resolved. Never write a rule id in the body.`;

  let prompt = priorRevision ? comparisonPrompt : standardPrompt;

  // If the document carries embedded images (exhibits/schedules/rate tables
  // pasted as pictures), tell the model they ARE part of the document and are
  // attached below, so it reads them instead of reporting a referenced exhibit
  // as missing (the Canyon Gate Exhibit A miss, Ed 2026-09-02).
  if (docImages.length) {
    prompt += `\n\nATTACHED IMAGES. This document includes ${docImages.length} embedded image(s) that are NOT in the DOCUMENT text above, because they were pasted in as pictures (exhibits, schedules, rate tables, signature pages). They are attached to this message as images. Read them as part of the document. If the text references an exhibit (for example "See Exhibit A for Schedule and Rates") and an image is attached, that image IS the exhibit, so review its contents and do NOT report it as missing or not attached.`;
  }
  // Build the user content: text prompt plus any embedded images as vision blocks.
  const userContent = docImages.length ? [{ type: 'text', text: prompt }, ...docImages] : prompt;

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const r = await client.messages.create({
      model: 'claude-sonnet-4-5',
      // A thorough contract analysis (checklist + full email body) runs long;
      // 1800 truncated the JSON mid-body, which fell back to storing the raw JSON
      // (Ed 2026-09-01). Give it room.
      max_tokens: 4000,
      messages: [{ role: 'user', content: userContent }],
    });
    const raw = String(r.content?.[0]?.text || '').trim();
    if (!raw) return { draftable: false, reason: 'empty_draft' };

    // Prefer the structured shape; a model that answers in prose anyway still
    // produces a usable review, it just contributes no memory for next time.
    let findings = [], fixedSince = [], body = raw;
    // Salvage the body if strict JSON.parse fails (a long body with quotes or a
    // truncated tail) — pull the "body" field so a person never sees raw JSON.
    const salvageBody = (s) => {
      const m = s.match(/"body"\s*:\s*"([\s\S]*?)"\s*[},]\s*$/) || s.match(/"body"\s*:\s*"([\s\S]*)$/);
      if (!m) return null;
      let t = m[1].replace(/"\s*}\s*$/, '');
      try { t = JSON.parse('"' + t.replace(/"/g, '\\"').replace(/\\\\"/g, '\\"') + '"'); } catch (_) {
        t = t.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '  ').replace(/\\\\/g, '\\');
      }
      return t.trim();
    };
    try {
      let parsed = null;
      try { parsed = JSON.parse(raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()); }
      catch (_) { const sb = salvageBody(raw); if (sb) parsed = { body: sb, findings: [] }; }
      const j = parsed;
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
      const criticPrompt = priorRevision
        ? `You are a second senior reviewer at Bedrock, checking a colleague's assessment of a REVISED document before it reaches the operator. The assessment compares a revised version against a prior review. Make it COMPLETE and ACCURATE without changing its voice.

Do these things:
1. VERIFY THE CALLS. For each point in the prior review, confirm the assessment correctly classifies it as resolved, partly resolved/cleanup, or still open, by checking the REVISED DOCUMENT text. If the revised text actually fixed something the assessment still lists as open, correct it. If it lists something as resolved that the revised text did NOT fix, correct that too.
2. NEW PROBLEMS. Add anything the REVISION introduced or newly broke: an edit that now reads two ways, a dangling editing note left in the text, a contradiction the change created between sections.
3. OVERSTATEMENTS. Soften any legal conclusion stated as fact to "may be X depending on the circumstances, treat as a real risk." Do not add a referral to outside counsel.
4. Do NOT re-flag an issue the revised text genuinely resolved, and do NOT drop a still-open point to shorten it. Keep the resolved / cleanup / still-open structure and the respectful, board-appropriate tone.

Order everything by consequence.
${docType === 'contract' ? '\nThe prior review and contract checklist are the baseline of what to verify:\n' + standards + '\n' : ''}
YOUR PRIOR REVIEW (the earlier version)
"""
${String(priorRevision.reply_body || '').slice(0, 8000)}
"""

THE REVISED DOCUMENT
"""
${doc.text.slice(0, 12000)}
"""`
        : `You are a second senior reviewer at Bedrock, checking a colleague's review of a document before it reaches the operator. Make the review COMPLETE and DEFENSIBLE without changing its voice.

Do three things:
1. MISSES. Add anything material in the document the review did not raise: a clause, a risk, a referenced-but-missing exhibit, and especially an internal CONTRADICTION between two sections (compare term, renewal, termination, and liability clauses against each other by section number).
2. OVERSTATEMENTS. Soften any statement that is too categorical, above all a legal conclusion stated as fact. Rewrite it to "may be X depending on the circumstances, treat as a real risk." Do not add a referral to outside counsel.
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
The findings array must list every problem raised in the body. Never write a rule id in the body.${docImages.length ? '\nEMBEDDED IMAGES (exhibits/schedules pasted as pictures) are attached below and are part of the document; read them. If the text references an exhibit and an image is attached, that image IS the exhibit, do not report it missing.' : ''}`;
      const criticContent = docImages.length ? [{ type: 'text', text: criticPrompt }, ...docImages] : criticPrompt;
      const cr = await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 4000, messages: [{ role: 'user', content: criticContent }] });
      const craw = String(cr.content?.[0]?.text || '').trim();
      if (craw) {
        // Tolerant parse: the critic sometimes prepends a heading like
        // "**SECOND REVIEW**" before the JSON, which broke a strict parse and
        // silently skipped the whole second pass (Ed 2026-09-01). Strip fences,
        // then extract the first {...} object; fall back to body salvage.
        let cj = null;
        const cleaned = craw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
        try { cj = JSON.parse(cleaned); }
        catch (_) {
          const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}');
          if (s >= 0 && e > s) { try { cj = JSON.parse(cleaned.slice(s, e + 1)); } catch (_2) {} }
          if (!cj) { const sb2 = salvageBody(cleaned); if (sb2) cj = { body: sb2, findings: [] }; }
        }
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
      comparison: !!priorRevision,
      priorVersion: priorRevision ? priorRevision.document_filename : null,
    };
  } catch (e) {
    console.warn('[amanda_review] draft failed:', e.message);
    return { draftable: false, reason: e.message };
  }
}

module.exports = { draftAmandaDocumentReview, classifyDocument, extractText, loadPriorReviews, recordReview };
