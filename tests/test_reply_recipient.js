// Tests for lib/email/reply_recipient — the contact-form reply-to extractor.
// Scar: Claire's reply to Bich Pham went to the Eaglewood form's relay address
// (mkessler@bedrocktx.com) instead of the homeowner's real address in the body.
const assert = require('assert');
const { extractFormContact, suggestReplyTo } = require('../lib/email/reply_recipient');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓', name); };

// The real Eaglewood contact-form body (the incident).
const EAGLEWOOD = `Name: Bich Pham
Email: briantranpham@gmail.com
Phone: 8324367570
Message: Hello,

I would like to report a couple of concerns regarding the property directly behind my home.
My Home Address: 16323 Scotch Hollow Ln
Neighbors Address: 16402 Eaglewood Shadows Dr`;

console.log('reply_recipient:');

t('extracts the homeowner from a contact-form body', () => {
  const c = extractFormContact(EAGLEWOOD);
  assert.strictEqual(c.email, 'briantranpham@gmail.com');
  assert.strictEqual(c.name, 'Bich Pham');
  assert.strictEqual(c.phone, '8324367570');
});

t('suggests the body email over the relay sender (the incident)', () => {
  const s = suggestReplyTo({ senderEmail: 'mkessler@bedrocktx.com', senderName: 'Eaglewood Community', bodyText: EAGLEWOOD });
  assert.strictEqual(s.email, 'briantranpham@gmail.com');
  assert.strictEqual(s.source, 'form_body');
});

t('falls back to sender when there is no labeled email in the body', () => {
  const s = suggestReplyTo({ senderEmail: 'jane@gmail.com', senderName: 'Jane', bodyText: 'Hi, my fence is broken, please help. Thanks, Jane' });
  assert.strictEqual(s.email, 'jane@gmail.com');
  assert.strictEqual(s.source, 'sender');
});

t('does not re-suggest when the body email equals the sender', () => {
  const body = 'Email: jane@gmail.com\nMessage: hello';
  const s = suggestReplyTo({ senderEmail: 'jane@gmail.com', bodyText: body });
  assert.strictEqual(s.source, 'sender');
  assert.strictEqual(s.email, 'jane@gmail.com');
});

t('handles E-mail / Reply-to / From labels and trailing punctuation', () => {
  assert.strictEqual(extractFormContact('E-mail: a@b.com.').email, 'a@b.com');
  assert.strictEqual(extractFormContact('Reply-To: c@d.org').email, 'c@d.org');
  assert.strictEqual(extractFormContact('From: e@f.net\n').email, 'e@f.net');
});

t('ignores an unlabeled email sitting in prose', () => {
  // No labeled field -> nothing suggested (conservative: avoid signatures/quotes).
  const c = extractFormContact('Please email me back sometime at random@nowhere.com maybe');
  assert.strictEqual(c.email, null);
});

t('empty / null body is safe', () => {
  assert.deepStrictEqual(extractFormContact(''), { name: null, email: null, phone: null });
  const s = suggestReplyTo({ senderEmail: 'x@y.com', bodyText: null });
  assert.strictEqual(s.email, 'x@y.com');
});

console.log(`\nreply_recipient: ${passed} passed`);
