// tests/test_billing_excludes_held_letters.js — Ed 2026-11-03: a printed letter withdrawn before mailing
// (Reduce marks it 'rejected', its mail piece held) is a system error and is never billed: not as a letter,
// not its pages, not its postage. ENFORCED: every letter query in api/billing.js that reads printed
// interactions also excludes held letters (null-safe), so a new billing query cannot forget it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'api/billing.js'), 'utf8').replace(/\r\n/g, '\n');
assert.ok(/const HELD_LETTER_STATUS = 'rejected';/.test(src), 'the held status is named once');
// Every chain that selects printed letters (".not('printed_at', 'is', null)") must carry the held filter nearby.
const at = [...src.matchAll(/\.not\('printed_at', 'is', null\)/g)].map((m) => m.index);
assert.ok(at.length >= 4, 'found the billing letter queries');
for (const i of at) {
  const chain = src.slice(i, i + 220);
  assert.ok(/status\.is\.null,status\.neq\.\$\{HELD_LETTER_STATUS\}/.test(chain), 'a billing letter query does not exclude held letters: ' + src.slice(Math.max(0, i - 160), i + 60).replace(/\s+/g, ' '));
}
assert.ok(/\.in\('id', ids\)\.or\(`status\.is\.null,status\.neq\.\$\{HELD_LETTER_STATUS\}`\)/.test(src), 'recovered mailings exclude held letters');
console.log(`  ✓ ${at.length} billing letter queries exclude held letters\n\n1 passed, 0 failed`);
