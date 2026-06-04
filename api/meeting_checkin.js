// ============================================================================
// Meeting Check-in API — annual-meeting in-person sign-in
// ----------------------------------------------------------------------------
// Mounted at /api/meeting-checkin.
//
// Reads voter rosters + ballot statuses from the VOTING APP'S SEPARATE
// SUPABASE DB (read-only). Writes attendance + meeting settings to
// trustEd's own DB. The voting database is never written to from here.
//
// Endpoints:
//   GET    /elections                       list active elections from voting DB
//   GET    /elections/:eid/settings         meeting settings (quorum, etc.) for an election
//   PUT    /elections/:eid/settings         create or update meeting settings (admin)
//   GET    /elections/:eid/search?q=...     search voters by name (live from voting DB)
//   GET    /elections/:eid/voter/:vid       full voter detail + current vote status
//   GET    /elections/:eid/status           live quorum + attendance summary
//   GET    /elections/:eid/attendance       full attendance log (chronological)
//   POST   /elections/:eid/checkin          mark a voter as attended
//   PATCH  /attendance/:aid                 update walk-in ballot status or note
//   POST   /elections/:eid/generate-pdf     generate quorum-evidence PDF + archive
//
// Auth: same staff auth as other admin endpoints in trustEd (relies on the
// frontend being served from an authed page; service role used internally).
// ============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { getActingUser, actorDisplayName } = require('./_acting_user');
const PDFDocument = require('pdfkit');
const { BRAND } = require('../lib/brand');

// Draw a 3-tier cornerstone (matching brand SVG) at (x,y) with given height.
// Bedrock master mark — embeds the actual designer-produced PNG from
// public/brand-assets/bedrock-mark-email-2x.png. Ed 2026-06-04: the
// prior path-based render was the "hand-drawn approximation" version
// (brand.js cornerstoneInlineSvg) which looked cartoon-y on the
// quorum-evidence PDF. PDFKit doesn't natively embed SVG, but it
// embeds PNG natively, and the email-2x raster is the canonical
// master mark at 2x resolution — sharper than any vector approximation
// I can draw by hand. If the file is missing, fall through silently
// so the rest of the PDF still ships.
const path = require('path');
const fs = require('fs');
const BEDROCK_MARK_PATH = path.join(__dirname, '..', 'public', 'brand-assets', 'bedrock-mark-email-2x.png');
function drawBedrockMark(doc, x, y, h) {
  try {
    if (!fs.existsSync(BEDROCK_MARK_PATH)) {
      console.warn('[meeting-checkin] brand mark missing at:', BEDROCK_MARK_PATH);
      return;
    }
    doc.image(BEDROCK_MARK_PATH, x, y, { height: h });
  } catch (e) {
    console.warn('[meeting-checkin] mark draw failed:', e?.message);
  }
}

const router = express.Router();

// Bedrock management company id — matches the seed in 001_foundation.sql
// and the constant used in lib/askEdTools.js.
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

// trustEd DB (writes attendance + settings here)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Voting app DB (reads only — publishable/anon key).
// Bedrock's voting platform lives in a separate Supabase project. We never
// write to it from here. The credentials are stored as Render env vars
// and never committed to the repo.
function getVotingClient() {
  const url = process.env.VOTING_SUPABASE_URL;
  const key = process.env.VOTING_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    const err = new Error('Voting app credentials not configured. Set VOTING_SUPABASE_URL and VOTING_SUPABASE_PUBLISHABLE_KEY in Render env.');
    err.code = 'VOTING_DB_NOT_CONFIGURED';
    throw err;
  }
  // No auth.persistSession — service-role-like ephemeral client.
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

// Derive a human-readable vote status from a voters-table row.
function deriveVoteStatus(voterRow) {
  if (!voterRow) return { status: 'unknown', label: 'Unknown', method: null, votedAt: null };
  if (voterRow.token_used) {
    const m = (voterRow.vote_method || '').toLowerCase();
    if (m === 'mail') return { status: 'voted_mail', label: 'Voted by mail', method: 'mail', votedAt: voterRow.token_used_at };
    if (m === 'walkin' || m === 'walk_in') return { status: 'voted_walkin', label: 'Voted walk-in', method: 'walkin', votedAt: voterRow.token_used_at };
    return { status: 'voted_online', label: 'Voted online', method: 'online', votedAt: voterRow.token_used_at };
  }
  return { status: 'not_voted', label: 'Has not voted', method: null, votedAt: null };
}

// Compute quorum math from a count snapshot + settings row.
function computeQuorum({ totalUnits, votedUnits, attendedUnitsNotVoted, threshold }) {
  const present = (votedUnits || 0) + (attendedUnitsNotVoted || 0);
  const required = threshold || 0;
  const met = required > 0 && present >= required;
  const pct = totalUnits > 0 ? (present / totalUnits) * 100 : 0;
  return {
    total_units: totalUnits,
    voted_units: votedUnits,
    attended_not_voted_units: attendedUnitsNotVoted,
    present_units: present,
    required_units: required,
    pct: Number(pct.toFixed(2)),
    quorum_met: met,
    short_by: met ? 0 : Math.max(0, required - present),
  };
}

// Match an attendance row to a voter row (after fetching both arrays).
function indexBy(arr, key) {
  const m = new Map();
  for (const row of arr || []) m.set(row[key], row);
  return m;
}

// ----------------------------------------------------------------------------
// GET /elections — portfolio view of every election across communities,
// joined with meeting_election_settings so each row carries derived status
// (scheduled / live / overdue / finalized), meeting date, and the frozen
// quorum snapshot at finalize time.
//
// Status derivation (in priority order):
//   - 'finalized'  — settings.status == 'finalized' (End Meeting completed)
//   - 'live'       — meeting_date is today (America/Chicago) AND not finalized
//   - 'overdue'    — meeting_date is in the past AND not finalized
//                    (e.g., meeting happened but staff hasn't clicked End
//                    Meeting yet — surfaces what needs finalizing)
//   - 'scheduled'  — meeting_date is in the future
//   - 'unknown'    — no settings row or no meeting_date set
// ----------------------------------------------------------------------------
router.get('/elections', async (req, res) => {
  try {
    const voting = getVotingClient();
    const [electionsRes, settingsRes] = await Promise.all([
      voting.from('elections').select('*').order('start_date', { ascending: false }).limit(100),
      supabase.from('meeting_election_settings').select('*').limit(500),
    ]);
    if (electionsRes.error) throw electionsRes.error;
    if (settingsRes.error) console.warn('[meeting-checkin] settings sidecar fetch failed:', settingsRes.error.message);
    const settingsByEid = new Map();
    for (const s of (settingsRes?.data || [])) {
      if (s.external_election_id) settingsByEid.set(s.external_election_id, s);
    }
    // Today in Central. The simplest reliable form: take 'now' as UTC and
    // shift back to Central via the locale formatter, then compare YYYY-MM-DD.
    const todayCentral = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); // YYYY-MM-DD
    const enriched = (electionsRes.data || []).map((e) => {
      const s = settingsByEid.get(e.election_id) || null;
      const meetingDate = s?.meeting_date || null;
      let meetingStatus = 'unknown';
      if (s?.status === 'finalized') meetingStatus = 'finalized';
      else if (meetingDate) {
        if (meetingDate === todayCentral) meetingStatus = 'live';
        else if (meetingDate < todayCentral) meetingStatus = 'overdue';
        else meetingStatus = 'scheduled';
      }
      return {
        ...e,
        meeting_status: meetingStatus,
        meeting_date: meetingDate,
        meeting_time: s?.meeting_time || null,
        meeting_location: s?.meeting_location || null,
        finalized_at: s?.finalized_at || null,
        finalize_quorum_met: s?.finalize_quorum_met ?? null,
        finalize_present_units: s?.finalize_present_units ?? null,
        finalize_attended_count: s?.finalize_attended_count ?? null,
      };
    });
    // Sort: live first, then scheduled, then overdue, then finalized (most
    // recent finalize at top of that bucket). This makes the active work
    // surface at the top of the portfolio panel.
    const statusRank = { live: 0, scheduled: 1, overdue: 2, finalized: 3, unknown: 4 };
    enriched.sort((a, b) => {
      const r = (statusRank[a.meeting_status] ?? 99) - (statusRank[b.meeting_status] ?? 99);
      if (r !== 0) return r;
      // Tiebreaker: meeting_date ascending for upcoming, descending for past.
      const ad = a.meeting_date || '9999-12-31';
      const bd = b.meeting_date || '9999-12-31';
      if (a.meeting_status === 'finalized' || a.meeting_status === 'overdue') return ad < bd ? 1 : -1;
      return ad < bd ? -1 : 1;
    });
    res.json({ elections: enriched, today_central: todayCentral });
  } catch (err) {
    console.error('[meeting-checkin] /elections failed:', err.message);
    res.status(err.code === 'VOTING_DB_NOT_CONFIGURED' ? 503 : 500)
       .json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /elections/:eid/settings — meeting settings for an election
// ----------------------------------------------------------------------------
router.get('/elections/:eid/settings', async (req, res) => {
  try {
    const eid = req.params.eid;
    const { data, error } = await supabase
      .from('meeting_election_settings')
      .select('*')
      .eq('external_election_id', eid)
      .maybeSingle();
    if (error) throw error;
    res.json({ settings: data || null });
  } catch (err) {
    console.error('[meeting-checkin] settings GET failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// PUT /elections/:eid/settings — create or update meeting settings
// ----------------------------------------------------------------------------
router.put('/elections/:eid/settings', async (req, res) => {
  try {
    const eid = req.params.eid;
    const body = req.body || {};
    if (!body.community_id) return res.status(400).json({ error: 'community_id_required' });
    // Recompute denormalized quorum_threshold_units from percent if both
    // total_voting_units and quorum_threshold_percent are known.
    let thresholdUnits = body.quorum_threshold_units || null;
    if (!thresholdUnits && body.total_voting_units && body.quorum_threshold_percent) {
      thresholdUnits = Math.ceil((Number(body.total_voting_units) * Number(body.quorum_threshold_percent)) / 100);
    }
    const payload = {
      community_id: body.community_id,
      external_election_id: eid,
      community_name: body.community_name || null,
      election_name: body.election_name || null,
      meeting_date: body.meeting_date || null,
      meeting_time: body.meeting_time || null,
      meeting_location: body.meeting_location || null,
      total_voting_units: body.total_voting_units || null,
      quorum_basis: body.quorum_basis || 'all_voters',
      quorum_threshold_percent: body.quorum_threshold_percent || null,
      quorum_threshold_units: thresholdUnits,
      quorum_clause_text: body.quorum_clause_text || null,
      secretary_name: body.secretary_name || null,
      president_name: body.president_name || null,
      parliamentarian_name: body.parliamentarian_name || null,
      created_by_staff: body.created_by_staff || null,
    };
    // Upsert on (community_id, external_election_id) unique constraint
    const { data, error } = await supabase
      .from('meeting_election_settings')
      .upsert(payload, { onConflict: 'community_id,external_election_id' })
      .select()
      .single();
    if (error) throw error;
    res.json({ settings: data });
  } catch (err) {
    console.error('[meeting-checkin] settings PUT failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /elections/:eid/search?q=... — search voters by name OR address OR lot
// ----------------------------------------------------------------------------
// Three-field search via PostgREST or() filter:
//
//   owner_name        — primary lookup ("Smith", "Nguyen")
//   mailing_address   — property-address lookup. NOTE: the voting app only
//                       stores mailing_address, which equals the property
//                       address for owner-occupants (~95% of walk-ins) but
//                       is OFF-property for absentee owners (investors,
//                       LLCs). The proper fix is importing Canyon Gate's
//                       property table into trustEd so we can cross-
//                       reference by lot_number to a real property address
//                       even for absentee owners; that's a separate import
//                       not blocking the Wednesday meeting.
//   lot_number        — Vantaca lot account ID. Useful when staff has the
//                       cheat-sheet or homeowner provides it.
//
// Returns up to 20 matches with vote status + attendance state.
// ----------------------------------------------------------------------------
router.get('/elections/:eid/search', async (req, res) => {
  try {
    const eid = req.params.eid;
    const q = (req.query.q || '').toString().trim();
    if (!q || q.length < 2) return res.json({ voters: [] });

    // Sanitize % and _ which are ILIKE wildcards — we want literal substring
    // match, not pattern injection from user input.
    const safe = q.replace(/[%_]/g, '');
    const orFilter = [
      `owner_name.ilike.%${safe}%`,
      `mailing_address.ilike.%${safe}%`,
      `lot_number.ilike.%${safe}%`,
    ].join(',');

    const voting = getVotingClient();
    const { data: votersRows, error: vErr } = await voting
      .from('voters')
      .select('voter_id, election_id, owner_name, mailing_address, lot_number, vote_weight, token_used, token_used_at, vote_method, entered_by, entered_at')
      .eq('election_id', eid)
      .or(orFilter)
      .order('owner_name')
      .limit(20);
    if (vErr) throw vErr;

    // Pull attendance for those voters from trustEd in one shot
    const voterIds = (votersRows || []).map((v) => v.voter_id);
    let attendanceByVoter = new Map();
    if (voterIds.length > 0) {
      const { data: attRows, error: aErr } = await supabase
        .from('meeting_attendance')
        .select('*')
        .eq('external_election_id', eid)
        .in('external_voter_id', voterIds);
      if (aErr) throw aErr;
      attendanceByVoter = indexBy(attRows, 'external_voter_id');
    }

    // Tag each result with WHICH field matched so the UI can show "matched
    // by lot #" / "matched by address" hints for ambiguous queries.
    const qLower = safe.toLowerCase();
    const voters = (votersRows || []).map((v) => {
      const status = deriveVoteStatus(v);
      const att = attendanceByVoter.get(v.voter_id) || null;
      const matchedFields = [];
      if ((v.owner_name || '').toLowerCase().includes(qLower)) matchedFields.push('name');
      if ((v.mailing_address || '').toLowerCase().includes(qLower)) matchedFields.push('address');
      if ((v.lot_number || '').toLowerCase().includes(qLower)) matchedFields.push('lot');
      return {
        voter_id: v.voter_id,
        owner_name: v.owner_name,
        mailing_address: v.mailing_address,
        lot_number: v.lot_number,
        vote_weight: v.vote_weight || 1,
        matched_fields: matchedFields,
        vote_status: status,
        already_attended: !!att,
        attendance: att,
      };
    });
    res.json({ voters });
  } catch (err) {
    console.error('[meeting-checkin] search failed:', err.message);
    res.status(err.code === 'VOTING_DB_NOT_CONFIGURED' ? 503 : 500)
       .json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /elections/:eid/voter/:vid — full voter detail + status
// ----------------------------------------------------------------------------
router.get('/elections/:eid/voter/:vid', async (req, res) => {
  try {
    const { eid, vid } = req.params;
    const voting = getVotingClient();
    const { data, error } = await voting
      .from('voters')
      .select('*')
      .eq('election_id', eid)
      .eq('voter_id', vid)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'voter_not_found' });

    const { data: att, error: aErr } = await supabase
      .from('meeting_attendance')
      .select('*')
      .eq('external_election_id', eid)
      .eq('external_voter_id', vid)
      .maybeSingle();
    if (aErr) throw aErr;

    res.json({
      voter: data,
      vote_status: deriveVoteStatus(data),
      attendance: att || null,
    });
  } catch (err) {
    console.error('[meeting-checkin] voter detail failed:', err.message);
    res.status(err.code === 'VOTING_DB_NOT_CONFIGURED' ? 503 : 500)
       .json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /elections/:eid/checkin — mark a voter as attended
// ----------------------------------------------------------------------------
// Body: { voter_id, community_id, checked_in_by_staff, note?, walk_in_ballot_status? }
// Walk-in status defaults to:
//   'needed'           if voter has not voted (token_used=false)
//   'not_applicable'   if voter already voted
// ----------------------------------------------------------------------------
router.post('/elections/:eid/checkin', async (req, res) => {
  try {
    // Capture the staff member doing the check-in from the JWT. Optional
    // for now (existing checked_in_by_staff text field still works during
    // transition); after STAFF_PASSWORD is killed, every check-in carries
    // a real FK to user_profiles.
    const actor = await getActingUser(req);

    const eid = req.params.eid;
    const body = req.body || {};
    if (!body.voter_id) return res.status(400).json({ error: 'voter_id_required' });
    if (!body.community_id) return res.status(400).json({ error: 'community_id_required' });

    // Re-fetch the voter (don't trust client-provided snapshot)
    const voting = getVotingClient();
    const { data: voterRow, error: vErr } = await voting
      .from('voters')
      .select('*')
      .eq('election_id', eid)
      .eq('voter_id', body.voter_id)
      .maybeSingle();
    if (vErr) throw vErr;
    if (!voterRow) return res.status(404).json({ error: 'voter_not_found_in_voting_app' });

    const status = deriveVoteStatus(voterRow);
    const walkInDefault = status.status === 'not_voted' ? 'needed' : 'not_applicable';

    // Display name on the quorum-evidence PDF: prefer the authenticated
    // user's profile name (no spoofing possible). Fall back to whatever
    // the client sent in checked_in_by_staff (legacy text path).
    const displayName = actor ? actorDisplayName(actor) : (body.checked_in_by_staff || null);

    const payload = {
      community_id: body.community_id,
      external_election_id: eid,
      external_voter_id: body.voter_id,
      owner_name: voterRow.owner_name,
      lot_number: voterRow.lot_number || null,
      mailing_address: voterRow.mailing_address || null,
      vote_weight: voterRow.vote_weight || 1,
      vote_status_at_checkin: status.status,
      vote_method_at_checkin: voterRow.vote_method || null,
      ballot_cast_at: voterRow.token_used_at || null,
      checked_in_by_staff: displayName,
      acted_by_user_id: actor?.id || null,
      attendance_note: body.attendance_note || body.note || null,
      walk_in_ballot_status: body.walk_in_ballot_status || walkInDefault,
    };

    // Upsert against the unique constraint so re-clicks don't duplicate
    const { data, error } = await supabase
      .from('meeting_attendance')
      .upsert(payload, { onConflict: 'external_election_id,external_voter_id' })
      .select()
      .single();
    if (error) throw error;
    res.json({ attendance: data });
  } catch (err) {
    console.error('[meeting-checkin] checkin failed:', err.message);
    res.status(err.code === 'VOTING_DB_NOT_CONFIGURED' ? 503 : 500)
       .json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// PATCH /attendance/:aid — update walk-in ballot status or note
// ----------------------------------------------------------------------------
const ALLOWED_PATCH_FIELDS = [
  'walk_in_ballot_status', 'walk_in_ballot_entered_by', 'attendance_note',
];
router.patch('/attendance/:aid', async (req, res) => {
  try {
    const actor = await getActingUser(req);
    const aid = req.params.aid;
    const body = req.body || {};
    const patch = {};
    for (const f of ALLOWED_PATCH_FIELDS) {
      if (body[f] !== undefined) patch[f] = body[f];
    }
    // Auto-set walk_in_ballot_entered_at + actor FK when status transitions
    // to 'entered'. Display name on walk_in_ballot_entered_by prefers the
    // authenticated user's profile name over whatever the client typed.
    if (patch.walk_in_ballot_status === 'entered') {
      patch.walk_in_ballot_entered_at = new Date().toISOString();
      if (actor) {
        patch.walk_in_acted_by_user_id = actor.id;
        patch.walk_in_ballot_entered_by = actorDisplayName(actor);
      }
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no_fields_to_update' });

    const { data, error } = await supabase
      .from('meeting_attendance')
      .update(patch)
      .eq('id', aid)
      .select()
      .single();
    if (error) throw error;
    res.json({ attendance: data });
  } catch (err) {
    console.error('[meeting-checkin] attendance PATCH failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /elections/:eid/status — live quorum + attendance summary
// ----------------------------------------------------------------------------
// QUORUM MATH NOTE — under "presence" bylaws (Canyon Gate and most TX HOAs):
//
//   3.4 QUORUM. The presence (in person, by proxy, or by absentee ballot)
//   of N% of the Members shall constitute a quorum...
//
// The key word is PRESENCE, not "votes cast." Three presence categories
// all count toward quorum, deduplicated per voter unit:
//
//   1. Voted absentee (online/mail) — token_used=true on the voter row
//   2. Physically attended — has an attendance row, REGARDLESS of whether
//      they then file a walk-in ballot. Attending a board meeting without
//      voting is still "presence in person" — the law cares about whether
//      they're there, not whether they cast a ballot.
//   3. By proxy — handled via the voting app's proxy intake; for quorum
//      math, a proxy that's been recorded shows up as token_used=true with
//      vote_method='walkin' or similar.
//
// Each voter unit counts ONCE — someone who voted online AND walks in is
// already counted by their absentee ballot; their attendance is evidence
// but doesn't double up the math.
//
// Earlier shipped logic (now fixed) incorrectly required a walk-in ballot
// for attendance to count. That would have undercounted quorum for anyone
// who showed up but declined to vote — contrary to what the bylaws say.
// ----------------------------------------------------------------------------
router.get('/elections/:eid/status', async (req, res) => {
  try {
    const eid = req.params.eid;
    const voting = getVotingClient();

    const { data: voterRows, error: vErr } = await voting
      .from('voters')
      .select('voter_id, vote_weight, token_used, vote_method')
      .eq('election_id', eid);
    if (vErr) throw vErr;

    const totalUnits = (voterRows || []).reduce((s, r) => s + (r.vote_weight || 1), 0);
    const voterById = new Map((voterRows || []).map((r) => [r.voter_id, r]));

    // Vote breakdown (informational — these are absentee ballots cast)
    const votedUnits = (voterRows || []).filter((r) => r.token_used).reduce((s, r) => s + (r.vote_weight || 1), 0);
    const methodCounts = {};
    for (const r of voterRows || []) {
      if (!r.token_used) continue;
      const m = (r.vote_method || 'unknown').toLowerCase();
      methodCounts[m] = (methodCounts[m] || 0) + 1;
    }

    // Attendance from trustEd
    const { data: attRows, error: aErr } = await supabase
      .from('meeting_attendance')
      .select('*')
      .eq('external_election_id', eid);
    if (aErr) throw aErr;

    // Build the PRESENT set — every voter_id who counts toward quorum
    // by any presence method. Deduplicates across absentee + in-person.
    const presentVoterIds = new Set();
    for (const r of voterRows || []) {
      if (r.token_used) presentVoterIds.add(r.voter_id);
    }
    for (const a of attRows || []) {
      if (a.external_voter_id) presentVoterIds.add(a.external_voter_id);
    }
    const presentUnits = [...presentVoterIds].reduce((s, vid) => {
      const v = voterById.get(vid);
      return s + (v?.vote_weight || 1);
    }, 0);

    // Attendance breakdown (informational, doesn't affect quorum math)
    const attendedTotal = (attRows || []).length;
    const attendedUnits = (attRows || []).reduce((s, r) => s + (r.vote_weight || 1), 0);
    const attendedNotVoted = (attRows || []).filter((r) => r.vote_status_at_checkin === 'not_voted');
    const walkInEntered = attendedNotVoted.filter((r) => r.walk_in_ballot_status === 'entered');
    const walkInNeeded  = attendedNotVoted.filter((r) => r.walk_in_ballot_status === 'needed');
    const declined      = attendedNotVoted.filter((r) => r.walk_in_ballot_status === 'declined_to_vote');
    // Attendees who showed up AFTER their absentee ballot was already in
    const attendedAlreadyVoted = (attRows || []).filter((r) => r.vote_status_at_checkin !== 'not_voted');

    // Settings
    const { data: settings } = await supabase
      .from('meeting_election_settings')
      .select('*')
      .eq('external_election_id', eid)
      .maybeSingle();

    const threshold = settings?.quorum_threshold_units || 0;
    const met = threshold > 0 && presentUnits >= threshold;
    const quorum = {
      total_units: totalUnits,
      voted_units: votedUnits,
      attended_units: attendedUnits,
      present_units: presentUnits, // dedup of voted + attended
      required_units: threshold,
      pct: totalUnits > 0 ? Number(((presentUnits / totalUnits) * 100).toFixed(2)) : 0,
      quorum_met: met,
      short_by: met ? 0 : Math.max(0, threshold - presentUnits),
    };

    res.json({
      quorum,
      vote_breakdown: methodCounts,
      attendance: {
        total_checkins: attendedTotal,
        total_units_attended: attendedUnits,
        attended_already_voted: attendedAlreadyVoted.length,
        attended_not_voted: attendedNotVoted.length,
        walk_in_ballots_entered: walkInEntered.length,
        walk_in_ballots_needed: walkInNeeded.length,
        declined_to_vote: declined.length,
      },
      settings,
    });
  } catch (err) {
    console.error('[meeting-checkin] status failed:', err.message);
    res.status(err.code === 'VOTING_DB_NOT_CONFIGURED' ? 503 : 500)
       .json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /elections/:eid/attendance — full chronological attendance log
// ----------------------------------------------------------------------------
router.get('/elections/:eid/attendance', async (req, res) => {
  try {
    const eid = req.params.eid;
    const { data, error } = await supabase
      .from('meeting_attendance')
      .select('*')
      .eq('external_election_id', eid)
      .order('checked_in_at', { ascending: true });
    if (error) throw error;
    res.json({ attendance: data || [] });
  } catch (err) {
    console.error('[meeting-checkin] attendance log failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /elections/:eid/generate-pdf — quorum-evidence PDF + archive
// ----------------------------------------------------------------------------
// Generates the timestamped, signature-block quorum-evidence PDF that
// stands as legal evidence the annual meeting met (or did not meet)
// quorum. Returns the PDF directly. Optionally also archives to
// library_documents.
//
// Body: { archive: true|false (default true) }
// ----------------------------------------------------------------------------
router.post('/elections/:eid/generate-pdf', async (req, res) => {
  // Stage tracker for diagnostic logs — Ed 2026-06-04 saw HTTP 500
  // finalizing Canyon Gate; without staged logging we can't tell which
  // call threw. Each stage updates this string so the catch at the
  // bottom emits exactly where it died.
  let stage = 'init';
  try {
    const eid = req.params.eid;
    const archive = req.body?.archive !== false;
    console.log(`[meeting-checkin] generate-pdf start eid=${eid} archive=${archive}`);

    // Pull everything we need for the report. Wrap each fetch separately
    // so a single bad source doesn't take down the whole endpoint.
    stage = 'init-voting-client';
    const voting = getVotingClient();
    stage = 'fetch-bedrock-vote-data';
    const [electionRes, votersRes, settingsRes, attRes] = await Promise.all([
      voting.from('elections').select('*').eq('election_id', eid).maybeSingle().then((r) => r).catch((e) => ({ error: e })),
      voting.from('voters').select('voter_id, vote_weight, token_used, vote_method').eq('election_id', eid).then((r) => r).catch((e) => ({ error: e })),
      supabase.from('meeting_election_settings').select('*').eq('external_election_id', eid).maybeSingle().then((r) => r).catch((e) => ({ error: e })),
      supabase.from('meeting_attendance').select('*').eq('external_election_id', eid).order('checked_in_at').then((r) => r).catch((e) => ({ error: e })),
    ]);
    if (electionRes.error) {
      console.error('[meeting-checkin] elections fetch error:', electionRes.error.message || electionRes.error);
      throw new Error('elections fetch failed: ' + (electionRes.error.message || 'unknown'));
    }
    if (votersRes.error) {
      console.error('[meeting-checkin] voters fetch error:', votersRes.error.message || votersRes.error);
      throw new Error('voters fetch failed: ' + (votersRes.error.message || 'unknown'));
    }
    if (attRes.error) {
      console.error('[meeting-checkin] attendance fetch error:', attRes.error.message || attRes.error);
      throw new Error('attendance fetch failed: ' + (attRes.error.message || 'unknown'));
    }
    if (settingsRes.error) {
      // Settings is optional — log and continue with null.
      console.warn('[meeting-checkin] settings fetch error (continuing without):', settingsRes.error.message || settingsRes.error);
    }
    const election = electionRes.data;
    const voters = votersRes.data || [];
    const settings = settingsRes?.data || null;
    const attendance = attRes.data || [];
    console.log(`[meeting-checkin] fetched: election=${!!election} voters=${voters.length} settings=${!!settings} attendance=${attendance.length}`);

    if (!election) return res.status(404).json({ error: 'election_not_found', eid });

    // Quorum math (same logic as /status — "presence" basis):
    // Each voter counts once toward quorum if they EITHER voted absentee
    // OR physically attended (regardless of whether they filed a ballot
    // at the meeting). Deduped via voter_id set.
    const totalUnits = voters.reduce((s, r) => s + (r.vote_weight || 1), 0);
    const votedUnits = voters.filter((r) => r.token_used).reduce((s, r) => s + (r.vote_weight || 1), 0);
    const voterById = new Map(voters.map((r) => [r.voter_id, r]));
    const presentVoterIds = new Set();
    for (const r of voters) { if (r.token_used) presentVoterIds.add(r.voter_id); }
    for (const a of attendance) { if (a.external_voter_id) presentVoterIds.add(a.external_voter_id); }
    const presentUnits = [...presentVoterIds].reduce((s, vid) => s + (voterById.get(vid)?.vote_weight || 1), 0);
    const attendedUnits = attendance.reduce((s, r) => s + (r.vote_weight || 1), 0);
    const walkInEnteredCount = attendance.filter((r) => r.vote_status_at_checkin === 'not_voted' && r.walk_in_ballot_status === 'entered').length;
    const attendedOnlyCount   = attendance.filter((r) => r.vote_status_at_checkin === 'not_voted' && r.walk_in_ballot_status !== 'entered').length;
    const threshold = settings?.quorum_threshold_units || 0;
    const met = threshold > 0 && presentUnits >= threshold;
    const quorum = {
      total_units: totalUnits,
      voted_units: votedUnits,
      attended_units: attendedUnits,
      walk_in_entered_count: walkInEnteredCount,
      attended_only_count: attendedOnlyCount,
      present_units: presentUnits,
      required_units: threshold,
      pct: totalUnits > 0 ? Number(((presentUnits / totalUnits) * 100).toFixed(2)) : 0,
      quorum_met: met,
      short_by: met ? 0 : Math.max(0, threshold - presentUnits),
    };

    stage = 'pdf-init';
    // Stream PDF. bufferPages: true is REQUIRED for the per-page footer
    // loop at the end of the body — without it, PDFKit flushes each page
    // as it's written and switchToPage(0) throws "out of bounds, current
    // buffer covers pages N to N" (the exact error that broke Canyon
    // Gate's finalize 2026-06-04 on a 3-page document). Buffered pages
    // sit in memory until doc.end() so the footer loop can stamp page
    // numbers across all of them.
    const doc = new PDFDocument({ size: 'LETTER', margin: 54, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', async () => {
      const pdfBuffer = Buffer.concat(chunks);
      console.log(`[meeting-checkin] PDF rendered, size=${pdfBuffer.length} bytes`);

      // Optionally archive. ALL failure paths are caught so a storage
      // or library-insert error never blocks the PDF download. The
      // operator gets the PDF and can re-archive manually if needed.
      let archived = null;
      let archiveError = null;
      if (archive && settings?.community_id) {
        try {
          const fileName = `Annual Meeting Quorum Evidence — ${settings.community_name || election.community_name || 'Community'} — ${settings.meeting_date || new Date().toISOString().slice(0,10)}.pdf`;
          const storagePath = `meeting-records/${settings.community_id}/${eid}/${Date.now()}-quorum-evidence.pdf`;
          const { error: upErr } = await supabase.storage
            .from('library')
            .upload(storagePath, pdfBuffer, {
              contentType: 'application/pdf',
              upsert: true,
            });
          if (upErr) {
            console.warn('[meeting-checkin] storage upload failed:', upErr.message);
            archiveError = 'storage: ' + upErr.message;
          } else {
            // Try the library_documents insert. If category 'meeting_records'
            // isn't in document_categories (it isn't seeded as of 2026-06-04),
            // the FK will reject. Fall back to 'annual_board_meeting_minutes'
            // which IS seeded (migration 012). The fileName makes it clear
            // what the doc is regardless of category.
            const tryInsert = async (cat) => {
              return supabase
                .from('library_documents')
                .insert({
                  management_company_id: BEDROCK_MGMT_CO_ID,
                  community_id: settings.community_id,
                  category: cat,
                  title: fileName,
                  file_path: storagePath,
                  status: 'current',
                  metadata: {
                    election_id: eid,
                    meeting_date: settings.meeting_date,
                    quorum_met: quorum.quorum_met,
                    source: 'meeting-checkin-evidence',
                    intended_category: 'meeting_records',
                  },
                })
                .select()
                .single();
            };
            let { data: libRow, error: libErr } = await tryInsert('meeting_records');
            if (libErr && /violates|foreign key|check constraint/i.test(libErr.message || '')) {
              console.warn('[meeting-checkin] meeting_records category rejected, falling back to annual_board_meeting_minutes:', libErr.message);
              ({ data: libRow, error: libErr } = await tryInsert('annual_board_meeting_minutes'));
            }
            if (libErr) {
              console.warn('[meeting-checkin] library_documents insert failed:', libErr.message);
              archiveError = 'library_documents: ' + libErr.message;
            } else {
              archived = libRow;
              // Portfolio view (Ed 2026-06-04): mark this election as
              // finalized so the dropdown / status badge / sort order
              // reflect that End Meeting has been completed. Snapshot
              // quorum totals at this moment so future portfolio queries
              // don't need to re-derive them.
              try {
                await supabase
                  .from('meeting_election_settings')
                  .update({
                    status: 'finalized',
                    finalized_at: new Date().toISOString(),
                    finalize_quorum_met: quorum.quorum_met,
                    finalize_present_units: quorum.present_units,
                    finalize_attended_count: attendance.length,
                  })
                  .eq('external_election_id', eid);
              } catch (finErr) {
                console.warn('[meeting-checkin] finalize-flag update failed:', finErr?.message);
              }
            }
          }
        } catch (e) {
          console.warn('[meeting-checkin] archive failed:', e.message);
          archiveError = e.message;
        }
      } else if (archive && !settings?.community_id) {
        archiveError = 'no_settings_row';
        console.warn(`[meeting-checkin] archive skipped — no meeting_election_settings row for eid=${eid}`);
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="meeting-quorum-evidence-${eid.slice(0,8)}.pdf"`);
      res.setHeader('X-Archived-Id', archived?.id || '');
      if (archiveError) res.setHeader('X-Archive-Error', archiveError.slice(0, 200));
      res.end(pdfBuffer);
    });
    doc.on('error', (e) => {
      console.error('[meeting-checkin] PDFKit stream error:', e?.stack || e?.message);
      if (!res.headersSent) res.status(500).json({ error: 'pdf_stream_error', detail: e?.message });
    });

    stage = 'pdf-body-header';
    // ===== PDF BODY =====
    // Null-safety helper — PDFKit's .text() throws on undefined/null.
    // Every interpolated value goes through this. Defense-in-depth against
    // the 2026-06-04 Canyon Gate 500 (one undefined field crashed the run).
    const s = (v, fallback = '') => {
      if (v == null) return fallback;
      const str = String(v);
      return str === 'undefined' || str === 'null' ? fallback : str;
    };

    // Central-time formatter — server runs UTC on Render, so anything that
    // hits new Date().toLocaleString() unqualified renders in UTC and looks
    // 5-6 hours off. Per CLAUDE.md timezone rule: format-on-display in
    // America/Chicago. Used for the per-row check-in time AND the footer.
    const fmtCentralTime = (iso) => {
      if (!iso) return '';
      try {
        return new Date(iso).toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
        });
      } catch (_) { return ''; }
    };
    const fmtCentralDateTime = (d) => {
      try {
        return d.toLocaleString('en-US', {
          dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Chicago',
        }) + ' CT';
      } catch (_) { return d.toISOString(); }
    };

    // Brand lockup — bedrock-mark-email-2x.png is the full B + BEDROCK
    // wordmark, designed for an email header band. At h=40 it's the
    // canonical brand presentation for this letterhead. No inline text
    // alongside it — Ed 2026-06-04 saw "Bedrock Association Management"
    // overlapping the embedded BEDROCK wordmark because the lockup is
    // wider than I had positioned the text for. Service-line identifier
    // moves to a small subtitle below.
    try { drawBedrockMark(doc, 54, 48, 40); } catch (e) { console.warn('[meeting-checkin] mark draw failed:', e?.message); }
    // Service-line subtitle under the lockup, right-justified to the
    // visual right-edge of the lockup (approx 220pt wide at h=40).
    doc.font('Helvetica').fontSize(8).fillColor('#7a7a7a')
       .text('Association Management  ·  Community. Simplified.', 54, 96, { width: 220 });

    doc.moveDown(2);
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#1A3050')
       .text(s(settings?.community_name || election.community_name, 'Community'), 54, 130, { align: 'center' });
    doc.font('Helvetica').fontSize(14).fillColor('#4a4a4a')
       .text(s(election.election_name, 'Annual Meeting'), { align: 'center' });
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(11).fillColor('#7a7a7a')
       .text('Quorum Evidence Record', { align: 'center' });

    doc.moveDown(2);

    stage = 'pdf-body-details';
    // Meeting details
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1A3050').text('Meeting Details');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a');
    const detLines = [
      ['Meeting Date', s(settings?.meeting_date, '(not set)')],
      ['Meeting Time', s(settings?.meeting_time, '(not set)')],
      ['Location', s(settings?.meeting_location, '(not set)')],
      ['Election', s(election.election_name, '(unnamed)')],
      ['Voting Window', `${s(election.start_date)?.slice(0,10) || '(none)'} to ${s(election.end_date)?.slice(0,10) || '(none)'}`],
      ['Seats Available', String(election.seats_available || 1)],
    ];
    for (const [k, v] of detLines) {
      doc.font('Helvetica-Bold').text(`${k}: `, { continued: true });
      doc.font('Helvetica').text(s(v, '—'));
    }

    doc.moveDown(1);

    stage = 'pdf-body-quorum';
    // Quorum math
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1A3050').text('Quorum Calculation');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a');
    const onlineCount = voters.filter((v) => v.token_used && (v.vote_method || '').toLowerCase() === 'online').length;
    const mailCount   = voters.filter((v) => v.token_used && (v.vote_method || '').toLowerCase() === 'mail').length;
    const qLines = [
      ['Total voting units in the Association', String(quorum.total_units)],
      ['Presence by absentee ballot (counted toward quorum)', String(quorum.voted_units)],
      ['  • Online ballots', String(onlineCount)],
      ['  • Mail ballots', String(mailCount)],
      ['Presence in person at the meeting (counted toward quorum)', String(quorum.attended_units)],
      ['  • Walk-in proxy ballot filed at meeting', String(quorum.walk_in_entered_count)],
      ['  • Attended without filing a walk-in ballot', String(quorum.attended_only_count)],
      ['Total unique units present (voted absentee OR attended in person)', String(quorum.present_units)],
      ['Quorum required', settings?.quorum_threshold_units
        ? `${quorum.required_units} units (${settings.quorum_threshold_percent}% of ${quorum.total_units})`
        : '(not configured)'],
      ['Current % present', `${quorum.pct}%`],
    ];
    for (const [k, v] of qLines) {
      doc.font('Helvetica-Bold').text(`${k}: `, { continued: true });
      doc.font('Helvetica').text(v);
    }

    doc.moveDown(0.3);
    doc.font('Helvetica-Oblique').fontSize(8).fillColor('#7a7a7a')
       .text('Members who both voted absentee AND physically attended are counted once. Physical attendance counts toward quorum under the governing-document "presence" language whether or not the member files a walk-in ballot.',
         { width: 504 });
    doc.moveDown(0.5);
    // Plain text (no unicode checkmarks). PDFKit's default Helvetica is
    // WinAnsi-only — Unicode U+2713 (✓) and U+2717 (✗) render as garbage
    // (saw "'&" in place of ✗ on Canyon Gate's PDF, 2026-06-04). Bold +
    // color is enough to convey status without the glyph.
    doc.font('Helvetica-Bold').fontSize(13)
       .fillColor(quorum.quorum_met ? '#1a7a35' : '#962a2a')
       .text(quorum.quorum_met
         ? 'QUORUM MET — meeting may transact business'
         : `QUORUM NOT MET — short by ${quorum.short_by} units`,
         { align: 'center' });
    doc.moveDown(1);

    if (settings?.quorum_clause_text) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor('#4a4a4a')
         .text(`Quorum threshold per governing documents: "${settings.quorum_clause_text}"`, {
           align: 'center', width: 504,
         });
      doc.moveDown(0.5);
    }

    stage = 'pdf-body-attendance';
    // Attendance log. Previously this section blindly called doc.addPage()
    // even when the quorum section had ALREADY auto-paginated, producing
    // a blank page in between (Ed 2026-06-04: 6 pages for Canyon Gate's
    // 42-attendee meeting). New behavior: soft break — only add a page if
    // there isn't enough room for the header + at least 6 rows on the
    // current page. Otherwise the attendance continues inline.
    {
      const HEADER_BLOCK_HEIGHT = 60;
      const MIN_ROWS_ON_FIRST_PAGE = 6;
      const PER_ROW = 14;
      const needed = HEADER_BLOCK_HEIGHT + (MIN_ROWS_ON_FIRST_PAGE * PER_ROW);
      if (doc.y + needed > 720) doc.addPage();
      else doc.moveDown(1);
    }
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#1A3050')
       .text('In-Person Attendance Log');
    doc.font('Helvetica').fontSize(9).fillColor('#7a7a7a')
       .text(`Timestamped record of every member checked in at the meeting (${attendance.length} entries).`);
    doc.moveDown(0.5);

    if (attendance.length === 0) {
      doc.font('Helvetica-Oblique').fontSize(10).fillColor('#7a7a7a')
         .text('No in-person attendees were checked in.');
    } else {
      // Header row
      const colX = { time: 54, name: 130, lot: 290, addr: 340, status: 470 };
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#1A3050');
      doc.text('Time', colX.time, doc.y);
      doc.text('Name', colX.name, doc.y);
      doc.text('Lot', colX.lot, doc.y);
      doc.text('Address', colX.addr, doc.y);
      doc.text('Status', colX.status, doc.y);
      doc.moveDown(0.3);
      doc.moveTo(54, doc.y).lineTo(558, doc.y).strokeColor('#E5E3DA').stroke();
      doc.moveDown(0.2);

      doc.font('Helvetica').fontSize(8).fillColor('#1a1a1a');
      // Deterministic row height — explicit y advance instead of moveDown so
      // a column's auto-wrap can't drift the cursor and accidentally double-
      // advance, which is part of how the Canyon Gate PDF ballooned to 6
      // pages (Ed 2026-06-04). 14pt per row gives clean spacing at 8pt font.
      const ROW_HEIGHT = 14;
      for (let i = 0; i < attendance.length; i++) {
        const a = attendance[i];
        try {
          if (doc.y + ROW_HEIGHT > 720) doc.addPage();
          const time = fmtCentralTime(a.checked_in_at);
          // Ed 2026-06-04: "Voted online" / "Voted mail" read like the
          // ballot is being cast at the meeting — but absentee voting
          // closed before meeting day. Re-phrased so timing is unambiguous:
          // these ballots were already on file when the owner checked in.
          const status =
            a.vote_status_at_checkin === 'voted_online' ? 'Online ballot on file' :
            a.vote_status_at_checkin === 'voted_mail'   ? 'Mail ballot on file' :
            a.vote_status_at_checkin === 'voted_walkin' ? 'Walk-in entered' :
            a.walk_in_ballot_status === 'entered'       ? 'Walk-in entered' :
            a.walk_in_ballot_status === 'needed'        ? 'Walk-in pending' :
            a.walk_in_ballot_status === 'declined_to_vote' ? 'Declined to vote' :
            'Attended';
          const y0 = doc.y;
          // height option on .text() prevents PDFKit from wrapping into the
          // next row's vertical space — anything too long gets clipped to
          // ROW_HEIGHT cleanly instead of bleeding down.
          doc.text(s(time, ''),             colX.time,   y0, { width: 70,  height: ROW_HEIGHT });
          doc.text(s(a.owner_name, ''),     colX.name,   y0, { width: 155, height: ROW_HEIGHT });
          doc.text(s(a.lot_number, ''),     colX.lot,    y0, { width: 45,  height: ROW_HEIGHT });
          doc.text(s(a.mailing_address, ''),colX.addr,   y0, { width: 125, height: ROW_HEIGHT });
          doc.text(s(status, 'Attended'),   colX.status, y0, { width: 90,  height: ROW_HEIGHT });
          // Hard-set cursor to next row, ignoring whatever doc.y is now.
          doc.y = y0 + ROW_HEIGHT;
        } catch (rowErr) {
          console.warn(`[meeting-checkin] attendance row ${i} render error:`, rowErr?.message, 'row=', JSON.stringify(a).slice(0, 200));
        }
      }
    }

    stage = 'pdf-body-signature';
    // Signature block. Soft break: 120pt is enough for the certification
    // paragraph + two signature lines; only add a page if that won't fit
    // on the current page. Previous threshold (y > 650) was too tight and
    // could fire even when 70pt of room remained, adding a blank page.
    doc.moveDown(1.5);
    const SIG_BLOCK_HEIGHT = 120;
    if (doc.y + SIG_BLOCK_HEIGHT > 720) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1A3050').text('Certification');
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a')
       .text(`I, the undersigned, certify that I served as Secretary of this annual meeting of ${s(settings?.community_name || election.community_name, 'the Community')} and that the attendance log and quorum calculation above accurately reflect the meeting as held.`,
         { width: 504 });

    doc.moveDown(3);
    const sigY = doc.y;
    doc.moveTo(54, sigY).lineTo(280, sigY).strokeColor('#000').stroke();
    doc.fontSize(9).fillColor('#7a7a7a').text(`Secretary — ${s(settings?.secretary_name, '(name)')}`, 54, sigY + 4);

    doc.moveTo(310, sigY).lineTo(540, sigY).strokeColor('#000').stroke();
    doc.fontSize(9).fillColor('#7a7a7a').text('Date', 310, sigY + 4);

    stage = 'pdf-footer';
    // Footer (every page). Wrapped in try/catch so a bad page-buffer state
    // here doesn't tank the PDF — the body content is far more important
    // than the page numbers. If this fails we ship the PDF without footers
    // and log the issue.
    try {
      const range = doc.bufferedPageRange();
      const pageCount = range.count;
      const startPage = range.start;
      for (let i = 0; i < pageCount; i++) {
        doc.switchToPage(startPage + i);
        doc.font('Helvetica').fontSize(7).fillColor('#bbb')
           .text(`Generated ${fmtCentralDateTime(new Date())} by ${s(BRAND?.service?.name, 'Bedrock Association Management')} · trustEd platform · page ${i+1} of ${pageCount}`,
             54, 760, { align: 'center', width: 504 });
      }
    } catch (footerErr) {
      console.warn('[meeting-checkin] footer render failed (continuing):', footerErr?.message);
    }

    stage = 'pdf-end';
    doc.end();
  } catch (err) {
    // Diagnostic-first: include the stage so the operator can paste the
    // log line and we know exactly where it died. Ed 2026-06-04 audit
    // rule — every silent failure path gets a structured log.
    console.error(`[meeting-checkin] generate-pdf failed at stage="${stage}":`, err?.stack || err?.message);
    if (!res.headersSent) {
      res.status(err?.code === 'VOTING_DB_NOT_CONFIGURED' ? 503 : 500)
         .json({ error: safeErrorMessage(err), stage });
    }
  }
});

module.exports = { router };
