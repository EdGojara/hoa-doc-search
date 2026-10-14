// Kat's bank correspondence (lib/banking/bank_correspondence) and the shared fact basis
// (lib/agents/fact_basis): a Positive Pay notice routes to Kat's processing, but a person can
// always have Kat write to the bank. Facts from our records first; only the unknowns are asked;
// a verified contact; a fresh message; a person approves before anything sends. (Ed 2026-10-14)
const BC = require('../lib/banking/bank_correspondence');
const FB = require('../lib/agents/fact_basis');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };
const GW = 'accounting@graywoodpropertiesllc.com';
const notice = (at, extra = []) => ({ direction: 'inbound', sender_email: 'treasurymanagement@newfirst.com', sender_name: 'treasurymanagement@newfirst.com', subject: 'Positive Pay Items Ready For Review', received_at: at, recipients: ['cdeleon@bedrocktx.com', 'egojara@bedrocktx.com', 'treasurymanagement@newfirst.com', 'kat@bedrocktx.com', ...extra] });
const db = {
  email_messages: [
    { id: 'm1', direction: 'inbound', sender_email: 'MHess@newfirst.com', sender_name: 'Hess,Melody', subject: 'RE: Positive Pay', received_at: '2026-09-08T16:40:00Z', recipients: ['kat@bedrocktx.com'] },
    { id: 'o1', direction: 'outbound', sender_email: 'kat@bedrocktx.com', subject: 'RE: Positive Pay', received_at: '2026-09-09T22:42:00Z', recipients: ['MHess@newfirst.com'] },
    { id: 'm2', direction: 'inbound', sender_email: 'mmatura@newfirst.com', sender_name: 'Madilyn Matura', subject: 'RE: Reminder', received_at: '2026-10-13T15:43:00Z', recipients: ['kat@bedrocktx.com'] },
    { id: 'n0', ...notice('2026-10-09T11:56:00Z') }, { id: 'n1', ...notice('2026-10-13T11:56:00Z', [GW]) }, { id: 'n2', ...notice('2026-10-14T11:56:00Z', [GW]) },
  ],
  vendors: [], contacts: [], community_contacts: [], banks: [],
};
const esc = (p) => String(p).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*');
const sb = { from(t) { const st = { f: [], ord: null }; const q = { select() { return q; }, eq(c, v) { st.f.push((r) => r[c] === v); return q; }, in(c, vs) { st.f.push((r) => vs.includes(r[c])); return q; }, ilike(c, p) { const re = new RegExp('^' + esc(p) + '$', 'i'); st.f.push((r) => re.test(r[c] || '')); return q; }, or() { return q; }, order(c) { if (!st.ord) st.ord = c; return q; }, range(a, b) { st.range = [a, b]; return q; }, limit() { return q; },
  then(res) { let d = (db[t] || []).filter((r) => st.f.every((fn) => fn(r))); if (st.ord) d = d.slice().sort((x, y) => String(x[st.ord]).localeCompare(String(y[st.ord]))); if (st.range) d = d.slice(st.range[0], st.range[1] + 1); return Promise.resolve({ data: d, error: null }).then(res); } }; return q; } };
const review = { recipients: { bank_domain: 'newfirst.com', unexpected: [GW], newly_added: [] }, items: [{ verdict: 'matched' }, { verdict: 'matched' }, { verdict: 'matched' }] };

(async () => {
  console.log('verified contact');
  const c = await BC.verifiedBankContact(sb, { bankDomain: 'newfirst.com', before: '2026-10-13T11:56:00Z', exclude: [GW, 'treasurymanagement@newfirst.com'] });
  check('Melody Hess: two-way correspondence before the anomaly; name read from "Hess,Melody"', c && c.email === 'mhess@newfirst.com' && c.name === 'Melody Hess', JSON.stringify(c));
  check('never the automated notice address or someone we only heard from (never written to)', c && c.email !== 'treasurymanagement@newfirst.com' && c.email !== 'mmatura@newfirst.com');
  const cfg = await BC.verifiedBankContact(sb, { bankDomain: 'newfirst.com', settings: { correspondence_contact: 'treasury.officer@newfirst.com', correspondence_contact_name: 'Officer' } });
  check('a contact configured on the bank in trustEd wins', cfg.email === 'treasury.officer@newfirst.com' && /on file/.test(cfg.basis));
  check('no verified contact: none is invented', (await BC.verifiedBankContact(sb, { bankDomain: 'otherbank.com' })) === null);

  console.log('facts first, unknowns asked');
  const h = await BC.recipientHistory(sb, { bankDomain: 'newfirst.com', address: GW });
  check('history: first seen 10/13, last notice without it 10/9', String(h.first_seen).startsWith('2026-10-13') && String(h.last_without).startsWith('2026-10-09'), JSON.stringify(h));
  const rm = await BC.recordMatches(sb, GW);
  check('record lookups ran (vendors, contacts, directory, mail) and found nothing', rm.checked.length === 4 && !rm.found.length, JSON.stringify(rm));
  const broken = { from(t) { const q = { select() { return q; }, ilike() { return q; }, or() { return q; }, limit() { return q; }, then(res) { return Promise.resolve(t === 'vendors' ? { data: null, error: { message: 'x' } } : { data: [], error: null }).then(res); } }; return q; } };
  const rm2 = await BC.recordMatches(broken, GW);
  check('a failed lookup is reported as NOT CHECKED, never as "no match"', rm2.unchecked.includes('vendors') && !rm2.checked.includes('vendors'));
  const d = await BC.draftForNotice(sb, { email: { ...notice('2026-10-14T11:56:00Z', [GW]), id: 'n2' }, review });
  check('to the verified contact, labelled with how it was verified', d.to === 'mhess@newfirst.com' && /two-way correspondence/.test(d.recipient_source), JSON.stringify([d.to, d.recipient_source]));
  check('the inquiry states the observed fact (first appeared October 13, 2026; not on earlier notices)', /first appeared on October 13, 2026\. It was not included in the earlier notifications we reviewed\./.test(d.body), d.body);
  check('the conclusion is worded as ours ("We do not recognize")', /We do not recognize this address as an authorized contact for our accounts\./.test(d.body));
  check('asks only the unknowns: exact time, who authorized, portal access / decision authority, other changes; remove and confirm', /1\. The exact date and time this address was added\./.test(d.body) && /2\. Who requested and authorized the addition\./.test(d.body) && /3\. Whether this address has any access to our banking portal or authority to make Positive Pay decisions\./.test(d.body) && /4\. Whether any other changes/.test(d.body) && /remove it immediately and confirm the removal/.test(d.body));
  check('no additional account data: no account endings, check numbers, amounts or DDA references', !/\b5961\b|\b5313\b|\b1037\b|\b1044\b|\$|DDA/.test(d.body));
  check('the reviewer sees the fact basis: observed (with sources), concluded, asked', d.fact_basis.observed.length >= 3 && d.fact_basis.conclusions.length === 1 && d.fact_basis.unknown.length === 4 && /Observed: .*first appears.*Concluded: .*Asked: /.test(d.review_hint));
  check('a draft for approval, never a send', d.draftable === true && d.careful === true && /only after you approve/.test(d.review_hint));

  console.log('user-directed correspondence about a routine notice');
  let got = null;
  const fake = async (args) => { got = args; return { subject: 'Re: Positive Pay', body: 'Good morning Melody, ...' }; };
  const r2 = await BC.draftForNotice(sb, { email: { ...notice('2026-10-09T11:56:00Z'), id: 'n0' }, review: { recipients: { bank_domain: 'newfirst.com', unexpected: [], newly_added: [] }, items: [{ verdict: 'matched' }] }, notes: 'Ask Melody whether our issued-check file from 10/5 was received.', draftReply: fake });
  check('Kat drafts it (not refused) as Kat, with the reviewer\'s notes, the fact basis and the bank rules', r2.draftable && got && got.persona === 'kat' && /issued-check file/.test(got.notes) && /never say that Ed/.test(got.notes) && got.factBasis && got.factBasis.observed.length);
  check('the notice\'s item table is withheld from the model writing it', got.email.body_full.includes('withheld') && !/DDA|\$/.test(got.email.body_full));
  const r3 = await BC.draftForNotice(sb, { email: { ...notice('2026-10-14T11:56:00Z', [GW]) }, review, notes: 'Shorter.', draftReply: fake });
  check('rewrite with notes on an unfamiliar-recipient notice also goes through the drafter', r3.draftable && got.notes.includes('Shorter.'));

  console.log('send guard');
  check('refuses the unfamiliar address', !BC.sendGuard({ to: GW, review, noticeSender: 'treasurymanagement@newfirst.com' }).ok);
  check('refuses the automated notice address (an unverified reply channel)', !BC.sendGuard({ to: 'treasurymanagement@newfirst.com', review, noticeSender: 'treasurymanagement@newfirst.com' }).ok);
  check('refuses the stranger on Cc too', !BC.sendGuard({ to: 'mhess@newfirst.com', cc: [GW], review, noticeSender: 'treasurymanagement@newfirst.com' }).ok);
  check('allows the verified contact', BC.sendGuard({ to: 'mhess@newfirst.com', review, noticeSender: 'treasurymanagement@newfirst.com' }).ok);

  console.log('shared fact basis (any agent)');
  const b = FB.basis({ observed: [{ fact: 'invoice 44817 paid 10/5', source: 'AP' }], conclusions: [{ fact: 'the vendor is chasing a paid bill' }], unknown: [{ fact: 'which invoice they mean' }] });
  const p = FB.promptBlock(b);
  check('prompt block: observed stated with sources, conclusions as our assessment, ask ONLY the unknowns', /OBSERVED[\s\S]*invoice 44817 paid 10\/5 \[source: AP\]/.test(p) && /OUR CONCLUSIONS[\s\S]*assessment/.test(p) && /ask ONLY these; never ask the recipient for anything listed above as observed/.test(p));
  const dr = require('fs').readFileSync(require.resolve('../lib/email/draft_reply'), 'utf8');
  check('the shared drafter accepts a fact basis for every persona', /persona, factBasis \}\)/.test(dr) && /fact_basis'\)\.promptBlock\(factBasis\)/.test(dr));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
