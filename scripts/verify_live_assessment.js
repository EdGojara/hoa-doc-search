// Inspects the REAL latest assessment payment (created by an actual Stripe
// checkout + webhook) to confirm the production chain worked: ledger row marked
// succeeded by the webhook, GL entry posted, AR subledger row written, balance
// dropped. READ-ONLY by default; pass --cleanup to delete the $1 test artifacts.
//   node scripts/verify_live_assessment.js            (inspect)
//   node scripts/verify_live_assessment.js --cleanup  (inspect + remove $1 test)
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { resolveCurrentAR } = require('../lib/ar/resolve_current_ar');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const CLEANUP = process.argv.includes('--cleanup');
const log = (...a) => console.log(...a);

(async () => {
  const { data: rows } = await supabase
    .from('payments')
    .select('id, processor_session_id, processor_payment_id, community_id, product_id, fee_type, payee, amount_cents, status, paid_at, processor_metadata, created_at')
    .eq('product_type', 'assessment_payment')
    .order('created_at', { ascending: false })
    .limit(10);
  if (!rows || !rows.length) { log('No assessment_payment rows yet. Run the $1 test checkout.'); process.exit(0); }

  const sessionId = rows[0].processor_session_id;
  const sess = rows.filter((r) => r.processor_session_id === sessionId);
  const asmt = sess.find((r) => r.fee_type === 'assessment');
  log('=== Latest session ===', sessionId);
  sess.forEach((r) => log(`  ${r.fee_type.padEnd(15)} ${r.amount_cents}c  [${r.status}]${r.processor_metadata && r.processor_metadata.gl_deferred ? '  GL-DEFERRED: ' + r.processor_metadata.gl_deferred_reason : ''}`));
  const webhookFired = sess.every((r) => r.status === 'succeeded');
  log(webhookFired ? '\n✓ Webhook fired — ledger rows marked succeeded' : '\n✗ Rows still pending — webhook has NOT fired (check STRIPE_WEBHOOK_SECRET + deploy)');

  if (!asmt) { log('No assessment fee row.'); process.exit(0); }
  const communityId = asmt.community_id, propertyId = asmt.product_id;

  // GL entry for this session
  const { data: je } = await supabase
    .from('journal_entries')
    .select('id, reference, posting_date, total_debits_cents, total_credits_cents, status')
    .eq('community_id', communityId).eq('source_module', 'payment_intake').eq('source_reference', sessionId).maybeSingle();
  if (je) {
    const { data: lines } = await supabase.from('journal_entry_lines').select('account_id, debit_cents, credit_cents').eq('journal_entry_id', je.id);
    const { data: accts } = await supabase.from('chart_of_accounts').select('id, account_number').eq('community_id', communityId);
    const num = Object.fromEntries((accts || []).map((a) => [a.id, String(a.account_number)]));
    log(`\n✓ GL posted: ${je.reference} ${je.posting_date}  Dr ${je.total_debits_cents}/Cr ${je.total_credits_cents}`);
    (lines || []).forEach((l) => log(`    ${num[l.account_id]}  Dr ${l.debit_cents}  Cr ${l.credit_cents}`));
  } else {
    log('\n✗ No GL entry for this session yet.');
  }

  // AR subledger row
  const { data: sub } = await supabase
    .from('homeowner_transactions').select('id, amount_cents, transaction_date, description')
    .contains('raw_row_jsonb', { stripe_session_id: sessionId }).maybeSingle();
  log(sub ? `\n✓ AR subledger row: ${sub.amount_cents}c on ${sub.transaction_date}` : '\n✗ No AR subledger row for this session.');

  const ar = await resolveCurrentAR(supabase, { propertyId });
  log('\nHomeowner current balance:', ar && ar.balance_cents, 'c (source=' + (ar && ar.source) + ')');

  if (CLEANUP) {
    log('\n--- cleanup ($1 test artifacts) ---');
    if (je) { await supabase.from('journal_entry_lines').delete().eq('journal_entry_id', je.id); await supabase.from('journal_entries').delete().eq('id', je.id); log('  deleted JE', je.reference); }
    if (sub) { await supabase.from('homeowner_transactions').delete().eq('id', sub.id); log('  deleted subledger row'); }
    await supabase.from('payments').delete().eq('processor_session_id', sessionId); log('  deleted payment ledger rows');
    const { data: batch } = await supabase.from('transaction_upload_batches').select('id').eq('community_id', communityId).eq('period_label', 'Online Payments').eq('source_format', 'manual').maybeSingle();
    if (batch) { const { count } = await supabase.from('homeowner_transactions').select('id', { count: 'exact', head: true }).eq('source_batch_id', batch.id); if (!count) { await supabase.from('transaction_upload_batches').delete().eq('id', batch.id); log('  deleted empty online-payments batch'); } }
    log('  cleanup done.');
  }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
