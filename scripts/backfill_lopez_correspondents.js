// One-time: link Maria Lopez's known addresses + thread onto the consolidated
// ACC case (EAG-ARC-2026-0001 / 9c843745). Run AFTER migration 351 is applied.
// Idempotent + column-tolerant (no-op if 351 not yet applied).
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { captureCorrespondent } = require('../lib/acc/match_open_application');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

(async () => {
  const SURVIVOR = '9c843745-a0aa-4d7d-a182-4057b3cb2dbd';
  // Her active gmail, the yahoo on her form, and the cc'd family address.
  const emails = ['lpzmartaxes@gmail.com', 'LPZMAR555@yahoo.com', 'lpz.mitchell@gmail.com'];
  // The acc@ Graph conversation for the Floral Crest thread.
  const { data: em } = await s.from('email_messages')
    .select('conversation_id').ilike('subject', '%FLORAL CREST%')
    .order('received_at', { ascending: false }).limit(1).maybeSingle();
  const res = await captureCorrespondent(s, {
    decisionId: SURVIVOR, emails, name: 'Simon and Maria Lopez',
    conversationId: em && em.conversation_id, isInternalAddr: () => false,
  });
  console.log('backfill:', JSON.stringify(res));
  if (res.reason === 'columns_absent') console.log('→ apply migration 351 first, then re-run.');
  const { data } = await s.from('acc_decisions').select('correspondent_emails, conversation_id').eq('id', SURVIVOR).maybeSingle().catch(() => ({ data: null }));
  if (data) console.log('now:', JSON.stringify(data));
})();
