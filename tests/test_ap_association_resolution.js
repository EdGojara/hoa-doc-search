#!/usr/bin/env node
// Association resolution for AP intake (Ed 2026-10-12): every signal is weighed
// together; an ordering profile is never decisive; strong signals that disagree
// are held for a person. Pure tests (stubbed resolvers, no database).
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const I = require('../lib/ap/intake');

let passed = 0; let failed = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); } };

const CG = { id: 'cg', name: 'Canyon Gate at Cinco Ranch' };
const WV = { id: 'wv', name: 'Waterview Estates' };
const SCR = { id: 'scr', name: 'Still Creek Ranch' };
const BY_ID = { cg: CG, wv: WV, scr: SCR };
const deps = {
  resolveCommunity: async (text) => {
    const s = String(text || '').toLowerCase();
    if (/canyon gate/.test(s)) return { community: CG };
    if (/waterview/.test(s)) return { community: WV };
    if (/still creek/.test(s)) return { community: SCR };
    return { community: null, candidates: [] };
  },
  resolveCommunityByEmailDomain: async (email) => (/@canyongateatcincoranch\.com$/i.test(email) ? 'cg' : null),
  communityById: (id) => BY_ID[id] || { id, name: null },
  bankAccounts: [{ community_id: 'cg', account_last4: '5313', account_nickname: 'Canyon Gate Operating Checking (NewFirst)' }, { community_id: 'wv', account_last4: '5961', account_nickname: 'Waterview Operating Checking' }],
};
const decide = async (args) => { const ev = await I.associationEvidence(args, deps); return { ev, d: I.decideAssociation(ev) }; };

(async () => {
  console.log('AP association resolution');

  await t('Canyon Gate Amazon receipt (112-5969175-5104221): Waterview ordering profile is not decisive; Canyon Gate selected with its basis', async () => {
    const { ev, d } = await decide({
      extracted: { community_hint: 'Waterview Estates Owners', ordered_by: 'Waterview Estates Owners', service_location: 'Martha Bravo | Canyon Gate @ Cinco Ranch Clubhouse, 20422 CANYON GATE BLVD, KATY, TX 77450', payment_account_last4: '313' },
      staffSenderEmail: 'propertymanager@canyongateatcincoranch.com', emailSubject: 'Amazon | Canyon Gate at Cinco Ranch', communityId: 'cg',
    });
    assert.strictEqual(d.decision, 'selected'); assert.strictEqual(d.community_id, 'cg');
    assert.ok(d.basis.includes('service_location') && d.basis.includes('payment_account') && d.basis.includes('sender_domain'), d.basis.join());
    assert.ok(ev.some((i) => i.kind === 'ordering_profile' && i.community_id === 'wv' && i.strength === 'ignored'), 'the Waterview profile is recorded as not decisive');
    assert.ok(!ev.some((i) => i.strength === 'strong' && i.community_id === 'wv'), 'Waterview is never strong evidence here');
  });

  await t('the same receipt read with only its "Placed by Waterview Estates Owners" line still resolves to Canyon Gate from the email', async () => {
    const { d } = await decide({ extracted: { community_hint: 'Placed by Waterview Estates Owners' }, staffSenderEmail: 'propertymanager@canyongateatcincoranch.com' });
    assert.strictEqual(d.decision, 'selected'); assert.strictEqual(d.community_id, 'cg');
  });

  await t('NRG utility batch (2026-07-28): each bill\'s own bill-to beats the email-level association it was scanned under', async () => {
    const { d } = await decide({ extracted: { bill_to: 'Still Creek Ranch HOA, c/o Bedrock, 12808 W Airport Blvd', community_hint: 'Still Creek Ranch' }, staffSenderEmail: 'cdeleon@bedrocktx.com', communityId: 'cg' });
    assert.strictEqual(d.decision, 'selected'); assert.strictEqual(d.community_id, 'scr'); assert.strictEqual(d.source, 'pdf');
    assert.ok(d.overruled.some((i) => i.kind === 'email_level' && i.community_id === 'cg'), 'the weaker email-level Canyon Gate is recorded as overruled');
  });

  await t('genuinely ambiguous: bill-to says Waterview, ship-to says Canyon Gate, nothing else -> held', async () => {
    const { d } = await decide({ extracted: { bill_to: 'Waterview Estates Owners Association', service_location: 'Canyon Gate clubhouse, 20422 Canyon Gate Blvd' } });
    assert.strictEqual(d.decision, 'conflict'); assert.deepStrictEqual(d.candidates.sort(), ['cg', 'wv']);
  });

  await t('conflict: the bill names Waterview but it came from Canyon Gate\'s own domain -> held, never silently picked', async () => {
    const { ev, d } = await decide({ extracted: { community_hint: 'Waterview Estates' }, staffSenderEmail: 'propertymanager@canyongateatcincoranch.com' });
    assert.strictEqual(d.decision, 'conflict');
    assert.ok(/Waterview/.test(I.describeEvidence(ev)) && /Canyon Gate/.test(I.describeEvidence(ev)));
  });

  await t('upload screen: a picked community that contradicts the bill-to is held (same control as email)', async () => {
    const { d } = await decide({ extracted: { bill_to: 'Waterview Estates' }, pickedCommunityId: 'cg' });
    assert.strictEqual(d.decision, 'conflict');
    const ok = await decide({ extracted: { bill_to: 'Canyon Gate at Cinco Ranch' }, pickedCommunityId: 'cg' });
    assert.strictEqual(ok.d.decision, 'selected');
  });

  await t('only weak signals: the email-level guess is returned as weak (the existing corroboration guards still apply)', async () => {
    const { d } = await decide({ extracted: {}, communityId: 'wv' });
    assert.strictEqual(d.decision, 'weak'); assert.strictEqual(d.source, 'email');
  });

  await t('a payment account matching two associations is not evidence', async () => {
    const ev = await I.associationEvidence({ extracted: { payment_account_last4: '313' } }, { ...deps, bankAccounts: [{ community_id: 'cg', account_last4: '5313' }, { community_id: 'wv', account_last4: '7313' }] });
    assert.ok(!ev.some((i) => i.kind === 'payment_account'));
  });

  await t('wired: intake decides once from the evidence, holds a conflict, records the decision and notes the basis', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ap', 'intake.js'), 'utf8');
    assert.ok(/const assoc = decideAssociation\(assocEvidence\)/.test(src));
    assert.ok(/assoc\.decision === 'conflict'[\s\S]{0,400}return held\(/.test(src));
    assert.ok(/extracted\.association_resolution = /.test(src));
    assert.ok(/extraNotes: assocNote/.test(src));
    assert.ok(!/const fromPdf = await resolveCommunity\(extracted\.community_hint\)/.test(src), 'the bill text no longer decides alone');
    const up = fs.readFileSync(path.join(__dirname, '..', 'api', 'ap_intake.js'), 'utf8');
    assert.ok(/decideAssociation\(ev\)/.test(up), 'the admin upload preview uses the same decision');
    const ex = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ap', 'invoice_extract.js'), 'utf8');
    assert.ok(/ordered_by/.test(ex) && /payment_account_last4/.test(ex) && /NEVER the ordering account/.test(ex));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
