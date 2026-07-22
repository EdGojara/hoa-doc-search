// Backfill: archive attachments from inbound emails already in the system, so
// what homeowners have already sent (Andrea's boundary photos, etc.) is viewable
// on the record. Idempotent — safe to re-run. Requires migration 328.
// Usage: node scripts/backfill_email_attachments.js [sender_email]
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { archiveInboundAttachments } = require('../lib/email/archive_attachments');

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const onlySender = process.argv[2] || null;

(async () => {
  // Guard: table must exist.
  const { error: tErr } = await s.from('email_attachments').select('id').limit(1);
  if (tErr) { console.error('email_attachments table not found — apply migration 328 first. (' + tErr.message + ')'); process.exit(1); }

  let q = s.from('email_messages')
    .select('id, mailbox, graph_id, has_attachments, sender_email, subject, community_id, resolved_property_id, resolved_contact_id, direction')
    .eq('direction', 'inbound').eq('has_attachments', true)
    .order('received_at', { ascending: false });
  if (onlySender) q = q.ilike('sender_email', onlySender);
  const { data: msgs, error } = await q.limit(2000);
  if (error) { console.error('load ERR:', error.message); process.exit(1); }
  console.log(`inbound emails with attachments${onlySender ? ' from ' + onlySender : ''}: ${msgs.length}`);

  let totalFiles = 0, done = 0, stale = 0, already = 0;
  for (const m of msgs) {
    const r = await archiveInboundAttachments(m);
    if (r.reason === 'exists') { already++; continue; }
    if (r.archived > 0) { totalFiles += r.archived; done++; console.log(`  ✓ ${r.archived} from "${(m.subject || '').trim().slice(0, 40)}" <${m.sender_email}>`); }
    else if (r.reason === 'fetch_failed' || r.error) { stale++; }
  }
  console.log(`\nDone. Archived ${totalFiles} file(s) across ${done} email(s). ${already} already archived, ${stale} unfetchable (filed/stale id).`);
})();
