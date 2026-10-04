// tests/test_ops_feed_phase1.js  (Issue #29 Phase 1 + refinement) — read-only Operations Feed
// Three lanes, the audited selection rules, exact "Take action" destinations, and
// the navigation-only deep-link parsers. In-memory read-only fake (any write throws).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildFeed, buildItem, summarize, holdReason, activeFor } = require('../lib/feed/build');
const DL = require('../public/app/deeplink');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const NOW = Date.parse('2026-10-05T15:00:00Z');
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const C1 = u(901); const C2 = u(902); const EAGLE = u(903);
const iso = (h) => new Date(NOW - h * 3600000).toISOString();
const day = (d) => new Date(NOW + d * 86400000).toISOString().slice(0, 10);

function readOnlyDb(seed = {}, { fail = [] } = {}) {
  const T = JSON.parse(JSON.stringify(seed));
  function from(t) {
    const f = []; let order = null; let lim = null;
    const deny = () => { throw new Error(`write attempted on ${t}`); };
    const q = {
      select() { return q; },
      eq(c, v) { f.push((r) => r[c] === v); return q; },
      in(c, v) { f.push((r) => v.includes(r[c])); return q; },
      gte(c, v) { f.push((r) => r[c] != null && String(r[c]) >= String(v)); return q; },
      lte(c, v) { f.push((r) => r[c] != null && String(r[c]) <= String(v)); return q; },
      lt(c, v) { f.push((r) => r[c] != null && String(r[c]) < String(v)); return q; },
      or(expr) { const parts = expr.split(',').map((p) => p.split('.')); f.push((r) => parts.some(([c, op, v]) => (op === 'eq' ? r[c] === v : op === 'is' && v === 'null' ? r[c] == null : false))); return q; },
      order(c, o = {}) { order = [c, o.ascending !== false]; return q; },
      limit(n) { lim = n; return q; },
      insert: deny, update: deny, upsert: deny, delete: deny,
      then(res, rej) {
        if (fail.includes(t)) return Promise.resolve({ data: null, error: { message: `relation "${t}" unavailable` } }).then(res, rej);
        let out = (T[t] || []).filter((r) => f.every((p) => p(r)));
        if (order) { const [c, asc] = order; out = [...out].sort((a, b) => (String(a[c] ?? '') < String(b[c] ?? '') ? -1 : String(a[c] ?? '') > String(b[c] ?? '') ? 1 : 0) * (asc ? 1 : -1)); }
        if (lim != null) out = out.slice(0, lim);
        return Promise.resolve({ data: out.map((r) => ({ ...r })), error: null }).then(res, rej);
      },
    };
    return q;
  }
  return { from, T };
}

const inv = (n, o = {}) => ({ id: u(n), community_id: C1, vendor_id: `v${n}`, vendor_invoice_number: `INV-${n}`, total_cents: 10000, status: 'awaiting_approval', needs_review: true, cutover_review: null, due_date: day(10), notes: 'Emma: loaded from email.', created_at: iso(48), vendor: { name: `Vendor ${n}` }, communities: { name: 'Alpha' }, ...o });
const accRow = (n, o = {}) => ({ id: u(n), status: 'pending_review', community_id: C1, community_name: 'Alpha', homeowner_address: `${n} Sample Ln`, project_summary: `Project ${n}`, decision_type: null, ai_recommendation: 'request_more_info', current_ai_recommendation: null, conversation_id: `conv${n}`, last_document_added_at: null, current_review_at: null, letter_draft_saved_at: null, finalization_id: null, created_at: iso(24 * 20), updated_at: iso(24 * 19), ...o });
const world = () => ({
  communities: [
    { id: C1, name: 'Alpha', management_status: 'active', financials_active: true, arc_active: true, is_demo: false },
    { id: C2, name: 'Beta', management_status: 'active', financials_active: true, arc_active: true, is_demo: false },
    { id: EAGLE, name: 'Eaglewood', management_status: 'terminating', financials_active: false, arc_active: true, is_demo: false },
  ],
  ap_invoices: [
    inv(1, { status: 'on_hold', notes: 'Emma: loaded from email.\nOn hold 2026-08-18: check #1008 was voided. Release once the corrected invoice is in hand.' }),
    inv(2, { status: 'on_hold', notes: 'Emma: loaded from email. ON HOLD (Issue #14, Ed 2026-10-01): W-9 required before payment.' }),
    inv(3, { cutover_review: 'PENDING', vendor_id: 'vX' }),
    inv(4, { due_date: day(-5), vendor_id: 'vRecurring' }),                    // past due, unapproved, NOT flagged needs_review -> still surfaces
    inv(5, { vendor_id: 'vNew', needs_review: false }),                          // first bill from this vendor -> new payee
    inv(6, { vendor_id: 'vRecurring', created_at: iso(10) }),                   // routine line flags only -> stays in Payables
    inv(7, { vendor_id: 'vRecurring', due_date: day(-9), created_at: iso(5) }), // approved already -> residue, not surfaced even though past due
    inv(8, { community_id: EAGLE, due_date: day(-30), communities: { name: 'Eaglewood' } }), // inactive community
    inv(9, { vendor_id: 'vRecurring', created_at: iso(24 * 400), status: 'paid' }),          // history: makes vRecurring not new
  ],
  ap_invoice_approvals: [{ invoice_id: u(7), action: 'approved', user_name: 'Celina', created_at: iso(2) }],
  ap_intake_exceptions: [
    { id: u(20), status: 'pending', reason: 'no_community', vendor_name: 'Law PC', invoice_number: '4068652', total_cents: 27000, community_id: null, notes: '', created_at: iso(24 * 51) },
    { id: u(21), status: 'pending', reason: 'other', vendor_name: 'Insurance Co', total_cents: 612568, community_id: C2, notes: 'payment requested, but the attachment is not an invoice: review in Payables', created_at: iso(72), communities: { name: 'Beta' } },
    { id: u(22), status: 'pending', reason: 'other', vendor_name: 'Reimbursement: Pat', total_cents: 165000, community_id: C1, notes: 'reimbursement: which expense account? no coding instruction from staff', created_at: iso(24) },
    { id: u(23), status: 'pending', reason: 'other', vendor_name: null, community_id: EAGLE, notes: 'payment requested, but no PDF', created_at: iso(96) },
  ],
  acc_decisions: [
    accRow(30, { last_document_added_at: iso(24 * 10) }),                                  // new docs -> now
    accRow(31, { conversation_id: 'c31' }),                                                // inbound after update -> now
    accRow(32),                                                                            // no decision -> now
    accRow(33, { decision_type: 'request_more_info' }),                                    // waiting
    accRow(34, { homeowner_address: '1 Dup Ln', created_at: iso(24 * 3) }),                // follow-up of a decided case -> duplicate
    accRow(35, { conversation_id: null, updated_at: iso(24 * 20), created_at: iso(24 * 20) }), // legacy, never touched
    accRow(36, { ai_recommendation: null }),                                               // incomplete
    accRow(37, { community_id: EAGLE, community_name: 'Eaglewood' }),                      // inactive
    { id: u(38), status: 'decided', community_id: C1, homeowner_address: '1 Dup Ln', created_at: iso(24 * 8), decided_at: iso(24 * 8) },
  ],
  email_messages: [{ conversation_id: 'c31', direction: 'inbound', received_at: iso(24 * 2) }],
  objectives: [], objective_events: [], manager_wakes: [], board_packets: [], cron_runs: [], acc_finalizations: [], board_packet_distribution_log: [],
});

const keysOf = (f, lane) => f.lanes[lane].map((i) => i.key);

check('three lanes from the audited rules: needs you now / waiting / policy (W-9 hold)', async () => {
  const f = await buildFeed(readOnlyDb(world()), { now: NOW, env: {} });
  assert.deepStrictEqual(keysOf(f, 'policy'), [`ap_invoice:${u(2)}`]);
  assert.ok(f.lanes.policy[0].policy_note && /informational/.test(f.lanes.policy[0].policy_note));
  assert.deepStrictEqual(new Set(keysOf(f, 'now')), new Set([`ap_invoice:${u(3)}`, `ap_invoice:${u(4)}`, `ap_invoice:${u(5)}`, `ap_exception:${u(21)}`, `acc_decision:${u(30)}`, `acc_decision:${u(31)}`, `acc_decision:${u(32)}`]));
  assert.deepStrictEqual(new Set(keysOf(f, 'waiting')), new Set([`ap_invoice:${u(1)}`, `ap_exception:${u(20)}`, `ap_exception:${u(22)}`, `acc_decision:${u(33)}`]));
  assert.deepStrictEqual(f.counts, { now: 7, waiting: 4, policy: 1 });
  assert.strictEqual(f.model_calls, 0); assert.deepStrictEqual(f.actions, []);
});

check('AP rules: residue, routine line flags and inactive communities never surface; past-due counts even without needs_review', async () => {
  const f = await buildFeed(readOnlyDb(world()), { now: NOW, env: {} });
  const all = [...keysOf(f, 'now'), ...keysOf(f, 'waiting'), ...keysOf(f, 'policy')];
  assert.ok(!all.includes(`ap_invoice:${u(6)}`), 'routine line-level flags stay in Payables');
  assert.ok(!all.includes(`ap_invoice:${u(7)}`), 'human-approved needs_review residue is not surfaced');
  assert.ok(!all.includes(`ap_invoice:${u(8)}`), 'inactive community excluded from the daily feed');
  assert.ok(all.includes(`ap_invoice:${u(4)}`), 'past due + unapproved surfaces');
  assert.strictEqual(f.elsewhere.ap_routine_in_payables, 1);
  assert.strictEqual(f.elsewhere.ap_approved_awaiting_release, 1);
  const pd = f.lanes.now.find((i) => i.key === `ap_invoice:${u(4)}`); assert.match(pd.why, /past due since .* and not approved/i);
  const np = f.lanes.now.find((i) => i.key === `ap_invoice:${u(5)}`); assert.match(np.why, /First bill from this vendor/);
  const hold = f.lanes.waiting.find((i) => i.key === `ap_invoice:${u(1)}`); assert.match(hold.why, /^On hold 2026-08-18/);
});

check('ACC rules: new docs / homeowner wrote / no decision = now; more-info requested = waiting; duplicates, legacy, incomplete and inactive are kept out (counted)', async () => {
  const f = await buildFeed(readOnlyDb(world()), { now: NOW, env: {} });
  const why = (n) => (f.lanes.now.concat(f.lanes.waiting).find((i) => i.key === `acc_decision:${u(n)}`) || {}).why || '';
  assert.match(why(30), /New documents arrived/); assert.match(why(31), /homeowner wrote again/); assert.match(why(32), /No decision has been sent yet/); assert.match(why(33), /More information requested/);
  assert.strictEqual(f.elsewhere.acc_possible_duplicates, 1);
  assert.strictEqual(f.elsewhere.acc_legacy_or_incomplete, 2);
  assert.ok(f.elsewhere.inactive_community >= 3, 'Eaglewood bill + exception + ACC counted, not surfaced');
});

check('intake exceptions: missing piece or reimbursement coding = waiting; otherwise now; unidentified community stays visible', async () => {
  const f = await buildFeed(readOnlyDb(world()), { now: NOW, env: {} });
  const w = f.lanes.waiting.find((i) => i.key === `ap_exception:${u(20)}`);
  assert.strictEqual(w.community, 'Community not identified'); assert.match(w.why, /which community/);
  assert.match(f.lanes.waiting.find((i) => i.key === `ap_exception:${u(22)}`).why, /expense account/);
  assert.match(f.lanes.now.find((i) => i.key === `ap_exception:${u(21)}`).why, /^Payment requested/, 'capitalized reason from the record');
});

check('every surfaced item has an exact "Take action" destination (navigation only)', async () => {
  const f = await buildFeed(readOnlyDb(world()), { now: NOW, env: {} });
  for (const i of [...f.lanes.now, ...f.lanes.waiting, ...f.lanes.policy]) {
    assert.strictEqual(i.action.label, 'Take action');
    const id = i.key.split(':')[1];
    if (i.kind === 'ap_invoice') assert.strictEqual(i.action.href, `/#tab=ap&invoice=${id}`);
    if (i.kind === 'acc_decision') assert.strictEqual(i.action.href, `/#tab=acc&decision=${id}`);
    if (i.kind === 'ap_exception') assert.strictEqual(i.action.href, `/admin/ap?exception=${id}`);
    assert.ok(i.title && i.why, 'what + why present');
  }
});

check('summary is a template over the three lanes; empty state; capped "+"', async () => {
  const f = await buildFeed(readOnlyDb(world()), { now: NOW, env: {} });
  assert.match(f.summary, /^7 need you now \(Emma \d, Annie 3\) · 4 waiting on something · 1 for your decision\.$/);
  const e = await buildFeed(readOnlyDb({}), { now: NOW, env: {} });
  assert.strictEqual(e.summary, 'Nothing needs a person right now.'); assert.deepStrictEqual(e.counts, { now: 0, waiting: 0, policy: 0 });
  assert.match(summarize({ counts: { now: 2, waiting: 0, policy: 0 }, by_specialist: { Emma: 2 }, capped: ['ap_invoices'] }), /^2\+ need you now/);
});

check('failure semantics: an unanswered source is reported, never counted as clear', async () => {
  const f = await buildFeed(readOnlyDb(world(), { fail: ['acc_decisions', 'manager_wakes'] }), { now: NOW, env: {} });
  assert.ok(f.section_errors.acc && f.section_errors.wakes);
  assert.strictEqual(f.routine_24h, null);
  assert.ok(f.lanes.now.some((i) => i.kind === 'ap_invoice'), 'other sources still shown');
});

check('community scope keeps that community plus unidentified rows', async () => {
  const f = await buildFeed(readOnlyDb(world()), { communityId: C1, now: NOW, env: {} });
  const all = [...keysOf(f, 'now'), ...keysOf(f, 'waiting'), ...keysOf(f, 'policy')];
  assert.ok(all.includes(`ap_exception:${u(20)}`) && !all.includes(`ap_exception:${u(21)}`));
});

check('drawer carries the same exact destination; read-only', async () => {
  const db = readOnlyDb(world());
  const d = await buildItem(db, `ap_invoice:${u(1)}`);
  assert.strictEqual(d.action.href, `/#tab=ap&invoice=${u(1)}`); assert.ok(d.facts.some((x) => /^Hold: On hold 2026-08-18/.test(x)));
  assert.strictEqual((await buildItem(db, `acc_decision:${u(30)}`)).action.href, `/#tab=acc&decision=${u(30)}`);
  assert.strictEqual((await buildItem(db, `ap_exception:${u(20)}`)).action.href, `/admin/ap?exception=${u(20)}`);
  assert.deepStrictEqual(d.actions, []); assert.strictEqual(d.model_calls, 0);
  await assert.rejects(() => buildItem(db, 'payments:1'), (x) => x.code === 'BAD_INPUT');
});

check('helpers: hold reason starts at "on hold"; inactive / demo communities leave the daily feed', () => {
  assert.strictEqual(holdReason('Emma: loaded from email. ON HOLD (Issue #14): W-9 required.'), 'ON HOLD (Issue #14): W-9 required.');
  assert.strictEqual(holdReason(''), 'On hold; the reason is not recorded on the bill.');
  assert.strictEqual(activeFor({ management_status: 'terminating' }, 'acc'), false);
  assert.strictEqual(activeFor({ management_status: 'active', financials_active: false }, 'ap'), false);
  assert.strictEqual(activeFor({ management_status: 'active', is_demo: true }, 'ap'), false);
  assert.strictEqual(activeFor(null, 'ap'), true, 'unidentified community still needs placing');
});

check('deep links: parse exact records, keep bare #tab=, fall back on missing/invalid ids', () => {
  assert.deepStrictEqual(DL.parseTabHash('#tab=ap'), { tab: 'ap', record: null });
  assert.deepStrictEqual(DL.parseTabHash('#tab=vantaca-imports'), { tab: 'vantaca-imports', record: null });
  assert.deepStrictEqual(DL.parseTabHash(`#tab=ap&invoice=${u(1)}`), { tab: 'ap', record: { kind: 'invoice', id: u(1) } });
  assert.deepStrictEqual(DL.parseTabHash(`#tab=acc&decision=${u(2).toUpperCase()}`), { tab: 'acc', record: { kind: 'decision', id: u(2) } });
  assert.deepStrictEqual(DL.parseTabHash('#tab=ap&invoice=not-a-uuid'), { tab: 'ap', record: null }, 'invalid id -> just the tab');
  assert.deepStrictEqual(DL.parseTabHash(`#tab=ap&decision=${u(3)}`), { tab: 'ap', record: null }, 'a key that does not belong to the tab is ignored');
  assert.deepStrictEqual(DL.parseTabHash(`#tab=inspect&invoice=${u(3)}`), { tab: 'inspect', record: null });
  assert.strictEqual(DL.parseTabHash(''), null); assert.strictEqual(DL.parseTabHash('#something'), null);
  assert.strictEqual(DL.parseExceptionParam(`?exception=${u(4)}`), u(4));
  assert.strictEqual(DL.parseExceptionParam(`?a=1&exception=${u(4)}&b=2`), u(4));
  assert.strictEqual(DL.parseExceptionParam('?exception=<script>'), null);
  assert.strictEqual(DL.parseExceptionParam(''), null);
});

check('pages wire the links as navigation only, with the old bare-tab path intact', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(/<script src="\/app\/deeplink\.js"><\/script>/.test(idx));
  assert.ok(/window\.TXDeepLink\.parseTabHash\(location\.hash\)/.test(idx) && /window\.apOpenInvoice\(rec\.id\)/.test(idx) && /setAccMode\('review'\); accOpenDetail\(rec\.id\)/.test(idx));
  assert.ok(/match\(\/\^#tab=\(\[a-z0-9-\]\+\)\$\/i\)/.test(idx), 'fallback for a missing helper keeps the original bare-tab regex');
  const ap = fs.readFileSync(path.join(__dirname, '..', 'public', 'ap-invoices.html'), 'utf8');
  assert.ok(/<script src="\/app\/deeplink\.js"><\/script>/.test(ap) && /parseExceptionParam\(location\.search\)/.test(ap) && /focusExceptionFromUrl\(\);\n?\s*\}catch/.test(ap.replace(/\r/g, '')));
  // the highlighted row stays in view while later sections above it load (live finding 2026-10-04), and yields to the user
  assert.ok(ap.includes('function keepExceptionInView(card)') && ap.includes('new ResizeObserver') && ap.includes("['wheel','touchstart','keydown','mousedown']") && ap.includes('setTimeout(stop,5000)'));
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app', 'today.html'), 'utf8');
  const feedJs = html.slice(html.indexOf('// ---- Operations Feed (Issue #29'), html.indexOf('// ---- Message Amanda (Issue #29 Phase 2A)')); // the feed itself; the composer below is a separate proposals-only door
  assert.ok(/Take action/.test(feedJs) && /Needs you now/.test(feedJs) && /Waiting on something/.test(feedJs) && /Policy \/ Ed decision/.test(feedJs));
  assert.ok(!/TX\.post\(|<form|method="post"/i.test(feedJs), 'no write controls in the feed');
});

check('read-only by construction: no writes, no model or mail modules, GET-only admin API, board portal untouched', () => {
  for (const f of ['lib/feed/build.js', 'api/feed.js', 'public/app/deeplink.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/\.(insert|update|upsert|delete)\(/.test(src), `${f} writes`);
    assert.ok(!/require\([^)]*(ai\/|anthropic|openai|graph_send|notifications|email)/.test(src), `${f} pulls a model or mail module`);
  }
  const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'feed.js'), 'utf8');
  assert.ok(!/router\.(post|put|patch|delete)\(/.test(api));
  assert.strictEqual((api.match(/requireAdmin\(req, res\)/g) || []).length, 2);
  assert.ok(!/lib\/feed/.test(fs.readFileSync(path.join(__dirname, '..', 'api', 'board_portal.js'), 'utf8')));
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) {
    try { await fn(); pass += 1; console.log(`  ✓ ${n}`); } catch (e) { fail += 1; console.log(`  ✗ ${n}\n    ${String(e.stack).split('\n').slice(0, 4).join('\n    ')}`); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
