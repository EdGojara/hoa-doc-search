// ============================================================================
// lib/builder_arc/rules.js  (Ed 2026-11-25)
// ----------------------------------------------------------------------------
// Annie's architectural review of ONE builder lot submission, as a pure
// function: facts in, documented findings + a recommendation out. No I/O, so
// every rule is unit-tested (tests/test_builder_arc_review.js) against the
// real Still Creek Ranch cases that exposed the gaps.
//
// Annie RECOMMENDS. She never decides: builder decisions stay Ed's (the
// finalize routes enforce that). Her recommendation is one of
//   approve             every check passed; ready for Ed's one-click approval
//   request_more_info   the builder must send something (listed, with a draft)
//   manual_review       Ed's judgment is needed (a guideline conflict) or
//                       Bedrock must fix a record before a letter can issue
// She never recommends a denial on her own.
//
// Finding severities:
//   blocker     a letter cannot issue until fixed (fix_by says who)
//   needs_info  the builder must supply or correct something
//   guideline   the submission conflicts with a community guideline: Ed decides
//   note        context for the decision (revision history, deadlines, precedent)
//   ok          a check that passed (shown so the review is auditable)
// ============================================================================
const { normalizeMaterials, colorKey } = require('./materials');

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
// "Five" -> "5", "5" -> "5", "C4" -> "C4"
// A packet read may return the whole label ("Still Creek Ranch Section Five",
// "Lot 8"): keep only the value after the last section / lot / block word.
const normId = (v) => {
  let s = String(v == null ? '' : v).trim();
  const m = /\b(?:section|sec\.?|lot|block|blk\.?)\s+([A-Za-z0-9]+)\s*$/i.exec(s);
  if (m) s = m[1];
  const w = WORDS[s.toLowerCase()];
  return w ? String(w) : s;
};
const UNKNOWN = (v) => { const s = String(v == null ? '' : v).trim(); return !s || /^(unknown|n\/a|-|null)$/i.test(s); };
const same = (a, b) => normId(a).toUpperCase() === normId(b).toUpperCase();

function parseAddress(addr) {
  const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(String(addr || '').split(',')[0]);
  if (!m) return { number: null, street: String(addr || '').trim().toLowerCase() };
  return { number: Number(m[1]), street: m[2].toLowerCase().replace(/\s+/g, ' ').replace(/\b(lane|ln)\b/, 'lane').replace(/\b(trail|trl)\b/, 'trail') };
}

function homeOf(app) {
  const m = normalizeMaterials(app.application_data || {});
  const a = parseAddress(app.street_address);
  return {
    id: app.id, ref: app.reference_number, address: app.street_address, number: a.number, street: a.street,
    side: a.number == null ? null : a.number % 2, block: String(app.block_number || '').trim() || null,
    lot: /^\d+$/.test(String(app.lot_number || '').trim()) ? Number(app.lot_number) : null,
    plan: String(app.plan_number || '').trim().toUpperCase() || null, elevation: String(app.elevation || '').trim().toUpperCase() || null,
    brick: colorKey(m.brick_color), brickLabel: m.brick_color || null,
    trim: colorKey(m.trim_color), trimLabel: m.trim_color || null,
    field: colorKey(m.paint_color || m.siding_color), fieldLabel: m.paint_color || m.siding_color || null,
    status: app.status, submitted_at: app.submitted_at, decided_at: app.decided_at || null,
  };
}

// Homes on the same street side and block, keyed by lot number. A newer
// submission for the same address replaces the older one (it is what will be
// built), and the subject's own address is excluded.
function streetscape(subject, others) {
  const s = homeOf(subject);
  const byAddr = new Map();
  for (const o of others || []) {
    if (!o || o.id === subject.id) continue;
    if (['denied', 'withdrawn', 'info_requested'].includes(o.status)) continue;
    const h = homeOf(o);
    if (h.street !== s.street || h.side !== s.side || h.block !== s.block || h.lot == null || h.number === s.number) continue;
    const prev = byAddr.get(h.number);
    if (!prev || new Date(h.submitted_at) > new Date(prev.submitted_at)) byAddr.set(h.number, h);
  }
  return { subject: s, homes: [...byAddr.values()] };
}

/**
 * Repetition checks for `subject` against `homes` (same street side + block).
 * Returns violations: [{ code, other, between, detail }]
 */
function repetitionViolations(s, homes, rep) {
  if (!rep || s.lot == null) return [];
  const out = [];
  for (const h of homes) {
    const between = Math.abs(h.lot - s.lot) - 1;
    const samePlan = s.plan && h.plan && s.plan === h.plan;
    const sameElev = samePlan && s.elevation && h.elevation && s.elevation === h.elevation;
    if (sameElev && rep.same_plan_same_elevation_min_lots_between != null && between < rep.same_plan_same_elevation_min_lots_between) {
      out.push({ code: 'repeat_same_elevation_spacing', other: h, between, detail: `Plan ${s.plan} elevation ${s.elevation} repeats with only ${between} home${between === 1 ? '' : 's'} between (at least ${rep.same_plan_same_elevation_min_lots_between} required)` });
    }
    const window = rep.same_plan_same_elevation_color_window_lots_between ?? 8;
    if (sameElev && rep.same_plan_same_elevation_requires_different_brick_and_trim && between <= window
        && ((s.brick && h.brick && s.brick === h.brick) || (s.trim && h.trim && s.trim === h.trim))) {
      const sameWhat = [s.brick && s.brick === h.brick ? `brick (${s.brickLabel})` : null, s.trim && s.trim === h.trim ? `trim (${s.trimLabel})` : null].filter(Boolean).join(' and ');
      out.push({ code: 'repeat_same_elevation_colors', other: h, between, detail: `Same plan and elevation as ${h.address} (${between} homes between) with the same ${sameWhat}; brick and trim must be different when an elevation repeats` });
    }
    if (samePlan && !sameElev && rep.same_plan_different_elevation_min_lots_between != null && between < rep.same_plan_different_elevation_min_lots_between) {
      out.push({ code: 'repeat_plan_spacing', other: h, between, detail: `Plan ${s.plan} repeats (elevation ${h.elevation} vs ${s.elevation}) with only ${between} home${between === 1 ? '' : 's'} between (at least ${rep.same_plan_different_elevation_min_lots_between} required)` });
    }
    if (s.brick && h.brick && s.brick === h.brick) {
      if (between === 0 && rep.adjacent_identical_brick_prohibited) out.push({ code: 'adjacent_brick', other: h, between, detail: `Same brick as the adjacent home (${s.brickLabel})` });
      else if (rep.brick_repeat_min_lots_between != null && between < rep.brick_repeat_min_lots_between) out.push({ code: 'brick_repeat_spacing', other: h, between, detail: `Brick ${s.brickLabel} repeats with only ${between} homes between (at least ${rep.brick_repeat_min_lots_between} required)` });
    }
    if (between === 0 && rep.adjacent_trim_or_field_color_must_vary) {
      const trimSame = s.trim && h.trim && s.trim === h.trim;
      const fieldSame = s.field && h.field && s.field === h.field;
      if (trimSame && fieldSame) out.push({ code: 'adjacent_colors', other: h, between, detail: `Same trim (${s.trimLabel}) and field color (${s.fieldLabel}) as the adjacent home; trim and/or field color must vary` });
    }
  }
  return out;
}

const SEV_ORDER = { blocker: 0, needs_info: 1, guideline: 2, note: 3, ok: 4 };

/**
 * @param {object} input
 *   app            builder_applications row (with application_data)
 *   packet         readPacket() result or null (no packet on file)
 *   standards      communities.builder_arc_standards.review or null
 *   neighbors      other builder_applications rows in the community (any status)
 *   approvedPool   approved rows in the community (precedent check); defaults to neighbors
 *   priorAtAddress earlier decided rows at the same address (revision history)
 *   letterCheck    validateApplicationForLetter() result AFTER corrections
 *   deadlines      computeDeadlines() result
 */
function evaluate(input) {
  const { app, packet, standards, neighbors = [], priorAtAddress = [], letterCheck, deadlines } = input;
  const approvedPool = input.approvedPool || neighbors.filter((n) => String(n.status || '').startsWith('approved'));
  const findings = [];
  const corrections = {};
  const add = (f) => findings.push({ fix_by: null, ref: null, ...f });
  const facts = (packet && packet.facts) || null;

  // ---- 0. Standards on file ------------------------------------------------
  if (!standards) {
    add({ code: 'no_standards', severity: 'blocker', fix_by: 'bedrock', title: 'Community review standards are not configured',
      detail: 'This community has no builder review standards on file (communities.builder_arc_standards.review), so Annie cannot check guideline compliance. Configure them from the governing documents before relying on a review.' });
  }

  // ---- 1. Packet -------------------------------------------------------------
  if (!packet) {
    add({ code: 'no_packet', severity: 'needs_info', fix_by: 'builder', title: 'No submission packet on file', detail: 'No plot plan or application PDF is attached, so the lot, plan and site details cannot be verified.' });
  } else {
    if ((packet.errors || []).length && !facts) add({ code: 'packet_unreadable', severity: 'blocker', fix_by: 'bedrock', title: 'Packet could not be read', detail: packet.errors.join('; ') });
    for (const c of (facts && facts.document_conflicts) || []) {
      add({ code: 'packet_self_conflict', severity: 'needs_info', fix_by: 'builder', title: 'The packet contradicts itself', detail: c, ask: `A corrected plot plan for ${app.street_address}: ${c}` });
    }
    const flags = (facts && facts.model_flags) || [];
    if (flags.length) add({ code: 'packet_observations', severity: 'note', title: "Annie's reading notes (unverified)", detail: flags.join(' | ') });
    for (const c of (facts && facts.read_conflicts) || []) {
      add({ code: 'packet_read_conflict', severity: 'note', title: `Two reads of the packet disagree on ${c.field}`, detail: `Text layer: ${c.text_layer}; document read: ${c.model}. Not used for any correction.` });
    }
  }

  // ---- 2. Identity: application vs packet -----------------------------------
  const ident = [['lot_number', 'lot', 'Lot'], ['block_number', 'block', 'Block'], ['section_number', 'section', 'Section'], ['plan_number', 'plan_number', 'Plan'], ['elevation', 'elevation', 'Elevation']];
  const effective = { ...app };
  if (facts) {
    for (const [col, fk, label] of ident) {
      const av = app[col]; const pv = facts[fk];
      if (UNKNOWN(av) && !UNKNOWN(pv)) {
        corrections[col] = normId(pv);
        effective[col] = corrections[col];
        add({ code: `fill_${col}`, severity: 'ok', title: `${label} taken from the packet`, detail: `The application had no ${label.toLowerCase()} ("${av == null ? '' : av}"); the packet shows ${pv}.` });
      } else if (!UNKNOWN(av) && !UNKNOWN(pv) && !same(av, pv)) {
        add({ code: `mismatch_${col}`, severity: 'needs_info', fix_by: 'builder', title: `${label} on the application does not match the packet`, detail: `Application: ${av}. Packet: ${pv}.`, ask: `Confirm the ${label.toLowerCase()} for ${app.street_address}: the application says ${av} and the plot plan says ${pv}.` });
      }
    }
    if (facts.street_address && app.street_address) {
      const a = parseAddress(app.street_address); const p = parseAddress(facts.street_address);
      if (a.number != null && p.number != null && a.number !== p.number) {
        add({ code: 'mismatch_address', severity: 'needs_info', fix_by: 'builder', title: 'Address on the application does not match the packet', detail: `Application: ${app.street_address}. Packet: ${facts.street_address}.`, ask: `Confirm the address: the application says ${app.street_address} and the plot plan says ${facts.street_address}.` });
      }
    }
    if (facts.orientation && app.elevation_orientation && !same(String(app.elevation_orientation)[0], facts.orientation)) {
      add({ code: 'mismatch_orientation', severity: 'note', title: 'Garage handing differs', detail: `Application: ${app.elevation_orientation}. Plot plan: ${facts.orientation === 'L' ? 'left' : 'right'}. The plot plan governs the site layout.` });
    }
  }

  // ---- 3. Letter readiness (validator, after corrections) --------------------
  if (letterCheck && Array.isArray(letterCheck.errors)) {
    for (const e of letterCheck.errors) {
      const planName = /Plan name is blank/i.test(e);
      add({ code: planName ? 'plan_name_missing' : 'letter_blocked', severity: 'blocker', fix_by: planName ? 'bedrock' : 'bedrock',
        title: planName ? 'The approved plan has no name on file' : 'An approval letter cannot issue yet', detail: e });
    }
  }

  // ---- 4. Site plan checks -------------------------------------------------
  if (standards && facts) {
    const max = Number(standards.max_lot_coverage_pct);
    const cov = facts.impervious_coverage_pct;
    if (Number.isFinite(max) && cov != null) {
      if (cov > max) add({ code: 'lot_coverage_exceeded', severity: 'guideline', fix_by: 'ed', ref: standards.lot_coverage_ref, title: 'Lot coverage exceeds the limit', detail: `Plot plan shows ${cov}% impervious coverage; the limit is ${max}%.` });
      else add({ code: 'lot_coverage_ok', severity: 'ok', ref: standards.lot_coverage_ref, title: `Lot coverage ${cov}% (limit ${max}%)`, detail: '' });
    } else if (Number.isFinite(max)) {
      const req = (standards.required_submittal || []).some((r) => r.key === 'lot_coverage');
      add({ code: 'lot_coverage_missing', severity: req ? 'needs_info' : 'note', fix_by: req ? 'builder' : null, ref: standards.lot_coverage_ref, title: 'Lot coverage not shown', detail: 'The plot plan does not show a lot coverage figure.', ask: req ? `The lot coverage calculation for ${app.street_address}.` : null });
    }
    const fenceReq = (standards.required_submittal || []).find((r) => r.key === 'fence');
    if (fenceReq) {
      const f = String(facts.fence || '');
      const statesSpec = /\d+\s*('|ft|foot|feet)/i.test(f) && /(wood|cedar|iron|metal|masonry|vinyl|brick)/i.test(f);
      if (!statesSpec) add({ code: 'fence_detail', severity: 'note', ref: fenceReq.ref, title: 'Fence height and material not stated', detail: `${fenceReq.label || 'The guidelines ask for the location, height and material of each fence.'} The plot plan shows ${f ? `"${f}"` : 'no fence note'}. Earlier approvals accepted the builder's standard fence specification.` });
    }
  }

  // ---- 5. Materials ----------------------------------------------------------
  // An application with no materials at all (an emailed packet entered by
  // hand) takes them from the packet's own application form.
  const form = (facts && facts.form) || {};
  if (!require('./materials').hasMaterials(app.application_data || {})) {
    const fill = {};
    for (const k of ['brick', 'paint', 'trim', 'stone', 'siding', 'shingles']) { const v = form[k]; if (v != null && String(v).trim() && !/^(full brick|n\/?a|none)$/i.test(String(v).trim())) fill[k] = String(v).trim(); }
    // Only a real application form counts: a brick AND a paint or siding
    // selection, and never a plot-plan note like 'FULL BRICK STD.' (8015
    // Misty Maple, 2026-11-25: the plot plan's construction note was read as
    // a brick color).
    const noteLike = (v) => /(full\s*brick|brick\s*std|std\.?$|standard)/i.test(String(v || ''));
    if (fill.brick && noteLike(fill.brick)) delete fill.brick;
    if (!(fill.brick && (fill.paint || fill.siding))) for (const k of Object.keys(fill)) delete fill[k];
    if (Object.keys(fill).length) {
      corrections.application_data = { ...(app.application_data || {}), ...fill };
      effective.application_data = corrections.application_data;
      add({ code: 'fill_materials', severity: 'ok', title: "Exterior selections taken from the packet's application form", detail: Object.entries(fill).map(([k, v]) => `${k}: ${v}`).join('; ') });
    }
  }
  if (standards && Array.isArray(standards.required_materials)) {
    const m = normalizeMaterials(effective.application_data || {});
    const missing = [];
    const odd = [];
    const want = { brick: m.brick_color, paint_or_siding: m.paint_color || m.siding_color, trim: m.trim_color, shingles: m.shingle_color || m.roof_color };
    const label = { brick: 'brick', paint_or_siding: 'paint or siding color', trim: 'trim color', shingles: 'shingle color' };
    for (const k of standards.required_materials) {
      const v = want[k];
      if (v == null) missing.push(label[k] || k);
      else if (String(v).replace(/[^a-z0-9]/gi, '').length < 2) odd.push(`${label[k] || k} "${v}"`);
    }
    // Selections the standards do not require: mention, never request.
    const optional = Object.keys(want).filter((k) => !standards.required_materials.includes(k));
    const optNote = optional.map((k) => (want[k] == null ? `${label[k]} not listed` : (String(want[k]).replace(/[^a-z0-9]/gi, '').length < 2 ? `${label[k]} reads "${want[k]}"` : null))).filter(Boolean);
    if (optNote.length) add({ code: 'materials_optional', severity: 'note', ref: standards.materials_ref || null, title: 'Other selections', detail: `${optNote.join('; ')} (not required by the community's standards; confirm on the letter if you want it listed).` });
    if (missing.length) add({ code: 'materials_missing', severity: 'needs_info', fix_by: 'builder', ref: standards.materials_ref || null, title: 'Exterior selections missing', detail: `Not listed on the application: ${missing.join(', ')}.`, ask: `The ${missing.join(', ')} for ${app.street_address}.` });
    if (odd.length) add({ code: 'materials_unclear', severity: 'needs_info', fix_by: 'builder', ref: standards.materials_ref || null, title: 'Exterior selection unclear', detail: `Unreadable value: ${odd.join(', ')}.`, ask: `The full ${odd.join(', ')} name for ${app.street_address}.` });
  }

  // ---- 6. Repetition (streetscape) --------------------------------------------
  const rep = standards && standards.repetition;
  let precedentCount = 0;
  if (rep) {
    const scape = streetscape({ ...app, ...effective }, neighbors);
    const viol = repetitionViolations(scape.subject, scape.homes, rep);
    // Precedent: how many already-approved pairs in this community show the
    // same pattern. Context for Ed's judgment, never a reason to skip a rule.
    const precedent = {};
    for (const p of approvedPool) {
      const sc = streetscape(p, approvedPool);
      for (const v of repetitionViolations(sc.subject, sc.homes, rep)) {
        const key = v.code; const pair = [p.street_address, v.other.address].sort().join(' / ');
        (precedent[key] = precedent[key] || new Set()).add(pair);
      }
    }
    for (const v of viol) {
      const prec = precedent[v.code] ? [...precedent[v.code]] : [];
      precedentCount += prec.length;
      const otherState = String(v.other.status || '').startsWith('approved') ? `approved ${v.other.ref}` : `also pending, ${v.other.ref}`;
      add({ code: v.code, severity: 'guideline', fix_by: 'ed', ref: rep.ref, title: `Repetition: ${v.other.address} (${otherState})`, detail: `${v.detail}.` + (prec.length ? ` Earlier approvals in this community with the same pattern: ${prec.slice(0, 4).join('; ')}${prec.length > 4 ? ` and ${prec.length - 4} more` : ''}.` : ' No earlier approval in this community has this pattern.') });
    }
    if (!viol.length && scape.subject.lot != null) add({ code: 'repetition_ok', severity: 'ok', ref: rep.ref, title: `Repetition rules met on this side of ${app.street_address ? app.street_address.replace(/^\d+\s+/, '') : 'the street'}`, detail: `Checked against ${scape.homes.length} home${scape.homes.length === 1 ? '' : 's'} in block ${scape.subject.block} that have submissions in trustEd. Lots decided before they were in trustEd are not included.` });
    add({ code: 'facing_not_checked', severity: 'note', ref: rep.ref, title: 'Facing lots not checked', detail: 'The guidelines also limit repeats on facing lots. trustEd has no map of which lots face each other, so that check is left to the reviewer. The street check covers only lots with submissions in trustEd; decisions filed before then are not included.' });
  }

  // ---- 7. Revision of an earlier decision -------------------------------------
  const prior = (priorAtAddress || []).filter((p) => p && p.id !== app.id && p.decided_at).sort((a, b) => new Date(b.decided_at) - new Date(a.decided_at));
  const revision_of = prior[0] || null;
  if (revision_of) {
    const changed = [];
    if (!same(revision_of.plan_number, effective.plan_number) || !same(revision_of.elevation, effective.elevation)) changed.push(`plan ${revision_of.plan_number} ${revision_of.elevation} to ${effective.plan_number} ${effective.elevation}`);
    add({ code: 'revision', severity: 'note', title: `Revises ${revision_of.reference_number} (${String(revision_of.status || '').replace(/_/g, ' ')} ${String(revision_of.decided_at).slice(0, 10)})`,
      detail: `${changed.length ? `Changes ${changed.join('; ')}. ` : ''}Approving this issues a replacement letter that names the earlier approval; the earlier approval and its letter stay on file unchanged.` });
  }

  // ---- 8. Deadlines -----------------------------------------------------------
  if (deadlines) {
    const parts = [`Bedrock target ${String(deadlines.target_due_at).slice(0, 10)}`];
    if (deadlines.limit_at) parts.push(`${deadlines.limit_days}-day review period ends ${String(deadlines.limit_at).slice(0, 10)}${deadlines.days_to_limit < 0 ? ` (passed ${-deadlines.days_to_limit} days ago)` : ` (${deadlines.days_to_limit} days left)`}`);
    add({ code: 'deadlines', severity: 'note', ref: standards && standards.legal_review_ref, title: 'Deadlines', detail: parts.join('; ') + '.' });
  }

  // ---- Recommendation ---------------------------------------------------------
  findings.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const blockers = findings.filter((f) => f.severity === 'blocker');
  const infos = findings.filter((f) => f.severity === 'needs_info');
  const guide = findings.filter((f) => f.severity === 'guideline');
  let recommended_action; let summary;
  if (blockers.length) {
    recommended_action = 'manual_review';
    summary = `Not ready: ${blockers.map((b) => b.title.toLowerCase()).join('; ')}.` + (infos.length ? ` The builder also needs to send ${infos.length} item${infos.length === 1 ? '' : 's'}.` : '');
  } else if (infos.length) {
    recommended_action = 'request_more_info';
    summary = `Request from the builder: ${infos.map((i) => i.title.toLowerCase()).join('; ')}.` + (guide.length ? ` Also ${guide.length} guideline question${guide.length === 1 ? '' : 's'} for your decision.` : '');
  } else if (guide.length) {
    recommended_action = 'manual_review';
    summary = `Your decision: ${guide.length} guideline question${guide.length === 1 ? '' : 's'} (${[...new Set(guide.map((g) => g.code))].join(', ').replace(/_/g, ' ')}). Everything else checks out.`;
  } else {
    recommended_action = 'approve';
    summary = 'Every check passed: the packet matches the application, the plan is approved at this community, and the streetscape rules are met. Ready for your approval.';
  }
  const asks = infos.map((i) => i.ask).filter(Boolean);
  const confidence = !packet ? 0.4 : (packet.text_layer && packet.text_layer.lot && packet.model_extracted) ? 0.9 : (packet.model_extracted || (packet.text_layer && packet.text_layer.lot)) ? 0.75 : 0.5;
  return { recommended_action, summary, findings, corrections, asks, revision_of: revision_of ? { id: revision_of.id, reference_number: revision_of.reference_number, decided_at: revision_of.decided_at, status: revision_of.status, plan_number: revision_of.plan_number, elevation: revision_of.elevation } : null, confidence, precedent_count: precedentCount };
}

// Builder-facing request (only drafted; a person sends it). No em-dashes.
function draftInfoRequest(app, result) {
  if (!result.asks || !result.asks.length) return null;
  const first = String(app.submitter_name || '').trim().split(/\s+/)[0] || 'there';
  return [
    `Hi ${first},`,
    '',
    `To finish the review of ${app.street_address} (${app.reference_number}), we need:`,
    '',
    ...result.asks.map((a, i) => `${i + 1}. ${a}`),
    '',
    'Reply here or upload a revised packet in the builder portal, and we will complete the review as soon as it arrives.',
  ].join('\n');
}

module.exports = { evaluate, draftInfoRequest, repetitionViolations, streetscape, homeOf, parseAddress };
