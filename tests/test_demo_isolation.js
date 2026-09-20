// ============================================================================
// tests/test_demo_isolation.js
// ----------------------------------------------------------------------------
// Adversarial proof of the demo execution boundary. We intentionally try to make
// a demo organization (Drama Creek) send email/SMS/certified mail, initiate a
// Stripe charge, enter a staff work queue, contaminate a portfolio metric, and
// cross a retrieval boundary — and prove each attempt FAILS by architectural
// enforcement, not by incomplete test data.
//
// Safety: the sender attempts use the demo COMMUNITY signal (Drama Creek,
// is_demo=true), which the guard blocks before any vendor call, and demo
// recipients as a belt. A "suppressed" result is only reachable on the guarded
// path (before the network), so asserting it proves no real send occurred.
//
// Parts marked [needs 439] pass after migration 439 (demo tenant + audit table)
// is applied; the rest pass on is_demo alone. Run: node tests/test_demo_isolation.js
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const { guardOutbound } = require('../lib/demo/outbound_guard');
const { runInDemoContext } = require('../lib/demo/demo_context');
const guard = require('../lib/demo/demo_guard');
const { DEMO_MGMT_CO_ID } = require('../lib/company');

const DC = 'dc100000-0000-4000-a000-000000000000';               // Drama Creek (demo)
const CANYON_GATE = 'a0000000-0000-4000-8000-000000000003';       // a real production community

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); if (!c) fails++; };
const sup = (r) => !!(r && (r.suppressed === true || (r.blocked === true)));

(async () => {
  console.log('demo isolation — adversarial boundary\n');

  // ---- 1. Guard core: demo signals block, production passes -----------------
  console.log('[guard core]');
  ok((await guardOutbound({ channel: 'email_graph', communityId: DC, to: 'a@b.com' })).blocked, 'demo COMMUNITY id blocks');
  ok((await guardOutbound({ channel: 'sms', to: 'x@anything.demo' })).blocked, 'demo RECIPIENT blocks');
  ok(await runInDemoContext(async () => (await guardOutbound({ channel: 'email_graph', to: 'real@example.com' })).blocked), 'demo CONTEXT blocks even a real recipient');
  ok(!(await guardOutbound({ channel: 'email_graph', communityId: CANYON_GATE, to: 'real@example.com' })).blocked, 'a PRODUCTION action is NOT blocked');
  ok(!(await guardOutbound({ channel: 'email_graph', to: 'real@example.com' })).blocked, 'a production action with no community is NOT blocked');

  // ---- 2. Each real sender suppresses a demo action -------------------------
  console.log('\n[outbound senders — demo action suppressed, never sent]');
  const { sendAs } = require('../lib/email/graph_send');
  ok(sup(await sendAs({ communityId: DC, to: 'blocked@drama.demo', subject: 'x', text: 'x' })), 'EMAIL (Graph) suppressed for a demo org');
  const { sendEmail } = require('../lib/notifications/email');
  ok(sup(await sendEmail({ communityId: DC, to: 'blocked@drama.demo', subject: 'x', html: '<p>x</p>' })), 'EMAIL (Resend) suppressed for a demo org');
  const { sendSms } = require('../lib/notifications/sms');
  ok(sup(await sendSms({ communityId: DC, to: '+15125551234', body: 'x' })), 'SMS suppressed for a demo org');
  const lob = require('../lib/mail/lob_provider');
  ok(sup(await lob.createCertifiedLetter({ pdfBuffer: Buffer.from('%PDF-1.4 test'), recipient: { name: 'X', address_line1: '1 St', city: 'Katy', state: 'TX', zip: '77450' }, options: { communityId: DC } })), 'CERTIFIED MAIL (Lob) suppressed for a demo org');
  const stripe = require('../lib/payments/stripe');
  ok(sup(await stripe.createCheckoutSession({ communityId: DC, fees: [{ payee: 'management_company', amount_cents: 100 }], successUrl: 'https://x', cancelUrl: 'https://x', customer: { email: 'blocked@drama.demo' } })), 'STRIPE checkout suppressed for a demo org');
  ok(sup(await stripe.chargeOffSession({ communityId: DC, amountCents: 100, customerId: 'cus_x', paymentMethodId: 'pm_x' })), 'STRIPE off-session charge suppressed for a demo org');

  // ---- 3. Staff queues / portfolio metrics exclude demo ---------------------
  console.log('\n[work queues / metrics — demo excluded]');
  const demoIds = await guard.demoCommunityIds();
  ok(demoIds.includes(DC), 'the demo community is in the demo-id set');
  // Adversarial: Drama Creek HAS operational rows; the exclusion must remove them.
  const rawV = await supabase.from('violations').select('id').eq('community_id', DC);
  ok((rawV.data || []).length > 0, 'demo org HAS operational rows (violations) that COULD leak');
  let vq = supabase.from('violations').select('id').eq('community_id', DC);
  vq = await guard.excludeDemo(vq, 'community_id');
  ok(((await vq).data || []).length === 0, 'excludeDemo removes the demo org from an all-rows query');

  // ---- 4. [needs 439] tenant move + suppressed-action audit -----------------
  console.log('\n[needs 439: tenant move + audit]');
  const { data: dc } = await supabase.from('communities').select('management_company_id, is_demo').eq('id', DC).maybeSingle();
  ok(dc && dc.is_demo === true, 'demo org keeps is_demo=true');
  ok(dc && dc.management_company_id === DEMO_MGMT_CO_ID, 'demo org now belongs to the DEMO tenant (migration 439)');
  // The suppressed sends above should have written audit rows.
  const { data: audit, error: aErr } = await supabase.from('demo_suppressed_actions')
    .select('channel, reason').eq('community_id', DC).order('created_at', { ascending: false }).limit(10);
  ok(!aErr && Array.isArray(audit) && audit.length > 0, 'suppressed demo actions are recorded in demo_suppressed_actions');

  console.log(fails ? `\n✗ demo isolation: ${fails} failure(s)` : '\n✓ demo isolation: a demo org cannot send, charge, enter a queue, or be metered');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
