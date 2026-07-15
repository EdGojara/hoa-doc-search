// ============================================================================
// tests/test_persona_knows_team.js  (Ed 2026-07-15)
// ----------------------------------------------------------------------------
// An AI teammate that doesn't know the team isn't a teammate.
//
// Superior LawnCare sent invoice 42778 addressed to Martha Bravo — Bedrock's own
// AP staffer. Emma's context was the vendor, the email, and the AP ledger, with
// NOTHING about her colleagues. So she read "Martha Bravo" as a stranger and
// drafted:
//
//   "I think this invoice was sent to us by mistake, we're Bedrock Association
//    Management, not Martha Bravo."
//
// One approval away from telling a vendor we'd never heard of our own staff, and
// asking them to resend an invoice that had already arrived at the right place.
// Ed: "Martha Bravo is a team member that emma should know."
//
// Nothing throws when a persona disowns a colleague — the email just reads as
// incompetent to the customer. That's the class of bug only a human notices, and
// only if they happen to read the draft. Hence a test.
//
// Run: npm run test:persona-team
// ============================================================================
require('dotenv').config({ override: true });

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + String(detail).replace(/\n/g, '\n      ') : ''}`); }
};

(async () => {
  console.log('\n\x1b[1mPersonas know their own team\x1b[0m\n');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) { console.log('  (skipped — no DB creds)\n'); return; }

  const { getTeam, teamRosterBlock } = require('../lib/email/team_roster');
  const team = await getTeam();
  check('the roster loads real staff', team.length > 0, 'roster came back empty');
  check('Martha Bravo is on it', team.some((t) => /martha/i.test(t.full_name || '')),
    'roster: ' + team.map((t) => t.full_name).join(', '));
  check('the AI teammates are on it too (a vendor writing to "Emma" must not puzzle Emma)',
    team.some((t) => /emma/i.test(t.full_name || '')) && team.some((t) => /claire/i.test(t.full_name || '')));
  const block = await teamRosterBlock();
  check('the roster block names Martha for the prompt', /Martha Bravo/.test(block));
  check('the roster block forbids disowning a colleague', /never tell an outsider we don't know them/i.test(block));

  if (!process.env.ANTHROPIC_API_KEY) { console.log('\n  (draft checks skipped — no ANTHROPIC_API_KEY)\n'); return; }

  // The real thing: the exact email that produced the bad draft.
  const { draftEmmaReply } = require('../lib/email/emma_reply');
  const email = {
    subject: 'Invoice 42778 from Superior LawnCare',
    body_full: 'Dear Martha Bravo,\n\nPlease find attached invoice 42778 for $1,602.97 for tree preparation labor.\n\nThank you,\nSuperior LawnCare',
  };
  const out = await draftEmmaReply({ email, vendorId: null, vendorName: 'Superior LawnCare' });
  const body = String((out && (out.body || out.draft)) || out || '');
  console.log(`  \x1b[2mdraft: ${body.replace(/\n+/g, ' ').slice(0, 100)}…\x1b[0m`);

  check('Emma does not claim the invoice came to us by mistake',
    !/by mistake|misdirect|wrong (company|contact|address)/i.test(body), body);
  check('Emma does not disown Martha ("we\'re Bedrock, not Martha Bravo")',
    !/not Martha|don'?t (know|have) (a |any )?Martha|no one (named |called )?Martha/i.test(body), body);
  check('Emma does not ask them to resend an invoice that already arrived',
    !/resend|send it (again|over) to|send that to/i.test(body), body);

  console.log('');
  if (failures) { console.log(`\x1b[31m\x1b[1m✗ ${failures} check(s) failed.\x1b[0m\n`); process.exitCode = 1; }
  else console.log('\x1b[32m\x1b[1m✓ Persona team knowledge: all checks passed.\x1b[0m\n');
})();
