// =============================================================================
// Board Motions API — fiduciary board voting inside the board portal
// =============================================================================
// Mounted at /api/board-motions in server.js.
//
// A motion is a formal board decision ("approve the Versatex sidewalk estimate").
// Active board members vote for / against / abstain; the result is computed with
// quorum from the active-board size snapshotted when the motion opened. Every
// vote is a permanent, named record (association_record) that belongs in the
// minutes.
//
// DISTINCT from the homeowner election app (bedrock-vote): that runs statutory
// community-wide elections; this is internal board approvals. No shared code.
//
// AUTHORIZATION reuses the board portal core (lib/portal/board_access.js):
//   - requireBoardViewer proves identity (staff JWT OR a board member's portal
//     cookie whose email holds an active seat) and derives a community scope.
//   - canSeeCommunity(viewer, id) is the one gate; the URL's community id is
//     CHECKED against the derived scope, never trusted.
// WRITES (create / vote / close) require a real actor:
//   - a real board member (viewer.kind==='board' && !acting_as) acts as self;
//   - staff (viewer.kind==='staff') records on behalf, stamped staff_recorded;
//   - a staff "view as" preview (acting_as set) is READ-ONLY — never writes,
//     so staff can never accidentally cast a vote as someone while previewing.
// =============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireBoardViewer, canSeeCommunity, boardCommunitiesForEmail } = require('../lib/portal/board_access');
const { enqueueMotionNotifications } = require('../lib/board/motion_notify');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const router = express.Router();

const MOTION_TYPES = ['general', 'project', 'vendor', 'budget', 'arc', 'policy', 'contract', 'other'];
const THRESHOLDS = ['simple_majority', 'two_thirds', 'unanimous'];
const VOTES = ['for', 'against', 'abstain'];

// The actor for a WRITE. Returns null when the caller may only read (a staff
// "view as" preview). See the authorization note above.
function writeActor(viewer) {
  if (!viewer) return null;
  if (viewer.kind === 'board' && !viewer.acting_as) {
    return { email: viewer.email, name: viewer.name, via: 'portal', is_staff: false };
  }
  if (viewer.kind === 'staff') {
    return { email: viewer.email, name: viewer.name, via: 'staff_recorded', is_staff: true };
  }
  return null; // board preview (acting_as) — read-only
}

// Active board roster for a community (the electorate + who-hasn't-voted set).
async function activeRoster(communityId) {
  const { data, error } = await supabase
    .from('board_members')
    .select('name, email, position')
    .eq('management_company_id', BEDROCK_MGMT_CO_ID)
    .eq('community_id', communityId)
    .eq('is_active', true)
    .not('email', 'is', null)
    .order('name', { ascending: true });
  if (error) throw error;
  return (data || []).map((r) => ({ ...r, email: String(r.email).trim().toLowerCase() }));
}

// Compute the tally + provisional result. Abstentions count for quorum but not
// for the pass math. Quorum = majority of the active-board size at open.
function evaluateMotion(motion, votes) {
  let forC = 0, againstC = 0, abstainC = 0;
  for (const v of votes) {
    if (v.vote === 'for') forC++;
    else if (v.vote === 'against') againstC++;
    else if (v.vote === 'abstain') abstainC++;
  }
  const cast = forC + againstC + abstainC;
  const seats = motion.seats_at_open || null;
  const quorum = seats ? Math.floor(seats / 2) + 1 : null;
  const quorumMet = quorum != null ? cast >= quorum : null;
  const decisive = forC + againstC; // abstentions excluded
  let wouldPass;
  if (motion.threshold === 'unanimous') wouldPass = forC > 0 && againstC === 0;
  else if (motion.threshold === 'two_thirds') wouldPass = decisive > 0 && forC >= Math.ceil((decisive * 2) / 3);
  else wouldPass = forC > againstC; // simple majority of those voting for/against
  return {
    for: forC, against: againstC, abstain: abstainC, cast,
    seats, quorum, quorum_met: quorumMet,
    would_pass: wouldPass,
    // The result IF closed right now: needs quorum AND the threshold.
    provisional_result: (quorumMet ? (wouldPass ? 'passed' : 'failed') : 'pending_quorum'),
  };
}

// ---------------------------------------------------------------------------
// GET /api/board-motions/community/:id/motions
//   List motions for a community (open first), each with its tally + result.
// ---------------------------------------------------------------------------
router.get('/community/:id/motions', async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const communityId = req.params.id;
    if (!canSeeCommunity(viewer, communityId)) return res.status(403).json({ error: 'forbidden' });

    const { data: motions, error } = await supabase
      .from('board_motions')
      .select('*')
      .eq('community_id', communityId)
      .order('opened_at', { ascending: false })
      .limit(300);
    if (error) throw error;

    const ids = (motions || []).map((m) => m.id);
    let votesByMotion = {};
    if (ids.length) {
      const { data: votes, error: ve } = await supabase
        .from('board_motion_votes')
        .select('motion_id, voter_email, voter_name, vote, voted_at')
        .in('motion_id', ids);
      if (ve) throw ve;
      for (const v of (votes || [])) (votesByMotion[v.motion_id] = votesByMotion[v.motion_id] || []).push(v);
    }

    const actor = writeActor(viewer);
    const myEmail = viewer.email ? String(viewer.email).trim().toLowerCase() : null;
    const out = (motions || []).map((m) => {
      const mv = votesByMotion[m.id] || [];
      const myVote = myEmail ? (mv.find((v) => v.voter_email === myEmail) || null) : null;
      return {
        ...m,
        tally: evaluateMotion(m, mv),
        my_vote: myVote ? myVote.vote : null,
      };
    });
    res.json({ motions: out, can_write: !!actor, is_staff: !!(actor && actor.is_staff) });
  } catch (err) {
    console.error('[board_motions] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/board-motions/community/:id/motions   — create a motion
// ---------------------------------------------------------------------------
router.post('/community/:id/motions', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const communityId = req.params.id;
    if (!canSeeCommunity(viewer, communityId)) return res.status(403).json({ error: 'forbidden' });
    const actor = writeActor(viewer);
    if (!actor) return res.status(403).json({ error: 'read_only_preview', message: 'Exit the board-member preview to record a motion.' });

    const b = req.body || {};
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ error: 'title_required' });
    const motion_type = MOTION_TYPES.includes(b.motion_type) ? b.motion_type : 'general';
    const threshold = THRESHOLDS.includes(b.threshold) ? b.threshold : 'simple_majority';

    // Snapshot the active-board size now — quorum is judged against the board as
    // it stood when the motion opened, not a roster that shifts mid-vote.
    const roster = await activeRoster(communityId);

    let voting_deadline = null;
    if (b.voting_deadline) {
      const d = new Date(b.voting_deadline);
      if (!Number.isNaN(d.getTime())) voting_deadline = d.toISOString();
    }

    const insert = {
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id: communityId,
      title,
      description: b.description ? String(b.description) : null,
      motion_type,
      threshold,
      related_project_id: b.related_project_id || null,
      status: 'open',
      seats_at_open: roster.length,
      voting_deadline,
      created_via: actor.via,
      created_by_email: actor.email,
      created_by_name: actor.name || actor.email,
    };
    const { data, error } = await supabase.from('board_motions').insert(insert).select('*').single();
    if (error) throw error;
    // Notify the board a vote is needed (everyone but the person who moved it).
    // Best-effort + kill-switched — never blocks the create.
    const notifyList = roster.filter((m) => m.email !== String(actor.email || '').trim().toLowerCase());
    const notif = await enqueueMotionNotifications(data, 'opened', notifyList);
    res.json({ ok: true, motion: { ...data, tally: evaluateMotion(data, []), my_vote: null }, notified: notif });
  } catch (err) {
    console.error('[board_motions] create failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Load a motion + authorize the caller against ITS community. Returns the
// motion or sends the response and returns null.
async function loadAuthorizedMotion(req, res, viewer) {
  const { data: motion, error } = await supabase
    .from('board_motions').select('*').eq('id', req.params.motionId).maybeSingle();
  if (error) throw error;
  if (!motion) { res.status(404).json({ error: 'motion_not_found' }); return null; }
  if (!canSeeCommunity(viewer, motion.community_id)) { res.status(403).json({ error: 'forbidden' }); return null; }
  return motion;
}

// ---------------------------------------------------------------------------
// GET /api/board-motions/motion/:motionId   — detail + every vote + roster
// ---------------------------------------------------------------------------
router.get('/motion/:motionId', async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const motion = await loadAuthorizedMotion(req, res, viewer);
    if (!motion) return;

    const [{ data: votes, error: ve }, roster, { data: notifs }] = await Promise.all([
      supabase.from('board_motion_votes')
        .select('voter_email, voter_name, vote, comment, voted_at, recorded_by_email')
        .eq('motion_id', motion.id).order('voted_at', { ascending: true }),
      activeRoster(motion.community_id),
      // Notification delivery status (best-effort; table may not exist pre-353).
      supabase.from('board_motion_notifications')
        .select('kind, status, created_at').eq('motion_id', motion.id),
    ]);
    if (ve) throw ve;
    // Summarize notifications so a manager sees delivery at a glance.
    let notify_status = null;
    if (Array.isArray(notifs)) {
      const s = { sent: 0, suppressed: 0, failed: 0, reminders: 0 };
      for (const n of notifs) {
        if (n.status === 'sent') s.sent++;
        else if (n.status === 'suppressed') s.suppressed++;
        else if (n.status === 'failed') s.failed++;
        if (n.kind === 'reminder') s.reminders++;
      }
      notify_status = s;
    }

    const voteByEmail = {};
    for (const v of (votes || [])) voteByEmail[String(v.voter_email).trim().toLowerCase()] = v;
    // Roster with each member's vote (or null = hasn't voted) so the board can
    // see who is outstanding — the "who voted for each one" ask.
    const roster_votes = roster.map((m) => ({
      name: m.name, email: m.email, position: m.position,
      vote: voteByEmail[m.email] ? voteByEmail[m.email].vote : null,
      comment: voteByEmail[m.email] ? voteByEmail[m.email].comment : null,
      voted_at: voteByEmail[m.email] ? voteByEmail[m.email].voted_at : null,
      recorded_by_email: voteByEmail[m.email] ? voteByEmail[m.email].recorded_by_email : null,
    }));
    // Any votes from emails no longer on the active roster (a member who has
    // since rolled off) — surface them rather than silently drop the record.
    const rosterEmails = new Set(roster.map((m) => m.email));
    const off_roster_votes = (votes || [])
      .filter((v) => !rosterEmails.has(String(v.voter_email).trim().toLowerCase()))
      .map((v) => ({ name: v.voter_name || v.voter_email, email: v.voter_email, vote: v.vote, comment: v.comment, voted_at: v.voted_at, off_roster: true }));

    const actor = writeActor(viewer);
    const myEmail = viewer.email ? String(viewer.email).trim().toLowerCase() : null;
    res.json({
      motion,
      tally: evaluateMotion(motion, votes || []),
      roster_votes,
      off_roster_votes,
      my_vote: myEmail && voteByEmail[myEmail] ? voteByEmail[myEmail].vote : null,
      can_write: !!actor,
      is_staff: !!(actor && actor.is_staff),
      notify_status,
    });
  } catch (err) {
    console.error('[board_motions] detail failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/board-motions/motion/:motionId/vote
//   A real board member casts/updates their own vote. Staff may record a vote
//   on behalf of a named active board member (voter_email in the body).
// ---------------------------------------------------------------------------
router.post('/motion/:motionId/vote', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const motion = await loadAuthorizedMotion(req, res, viewer);
    if (!motion) return;
    const actor = writeActor(viewer);
    if (!actor) return res.status(403).json({ error: 'read_only_preview', message: 'Exit the board-member preview to vote.' });
    if (motion.status !== 'open') return res.status(409).json({ error: 'motion_closed', message: 'This motion is closed to voting.' });

    const b = req.body || {};
    const vote = String(b.vote || '').trim().toLowerCase();
    if (!VOTES.includes(vote)) return res.status(400).json({ error: 'invalid_vote', message: 'Vote must be for, against, or abstain.' });

    // Who is this vote FOR? A board member votes as themselves; staff must name
    // an active board member of this community.
    const roster = await activeRoster(motion.community_id);
    const rosterByEmail = {};
    for (const m of roster) rosterByEmail[m.email] = m;

    let voterEmail, voterName, recordedBy = null;
    if (actor.is_staff) {
      voterEmail = String(b.voter_email || '').trim().toLowerCase();
      if (!voterEmail) return res.status(400).json({ error: 'voter_email_required', message: 'Pick which board member this vote is for.' });
      if (!rosterByEmail[voterEmail]) return res.status(400).json({ error: 'not_a_board_member', message: 'That email is not on this active board.' });
      voterName = rosterByEmail[voterEmail].name || voterEmail;
      recordedBy = actor.email;
    } else {
      voterEmail = String(viewer.email).trim().toLowerCase();
      if (!rosterByEmail[voterEmail]) return res.status(403).json({ error: 'not_a_board_member' });
      voterName = rosterByEmail[voterEmail].name || actor.name || voterEmail;
    }

    // Upsert on the (motion_id, voter_email) unique constraint so re-voting
    // updates the existing row instead of duplicating.
    const row = {
      motion_id: motion.id,
      voter_email: voterEmail,
      voter_name: voterName,
      vote,
      comment: b.comment ? String(b.comment) : null,
      recorded_by_email: recordedBy,
      voted_at: new Date().toISOString(),
    };
    const { error: ue } = await supabase
      .from('board_motion_votes')
      .upsert(row, { onConflict: 'motion_id,voter_email' });
    if (ue) throw ue;

    // Re-read votes, evaluate. Auto-finalize once every active seat has voted —
    // the result is settled, no reason to make someone click "close".
    const { data: votes, error: ve } = await supabase
      .from('board_motion_votes').select('vote').eq('motion_id', motion.id);
    if (ve) throw ve;
    const tally = evaluateMotion(motion, votes || []);
    let updated = motion;
    if (tally.cast >= (motion.seats_at_open || Infinity)) {
      const result = tally.quorum_met && tally.would_pass ? 'passed' : 'failed';
      const { data: u, error: cerr } = await supabase.from('board_motions')
        .update({ status: result, closed_at: new Date().toISOString(), closed_by: 'auto (all voted)', outcome_note: 'Auto-finalized: every active board member voted.' })
        .eq('id', motion.id).eq('status', 'open').select('*').maybeSingle();
      if (cerr) throw cerr;
      if (u) { updated = u; await enqueueMotionNotifications(u, 'result', roster, { tally }); }
    }
    res.json({ ok: true, motion: updated, tally, your_vote: actor.is_staff ? null : vote });
  } catch (err) {
    console.error('[board_motions] vote failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/board-motions/motion/:motionId/close   — finalize the result now
//   (a chair/staff closing the vote before every seat has weighed in)
// ---------------------------------------------------------------------------
router.post('/motion/:motionId/close', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const motion = await loadAuthorizedMotion(req, res, viewer);
    if (!motion) return;
    const actor = writeActor(viewer);
    if (!actor) return res.status(403).json({ error: 'read_only_preview' });
    if (motion.status !== 'open') return res.status(409).json({ error: 'already_closed' });

    const { data: votes, error: ve } = await supabase
      .from('board_motion_votes').select('vote').eq('motion_id', motion.id);
    if (ve) throw ve;
    const tally = evaluateMotion(motion, votes || []);
    const result = tally.quorum_met && tally.would_pass ? 'passed' : 'failed';
    const note = tally.quorum_met
      ? `Closed by ${actor.name || actor.email}. ${tally.for} for, ${tally.against} against, ${tally.abstain} abstain.`
      : `Closed by ${actor.name || actor.email} without quorum (${tally.cast} of ${tally.seats}, needed ${tally.quorum}) — motion fails.`;
    const { data, error } = await supabase.from('board_motions')
      .update({ status: result, closed_at: new Date().toISOString(), closed_by: actor.email, outcome_note: note })
      .eq('id', motion.id).eq('status', 'open').select('*').single();
    if (error) throw error;
    const roster = await activeRoster(motion.community_id);
    const notif = await enqueueMotionNotifications(data, 'result', roster, { tally });
    res.json({ ok: true, motion: data, tally, notified: notif });
  } catch (err) {
    console.error('[board_motions] close failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/board-motions/motion/:motionId/remind
//   Nudge the active board members who have NOT voted yet on an open motion.
//   Manual (a manager/chair click); the same helper backs a future scheduler.
// ---------------------------------------------------------------------------
router.post('/motion/:motionId/remind', express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const motion = await loadAuthorizedMotion(req, res, viewer);
    if (!motion) return;
    const actor = writeActor(viewer);
    if (!actor) return res.status(403).json({ error: 'read_only_preview' });
    if (motion.status !== 'open') return res.status(409).json({ error: 'not_open', message: 'Only open motions can be reminded.' });

    const [{ data: votes, error: ve }, roster] = await Promise.all([
      supabase.from('board_motion_votes').select('voter_email, vote').eq('motion_id', motion.id),
      activeRoster(motion.community_id),
    ]);
    if (ve) throw ve;
    const voted = new Set((votes || []).map((v) => String(v.voter_email).trim().toLowerCase()));
    const nonVoters = roster.filter((m) => !voted.has(m.email));
    const tally = evaluateMotion(motion, votes || []);
    const notif = await enqueueMotionNotifications(motion, 'reminder', nonVoters, { tally });
    res.json({ ok: true, non_voters: nonVoters.length, notified: notif });
  } catch (err) {
    console.error('[board_motions] remind failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/board-motions/motion/:motionId/withdraw  — pull a motion
// ---------------------------------------------------------------------------
router.post('/motion/:motionId/withdraw', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const motion = await loadAuthorizedMotion(req, res, viewer);
    if (!motion) return;
    const actor = writeActor(viewer);
    if (!actor) return res.status(403).json({ error: 'read_only_preview' });
    if (motion.status !== 'open') return res.status(409).json({ error: 'not_open' });
    const { data, error } = await supabase.from('board_motions')
      .update({ status: 'withdrawn', closed_at: new Date().toISOString(), closed_by: actor.email, outcome_note: `Withdrawn by ${actor.name || actor.email}.` })
      .eq('id', motion.id).eq('status', 'open').select('*').single();
    if (error) throw error;
    res.json({ ok: true, motion: data });
  } catch (err) {
    console.error('[board_motions] withdraw failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router, evaluateMotion };
