// ============================================================================
// scripts/stripe_preflight.js — is Stripe actually wired, and to what?
// ----------------------------------------------------------------------------
// Ed 2026-08-21: "okay lets finally link stripe."
//
// Run this BEFORE and AFTER pasting keys. It answers, from the outside, the
// questions that otherwise get answered by a failed booking:
//
//   * are the keys there, and are they TEST or LIVE
//   * does Stripe actually accept them
//   * do the Connect accounts on file exist IN THIS MODE — the one that bites,
//     because an account created with test keys simply does not exist when you
//     switch to live, and the row in our database looks identical either way
//   * can each community actually take money (charges_enabled), and can the
//     association actually receive it (payouts_enabled)
//   * is a webhook registered, pointed at us, listening for what we handle
//   * do the communities that take bookings have fees configured
//
// Read-only. It creates nothing, changes nothing, and moves no money.
//
//   node scripts/stripe_preflight.js
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const KEY = process.env.STRIPE_SECRET_KEY || '';
const WH = process.env.STRIPE_WEBHOOK_SECRET || '';

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[90m${s}\x1b[0m`;

async function stripe(path, params) {
  const url = `https://api.stripe.com/v1/${path}${params ? `?${params}` : ''}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, body: j };
}

(async () => {
  let problems = 0;
  const fail = (m) => { problems++; console.log('   ' + bad('✗ ' + m)); };

  console.log('\n\x1b[1mSTRIPE PREFLIGHT\x1b[0m');
  console.log('─'.repeat(66));

  // ---- keys -----------------------------------------------------------
  const mode = /^sk_live_/.test(KEY) ? 'LIVE' : (/^sk_test_/.test(KEY) ? 'TEST' : null);
  console.log('\n1. Keys');
  if (!KEY) {
    fail('STRIPE_SECRET_KEY is not set — nothing below can work.');
    console.log('   ' + dim('Set it in Render → Environment, then redeploy.'));
    console.log('\n' + bad('Not configured. Stop here.') + '\n');
    process.exit(1);
  }
  console.log('   ' + ok('✓') + ` STRIPE_SECRET_KEY present  ${dim(KEY.slice(0, 8) + '…')}`);
  console.log(`   mode: ${mode === 'LIVE' ? bad('LIVE — real money') : ok('TEST — no real money')}`);
  if (!WH) fail('STRIPE_WEBHOOK_SECRET is not set. Payments will be taken and never confirmed — the booking stays pending_payment forever.');
  else console.log('   ' + ok('✓') + ` STRIPE_WEBHOOK_SECRET present  ${dim(WH.slice(0, 8) + '…')}`);

  // ---- does Stripe accept them ----------------------------------------
  console.log('\n2. Stripe accepts the key');
  const acct = await stripe('account');
  if (!acct.ok) {
    fail(`Stripe refused the key (${acct.status}): ${(acct.body.error && acct.body.error.message) || 'unknown'}`);
    console.log('\n' + bad(`${problems} problem(s).`) + '\n');
    process.exit(1);
  }
  console.log('   ' + ok('✓') + ` platform account: ${acct.body.business_profile?.name || acct.body.id}  ${dim(acct.body.id)}`);
  if (acct.body.charges_enabled === false) fail('The PLATFORM account cannot take charges yet.');

  // ---- connect accounts, in this mode ---------------------------------
  console.log('\n3. Connect accounts — do they exist in ' + (mode || '?') + ' mode?');
  const { data: comms, error } = await supabase.from('communities')
    .select('name, slug, stripe_connected_account_id, stripe_onboarding_status, amenity_bookings_active')
    .order('name');
  if (error) { fail('could not read communities: ' + error.message); process.exit(1); }

  const withAccounts = (comms || []).filter((c) => c.stripe_connected_account_id);
  if (!withAccounts.length) console.log('   ' + dim('none on file yet'));
  for (const c of withAccounts) {
    const a = await stripe(`accounts/${c.stripe_connected_account_id}`);
    if (!a.ok) {
      fail(`${c.name}: ${c.stripe_connected_account_id} does NOT exist in ${mode} mode`);
      console.log('     ' + dim('It was created in the other mode. Onboarding has to be redone, and the'));
      console.log('     ' + dim('stored id should be cleared so nothing tries to pay into it.'));
      continue;
    }
    const charges = a.body.charges_enabled;
    const payouts = a.body.payouts_enabled;
    const due = (a.body.requirements?.currently_due || []).length;
    const mark = charges && payouts ? ok('✓') : warn('~');
    console.log(`   ${mark} ${String(c.name).padEnd(28)} charges=${charges ? ok('yes') : bad('no')}  payouts=${payouts ? ok('yes') : bad('no')}`
      + (due ? `  ${warn(due + ' item(s) still required')}` : ''));
    if (due) {
      for (const r of (a.body.requirements.currently_due || []).slice(0, 4)) console.log('     ' + dim('· ' + r));
    }
    if (c.stripe_onboarding_status === 'enabled' && !(charges && payouts)) {
      fail(`${c.name} is stored as "enabled" but Stripe says it cannot ${!charges ? 'take charges' : 'pay out'}. Our status is stale.`);
    }
  }

  // ---- webhook --------------------------------------------------------
  console.log('\n4. Webhook');
  const HANDLED = ['checkout.session.completed', 'payment_intent.payment_failed', 'charge.refunded', 'account.updated'];
  const hooks = await stripe('webhook_endpoints', 'limit=20');
  const eps = (hooks.body && hooks.body.data) || [];
  const ours = eps.filter((e) => /\/api\/payments\/webhook$/.test(e.url || ''));
  if (!ours.length) {
    fail('No webhook endpoint points at /api/payments/webhook.');
    console.log('   ' + dim('Without it Stripe takes the money and we never hear about it: the'));
    console.log('   ' + dim('reservation stays pending_payment and no payment row is marked paid.'));
    if (eps.length) {
      console.log('   ' + dim('Endpoints that DO exist:'));
      eps.slice(0, 5).forEach((e) => console.log('     ' + dim('· ' + e.url)));
    }
  }
  for (const e of ours) {
    console.log(`   ${e.status === 'enabled' ? ok('✓') : bad('✗')} ${e.url}  ${dim(e.status)}`);
    const listening = e.enabled_events || [];
    const all = listening.includes('*');
    const missing = HANDLED.filter((h) => !all && !listening.includes(h));
    if (missing.length) {
      fail('not listening for: ' + missing.join(', '));
      console.log('     ' + dim('checkout.session.completed is the one that confirms a booking.'));
    } else {
      console.log('     ' + ok('listening for everything we handle'));
    }
  }

  // ---- fees -----------------------------------------------------------
  console.log('\n5. Communities taking bookings');
  for (const c of (comms || []).filter((x) => x.amenity_bookings_active)) {
    const { data: ams } = await supabase.from('amenities')
      .select('id, name').eq('community_id', (await supabase.from('communities').select('id').eq('slug', c.slug).maybeSingle()).data?.id)
      .eq('is_rentable', true);
    let feeCount = 0;
    for (const a of (ams || [])) {
      const { count } = await supabase.from('amenity_fee_schedule').select('id', { count: 'exact', head: true }).eq('amenity_id', a.id);
      feeCount += count || 0;
    }
    const connected = !!c.stripe_connected_account_id;
    const mark = connected && feeCount ? ok('✓') : warn('~');
    console.log(`   ${mark} ${String(c.name).padEnd(28)} ${(ams || []).length} rentable · ${feeCount} fee row(s) · connect=${connected ? ok('yes') : warn('no')}`);
    if (!connected && feeCount) console.log('     ' + dim('fees are set but the association has no Connect account — bookings fall back to pay-by-check'));
  }

  console.log('\n' + '─'.repeat(66));
  if (problems) {
    console.log(bad(`${problems} problem(s) to fix before taking a payment.`) + '\n');
    process.exit(1);
  }
  console.log(ok('Ready.') + (mode === 'TEST' ? dim('  (test mode — use 4242 4242 4242 4242)') : '') + '\n');
})();
