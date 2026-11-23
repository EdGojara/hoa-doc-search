#!/usr/bin/env node
// ============================================================================
// Closing/resale property identification (Ed 2026-11-23). A closing packet that says
// "Ln" must find the lot stored as "Lane"; anything not certain is a person's choice;
// a failed lookup is an error on screen, never a blank or zero balance.
// ============================================================================
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { matchAddress } = require('../lib/entity_resolution');
const { searchLots } = require('../api/home_sales')._test;

let failed = 0;
const t = async (name, fn) => { try { await fn(); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); } };
const lot = (id, street_address, unit = null, owner_name = 'Pat Example') => ({ property_id: id, street_address, unit, owner_name });
const LOTS = [lot('a', '100 Sample Springs Lane'), lot('b', '102 Sample Springs Lane'), lot('c', '4707 Example Forest Dr'), lot('d', '4707 Example Forest Court'),
  lot('e', '12 Meadow View Drive'), lot('f', '7 Oak Cove'), lot('g', '9 Pine Trail'), lot('h', '55 Tower Street', '2A'), lot('i', '55 Tower Street', '3B'), lot('j', '300 Quiet Ridge Boulevard')];
const M = (a, l = LOTS) => { const r = matchAddress(l, a); return [r.status, r.matches.map((x) => x.property_id).join(',')]; };

(async () => {
  await t('abbreviations in either direction, any case or punctuation, city and ZIP after a comma', () => {
    for (const a of ['100 Sample Springs Ln', '100 SAMPLE SPRINGS LN.', '100 Sample Springs Lane', '100 sample springs ln, Houston, TX 77000', ' 100  Sample   Springs Ln ']) assert.deepStrictEqual(M(a), ['matched', 'a'], a);
    for (const [a, id] of [['4707 Example Forest Drive', 'c'], ['4707 Example Forest Dr', 'c'], ['4707 Example Forest Ct', 'd'], ['12 Meadow View Dr', 'e'], ['7 Oak Cv', 'f'], ['9 Pine Trl', 'g'], ['300 Quiet Ridge Blvd', 'j']]) assert.deepStrictEqual(M(a), ['matched', id], a);
  });
  await t('no suffix: used only when one lot fits; several lots must be chosen', () => {
    assert.deepStrictEqual(M('100 Sample Springs'), ['matched', 'a']);
    assert.deepStrictEqual(M('4707 Example Forest'), ['choose', 'c,d']);
  });
  await t('a different suffix, extra words, or a unit that differs is a choice, never a match', () => {
    assert.deepStrictEqual(M('100 Sample Springs Ct'), ['choose', 'a']);
    assert.deepStrictEqual(M('100 Sample Springs Ln Houston TX 77000'), ['choose', 'a']);
    assert.deepStrictEqual(M('55 Tower St'), ['choose', 'h,i']);
    assert.deepStrictEqual(M('55 Tower St #2A'), ['matched', 'h']);
    assert.deepStrictEqual(M('55 Tower St Unit 9Z'), ['choose', 'h,i']);
  });
  await t('nothing similar, no number, blank or null: none, never the nearest house number', () => {
    for (const a of ['101 Sample Springs Ln', '10 Sample Springs Ln', '1000 Sample Springs Ln', 'Sample Springs Ln', '', '   ', null, undefined, ',']) assert.strictEqual(M(a)[0], 'none', String(a));
    assert.strictEqual(matchAddress([], '100 Sample Springs Ln').status, 'none');
    assert.strictEqual(matchAddress(null, '100 Sample Springs Ln').status, 'none');
  });
  await t('two rows for one lot (co-owners) are one property; two lots at one address must be chosen', () => {
    assert.deepStrictEqual(M('1 A Ln', [lot('x', '1 A Lane'), lot('x', '1 A Lane')]), ['matched', 'x']);
    assert.deepStrictEqual(M('1 A Ln', [lot('x', '1 A Lane'), lot('y', '1 A Ln')]), ['choose', 'x,y']);
  });
  await t('scale: the right lot among 1,500', () => {
    const big = Array.from({ length: 1500 }, (_, i) => lot('n' + i, `${1000 + i} Long Trail Drive`));
    assert.deepStrictEqual(M('2499 Long Trail Dr', big), ['matched', 'n1499']);
  });
  await t('search box: abbreviation, partial typing and owner name; commas do not break it', () => {
    const ids = (q) => searchLots(LOTS, q).map((x) => x.property_id).join(',');
    assert.strictEqual(ids('100 Sample Springs Ln'), 'a'); assert.strictEqual(ids('100 sample spr'), 'a');
    assert.strictEqual(ids('4707 Example Forest Drive'), 'c'); assert.strictEqual(ids('100 Sample Springs Ln, Houston'), 'a');
    assert.strictEqual(searchLots([lot('z', '1 B Way', null, 'Chris Sampleton')], 'sampleton').length, 1);
    assert.strictEqual(ids('zzz'), '');
  });

  // ---- the screen, run as shipped -------------------------------------------------
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'home_sales.html'), 'utf8');
  const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).sort((a, b) => b.length - a.length)[0];
  const grab = (from, to) => { const i = src.indexOf(from); const j = src.indexOf(to, i); assert.ok(i >= 0 && j > i, from); return src.slice(i, j); };
  function screen(answers) {
    const els = {}; const $ = (id) => els[id] || (els[id] = { innerHTML: '', style: {}, value: '', textContent: '' });
    const w = {};
    const ctx = { window: w, $, CID: 'c', fetch: (u) => answers(u), renderChecks() {}, drvBadge: () => '', esc: String, payoffCheck: () => null, payoffKey: () => null, console, fmt: (c) => '$' + (c / 100).toFixed(2) };
    vm.createContext(ctx);
    vm.runInContext(grab('  const balBadge', '  const esc'), ctx);
    vm.runInContext(grab('  const LOOKUP_FAILED', '  function snapshotCard') + grab('  function renderSellerCheck', '  // ── Closing checks') + grab('  function recordBlockers', '  function updateRecordGate') + '\n;this.sel = selectScanProperty; this.block = recordBlockers;', ctx);
    return { ctx, w, text: () => els['sc-seller-check'] ? els['sc-seller-check'].innerHTML : '' };
  }
  const snap = (id, cents) => ({ property: { id, street_address: id }, owner: { owner_name: 'O' }, balance_status: cents == null ? 'UNKNOWN' : 'KNOWN', balance_cents: cents, drv_clean: true });
  const ok = (j) => Promise.resolve({ ok: true, json: () => Promise.resolve(j) });

  await t('screen: no property selected, a failed lookup, or a malformed answer is an error and blocks recording', async () => {
    let s = screen(() => ok({})); s.w._scanProp = null;
    await s.ctx.sel(null); assert.match(s.text(), /Seller balance not available/); assert.ok(s.ctx.block().includes('select the property'));
    for (const a of [() => Promise.resolve({ ok: false }), () => Promise.reject(new Error('offline')), () => ok({}), () => ok({ error: 'x' })]) {
      s = screen(a); await s.ctx.sel('p1');
      assert.match(s.text(), /Could not load this property/); assert.ok(!/\$0|cleared/.test(s.text())); assert.ok(s.ctx.block().some((x) => /account to load/.test(x)));
    }
  });
  await t('screen: a loaded balance shows and unblocks; UNKNOWN says so and is never $0', async () => {
    let s = screen(() => ok(snap('p1', 158342))); await s.ctx.sel('p1');
    assert.match(s.text(), /\$1583\.42 still owed/); assert.deepStrictEqual([...s.ctx.block()], []);
    s = screen(() => ok(snap('p1', null))); await s.ctx.sel('p1');
    assert.match(s.text(), /UNKNOWN/); assert.ok(!/\$0/.test(s.text()));
  });
  await t('screen: a slow answer for an earlier choice never shows another home\'s balance', async () => {
    let release; const slow = new Promise((r) => { release = r; });
    const s = screen((u) => (u.includes('p1') ? slow.then(() => ({ ok: true, json: () => Promise.resolve(snap('p1', 99900)) })) : ok(snap('p2', 12300))));
    const first = s.ctx.sel('p1'); await s.ctx.sel('p2'); release(); await first;
    assert.match(s.text(), /\$123\.00/); assert.strictEqual(s.w._scanSnap.property.id, 'p2');
  });
  await t('screen: several possible lots never preselect the first one', () => {
    assert.ok(src.includes("const sure = match.status === 'matched' && matches.length === 1;"));
    assert.ok(src.includes('selectScanProperty(sure ? matches[0].property_id : null)'));
  });

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
