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

const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

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

function renderHtml(rows, todayLabel) {
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

function renderText(rows, todayLabel) {
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
  return `Monthly AR cadence — ${todayLabel}\n\n${lines}\n\nUpload month-end Vantaca AR reports at: ${(process.env.PUBLIC_BASE_URL || 'https://trustedhoa.com')}/#tab-ownerar\n`;
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

  const to = process.env.AR_REMINDER_TO;
  if (!to) {
    // Still want this visible — log the would-have-sent body to Render logs
    // so Ed sees it even before he configures the env var.
    console.warn('[ar_reminder] AR_REMINDER_TO not set — logging email body instead of sending');
    console.log('[ar_reminder] would-send (text):\n' + renderText(rows, todayLabel));
    return { fired: false, reason: 'AR_REMINDER_TO not configured', row_count: rows.length };
  }
  if (!isConfigured()) {
    console.warn('[ar_reminder] Resend not configured — skipping send');
    return { fired: false, reason: 'resend_not_configured', row_count: rows.length };
  }

  const result = await sendEmail({
    to,
    subject: `Monthly AR cadence — ${todayLabel}`,
    html: renderHtml(rows, todayLabel),
    text: renderText(rows, todayLabel),
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
};
