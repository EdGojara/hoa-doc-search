// Tests for Tessa's lunch-order collection logic (lib/ea/lunch*.js).
// Pure pieces only — ref-code format/matching, reply-quote stripping, and the
// no-AI order-parse fallback (a reply is never dropped). (Ed 2026-09-05.)
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
delete process.env.ANTHROPIC_API_KEY; // force the deterministic fallback path

const assert = require('assert');
const { genRefCode, fmtUsd } = require('../lib/ea/lunch');
const { parseOrder, topOfReply } = require('../lib/ea/lunch_reply');
const { isLunchQuestion, resolveDate, buildAnswer } = require('../lib/ea/lunch_question');

let failures = 0;
function check(name, fn) { try { fn(); console.log('  ok  ' + name); } catch (e) { failures++; console.error('  FAIL ' + name + ' — ' + e.message); } }
async function acheck(name, fn) { try { await fn(); console.log('  ok  ' + name); } catch (e) { failures++; console.error('  FAIL ' + name + ' — ' + e.message); } }

// The ref-code must look like LUN-XXXX and match the reply-subject regex the
// poller uses, or replies won't thread back to the round.
const SUBJECT_RE = /\[(LUN-[A-Z0-9]{3,6})\]/i;
check('ref-code is LUN-XXXX and matches the reply regex', () => {
  for (let i = 0; i < 50; i++) {
    const code = genRefCode();
    assert.ok(/^LUN-[A-Z0-9]{4}$/.test(code), 'bad ref-code: ' + code);
    const m = `Re: [${code}] Lunch order`.match(SUBJECT_RE);
    assert.ok(m && m[1].toUpperCase() === code, 'ref-code did not match subject regex: ' + code);
  }
});
check('ref-codes avoid ambiguous characters', () => {
  const s = new Set();
  for (let i = 0; i < 200; i++) s.add(genRefCode());
  assert.ok(![...s].some((c) => /[O0I1L]/.test(c.slice(4))), 'contains ambiguous char');
});

check('fmtUsd formats cents', () => {
  assert.strictEqual(fmtUsd(1495), '$14.95');
  assert.strictEqual(fmtUsd(0), '$0.00');
  assert.strictEqual(fmtUsd(null), null);
});

check('topOfReply strips quoted history', () => {
  const body = 'The Cuban, no pickles please\n\nOn Fri, Sep 5, Tessa wrote:\n> what would you like for lunch?';
  const t = topOfReply(body);
  assert.ok(/Cuban/.test(t), 'kept their words');
  assert.ok(!/what would you like/.test(t), 'dropped the quoted original');
});

(async () => {
  // No AI key → fallback keeps the raw words rather than losing the order.
  await acheck('parseOrder keeps the raw order when AI is unavailable', async () => {
    const r = await parseOrder('The Cuban sandwich, no pickles', 'Paulie\'s Poboys');
    assert.ok(r && /Cuban/.test(r.item), 'should keep the item text');
    assert.strictEqual(r.confident, false);
  });
  await acheck('parseOrder returns null for an empty reply', async () => {
    assert.strictEqual(await parseOrder('   ', 'Paulie\'s'), null);
  });

  // ---- Lunch question responder --------------------------------------------
  check('isLunchQuestion recognizes real questions and ignores the rest', () => {
    assert.ok(isLunchQuestion('what is for lunchdrop on wednesday'), "Ed's exact phrasing");
    assert.ok(isLunchQuestion("What's for lunch tomorrow?"));
    assert.ok(isLunchQuestion('lunchdrop menu?'));
    assert.ok(!isLunchQuestion('Please approve the vendor invoice.'), 'not lunch');
    assert.ok(!isLunchQuestion("let's grab lunch sometime"), 'lunch but not a question');
  });

  check('resolveDate maps day references correctly', () => {
    const now = new Date('2026-09-05T12:00:00'); // fixed reference
    const ymd = (d) => d.toISOString().slice(0, 10);
    assert.strictEqual(resolveDate('what about today', now), ymd(now), 'today');
    const tmr = new Date(now); tmr.setDate(tmr.getDate() + 1);
    assert.strictEqual(resolveDate('lunch tomorrow?', now), ymd(tmr), 'tomorrow');
    assert.strictEqual(resolveDate('menu for 2026-09-11 please', now), '2026-09-11', 'explicit date');
    // A weekday resolves to its next occurrence (within a week) with that weekday.
    const wed = resolveDate('what is for lunch on wednesday', now);
    assert.strictEqual(new Date(wed + 'T12:00:00').getDay(), 3, 'resolved to a Wednesday');
    assert.ok(wed >= ymd(now) && wed <= '2026-09-11', 'within the coming week: ' + wed);
  });

  check('buildAnswer lists restaurants + says so when the menu is missing', () => {
    const rows = [{ restaurant_name: 'Paulie\'s Poboys', items: [{ name: 'The Cuban', price_cents: 1395 }], cutoff_text: 'Order by 10:30am Wednesday' }];
    const a = buildAnswer('2026-09-09', rows, 'Ed');
    assert.ok(/Paulie's Poboys/.test(a) && /The Cuban/.test(a) && /\$13\.95/.test(a), 'lists the restaurant + item + price');
    assert.ok(/10:30am/.test(a), 'includes the cutoff');
    const none = buildAnswer('2026-09-09', [], 'Ed');
    assert.ok(/don't have/i.test(none), 'honest when menu not captured');
  });

  if (failures) { console.error('\n' + failures + ' lunch test(s) failed.'); process.exit(1); }
  console.log('\nAll lunch tests passed.');
})();
