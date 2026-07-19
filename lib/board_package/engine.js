// ===========================================================================
// board_package/engine.js  (Ed 2026-07-18) — "Paige", the board-ops engine.
// ---------------------------------------------------------------------------
// Encodes the standard best-practice board package once (the DEFAULT_PROFILE),
// lets each association override it (communities.board_package_config), then
// validates a packet like a seasoned CAM: per-item verdict + the reasons. The
// system chases and checks; a human keeps judgment, confidentiality, and final
// approval (the finalize/reopen lifecycle).
//
// SINGLE SOURCE OF TRUTH (Ed 2026-07-19): this file's DEFAULT_SECTIONS is the
// canonical registry of WHICH board-packet sections exist and how each one is
// sourced. The `board_packet_section_templates` DB table (which SEEDS the
// per-packet board_packet_sections rows and is the FK target for
// section_key) is a projection of this list — every registry key MUST have a
// template row, and vice versa. That equality is enforced by
// tests/test_board_package_registry.js (live check), so the two can never
// silently drift again. This is the fix for the class of bug where readiness
// scored a section that assemble could not seed/fill (five Financials sections,
// commit fec366f) — the registry and the templates are now generated-in-sync.
//
// When you ADD or REMOVE a section: edit DEFAULT_SECTIONS here, then write a
// numbered migration that INSERTs/retires the matching template row (service_role
// is read-only on the templates table — see migration 315 for the pattern), and
// if it is `source:'native'` also add an autoFillSection handler + a
// nativeContext probe (the registry test asserts those sets stay equal).
// ===========================================================================

// The standard package structure, numbered like the physical board book.
// ---------------------------------------------------------------------------
// source semantics (drives readiness verdicts AND the auto-fill contract):
//   'native'     = trustEd already owns the data; assemble auto-fills it from a
//                  live module. Every native section MUST have an
//                  autoFillSection handler, a nativeContext probe, and a
//                  template row. The set of native sections == the set assemble
//                  can fill == FILLABLE (asserted by the registry test).
//   'upload'     = a human provides a document (management report, legal memo).
//   'ai'         = AI drafts the copy from the rest of the packet (exec summary,
//                  action items, vendor activity narrative).
//   'manual'     = a human curates the content (board-decision items).
//   'structural' = fixed scaffolding that is always present (cover page); never
//                  a data-readiness punch-list item.
// confidentiality: 'open' | 'exec' | 'legal'  · period = financial-cutoff sensitive.
// `template` = the DB template-row attributes this section projects to (used to
//   generate/seed board_packet_section_templates). display_name is the
//   board-FACING title; `label` above is the operator-facing readiness label.
const DEFAULT_SECTIONS = [
  // ---- Cover & Agenda -----------------------------------------------------
  { key: 'cover',            label: 'Cover page',                       group: 'Cover & Agenda',  required: false, source: 'structural', owner: 'manager',    confidentiality: 'open',
    template: { display_name: 'Cover Page', default_order: 10, required_default: true, supports_manual: true, supports_upload: false, supports_auto_trusted: true, supports_ai_generated: false, default_audience: 'both' } },
  { key: 'agenda',           label: 'Draft agenda',                     group: 'Cover & Agenda',  required: true,  source: 'native', owner: 'manager',    confidentiality: 'open',
    template: { display_name: 'Agenda', default_order: 20, required_default: true, supports_manual: true, supports_upload: true, supports_auto_trusted: true, supports_ai_generated: false, default_audience: 'both' } },
  { key: 'prior_minutes',    label: 'Prior open-session minutes',       group: 'Cover & Agenda',  required: true,  source: 'native', owner: 'manager',    confidentiality: 'open',
    template: { display_name: 'Prior Meeting Minutes', default_order: 30, required_default: true, supports_manual: true, supports_upload: true, supports_auto_trusted: true, supports_ai_generated: true, default_audience: 'both' } },
  { key: 'prior_exec_minutes', label: 'Prior executive-session minutes', group: 'Cover & Agenda', required: false, source: 'upload', owner: 'manager',    confidentiality: 'exec',
    template: { display_name: 'Prior Executive-Session Minutes', default_order: 35, required_default: false, supports_manual: true, supports_upload: true, supports_auto_trusted: false, supports_ai_generated: false, default_audience: 'board' } },
  { key: 'action_items',     label: 'Open action-item report',          group: 'Cover & Agenda',  required: true,  source: 'ai', owner: 'manager',    confidentiality: 'open',
    template: { display_name: 'Action Items & Watch Outs', default_order: 100, required_default: true, supports_manual: true, supports_upload: true, supports_auto_trusted: false, supports_ai_generated: false, default_audience: 'both' } },
  // ---- Executive summary --------------------------------------------------
  { key: 'exec_summary',     label: 'Executive summary',                group: 'Summary',         required: false, source: 'ai', owner: 'manager',    confidentiality: 'open',
    template: { display_name: 'Executive Summary', default_order: 40, required_default: true, supports_manual: true, supports_upload: true, supports_auto_trusted: false, supports_ai_generated: true, default_audience: 'both' } },
  // ---- Financials ---------------------------------------------------------
  { key: 'financials',       label: 'Financial statements (legacy)',    group: 'Financials',      required: false, source: 'upload', owner: 'accounting', confidentiality: 'open', legacy: true,
    template: { display_name: 'Financial Statements (legacy combined)', default_order: 45, required_default: false, supports_manual: true, supports_upload: false, supports_auto_trusted: false, supports_ai_generated: false, default_audience: 'both' } },
  { key: 'balance_sheet',    label: 'Balance sheet',                    group: 'Financials',      required: true,  source: 'native', owner: 'accounting', confidentiality: 'open', period: true,
    template: { display_name: 'Balance Sheet', default_order: 50, required_default: true, supports_manual: true, supports_upload: false, supports_auto_trusted: true, supports_ai_generated: true, default_audience: 'both' } },
  { key: 'income_statement', label: 'Income statement vs. budget',      group: 'Financials',      required: true,  source: 'native', owner: 'accounting', confidentiality: 'open', period: true,
    template: { display_name: 'Income Statement', default_order: 55, required_default: true, supports_manual: true, supports_upload: false, supports_auto_trusted: true, supports_ai_generated: true, default_audience: 'both' } },
  { key: 'bank_rec',         label: 'Bank-reconciliation status',       group: 'Financials',      required: true,  source: 'native', owner: 'accounting', confidentiality: 'open', period: true,
    template: { display_name: 'Bank-reconciliation status', default_order: 60, required_default: true, supports_manual: false, supports_upload: true, supports_auto_trusted: true, supports_ai_generated: false, default_audience: 'both' } },
  { key: 'ar_aging',         label: 'Accounts-receivable aging',        group: 'Financials',      required: true,  source: 'native', owner: 'accounting', confidentiality: 'open', period: true,
    template: { display_name: 'Delinquencies / AR Aging', default_order: 70, required_default: true, supports_manual: true, supports_upload: true, supports_auto_trusted: true, supports_ai_generated: false, default_audience: 'board' } },
  { key: 'delinquency',      label: 'Delinquency & collections',        group: 'Financials',      required: true,  source: 'native', owner: 'accounting', confidentiality: 'open', period: true,
    template: { display_name: 'Delinquency & collections', default_order: 72, required_default: true, supports_manual: true, supports_upload: true, supports_auto_trusted: true, supports_ai_generated: false, default_audience: 'board' } },
  { key: 'ap_approval',      label: 'AP / invoice approval list',       group: 'Financials',      required: true,  source: 'native', owner: 'accounting', confidentiality: 'open', period: true,
    template: { display_name: 'AP / invoice approval list', default_order: 73, required_default: true, supports_manual: false, supports_upload: true, supports_auto_trusted: true, supports_ai_generated: false, default_audience: 'both' } },
  { key: 'reserve_activity', label: 'Reserve activity & cash balances', group: 'Financials',      required: true,  source: 'native', owner: 'accounting', confidentiality: 'open', period: true,
    template: { display_name: 'Reserve activity & cash balances', default_order: 74, required_default: true, supports_manual: false, supports_upload: true, supports_auto_trusted: true, supports_ai_generated: false, default_audience: 'both' } },
  // ---- Operations ---------------------------------------------------------
  { key: 'drv',              label: 'Violation & §209 status',          group: 'Operations',      required: true,  source: 'native', owner: 'compliance', confidentiality: 'open',
    template: { display_name: 'Deed Restriction Violations', default_order: 75, required_default: false, supports_manual: false, supports_upload: true, supports_auto_trusted: true, supports_ai_generated: false, default_audience: 'board' } },
  { key: 'arc_decisions',    label: 'ACC / architectural activity',     group: 'Operations',      required: true,  source: 'native', owner: 'compliance', confidentiality: 'open',
    template: { display_name: 'ARC Decisions', default_order: 90, required_default: false, supports_manual: true, supports_upload: true, supports_auto_trusted: true, supports_ai_generated: false, default_audience: 'both' } },
  { key: 'vendor_activity',  label: 'Vendor & contract updates',        group: 'Operations',      required: false, source: 'ai', owner: 'manager',    confidentiality: 'open',
    template: { display_name: 'Vendor Activity', default_order: 80, required_default: false, supports_manual: false, supports_upload: false, supports_auto_trusted: false, supports_ai_generated: true, default_audience: 'both' } },
  { key: 'management_report', label: 'Management report',               group: 'Operations',      required: true,  source: 'upload', owner: 'manager',    confidentiality: 'open',
    template: { display_name: 'Management Report', default_order: 85, required_default: true, supports_manual: true, supports_upload: true, supports_auto_trusted: false, supports_ai_generated: false, default_audience: 'both' } },
  { key: 'legal_matters',    label: 'Legal matters (privileged)',       group: 'Operations',      required: false, source: 'upload', owner: 'compliance', confidentiality: 'legal',
    template: { display_name: 'Legal Matters (privileged)', default_order: 95, required_default: false, supports_manual: true, supports_upload: true, supports_auto_trusted: false, supports_ai_generated: false, default_audience: 'board' } },
  // ---- Board decisions ----------------------------------------------------
  { key: 'board_decisions',  label: 'Items requiring board approval',   group: 'Board Decisions', required: true,  source: 'manual', owner: 'manager',    confidentiality: 'open',
    template: { display_name: 'Items Requiring Board Approval', default_order: 105, required_default: true, supports_manual: true, supports_upload: false, supports_auto_trusted: false, supports_ai_generated: true, default_audience: 'both' } },
  // ---- Appendix -----------------------------------------------------------
  { key: 'appendix',         label: 'Appendix',                         group: 'Appendix',        required: false, source: 'upload', owner: 'manager',    confidentiality: 'open',
    template: { display_name: 'Appendix', default_order: 110, required_default: false, supports_manual: true, supports_upload: true, supports_auto_trusted: false, supports_ai_generated: false, default_audience: 'both' } },
];

const DEFAULT_PROFILE = {
  meeting_cadence: 'monthly',
  financial_cutoff: 'prior_month_end',
  due_offsets: { create: -10, collect: -7, first_check: -5, review_draft: -3, lock: -1 }, // business days from meeting
  board_preferences: { summary_first: true },
  sections: DEFAULT_SECTIONS,
};

// The canonical key set + the native (auto-fillable) subset. Consumers derive
// their lists from these so there is exactly ONE place that decides "what are
// the sections" and "which ones does trustEd fill itself."
const SECTION_KEYS = DEFAULT_SECTIONS.map((s) => s.key);
function nativeSectionKeys() {
  return DEFAULT_SECTIONS.filter((s) => s.source === 'native').map((s) => s.key);
}

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

  // NON-NATIVE sections (upload / ai / manual): someone (or the AI) has to
  // provide the content. Its presence on the packet section row is the signal.
  if (!section) return { status: 'missing', detail: item.source === 'upload' ? 'awaiting upload' : 'not drafted yet' };
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
  // Auto-fillable = required sections trustEd pulls itself (source 'native').
  // This is the count that MUST equal what assemble can fill — the invariant
  // that keeps readiness honest about what will actually appear in the packet.
  const autoItems = req.filter((i) => i.source === 'native');
  const summary = {
    required_total: req.length,
    ready,
    needs_attention: blocking.length,
    needs_confirmation: req.filter((i) => i.validation_status === 'needs_confirmation').length,
    auto_fillable: autoItems.length,
    auto_fillable_ready: autoItems.filter((i) => i.validation_status === 'ready').length,
    pct_ready: req.length ? Math.round((ready / req.length) * 100) : 0,
    is_package_ready: blocking.length === 0,
  };
  return { summary, items };
}

module.exports = {
  DEFAULT_PROFILE, DEFAULT_SECTIONS, SECTION_KEYS, nativeSectionKeys,
  getProfile, financialCutoff, buildReadiness, verdictFor,
};
