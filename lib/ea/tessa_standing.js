// ============================================================================
// lib/ea/tessa_standing.js  (Ed 2026-08-01)
// ----------------------------------------------------------------------------
// Standing instructions: recurring emails Ed set up once and Tessa sends on
// schedule without being re-asked. The scheduler's tessa_standing job calls
// runDueStandingTasks() once a day (after its targetHour); this fires any task
// whose schedule matches today (daily / weekly weekday / monthly day-of-month)
// and hasn't already run today. Sends as Tessa (or Ed), logs to the Sent view.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const graphSend = require('../email/graph_send');
const supabaseDefault = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Central-time parts of a date, so "the 1st" means the 1st in Houston.
function centralParts(d = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
      .formatToParts(d).map((p) => [p.type, p.value]),
  );
  return { ymd: `${parts.year}-${parts.month}-${parts.day}`, dom: Number(parts.day), dow: DOW[parts.weekday] };
}

// Is this task due today? (The daily tick already gates once-per-day; last_run_at
// is the belt so a second tick the same day never re-sends.)
function isDue(task, cp = centralParts()) {
  if (task.last_run_at && centralParts(new Date(task.last_run_at)).ymd === cp.ymd) return false;
  if (task.freq === 'daily') return true;
  if (task.freq === 'weekly') return Number(task.day_of_week) === cp.dow;
  if (task.freq === 'monthly') return Math.min(28, Number(task.day_of_month) || 1) === cp.dom;
  return false;
}

async function resolveRecipients(task, supabase) {
  if (task.recipients_spec === 'team') {
    const { data } = await supabase.from('user_profiles').select('email, is_active').neq('is_active', false).limit(500);
    return [...new Set((data || []).map((u) => u.email).filter((e) => e && EMAIL_RE.test(e)))];
  }
  return [...new Set(String(task.to_emails || '').split(/[,;]/).map((s) => s.trim()).filter((s) => EMAIL_RE.test(s)))];
}

// Send one task now (used by the due-runner and the manual "send test"). Stamps
// last_run_at + logs to the Sent view. Returns { sent, to } or throws.
async function sendOneTask(task, supabase) {
  const to = await resolveRecipients(task, supabase);
  if (!to.length) return { sent: false, reason: 'no_recipients' };
  const asEd = false;  // Tessa sends as herself, always.
  const from = asEd ? graphSend.ED_MAILBOX : graphSend.TESSA_MAILBOX;
  let html, attachments;
  if (asEd) {
    html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a2230;">${String(task.body).split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px;">${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`).join('')}</div>`;
  } else {
    ({ html, attachments } = require('../email/tessa_signature').buildTessaEmail(String(task.body)));
  }
  await graphSend.sendAs({ from, to, subject: task.subject, html, attachments });
  // Stamp last_run_at FIRST so a crash after send can't loop-send it.
  await supabase.from('ea_standing_tasks').update({ last_run_at: new Date().toISOString() }).eq('id', task.id);
  try {
    await supabase.from('email_messages').insert({
      mailbox: from, direction: 'outbound', sender_email: from, sender_name: asEd ? 'Ed Gojara' : 'Tessa McCall (Bedrock EA)',
      recipients: to, subject: task.subject, body_preview: String(task.body).slice(0, 2000), body_full: String(task.body),
      classification: 'outbound_standing', classification_confidence: 'high', persona: 'tessa',
      ai_summary: `Standing task "${task.title}" sent to ${to.length} recipient(s)`,
      triage_status: 'handled', record_ownership: 'workpaper', reviewed_by: 'tessa-standing', reviewed_at: new Date().toISOString(),
    });
  } catch (_) { /* log best-effort */ }
  return { sent: true, to };
}

async function runDueStandingTasks({ supabase = supabaseDefault } = {}) {
  const summary = { checked: 0, sent: 0, skipped: 0, errors: 0 };
  if (!graphSend.isConfigured()) return { ...summary, note: 'email_not_configured' };
  const cp = centralParts();
  const { data: tasks, error } = await supabase.from('ea_standing_tasks').select('*').eq('active', true).limit(200);
  if (error) return { ...summary, error: error.message };
  for (const task of (tasks || [])) {
    summary.checked += 1;
    try {
      if (!isDue(task, cp)) { summary.skipped += 1; continue; }
      const r = await sendOneTask(task, supabase);
      if (r.sent) summary.sent += 1; else summary.skipped += 1;
    } catch (e) { summary.errors += 1; console.warn('[tessa_standing] task failed:', task.id, e.message); }
  }
  return summary;
}

// Send a task immediately (manual test), ignoring the schedule.
async function runTaskNow(id, { supabase = supabaseDefault } = {}) {
  const { data: task, error } = await supabase.from('ea_standing_tasks').select('*').eq('id', id).single();
  if (error || !task) return { sent: false, reason: 'not_found' };
  return sendOneTask(task, supabase);
}

module.exports = { runDueStandingTasks, runTaskNow, isDue, centralParts };
