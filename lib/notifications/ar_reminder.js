// ============================================================================
// notifications/ar_reminder.js — monthly Owner-AR cadence nudge
// ----------------------------------------------------------------------------
// Fires on the 3rd of every Central-time month (after Vantaca's typical
// month-end close finishes) and emails Ed a per-community status of the last
// AR snapshot. Drives the operational habit that produces month-end snapshots
// for board packets — see project_owner_receivables.md.
//
// Logic:
//   - Pull staleness rows (same shape as /api/owner-ar/staleness)
//   - Build a per-community line with severity icon + last as-of date
//   - Send via existing Resend wiring (lib/notifications/email.js)
//   - Recipient: AR_REMINDER_TO env var (Ed's inbox). Falls back gracefully
//     when not configured — logs the would-have-sent body so it's visible
//     in Render logs.
//
// Scheduled by lib/scheduler.js — daily-mode job that checks the calendar
// inside the run function. Fires only on the 3rd, no-ops on other days.
// This keeps the scheduler framework simple (no monthly mode needed).
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const { sendEmail, isConfigured } = require('./email');
const { BRAND } = require('../brand');

const { BEDROCK_MGMT_CO_ID } = require('../company');

// Returns the Central-time date components — same helper pattern as scheduler.js
function centralParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

async function computeStaleness(supabase) {
  const { data: communities, error: cErr } = await supabase
    .from('communities')
    .select('id, name')
    .eq('management_company_id', BEDROCK_MGMT_CO_ID)
    .eq('active', true)
    .order('name');
  if (cErr) throw cErr;

  const { data: snaps, error: sErr } = await supabase
    .from('owner_ar_snapshots')
    .select('community_id, snapshot_date')
    .not('approved_at', 'is', null)
    .order('snapshot_date', { ascending: false })
    .limit(50000);
  if (sErr) throw sErr;

  const latestByCommunity = new Map();
  for (const s of (snaps || [])) {
    if (!latestByCommunity.has(s.community_id)) {
      latestByCommunity.set(s.community_id, s.snapshot_date);
    }
  }
  const today = new Date();
  const todayMs = Date.parse(today.toISOString().slice(0, 10) + 'T00:00:00Z');
  return (communities || []).map((c) => {
    const last = latestByCommunity.get(c.id) || null;
    const daysSince = last ? Math.floor((todayMs - Date.parse(last + 'T00:00:00Z')) / 86400000) : null;
    let severity;
    if (daysSince == null) severity = 'never_ingested';
    else if (daysSince <= 35) severity = 'current';
    else if (daysSince <= 60) severity = 'stale';
    else severity = 'very_stale';
    return { community_id: c.id, community_name: c.name, last_snapshot_date: last, days_since: daysSince, severity };
  });
}

function severityIcon(sev) {
  switch (sev) {
    case 'current': return '✓';
    case 'stale': return '⚠️';
    case 'very_stale': return '❌';
    case 'never_ingested': return '○';
    default: return '·';
  }
}

function severityLabel(sev) {
  switch (sev) {
    case 'current': return 'up to date';
    case 'stale': return 'overdue';
    case 'very_stale': return 'very overdue';
    case 'never_ingested': return 'never uploaded';
    default: return '';
  }
}

// Builder assessment coverage (GitHub #96), per community with a builder rule:
// covered-through date, active builder lots, lots behind / blocked, open
// conversion reconciling items. Same function the Home Sales card and the
// Operations Feed read (builder_coverage_status, migration 501). Never throws:
// a community it cannot read is listed as unreadable, not dropped.
async function builderCoverageSections(sb, asOf) {
  const { data: rules, error } = await sb.from('transfer_proration_builders').select('community_id, communities:community_id(name)').eq('active', true).order('community_id').limit(50);
  if (error) return /does not exist|42P01/i.test(error.message || '') ? [] : [{ community_name: '(builder coverage)', error: error.message }];
  const out = []; const seen = new Set();
  for (const r of rules || []) {
    if (seen.has(r.community_id)) continue; seen.add(r.community_id);
    const name = (r.communities && r.communities.name) || r.community_id;
    const { data: s, error: e } = await sb.rpc('builder_coverage_status', { p_community_id: r.community_id, p_as_of: asOf });
    if (e) { out.push({ community_name: name, error: e.message }); continue; }
    if (!s || !s.applies) continue;
    const lots = s.lots || [];
    out.push({ community_name: name, converted: !!s.converted, status: s.status, expected_through: s.expected_through || null,
      covered_through: lots.map((l) => l.covered_through).filter(Boolean).sort()[0] || null, lots: lots.length,
      problems: lots.filter((l) => l.severity !== 'ok').map((l) => ({ lot: l.street_address, covered_through: l.covered_through, severity: l.severity, reason: l.reason })),
      staged_run: s.staged_run || null, items: (s.open_reconciling_items || []).map((i) => ({ kind: i.kind, amount_cents: i.amount_cents, account: i.account_number, lot: i.detail && i.detail.lot })) });
  }
  return out;
}
const _money = (c) => `$${(Number(c) / 100).toFixed(2)}`;
const _itemText = (i) => (i.kind === 'deferral_residue' ? `${_money(i.amount_cents)} in ${i.account} outside the release schedule` : `${i.lot || 'a builder lot'}: no resolved builder position`);
const _probText = (p) => `${p.lot}: ${p.covered_through ? `through ${p.covered_through}` : 'no coverage'}${p.reason && p.reason !== 'behind' ? ` (${String(p.reason).replace(/_/g, ' ')})` : ''}`;
function builderHtml(sections) {
  if (!sections || !sections.length) return '';
  const icon = (s) => (s.error || s.status === 'red' ? '🔴' : s.status === 'amber' ? '🟡' : '🟢');
  const rows = sections.map((s) => `<div style="padding:8px 10px; border-bottom:1px solid #eee; font-size:13px;">${icon(s)} <strong>${s.community_name}</strong>
      <div style="font-size:12.5px; color:#475569; margin-top:2px;">${s.error ? `could not be read: ${s.error}` : !s.converted ? 'not converted yet; builder billing starts with the conversion'
        : `${s.lots} builder lot${s.lots === 1 ? '' : 's'} · covered through ${s.covered_through || '—'} (expected ${s.expected_through})${s.staged_run ? ' · an accrual run stopped part-way' : ''}`}
      ${(s.problems || []).length ? `<br>${s.problems.slice(0, 8).map(_probText).join('<br>')}${s.problems.length > 8 ? '<br>…' : ''}` : ''}
      ${(s.items || []).length ? `<br>Open reconciling items: ${s.items.map(_itemText).join('; ')}` : ''}</div></div>`).join('');
  return `<div style="margin-top:20px; font-family:Georgia, serif; font-size:16px; color:#0B1D34;">Builder assessments</div>
    <div style="font-size:12.5px; color:#64748b; margin:2px 0 6px;">Billed monthly at the builder rate from the conversion forward. A lot not covered through Dec 31 by Jan 5 is an exception.</div>${rows}`;
}
function builderText(sections) {
  if (!sections || !sections.length) return '';
  const line = (s) => `  ${s.community_name}: ${s.error ? `could not be read (${s.error})` : !s.converted ? 'not converted yet'
    : `${s.status.toUpperCase()} · ${s.lots} lots · covered through ${s.covered_through || '-'} (expected ${s.expected_through})${(s.problems || []).length ? ` · ${s.problems.map(_probText).join('; ')}` : ''}${(s.items || []).length ? ` · open items: ${s.items.map(_itemText).join('; ')}` : ''}`}`;
  return `\nBuilder assessments\n${sections.map(line).join('\n')}\n`;
}

function renderHtml(rows, todayLabel, builder = []) {
  // Sort: ones that need attention at the top
  const sevRank = { never_ingested: 0, very_stale: 1, stale: 2, current: 3 };
  const sorted = [...rows].sort((a, b) => {
    if (sevRank[a.severity] !== sevRank[b.severity]) return sevRank[a.severity] - sevRank[b.severity];
    return (b.days_since || -1) - (a.days_since || -1);
  });

  const lines = sorted.map((r) => {
    const ageStr = r.last_snapshot_date
      ? `last ${r.last_snapshot_date} · ${r.days_since}d ago · ${severityLabel(r.severity)}`
      : 'never uploaded — first ingest needed';
    return `<tr>
      <td style="padding:6px 10px; border-bottom:1px solid #eee; font-size:13px;">${severityIcon(r.severity)} ${r.community_name}</td>
      <td style="padding:6px 10px; border-bottom:1px solid #eee; font-size:12.5px; color:#475569;">${ageStr}</td>
    </tr>`;
  }).join('');

  const attentionCount = sorted.filter((r) => r.severity !== 'current').length;

  return `<!DOCTYPE html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif; color:#1a1a1a; background:#fafaf6; padding:20px;">
  <div style="max-width:620px; margin:0 auto; background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:24px;">
    <div style="font-family:Georgia, serif; font-size:22px; color:#0B1D34; margin-bottom:4px;">
      Monthly AR cadence — ${todayLabel}
    </div>
    <div style="font-size:13px; color:#64748b; margin-bottom:16px;">
      Vantaca AR Aging upload status across the portfolio.
      ${attentionCount === 0 ? 'All communities are current — nothing required.' : `${attentionCount} of ${sorted.length} communities need attention.`}
    </div>
    <table style="width:100%; border-collapse:collapse;">
      ${lines}
    </table>
    ${builderHtml(builder)}
    <div style="margin-top:18px; font-size:12px; color:#64748b; line-height:1.5;">
      <strong>Standing cadence:</strong> upload the month-end Vantaca AR Aging PDF for each community on the 3rd–5th of the month for the prior month's board package. Ad-hoc mid-month uploads are welcome and don't disturb the month-end snapshot — both versions coexist and each board package pulls its own period.
    </div>
    <div style="margin-top:14px;">
      <a href="${process.env.PUBLIC_BASE_URL || 'https://trustedhoa.com'}/#tab-ownerar"
         style="display:inline-block; background:#0B1D34; color:#fff; padding:10px 18px; border-radius:6px; text-decoration:none; font-size:13.5px; font-weight:600;">
        Open Owner Receivables
      </a>
    </div>
    <div style="margin-top:18px; font-size:11px; color:#94a3b8;">
      Sent automatically by ${BRAND && BRAND.service ? BRAND.service.name : 'Bedrock'}. Adjust cadence by editing the ar_monthly_reminder scheduler job.
    </div>
  </div>
</body></html>`;
}

function renderText(rows, todayLabel, builder = []) {
  const sevRank = { never_ingested: 0, very_stale: 1, stale: 2, current: 3 };
  const sorted = [...rows].sort((a, b) => {
    if (sevRank[a.severity] !== sevRank[b.severity]) return sevRank[a.severity] - sevRank[b.severity];
    return (b.days_since || -1) - (a.days_since || -1);
  });
  const lines = sorted.map((r) => {
    const ageStr = r.last_snapshot_date
      ? `last ${r.last_snapshot_date} · ${r.days_since}d ago · ${severityLabel(r.severity)}`
      : 'never uploaded';
    return `  ${severityIcon(r.severity)} ${r.community_name} — ${ageStr}`;
  }).join('\n');
  return `Monthly AR cadence — ${todayLabel}\n\n${lines}\n${builderText(builder)}\nUpload month-end Vantaca AR reports at: ${(process.env.PUBLIC_BASE_URL || 'https://trustedhoa.com')}/#tab-ownerar\n`;
}

/**
 * Fires the monthly AR cadence reminder if today is the 3rd of the month
 * (Central time). No-op on other days.
 *
 * Used as the run function of the ar_monthly_reminder scheduler job.
 * @returns {Promise<Object>} summary object for cron_runs.summary
 */
async function sendArMonthlyReminderIfDue({ supabase } = {}) {
  const sb = supabase || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const cp = centralParts(new Date());
  // Fire on the 3rd of the month (Central). Skip otherwise.
  if (cp.day !== 3) {
    return { fired: false, reason: `not the 3rd (day=${cp.day})` };
  }

  const rows = await computeStaleness(sb);
  const todayLabel = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'America/Chicago' });
  let builder = [];
  try { builder = await builderCoverageSections(sb, `${cp.year}-${String(cp.month).padStart(2, '0')}-${String(cp.day).padStart(2, '0')}`); }
  catch (e) { builder = [{ community_name: '(builder coverage)', error: e.message }]; }

  const to = process.env.AR_REMINDER_TO;
  if (!to) {
    // Still want this visible — log the would-have-sent body to Render logs
    // so Ed sees it even before he configures the env var.
    console.warn('[ar_reminder] AR_REMINDER_TO not set — logging email body instead of sending');
    console.log('[ar_reminder] would-send (text):\n' + renderText(rows, todayLabel, builder));
    return { fired: false, reason: 'AR_REMINDER_TO not configured', row_count: rows.length };
  }
  if (!isConfigured()) {
    console.warn('[ar_reminder] Resend not configured — skipping send');
    return { fired: false, reason: 'resend_not_configured', row_count: rows.length };
  }

  const result = await sendEmail({
    to,
    subject: `Monthly AR cadence — ${todayLabel}`,
    html: renderHtml(rows, todayLabel, builder),
    text: renderText(rows, todayLabel, builder),
    tags: [{ name: 'kind', value: 'ar_monthly_reminder' }],
  });

  return {
    fired: true,
    sent_to: to,
    row_count: rows.length,
    attention_count: rows.filter((r) => r.severity !== 'current').length,
    resend_ok: result.ok,
    resend_message_id: result.vendor_message_id || null,
    resend_error: result.error || null,
  };
}

module.exports = {
  sendArMonthlyReminderIfDue,
  computeStaleness,
  builderCoverageSections, builderHtml, builderText, renderHtml, renderText,
};
