// ============================================================================
// tests/test_forward_hygiene.js  (Ed 2026-07-16)
// ----------------------------------------------------------------------------
// An internal review forward MUST NOT reach the homeowner. One did: Azalia
// Fuenmayor was Cc'd on a note to Martha that discussed her and said "nothing
// has been sent to the homeowner yet." The Cc had defaulted to the original
// sender — who, on a homeowner email, is the homeowner.
//
// This is a privacy breach, which is precisely the class that must fail a build
// rather than be caught in review. So the guard is a pure, tested function.
//
// Run: npm run test:forward-hygiene
// ============================================================================
const { internalRecipients, stripQuoted } = require('../lib/email/forward_hygiene');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`); }
};

console.log('\n\x1b[1mForward hygiene — the homeowner is never on an internal forward\x1b[0m\n');

// The exact breach: forwarding to Martha, with the homeowner defaulted into Cc.
const HOMEOWNER = 'fuenmayorazalia@gmail.com';
const breach = internalRecipients({ toEmail: 'mbravo@bedrocktx.com', ccEmail: HOMEOWNER, senderEmail: HOMEOWNER });
check('the homeowner is stripped from Cc', !breach.cc.includes(HOMEOWNER) && !breach.to.includes(HOMEOWNER), JSON.stringify(breach));
check('Martha (staff) still receives it', breach.to.includes('mbravo@bedrocktx.com'));
check('the stripped homeowner is reported back', breach.dropped.includes(HOMEOWNER));

// The original sender is dropped even if they're somehow a bedrock-looking dupe
// or typed into To directly.
const senderInTo = internalRecipients({ toEmail: `${HOMEOWNER}, laurie@bedrocktx.com`, ccEmail: '', senderEmail: HOMEOWNER });
check('an external address typed into To is stripped, staff kept', senderInTo.to.length === 1 && senderInTo.to[0] === 'laurie@bedrocktx.com', JSON.stringify(senderInTo));

// ANY outside address, not just the sender — a forward must never leak out.
const outsider = internalRecipients({ toEmail: 'mbravo@bedrocktx.com', ccEmail: 'someone@gmail.com, board@hoaboard.org', senderEmail: HOMEOWNER });
check('every non-@bedrocktx.com address is stripped from Cc', outsider.cc.length === 0, JSON.stringify(outsider.cc));
check('...and all of them are reported dropped', outsider.dropped.includes('someone@gmail.com') && outsider.dropped.includes('board@hoaboard.org'));

// Nothing internal left => the caller must refuse (empty to []).
const noInternal = internalRecipients({ toEmail: HOMEOWNER, ccEmail: '', senderEmail: HOMEOWNER });
check('forwarding ONLY to the homeowner leaves no recipient (caller refuses)', noInternal.to.length === 0);

// A legitimate all-internal forward is untouched.
const clean = internalRecipients({ toEmail: 'mbravo@bedrocktx.com', ccEmail: 'laurie@bedrocktx.com', senderEmail: HOMEOWNER });
check('a genuine staff-to-staff forward passes through', clean.to.length === 1 && clean.cc.length === 1 && clean.dropped.length === 0);

// De-dupe: an address in both To and Cc doesn't get copied twice.
const dup = internalRecipients({ toEmail: 'mbravo@bedrocktx.com', ccEmail: 'mbravo@bedrocktx.com', senderEmail: HOMEOWNER });
check('an address in both To and Cc is not duplicated', dup.to.length === 1 && dup.cc.length === 0);

console.log('\n\x1b[1mForward body — readable, not a quoted wall\x1b[0m\n');

// The real Azalia email shape: a new line, then the entire chain quoted inline.
const walled = `Hi Martha, I'm following up on my request for the new pool access card. Please let me know how I should proceed. Thank you, Azalia Fuenmayor On Fri, Jun 12, 2026 at 11:56 AM AZALIA FUENMAYOR SANCHEZ <${HOMEOWNER}> wrote: Hi Martha, Thank you for the option to pick up the card at the board meeting. On Wed, Jun 10, 2026 at 4:04 PM Bedrock Information wrote: We can mail it...`;
const stripped = stripQuoted(walled);
check('keeps the new message', /following up on my request/.test(stripped));
check('drops the quoted chain', !/board meeting/.test(stripped) && !/We can mail it/.test(stripped), stripped);
check('drops the "On <date> ... wrote:" quote marker itself', !/wrote:/.test(stripped), stripped);

// A bare forwarded chain (no new text before the quote) keeps SOMETHING rather
// than sending a blank block.
const bareQuote = 'On Wed, Jun 10, 2026 at 4:04 PM Bedrock wrote: original content here';
check('an all-quote body is not blanked', stripQuoted(bareQuote).length > 0);

// Outlook-style header block is also cut.
const outlook = `Please review this.\nFrom: Azalia\nSent: Monday\nTo: Bedrock\nSubject: Pool`;
check('Outlook "From:/Sent:" header block is cut', stripQuoted(outlook) === 'Please review this.', JSON.stringify(stripQuoted(outlook)));

console.log('');
if (failures) { console.log(`\x1b[31m\x1b[1m✗ ${failures} check(s) failed.\x1b[0m\n`); process.exitCode = 1; }
else console.log('\x1b[32m\x1b[1m✓ Forward hygiene: all checks passed.\x1b[0m\n');
