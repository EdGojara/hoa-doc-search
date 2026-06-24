// Self-contained verification for lib/payments/assessment_posting.js.
// Inserts a synthetic assessment payment for a real live-GL property, posts it
// to AR + GL, asserts correctness + idempotency, then deletes every artifact so
// production books are untouched.  Usage: node scripts/verify_assessment_posting.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { postAssessmentPaymentToBooks } = require('../lib/payments/assessment_posting');
const { resolveCurrentAR } = require('../lib/ar/resolve_current_ar');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const log = (...a) => console.log(...a);
const SESSION = 'cs_verify_DELETEME_' + Date.now();
const ASMT = 100, FEE = 34; // $1.00 assessment + $0.34 card fee
let pass = true;
const check = (label, cond) => { log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) pass = false; };

(async () => {
  // 0) Constraint sanity — assessment_payment must now be allowed.
  // 1) Pick a live-GL community + a property with a vantaca_account_id.
  const { data: comms } = await supabase
    .from('communities').select('id, name, hoa_legal_name, gl_cutover_date, stripe_connected_account_id')
    .not('gl_cutover_date', 'is', null);
  const today = new Date().toISOString().slice(0, 10);
  const live = (comms || []).find((c) => String(c.gl_cutover_date).slice(0, 10) <= today);
  if (!live) { log('No live-GL community found.'); process.exit(1); }
  log('Live-GL community:', live.name, '| cutover', live.gl_cutover_date);

  const { data: props } = await supabase
    .from('properties').select('id, vantaca_account_id, street_address')
    .eq('community_id', live.id).not('vantaca_account_id', 'is', null).limit(1);
  if (!props || !props.length) { log('No property with vantaca_account_id.'); process.exit(1); }
  const prop = props[0];
  log('Property:', prop.street_address, '| acct', prop.vantaca_account_id);

  // 2) Insert synthetic payment rows (what create-checkout would have written).
  const rows = [
    { community_id: live.id, product_type: 'assessment_payment', product_id: prop.id, fee_type: 'assessment',
      payee: 'community_association', payee_display_name: live.hoa_legal_name || live.name,
      connected_account_id: live.stripe_connected_account_id, amount_cents: ASMT, method: 'stripe_checkout',
      processor: 'stripe', processor_session_id: SESSION, status: 'succeeded', initiated_by: 'verify' },
    { community_id: live.id, product_type: 'assessment_payment', product_id: prop.id, fee_type: 'convenience_fee',
      payee: 'management_company', payee_display_name: 'Bedrock Association Management',
      connected_account_id: null, amount_cents: FEE, method: 'stripe_checkout',
      processor: 'stripe', processor_session_id: SESSION, status: 'succeeded', initiated_by: 'verify' },
  ];
  const { error: insErr } = await supabase.from('payments').insert(rows);
  check('payments insert accepted (migration 245 applied)', !insErr);
  if (insErr) { log('  insert error:', insErr.code, insErr.message); process.exit(1); }

  // 3) AR before
  const before = await resolveCurrentAR(supabase, { propertyId: prop.id });
  const beforeBal = before ? before.balance_cents : 0;
  log('\nAR before:', beforeBal, 'c (source=' + (before && before.source) + ')');

  // 4) Post to books
  log('\n--- post (call 1) ---');
  const r1 = await postAssessmentPaymentToBooks(supabase, { sessionId: SESSION, paymentIntentId: 'pi_verify' });
  log(JSON.stringify(r1));
  check('not skipped (live-GL recognized)', !r1.skipped);
  check('GL entry created', !!(r1.gl && r1.gl.journal_entry_id));
  check('AR subledger row created', !!(r1.subledger && r1.subledger.id));

  // 5) Inspect GL entry — balanced, Dr 1000 / Cr 1300, equal to assessment only
  const jeId = r1.gl && r1.gl.journal_entry_id;
  if (jeId) {
    const { data: je } = await supabase.from('journal_entries').select('*').eq('id', jeId).single();
    const { data: lines } = await supabase.from('journal_entry_lines').select('*').eq('journal_entry_id', jeId).order('line_number');
    const { data: accts } = await supabase.from('chart_of_accounts').select('id, account_number').eq('community_id', live.id);
    const num = Object.fromEntries((accts || []).map((a) => [a.id, String(a.account_number)]));
    const cash = lines.find((l) => num[l.account_id] === '1000');
    const ar = lines.find((l) => num[l.account_id] === '1300');
    log('\nJE', je.reference, je.posting_date, '| Dr', je.total_debits_cents, '/ Cr', je.total_credits_cents);
    lines.forEach((l) => log(`  ${num[l.account_id]}  Dr ${l.debit_cents}  Cr ${l.credit_cents}`));
    check('JE balanced', je.total_debits_cents === je.total_credits_cents);
    check('Dr Cash(1000) = assessment amount', cash && cash.debit_cents === ASMT);
    check('Cr AR(1300) = assessment amount', ar && ar.credit_cents === ASMT);
    check('convenience fee NOT on HOA books (total = assessment only)', je.total_debits_cents === ASMT);
    check('source_reference = session id', je.source_reference === SESSION);
  }

  // 6) AR after — should drop by assessment amount
  const after = await resolveCurrentAR(supabase, { propertyId: prop.id });
  const afterBal = after ? after.balance_cents : 0;
  log('\nAR after:', afterBal, 'c | delta', afterBal - beforeBal, '(expected', -ASMT, ')');
  check('homeowner balance dropped by assessment amount', afterBal - beforeBal === -ASMT);

  // 7) Idempotency
  log('\n--- post (call 2 — idempotency) ---');
  const r2 = await postAssessmentPaymentToBooks(supabase, { sessionId: SESSION, paymentIntentId: 'pi_verify' });
  check('GL idempotent (no new entry)', r2.gl && r2.gl.idempotent === true);
  check('subledger idempotent (no new row)', r2.subledger && r2.subledger.idempotent === true);
  const afterIdem = await resolveCurrentAR(supabase, { propertyId: prop.id });
  check('balance unchanged after 2nd post', (afterIdem ? afterIdem.balance_cents : 0) === afterBal);

  // 8) CLEANUP — remove all artifacts.
  log('\n--- cleanup ---');
  const subId = r1.subledger && r1.subledger.id;
  if (jeId) { await supabase.from('journal_entry_lines').delete().eq('journal_entry_id', jeId); await supabase.from('journal_entries').delete().eq('id', jeId); }
  if (subId) await supabase.from('homeowner_transactions').delete().eq('id', subId);
  await supabase.from('payments').delete().eq('processor_session_id', SESSION);
  const { data: batch } = await supabase.from('transaction_upload_batches').select('id').eq('community_id', live.id).eq('period_label', 'Online Payments').eq('source_format', 'manual').maybeSingle();
  if (batch) {
    const { count } = await supabase.from('homeowner_transactions').select('id', { count: 'exact', head: true }).eq('source_batch_id', batch.id);
    if (!count) await supabase.from('transaction_upload_batches').delete().eq('id', batch.id);
  }
  const restored = await resolveCurrentAR(supabase, { propertyId: prop.id });
  check('AR restored to original after cleanup', (restored ? restored.balance_cents : 0) === beforeBal);

  log('\n==================  ' + (pass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED') + '  ==================');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
