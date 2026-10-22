#!/usr/bin/env node
// The AI employee email desk (Ed 2026-10-22): one desk for Amanda, Kat, Annie, Maggie and
// Miranda, configured on the roster. Offline (in-memory store, stubbed Microsoft 365 reads).
// Locks: each agent sees only their correspondence; replies stage in THEIR outbox from THEIR
// mailbox; Reply all keeps everyone but the agent; a reply already sent in the thread is never
// prepared again; drafts cannot be approved across desks; sends need a signed-in approver and
// record who, when, agent, mailbox and message id; record checks are narrow and honest;
// banking routes to Kat; Amanda's desk keeps her reply kind and guard.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://offline.invalid';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'offline';
const fs = require('fs'); const path = require('path');
const D = require('../lib/email/agent_desk');
const OF = require('../lib/agents/operational_facts');
const roster = require('../lib/team/roster');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };
const throwsCode = async (fn, code) => { try { await fn(); return false; } catch (e) { return e.code === code || e.message === code; } };
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

function store(T) {
  let n = 0;
  return { T, from(table) {
    let op = 'select', payload = null, one = false, sel = false, lim = null; const f = [];
    const api = {
      select() { sel = true; return api; }, eq(c, v) { f.push((r) => r[c] === v); return api; }, neq(c, v) { f.push((r) => r[c] !== v); return api; },
      in(c, v) { f.push((r) => v.includes(r[c])); return api; }, gte(c, v) { f.push((r) => String(r[c]) >= String(v)); return api; },
      or(expr) { const parts = expr.split(',').map((x) => x.split('.eq.')); f.push((r) => parts.some(([c, v]) => String(r[c]) === v)); return api; },
      order() { return api; }, limit(x) { lim = x; return api; }, single() { one = true; return api; }, maybeSingle() { one = true; return api; },
      insert(rows) { op = 'insert'; payload = Array.isArray(rows) ? rows : [rows]; return api; }, update(p) { op = 'update'; payload = p; return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      const t = T[table] || (T[table] = []);
      if (op === 'insert') { const rows = payload.map((r) => ({ id: `${table}-${++n}`, created_at: new Date().toISOString(), ...r })); t.push(...rows); return { data: one ? rows[0] : rows, error: null }; }
      let rows = t.filter((r) => f.every((g) => g(r)));
      if (op === 'update') { rows.forEach((r) => Object.assign(r, payload)); return { data: one ? rows[0] : rows, error: null }; }
      if (lim) rows = rows.slice(0, lim);
      return { data: one ? (rows[0] || null) : rows.map((r) => ({ ...r })), error: null };
    }
    return api;
  } };
}

const AGENTS = ['amanda', 'kat', 'annie', 'maggie', 'miranda'];
const MAILBOX = { amanda: 'amandaalbright@bedrocktx.com', kat: 'kat@bedrocktx.com', annie: 'annie@bedrocktx.com', maggie: 'maggie@bedrocktx.com', miranda: 'miranda@bedrocktx.com' };
const now = new Date().toISOString();
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const CONV = 'conv-melody';
const msg = (o) => ({ direction: 'inbound', triage_status: 'new', received_at: ago(48), graph_id: 'g-' + o.id, conversation_id: 'c-' + o.id, subject: 'Hello', body_preview: 'hi', recipients: [o.mailbox], ...o });
const T = {
  email_messages: [
    msg({ id: 'melody', mailbox: 'kat@bedrocktx.com', persona: 'kat', sender_email: 'MHess@newfirst.com', sender_name: 'Hess,Melody', subject: 'RE: Positive Pay', conversation_id: CONV, body_full: 'I am verifying that Bedrock is now using the template to upload the issued check report into Positive Pay.' }),
    { id: 'katreply', direction: 'outbound', mailbox: 'kat@bedrocktx.com', persona: 'kat', sender_email: 'kat@bedrocktx.com', recipients: ['MHess@newfirst.com', 'tessa@bedrocktx.com'], subject: 'RE: Positive Pay', conversation_id: CONV, received_at: ago(2), reviewed_by: 'egojara@bedrocktx.com' },
    msg({ id: 'bank-info', mailbox: 'info@bedrocktx.com', persona: 'kat', sender_email: 'treasury@newfirst.com', subject: 'Statement question' }),
    msg({ id: 'acc', mailbox: 'annie@bedrocktx.com', persona: 'annie', sender_email: 'owner@gmail.com', subject: 'Fence application' }),
    msg({ id: 'drv', mailbox: 'info@bedrocktx.com', persona: 'miranda', sender_email: 'owner2@gmail.com', subject: 'Violation letter' }),
    msg({ id: 'bd', mailbox: 'maggie@bedrocktx.com', persona: 'maggie', sender_email: 'MHess@newfirst.com', subject: 'Referral: Oak Hollow HOA' }),
    msg({ id: 'mgmt', mailbox: 'amandaalbright@bedrocktx.com', persona: 'amanda', sender_email: 'president@hoa.test', subject: 'Board question' }),
    msg({ id: 'tessa-private', mailbox: 'kat@bedrocktx.com', persona: 'tessa', sender_email: 'x@y.test', subject: 'Private' }),
  ],
  outbound_email_drafts: [],
};
const ga = { fetchMessageText: async () => '', fetchMessageRecipients: async (mbx) => (mbx === 'kat@bedrocktx.com' ? { to: ['kat@bedrocktx.com'], cc: ['tessa@bedrocktx.com'] } : { to: [mbx], cc: [] }) };

(async () => {
  const db = store(T);
  console.log('configuration: the roster decides who has a desk');
  check('exactly the five agents have an email desk', roster.deskAgents().map((m) => m.persona).sort().join() === [...AGENTS].sort().join());
  for (const p of AGENTS) { const d = D.deskFor(p); check(`${p}: own Microsoft 365 mailbox ${MAILBOX[p]}, human approval`, d.mailbox === MAILBOX[p] && d.approval === 'human'); }
  check('guards per agent: Kat banking, Annie decision authority, Miranda compliance, Amanda auto-reply; Maggie business development (approval only)', D.deskFor('kat').guards.includes('bank_correspondence') && D.deskFor('annie').guards.includes('acc_decision_authority') && D.deskFor('miranda').guards.includes('compliance_209') && D.deskFor('amanda').guards.includes('amanda_auto_reply') && D.deskFor('maggie').guards.length === 0);
  check('Amanda keeps her reply kind; everyone else uses the shared one', D.deskFor('amanda').reply_kind === 'amanda_reply' && ['kat', 'annie', 'maggie', 'miranda'].every((p) => D.deskFor(p).reply_kind === 'agent_reply'));
  check('no desk for anyone the roster does not configure', await throwsCode(() => D.deskFor('claire'), 'not_a_desk_agent') && await throwsCode(() => D.deskFor('tessa'), 'not_a_desk_agent'));
  check('Amanda\'s mailbox aliases include amanda@', D.deskFor('amanda').aliases.includes('amanda@bedrocktx.com'));

  console.log('inboxes: each agent sees their own correspondence');
  const want = { amanda: ['mgmt'], kat: ['melody', 'bank-info'], annie: ['acc'], maggie: ['bd'], miranda: ['drv'] };
  for (const p of AGENTS) {
    const r = await D.loadInbox(db, p);
    const ids = r.items.map((i) => i.id).sort();
    check(`${p}: ${want[p].join(', ')}`, ids.join() === [...want[p]].sort().join(), ids.join());
  }
  const kat = await D.loadInbox(db, 'kat');
  check('Melody\'s 10/19 email is on Kat\'s desk, and shows as replied (the 3:49 pm reply from kat@ in its thread)', kat.items.find((i) => i.id === 'melody').reply_status === 'replied');
  check('mail routed to Kat from info@ is marked as arriving via the shared inbox', kat.items.find((i) => i.id === 'bank-info').delivered_to_agent === false);
  check('the same contact can correspond with two agents: Melody on Kat\'s desk (banking) and Maggie\'s (a referral)', (await D.loadInbox(db, 'maggie')).items.some((i) => i.from_email === 'MHess@newfirst.com'));
  check('Tessa\'s private mail never appears, even in kat@', !kat.items.some((i) => i.id === 'tessa-private'));

  console.log('threads: Reply all, sending mailbox, in-thread, no duplicate reply');
  const t = await D.loadThread(db, 'kat', 'melody', { graphAttachments: ga });
  check('Reply all to Melody keeps Tessa in CC and never includes Kat', t.reply.to === 'MHess@newfirst.com' && t.reply.reply_all_cc.join() === 'tessa@bedrocktx.com' && t.reply.default_mode === 'all');
  check('sends from kat@ in the original thread (the message lives in kat@)', t.reply.sends_from === 'kat@bedrocktx.com' && t.reply.in_thread === true);
  check('the thread shows Kat\'s 3:49 pm reply and who approved it', t.already_replied && t.already_replied.approved_by === 'egojara@bedrocktx.com' && t.thread.some((x) => x.direction === 'outbound'));
  const tb = await D.loadThread(db, 'kat', 'bank-info', { graphAttachments: ga });
  check('mail that came to info@ replies as a new message from kat@, said plainly', tb.reply.in_thread === false && /new message from kat@bedrocktx.com/.test(tb.reply.threading));
  check('another agent\'s message is not on this desk', (await D.loadThread(db, 'maggie', 'melody', { graphAttachments: ga })).not_on_desk === true);
  check('no reply is prepared for a thread already answered from the agent\'s mailbox', await throwsCode(() => D.stageReply(db, 'kat', { thread: t, body: 'Hi again', createdBy: 'egojara@bedrocktx.com' }), 'already_replied'));

  console.log('outboxes stay separate; approval stays with a person');
  const tf = await D.loadThread(db, 'annie', 'acc', { graphAttachments: ga });
  check('a staged reply needs a signed-in person', await throwsCode(() => D.stageReply(db, 'annie', { thread: tf, body: 'Thanks', createdBy: null }), 'signed_in_person_required'));
  const rowA = await D.stageReply(db, 'annie', { thread: tf, body: 'Thank you for the fence application.', createdBy: 'egojara@bedrocktx.com' });
  check('Annie\'s reply is staged as hers, from annie@, never sent', rowA.persona === 'annie' && rowA.from_mailbox === 'annie@bedrocktx.com' && rowA.status === 'draft' && rowA.policy.sends_from === 'annie@bedrocktx.com');
  const rowA2 = await D.stageReply(db, 'annie', { thread: tf, body: 'Thank you, revised.', createdBy: 'egojara@bedrocktx.com' });
  check('staging again updates the same open reply (one per message)', rowA2.replaced && T.outbound_email_drafts.filter((d) => d.source_email_ref === 'acc').length === 1);
  T.email_messages.find((m) => m.id === 'acc').persona = 'annie';
  T.outbound_email_drafts.push({ id: 'x-maggie', persona: 'maggie', draft_kind: 'agent_reply', status: 'draft', source_email_ref: 'bd2' });
  T.email_messages.push(msg({ id: 'bd2', mailbox: 'info@bedrocktx.com', persona: 'kat', sender_email: 'a@b.test' }));
  const tbd = await D.loadThread(db, 'kat', 'bd2', { graphAttachments: ga });
  check('a reply waiting on another agent\'s desk is never taken over', await throwsCode(() => D.stageReply(db, 'kat', { thread: tbd, body: 'x', createdBy: 'egojara@bedrocktx.com' }), 'reply_staged_by_another_agent'));
  const oa = await D.loadOutbox(db, 'annie'); const ok = await D.loadOutbox(db, 'kat');
  check('each outbox lists only its own agent\'s drafts, with the sending mailbox and the reviewed-version fingerprint', oa.drafts.length === 1 && oa.drafts[0].sends_from === 'annie@bedrocktx.com' && /^[0-9a-f]{64}$/.test(oa.drafts[0].package_sha256) && !ok.drafts.some((d) => d.persona !== 'kat'));
  const tm = await D.loadThread(db, 'amanda', 'mgmt', { graphAttachments: ga });
  const rowM = await D.stageReply(db, 'amanda', { thread: tm, body: 'Thank you.', createdBy: 'egojara@bedrocktx.com' });
  check('Amanda\'s desk still stages amanda_reply drafts from amandaalbright@ (her existing send rules apply)', rowM.persona === 'amanda' && T.outbound_email_drafts.find((d) => d.id === rowM.id).draft_kind === 'amanda_reply' && rowM.from_mailbox === 'amandaalbright@bedrocktx.com');
  for (const p of ['maggie', 'miranda']) {
    const id = p === 'maggie' ? 'bd' : 'drv'; const tt = await D.loadThread(db, p, id, { graphAttachments: ga });
    const r = await D.stageReply(db, p, { thread: tt, body: 'Thank you.', createdBy: 'egojara@bedrocktx.com' });
    check(`${p}: reply staged as ${p}, from ${MAILBOX[p]}, waiting for approval`, r.persona === p && r.from_mailbox === MAILBOX[p] && r.policy.approval === 'human');
  }

  console.log('reassignment');
  const ra = await D.reassign(db, 'kat', 'bank-info', { to: 'maggie', by: 'egojara@bedrocktx.com' });
  const moved = T.email_messages.find((m) => m.id === 'bank-info');
  check('explicit reassignment moves it to the other desk and records who did it', ra.to === 'maggie' && moved.persona === 'maggie' && moved.extracted.reassignments[0].by === 'egojara@bedrocktx.com');
  check('reassignment needs a signed-in person and a real desk', await throwsCode(() => D.reassign(db, 'maggie', 'bank-info', { to: 'kat', by: null }), 'signed_in_person_required') && await throwsCode(() => D.reassign(db, 'maggie', 'bank-info', { to: 'claire', by: 'x' }), 'not_a_desk_agent'));

  console.log('record checks: narrow, and honest about what was not checked');
  const st0 = { files_accepted: 0, exception_cutoff: '10:00', start_date: null };
  check('Kat\'s sent reply passes (no false claim, deadline kept separate)', !OF.positivePayClaims('We\'re currently finalizing our automated Positive Pay process and expect to begin submitting issued-check files shortly. I know the 10:00 a.m. deadline applies to reviewing and approving exceptions.', st0).length);
  const bad = OF.positivePayClaims('We are uploading the issued-check file through Treasury Management. We upload each file before the 10:00 a.m. deadline.', st0).map((i) => i.kind);
  check('a draft claiming uploads are happening, and 10:00 am as the upload deadline, is flagged', bad.includes('uploading_claim') && bad.includes('deadline_conflation'));
  check('once NewFirst has accepted files, saying so is not flagged', !OF.positivePayClaims('We are uploading the issued-check file each day.', { ...st0, files_accepted: 3 }).some((i) => i.kind === 'uploading_claim'));
  const b = OF.positivePayBasis(st0);
  check('the fact basis states what the records show and separates the two deadlines', /No issued-check file has been uploaded/.test(b.observed[0].text) && /not a file-upload deadline/.test(b.observed[2].text) && /deadline, if any, for uploading/.test(b.unknown[0].text));
  const none = await OF.factsFor(db, D.deskFor('annie'), { subject: 'Fence', body: 'question' });
  check('a topic no record covers says plainly that nothing was verified', !none.covered.length && /not verified automatically/.test(none.note) && /not verified automatically/.test(OF.checkDraft('anything', none).note));
  const notTopic = await OF.factsFor(db, D.deskFor('kat'), { subject: 'Escrow', body: 'refund question' });
  check('Kat\'s Positive Pay check only runs on Positive Pay mail', !notTopic.covered.length);

  console.log('routing: responsibilities');
  const P = require('../lib/email/persona');
  const route = (o) => P.personaForMessage({ direction: 'inbound', subject: 'Question', body_preview: 'hi', ...o });
  check('bank mail to a shared inbox goes to Kat', route({ mailbox: 'info@bedrocktx.com', sender_email: 'MHess@newfirst.com' }) === 'kat');
  check('mail to an agent\'s own mailbox stays theirs (Melody writing Maggie stays Maggie\'s)', route({ mailbox: 'maggie@bedrocktx.com', sender_email: 'mhess@newfirst.com' }) === 'maggie');
  check('ACC, violations and management keep their existing routes', route({ mailbox: 'acc@bedrocktx.com', sender_email: 'a@b.test' }) === 'annie' && route({ mailbox: 'violations@bedrocktx.com', sender_email: 'a@b.test' }) === 'miranda' && route({ mailbox: 'amandaalbright@bedrocktx.com', sender_email: 'a@b.test' }) === 'amanda');

  console.log('approval records and wiring');
  const drafts = src('api/email_drafts.js'); const tri = src('api/email_triage.js'); const gs = src('lib/email/graph_send.js'); const today = src('public/app/today.html'); const rg = src('lib/email/reply_guard.js');
  check('the send route refuses a draft opened on another agent\'s desk', /desk_persona/.test(drafts) && /error: 'wrong_desk'/.test(drafts));
  check('it sends shared-desk replies in the original thread, with Amanda\'s auto-reply guard for Amanda only', /\['amanda_reply', 'agent_reply'\]\.includes\(d\.draft_kind\)/.test(drafts) && /d\.persona === 'amanda' && src\.internet_message_id/.test(drafts));
  check('every approval records who, when, agent, mailbox and the Microsoft 365 message id', /approval: \{ approved_by: approvedBy, approved_by_name: approver\.full_name \|\| null, approver_user_id: approver\.id \|\| null, approved_at: sentAt, agent: d\.persona, mailbox: from, message_id:/.test(drafts) && /sent_internet_message_id: \(sent && sent\.internetMessageId\)/.test(drafts));
  const sendRoute = tri.slice(tri.indexOf("router.post('/:id/send'"), tri.indexOf("\nrouter.", tri.indexOf("router.post('/:id/send'") + 10));
  check('Communications send blocks an unidentified approver and never records "staff"', /error: 'approver_unidentified'/.test(sendRoute) && !/\|\| 'staff'/.test(sendRoute) && /internet_message_id: sentMessageId/.test(sendRoute) && /extracted: \{ approval: \{ approved_by: reviewed_by/.test(sendRoute));
  const fwd = tri.slice(tri.indexOf("router.post('/:id/forward-internal'"), tri.indexOf("router.post('/:id/forward-note'"));
  check('internal forwards and Compose also name the signed-in sender', /approver_unidentified/.test(fwd) && !/\|\| 'staff'/.test(fwd) && /path: 'compose'/.test(tri));
  check('both Graph send paths return the message id', /internetMessageId: \(vd && vd\.internetMessageId\) \|\| null/.test(gs) && /return \{ sent: true, from, to, internetMessageId \}/.test(gs));
  check('the one-reply-per-email guard covers shared-desk replies across both send paths', /const REPLY_KINDS = \['amanda_reply', 'agent_reply', 'reply'\]/.test(rg));
  check('Today: one desk with an agent selector; shared endpoints; the send names the mailbox and the desk', /id="th-em-desks"/.test(today) && /deskApi\('\/inbox'\)/.test(today) && /desk_persona: DESK/.test(today) && /Sends from <b>/.test(today) && !/approved_by: user\.email \|\| 'staff'/.test(today));
  check('Amanda\'s original desk routes are untouched', /router\.get\('\/inbox'/.test(src('api/amanda_email.js')) && /REPLY_KIND = 'amanda_reply'/.test(src('lib/amanda/email_inbox.js')));
  check('Communications drafting runs the same record check', /require\('\.\.\/lib\/agents\/operational_facts'\)\.checkDraft\(draft\.body, _facts\)/.test(tri));

  console.log(`\nagent_desk: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
