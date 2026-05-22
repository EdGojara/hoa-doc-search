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
const PDFDocument = require('pdfkit');
const { BRAND } = require('../lib/brand');

// Draw a 3-tier cornerstone (matching brand SVG) at (x,y) with given height.
function drawCornerstone(doc, x, y, h) {
  const w = h * 0.8;
  const tier = h / 3.4;
  const inset = w * 0.045;
  doc.save().fillColor('#D4AF37');
  // Top tier
  doc.polygon([x, y], [x + w, y], [x + w - inset * 2, y + tier], [x + inset * 2, y + tier]).fill();
  // Middle tier
  doc.polygon(
    [x + inset, y + tier * 1.1], [x + w - inset, y + tier * 1.1],
    [x + w - inset * 3, y + tier * 2.1], [x + inset * 3, y + tier * 2.1]
  ).fill();
  // Bottom tier
  doc.polygon(
    [x + inset * 2.2, y + tier * 2.2], [x + w - inset * 2.2, y + tier * 2.2],
    [x + w - inset * 4, y + h], [x + inset * 4, y + h]
  ).fill();
  doc.restore();
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
// GET /elections — list active elections from voting DB
// ----------------------------------------------------------------------------
router.get('/elections', async (req, res) => {
  try {
    const voting = getVotingClient();
    const { data, error } = await voting
      .from('elections')
      .select('*')
      .order('start_date', { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json({ elections: data || [] });
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
// GET /elections/:eid/search?q=... — search voters by name
// ----------------------------------------------------------------------------
// Searches by owner_name (ILIKE). Returns up to 20 matches with current
// vote status derived from the voters row. Also pulls any existing
// attendance record so the UI can show "already checked in" state.
// ----------------------------------------------------------------------------
router.get('/elections/:eid/search', async (req, res) => {
  try {
    const eid = req.params.eid;
    const q = (req.query.q || '').toString().trim();
    if (!q || q.length < 2) return res.json({ voters: [] });

    const voting = getVotingClient();
    const { data: votersRows, error: vErr } = await voting
      .from('voters')
      .select('voter_id, election_id, owner_name, mailing_address, lot_number, vote_weight, token_used, token_used_at, vote_method, entered_by, entered_at')
      .eq('election_id', eid)
      .ilike('owner_name', `%${q}%`)
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

    const voters = (votersRows || []).map((v) => {
      const status = deriveVoteStatus(v);
      const att = attendanceByVoter.get(v.voter_id) || null;
      return {
        voter_id: v.voter_id,
        owner_name: v.owner_name,
        mailing_address: v.mailing_address,
        lot_number: v.lot_number,
        vote_weight: v.vote_weight || 1,
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
      checked_in_by_staff: body.checked_in_by_staff || null,
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
    const aid = req.params.aid;
    const body = req.body || {};
    const patch = {};
    for (const f of ALLOWED_PATCH_FIELDS) {
      if (body[f] !== undefined) patch[f] = body[f];
    }
    // Auto-set walk_in_ballot_entered_at when status transitions to 'entered'
    if (patch.walk_in_ballot_status === 'entered') {
      patch.walk_in_ballot_entered_at = new Date().toISOString();
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
router.get('/elections/:eid/status', async (req, res) => {
  try {
    const eid = req.params.eid;
    const voting = getVotingClient();

    // Pull all voters for this election (vote_weight + token_used columns
    // are enough for the quorum math; we don't need the names here).
    const { data: voterRows, error: vErr } = await voting
      .from('voters')
      .select('voter_id, vote_weight, token_used, vote_method')
      .eq('election_id', eid);
    if (vErr) throw vErr;

    const totalUnits = (voterRows || []).reduce((s, r) => s + (r.vote_weight || 1), 0);
    const votedUnits = (voterRows || []).filter((r) => r.token_used).reduce((s, r) => s + (r.vote_weight || 1), 0);

    // Breakdown by vote_method
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

    const attendedTotal = (attRows || []).length;
    const attendedUnits = (attRows || []).reduce((s, r) => s + (r.vote_weight || 1), 0);
    // "Attended but had not voted at check-in" — these count toward quorum
    // ONLY if they file a walk-in ballot (so we further filter by
    // walk_in_ballot_status = 'entered' OR by current voted-status from
    // voting DB at this moment). We compute both for transparency.
    const attendedNotVotedAtCheckin = (attRows || []).filter(
      (r) => r.vote_status_at_checkin === 'not_voted'
    );
    const walkInEnteredUnits = attendedNotVotedAtCheckin
      .filter((r) => r.walk_in_ballot_status === 'entered')
      .reduce((s, r) => s + (r.vote_weight || 1), 0);

    // Settings
    const { data: settings } = await supabase
      .from('meeting_election_settings')
      .select('*')
      .eq('external_election_id', eid)
      .maybeSingle();

    const threshold = settings?.quorum_threshold_units || 0;
    const quorum = computeQuorum({
      totalUnits,
      votedUnits,
      attendedUnitsNotVoted: walkInEnteredUnits,
      threshold,
    });

    res.json({
      quorum,
      vote_breakdown: methodCounts,
      attendance: {
        total_checkins: attendedTotal,
        total_units_attended: attendedUnits,
        attended_not_voted: attendedNotVotedAtCheckin.length,
        walk_in_ballots_entered: attendedNotVotedAtCheckin.filter((r) => r.walk_in_ballot_status === 'entered').length,
        walk_in_ballots_needed: attendedNotVotedAtCheckin.filter((r) => r.walk_in_ballot_status === 'needed').length,
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
  try {
    const eid = req.params.eid;
    const archive = req.body?.archive !== false;

    // Pull everything we need for the report
    const voting = getVotingClient();
    const [electionRes, votersRes, settingsRes, attRes] = await Promise.all([
      voting.from('elections').select('*').eq('election_id', eid).maybeSingle(),
      voting.from('voters').select('voter_id, vote_weight, token_used, vote_method').eq('election_id', eid),
      supabase.from('meeting_election_settings').select('*').eq('external_election_id', eid).maybeSingle(),
      supabase.from('meeting_attendance').select('*').eq('external_election_id', eid).order('checked_in_at'),
    ]);
    if (electionRes.error) throw electionRes.error;
    if (votersRes.error) throw votersRes.error;
    if (attRes.error) throw attRes.error;
    const election = electionRes.data;
    const voters = votersRes.data || [];
    const settings = settingsRes.data;
    const attendance = attRes.data || [];

    if (!election) return res.status(404).json({ error: 'election_not_found' });

    // Quorum math (same logic as /status)
    const totalUnits = voters.reduce((s, r) => s + (r.vote_weight || 1), 0);
    const votedUnits = voters.filter((r) => r.token_used).reduce((s, r) => s + (r.vote_weight || 1), 0);
    const walkInEnteredUnits = attendance
      .filter((r) => r.vote_status_at_checkin === 'not_voted' && r.walk_in_ballot_status === 'entered')
      .reduce((s, r) => s + (r.vote_weight || 1), 0);
    const quorum = computeQuorum({
      totalUnits,
      votedUnits,
      attendedUnitsNotVoted: walkInEnteredUnits,
      threshold: settings?.quorum_threshold_units || 0,
    });

    // Stream PDF
    const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', async () => {
      const pdfBuffer = Buffer.concat(chunks);

      // Optionally archive
      let archived = null;
      if (archive && settings?.community_id) {
        try {
          const fileName = `Annual Meeting Quorum Evidence — ${settings.community_name || election.community_name} — ${settings.meeting_date || new Date().toISOString().slice(0,10)}.pdf`;
          const storagePath = `meeting-records/${settings.community_id}/${eid}/${Date.now()}-quorum-evidence.pdf`;
          const { error: upErr } = await supabase.storage
            .from('library')
            .upload(storagePath, pdfBuffer, {
              contentType: 'application/pdf',
              upsert: true,
            });
          if (upErr) console.warn('[meeting-checkin] storage upload failed:', upErr.message);
          const { data: libRow, error: libErr } = await supabase
            .from('library_documents')
            .insert({
              management_company_id: BEDROCK_MGMT_CO_ID,
              community_id: settings.community_id,
              category: 'meeting_records',
              title: fileName,
              file_path: storagePath,
              metadata: {
                election_id: eid,
                meeting_date: settings.meeting_date,
                quorum_met: quorum.quorum_met,
                source: 'meeting-checkin-evidence',
              },
            })
            .select()
            .single();
          if (libErr) console.warn('[meeting-checkin] library_documents insert failed:', libErr.message);
          else archived = libRow;
        } catch (e) {
          console.warn('[meeting-checkin] archive failed:', e.message);
        }
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="meeting-quorum-evidence-${eid.slice(0,8)}.pdf"`);
      res.setHeader('X-Archived-Id', archived?.id || '');
      res.end(pdfBuffer);
    });

    // ===== PDF BODY =====
    // Brand cornerstone + wordmark
    try { drawCornerstone(doc, 54, 54, 36); } catch (_) {}
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1A3050')
       .text(BRAND.service.name, 100, 60);
    doc.font('Helvetica').fontSize(8).fillColor('#7a7a7a')
       .text(BRAND.tagline || 'Community. Simplified.', 100, 76);

    doc.moveDown(2);
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#1A3050')
       .text(`${settings?.community_name || election.community_name}`, 54, 130, { align: 'center' });
    doc.font('Helvetica').fontSize(14).fillColor('#4a4a4a')
       .text(election.election_name || 'Annual Meeting', { align: 'center' });
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(11).fillColor('#7a7a7a')
       .text('Quorum Evidence Record', { align: 'center' });

    doc.moveDown(2);

    // Meeting details
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1A3050').text('Meeting Details');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a');
    const detLines = [
      ['Meeting Date', settings?.meeting_date || '(not set)'],
      ['Meeting Time', settings?.meeting_time || '(not set)'],
      ['Location', settings?.meeting_location || '(not set)'],
      ['Election', election.election_name],
      ['Voting Window', `${election.start_date?.slice(0,10)} → ${election.end_date?.slice(0,10)}`],
      ['Seats Available', String(election.seats_available || 1)],
    ];
    for (const [k, v] of detLines) {
      doc.font('Helvetica-Bold').text(`${k}: `, { continued: true });
      doc.font('Helvetica').text(v);
    }

    doc.moveDown(1);

    // Quorum math
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1A3050').text('Quorum Calculation');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a');
    const qLines = [
      ['Total voting units in the Association', String(quorum.total_units)],
      ['Voted by online or mail ballot before meeting', String(quorum.voted_units)],
      ['  • Online ballots', String(voters.filter((v) => v.token_used && (v.vote_method || '').toLowerCase() === 'online').length)],
      ['  • Mail ballots', String(voters.filter((v) => v.token_used && (v.vote_method || '').toLowerCase() === 'mail').length)],
      ['Walk-in proxy ballots entered at meeting', String(quorum.attended_not_voted_units)],
      ['Total units present (voted + walk-in)', String(quorum.present_units)],
      ['Quorum required', settings?.quorum_threshold_units
        ? `${quorum.required_units} units (${settings.quorum_threshold_percent}% of ${quorum.total_units})`
        : '(not configured)'],
      ['Current % present', `${quorum.pct}%`],
    ];
    for (const [k, v] of qLines) {
      doc.font('Helvetica-Bold').text(`${k}: `, { continued: true });
      doc.font('Helvetica').text(v);
    }

    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(13)
       .fillColor(quorum.quorum_met ? '#1a7a35' : '#962a2a')
       .text(quorum.quorum_met
         ? `✓ QUORUM MET — meeting may transact business`
         : `✗ Quorum NOT MET — short by ${quorum.short_by} units`,
         { align: 'center' });
    doc.moveDown(1);

    if (settings?.quorum_clause_text) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor('#4a4a4a')
         .text(`Quorum threshold per governing documents: "${settings.quorum_clause_text}"`, {
           align: 'center', width: 504,
         });
      doc.moveDown(0.5);
    }

    // Attendance log
    doc.addPage();
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
      for (const a of attendance) {
        if (doc.y > 720) doc.addPage();
        const time = a.checked_in_at ? new Date(a.checked_in_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
        const status =
          a.vote_status_at_checkin === 'voted_online' ? 'Voted online' :
          a.vote_status_at_checkin === 'voted_mail'   ? 'Voted mail' :
          a.vote_status_at_checkin === 'voted_walkin' ? 'Walk-in' :
          a.walk_in_ballot_status === 'entered'       ? 'Walk-in entered' :
          a.walk_in_ballot_status === 'needed'        ? 'Walk-in pending' :
          a.walk_in_ballot_status === 'declined_to_vote' ? 'Declined' :
          'Attended';
        const y0 = doc.y;
        doc.text(time, colX.time, y0, { width: 70 });
        doc.text(a.owner_name || '', colX.name, y0, { width: 155 });
        doc.text(a.lot_number || '', colX.lot, y0, { width: 45 });
        doc.text(a.mailing_address || '', colX.addr, y0, { width: 125 });
        doc.text(status, colX.status, y0, { width: 90 });
        doc.moveDown(1.2);
      }
    }

    // Signature block
    doc.moveDown(2);
    if (doc.y > 650) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1A3050').text('Certification');
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a')
       .text(`I, the undersigned, certify that I served as Secretary of this annual meeting of ${settings?.community_name || election.community_name} and that the attendance log and quorum calculation above accurately reflect the meeting as held.`,
         { width: 504 });

    doc.moveDown(3);
    const sigY = doc.y;
    doc.moveTo(54, sigY).lineTo(280, sigY).strokeColor('#000').stroke();
    doc.fontSize(9).fillColor('#7a7a7a').text(`Secretary — ${settings?.secretary_name || '(name)'}`, 54, sigY + 4);

    doc.moveTo(310, sigY).lineTo(540, sigY).strokeColor('#000').stroke();
    doc.fontSize(9).fillColor('#7a7a7a').text('Date', 310, sigY + 4);

    // Footer (every page)
    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      doc.font('Helvetica').fontSize(7).fillColor('#bbb')
         .text(`Generated ${new Date().toLocaleString('en-US')} by ${BRAND.service.name} · trustEd platform · page ${i+1} of ${pageCount}`,
           54, 760, { align: 'center', width: 504 });
    }

    doc.end();
  } catch (err) {
    console.error('[meeting-checkin] generate-pdf failed:', err.stack || err.message);
    res.status(err.code === 'VOTING_DB_NOT_CONFIGURED' ? 503 : 500)
       .json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
