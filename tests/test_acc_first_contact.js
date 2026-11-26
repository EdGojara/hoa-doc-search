// ============================================================================
// tests/test_acc_first_contact.js  (Ed 2026-11-26)
// ----------------------------------------------------------------------------
// Coordinated communication + measurable deadlines for architectural
// applications:
//   * ONE first message: Annie's outcome carries the receipt (6331 Clear Canyon
//     got two emails seconds apart);
//   * several improvements with different outcomes are answered per improvement
//     in one email, never stalled (WAT-ARC-2026-0054);
//   * greetings never guess a first name from a company ("Hi Open,");
//   * Bedrock's service clock and the association clock are separate and anchored
//     to receipt.
// Run: node tests/test_acc_first_contact.js
// ============================================================================
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
const fs = require('fs');
const path = require('path');
const S = require('../lib/email/salutation');
const C = require('../lib/email/acc_cover_note');
const SC = require('../lib/acc/service_clock');
const MI = require('../lib/acc/multi_item');
const FC = require('../lib/acc/first_contact');
const DA = require('../lib/acc/decision_authority');
const ACK = require('../lib/acc/acknowledge');

let failures = 0;
const check = (name, cond, detail) => { if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`); else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`); } };

console.log('\nGreetings: a person\'s name or a neutral greeting, never a guess');
check('an LLC gets "Hello," (not "Hi Open,")', S.greeting('Open House Texas Realty & Investments LLC') === 'Hello,');
check('two owners: both first names', S.greeting('I-Tsun Chang and Sheue-Jin Chang') === 'Hi I-Tsun and Sheue-Jin,');
check('a title is skipped', S.greeting('Mr. John Smith') === 'Hi John,');
check('placeholders and blanks: neutral', S.greeting('Homeowner') === 'Hello,' && S.greeting('') === 'Hello,');
check('trusts, investors and builders: neutral', ['Smith Family Trust', 'Opendoor Property J LLC', 'Invitation Homes'].every((n) => S.greeting(n) === 'Hello,'));
check('the receipt uses it', ACK.acknowledgmentText({ applicantName: 'Open House Texas Realty & Investments LLC', reference: 'R' }).body.startsWith('Hello,'));
check('the cover notes use it', C.composeAccCoverNote({ decisionType: 'request_more_info', homeownerName: 'Open House Texas Realty & Investments LLC' }).startsWith('Hello,'));

console.log('\nOne first message: the outcome carries the receipt');
const fc = { reference: 'CAN-ARC-2026-0005', receivedAt: '2026-11-26T17:19:00Z' };
let m = C.composeAccDecisionEmail({ decisionType: 'request_more_info', homeownerName: 'Maria Lopez', homeownerAddress: '123 Example Ln, Katy', projectSummary: 'Removal of 5 trees', letterBody: 'Dear Maria,\n\n1. An arborist report.\n', communityName: 'Canyon Gate', firstContact: fc });
check('request + receipt in one message: date and reference, then the items', /November 26, 2026/.test(m.text) && /CAN-ARC-2026-0005/.test(m.text) && /We have already reviewed it/.test(m.text) && /An arborist report/.test(m.text) && /We received your architectural application/.test(m.subject), m.text);
m = C.composeAccDecisionEmail({ decisionType: 'approved_with_conditions', homeownerName: 'Maria Lopez', homeownerAddress: '123 Example Ln', projectSummary: 'Roof replacement', letterBody: 'Dear Maria Lopez,', firstContact: fc });
check('decision + receipt in one message, application named once', /We received it on November 26, 2026/.test(m.text) && /We have reviewed it, and it has been approved with conditions/.test(m.text) && (m.text.match(/roof replacement/gi) || []).length === 1, m.text);
m = C.composeAccDecisionEmail({ decisionType: 'approved', homeownerName: 'Maria Lopez', homeownerAddress: '123 Example Ln', projectSummary: 'Roof replacement', letterBody: 'Dear Maria Lopez,' });
check('a later decision (already acknowledged) is unchanged', !/We received it/.test(m.text) && /has been approved/.test(m.text));
check('no em-dashes in homeowner text', !/—/.test(m.text + C.composeAccDecisionEmail({ decisionType: 'request_more_info', homeownerName: 'A B', letterBody: '1. x', firstContact: fc }).text));
const sv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check('finalize treats the first email on a case as the receipt', /const firstContact = dec\.acknowledged_at \? null :/.test(sv));
check('the decision owner\'s review gets an honest "may take longer" receipt, no date promised', FC.longerReviewReason({}, { route: 'committee_or_board_required' }) === "requires the Architectural Committee's review"
  && /may take a little longer/.test(ACK.acknowledgmentText({ applicantName: 'Maria Lopez', longerReview: 'requires additional review' }).body) && !/by (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/.test(ACK.acknowledgmentText({ applicantName: 'Maria Lopez', longerReview: 'requires additional review' }).body));
const fcs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'acc', 'first_contact.js'), 'utf8');
check('outcome first, receipt only when nothing else is ready; window timer is one-shot', fcs.indexOf('I.issueIfReady(supabase, id') < fcs.indexOf('sendReceipt(supabase, row, { longerReview: longer })')
  && /setTimeout\(/.test(fcs) && !/setInterval\(/.test(fcs) && /ACC_ACK_WINDOW_MINUTES/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'acc', 'service_clock.js'), 'utf8')));
check('never the historical backlog', /isBacklogHeld\(row\)\) return \{ outcome: 'skipped', detail: 'backlog hold' \}/.test(fcs));

console.log('\nSeveral improvements, different outcomes (WAT-ARC-2026-0054)');
const mixed = 'Thank you for your architectural applications. For Application #1 we need a photo. For Application #3 (Fence Man Gate Replacement), we are pleased to approve your application subject to the following conditions: 1. ...';
check('a request letter that also approves is detected', MI.mixesOutcomes(mixed) && !MI.mixesOutcomes('Please send a current photograph of the front of the home.'));
const good = { items: [
  { n: 1, title: 'Front door painting', outcome: 'request_more_info', missing: ['a current photo of the front of the home'] },
  { n: 2, title: 'Exterior touch-up painting', outcome: 'request_more_info', missing: ['paint brand, product and color code per surface'] },
  { n: 3, title: 'Fence man gate replacement', outcome: 'approved_with_conditions', missing: [], letter_body: 'Dear Owner,\n\nYour application is approved subject to the conditions below.' },
], request_letter_body: 'Dear Owner,\n\nTo complete the review of the front door and the touch-up painting, please send a current photograph and the paint specifications.' };
check('a valid per-improvement plan passes', MI.validatePlan(good).length === 0, MI.validatePlan(good).join('; '));
check('a request letter that still decides something is refused', MI.validatePlan({ ...good, request_letter_body: 'Regarding your architectural applications: for Application #3 (Fence Man Gate Replacement), we are pleased to approve your application subject to the following conditions. Please send a photo for the door.' }).some((e) => /still decides/.test(e)));
check('a decision without its own letter is refused', MI.validatePlan({ ...good, items: good.items.map((it) => (it.n === 3 ? { ...it, letter_body: '' } : it)) }).some((e) => /without a letter/.test(e)));
check('a request without the missing items is refused', MI.validatePlan({ ...good, items: good.items.map((it) => (it.n === 1 ? { ...it, missing: [] } : it)) }).some((e) => /without the missing items/.test(e)));
m = C.composeMultiItemEmail({ homeownerName: 'Open House Texas Realty & Investments LLC', homeownerAddress: '123 Example Ln, Richmond', communityName: 'Waterview Estates', reference: 'WAT-ARC-2026-0054',
  items: [{ title: 'Fence man gate replacement', status: 'approved with conditions (approval letter attached)', missing: [] }, { title: 'Front door painting', status: 'needs information', missing: ['a current photo'] }] });
check('one email lists each improvement, its status, what is missing, next steps', m.text.startsWith('Hello,') && /1\. Fence man gate replacement: approved with conditions/.test(m.text) && /2\. Front door painting: needs information\. We need: a current photo/.test(m.text) && /may proceed under the conditions/.test(m.text) && /reply to this email with the items listed/.test(m.text), m.text);
const ai = fs.readFileSync(path.join(__dirname, '..', 'lib', 'acc', 'annie_issue.js'), 'utf8');
check('Annie\'s issuer routes a mixed letter to the per-improvement path (not a stall)', /MI\.mixesOutcomes\(letter\.body_text\)/.test(ai) && /MI\.respondMultiItem\(supabase, id, \{ issuer \}\)/.test(ai));
const mis = fs.readFileSync(path.join(__dirname, '..', 'lib', 'acc', 'multi_item.js'), 'utf8');
check('only decisions within Annie\'s delegated authority are issued', /a\.route === 'annie_decides' && a\.annie && a\.annie\.ok && a\.annie\.outcome === c\.row\.ai_recommendation/.test(mis));
check('companions (several letters in one email) are honored only from Annie\'s in-process issuer', /req\._accAgentIssuer && body\.companion/.test(sv));

console.log('\nTwo clocks, anchored to receipt');
const ACTIVE_ROW = { id: 'x', status: 'pending_review', community_name: 'Canyon Gate at Cinco Ranch', created_at: '2026-11-26T18:17:00Z', updated_at: '2026-11-26T18:17:06Z', ai_recommendation: 'request_more_info', ai_review_text: 'x', project_summary: 'Removal of 5 trees', submitter_email: 'a@example.test' };
let k = SC.serviceClock(ACTIVE_ROW, { now: new Date('2026-11-26T18:20:00Z') });
const ack = k.stages.find((s) => s.key === 'acknowledgment');
check('acknowledgment due 30 minutes from ingestion', ack && ack.due_at === '2026-11-26T18:47:00.000Z', JSON.stringify(ack));
const ir = k.stages.find((s) => s.key === 'info_request');
check('routine missing-information request due within 60 minutes', ir && ir.due_at === '2026-11-26T19:17:00.000Z' && !k.complex, JSON.stringify(k.stages));
k = SC.serviceClock({ ...ACTIVE_ROW, acknowledged_at: '2026-11-26T19:09:07Z', decision_type: 'request_more_info', updated_at: '2026-11-26T19:09:12Z' }, { now: new Date('2026-11-27T15:00:00Z') });
check('met stages stay met (late is recorded as late, never reset)', k.stages.find((s) => s.key === 'acknowledgment').state === 'met_late' && k.stages.find((s) => s.key === 'info_request').state === 'met' && !k.next);
k = SC.serviceClock({ ...ACTIVE_ROW, project_summary: 'Pour a new 12x16 concrete patio', ai_recommendation: 'approved' }, { now: new Date('2026-11-26T18:20:00Z') });
check('complex: says why, and has initial review (4 business hours), recommendation (2 business days), escalation (1 business day)', k.complex && /Ed's approval required/.test(k.complexity_reasons[0]) && ['initial_review', 'recommendation', 'escalation'].every((x) => k.stages.some((s) => s.key === x)), JSON.stringify(k));
const four = SC.addBusinessHours('2026-11-25T21:00:00Z', 4); // Wed 3 PM CT -> 2 hrs Wed, holiday Thu/Fri (11/26-27), weekend -> Mon 10 AM CT
check('business hours skip evenings, holidays and weekends', four === '2026-11-30T16:00:00.000Z', four);
k = SC.serviceClock({ ...ACTIVE_ROW, project_summary: 'Pour a new 12x16 concrete patio', ai_recommendation: 'approved' }, { now: new Date('2026-12-10T15:00:00Z'), facts: { escalated_at: '2026-11-30T15:00:00Z' } });
check('an outstanding decision gets a follow-up every 2 business days after escalation', k.stages.some((s) => s.followup >= 2), JSON.stringify(k.stages.map((s) => s.key)));
const T = require('../lib/acc/tracking');
check('association clock is separate (governing documents) and flags near/passed', T.governing({ community_name: 'Quail Ridge', created_at: '2026-11-01T12:00:00Z' }, null, new Date('2026-11-28T12:00:00Z')).state === 'near'
  && T.governing({ community_name: 'Quail Ridge', created_at: '2026-10-01T12:00:00Z' }, null, new Date('2026-11-28T12:00:00Z')).state === 'passed');
const sch = fs.readFileSync(path.join(__dirname, '..', 'lib', 'scheduler.js'), 'utf8');
check('Amanda\'s sweep runs on the existing architectural-deadline job (no new timer)', /require\('\.\/acc\/tracking'\)\.sweep\(supabase/.test(sch));
{
  const trk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'acc', 'tracking.js'), 'utf8');
  check('the sweep skips ended communities; held (historical) cases are tracked for Ed with the association clock only, no escalation to send', /if \(comm && lifecycle\.isEnded\(comm, now\)\) continue;/.test(trk) && /const levels = held \? levelsFor\(\{ levels: \[\] \}, gov\)/.test(trk) && /if \(!held && owner && DA\.reviewAt/.test(trk) && !/\.sendAs\(|acknowledgeApplication|issueIfReady/.test(trk));
  const g = { limit_at: '2026-12-10T18:00:35Z', state: 'open' };
  const base = { decision_type: 'request_more_info', updated_at: '2026-11-26T19:44:00Z', submitter_email: 'a@example.test' };
  let na = T.nextAction(base, { next: null }, g);
  check('waiting on the homeowner: names it, owner Homeowner, due = association deadline', na.who === 'Homeowner' && na.due === g.limit_at && /Waiting on the homeowner/.test(na.text));
  na = T.nextAction({ submitter_email: 'a@example.test' }, { next: null }, g, { held: true });
  check('historical hold: owner Ed, nothing sent', na.who === 'Ed' && /nothing is sent/.test(na.text));
  na = T.nextAction({ submitter_email: null }, { next: { key: 'acknowledgment', label: 'Acknowledge receipt', owner: 'Annie', due_at: '2026-11-19T18:04:00Z' } }, g, { owner: 'Ed' });
  check('no applicant email: a person contacts the homeowner (no impossible "acknowledge" task)', /No applicant email/.test(na.text) && /Ed's/.test(na.text));
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall ACC first-contact checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
