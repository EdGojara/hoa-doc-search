// ============================================================================
// lib/board/discussion_digest.js  (Ed 2026-08-09)
// ----------------------------------------------------------------------------
// The ONE email board discussion sends: a quiet, at-most-once-per-window digest
// ("you have N new board messages"), never one email per message. Unread is
// tracked per reader; a member is only emailed if they have unread AND haven't
// been digested within the window. Kill-switched with the rest of board email.
// The in-portal unread badges are the primary, zero-noise signal; this is just
// the nudge for members who aren't looking at the portal.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('../notifications/email');
const { unreadCount } = require('../../api/board_threads');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const PORTAL_BASE = (process.env.TRUSTED_URL || '').replace(/\/+$/, '');

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function sendBoardDigests({ windowHours = 20 } = {}) {
  const stats = { candidates: 0, sent: 0, suppressed: 0, skipped: 0 };
  const enabled = process.env.BOARD_NOTIFY_ENABLED === '1';
  try {
    const { data: seats, error } = await supabase.from('board_members')
      .select('email, name, community_id').eq('is_active', true).eq('management_company_id', BEDROCK_MGMT_CO_ID).not('email', 'is', null);
    if (error) throw error;
    const byEmail = {};
    for (const s of (seats || [])) {
      const e = String(s.email).trim().toLowerCase();
      (byEmail[e] = byEmail[e] || { name: s.name, communities: new Set() });
      if (s.community_id) byEmail[e].communities.add(s.community_id);
    }
    const cutoff = Date.now() - windowHours * 3600 * 1000;

    for (const [email, info] of Object.entries(byEmail)) {
      const { data: d } = await supabase.from('board_digest_sent').select('last_digest_at').eq('reader_email', email).maybeSingle();
      if (d && new Date(d.last_digest_at).getTime() > cutoff) { stats.skipped++; continue; }

      const { data: threads } = await supabase.from('board_threads').select('id').in('community_id', [...info.communities]);
      let unread = 0;
      for (const t of (threads || [])) unread += await unreadCount(t.id, email);
      if (!unread) { stats.skipped++; continue; }
      stats.candidates++;

      if (!enabled) { stats.suppressed++; continue; } // don't record → they get it once enabled
      const first = String(info.name || '').split(' ')[0] || 'there';
      const url = PORTAL_BASE ? `${PORTAL_BASE}/board-portal` : '';
      const send = await sendEmail({
        to: email,
        subject: `${unread} new board message${unread === 1 ? '' : 's'}`,
        html: `<div style="font-family:Inter,-apple-system,sans-serif;color:#1a2230;max-width:520px;">
          <p>Hi ${esc(first)},</p>
          <p>There ${unread === 1 ? 'is' : 'are'} <b>${unread}</b> new message${unread === 1 ? '' : 's'} in your board discussion.</p>
          <p>Open the board portal to catch up and reply. This is a once-a-day summary, not a message-by-message alert.</p>
          ${url ? `<p style="margin:20px 0;"><a href="${esc(url)}" style="display:inline-block;background:#0B1D34;color:#fff;padding:12px 22px;border-radius:7px;text-decoration:none;font-weight:600;">Open the board discussion</a></p>` : ''}
        </div>`,
        tags: [{ name: 'module', value: 'board_discussion' }, { name: 'event', value: 'digest' }],
      });
      if (send && send.ok) {
        stats.sent++;
        await supabase.from('board_digest_sent').upsert({ reader_email: email, last_digest_at: new Date().toISOString() }, { onConflict: 'reader_email' });
      } else { stats.suppressed++; }
    }
  } catch (e) {
    console.warn('[discussion_digest] failed:', e.message);
    return { ...stats, error: e.message };
  }
  return stats;
}

module.exports = { sendBoardDigests };
