// api/mailing_confirmation.js  (Ed 2026-10-24)
// ----------------------------------------------------------------------------
// Mailing confirmation + the violations work queue.
//
//   GET  /api/mailing/batches?community_id=   print runs that still need a staff answer
//   POST /api/mailing/batches/confirm          record what happened to one print run
//   POST /api/mailing/holds/:id/release        admin releases a mail hold
//   GET  /api/mailing/queue?community_id=      the four-bucket staff work queue
//
// A confirmation is a permanent record (letter_mailing_evidence, append-only). It
// never regenerates a letter, changes a cure deadline or letter date, advances a
// case, touches the mail-piece record or posts a charge. The one field it fills is
// interactions.mailed_at, and only where it is empty, with the date staff entered.
// Every write uses the employee's own login (requireStaff); a name is never taken
// from the request.
// ----------------------------------------------------------------------------
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { requireStaff, requireAdmin } = require('./_require_admin');
const { fetchAllQuery } = require('../lib/db/fetch_all');
const { isOperational } = require('../lib/community/lifecycle');
const ME = require('../lib/enforcement/mailing_evidence');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

const LETTER_TYPES = ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209', 'letter_postcard_reminder', 'letter_fine', 'letter_hearing', 'letter_force_mow'];
const LETTER_COLS = 'id, community_id, property_id, violation_id, type, subject, status, created_at, sent_at, printed_at, mailed_at, postmark_date, delivery_method, certified_tracking_number, properties(street_address)';
const todayCentral = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const flat = (l) => ({ ...l, street_address: (l.properties && l.properties.street_address) || null, properties: undefined });

async function activeCommunities(onlyId) {
  const rows = await fetchAllQuery(() => supabase.from('communities').select('*'));
  return rows.filter((c) => isOperational(c) && !c.is_demo && (!onlyId || c.id === onlyId));
}

async function inChunks(build, ids) {
  let out = [];
  for (let i = 0; i < ids.length; i += 200) out = out.concat(await fetchAllQuery(() => build(ids.slice(i, i + 200))));
  return out;
}

// Every printed letter that could still need an answer: printed and never
// confirmed, or printed inside a presumed-not-mailed window. Whole print runs are
// returned so staff see the full batch, including letters already answered.
async function printedLettersNeedingReview(communityIds) {
  const ctx0 = await ME.loadMailingContext(supabase, [], communityIds);
  const unconfirmed = await fetchAllQuery(() => supabase.from('interactions').select(LETTER_COLS)
    .in('type', LETTER_TYPES).in('community_id', communityIds).not('printed_at', 'is', null).is('mailed_at', null));
  let scoped = [];
  for (const s of ctx0.scopes) {
    // Central-day window, widened a day on each side then filtered exactly by scopeFor.
    const from = new Date(Date.parse(s.printed_from + 'T00:00:00Z') - 86400000).toISOString();
    const to = new Date(Date.parse(s.printed_through + 'T00:00:00Z') + 2 * 86400000).toISOString();
    scoped = scoped.concat(await fetchAllQuery(() => supabase.from('interactions').select(LETTER_COLS)
      .in('type', LETTER_TYPES).eq('community_id', s.community_id).gte('printed_at', from).lt('printed_at', to)));
  }
  const seen = new Map();
  for (const l of unconfirmed.concat(scoped)) seen.set(l.id, flat(l));
  // pull the rest of each touched print run so the batch is complete
  const runs = new Map();
  for (const l of seen.values()) runs.set(ME.batchKey(l), { community_id: l.community_id, printed_at: l.printed_at });
  for (const r of runs.values()) {
    const rest = await fetchAllQuery(() => supabase.from('interactions').select(LETTER_COLS)
      .in('type', LETTER_TYPES).eq('community_id', r.community_id).eq('printed_at', r.printed_at));
    for (const l of rest) if (!seen.has(l.id)) seen.set(l.id, flat(l));
  }
  const letters = [...seen.values()];
  const ctx = await ME.loadMailingContext(supabase, letters.map((l) => l.id), communityIds);
  return { letters, ctx };
}

function presentBatch(b, commName) {
  return {
    key: b.key, community_id: b.community_id, community: commName, delivery_method: b.delivery_method, printed_at: b.printed_at,
    letter_count: b.letters.length, needs_confirmation: b.needs_confirmation, presumed_not_mailed: b.presumed_not_mailed, counts: b.counts,
    letters: b.letters.map((l) => ({
      id: l.id, violation_id: l.violation_id, street_address: l.street_address, stage: l.stage, status: l.status,
      state: l.effective.state, mailed_on: l.effective.mailed_on || null, verified: !!l.effective.verified,
      reason: l.effective.reason || null, hold_id: (l.effective.hold && l.effective.hold.id) || null,
      recorded_by: (l.effective.evidence && l.effective.evidence.recorded_by_name) || null,
    })).sort((a, z) => String(a.street_address || '').localeCompare(String(z.street_address || ''))),
  };
}

router.get('/batches', async (req, res) => {
  try {
    const staff = await requireStaff(req, res); if (!staff) return;
    const comms = await activeCommunities(req.query.community_id || null);
    if (!comms.length) return res.json({ batches: [] });
    const names = new Map(comms.map((c) => [c.id, c.name]));
    const { letters, ctx } = await printedLettersNeedingReview(comms.map((c) => c.id));
    const batches = ME.summarizeBatches(letters, ctx)
      .filter((b) => b.needs_confirmation > 0 || req.query.include_done === '1')
      .map((b) => presentBatch(b, names.get(b.community_id)));
    res.json({ batches, as_of: new Date().toISOString() });
  } catch (err) {
    console.error('[mailing.batches] failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Body: { community_id, delivery_method, printed_at, mailed_on: 'YYYY-MM-DD',
//         outcomes: { [interaction_id]: 'mailed'|'not_mailed'|'held'|'excluded' },
//         notes?: { [interaction_id]: text }, note?: text }
router.post('/batches/confirm', express.json(), async (req, res) => {
  try {
    const staff = await requireStaff(req, res); if (!staff) return;
    const b = req.body || {};
    const who = staff.full_name || staff.email;
    if (!b.community_id || !b.printed_at) return res.status(400).json({ error: 'batch_required', detail: 'Which print run is this?' });
    const comms = await activeCommunities(b.community_id);
    if (!comms.length) return res.status(400).json({ error: 'community_not_active' });
    const method = b.delivery_method || 'first_class_mail';
    const batchLetters = (await fetchAllQuery(() => supabase.from('interactions').select(LETTER_COLS)
      .in('type', LETTER_TYPES).eq('community_id', b.community_id).eq('printed_at', b.printed_at)))
      .map(flat).filter((l) => (l.delivery_method || 'first_class_mail') === method);
    if (!batchLetters.length) return res.status(404).json({ error: 'batch_not_found', detail: 'No letters were printed in that run.' });
    const ctx = await ME.loadMailingContext(supabase, batchLetters.map((l) => l.id), [b.community_id]);
    const outcomes = b.outcomes || {};
    const v = ME.validateBatchConfirmation({ batchLetters, outcomes, mailedOn: b.mailed_on, today: todayCentral(), ctx });
    if (!v.ok) return res.status(400).json({ error: 'invalid_confirmation', detail: v.errors.join(' '), errors: v.errors });

    const entries = Object.entries(outcomes);
    const count = (o) => entries.filter(([, x]) => x === o).length;
    const anyMailed = count('mailed') > 0;
    const { data: conf, error: cErr } = await supabase.from('mailing_batch_confirmations').insert({
      community_id: b.community_id, delivery_method: method, printed_at: b.printed_at,
      mailed_on: anyMailed ? b.mailed_on : null, letter_count: entries.length,
      mailed_count: count('mailed'), not_mailed_count: count('not_mailed'), held_count: count('held'), excluded_count: count('excluded'),
      note: b.note ? String(b.note).slice(0, 2000) : null,
      confirmed_by_user_id: staff.user.id, confirmed_by_name: who,
    }).select('id').single();
    if (cErr) throw cErr;

    const byId = new Map(batchLetters.map((l) => [l.id, l]));
    const notes = b.notes || {};
    const evidence = entries.map(([id, o]) => ({
      interaction_id: id, community_id: b.community_id, violation_id: byId.get(id).violation_id || null,
      batch_confirmation_id: conf.id, outcome: o, mailed_on: o === 'mailed' ? b.mailed_on : null, delivery_method: method,
      note: notes[id] ? String(notes[id]).slice(0, 1000) : (b.note ? String(b.note).slice(0, 1000) : null),
      recorded_by_user_id: staff.user.id, recorded_by_name: who,
    }));
    const { error: eErr } = await supabase.from('letter_mailing_evidence').insert(evidence);
    if (eErr) {
      console.error('[mailing.confirm] evidence insert failed after batch row', conf.id, eErr.message);
      return res.status(500).json({ error: 'evidence_not_saved', detail: 'The confirmation was not saved. Nothing about the letters changed. Please try again.' });
    }

    // Fill the canonical mailed date only where it is empty (never overwrite a
    // recorded date). No cure deadline, letter date, PDF, mail piece or charge.
    const fillIds = entries.filter(([id, o]) => o === 'mailed' && !byId.get(id).mailed_at).map(([id]) => id);
    let filled = 0;
    if (fillIds.length) {
      const { data: up, error: uErr } = await supabase.from('interactions')
        .update({ mailed_at: `${b.mailed_on}T12:00:00+00:00` }).in('id', fillIds).is('mailed_at', null).select('id');
      if (uErr) console.error('[mailing.confirm] mailed_at fill failed (evidence is saved):', uErr.message);
      filled = (up || []).length;
    }

    // A line on each case timeline so the history reads in one place.
    const LABEL = { mailed: `confirmed mailed on ${b.mailed_on}`, not_mailed: 'confirmed NOT mailed yet', held: 'held, not mailed', excluded: 'pulled from the mailing' };
    const timeline = entries.filter(([id]) => byId.get(id).violation_id).map(([id, o]) => ({
      community_id: b.community_id, property_id: byId.get(id).property_id, violation_id: byId.get(id).violation_id,
      type: 'observation_note', direction: 'internal', subject: 'Mailing confirmed by staff',
      content: `${who}: letter printed ${ME.centralDate(b.printed_at)} was ${LABEL[o]}.${notes[id] ? ' Note: ' + String(notes[id]).slice(0, 300) : ''} Letter dates and the cure deadline were not changed.`,
      sent_by_user_id: staff.user.id, sent_at: new Date().toISOString(),
    }));
    if (timeline.length) {
      const { error: tErr } = await supabase.from('interactions').insert(timeline);
      if (tErr) console.warn('[mailing.confirm] timeline notes failed (evidence is saved):', tErr.message);
    }

    res.json({ ok: true, confirmation_id: conf.id, mailed: count('mailed'), not_mailed: count('not_mailed'), held: count('held'), excluded: count('excluded'), mailed_date_filled: filled });
  } catch (err) {
    console.error('[mailing.confirm] failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/holds/:id/release', express.json(), async (req, res) => {
  try {
    const admin = await requireAdmin(req, res); if (!admin) return;
    const reason = String((req.body && req.body.reason) || '').trim();
    if (reason.length < 5) return res.status(400).json({ error: 'reason_required', detail: 'Say why the hold is released.' });
    const { data, error } = await supabase.from('letter_mail_holds')
      .update({ released_at: new Date().toISOString(), released_by_user_id: admin.user.id, release_reason: reason })
      .eq('id', req.params.id).is('released_at', null).select('id').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'hold_not_active' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[mailing.hold-release] failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/queue', async (req, res) => {
  try {
    const staff = await requireStaff(req, res); if (!staff) return;
    const comms = await activeCommunities(req.query.community_id || null);
    if (!comms.length) return res.json({ items: [], counts: {} });
    const cids = comms.map((c) => c.id);
    const names = new Map(comms.map((c) => [c.id, c.name]));
    const vios = (await fetchAllQuery(() => supabase.from('violations')
      .select('id, community_id, property_id, current_stage, source, opened_at, properties(street_address)')
      .in('community_id', cids).is('resolved_at', null).neq('quality_status', 'superseded')
      .in('current_stage', ['courtesy_1', 'courtesy_2', 'certified_209', 'fine_assessed']))).map(flat);
    const caseLetters = (await inChunks((ids) => supabase.from('interactions').select(LETTER_COLS).in('type', LETTER_TYPES).in('violation_id', ids), vios.map((v) => v.id))).map(flat);
    const { letters: printed } = await printedLettersNeedingReview(cids);
    const all = new Map(); for (const l of caseLetters.concat(printed)) all.set(l.id, l);
    const letters = [...all.values()];
    const ctx = await ME.loadMailingContext(supabase, letters.map((l) => l.id), cids);
    const owners = await fetchAllQuery(() => supabase.from('enforcement_queue_owners').select('id, community_id, bucket, user_id')).catch((e) => { console.warn('[mailing.queue] owners unavailable:', e.message); return []; });
    const profiles = owners.length ? await fetchAllQuery(() => supabase.from('user_profiles').select('id, full_name, email').in('id', [...new Set(owners.map((o) => o.user_id))])) : [];
    const pName = new Map(profiles.map((p) => [p.id, p.full_name || p.email]));
    const q = ME.buildWorkQueue({ letters, violations: vios, ctx, owners: owners.map((o) => ({ ...o, name: pName.get(o.user_id) })), today: todayCentral() });
    res.json({ ...q, items: q.items.map((i) => ({ ...i, community: names.get(i.community_id) || '' })) });
  } catch (err) {
    console.error('[mailing.queue] failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
