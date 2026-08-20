// ============================================================================
// lib/nominations/paige_nominations.js  (Ed 2026-08-19)
// ----------------------------------------------------------------------------
// Staff email Paige a meeting date; Paige emails back the call for nominations.
//
// Two rules Ed set, and both are load-bearing:
//
//   1. ASK FOR WHAT YOU NEED. Never guess a value that lands on a statutory
//      notice. Where the platform can work something out (the seat count from
//      board terms, the whole calendar from the meeting date) it does — and
//      then reads it back for a yes rather than using it silently.
//
//   2. NOTHING IS CREATED BEFORE CONFIRMATION. Creating the cycle publishes a
//      nomination page at a public URL. A wrong seat count must never exist at
//      that URL, even briefly, because a homeowner can hit it. So the first
//      reply only ever asks; the cycle, the letter and the page come on the
//      second pass.
//
// The reply carries the PDF *and* the platform link. The attachment is what
// staff expect; the link is where the artifact actually lives, versioned, with
// the QR code pointing at a live nomination page. A hand-built Word version
// cannot have the second one, which is what makes the platform the easier path
// rather than the mandated one.
// ============================================================================
const { gatherNominationInputs } = require('./request_from_email');
const { renderCallForNominationsHTML } = require('./letter');

// "call for nominations", "nominations letter", "annual meeting ... nominations"
const NOMINATION_INTENT = /\b(call\s+for\s+nominations?|nominations?\s+(letter|packet|notice|form)|open\s+nominations?)\b/i;
const ANNUAL_MEETING_HINT = /\bannual\s+meeting\b/i;

/** Does this email want a call for nominations? */
function detectNominationIntent(text) {
  const t = String(text || '');
  if (NOMINATION_INTENT.test(t)) return true;
  // "annual meeting is October 13" + a nomination word nearby
  return ANNUAL_MEETING_HINT.test(t) && /\bnominat/i.test(t);
}

// Staff confirming the seat count. Their reply quotes Paige's question, so the
// number is usually present in the thread even when they only write "yes".
const AFFIRMATIVE = /\b(yes|yep|confirmed?|correct|that'?s right|looks right|go ahead|proceed|approved?)\b/i;

/** An explicitly stated seat count, e.g. "2 seats are up", "one (1) Director". */
function extractStatedSeats(text) {
  const t = String(text || '');
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
  let m = t.match(/\b(\d{1,2})\s*(?:\(\d{1,2}\)\s*)?(?:board\s+)?(?:seats?|directors?|positions?|vacanc)/i);
  if (m) return Number(m[1]);
  m = t.match(/\b(one|two|three|four|five|six|seven)\s*(?:\(\d{1,2}\)\s*)?(?:board\s+)?(?:seats?|directors?|positions?)/i);
  if (m) return words[m[1].toLowerCase()];
  return null;
}

/**
 * A stated meeting time, e.g. "at 7:00 PM", "6:30pm", "7 PM".
 * TIME ONLY, deliberately. Location is free prose ("the amenity center", "same
 * place as last year") and a mis-parsed address on a statutory notice sends
 * owners to the wrong building. Asking once beats guessing.
 */
function extractStatedTime(text) {
  const m = String(text || '').match(/(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*([ap])\.?m\.?/i);
  if (!m) return null;
  const h = Number(m[1]);
  const mins = m[2] || '00';
  return `${h}:${mins} ${m[3].toLowerCase() === 'a' ? 'AM' : 'PM'}`;
}

/** HTML -> PDF, same launch flags as the other renderers in this codebase. */
async function letterPdf(html) {
  const puppeteer = require('puppeteer');
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    return Buffer.from(await page.pdf({ format: 'Letter', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } }));
  } finally { if (browser) await browser.close(); }
}

/**
 * @returns {Promise<null|{draftable:true, subject:string, body:string,
 *                         attachments?:Array, review_hint:string}>}
 *   null when this email is not a nominations request at all.
 */
async function handleNominationRequest({ email, supabase, community, meetingDate, senderFirstName }) {
  const text = [email.subject, email.body_full, email.body, email.body_preview].filter(Boolean).join('\n');
  if (!detectNominationIntent(text)) return null;

  const first = senderFirstName || String(email.sender_name || '').trim().split(/\s+/)[0] || 'there';
  const sign = '\n\nPaige\nBoard Operations, Bedrock Association Management';

  if (!community) {
    return {
      draftable: true, careful: true,
      subject: `Re: ${email.subject || 'call for nominations'}`,
      body: `Hi ${first},\n\nHappy to put that together — which community is this for? Send me the name and the annual meeting date and I'll take it from there.${sign}`,
      review_hint: 'Paige: nominations request, community not identified',
    };
  }
  if (!meetingDate) {
    return {
      draftable: true, careful: true,
      subject: `Re: ${email.subject || community.name}`,
      body: `Hi ${first},\n\nI can generate the ${community.name} call for nominations. What date is the annual meeting? Everything else I can work out from there, and I'll check anything I'm unsure of before it goes out.${sign}`,
      review_hint: 'Paige: nominations request, no meeting date',
    };
  }

  // Staff may have stated the seat count outright, or be confirming one Paige
  // already proposed. Either way it is THEIR number, not an assumption.
  const stated = extractStatedSeats(text);
  const confirming = AFFIRMATIVE.test(text);
  const provided = {};
  if (stated != null) provided.seats_open = stated;
  const statedTime = extractStatedTime(text);
  if (statedTime) provided.annual_meeting_time = statedTime;

  const g = await gatherNominationInputs({ supabase, community, meetingDate, provided });

  if (g.blocked) {
    return {
      draftable: true, careful: true,
      subject: `Re: ${email.subject || community.name}`,
      body: `Hi ${first},\n\nI can't build a valid calendar around that meeting date. ${g.blocked}\n\nSend me a workable meeting date and I'll generate everything.${sign}`,
      review_hint: 'Paige: nominations blocked on statutory window',
    };
  }

  // ASK. Nothing is created on this pass.
  const mustAsk = g.missing.length > 0 || (g.needs_confirmation && !(confirming || stated != null));
  if (mustAsk) {
    // Warnings are surfaced, never swallowed. A notice that would mail on a
    // Saturday quietly costs two days of a statutory window, and staff can only
    // move the date if somebody tells them. (Ed 2026-08-19.)
    const warn = (g.calendar && g.calendar.warnings && g.calendar.warnings.length)
      ? '\n\nWorth flagging: ' + g.calendar.warnings.join(' ') : '';
    const cal = g.calendar ? '\n\nWorking backwards from the meeting date, the schedule would be:\n'
      + g.calendar.milestones.map((m) => `  ${m.pretty} — ${m.label}`).join('\n') + warn : '';
    return {
      draftable: true,
      subject: `Re: ${email.subject || community.name} call for nominations`,
      body: `Hi ${first},\n\n${g.question}${cal}${sign}`,
      review_hint: `Paige: nominations — asking for ${g.missing.join(', ') || 'seat confirmation'}`,
    };
  }

  // CONFIRMED. Create the cycle, then the documents.
  const slug = `${String(community.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24)}-${String(meetingDate).slice(0, 4)}`;
  const { data: existing } = await supabase.from('nomination_cycles')
    .select('*').eq('community_id', community.id).eq('annual_meeting_date', meetingDate).maybeSingle();

  let cycle = existing;
  if (!cycle) {
    const { data: created, error } = await supabase.from('nomination_cycles').insert({
      management_company_id: community.management_company_id || null,
      community_id: community.id,
      community_name: community.name,
      annual_meeting_date: g.values.annual_meeting_date,
      annual_meeting_time: g.values.annual_meeting_time,
      annual_meeting_location: g.values.annual_meeting_location,
      nominations_open_at: g.calendar.nominations_open_at,
      nominations_close_at: g.calendar.nominations_close_at,
      seats_open: g.values.seats_open,
      term_years: g.values.term_years,
      public_slug: slug,
      status: 'open',
      accept_electronic: true,
      accept_physical_mail: true,
    }).select('*').single();
    if (error) {
      return {
        draftable: true, careful: true,
        subject: `Re: ${email.subject || community.name}`,
        body: `Hi ${first},\n\nI hit a problem creating the ${community.name} nomination cycle and stopped rather than leave it half-made. I've flagged it for the team.${sign}`,
        review_hint: 'Paige: nominations cycle insert failed — ' + error.message,
      };
    }
    cycle = created;
  }

  const html = await renderCallForNominationsHTML(cycle, {});
  let attachments = [];
  try {
    const pdf = await letterPdf(html);
    attachments = [{ filename: `${community.name} Call for Nominations ${String(meetingDate).slice(0, 4)}.pdf`, content: pdf }];
  } catch (e) {
    // The letter still exists in the platform; say so rather than pretend.
    attachments = [];
  }

  const base = process.env.APP_BASE_URL || 'https://app.bedrocktxai.com';
  const cal = g.calendar.milestones.map((m) => `  ${m.pretty} — ${m.label}`).join('\n');
  const body = `Hi ${first},\n\n`
    + `Here's the ${community.name} call for nominations${attachments.length ? ', attached' : ''}. `
    + `It's also in the platform, where it stays versioned and where the QR code on it points:\n`
    + `  ${base}/nominate/${cycle.public_slug}\n\n`
    + `${g.values.seats_open === 1 ? 'One seat' : `${g.values.seats_open} seats`}, ${g.values.term_years}-year term. The schedule:\n${cal}\n\n`
    + `The notice and ballot mail after nominations close — I'll have those ready.`
    + (attachments.length ? '' : `\n\nI couldn't attach the PDF, so use the link above to print it.`)
    + sign;

  return {
    draftable: true,
    subject: `${community.name} — Call for Nominations`,
    body, attachments,
    review_hint: `Paige: nominations generated for ${community.name}, ${g.values.seats_open} seat(s)`,
  };
}

module.exports = { handleNominationRequest, detectNominationIntent, extractStatedSeats, extractStatedTime };
