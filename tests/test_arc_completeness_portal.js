// Portal ARC submissions send one free-text description. A detail the homeowner
// already wrote there must count, and a portal homeowner is never told to
// "reply to this email" (no email is sent). (Ed 2026-11-27 launch test.)
'use strict';
const assert = require('assert');
const { checkCompleteness } = require('../lib/applications/completeness');
const atts = [{ id: 1 }, { id: 2 }];
const fence = (description) => checkCompleteness({ service_type: 'fence', application_data: { description }, attachments: atts, channel: 'portal' });
assert.strictEqual(fence('Replace 6 ft cedar privacy fence along the rear property line').passed, true, 'material and height in the description count');
assert.strictEqual(fence("New 8' wrought iron fence in the side yard").passed, true);
const vague = fence('New fence in the back');
assert.ok(!vague.passed && vague.issues.some((i) => i.rule_id === 'material') && vague.issues.some((i) => i.rule_id === 'height'), 'still asks when the detail is not there');
assert.ok(/Messages in your portal/.test(vague.message) && !/Reply to this email/.test(vague.message), 'portal homeowners are told where to send additions');
const emailed = checkCompleteness({ service_type: 'fence', application_data: { description: 'New fence' }, attachments: [] });
assert.ok(/Reply to this email/.test(emailed.message), 'the emailed flow keeps its wording');
const roof = checkCompleteness({ service_type: 'roof', application_data: { description: 'Replace with architectural shingles', color: 'Weathered Wood', contractor: 'Acme Roofing' }, attachments: atts, channel: 'portal' });
assert.strictEqual(roof.passed, true, 'roof material, color and the portal contractor field count');
for (const r of [vague, emailed, roof]) assert.ok(!/\u2014/.test(r.message + r.issues.map((i) => i.ask).join(' ')), 'no em-dash in homeowner text');
assert.ok(!/\u2014/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'lib/applications/completeness.js'), 'utf8').split('\n').filter((l) => /ask:|message =/.test(l)).join('\n')), 'no em-dash in any ask');
console.log('test_arc_completeness_portal: ok');
