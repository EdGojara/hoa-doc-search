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
//
// With Render's environment (the keys live only there): open the service's
// Shell tab in Render and run the same command. It prints the key's MODE and its
// fixed prefix only, never the key or any part of a signing secret.
//
// Section 6 (Ed 2026-10-16) is the per-community payment readiness the server
// enforces at checkout (lib/payments/payment_readiness.js), computed from the
// same Stripe answers, without writing anything.
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { stripeMode } = require('../lib/payments/stripe_mode');
const { paymentsReadyFor } = require('../lib/payments/payment_readiness');
const { HANDLED_PLATFORM_EVENTS, HANDLED_CONNECT_EVENTS } = require('../lib/payments/payment_lifecycle');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const KEY = process.env.STRIPE_SECRET_KEY || '';
const WH = process.env.STRIPE_WEBHOOK_SECRET || '';
const WHC = process.env.STRIPE_CONNECT_WEBHOOK_SECRET || '';

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
  const m = stripeMode(KEY);
  const mode = m === 'live' ? 'LIVE' : (m === 'test' ? 'TEST' : null);
  console.log('\n1. Keys');
  if (!KEY) {
    fail('STRIPE_SECRET_KEY is not set — nothing below can work.');
    console.log('   ' + dim('Set it in Render → Environment, then redeploy.'));
    console.log('\n' + bad('Not configured. Stop here.') + '\n');
    process.exit(1);
  }
  // The fixed type prefix only (sk_live_ / rk_test_ ...), never a character of the secret part.
  const prefix = (KEY.match(/^(sk|rk)_(live|test)_/) || ['unrecognized'])[0];
  console.log('   ' + ok('✓') + ` STRIPE_SECRET_KEY present  ${dim(prefix + '…')}`);
  if (!mode) fail('STRIPE_SECRET_KEY is not a recognised sk_/rk_ test or live key; checkout refuses (payment_not_configured).');
  console.log(`   mode: ${mode === 'LIVE' ? bad('LIVE — real money') : ok('TEST — no real money')}`);
  // Signing secrets: report presence only, never any part of the value.
  if (!WH) fail('STRIPE_WEBHOOK_SECRET (platform endpoint) is not set. Payments will be taken and never confirmed.');
  else console.log('   ' + ok('✓') + ' STRIPE_WEBHOOK_SECRET present (platform endpoint)');
  if (!WHC) console.log('   ' + warn('!') + ' STRIPE_CONNECT_WEBHOOK_SECRET not set: connected-account events (account.updated) are refused with 503; platform payment events are unaffected.');
  else console.log('   ' + ok('✓') + ' STRIPE_CONNECT_WEBHOOK_SECRET present (connected-accounts endpoint)');
  if (WH && WHC && WH === WHC) fail('STRIPE_WEBHOOK_SECRET and STRIPE_CONNECT_WEBHOOK_SECRET are identical; each Stripe endpoint has its own signing secret.');

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
    .select('*')
    .order('name');
  if (error) { fail('could not read communities: ' + error.message); process.exit(1); }

  const withAccounts = (comms || []).filter((c) => c.stripe_connected_account_id);
  if (!withAccounts.length) console.log('   ' + dim('none on file yet'));
  const accountAnswers = new Map();
  for (const c of withAccounts) {
    const a = await stripe(`accounts/${c.stripe_connected_account_id}`);
    accountAnswers.set(c.stripe_connected_account_id, a);
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
  // What lib/payments/payment_lifecycle.js handles (Ed 2026-09-27). Platform
  // events arrive on a normal endpoint; account.updated for CONNECTED accounts
  // only arrives on an endpoint created to listen to connected accounts
  // (connect: true), which has its own signing secret.
  // payout.* (Ed 2026-10-16) relieve Stripe clearing into operating cash; they
  // happen ON the association's account, so they need the connected-accounts endpoint.
  const HANDLED_PLATFORM = HANDLED_PLATFORM_EVENTS;
  const HANDLED_CONNECT = HANDLED_CONNECT_EVENTS;
  console.log('   handled platform events:  ' + dim(HANDLED_PLATFORM.join(', ')));
  console.log('   handled connected events: ' + dim(HANDLED_CONNECT.join(', ')));
  const hooks = await stripe('webhook_endpoints', 'limit=20');
  const eps = (hooks.body && hooks.body.data) || [];
  const ours = eps.filter((e) => /\/api\/payments\/webhook$/.test(e.url || ''));
  const covered = (list, wantConnect) => new Set(ours.filter((e) => !!e.connect === wantConnect && e.status === 'enabled')
    .flatMap((e) => ((e.enabled_events || []).includes('*') ? list : (e.enabled_events || []))));
  const platSet = covered(HANDLED_PLATFORM, false), connSet = covered(HANDLED_CONNECT, true);
  const platMissing = HANDLED_PLATFORM.filter((h) => !platSet.has(h));
  const connMissing = HANDLED_CONNECT.filter((h) => !connSet.has(h));
  console.log(`   platform events: ${platMissing.length ? bad('missing ' + platMissing.join(', ')) : ok('all ' + HANDLED_PLATFORM.length + ' subscribed')}`);
  console.log(`   connected-account events: ${connMissing.length ? warn('missing ' + connMissing.join(', ') + ' (needs a connected-accounts endpoint)') : ok('all ' + HANDLED_CONNECT.length + ' subscribed')}`);
  if (connMissing.some((e) => e.startsWith('payout.'))) fail('connected-accounts webhook not listening for ' + connMissing.filter((e) => e.startsWith('payout.')).join(', ') + ': payouts will never relieve Stripe clearing (1090) into operating cash (1000).');
  if (platMissing.length) fail('platform webhook not listening for: ' + platMissing.join(', '));
  // Each endpoint has its own signing secret: platform -> STRIPE_WEBHOOK_SECRET,
  // connected accounts -> STRIPE_CONNECT_WEBHOOK_SECRET (lib/payments/webhook_auth.js).
  if (ours.some((e) => e.connect) && !WHC) {
    fail('a connected-accounts endpoint points at us but STRIPE_CONNECT_WEBHOOK_SECRET is not set; its deliveries will be refused (503).');
  }
  if (ours.some((e) => !e.connect) && !WH) {
    fail('a platform endpoint points at us but STRIPE_WEBHOOK_SECRET is not set; its deliveries will be refused (503).');
  }
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
    console.log(`     ${dim((e.connect ? 'connected accounts' : 'platform') + ': ' + (listening.includes('*') ? 'all events' : listening.join(', ')))}`);
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

  // ---- payment readiness (what checkout enforces) ---------------------
  console.log('\n6. Online assessment payment readiness (server gate, read-only)');
  const shim = { retrieveAccount: async (id) => {
    const a = accountAnswers.get(id) || await stripe(`accounts/${id}`);
    const msg = (a.body && a.body.error && a.body.error.message) || String(a.status);
    if (!a.ok) return { ok: false, not_found: a.status === 404 || /no such account|does not have access/i.test(msg), error: msg };
    return { ok: true, charges_enabled: !!a.body.charges_enabled, payouts_enabled: !!a.body.payouts_enabled };
  } };
  const quiet = { error() {}, warn() {} };
  for (const c of (comms || []).filter((x) => !['archived', 'terminated'].includes(x.management_status))) {
    if (!('online_payments_enabled' in c)) { console.log('   ' + warn('!') + ' migration 534 not applied: no online_payments_enabled switch, so every checkout is refused.'); break; }
    const r = await paymentsReadyFor({ ...c }, { supabase: null, stripeLib: shim, key: KEY, verify: true, log: quiet });
    const sw = c.online_payments_enabled ? ok('on') : dim('off');
    console.log(`   ${r.ready ? ok('✓ READY') : dim('· not ready')} ${String(c.name).padEnd(28)} switch=${sw}  financials=${c.financials_active === false ? warn('off') : 'on'}  receipts=${c.payment_receipt_emails_enabled ? 'email' : 'record only'}  dispute_reversal=${c.stripe_dispute_auto_reversal ? 'auto' : 'staff'}`
      + (r.ready ? '' : `  ${dim(r.reason)}`));
    if (c.online_payments_enabled && !r.ready) fail(`${c.name} has online payments switched ON but checkout will refuse it: ${r.reason}.`);
  }

  console.log('\n' + '─'.repeat(66));
  if (problems) {
    console.log(bad(`${problems} problem(s) to fix before taking a payment.`) + '\n');
    process.exit(1);
  }
  console.log(ok('Ready.') + (mode === 'TEST' ? dim('  (test mode — use 4242 4242 4242 4242)') : '') + '\n');
})();
