// ============================================================================
// lib/board_package/paige_annual_meeting.js — an annual meeting is not a
// monthly board meeting.
// ----------------------------------------------------------------------------
// Ed 2026-08-21: "ok but martha asked for help with annual meeting and online
// voting but paige did monthly board package."
//
// He is right, and this was the real miss — bigger than the attachments.
//
// Martha wrote:
//
//     Annual meeting is coming up for Lakes of Pine Forest. One position is
//     open. Please create a board packet for and help me create the timeline.
//     I also need to set up online voting.
//
// Three asks. Paige answered a fourth question nobody asked: she ran the
// readiness engine, which has exactly ONE section list, and that list is a
// MONTHLY board meeting — draft agenda, prior open-session minutes, action
// items, AR aging, AP approval, management report. The word "annual" does not
// appear anywhere in board_package/engine.js.
//
// So Martha was told "no finalized prior minutes on record" (the prior ANNUAL
// minutes were attached to her email), and heard nothing at all about the
// timeline or online voting.
//
// An annual meeting is a different artifact with a statutory spine:
//
//     call for nominations -> nominations close -> candidates set ->
//     notice + ballot mailed (Texas Property Code 209.0056) -> meeting
//
// and its package is notice, candidates, ballot and proxy, sign-in and quorum,
// prior ANNUAL minutes. Financial statements are optional supporting material,
// not the substance.
//
// EVERY PIECE ALREADY EXISTED. letter.js writes the call for nominations,
// annual_meeting_notice.js writes the notice, meeting_calendar.js computes the
// statutory dates, paper_form.js prints the paper nomination form, and the
// bedrock-vote bridge runs the online election. Nothing here is new capability.
// This is the part that knew which question was being asked.
//
// AND IT ANSWERS ALL THREE. Ed's standing rule is that the AI team asks for what
// it needs; the corollary is that it must not silently drop what it was asked
// for. Anything Paige cannot do herself is named, with who does it, rather than
// left out and hoped over.
// ============================================================================
const { buildMeetingCalendar } = require('../nominations/meeting_calendar');

// Is this about the ANNUAL meeting rather than a monthly board meeting?
//
// Deliberately generous on the annual side. Getting this wrong in the monthly
// direction is what already happened, and it produced a confidently wrong
// answer; getting it wrong the other way produces an annual checklist for a
// monthly meeting, which a manager spots in a second.
function isAnnualMeeting(text) {
  const t = String(text || '').toLowerCase();
  if (/\bannual\s+(meeting|membership\s+meeting)\b/.test(t)) return true;
  if (/\bmembership\s+meeting\b/.test(t)) return true;
  // Elections only happen at the annual meeting.
  if (/\b(call\s+for\s+nominations?|nominations?|ballot|proxy|candidates?)\b/.test(t)
      && /\b(meeting|election|seat|position|director)\b/.test(t)) return true;
  return false;
}

// What Martha asked for, beyond the package itself. Named so the reply can
// answer each one instead of dropping the ones the package path does not cover.
function asksIn(text) {
  const t = String(text || '').toLowerCase();
  return {
    package: /\b(packet|package|board\s*book)\b/.test(t),
    timeline: /\b(timeline|schedule|calendar|dates|when\b)/.test(t),
    voting: /\b(online\s+voting|electronic\s+voting|e-?voting|vote\s+online|ballot)\b/.test(t),
    nominations: /\bnominat/.test(t),
    notice: /\bnotice\b/.test(t),
  };
}

// The annual meeting package. Not the monthly list.
//
// `owner` matters as much as the label: Ed's rule is that the platform routes
// work to whoever owns it rather than handing a manager a list of everything.
const ANNUAL_SECTIONS = [
  { key: 'call_for_nominations', label: 'Call for nominations', owner: 'paige', native: true,
    ready: (s) => !!s.cycle, why: 'no nomination cycle yet' },
  { key: 'candidates', label: 'Candidate list and bios', owner: 'paige', native: true,
    ready: (s) => s.nominationCount > 0, why: 'no nominations received yet' },
  { key: 'notice', label: 'Notice of annual meeting (§209.0056)', owner: 'paige', native: true,
    ready: (s) => !!s.cycle, why: 'needs the cycle before it can be generated' },
  { key: 'ballot', label: 'Ballot and proxy', owner: 'paige', native: true,
    ready: (s) => s.nominationCount > 0, why: 'needs the candidate list first' },
  { key: 'signin', label: 'Sign-in sheet and quorum tracking', owner: 'paige', native: true,
    ready: (s) => !!s.cycle, why: 'generated from the roster once the cycle is set' },
  { key: 'prior_annual_minutes', label: 'Prior annual meeting minutes', owner: 'manager', native: false,
    ready: (s) => s.hasPriorAnnualMinutes, why: 'not on file' },
  { key: 'roster', label: 'Member roster and voting eligibility', owner: 'accounting', native: true,
    ready: (s) => s.propertyCount > 0, why: 'no properties on file' },
  { key: 'financials', label: 'Year-end financials for the membership', owner: 'accounting', native: true,
    ready: () => true, why: '' },
];

/**
 * Where the ANNUAL meeting stands, and what each of Martha's asks gets.
 *
 * Reads only. Nothing is created here — the same rule the nominations path
 * follows, because creating a cycle publishes a public nomination page and a
 * wrong seat count must never exist at that URL even briefly.
 */
async function annualMeetingStatus({ supabase, community, requestText }) {
  const asks = asksIn(requestText);

  const { data: cycles, error: cErr } = await supabase.from('nomination_cycles')
    .select('*').eq('community_id', community.id)
    .order('annual_meeting_date', { ascending: false }).limit(5);
  if (cErr) console.warn('[paige_annual] cycle lookup failed:', cErr.message);
  const cycle = (cycles || []).find((c) => c.status === 'open') || (cycles || [])[0] || null;

  let nominationCount = 0;
  if (cycle) {
    const { count, error } = await supabase.from('nominations')
      .select('id', { count: 'exact', head: true }).eq('cycle_id', cycle.id);
    if (!error) nominationCount = count || 0;
  }

  const { count: propertyCount } = await supabase.from('properties')
    .select('id', { count: 'exact', head: true }).eq('community_id', community.id);

  // Prior ANNUAL minutes, not last month's board minutes. This is the item
  // Martha was told was missing while she had it attached.
  let hasPriorAnnualMinutes = false;
  try {
    const { data: mins, error } = await supabase.from('library_documents')
      .select('id, title').eq('community_id', community.id)
      .ilike('title', '%annual%').limit(5);
    if (!error) hasPriorAnnualMinutes = (mins || []).some((m) => /minutes/i.test(m.title || ''));
  } catch (_) { /* best-effort */ }

  const state = { cycle, nominationCount, propertyCount: propertyCount || 0, hasPriorAnnualMinutes };
  const sections = ANNUAL_SECTIONS.map((s) => ({
    key: s.key, label: s.label, owner: s.owner, native: s.native,
    ready: !!s.ready(state), why: s.ready(state) ? null : s.why,
  }));

  const calendar = cycle && cycle.annual_meeting_date
    ? buildMeetingCalendar(cycle.annual_meeting_date, {})
    : null;

  return { asks, cycle, calendar, sections, ...state };
}

module.exports = { isAnnualMeeting, asksIn, annualMeetingStatus, ANNUAL_SECTIONS };
