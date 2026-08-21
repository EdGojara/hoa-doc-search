// ============================================================================
// lib/board_package/paige_doc_review.js — Paige reads what staff actually sent.
// ----------------------------------------------------------------------------
// Ed 2026-08-21: "yes lets build that and if paige can just do one better have
// paige send it to martha. in the future i want paige preparing it, i think
// right now we are just in the transition phase."
//
// Martha prepared "Call for Nominations LOPF.2026.docx" and sent it to paige@
// to be looked at. Paige replied about board-package readiness and never opened
// it. This is the path that opens it.
//
// THE SHAPE, and it matters more than the feature:
//
//   extract  — pull the facts OUT of the staff document with a model
//   validate — compare them IN CODE against what the platform actually holds
//   render   — say what differs, in Ed's voice, with her version attached
//
// The model is used to READ, never to judge. Every finding below is a code-level
// comparison between a value found in the document and a value the platform
// already knows: the cycle's meeting date, the seat count, the statutory
// calendar. A model asked "is this call for nominations correct?" will answer
// confidently and sometimes wrongly, and a wrong nomination deadline is not a
// typo — under Texas Property Code 209.0056 it is a challengeable election.
//
// TRANSITION PHASE. Martha prepares, Paige checks and offers better. The same
// comparison is what lets Paige prepare it herself later: the difference is only
// who writes first, not what is known to be true.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-5';

/** Readable text out of a .docx / .pdf buffer. '' on failure, never throws. */
async function extractText({ filename, buffer, contentType }) {
  const name = String(filename || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  try {
    if (name.endsWith('.docx') || ct.includes('wordprocessingml')) {
      const mammoth = require('mammoth');
      const r = await mammoth.extractRawText({ buffer });
      return String((r && r.value) || '').trim();
    }
    if (name.endsWith('.pdf') || ct.includes('pdf')) {
      const pdf = require('pdf-parse');
      const r = await pdf(buffer);
      return String((r && r.text) || '').trim();
    }
  } catch (e) {
    console.warn('[paige_doc_review] extract failed for', filename, e.message);
  }
  return '';
}

/** Which board document is this? Filename first, then the text itself. */
function classifyDoc(filename, text) {
  const n = String(filename || '').toLowerCase();
  const t = String(text || '').toLowerCase().slice(0, 4000);
  const has = (re) => re.test(n) || re.test(t);
  if (has(/call for nomination|nomination form|nominat/)) return 'call_for_nominations';
  if (has(/minutes/)) return 'minutes';
  if (has(/agenda/)) return 'agenda';
  if (has(/management report/)) return 'management_report';
  if (has(/ballot|proxy/)) return 'ballot';
  return null;
}

const EXTRACT_PROMPT = `You are reading an HOA "call for nominations" that a community manager drafted.
Pull out ONLY what the document actually states. Do not infer, do not correct,
do not fill anything in. If the document does not say it, use null.

Return ONLY this JSON, no prose, no code fence:
{
  "annual_meeting_date": "YYYY-MM-DD or null",
  "annual_meeting_time": "as written, e.g. '6:00 PM', or null",
  "annual_meeting_location": "as written, or null",
  "nominations_close_date": "YYYY-MM-DD or null",
  "nominations_close_time": "as written or null",
  "seats_open": <number or null>,
  "term_years": <number or null>,
  "mentions_how_to_submit": true/false,
  "mentions_eligibility": true/false,
  "mentions_floor_nominations": true/false,
  "association_name": "as written, or null",
  "quoted_dates": ["every date the document states, YYYY-MM-DD"]
}

Rules:
- Report what is ON THE PAGE, even when it looks wrong. Catching a wrong date is
  the entire point, so silently normalising one defeats the exercise.
- A year may be missing from a date. Assume the year of the annual meeting if
  one is stated, otherwise null.`;

async function extractStatedFacts(text) {
  const completion = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 900,
    system: EXTRACT_PROMPT,
    messages: [{ role: 'user', content: String(text).slice(0, 14000) }],
  });
  const raw = completion.content?.[0]?.text || '';
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch (e) { return { _unparsed: cleaned.slice(0, 300) }; }
}

const pretty = (iso) => {
  if (!iso) return null;
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

// Compare the document against what the platform holds. Pure code — every
// finding is a value-to-value comparison, never a model's opinion.
//
// Severity is the whole point of the shape:
//   blocking — the document would mislead an owner about a statutory deadline
//   check    — a real difference a person has to decide about
//   note     — worth mentioning, nothing is wrong
function compareToTruth(said, truth) {
  const F = [];
  const add = (severity, what) => F.push({ severity, what });
  const cal = truth.calendar || {};
  const v = truth.values || {};

  if (said.annual_meeting_date && v.annual_meeting_date && said.annual_meeting_date !== v.annual_meeting_date) {
    add('blocking', `The form gives the annual meeting as ${pretty(said.annual_meeting_date)}. trustEd has ${pretty(v.annual_meeting_date)}.`);
  } else if (!said.annual_meeting_date) {
    add('check', 'The form does not state the annual meeting date.');
  }

  if (said.nominations_close_date && cal.nominations_close_at && said.nominations_close_date !== cal.nominations_close_at) {
    // The one that voids an election. A close date later than the statutory
    // calendar allows leaves too little time to mail notice under 209.0056.
    add('blocking', `Nominations close on ${pretty(said.nominations_close_date)} in the form. The statutory calendar for a ${pretty(v.annual_meeting_date)} meeting closes them ${pretty(cal.nominations_close_at)}, so notice can mail ${pretty(cal.notice_mail_at)} — ${cal.notice_days_before} days ahead, per Texas Property Code 209.0056.`);
  } else if (!said.nominations_close_date) {
    add('blocking', 'The form does not say when nominations close. An owner cannot act on it as written.');
  }

  if (said.seats_open != null && v.seats_open != null && Number(said.seats_open) !== Number(v.seats_open)) {
    add('blocking', `The form says ${said.seats_open} seat${said.seats_open === 1 ? '' : 's'}. trustEd has ${v.seats_open} open.`);
  } else if (said.seats_open == null) {
    add('check', 'The form does not say how many seats are open.');
  }

  if (said.term_years != null && v.term_years != null && Number(said.term_years) !== Number(v.term_years)) {
    add('check', `The form says a ${said.term_years}-year term; the cycle on file is ${v.term_years} years.`);
  }

  if (said.annual_meeting_time && v.annual_meeting_time
      && String(said.annual_meeting_time).replace(/\s/g, '').toLowerCase() !== String(v.annual_meeting_time).replace(/\s/g, '').toLowerCase()) {
    add('check', `Meeting time reads ${said.annual_meeting_time}; the cycle has ${v.annual_meeting_time}.`);
  }
  if (said.annual_meeting_location && v.annual_meeting_location
      && !String(v.annual_meeting_location).toLowerCase().includes(String(said.annual_meeting_location).toLowerCase().slice(0, 18))) {
    add('check', `Location reads "${said.annual_meeting_location}"; the cycle has "${v.annual_meeting_location}".`);
  }

  if (said.mentions_how_to_submit === false) add('check', 'There is no instruction for how to submit a nomination.');
  if (said.mentions_eligibility === false) add('note', 'Eligibility is not stated, so owners cannot tell whether they qualify.');

  // Anything the platform itself is unhappy about, regardless of the document.
  for (const w of (cal.warnings || [])) add('note', w);

  return F;
}

/**
 * Review a board document a staffer sent in.
 *
 * @returns { draftable, subject, body, docType, reviewed, findings, review_hint }
 *          draftable false when this is not a document review, so the caller
 *          falls through rather than guessing.
 */
async function draftPaigeDocReview({ email, attachments = [], supabase, community, senderFirstName = null }) {
  // Staff only. A board member emailing paige@ a PDF is a different
  // conversation, and reviewing their work uninvited is not our place.
  if (!/@bedrocktx\.com$/i.test(String(email.sender_email || ''))) return { draftable: false };
  if (!attachments.length) return { draftable: false };

  // Pick the document worth reviewing. Signature logos are not documents.
  const candidates = attachments.filter((a) => a.isPdf || a.isDoc);
  if (!candidates.length) return { draftable: false };

  let target = null; let text = ''; let docType = null;
  for (const a of candidates) {
    const t = await extractText(a);
    if (!t || t.length < 120) continue;
    const kind = classifyDoc(a.filename, t);
    // A call for nominations is the one we can check hardest, so it wins.
    if (kind === 'call_for_nominations') { target = a; text = t; docType = kind; break; }
    if (!target) { target = a; text = t; docType = kind; }
  }
  if (!target || !text) return { draftable: false };

  const first = senderFirstName || String(email.sender_name || '').trim().split(/\s+/)[0] || 'there';
  const sign = '\n\nPaige\nBoard Operations, Bedrock Association Management';

  // Only the call for nominations gets the full comparison today. Anything else
  // is acknowledged honestly rather than reviewed badly.
  if (docType !== 'call_for_nominations') {
    return {
      draftable: true, docType: docType || 'document', reviewed: target.filename, findings: [],
      subject: `Re: ${email.subject || target.filename}`,
      body: `Hi ${first},\n\nGot ${target.filename} — I've read it and filed it against ${community ? community.name : 'the community'}. I can't check this type against the platform yet, so treat it as filed, not reviewed.${sign}`,
      review_hint: `Paige: filed ${target.filename} (no comparison available for ${docType || 'this type'})`,
    };
  }

  if (!community) {
    return {
      draftable: true, careful: true, docType, reviewed: target.filename, findings: [],
      subject: `Re: ${email.subject || target.filename}`,
      body: `Hi ${first},\n\nI have ${target.filename} but I can't tell which community it's for. Tell me and I'll check it against what we have on file.${sign}`,
      review_hint: 'Paige: doc review, community not identified',
    };
  }

  // What the platform holds. This is the yardstick.
  const { gatherNominationInputs } = require('../nominations/request_from_email');
  const { data: cycles } = await supabase.from('nomination_cycles')
    .select('*').eq('community_id', community.id)
    .order('annual_meeting_date', { ascending: false }).limit(5);
  const cycle = (cycles || []).find((c) => c.status === 'open') || (cycles || [])[0] || null;
  const meetingDate = cycle && cycle.annual_meeting_date;
  if (!meetingDate) {
    return {
      draftable: true, careful: true, docType, reviewed: target.filename, findings: [],
      subject: `Re: ${email.subject || target.filename}`,
      body: `Hi ${first},\n\nI've read ${target.filename}, but there's no nomination cycle on file for ${community.name} yet, so I have nothing to check it against. Send me the annual meeting date and I'll set the cycle up and compare.${sign}`,
      review_hint: 'Paige: doc review, no cycle to compare against',
    };
  }

  const truth = await gatherNominationInputs({ supabase, community, meetingDate });
  const said = await extractStatedFacts(text);
  if (said._unparsed) {
    return {
      draftable: true, careful: true, docType, reviewed: target.filename, findings: [],
      subject: `Re: ${email.subject || target.filename}`,
      body: `Hi ${first},\n\nI opened ${target.filename} but couldn't read it cleanly enough to check it properly. Could you send it as a PDF?${sign}`,
      review_hint: 'Paige: doc review, extraction unreadable',
    };
  }

  const findings = compareToTruth(said, truth);
  const blocking = findings.filter((f) => f.severity === 'blocking');
  const checks = findings.filter((f) => f.severity === 'check');
  const notes = findings.filter((f) => f.severity === 'note');

  const cal = truth.calendar || {};
  const v = truth.values || {};
  const schedule = (cal.milestones || []).map((m) => `  ${m.pretty} — ${m.label}`).join('\n');

  let body = `Hi ${first},\n\nI read ${target.filename} against what we have on file for ${community.name}.\n\n`;

  if (!findings.length) {
    body += 'It matches the cycle in trustEd on every point I can check: meeting date, seats, term, and the nomination window. Nothing to change.\n\n';
  } else {
    if (blocking.length) {
      body += `${blocking.length === 1 ? 'One thing needs fixing before this goes out' : `${blocking.length} things need fixing before this goes out`}:\n`;
      blocking.forEach((f) => { body += `  • ${f.what}\n`; });
      body += '\n';
    }
    if (checks.length) {
      body += 'Worth a look:\n';
      checks.forEach((f) => { body += `  • ${f.what}\n`; });
      body += '\n';
    }
    if (notes.length) {
      notes.forEach((f) => { body += `  ${f.what}\n`; });
      body += '\n';
    }
  }

  body += `The schedule I have for a ${pretty(v.annual_meeting_date)} meeting:\n${schedule}\n\n`;

  // Never claim an attachment that is not attached.
  //
  // The first version of this line said "I've attached a version built from the
  // cycle on file". Nothing is attached — the draft goes to the review queue and
  // the reply path does not carry files. A message that says "attached" with
  // nothing attached is the same class of failure as a status that says
  // "✓ coded" without naming the account: it reads as done and is not.
  //
  // What she offers also has to depend on what she found. Telling Martha "use
  // mine instead" when Martha's document is correct on every checkable point is
  // both wrong and annoying, and it is the fastest way to get an assistant
  // ignored. (Ed 2026-08-21: transition phase — Martha prepares, Paige checks.)
  if (!blocking.length && !checks.length) {
    body += `Yours is good to go as written. Say the word and I'll get it out to the owners on ${pretty(cal.nominations_open_at)}.${sign}`;
  } else {
    body += `If you'd rather not edit it, I can generate a replacement straight from the cycle — ${v.seats_open} seat${v.seats_open === 1 ? '' : 's'}, ${v.term_years}-year term, the dates above and the nomination link on it. Say the word and I'll put it together for you to look at.${sign}`;
  }

  return {
    draftable: true,
    careful: blocking.length > 0,
    docType, reviewed: target.filename,
    findings, said, truth: { values: v, calendar: cal },
    cycle_id: cycle.id,
    subject: `Re: ${email.subject || target.filename} — checked against the ${community.name} cycle`,
    body,
    review_hint: `Paige reviewed ${target.filename}: ${blocking.length} blocking · ${checks.length} to check`,
  };
}

module.exports = { draftPaigeDocReview, extractText, classifyDoc, compareToTruth, extractStatedFacts };
