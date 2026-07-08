// ============================================================================
// verify_lennar_magic_links.js
// ----------------------------------------------------------------------------
// Verify the magic-link chain end-to-end on production BEFORE handing Ed
// any URLs to email Richelle / Teresa. Standing rule from the Karla incident
// 2026-06-11: never give Ed a URL I haven't proven works.
//
// What happens:
//   1. Invalidate any existing unused tokens for Richelle + Teresa
//      (cleanup — they were minted earlier at 7-day expiry; we're replacing
//       them with fresh 48-hour tokens per Ed 2026-06-12).
//   2. Mint a test token for Richelle.
//   3. POST /api/portal/consume?token=X → expect 200 + Set-Cookie.
//   4. GET /api/portal/me with that cookie → expect role=builder,
//      landing_url=/builders/still-creek-lennar, builder_companies includes Lennar.
//   5. GET /builders/still-creek-lennar → expect 200 + HTML containing
//      "Lennar" and "Still Creek Ranch".
//   6. If all three pass, mint the REAL tokens for Richelle + Teresa
//      at 48-hour expiry and print both URLs.
//   7. If any step fails, print exactly what failed and DO NOT mint the real
//      tokens. We do not hand Ed a URL we haven't proven works.
//
// Usage: node scripts/verify_lennar_magic_links.js
// ============================================================================

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const BASE_URL = 'https://my.bedrocktxai.com';
const RICHELLE_ID = 'c75161cf-86e5-4e7a-b2df-98d9408cabc8';
const TERESA_ID   = '5e9cab62-8c81-4c95-a7a4-43b79feed2b9';

async function mintToken(portalUserId, hours, purpose) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
  const { error } = await supabase.from('portal_magic_links').insert({
    portal_user_id: portalUserId,
    token,
    purpose,
    expires_at: expiresAt.toISOString(),
    created_by: 'egojara@bedrocktx.com',
  });
  if (error) throw new Error('mint: ' + error.message);
  return { token, expiresAt };
}

async function invalidateExistingUnused(portalUserId) {
  const { error, data } = await supabase.from('portal_magic_links')
    .update({ used_at: new Date().toISOString(), used_ip: '127.0.0.1 (admin-revoke)' })
    .eq('portal_user_id', portalUserId)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('id');
  if (error) throw new Error('invalidate: ' + error.message);
  return (data || []).length;
}

async function consumeToken(token) {
  const res = await fetch(`${BASE_URL}/api/portal/consume?token=${token}`, {
    method: 'POST',
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  const body = await res.text();
  return { status: res.status, setCookie, body };
}

function extractPortalSessionCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  // Set-Cookie can have multiple headers joined by comma; pick the portal session cookie.
  const cookies = setCookieHeader.split(/,(?=\s*\w+=)/);
  for (const c of cookies) {
    const m = c.match(/^\s*([^=]+)=([^;]+)/);
    if (m && /portal/i.test(m[1])) return `${m[1].trim()}=${m[2].trim()}`;
  }
  // Fallback — return the first cookie we saw
  const m = cookies[0].match(/^\s*([^=]+)=([^;]+)/);
  return m ? `${m[1].trim()}=${m[2].trim()}` : null;
}

async function getMe(cookie) {
  const res = await fetch(`${BASE_URL}/api/portal/me`, {
    headers: { Cookie: cookie },
  });
  const status = res.status;
  let body = null;
  try { body = await res.json(); } catch (_) {}
  return { status, body };
}

async function getLandingPage(cookie) {
  const res = await fetch(`${BASE_URL}/builders/still-creek-lennar`, {
    headers: { Cookie: cookie },
  });
  const body = await res.text();
  return { status: res.status, body };
}

(async () => {
  console.log('Verify chain — production', BASE_URL);
  console.log('==========================================================');

  console.log('\nStep 0 — invalidate prior unused tokens for both users');
  const invalidatedR = await invalidateExistingUnused(RICHELLE_ID);
  const invalidatedT = await invalidateExistingUnused(TERESA_ID);
  console.log(`  Richelle: invalidated ${invalidatedR} prior unused token(s)`);
  console.log(`  Teresa:   invalidated ${invalidatedT} prior unused token(s)`);

  console.log('\nStep 1 — mint TEST token for Richelle (24h, will be burned by verify)');
  const test = await mintToken(RICHELLE_ID, 24, 'invite');
  console.log(`  test token minted (last 6: …${test.token.slice(-6)})`);

  console.log('\nStep 2 — POST /api/portal/consume');
  const consume = await consumeToken(test.token);
  console.log(`  status: ${consume.status}`);
  if (consume.status >= 400) {
    console.log(`  ✗ consume failed — body: ${consume.body.slice(0, 400)}`);
    return;
  }
  const cookie = extractPortalSessionCookie(consume.setCookie);
  console.log(`  cookie: ${cookie ? cookie.split('=')[0] + '=…' : 'NONE'}`);
  if (!cookie) {
    console.log('  ✗ no Set-Cookie returned — cannot continue');
    return;
  }

  console.log('\nStep 3 — GET /api/portal/me');
  const me = await getMe(cookie);
  console.log(`  status: ${me.status}`);
  if (me.status !== 200 || !me.body || !me.body.user) {
    console.log(`  ✗ /me failed — body: ${JSON.stringify(me.body).slice(0, 400)}`);
    return;
  }
  console.log(`  user.email:        ${me.body.user.email}`);
  console.log(`  user.role:         ${me.body.user.role}`);
  console.log(`  user.landing_url:  ${me.body.user.landing_url}`);
  console.log(`  user.builder_cos:  ${JSON.stringify(me.body.user.builder_companies)}`);
  const meOk = me.body.user.role === 'builder'
    && me.body.user.landing_url === '/builders/still-creek-lennar'
    && (me.body.user.builder_companies || []).includes('Lennar');
  if (!meOk) {
    console.log('  ✗ /me values not as expected');
    return;
  }
  console.log('  ✓ /me payload correct');

  console.log('\nStep 4 — GET /builders/still-creek-lennar');
  const landing = await getLandingPage(cookie);
  console.log(`  status: ${landing.status}`);
  const hasLennar = landing.body.includes('Lennar');
  const hasStillCreek = landing.body.includes('Still Creek Ranch');
  console.log(`  contains "Lennar":           ${hasLennar}`);
  console.log(`  contains "Still Creek Ranch": ${hasStillCreek}`);
  if (landing.status !== 200 || !hasLennar || !hasStillCreek) {
    console.log('  ✗ landing page did not return the expected branded form');
    console.log('  body sample: ' + landing.body.slice(0, 400));
    return;
  }
  console.log('  ✓ landing page is the Lennar/Still Creek branded form');

  console.log('\n==========================================================');
  console.log('  VERIFY CHAIN PASSED — minting real 48-hour tokens');
  console.log('==========================================================');

  const richelle = await mintToken(RICHELLE_ID, 48, 'invite');
  const teresa   = await mintToken(TERESA_ID,   48, 'invite');

  const exp = (d) => d.toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' }) + ' Central';

  console.log('\nRICHELLE HEARITIGE — richelle.hearitige@lennar.com');
  console.log(`  Expires: ${exp(richelle.expiresAt)}`);
  console.log(`  ${BASE_URL}/portal-login.html?token=${richelle.token}`);
  console.log('\nTERESA CONTRERAS — teresa.contreras@lennar.com');
  console.log(`  Expires: ${exp(teresa.expiresAt)}`);
  console.log(`  ${BASE_URL}/portal-login.html?token=${teresa.token}`);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
