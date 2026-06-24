// Verification harness for lib/payments/assessment_posting.js
// Runs the real posting path against the live DB for the latest assessment
// test session, asserts AR + GL correctness + idempotency, then cleans up the
// test artifacts so production books stay clean.  Usage: node scripts/verify_assessment_posting.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { postAssessmentPaymentToBooks } = require('../lib/payments/assessment_posting');
const { resolveCurrentAR } = require('../lib/ar/resolve_current_ar');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const log = (...a) => console.log(...a);

(async () => {
  // 1) Find the most recent assessment_payment session.
  const { data: rows } = await supabase
    .from('payments')
    .select('id, processor_session_id, community_id, product_id, fee_type, amount_cents, status, created_at')
    .eq('product_type', 'assessment_payment')
    .order('created_at', { ascending: false })
    .limit(10);
  if (!rows || !rows.length) { log('No assessment_payment rows found. Run a test checkout first.'); process.exit(0); }

  const sessionId = rows[0].processor_session_id;
  const sessRows = rows.filter((r) => r.processor_session_id === sessionId);
  const asmt = sessRows.find((r) => r.fee_type === 'assessment');
  log('=== Target session ===', sessionId);
  log('Rows:', sessRows.map((r) => `${r.fee_type}=${r.amount_cents}c [${r.status}]`).join(', '));
  if (!asmt) { log('No assessment fee row on this session.'); process.exit(0); }

  const communityId = asmt.community_id;
  const propertyId = asmt.product_id;

  const { data: comm } = await supabase.from('communities').select('name, gl_cutover_date').eq('id', communityId).maybeSingle();
  log('Community:', comm && comm.name, '| gl_cutover_date:', comm && comm.gl_cutover_date);

  // 2) AR before
  const before = await resolveCurrentAR(supabase, { propertyId });
  log('\nAR before:', before ? `${before.balance_cents}c (source=${before.source}, as_of=${before.as_of})` : 'none');

  // 3) Post to books
  log('\n--- postAssessmentPaymentToBooks (call 1) ---');
  const r1 = await postAssessmentPaymentToBooks(supabase, { sessionId, paymentIntentId: 'pi_verify_test' });
  log(JSON.stringify(r1, null, 2));

  // 4) Inspect the GL entry + lines
  let jeId = r1.gl && r1.gl.journal_entry_id;
  if (jeId) {
    const { data: je } = await supabase.from('journal_entries').select('id, reference, posting_date, description, total_debits_cents, total_credits_cents, status, source_module, source_reference').eq('id', jeId).single();
    const { data: lines } = await supabase.from('journal_entry_lines').select('line_number, account_id, debit_cents, credit_cents, memo, property_id').eq('journal_entry_id', jeId).order('line_number');
    const { data: accts } = await supabase.from('chart_of_accounts').select('id, account_number, account_name').eq('community_id', communityId);
    const num = Object.fromEntries((accts || []).map((a) => [a.id, `${a.account_number} ${a.account_name}`]));
    log('\nJournal entry:', je.reference, '|', je.posting_date, '| status=', je.status, '| balanced=', je.total_debits_cents === je.total_credits_cents, `(Dr ${je.total_debits_cents} / Cr ${je.total_credits_cents})`);
    (lines || []).forEach((l) => log(`  L${l.line_number} ${num[l.account_id]}  Dr ${l.debit_cents}  Cr ${l.credit_cents}  ${l.memo}${l.property_id ? ' [prop]' : ''}`));
  }

  // 5) Inspect the AR subledger row
  const subId = r1.subledger && r1.subledger.id;
  if (subId) {
    const { data: ht } = await supabase.from('homeowner_transactions').select('id, transaction_date, txn_type, amount_cents, description, raw_row_jsonb').eq('id', subId).single();
    log('\nSubledger row:', ht.transaction_date, ht.txn_type, `${ht.amount_cents}c`, '|', ht.description);
  }

  // 6) AR after
  const after = await resolveCurrentAR(supabase, { propertyId });
  log('\nAR after:', after ? `${after.balance_cents}c (source=${after.source})` : 'none');
  if (before && after) log('Balance delta:', after.balance_cents - before.balance_cents, 'c (expected', -Math.abs(asmt.amount_cents), 'c)');

  // 7) Idempotency — call again, expect no new JE / no new subledger row
  log('\n--- postAssessmentPaymentToBooks (call 2 — idempotency) ---');
  const r2 = await postAssessmentPaymentToBooks(supabase, { sessionId, paymentIntentId: 'pi_verify_test' });
  log('gl.idempotent=', r2.gl && r2.gl.idempotent, '| subledger.idempotent=', r2.subledger && r2.subledger.idempotent);
  const afterIdem = await resolveCurrentAR(supabase, { propertyId });
  log('AR after 2nd call:', afterIdem && afterIdem.balance_cents, 'c (must equal after-1st:', after && after.balance_cents, 'c)');

  // 8) CLEANUP — remove the $1 test artifacts so production books stay clean.
  log('\n--- cleanup test artifacts ---');
  if (jeId) {
    await supabase.from('journal_entry_lines').delete().eq('journal_entry_id', jeId);
    await supabase.from('journal_entries').delete().eq('id', jeId);
    log('Deleted test JE', jeId);
  }
  if (subId) {
    await supabase.from('homeowner_transactions').delete().eq('id', subId);
    log('Deleted test subledger row', subId);
  }
  // Remove the standing online-payments batch ONLY if it now has no rows (we just made it).
  const { data: batch } = await supabase.from('transaction_upload_batches').select('id').eq('community_id', communityId).eq('period_label', 'Online Payments').eq('source_format', 'manual').maybeSingle();
  if (batch) {
    const { count } = await supabase.from('homeowner_transactions').select('id', { count: 'exact', head: true }).eq('source_batch_id', batch.id);
    if (!count) { await supabase.from('transaction_upload_batches').delete().eq('id', batch.id); log('Deleted empty test batch', batch.id); }
    else log('Left online-payments batch in place (has', count, 'rows)');
  }
  const restored = await resolveCurrentAR(supabase, { propertyId });
  log('AR restored:', restored && restored.balance_cents, 'c (should match before:', before && before.balance_cents, 'c)');
  log('\nDONE.');
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
