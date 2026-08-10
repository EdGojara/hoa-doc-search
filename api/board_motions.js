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
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { requireBoardViewer, canSeeCommunity, scopeCommunityIds, boardCommunitiesForEmail } = require('../lib/portal/board_access');
const { enqueueMotionNotifications } = require('../lib/board/motion_notify');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const router = express.Router();

const MOTION_TYPES = ['general', 'project', 'vendor', 'budget', 'arc', 'policy', 'contract', 'other'];
const THRESHOLDS = ['simple_majority', 'two_thirds', 'unanimous'];
const VOTES = ['for', 'against', 'abstain'];

// Short human reference stamped into the vote email subject "[WAT-3F9A]" so a
// reply matches the exact motion deterministically. Abbrev from the community
// name + 4 random hex.
function makeRefCode(communityName) {
  const abbr = String(communityName || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'BRD';
  return `${abbr}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

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

// Stages a project can be in BEFORE the board has approved it — the only ones a
// vote should advance or reflect. Never touch a project already approved/further.
const PRE_APPROVAL_STAGES = ['requested', 'bid_requested', 'bid_received', 'board_deciding', 'on_hold'];

// When a motion is LINKED to a project and opened for a vote, reflect that on
// the project dashboard: it's now before the board. Best-effort; never throws.
async function markProjectOutForVote(motion) {
  try {
    if (!motion || !motion.related_project_id) return;
    const { data: proj } = await supabase.from('vendor_projects')
      .select('id, community_id, stage').eq('id', motion.related_project_id).maybeSingle();
    if (!proj || !PRE_APPROVAL_STAGES.includes(proj.stage) || proj.stage === 'board_deciding') return;
    await supabase.from('vendor_projects').update({
      stage: 'board_deciding', stage_since: new Date().toISOString(),
      next_action: 'board_vote', next_action_owner: 'board',
      next_action_note: `Out for board vote: "${motion.title}".`,
    }).eq('id', proj.id);
    await supabase.from('vendor_project_events').insert({
      project_id: proj.id, community_id: proj.community_id, event_type: 'stage_change',
      from_stage: proj.stage, to_stage: 'board_deciding',
      note: `Sent to the board for a vote via motion "${motion.title}".`, by_user: 'board vote',
    });
  } catch (e) { console.warn('[board_motions] markProjectOutForVote failed (non-fatal):', e.message); }
}

// When a linked motion is DECIDED, drive the project: a pass authorizes it
// (advance to 'approved', carry the estimate to approved_cost, next step =
// sign the contract); a fail is logged, stage left for a human. This is where
// a board vote stops being a record and starts moving operations. Never throws.
async function applyMotionEffect(motion, tally) {
  try {
    if (!motion || !motion.related_project_id) return null;
    if (motion.status !== 'passed' && motion.status !== 'failed') return null;
    const { data: proj } = await supabase.from('vendor_projects')
      .select('id, community_id, stage, estimated_cost_cents, approved_cost_cents')
      .eq('id', motion.related_project_id).maybeSingle();
    if (!proj) return null;
    const summary = `${tally.for} for, ${tally.against} against, ${tally.abstain} abstain`;

    if (motion.status === 'passed') {
      if (!PRE_APPROVAL_STAGES.includes(proj.stage)) {
        // Already approved or beyond — record the board's decision, don't move it back.
        await supabase.from('vendor_project_events').insert({
          project_id: proj.id, community_id: proj.community_id, event_type: 'note',
          note: `Board passed motion "${motion.title}" (${summary}); project already at "${proj.stage}".`, by_user: 'board vote',
        });
        return { advanced: false, project_id: proj.id };
      }
      const patch = {
        stage: 'approved', stage_since: new Date().toISOString(),
        next_action: 'sign_contract', next_action_owner: 'staff',
        next_action_note: `Board approved via vote (${summary}). Proceed to contract.`,
        status_note: `Board-approved via motion: "${motion.title}".`,
      };
      if (proj.approved_cost_cents == null && proj.estimated_cost_cents != null) patch.approved_cost_cents = proj.estimated_cost_cents;
      await supabase.from('vendor_projects').update(patch).eq('id', proj.id);
      await supabase.from('vendor_project_events').insert({
        project_id: proj.id, community_id: proj.community_id, event_type: 'stage_change',
        from_stage: proj.stage, to_stage: 'approved',
        note: `Board approved via motion "${motion.title}" (${summary}).`, by_user: 'board vote',
      });
      return { advanced: true, project_id: proj.id, to_stage: 'approved' };
    }
    // failed — log, leave the stage for a manager to decide next steps.
    await supabase.from('vendor_project_events').insert({
      project_id: proj.id, community_id: proj.community_id, event_type: 'note',
      note: `Board did NOT approve motion "${motion.title}" (${summary}).`, by_user: 'board vote',
    });
    return { advanced: false, declined: true, project_id: proj.id };
  } catch (e) {
    console.warn('[board_motions] applyMotionEffect failed (non-fatal):', e.message);
    return null;
  }
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
// GET /api/board-motions/portfolio
//   Cross-community roll-up so a manager sees board status everywhere at once,
//   without a community picker or email. Scoped: staff → all communities; a
//   board member → the communities they sit on. Motions needing attention
//   (open, no quorum yet, or past deadline) surface first.
// ---------------------------------------------------------------------------
router.get('/portfolio', async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const scope = scopeCommunityIds(viewer); // 'all' | [ids]

    // Resolve the community id → name map within scope.
    let commQ = supabase.from('communities')
      .select('id, name').eq('management_company_id', BEDROCK_MGMT_CO_ID);
    if (scope !== 'all') {
      if (!scope.length) return res.json({ communities: 0, motions: [] });
      commQ = commQ.in('id', scope);
    }
    const { data: comms, error: ce } = await commQ;
    if (ce) throw ce;
    const nameById = {};
    for (const c of (comms || [])) nameById[c.id] = c.name;
    const ids = Object.keys(nameById);
    if (!ids.length) return res.json({ communities: 0, motions: [] });

    const { data: motions, error } = await supabase.from('board_motions')
      .select('*').in('community_id', ids)
      .order('opened_at', { ascending: false }).limit(500);
    if (error) throw error;

    const mIds = (motions || []).map((m) => m.id);
    const votesByMotion = {};
    if (mIds.length) {
      const { data: votes, error: ve } = await supabase.from('board_motion_votes')
        .select('motion_id, vote').in('motion_id', mIds);
      if (ve) throw ve;
      for (const v of (votes || [])) (votesByMotion[v.motion_id] = votesByMotion[v.motion_id] || []).push(v);
    }

    // now (as ms since epoch) for deadline checks — Date.now() is fine here (API
    // runtime, not a workflow script).
    const now = Date.now();
    const out = (motions || []).map((m) => {
      const tally = evaluateMotion(m, votesByMotion[m.id] || []);
      const pastDeadline = m.status === 'open' && m.voting_deadline && new Date(m.voting_deadline).getTime() < now;
      // Proposed motions need attention too — they're waiting on a director to move them.
      const needsAttention = m.status === 'proposed' || (m.status === 'open' && (tally.quorum_met === false || !!pastDeadline));
      return {
        id: m.id, community_id: m.community_id, community_name: nameById[m.community_id] || '',
        title: m.title, motion_type: m.motion_type, status: m.status,
        voting_deadline: m.voting_deadline, opened_at: m.opened_at, closed_at: m.closed_at,
        requested_mover_name: m.requested_mover_name || null,
        tally, past_deadline: !!pastDeadline, needs_attention: needsAttention,
      };
    });
    res.json({ communities: ids.length, motions: out });
  } catch (err) {
    console.error('[board_motions] portfolio failed:', err.message);
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

    // Community name → the ref-code abbreviation stamped in vote-email subjects.
    let communityName = null;
    try { const { data } = await supabase.from('communities').select('name').eq('id', communityId).maybeSingle(); communityName = data?.name || null; } catch (_) {}
    const ref_code = makeRefCode(communityName);

    let voting_deadline = null;
    if (b.voting_deadline) {
      const d = new Date(b.voting_deadline);
      if (!Number.isNaN(d.getTime())) voting_deadline = d.toISOString();
    }

    // A linked project must belong to THIS community (never let a motion point
    // at another community's project). Silently drop a mismatched id.
    let related_project_id = null;
    if (b.related_project_id) {
      const { data: proj } = await supabase.from('vendor_projects')
        .select('id, community_id').eq('id', b.related_project_id).maybeSingle();
      if (proj && proj.community_id === communityId) related_project_id = proj.id;
    }

    // Lifecycle: 'propose' (manager keys it up, a director must MOVE it before
    // voting — the parliamentary default) vs 'open' (put straight to a vote,
    // e.g. recording a motion already moved in a meeting).
    const mode = b.mode === 'open' ? 'open' : 'propose';
    const rosterByEmail = {};
    for (const m of roster) rosterByEmail[m.email] = m;

    // Optional: the director the manager is asking to move it.
    let requested_mover_email = null, requested_mover_name = null;
    if (mode === 'propose' && b.requested_mover_email) {
      const rm = String(b.requested_mover_email).trim().toLowerCase();
      if (rosterByEmail[rm]) { requested_mover_email = rm; requested_mover_name = rosterByEmail[rm].name || rm; }
    }

    const insert = {
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id: communityId,
      title,
      description: b.description ? String(b.description) : null,
      motion_type,
      threshold,
      related_project_id,
      status: mode === 'open' ? 'open' : 'proposed',
      seats_at_open: roster.length,
      voting_deadline,
      created_via: actor.via,
      created_by_email: actor.email,
      created_by_name: actor.name || actor.email,
      requested_mover_email,
      requested_mover_name,
      ref_code,
    };
    const { data, error } = await supabase.from('board_motions').insert(insert).select('*').single();
    if (error) throw error;

    // Notify. Open-now → tell the board a vote is needed. Proposed → if a
    // specific director was asked, nudge just them to move it. Best-effort +
    // kill-switched, never blocks the create.
    let notif;
    if (mode === 'open') {
      const notifyList = roster.filter((m) => m.email !== String(actor.email || '').trim().toLowerCase());
      notif = await enqueueMotionNotifications(data, 'opened', notifyList);
    } else if (requested_mover_email) {
      notif = await enqueueMotionNotifications(data, 'to_move', [{ email: requested_mover_email, name: requested_mover_name }]);
    }
    // If linked to a project, reflect "out for board vote" on the project.
    if (data.related_project_id) await markProjectOutForVote(data);
    res.json({ ok: true, motion: { ...data, tally: evaluateMotion(data, []), my_vote: null }, notified: notif || null });
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
        .select('voter_email, voter_name, vote, comment, voted_at, recorded_by_email, source')
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
      source: voteByEmail[m.email] ? voteByEmail[m.email].source : null,
    }));
    // Any votes from emails no longer on the active roster (a member who has
    // since rolled off) — surface them rather than silently drop the record.
    const rosterEmails = new Set(roster.map((m) => m.email));
    const off_roster_votes = (votes || [])
      .filter((v) => !rosterEmails.has(String(v.voter_email).trim().toLowerCase()))
      .map((v) => ({ name: v.voter_name || v.voter_email, email: v.voter_email, vote: v.vote, comment: v.comment, voted_at: v.voted_at, off_roster: true }));

    // Linked project (so the UI can say "approving this authorizes X").
    let related_project = null;
    if (motion.related_project_id) {
      const { data: p } = await supabase.from('vendor_projects')
        .select('id, title, stage').eq('id', motion.related_project_id).maybeSingle();
      if (p) related_project = p;
    }

    const actor = writeActor(viewer);
    const myEmail = viewer.email ? String(viewer.email).trim().toLowerCase() : null;
    res.json({
      motion,
      related_project,
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

// The ONE path that records a vote — used by the portal endpoint AND the
// email-ballot endpoint, so a vote is recorded identically however it arrives
// (upsert on the unique key, re-tally, auto-finalize when every seat has voted,
// then fire result notice + project effect). Caller has already authorized the
// voter and confirmed the motion is open. Returns { tally, motion }.
async function recordMotionVote({ motion, voterEmail, voterName, vote, comment, source, recordedBy }) {
  const row = {
    motion_id: motion.id,
    voter_email: voterEmail,
    voter_name: voterName,
    vote,
    comment: comment ? String(comment) : null,
    recorded_by_email: recordedBy || null,
    source: source || 'portal',
    voted_at: new Date().toISOString(),
  };
  const { error: ue } = await supabase
    .from('board_motion_votes').upsert(row, { onConflict: 'motion_id,voter_email' });
  if (ue) throw ue;

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
    if (u) {
      updated = u;
      const roster = await activeRoster(motion.community_id);
      await enqueueMotionNotifications(u, 'result', roster, { tally });
      await applyMotionEffect(u, tally);
    }
  }
  return { tally, motion: updated };
}

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

    let voterEmail, voterName, recordedBy = null, source = 'portal';
    if (actor.is_staff) {
      voterEmail = String(b.voter_email || '').trim().toLowerCase();
      if (!voterEmail) return res.status(400).json({ error: 'voter_email_required', message: 'Pick which board member this vote is for.' });
      if (!rosterByEmail[voterEmail]) return res.status(400).json({ error: 'not_a_board_member', message: 'That email is not on this active board.' });
      voterName = rosterByEmail[voterEmail].name || voterEmail;
      recordedBy = actor.email;
      source = 'staff_recorded';
    } else {
      voterEmail = String(viewer.email).trim().toLowerCase();
      if (!rosterByEmail[voterEmail]) return res.status(403).json({ error: 'not_a_board_member' });
      voterName = rosterByEmail[voterEmail].name || actor.name || voterEmail;
    }

    const { tally, motion: updated } = await recordMotionVote({ motion, voterEmail, voterName, vote, comment: b.comment, source, recordedBy });
    res.json({ ok: true, motion: updated, tally, your_vote: actor.is_staff ? null : vote });
  } catch (err) {
    console.error('[board_motions] vote failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/board-motions/parse-reply
//   Reply-to-vote: record a vote from a board member's email reply. Staff-gated
//   (usable now to process a forwarded reply); the future votes@ inbound
//   webhook calls the same lib in-process. Body: { from, subject, body }.
//   Records NOTHING unless sender+motion+intent all resolve cleanly.
// ---------------------------------------------------------------------------
router.post('/parse-reply', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    if (viewer.kind !== 'staff') return res.status(403).json({ error: 'staff_only' });
    const { from, subject, body } = req.body || {};
    if (!from || !body) return res.status(400).json({ error: 'from_and_body_required', message: 'Need the sender and the reply body.' });
    // Lazy require to avoid a load-time cycle (vote_reply → board_motions).
    const { resolveVoteReply } = require('../lib/board/vote_reply');
    const result = await resolveVoteReply(supabase, { from, subject, body });
    res.json({ ok: true, result });
  } catch (err) {
    console.error('[board_motions] parse-reply failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/board-motions/poll-inbox
//   Reply-to-vote auto-ingest: read unread mail in vote@ via Graph and record
//   each clear vote. Staff-gated; also safe to call from a scheduler. No-ops
//   (with a clear reason) until GRAPH_* is set + vote@ is in the app's Mail.Read
//   policy.
// ---------------------------------------------------------------------------
router.post('/poll-inbox', express.json({ limit: '2kb' }), async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    if (viewer.kind !== 'staff') return res.status(403).json({ error: 'staff_only' });
    const { pollVoteInbox } = require('../lib/board/vote_inbox');
    const stats = await pollVoteInbox({ max: 50 });
    res.json({ ok: true, stats });
  } catch (err) {
    console.error('[board_motions] poll-inbox failed:', err.message);
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
    const effect = await applyMotionEffect(data, tally);
    res.json({ ok: true, motion: data, tally, notified: notif, project_effect: effect });
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
// POST /api/board-motions/motion/:motionId/move
//   A director MOVES a proposed motion (self, or staff records on their behalf),
//   optionally naming a seconder. This is the parliamentary step that turns a
//   manager-keyed draft into a live vote — status 'proposed' → 'open'.
// ---------------------------------------------------------------------------
router.post('/motion/:motionId/move', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const motion = await loadAuthorizedMotion(req, res, viewer);
    if (!motion) return;
    const actor = writeActor(viewer);
    if (!actor) return res.status(403).json({ error: 'read_only_preview', message: 'Exit the board-member preview to move a motion.' });
    if (motion.status !== 'proposed') return res.status(409).json({ error: 'not_proposed', message: 'Only a proposed motion can be moved.' });

    const roster = await activeRoster(motion.community_id);
    const rosterByEmail = {};
    for (const m of roster) rosterByEmail[m.email] = m;

    // Who moves it? A director moves as themselves; staff records a named director.
    let moverEmail, moverName, recordedBy = null;
    if (actor.is_staff) {
      moverEmail = String((req.body && req.body.mover_email) || '').trim().toLowerCase();
      if (!moverEmail) return res.status(400).json({ error: 'mover_required', message: 'Pick which board member moved it.' });
      if (!rosterByEmail[moverEmail]) return res.status(400).json({ error: 'not_a_board_member', message: 'That email is not on this active board.' });
      moverName = rosterByEmail[moverEmail].name || moverEmail;
      recordedBy = actor.email;
    } else {
      moverEmail = String(viewer.email).trim().toLowerCase();
      if (!rosterByEmail[moverEmail]) return res.status(403).json({ error: 'not_a_board_member' });
      moverName = rosterByEmail[moverEmail].name || actor.name || moverEmail;
    }

    const nowIso = new Date().toISOString();
    const patch = {
      status: 'open',
      moved_by_email: moverEmail, moved_by_name: moverName, moved_at: nowIso, moved_recorded_by: recordedBy,
      // Voting truly opens now — re-snapshot the clock + quorum base.
      opened_at: nowIso, seats_at_open: roster.length,
    };
    // Optional seconder (a DIFFERENT active director).
    const sec = String((req.body && req.body.seconded_by_email) || '').trim().toLowerCase();
    if (sec && rosterByEmail[sec] && sec !== moverEmail) {
      patch.seconded_by_email = sec; patch.seconded_by_name = rosterByEmail[sec].name || sec; patch.seconded_at = nowIso;
    }
    const { data, error } = await supabase.from('board_motions')
      .update(patch).eq('id', motion.id).eq('status', 'proposed').select('*').single();
    if (error) throw error;

    // The mover is presumed in favor — auto-record their YES so they don't have
    // to vote again (Ed 2026-08-09). Goes through the same recordMotionVote path
    // (tally, auto-finalize if that completes the board).
    let finalMotion = data, moverTally = null;
    try {
      const rv = await recordMotionVote({
        motion: data, voterEmail: moverEmail, voterName: moverName, vote: 'for',
        comment: 'Moved this motion.', source: recordedBy ? 'staff_recorded' : 'portal', recordedBy,
      });
      finalMotion = rv.motion; moverTally = rv.tally;
    } catch (e) { console.warn('[board_motions] mover auto-vote failed:', e.message); }

    // Now open for voting → notify the board (except the mover, who has voted).
    const notifyList = roster.filter((m) => m.email !== moverEmail);
    const notif = await enqueueMotionNotifications(finalMotion, 'opened', notifyList);
    res.json({ ok: true, motion: finalMotion, tally: moverTally, notified: notif });
  } catch (err) {
    console.error('[board_motions] move failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/board-motions/motion/:motionId/request-mover
//   Staff asks a specific director to move a proposed motion (records + nudges).
// ---------------------------------------------------------------------------
router.post('/motion/:motionId/request-mover', express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const motion = await loadAuthorizedMotion(req, res, viewer);
    if (!motion) return;
    const actor = writeActor(viewer);
    if (!actor) return res.status(403).json({ error: 'read_only_preview' });
    if (motion.status !== 'proposed') return res.status(409).json({ error: 'not_proposed' });
    const roster = await activeRoster(motion.community_id);
    const rosterByEmail = {};
    for (const m of roster) rosterByEmail[m.email] = m;
    const rm = String((req.body && req.body.requested_mover_email) || '').trim().toLowerCase();
    if (!rm || !rosterByEmail[rm]) return res.status(400).json({ error: 'not_a_board_member', message: 'Pick a board member to ask.' });
    const name = rosterByEmail[rm].name || rm;
    const { data, error } = await supabase.from('board_motions')
      .update({ requested_mover_email: rm, requested_mover_name: name })
      .eq('id', motion.id).eq('status', 'proposed').select('*').single();
    if (error) throw error;
    const notif = await enqueueMotionNotifications(data, 'to_move', [{ email: rm, name }]);
    res.json({ ok: true, motion: data, notified: notif });
  } catch (err) {
    console.error('[board_motions] request-mover failed:', err.message);
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
    if (!['open', 'proposed'].includes(motion.status)) return res.status(409).json({ error: 'not_open' });
    const { data, error } = await supabase.from('board_motions')
      .update({ status: 'withdrawn', closed_at: new Date().toISOString(), closed_by: actor.email, outcome_note: `Withdrawn by ${actor.name || actor.email}.` })
      .eq('id', motion.id).in('status', ['open', 'proposed']).select('*').single();
    if (error) throw error;
    res.json({ ok: true, motion: data });
  } catch (err) {
    console.error('[board_motions] withdraw failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router, evaluateMotion, recordMotionVote, activeRoster };
