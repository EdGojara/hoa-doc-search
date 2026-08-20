// ============================================================================
// lib/nominations/request_from_email.js  (Ed 2026-08-19)
// ----------------------------------------------------------------------------
// "Staff email the AI team a meeting date and get the document back."
//
// This is the gathering step. It answers one question: given a community and a
// meeting date, does Paige have everything a legally valid call for nominations
// needs, and if not, exactly what should she ask for?
//
// THE RULE Ed set: the AI team ASKS for what it needs to do its job. It does
// not guess. That distinction matters more here than almost anywhere else in
// the platform, because every field below lands on a statutory notice:
//
//   - a wrong SEAT COUNT puts the wrong number of slots on a ballot, and the
//     election is challengeable
//   - a wrong TIME or LOCATION sends owners to the wrong place, which is
//     effectively disenfranchisement
//   - a wrong TERM misstates what a candidate is volunteering for
//
// So the fields split three ways:
//
//   FROM THE EMAIL   the meeting date. Nothing else is safe to infer from prose.
//   CARRIED FORWARD  time, location, term — stable year to year, and if last
//                    year's cycle has them they are quoted back in the reply so
//                    staff can correct rather than confirm. "Same clubhouse as
//                    last year, correct?" is a better question than silence.
//   DERIVED, THEN    seats open. Computed from board_members term_end dates
//   CONFIRMED        where the platform holds them, then read back for a yes.
//                    Never carried forward from last year, and never used
//                    silently: board data goes stale the moment a director
//                    resigns without telling us, and a wrong seat count makes
//                    the election challengeable. Where terms are missing or no
//                    board is on file, it is asked outright.
//
// The calendar is computed, never asked — see meeting_calendar.js, which
// enforces the Texas Property Code 209.0056 notice window.
// ============================================================================
const { buildMeetingCalendar } = require('./meeting_calendar');

// Fields a call for nominations cannot go out without.
const REQUIRED = ['annual_meeting_date', 'annual_meeting_time', 'annual_meeting_location', 'seats_open', 'term_years'];

const LABEL = {
  annual_meeting_date: 'the annual meeting date',
  annual_meeting_time: 'the meeting start time',
  annual_meeting_location: 'where the meeting will be held',
  seats_open: 'how many Board seats are up for election',
  term_years: 'the term length for those seats',
};


// ---------------------------------------------------------------------------
// SEATS OPEN — derive it, then CONFIRM it. Never silently assume.
// ---------------------------------------------------------------------------
// Ed 2026-08-19: "we should also know which board members seat expire so that
// should be able to be determined each year" — and then, importantly: "Paige
// could send email and verify that she sees 1 open seat and wants to confirm."
//
// Both halves matter. Asking blind when the platform already knows is the
// gatekeeper behaviour we are removing. Using the number silently is worse: a
// wrong seat count puts the wrong number of slots on a ballot and the election
// is challengeable, and the platform's board data goes stale the moment someone
// resigns without telling us.
//
// So: compute, show the working, ask for a yes.
//
// A term counts as expiring AT this meeting if term_end falls within 90 days
// either side of it. Boards are seated at the annual meeting, so a term ending
// 2026-10-13 or 2026-10-31 both belong to an October 2026 meeting, while
// 2027-10-31 plainly does not.
async function deriveSeatsOpen({ supabase, community, meetingDate }) {
  if (!community || !community.id || !meetingDate) return { derivable: false, reason: 'no_community_or_date' };
  const { data, error } = await supabase.from('board_members')
    .select('name, position, term_end, is_active').eq('community_id', community.id);
  if (error) return { derivable: false, reason: 'lookup_failed' };

  const active = (data || []).filter((b) => b.is_active !== false);
  if (!active.length) return { derivable: false, reason: 'no_board_on_file' };

  // If ANY sitting member has no term_end we cannot count what expires. Better
  // to say so than to return a confident number built on partial data.
  const undated = active.filter((b) => !b.term_end);
  if (undated.length) {
    return { derivable: false, reason: 'missing_term_dates', total: active.length, undated: undated.length };
  }

  const meeting = new Date(String(meetingDate).slice(0, 10) + 'T12:00:00Z').getTime();
  const WINDOW = 90 * 86400000;
  const expiring = active.filter((b) => {
    const t = new Date(String(b.term_end).slice(0, 10) + 'T12:00:00Z').getTime();
    return Math.abs(t - meeting) <= WINDOW;
  });

  return {
    derivable: true,
    seats: expiring.length,
    total_seats: active.length,
    expiring: expiring.map((b) => ({ name: b.name, position: b.position, term_end: String(b.term_end).slice(0, 10) })),
  };
}

/**
 * @param {object} args
 *   supabase, community {id,name}, meetingDate 'YYYY-MM-DD',
 *   provided  {}  anything staff stated explicitly in the email
 * @returns {Promise<{ready:boolean, values:object, missing:string[],
 *                     carried:object, calendar:object|null, question:string|null}>}
 */
async function gatherNominationInputs({ supabase, community, meetingDate, provided = {} }) {
  const values = { annual_meeting_date: meetingDate || null };
  const carried = {};

  // Anything staff stated wins over anything remembered.
  for (const k of REQUIRED) {
    if (provided[k] !== undefined && provided[k] !== null && provided[k] !== '') values[k] = provided[k];
  }

  // Last cycle for this community — the source for carried-forward fields.
  let prior = null;
  if (community && community.id) {
    const { data } = await supabase.from('nomination_cycles')
      .select('annual_meeting_time, annual_meeting_location, term_years, annual_meeting_date, accept_electronic, accept_physical_mail, onsite_drop_off, expectations_blurb, floor_nominations_policy')
      .eq('community_id', community.id)
      .order('annual_meeting_date', { ascending: false })
      .limit(1);
    prior = (data && data[0]) || null;
  }

  if (prior) {
    // NOTE the deliberate omission of seats_open. It is not in this list and
    // must never be added to it.
    for (const k of ['annual_meeting_time', 'annual_meeting_location', 'term_years']) {
      if (!values[k] && prior[k] !== null && prior[k] !== undefined && prior[k] !== '') {
        values[k] = prior[k];
        carried[k] = { value: prior[k], from: prior.annual_meeting_date };
      }
    }
  }

  // Seats: derive from who is actually expiring, then confirm. Only fall back
  // to asking when the platform cannot know.
  let seatBasis = null;
  if (values.seats_open === undefined || values.seats_open === null || values.seats_open === '') {
    seatBasis = await deriveSeatsOpen({ supabase, community, meetingDate: values.annual_meeting_date });
    if (seatBasis.derivable) values.seats_open = seatBasis.seats;
  }

  const missing = REQUIRED.filter((k) => values[k] === null || values[k] === undefined || values[k] === '');

  let calendar = null;
  if (values.annual_meeting_date) {
    const c = buildMeetingCalendar(values.annual_meeting_date);
    calendar = c.ok ? c : null;
    // A statutory failure is not a missing field, it is a bad date, and it must
    // surface as a refusal rather than a silent omission.
    if (!c.ok) return { ready: false, values, missing, carried, calendar: null, blocked: c.error, question: null };
  }

  // A derived seat count is never "ready" on its own — it is ready to CONFIRM.
  const needsConfirm = !!(seatBasis && seatBasis.derivable);
  return {
    ready: missing.length === 0 && !needsConfirm,
    needs_confirmation: needsConfirm,
    values, missing, carried, calendar, seat_basis: seatBasis,
    question: missing.length
      ? buildQuestion(missing, carried, community)
      : (needsConfirm ? buildSeatConfirmation(seatBasis, community, values) : null),
  };
}

/**
 * Read the derived seat count back with the reasoning visible, so staff are
 * confirming a fact rather than rubber-stamping a number. Naming the outgoing
 * director is what makes a stale record obvious: "Ron resigned in June" is a
 * reply we get to this and never get to a bare "1 seat".
 */
function buildSeatConfirmation(basis, community, values) {
  const name = (community && community.name) || 'that community';
  const who = (basis.expiring || [])
    .map((b) => `${b.name}${b.position ? ` (${b.position})` : ''}, term ends ${b.term_end}`)
    .join('; ');
  const n = basis.seats;
  if (n === 0) {
    return `I have what I need for the ${name} call for nominations, but none of the ${basis.total_seats} seats on file expire around this meeting, so I would be sending a call for nominations with no seat to fill. Can you check the board terms before I generate it?`;
  }
  return `Ready to generate the ${name} call for nominations. Before I do: I see ${n} of ${basis.total_seats} seats expiring at this meeting — ${who}. Confirm that is right and I will send the letter and the nomination form straight back.`;
}

/** The one short ask. Never a form, never a list of everything. */
function buildQuestion(missing, carried, community) {
  const name = (community && community.name) || 'that community';
  const asks = missing.map((k) => LABEL[k]);
  const askLine = asks.length === 1
    ? asks[0]
    : asks.slice(0, -1).join(', ') + ' and ' + asks[asks.length - 1];

  let out = `I have everything for the ${name} call for nominations except ${askLine}.`;

  // Quote back what is being reused so a stale value gets corrected rather than
  // silently reprinted on a legal notice.
  const carriedKeys = Object.keys(carried);
  if (carriedKeys.length) {
    const bits = carriedKeys.map((k) => `${LABEL[k]} as ${carried[k].value}`);
    out += ` I'm carrying forward ${bits.length > 2 ? bits.slice(0,-1).join(', ') + ' and ' + bits[bits.length-1] : bits.join(' and ')} from last year's meeting — tell me if ${bits.length === 1 ? 'that has' : bits.length === 2 ? 'either has' : 'any of those have'} changed.`;
  }
  out += " Send that over and I'll have the letter and the nomination form back to you.";
  return out;
}

module.exports = { gatherNominationInputs, deriveSeatsOpen, REQUIRED, LABEL };
