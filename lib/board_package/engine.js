// ===========================================================================
// board_package/engine.js  (Ed 2026-07-18) — "Paige", the board-ops engine.
// ---------------------------------------------------------------------------
// Encodes the standard best-practice board package once (the DEFAULT_PROFILE),
// lets each association override it (communities.board_package_config), then
// validates a packet like a seasoned CAM: per-item verdict + the reasons. The
// system chases and checks; a human keeps judgment, confidentiality, and final
// approval (the finalize/reopen lifecycle).
// ===========================================================================

// The standard package structure, numbered like the physical board book.
// source: 'native' = trustEd already has the data · 'upload' = someone provides it.
// confidentiality: 'open' | 'exec' | 'legal'  · period = financial-cutoff sensitive.
const DEFAULT_SECTIONS = [
  { key: 'agenda',           label: 'Draft agenda',                     group: 'Cover & Agenda',  required: true,  source: 'native', owner: 'manager',    confidentiality: 'open' },
  { key: 'prior_minutes',    label: 'Prior open-session minutes',       group: 'Cover & Agenda',  required: true,  source: 'native', owner: 'manager',    confidentiality: 'open' },
  { key: 'prior_exec_minutes', label: 'Prior executive-session minutes', group: 'Cover & Agenda', required: false, source: 'native', owner: 'manager',    confidentiality: 'exec' },
  { key: 'action_items',     label: 'Open action-item report',          group: 'Cover & Agenda',  required: true,  source: 'native', owner: 'manager',    confidentiality: 'open' },
  { key: 'balance_sheet',    label: 'Balance sheet',                    group: 'Financials',      required: true,  source: 'native', owner: 'accounting', confidentiality: 'open', period: true },
  { key: 'income_statement', label: 'Income statement vs. budget',      group: 'Financials',      required: true,  source: 'native', owner: 'accounting', confidentiality: 'open', period: true },
  { key: 'bank_rec',         label: 'Bank-reconciliation status',       group: 'Financials',      required: true,  source: 'native', owner: 'accounting', confidentiality: 'open', period: true },
  { key: 'ar_aging',         label: 'Accounts-receivable aging',        group: 'Financials',      required: true,  source: 'native', owner: 'accounting', confidentiality: 'open', period: true },
  { key: 'delinquency',      label: 'Delinquency & collections',        group: 'Financials',      required: true,  source: 'native', owner: 'accounting', confidentiality: 'open', period: true },
  { key: 'ap_approval',      label: 'AP / invoice approval list',       group: 'Financials',      required: true,  source: 'native', owner: 'accounting', confidentiality: 'open', period: true },
  { key: 'reserve_activity', label: 'Reserve activity & cash balances', group: 'Financials',      required: true,  source: 'native', owner: 'accounting', confidentiality: 'open', period: true },
  { key: 'management_report', label: 'Management report',               group: 'Operations',      required: true,  source: 'upload', owner: 'manager',    confidentiality: 'open' },
  { key: 'vendor_activity',  label: 'Vendor & contract updates',        group: 'Operations',      required: true,  source: 'native', owner: 'manager',    confidentiality: 'open' },
  { key: 'arc_decisions',    label: 'ACC / architectural activity',     group: 'Operations',      required: true,  source: 'native', owner: 'compliance', confidentiality: 'open' },
  { key: 'drv',              label: 'Violation & §209 status',          group: 'Operations',      required: true,  source: 'native', owner: 'compliance', confidentiality: 'open' },
  { key: 'legal_matters',    label: 'Legal matters (privileged)',       group: 'Operations',      required: false, source: 'upload', owner: 'compliance', confidentiality: 'legal' },
  { key: 'board_decisions',  label: 'Items requiring board approval',   group: 'Board Decisions', required: true,  source: 'native', owner: 'manager',    confidentiality: 'open' },
];

const DEFAULT_PROFILE = {
  meeting_cadence: 'monthly',
  financial_cutoff: 'prior_month_end',
  due_offsets: { create: -10, collect: -7, first_check: -5, review_draft: -3, lock: -1 }, // business days from meeting
  board_preferences: { summary_first: true },
  sections: DEFAULT_SECTIONS,
};

// Merge a community's stored overrides on top of the default (encode-once,
// tweak-per-association). Overrides can flip `required`, change `owner`, or add
// sections keyed by `key`.
function getProfile(community) {
  const cfg = (community && community.board_package_config) || {};
  const base = { ...DEFAULT_PROFILE, ...cfg };
  const bySection = new Map(DEFAULT_SECTIONS.map((s) => [s.key, { ...s }]));
  for (const ov of (cfg.sections || [])) {
    if (bySection.has(ov.key)) Object.assign(bySection.get(ov.key), ov);
    else bySection.set(ov.key, ov);
  }
  base.sections = [...bySection.values()];
  return base;
}

// The financial cutoff date (period the financials must tie to).
function financialCutoff(profile, meetingDate) {
  const md = meetingDate ? new Date(meetingDate + 'T12:00:00Z') : new Date();
  if ((profile.financial_cutoff || 'prior_month_end') === 'prior_month_end') {
    // last day of the month before the meeting's month
    return new Date(Date.UTC(md.getUTCFullYear(), md.getUTCMonth(), 0)).toISOString().slice(0, 10);
  }
  return null;
}

// Validate one required section against its live section row + context.
// ctx: { cutoff, priorMeetingDate, native: {<key>: {present, period, count}} }
function verdictFor(item, section, ctx) {
  if (!item.required) return { status: 'not_required', detail: 'optional section' };
  if (section && section.status === 'skipped') return { status: 'not_required', detail: 'skipped for this meeting' };

  // Confidentiality: exec/legal material must be board-only, never open handout.
  if ((item.confidentiality === 'exec' || item.confidentiality === 'legal') && section && section.audience && section.audience !== 'board') {
    return { status: 'restricted', detail: `marked ${item.confidentiality} but audience='${section.audience}' — must be board-only` };
  }

  // NATIVE sections: trustEd owns the data, so live-data availability is the
  // primary signal. Present = ready to auto-assemble; absent = genuinely missing.
  if (item.source === 'native') {
    const nat = (ctx.native && ctx.native[item.key]) || null;
    if (!nat || nat.present === false) return { status: 'missing', detail: (nat && nat.reason) || 'no live data for this period' };
    if (item.period && nat.period && ctx.cutoff && nat.period !== ctx.cutoff) {
      return { status: 'wrong_period', detail: `data period ${nat.period} ≠ cutoff ${ctx.cutoff}` };
    }
    if (item.key === 'prior_minutes' && ctx.priorMeetingDate && nat.minutes_meeting_date && nat.minutes_meeting_date !== ctx.priorMeetingDate) {
      return { status: 'wrong_period', detail: `minutes are for ${nat.minutes_meeting_date}, not the immediately-prior meeting ${ctx.priorMeetingDate}` };
    }
    return { status: 'ready', detail: nat.count != null ? `${nat.count} record(s) from trustEd` : 'available from trustEd' };
  }

  // UPLOAD sections: someone has to provide the document.
  if (!section) return { status: 'missing', detail: 'awaiting upload' };
  const hasData = !!(section.input_data || section.rendered_html || section.source_document_id);
  if (!hasData) return { status: 'missing', detail: 'no content yet' };
  // "final" in a filename is not proof it's final.
  if (section.extraction_confidence != null && Number(section.extraction_confidence) < 0.6) {
    return { status: 'needs_confirmation', detail: `low extraction confidence (${section.extraction_confidence})` };
  }
  return { status: 'ready', detail: null };
}

// Build the readiness report for a packet: every profile item + its verdict.
function buildReadiness(profile, sectionsByKey, ctx) {
  const items = profile.sections.map((item) => {
    const sec = sectionsByKey.get(item.key) || null;
    const v = verdictFor(item, sec, ctx);
    return {
      key: item.key, label: item.label, group: item.group, required: item.required,
      source: item.source, owner: item.owner, confidentiality: item.confidentiality,
      validation_status: v.status, detail: v.detail,
    };
  });
  const req = items.filter((i) => i.required);
  const ready = req.filter((i) => i.validation_status === 'ready').length;
  const blocking = req.filter((i) => ['missing', 'wrong_period', 'incomplete', 'restricted', 'duplicate'].includes(i.validation_status));
  const summary = {
    required_total: req.length,
    ready,
    needs_attention: blocking.length,
    needs_confirmation: req.filter((i) => i.validation_status === 'needs_confirmation').length,
    pct_ready: req.length ? Math.round((ready / req.length) * 100) : 0,
    is_package_ready: blocking.length === 0,
  };
  return { summary, items };
}

module.exports = { DEFAULT_PROFILE, DEFAULT_SECTIONS, getProfile, financialCutoff, buildReadiness, verdictFor };
