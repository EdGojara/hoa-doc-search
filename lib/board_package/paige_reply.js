// ===========================================================================
// board_package/paige_reply.js  (Ed 2026-07-18)
// ---------------------------------------------------------------------------
// Paige's inbound handler. A manager emails paige@ ("build the Lakes of Pine
// Forest board package") → Paige identifies the community, runs the readiness
// engine over live trustEd data, and drafts a REPLY-FIRST response: here's
// where the package stands, here's what's ready and what still needs
// attention, reply "go" and I'll assemble it. Reply-first keeps a human in the
// loop before anything is generated. The draft is queued for review like every
// other agent reply (outbound stays manual).
// ===========================================================================
const { getProfile, financialCutoff, buildReadiness } = require('./engine');
const { nativeContext } = require('./native');
const { detectBoardDocIntent, ingestBoardDocs } = require('./doc_intake');

const BUILD_INTENT = /\b(build|create|assemble|prepare|generate|put\s+together|start|get\s+ready)\b[\s\S]{0,40}\b(board\s*(package|packet|book|meeting)|packet|meeting\s*package)\b/i;

function paigeSignature() {
  return '\n\n— Paige Chandler · board-operations assistant (AI) · Bedrock Association Management'
    + '\nReply "go" and I\'ll assemble the review draft. Want a person instead? Just reply and I\'ll pass you to the team.';
}

async function matchCommunity(text, supabase) {
  const { data: comms } = await supabase.from('communities').select('id, name');
  const low = String(text || '').toLowerCase();
  // longest name first so "Lakes of Pine Forest" beats "Lakes"
  const sorted = (comms || []).slice().sort((a, b) => b.name.length - a.name.length);
  for (const c of sorted) {
    const n = String(c.name || '').toLowerCase();
    if (n && low.includes(n)) return c;
  }
  // token match: every significant word of a community name appears
  for (const c of sorted) {
    const toks = String(c.name || '').toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !['the', 'of', 'at', 'and'].includes(w));
    if (toks.length >= 2 && toks.every((t) => low.includes(t))) return c;
  }
  return null;
}

const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12 };

// Staff write "the annual meeting is October 13" far more often than they write
// 2026-10-13. Handling only ISO and MM/DD/YYYY meant Paige would ask for a date
// staff had already given her, which is exactly the behaviour we are removing.
// A month-name date with no year is read as the next occurrence; the reply
// always echoes the full date back ("Tuesday, October 13, 2026") so a wrong
// year is visible before anything is created. (Ed 2026-08-19.)
function parseMeetingDate(text) {
  const t = String(text || '');
  const iso = t.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];
  const mdy = t.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (mdy) return `${mdy[3]}-${String(mdy[1]).padStart(2, '0')}-${String(mdy[2]).padStart(2, '0')}`;

  const named = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(20\d{2}))?\b/i);
  if (named) {
    const mo = MONTHS[named[1].toLowerCase()];
    const day = Number(named[2]);
    if (!mo || day < 1 || day > 31) return null;
    let year = named[3] ? Number(named[3]) : null;
    if (!year) {
      // No year given: the next time this date occurs, today included.
      const now = new Date();
      year = now.getUTCFullYear();
      const candidate = Date.UTC(year, mo - 1, day, 12);
      if (candidate < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12)) year += 1;
    }
    const dt = new Date(Date.UTC(year, mo - 1, day, 12));
    if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== day) return null; // e.g. Feb 30
    return dt.toISOString().slice(0, 10);
  }
  return null;
}

// Turn intake results into a human confirmation line per doc.
function describeFiled(r) {
  const label = r.docType === 'agenda' ? 'agenda' : 'minutes';
  const when = r.meeting_date ? ` (${r.meeting_date})` : '';
  if (r.already) return `  • ${label}${when} — already on file, nothing changed`;
  if (r.filed) return `  • ${r.title || label}${when} — filed as a draft`;
  return `  • ${r.filename || label} — couldn't file it: ${r.reason || 'unreadable'}`;
}

async function draftPaigeReply({ email, supabase, mailbox }) {
  // Attachment filenames count as part of what the sender said.
  //
  // Martha's request never typed "minutes" or "nominations" — both words were
  // in the FILENAMES ("Call for Nominations LOPF.2026.docx", "Minutes of Annual
  // Meeting LOPF.2025.pdf"). Every detector below reads this string, so all of
  // them declined, and Paige answered with a generic readiness report that
  // listed "no finalized prior minutes on record" while holding the minutes.
  // (Ed 2026-08-21.)
  const text = [email.subject, email.body, email.body_preview]
    .concat(email.attachment_names || [])
    .filter(Boolean).join('\n');
  const senderName = (String(email.sender_name || '').trim().split(/\s+/)[0]) || 'there';
  const isBuild = BUILD_INTENT.test(text) || /\b(readiness|package|packet|board\s*book)\b/i.test(text);
  const community = await matchCommunity(text, supabase);

  // "Add this to [community] minutes/agenda" — file the emailed doc into the
  // native module as a draft, so it's in the platform (and flows into the
  // packet) without anyone opening a screen. Runs BEFORE the build/readiness
  // path so a doc-drop email is never mistaken for a package request.
  // Nominations run BEFORE the doc-intake and package paths: "send me the call
  // for nominations for the October 13 annual meeting" is a produce request,
  // not a document drop, and must not be mistaken for one. (Ed 2026-08-19.)
  try {
    const { handleNominationRequest } = require('../nominations/paige_nominations');
    const nom = await handleNominationRequest({
      email, supabase, community,
      meetingDate: parseMeetingDate(text),
      senderFirstName: senderName,
    });
    if (nom) return nom;
  } catch (e) {
    console.warn('[paige_reply] nominations path failed:', e.message);
  }

  const docIntent = detectBoardDocIntent(text);
  const hasBody = String(email.body_full || email.body || email.body_preview || '').replace(/<[^>]+>/g, '').trim().length > 400;
  if (docIntent.wants && (email.has_attachments || hasBody)) {
    if (!community) {
      return {
        draftable: true, careful: true,
        subject: `Re: ${email.subject || 'board document'}`,
        body: `Hi ${senderName},\n\nHappy to file that — which community are these for? Reply with the community name and I'll add them to the platform.${paigeSignature()}`,
        review_hint: 'Paige: board-doc intake, community not identified',
      };
    }
    const { data: communityRow } = await supabase.from('communities').select('id, name, management_company_id').eq('id', community.id).maybeSingle();
    let ing;
    try {
      ing = await ingestBoardDocs({ email, supabase, mailbox, community: communityRow || community, docTypeHint: docIntent.docTypeHint });
    } catch (e) {
      return { draftable: true, careful: true, subject: `Re: ${email.subject || community.name}`,
        body: `Hi ${senderName},\n\nI hit a problem filing that for ${community.name} and stopped so nothing lands half-done. I've flagged it for the team to sort out.${paigeSignature()}` };
    }
    const filed = ing.results.filter((r) => r.filed);
    const already = ing.results.filter((r) => r.already);
    const failed = ing.results.filter((r) => !r.filed && !r.already);
    if (!ing.attempted || !ing.results.length) {
      return { draftable: true, careful: true, subject: `Re: ${email.subject || community.name}`,
        body: `Hi ${senderName},\n\nI can add that to ${community.name}, but I couldn't find a document — attach it as a PDF (or paste the full text into the email) and send it back, and I'll file it.${paigeSignature()}`,
        review_hint: 'Paige: board-doc intake, no document found' };
    }
    const lines = ing.results.map(describeFiled).join('\n');
    const body = `Hi ${senderName},\n\n`
      + `${filed.length ? `Done — filed into ${community.name} in the platform:` : `Here's what I found for ${community.name}:`}\n${lines}\n\n`
      + (filed.length ? `${filed.length === 1 ? "It's" : "They're"} in as ${filed.length === 1 ? 'a draft' : 'drafts'} for review — open the Minutes / Agenda module to finalize, and ${filed.length === 1 ? 'it' : 'they'} will flow into the ${community.name} board packet automatically.\n\n` : '')
      + (failed.length ? `I couldn't read ${failed.length === 1 ? 'one file' : `${failed.length} files`} — if ${failed.length === 1 ? "it's" : "they're"} a Word doc or a scan, resend as a PDF and I'll get ${failed.length === 1 ? 'it' : 'them'}.\n\n` : '')
      + `Want me to check where the ${community.name} board package stands? Just reply "readiness".`
      + paigeSignature();
    return {
      draftable: true, careful: true,
      subject: `${community.name} — ${filed.length ? `${filed.length} ${filed.length === 1 ? 'document' : 'documents'} filed` : 'board document intake'}`,
      body,
      review_hint: `Paige filed: ${filed.length} new, ${already.length} dup, ${failed.length} failed (${community.name})`,
    };
  }

  // "go"/"yes" reply to a readiness thread → actually build the report now.
  const isGo = /^\s*(go|yes|yep|proceed|assemble|build it|do it|go ahead|please\s+(go|do|build))\b/i.test(String(email.body || email.body_preview || '').trim());
  if (isGo && community) {
    try {
      const { assemblePackage } = require('../../api/board_packets');
      const result = await assemblePackage({ community_id: community.id, meeting_date: parseMeetingDate(text) || undefined });
      const filledList = result.filled.map((f) => `  • ${f.section.replace(/_/g, ' ')}`).join('\n');
      const needList = result.needs.map((n) => `  • ${n.section.replace(/_/g, ' ')} — ${n.reason}`).join('\n');
      const body = `Hi ${senderName},\n\n`
        + `Done — the ${community.name} board package draft is assembled. ${result.filled_count} sections pulled straight from trustEd:\n${filledList}\n\n`
        + (result.needs.length ? `Still open (owners flagged):\n${needList}\n\n` : 'Nothing outstanding.\n\n')
        + `It's in the Board Packets screen as a draft for your review. Once it looks right, an admin approves it to lock the final.`
        + paigeSignature();
      return { draftable: true, careful: true, subject: `${community.name} board package — draft assembled`, body, review_hint: `Paige assembled: ${result.filled_count} filled, ${result.needs.length} open` };
    } catch (e) {
      return { draftable: true, careful: true, subject: `Re: ${email.subject || community.name + ' board package'}`,
        body: `Hi ${senderName},\n\nI ran into a problem assembling the ${community.name} package and stopped so nothing goes out wrong. I've flagged it for the team.${paigeSignature()}` };
    }
  }

  // Not a package request at all → let the generic path handle it.
  if (!isBuild && !community) return { draftable: false };

  if (!community) {
    return {
      draftable: true, careful: true,
      subject: `Re: ${email.subject || 'board package'}`,
      body: `Hi ${senderName},\n\nHappy to put that board package together — which community is it for? Once I know, I'll pull everything trustEd has and send you a readiness snapshot.${paigeSignature()}`,
      review_hint: 'Paige: package request, community not identified',
    };
  }

  const { data: communityRow } = await supabase.from('communities').select('*').eq('id', community.id).maybeSingle();
  const profile = getProfile(communityRow);
  const meetingDate = parseMeetingDate(text) || new Date().toISOString().slice(0, 10);
  const cutoff = financialCutoff(profile, meetingDate);
  const { data: mm } = await supabase.from('meeting_minutes').select('meeting_date')
    .eq('community_id', community.id).order('meeting_date', { ascending: false }).limit(1);
  const priorMeetingDate = mm && mm[0] ? mm[0].meeting_date : null;

  const nat = await nativeContext(supabase, communityRow, cutoff, priorMeetingDate);
  const { summary, items } = buildReadiness(profile, new Map(), { cutoff, priorMeetingDate, native: nat });

  const ready = items.filter((i) => i.validation_status === 'ready');
  const attention = items.filter((i) => i.required && ['missing', 'wrong_period', 'incomplete', 'restricted', 'duplicate'].includes(i.validation_status));
  const readyList = ready.map((i) => i.label).join(', ');
  const attnList = attention.map((i) => `  • ${i.label} — ${i.detail || i.validation_status.replace(/_/g, ' ')} (owner: ${i.owner})`).join('\n');

  const body = `Hi ${senderName},\n\n`
    + `Here's where the ${community.name} board package stands (financials tied to ${cutoff}):\n\n`
    + `${summary.ready} of ${summary.required_total} required sections are ready to assemble straight from trustEd.\n\n`
    + (readyList ? `Ready now: ${readyList}.\n\n` : '')
    + (attention.length
      ? `Still needs attention:\n${attnList}\n\n`
      : `Everything's in place — nothing outstanding.\n\n`)
    + `Reply "go" and I'll assemble the review draft and route the open items to their owners. If the meeting isn't this month, tell me the date and I'll re-check the financial period.`
    + paigeSignature();

  return {
    draftable: true, careful: true,
    subject: `${community.name} board package — ${summary.ready}/${summary.required_total} sections ready`,
    body,
    review_hint: `Paige readiness: ${summary.ready}/${summary.required_total} ready · ${attention.length} need attention`,
  };
}

// matchCommunity is exported for the document-review path, which has to
// resolve the community before it can compare a document against the cycle.
module.exports = { draftPaigeReply, matchCommunityForPaige: matchCommunity };
