// tests/test_completion_thanks.js — the "should we thank her when it's complete" gate.
const assert = require('assert');
const { isCompletionAck } = require('../lib/email/completion_thanks');
const P = (sender_email, body, subject) => ({ direction: 'inbound', sender_email, sender_name: 'X', body_preview: body, subject: subject || 'RE: thing' });

const YES = [
  P('mhess@newfirst.com', 'You have been added to the exception notifications and you all should be good to go with Positive Pay now.'),
  P('rep@vendor.com', "You're all set — the account is active on our end."),
  P('a@b.com', "That's been completed on our end, up and running."),
  P('c@d.com', 'Everything is set up and ready to go.'),
];
const NO = [
  P('treasurymanagement@newfirst.com', 'Positive Pay Items Ready For Review', 'Positive Pay Items Ready'), // bot
  P('rep@vendor.com', 'Can you please send me the signed form?'),        // request
  P('x@y.com', 'Please complete the attached application and return it.'),// request
  P('z@w.com', 'Following up on the past due invoice — any update on status?'), // chase
  P('h@i.com', 'When is the pool open on weekends?'),                     // question, no completion
  { direction: 'outbound', sender_email: 'kat@bedrocktx.com', body_preview: "You're all set!" }, // our own outbound
];

let pass = 0; const fails = [];
YES.forEach((e, i) => { try { assert.strictEqual(isCompletionAck(e), true); pass++; } catch (_) { fails.push('YES #' + i + ': "' + (e.body_preview || '').slice(0, 40) + '"'); } });
NO.forEach((e, i) => { try { assert.strictEqual(isCompletionAck(e), false); pass++; } catch (_) { fails.push('NO #' + i + ': "' + (e.body_preview || '').slice(0, 40) + '"'); } });
if (fails.length) { console.error('completion_thanks: ' + fails.length + ' FAILURES (' + pass + ' ok):'); fails.forEach((f) => console.error('  - ' + f)); process.exit(1); }
console.log('completion_thanks: all ' + pass + ' cases passed');
