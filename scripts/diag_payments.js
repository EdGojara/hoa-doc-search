require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
(async () => {
  const { data: recent, error } = await supabase
    .from('payments')
    .select('id, product_type, fee_type, payee, amount_cents, status, processor_session_id, community_id, created_at')
    .order('created_at', { ascending: false })
    .limit(15);
  console.log('error:', error && error.message);
  console.log('recent payments:', JSON.stringify(recent, null, 2));

  // Probe the product_type CHECK by attempting a no-commit style check: read constraint via RPC if available, else try a dry insert into a temp.
  // Simpler: try inserting a throwaway assessment_payment row and see if the constraint rejects it.
  const probe = {
    community_id: (recent && recent[0] && recent[0].community_id) || '00000000-0000-0000-0000-000000000000',
    product_type: 'assessment_payment', fee_type: 'assessment', payee: 'community_association',
    amount_cents: 1, method: 'stripe_checkout', processor: 'stripe',
    processor_session_id: 'cs_probe_DELETEME', status: 'pending', initiated_by: 'diag',
  };
  const { data: ins, error: insErr } = await supabase.from('payments').insert(probe).select('id').single();
  if (insErr) console.log('PROBE insert error:', insErr.code, insErr.message);
  else { console.log('PROBE insert OK id=', ins.id, '-> assessment_payment IS allowed; deleting probe'); await supabase.from('payments').delete().eq('id', ins.id); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
