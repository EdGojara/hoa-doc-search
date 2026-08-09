// =============================================================================
// lib/board/motion_notify.js  (Ed 2026-08-09)
// -----------------------------------------------------------------------------
// Board motion notifications: pull board members to the portal instead of
// chasing email threads. Three kinds:
//   - 'opened'   : a new motion needs your vote
//   - 'reminder' : you haven't voted yet (manager nudge / scheduled)
//   - 'result'   : the motion passed / failed
//
// KILL SWITCH: env BOARD_NOTIFY_ENABLED must equal '1' to actually send. While
// off (default), every notice is LOGGED with status='suppressed' so Ed can see
// exactly what would go out before one email reaches a real board member. The
// motion flow never breaks if notifications fail — every path is best-effort.
// =============================================================================
const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('../notifications/email');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const PORTAL_BASE = (process.env.TRUSTED_URL || '').replace(/\/+$/, '');

function notifyEnabled() { return process.env.BOARD_NOTIFY_ENABLED === '1'; }

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Bedrock-branded shell. Plain, professional board notice — no em-dashes in
// customer copy (house style), commas instead.
function shell(bodyHtml, ctaLabel, ctaUrl) {
  const cta = ctaUrl ? `<p style="margin:22px 0;"><a href="${esc(ctaUrl)}" style="display:inline-block;background:#0B1D34;color:#fff;padding:12px 22px;border-radius:7px;text-decoration:none;font-weight:600;">${esc(ctaLabel)}</a></p>` : '';
  return `<div style="font-family:Inter,-apple-system,Segoe UI,sans-serif;color:#1a2230;max-width:560px;">
    ${bodyHtml}${cta}
    <p style="color:#64748b;font-size:11px;margin-top:26px;padding-top:14px;border-top:1px solid #e2e8f0;">
      Bedrock Association Management, board portal notification.<br>You are receiving this as a member of the board.
    </p></div>`;
}

function buildEmail(kind, { motion, communityName, recipientName, tally }) {
  const who = recipientName ? recipientName.split(' ')[0] : 'there';
  const url = PORTAL_BASE ? `${PORTAL_BASE}/board-portal` : '';
  const title = esc(motion.title);
  const comm = esc(communityName || 'your community');
  if (kind === 'opened') {
    return {
      subject: `Board vote needed: ${motion.title}`,
      html: shell(
        `<p>Hi ${esc(who)},</p>
         <p>A new motion is open for the ${comm} board and needs your vote:</p>
         <p style="font-size:16px;font-weight:600;color:#0B1D34;">${title}</p>
         ${motion.description ? `<p style="color:#475569;">${esc(motion.description)}</p>` : ''}
         <p>Open the board portal to cast your vote and see how the board stands.</p>`,
        'Cast your vote', url),
    };
  }
  if (kind === 'reminder') {
    return {
      subject: `Reminder, your board vote is needed: ${motion.title}`,
      html: shell(
        `<p>Hi ${esc(who)},</p>
         <p>This is a reminder that the ${comm} board motion below is still open and we do not yet have your vote:</p>
         <p style="font-size:16px;font-weight:600;color:#0B1D34;">${title}</p>
         ${tally ? `<p style="color:#475569;">So far, ${tally.for} for, ${tally.against} against, ${tally.abstain} abstain${tally.quorum && !tally.quorum_met ? ', quorum not yet reached' : ''}.</p>` : ''}
         <p>Please open the board portal to weigh in.</p>`,
        'Vote now', url),
    };
  }
  // result
  const passed = motion.status === 'passed';
  return {
    subject: `Board motion ${passed ? 'passed' : 'decided'}: ${motion.title}`,
    html: shell(
      `<p>Hi ${esc(who)},</p>
       <p>The ${comm} board motion below has closed:</p>
       <p style="font-size:16px;font-weight:600;color:#0B1D34;">${title}</p>
       <p style="font-size:15px;font-weight:700;color:${passed ? '#1a7a3c' : '#b42318'};">Result: ${esc((motion.status || '').toUpperCase())}</p>
       ${tally ? `<p style="color:#475569;">${tally.for} for, ${tally.against} against, ${tally.abstain} abstain.</p>` : ''}
       ${motion.outcome_note ? `<p style="color:#475569;">${esc(motion.outcome_note)}</p>` : ''}
       <p>The decision is recorded in the board portal and will appear in the minutes.</p>`,
      'View in the board portal', url),
  };
}

async function communityName(communityId) {
  try {
    const { data } = await supabase.from('communities').select('name').eq('id', communityId).maybeSingle();
    return data ? data.name : null;
  } catch (_) { return null; }
}

// recipients: [{ email, name }]. Best-effort; never throws.
async function enqueueMotionNotifications(motion, kind, recipients, opts = {}) {
  const out = { queued: 0, sent: 0, suppressed: 0, failed: 0, skipped_duplicate: 0 };
  try {
    const enabled = notifyEnabled();
    const cName = opts.communityName || await communityName(motion.community_id);
    for (const r of (recipients || [])) {
      const email = String(r && r.email || '').trim().toLowerCase();
      if (!email) continue;
      const { subject, html } = buildEmail(kind, { motion, communityName: cName, recipientName: r.name, tally: opts.tally });

      // Log first (dedup on opened/result via the unique index).
      let rowId = null;
      try {
        const { data, error } = await supabase.from('board_motion_notifications')
          .insert({
            motion_id: motion.id, community_id: motion.community_id,
            recipient_email: email, recipient_name: r.name || null,
            kind, channel: 'email', subject, status: 'pending',
          }).select('id').single();
        if (error) {
          if (/duplicate|unique/i.test(error.message || '')) { out.skipped_duplicate++; continue; }
          throw error;
        }
        rowId = data.id;
      } catch (e) { console.warn('[motion_notify] log insert failed:', e.message); continue; }
      out.queued++;

      if (!enabled) {
        await supabase.from('board_motion_notifications')
          .update({ status: 'suppressed', detail: 'BOARD_NOTIFY_ENABLED off' }).eq('id', rowId);
        out.suppressed++;
        continue;
      }
      const send = await sendEmail({ to: email, subject, html, tags: [{ name: 'module', value: 'board_motion' }, { name: 'event', value: kind }] });
      if (send && send.ok) {
        await supabase.from('board_motion_notifications')
          .update({ status: 'sent', sent_at: new Date().toISOString(), vendor_message_id: send.vendor_message_id || null }).eq('id', rowId);
        out.sent++;
      } else {
        await supabase.from('board_motion_notifications')
          .update({ status: 'failed', detail: (send && send.error) || 'unknown' }).eq('id', rowId);
        out.failed++;
      }
    }
  } catch (e) {
    console.warn('[motion_notify] enqueue failed (non-fatal):', e.message);
  }
  return out;
}

module.exports = { enqueueMotionNotifications, notifyEnabled };
