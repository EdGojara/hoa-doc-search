// lib/enforcement/mailing_evidence.js  (Ed 2026-10-24)
// ----------------------------------------------------------------------------
// Whether a letter actually went in the mail, decided from the evidence staff
// recorded, not from the print stamp. Three facts sit on top of the letter's own
// fields (printed_at / mailed_at / status):
//
//   holds     a letter someone with authority said must NOT be mailed
//             (letter_mail_holds). It stays held until an admin releases it.
//   evidence  what staff confirmed happened to the letter (letter_mailing_evidence,
//             append-only; the newest row for a letter is the current answer):
//             mailed on a date / not mailed yet / held / excluded.
//   scopes    print windows Ed flagged as "presumed not mailed" even though
//             TrustEd shows a confirm click (mailing_verification_scopes). A
//             letter in a scope counts as mailed only once staff record a date.
//
// Nothing here writes. It never touches cure deadlines, letter dates, PDFs or
// charges; it only answers "is this letter proven mailed, and on what date".
// ----------------------------------------------------------------------------
const { letterStageOf } = require('./letter_stage');

const DEAD_STATUS = new Set(['rejected', 'failed', 'cancelled', 'error', 'superseded', 'voided']);
const centralDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }) : null);

// Newest evidence row per letter (append-only: a later row supersedes an earlier one).
function latestEvidenceByLetter(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const cur = m.get(r.interaction_id);
    if (!cur || String(r.recorded_at) > String(cur.recorded_at)) m.set(r.interaction_id, r);
  }
  return m;
}

function activeHoldsByLetter(rows) {
  const m = new Map();
  for (const h of rows || []) if (!h.released_at) m.set(h.interaction_id, h);
  return m;
}

// The scope (if any) a printed letter falls in: same community, printed on a
// Central calendar day inside [printed_from, printed_through].
function scopeFor(letter, scopes) {
  if (!letter || !letter.printed_at) return null;
  const d = centralDate(letter.printed_at);
  return (scopes || []).find((s) => s.community_id === letter.community_id
    && (!s.printed_from || d >= s.printed_from) && (!s.printed_through || d <= s.printed_through)) || null;
}

// When migration 544 was applied; from then on every mailing needs an evidence row.
const EVIDENCE_REQUIRED_FROM = '2026-10-24T23:53:25Z';
function isClickTimeStamp(l) {
  if (!l || !l.mailed_at || !l.sent_at || !l.printed_at) return false;
  if (Date.parse(l.mailed_at) < Date.parse(EVIDENCE_REQUIRED_FROM)) return false;
  return l.mailed_at === l.sent_at && l.printed_at !== l.mailed_at;
}

// The one answer every reader uses.
//   state: mailed | presumed_not_mailed | not_mailed | on_hold | held | excluded |
//          printed_unconfirmed | queued | approved | draft
//   mailed_on: YYYY-MM-DD when state is mailed
//   verified: true when a staff evidence row backs the answer
function effectiveMailing(letter, ctx = {}) {
  const l = letter || {};
  const ev = ctx.evidence && ctx.evidence.get(l.id);
  const hold = ctx.holds && ctx.holds.get(l.id);
  if (DEAD_STATUS.has(String(l.status || ''))) return { state: 'held', verified: false, reason: 'pulled from the mail run' };
  if (hold) return { state: 'on_hold', verified: true, reason: hold.reason, hold };
  if (ev) {
    if (ev.outcome === 'mailed') return { state: 'mailed', mailed_on: ev.mailed_on, verified: true, evidence: ev };
    if (ev.outcome === 'not_mailed') return { state: 'not_mailed', verified: true, evidence: ev };
    if (ev.outcome === 'held') return { state: 'held', verified: true, evidence: ev, reason: ev.note };
    if (ev.outcome === 'excluded') return { state: 'excluded', verified: true, evidence: ev, reason: ev.note };
  }
  const scope = scopeFor(l, ctx.scopes);
  if (scope) return { state: 'presumed_not_mailed', verified: false, scope, reason: scope.reason };
  // A click-time stamp from the old Mail Queue button after evidence became
  // required (migration 544): mailed_at equals the queue stamp, no evidence row.
  // The date is the click, not the mailing, so it still needs a real date.
  if (isClickTimeStamp(l)) return { state: 'printed_unconfirmed', verified: false, reason: 'marked mailed with the click time; the actual mailing date is not recorded' };
  if (l.mailed_at) return { state: 'mailed', mailed_on: l.postmark_date || centralDate(l.mailed_at), verified: false };
  if (l.printed_at) return { state: 'printed_unconfirmed', verified: false };
  if (l.sent_at || l.status === 'sent') return { state: 'queued', verified: false };
  if (l.status === 'approved') return { state: 'approved', verified: false };
  return { state: 'draft', verified: false };
}

const isMailed = (letter, ctx) => effectiveMailing(letter, ctx).state === 'mailed';

// The five categories staff see (Ed 2026-10-24). Every state maps to exactly one.
const CATEGORY = {
  mailed: 'mailed',
  printed_unconfirmed: 'needs_date_confirmation', // believed mailed, actual date not yet confirmed
  presumed_not_mailed: 'printed_not_mailed',
  not_mailed: 'printed_not_mailed',
  draft: 'not_yet_printed', approved: 'not_yet_printed', queued: 'not_yet_printed',
  on_hold: 'held', held: 'held', excluded: 'held',
};
const CATEGORY_LABEL = {
  mailed: 'Mailed',
  needs_date_confirmation: 'Already mailed, needs date confirmation',
  printed_not_mailed: 'Printed but not mailed',
  not_yet_printed: 'Not yet printed',
  held: 'Held, must not be mailed',
};
const mailingCategory = (state) => CATEGORY[state] || 'not_yet_printed';

// Load holds / evidence / scopes for a set of letters. A missing table (the
// migration not yet applied) or a fake test database yields empty context, so
// readers behave exactly as before; the failure is logged, never silent.
async function loadMailingContext(db, interactionIds, communityIds) {
  const ctx = { evidence: new Map(), holds: new Map(), scopes: [] };
  const ids = [...new Set((interactionIds || []).filter(Boolean))];
  const pull = async (table, cols, build, { perIdChunk = true } = {}) => {
    try {
      let out = [];
      const chunks = perIdChunk ? [] : [null];
      if (perIdChunk) for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));
      for (const chunk of chunks) {
        const { data, error } = await build(db.from(table).select(cols), chunk);
        if (error) throw new Error(error.message);
        out = out.concat(data || []);
      }
      return out;
    } catch (e) {
      console.warn(`[mailing-evidence] ${table} unavailable, treated as empty:`, e.message);
      return [];
    }
  };
  if (ids.length) {
    ctx.evidence = latestEvidenceByLetter(await pull('letter_mailing_evidence', 'id, interaction_id, outcome, mailed_on, note, recorded_by_name, recorded_at, batch_confirmation_id', (q, chunk) => q.in('interaction_id', chunk).order('id')));
    ctx.holds = activeHoldsByLetter(await pull('letter_mail_holds', 'id, interaction_id, reason, directed_by, directed_at, released_at', (q, chunk) => q.in('interaction_id', chunk).order('id')));
  }
  ctx.scopes = await pull('mailing_verification_scopes', 'id, community_id, printed_from, printed_through, reason', (q) => {
    const cids = [...new Set((communityIds || []).filter(Boolean))];
    return (cids.length ? q.in('community_id', cids) : q).eq('active', true).order('id');
  }, { perIdChunk: false });
  return ctx;
}

// Open cure-deadline review holds, by case ids or by communities. Missing table
// (migration not applied) reads as none, logged.
async function loadOpenReviewHolds(db, { violationIds = null, communityIds = null } = {}) {
  try {
    let out = [];
    if (violationIds) {
      const ids = [...new Set(violationIds.filter(Boolean))];
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await db.from('enforcement_review_holds').select('id, community_id, violation_id, interaction_id, kind, reason, basis_date, confirmed_mailed_on, cure_period_ends_at_flagged, created_at, resolved_at')
          .in('violation_id', ids.slice(i, i + 200)).is('resolved_at', null).order('id');
        if (error) throw new Error(error.message);
        out = out.concat(data || []);
      }
    } else {
      let q = db.from('enforcement_review_holds').select('id, community_id, violation_id, interaction_id, kind, reason, basis_date, confirmed_mailed_on, cure_period_ends_at_flagged, created_at, resolved_at').is('resolved_at', null);
      if (communityIds && communityIds.length) q = q.in('community_id', communityIds);
      const { data, error } = await q.order('id').limit(2000);
      if (error) throw new Error(error.message);
      out = data || [];
    }
    return out;
  } catch (e) {
    console.warn('[mailing-evidence] enforcement_review_holds unavailable, treated as none:', e.message);
    return [];
  }
}

// A print session = one community, one delivery method, one print stamp.
const batchKey = (l) => `${l.community_id}|${l.delivery_method || 'first_class_mail'}|${l.printed_at}`;

// Letters in a batch that still need someone to say what happened to them.
const NEEDS_CONFIRMATION = new Set(['printed_unconfirmed', 'presumed_not_mailed', 'not_mailed']);

function summarizeBatches(letters, ctx) {
  const map = new Map();
  for (const l of letters || []) {
    if (!l.printed_at) continue;
    const eff = effectiveMailing(l, ctx);
    const k = batchKey(l);
    if (!map.has(k)) map.set(k, { key: k, community_id: l.community_id, delivery_method: l.delivery_method || 'first_class_mail', printed_at: l.printed_at, letters: [], counts: {} });
    const b = map.get(k);
    b.letters.push({ ...l, stage: letterStageOf(l), effective: eff });
    b.counts[eff.state] = (b.counts[eff.state] || 0) + 1;
  }
  const out = [...map.values()].map((b) => ({
    ...b,
    needs_confirmation: b.letters.filter((x) => NEEDS_CONFIRMATION.has(x.effective.state)).length,
    presumed_not_mailed: b.letters.some((x) => x.effective.state === 'presumed_not_mailed'),
  }));
  return out.sort((a, b) => String(a.printed_at).localeCompare(String(b.printed_at)));
}

// Validate one batch confirmation before anything is written. Pure.
//   outcomes: { [interaction_id]: 'mailed' | 'not_mailed' | 'held' | 'excluded' }
function validateBatchConfirmation({ batchLetters, outcomes, mailedOn, today, ctx }) {
  const errors = [];
  const inBatch = new Map((batchLetters || []).map((l) => [l.id, l]));
  const entries = Object.entries(outcomes || {});
  if (!entries.length) errors.push('Choose what happened to at least one letter.');
  const anyMailed = entries.some(([, o]) => o === 'mailed');
  if (anyMailed) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(mailedOn || ''))) errors.push('Enter the date the letters were mailed.');
    else {
      if (today && mailedOn > today) errors.push('The mailing date cannot be in the future.');
      const printedDay = (batchLetters || []).map((l) => centralDate(l.printed_at)).filter(Boolean).sort()[0];
      if (printedDay && mailedOn < printedDay) errors.push(`The mailing date cannot be before the letters were printed (${printedDay}).`);
    }
  }
  for (const [id, o] of entries) {
    const l = inBatch.get(id);
    if (!l) { errors.push(`Letter ${id.slice(0, 8)} is not in this print run.`); continue; }
    if (!['mailed', 'not_mailed', 'held', 'excluded'].includes(o)) { errors.push(`Unknown choice "${o}".`); continue; }
    const eff = effectiveMailing(l, ctx);
    if (o === 'mailed' && eff.state === 'on_hold') errors.push(`The letter for ${l.street_address || id.slice(0, 8)} is on hold and cannot be confirmed as mailed. ${eff.reason || ''}`.trim());
    if (eff.state === 'held' && !eff.verified) errors.push(`The letter for ${l.street_address || id.slice(0, 8)} was already pulled from the mail run.`);
  }
  return { ok: !errors.length, errors };
}

// ---------------------------------------------------------------------------
// Cure-deadline safeguard (Ed 2026-10-24). A letter's cure deadline was counted
// from its letter date (postmark_date, else the print day). If staff confirm it
// was actually mailed LATER, the owner got less time than the letter says: the
// case is flagged and escalation waits until an admin resolves the deadline.
// Pure: returns the flags to record; the caller writes them.
function cureDeadlineFlags({ letters, mailedOn, openViolationIds }) {
  const open = new Set(openViolationIds || []);
  const out = [];
  const seen = new Set();
  for (const l of letters || []) {
    if (!l || !l.violation_id || !open.has(l.violation_id) || seen.has(l.violation_id)) continue;
    const basis = l.postmark_date || centralDate(l.printed_at);
    if (basis && mailedOn && mailedOn > basis) {
      seen.add(l.violation_id);
      out.push({
        violation_id: l.violation_id, interaction_id: l.id, basis_date: basis, confirmed_mailed_on: mailedOn,
        reason: `Letter dated ${basis} was confirmed mailed on ${mailedOn}; the cure deadline was counted from ${basis}. Escalation waits until the deadline is reviewed.`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The staff work queue: four buckets, each item with one action and one owner.
// ---------------------------------------------------------------------------
const BUCKETS = {
  ready_to_mail: 'Ready to mail (needs staff approval)',
  confirm_mailing: 'Confirm mailing date',
  held_correction: 'Held or needs correction',
  missing_notice: 'Missing required notice or evidence',
};
const REQUIRED_PRIOR = { courtesy_2: 'courtesy_1', certified_209: 'courtesy_2', fine_assessed: 'certified_209' };
const STAGE_LABEL = { courtesy_1: 'Courtesy 1', courtesy_2: 'Courtesy 2', certified_209: 'Certified §209', fine_assessed: 'Fine' };

function ownerFor(owners, communityId, bucket) {
  const own = (owners || []).find((o) => o.community_id === communityId && o.bucket === bucket)
    || (owners || []).find((o) => !o.community_id && o.bucket === bucket);
  return own ? { user_id: own.user_id, name: own.name || null } : { user_id: null, name: 'Unassigned' };
}

// letters: active-community violation letters (open cases + recent prints).
// violations: open cases (resolved_at null) at any stage.
function buildWorkQueue({ letters, violations, ctx, owners, today }) {
  const items = [];
  // ownerBucket: whose decision it is when that differs from the bucket's owner
  // (a missing notice that needs a stage decision belongs to the corrections owner).
  const push = (bucket, it, ownerBucket = bucket) => items.push({ bucket, bucket_label: BUCKETS[bucket], owner: ownerFor(owners, it.community_id, ownerBucket), ...it });
  const byCase = new Map();
  for (const l of letters || []) { if (!l.violation_id) continue; if (!byCase.has(l.violation_id)) byCase.set(l.violation_id, []); byCase.get(l.violation_id).push(l); }
  const openIds = new Set((violations || []).map((v) => v.id));

  // Batches: one item per print run with anything left to confirm.
  for (const b of summarizeBatches(letters, ctx)) {
    if (!b.needs_confirmation) continue;
    const notMailed = b.letters.filter((x) => x.effective.state === 'not_mailed').length;
    push(notMailed === b.needs_confirmation ? 'ready_to_mail' : 'confirm_mailing', {
      kind: 'batch', key: b.key, community_id: b.community_id, printed_at: b.printed_at, delivery_method: b.delivery_method,
      count: b.needs_confirmation, presumed_not_mailed: b.presumed_not_mailed,
      action: notMailed === b.needs_confirmation
        ? `${notMailed} printed letter(s) were never mailed. Before mailing, check whether the letter date and cure deadline still give the owner the full cure period; if not, ask Ed to correct the date first. Nothing is resent or regenerated automatically. After mailing, confirm the date they went out.`
        : b.presumed_not_mailed
          ? `Presumed NOT mailed. Tell us which letters in this run actually went out and on what date; mark the rest "not mailed yet".`
          : `Confirm the date this run was mailed, and mark any letters that were held or pulled.`,
    });
  }

  for (const l of letters || []) {
    const eff = effectiveMailing(l, ctx);
    const open = l.violation_id && openIds.has(l.violation_id);
    if (!open && !['on_hold', 'excluded'].includes(eff.state)) continue;
    if (eff.state === 'draft' || eff.state === 'approved' || eff.state === 'queued') {
      push('ready_to_mail', {
        kind: 'letter', interaction_id: l.id, violation_id: l.violation_id, community_id: l.community_id, street_address: l.street_address, stage: letterStageOf(l),
        action: eff.state === 'draft' ? 'Review and approve this letter in Drafts.' : 'Lock and print this letter in the Mail Queue, then confirm mailing.',
      });
    } else if (eff.state === 'on_hold' || eff.state === 'excluded' || (eff.state === 'held' && open)) {
      push('held_correction', {
        kind: 'letter', interaction_id: l.id, violation_id: l.violation_id, community_id: l.community_id, street_address: l.street_address, stage: letterStageOf(l),
        reason: eff.reason || null,
        action: eff.state === 'on_hold' ? 'On hold: do not mail. Ed decides whether to release or void it.' : 'Pulled from the mail. Decide whether the case needs a corrected letter or should be reduced.',
      });
    }
  }

  // Cases waiting on a cure-deadline review (escalation is on hold).
  for (const h of (ctx && ctx.reviewHolds) || []) {
    if (h.resolved_at) continue;
    push('held_correction', {
      kind: 'review_hold', review_hold_id: h.id, violation_id: h.violation_id, interaction_id: h.interaction_id, community_id: h.community_id,
      street_address: h.street_address || null, reason: h.reason,
      action: 'Cure deadline needs review: the letter went out after the date its deadline was counted from. Escalation is on hold. Ed decides: keep the deadline, or record a corrected one.',
    });
  }

  // Cases whose current stage is not backed by a mailed earlier notice.
  for (const v of violations || []) {
    const req = REQUIRED_PRIOR[v.current_stage];
    const L = (byCase.get(v.id) || []).filter((l) => !DEAD_STATUS.has(String(l.status || '')));
    const atStage = L.filter((l) => letterStageOf(l) === (v.current_stage === 'fine_assessed' ? 'certified_209' : v.current_stage));
    const prior = req ? L.filter((l) => letterStageOf(l) === req) : [];
    const priorEff = prior.map((l) => effectiveMailing(l, ctx));
    const priorMailed = priorEff.find((e) => e.state === 'mailed');
    if (!atStage.length && !(v.source === 'vantaca_import' && !L.length)) {
      const label = STAGE_LABEL[v.current_stage] || v.current_stage;
      if (!req || priorMailed || v.source === 'vantaca_import') {
        push('missing_notice', {
          kind: 'case', violation_id: v.id, community_id: v.community_id, street_address: v.street_address, stage: v.current_stage,
          action: !req
            ? `No ${label} letter exists for this open case. Open the case: draft the first notice, or close the case if it was opened in error.`
            : `No ${label} letter exists for this case${priorMailed ? ` (the ${STAGE_LABEL[req]} letter was mailed ${priorMailed.mailed_on})` : ''}. Use "Prepare letter" on the case, then approve it in Drafts.`,
        });
      } else if (priorEff.some((e) => ['printed_unconfirmed', 'presumed_not_mailed'].includes(e.state))) {
        // Waiting on a print-run confirmation; the batch item covers it.
      } else {
        push('missing_notice', {
          kind: 'case', violation_id: v.id, community_id: v.community_id, street_address: v.street_address, stage: v.current_stage,
          action: `The case is at ${label} with no ${label} letter and no mailed ${STAGE_LABEL[req]} letter. Ed decides: reduce the case to the last notice actually mailed, or record proof of an earlier mailing.`,
        }, 'held_correction');
      }
      continue;
    }
    if (!req || v.source === 'vantaca_import') continue;
    if (priorEff.some((e) => e.state === 'mailed')) continue;
    // A prior that is only waiting for a batch confirmation is covered by that batch item.
    if (priorEff.some((e) => ['printed_unconfirmed', 'presumed_not_mailed'].includes(e.state))) continue;
    push('missing_notice', {
      kind: 'case', violation_id: v.id, community_id: v.community_id, street_address: v.street_address, stage: v.current_stage,
      action: prior.length
        ? `The ${STAGE_LABEL[req]} letter on this case was never mailed. Ed decides: mail it and keep the stage, or reduce the case to ${STAGE_LABEL[req]}.`
        : `The case is at ${STAGE_LABEL[v.current_stage]} but no ${STAGE_LABEL[req]} letter is on file. Find proof it was mailed outside TrustEd, or Ed reduces the stage.`,
    }, 'held_correction');
  }
  const counts = Object.keys(BUCKETS).reduce((m, k) => { m[k] = items.filter((i) => i.bucket === k).length; return m; }, {});
  return { items, counts, buckets: BUCKETS, as_of: today || null };
}

module.exports = {
  effectiveMailing, isMailed, loadMailingContext, latestEvidenceByLetter, activeHoldsByLetter, scopeFor,
  summarizeBatches, validateBatchConfirmation, buildWorkQueue, batchKey, centralDate, BUCKETS,
  EVIDENCE_REQUIRED_FROM, isClickTimeStamp,
  mailingCategory, CATEGORY_LABEL, cureDeadlineFlags, loadOpenReviewHolds,
};
