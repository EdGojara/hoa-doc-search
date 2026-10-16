#!/usr/bin/env node
// ============================================================================
// scripts/amanda_rfp_dry_run.js  (Ed 2026-10-16)
// ----------------------------------------------------------------------------
// Read-only dry run of Amanda's RFP / Bid Workflow comparison. Writes NOTHING.
//
//   node scripts/amanda_rfp_dry_run.js                 fixture replay (Canyon Gate cameras)
//   node scripts/amanda_rfp_dry_run.js --json          same, full record as JSON
//   node scripts/amanda_rfp_dry_run.js --live --community=<uuid> --mailbox=<addr> --graph-id=<id>
//        [--preview-cache=<dir>]  save in-memory line-item extractions locally (by document hash);
//                                 a second run with the same dir reuses them without a model call
//        [--reprocess --requested-by=<name> --reason="..."]  extract fresh as a new version and print the diff
//        live: reads the community's workflow records, books and the message's
//        attachments; the Supabase client is wrapped in a guard that THROWS on any
//        insert / update / upsert / delete / rpc / storage upload.
//
// Fixture replay = the real sequence: the 9/17/2026 proposals are already on the
// workflow (vendor_proposals with saved extractions), then Hugh's 10/15/2026
// "Camera Proposals" email arrives with the same iTech file, the same packet, and
// the standalone Envera quote. Nothing is re-uploaded or re-extracted that is
// already on file; the standalone quote is the only new document.
// ============================================================================
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const crypto = require('crypto');
const path = require('path');
const W = require('../lib/vendors/rfp_workflow');
const D = require('../lib/amanda/decision_ready');

const FIXTURE = path.join(__dirname, '..', 'tests', 'fixtures', 'rfp-comparison', 'canyon-gate-cameras-2026-10.json');

/** Read-only PostgREST stand-in seeded per table; records every write attempt. */
function fakeDb(seed) {
  const writes = []; let n = 0;
  const db = {
    writes,
    from(table) {
      let inserted = false; const filters = [];
      // Simple filters on top-level fields the seeded row actually has (others are ignored).
      const rows = () => (seed[table] || []).filter((r) => filters.every(([op, k, v]) => !(k in r) || (op === 'eq' ? r[k] === v : op === 'neq' ? r[k] !== v : op === 'in' ? v.includes(r[k]) : true)));
      const q = {
        select() { return q; }, eq(k, v) { filters.push(['eq', k, v]); return q; }, neq(k, v) { filters.push(['neq', k, v]); return q; }, in(k, v) { filters.push(['in', k, v]); return q; }, gte() { return q; }, lte() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; }, ilike() { return q; },
        maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
        single() { return Promise.resolve({ data: inserted ? { id: `new-${table}-${++n}` } : rows()[0] || null, error: null }); },
        insert(row) { inserted = true; writes.push({ table, op: 'insert', row }); return q; },
        update(row) { writes.push({ table, op: 'update', row }); return q; },
        then(res, rej) { return Promise.resolve({ data: rows(), error: null }).then(res, rej); },
      };
      return q;
    },
    storage: { from() { return { upload(p) { writes.push({ table: 'storage', op: 'upload', path: p }); return Promise.resolve({ error: null }); } }; } },
  };
  return db;
}

/** Local preview cache of line-item versions, one JSON file per document hash. Never the database. */
function fileCache(dir) {
  const fs = require('fs'); const path = require('path');
  fs.mkdirSync(dir, { recursive: true });
  const f = (sha) => path.join(dir, `${sha}.json`);
  return {
    get(sha) { try { return JSON.parse(fs.readFileSync(f(sha), 'utf8')); } catch (_) { return null; } },
    put(sha, ed) { fs.writeFileSync(f(sha), JSON.stringify(ed, null, 2)); },
  };
}

/** Wrap a real client so any write throws. */
function readOnly(client) {
  const deny = (what) => () => { throw new Error(`dry run is read-only: ${what} refused`); };
  return new Proxy(client, { get(t, k) {
    if (k === 'rpc') return deny('rpc');
    if (k === 'storage') return { from: (bucket) => ({ upload: deny('storage upload'), remove: deny('storage remove'), download: (path) => t.storage.from(bucket).download(path) }) };
    if (k === 'from') return (table) => { const b = t.from(table); for (const m of ['insert', 'update', 'upsert', 'delete']) b[m] = deny(`${m} on ${table}`); return b; };
    return t[k];
  } });
}

const bufFor = (name) => Buffer.from(`fixture bytes for ${name}`);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** A stored, owner-approved line-item version (fixture stand-in for Ed's approval). */
function approvedFixture(items, sha) {
  const V = require('../lib/vendors/line_item_versions');
  return V.approveVersion(V.addVersion({}, { items, document_sha256: sha, reason: 'initial extraction', requested_by: 'fixture', at: '2026-09-17T21:00:00Z' }), 1, { approved_by: 'Ed (fixture)', at: '2026-09-17T22:00:00Z' });
}

/** The fixture replay through the real prepareComparison(). */
async function fixtureRun({ mode = 'dry_run', previewCache = null, reprocess = null, transformExtract = null } = {}) {
  const fx = require(FIXTURE);
  const byKey = Object.fromEntries(fx.proposals.map((p) => [p.key, p]));
  const itechFile = 'iTech_Video Proposal_Sept 2026.pdf'; const packetFile = 'CGHOASecProps2026.pdf'; const enveraFile = 'Canyon Gate at Cinco Ranch Qoute 19538.pdf';
  const itechSha = sha(bufFor(itechFile)); const packetSha = sha(bufFor(packetFile));
  // Already on the workflow from 9/17: the iTech proposal and the July packet's three proposals.
  const packetItems = ['itech-2024', 'envera-q19538-2-packet', 'netwatch-2026'].map((k) => byKey[k]);
  const seed = { ...fx.db_seed, ...(fx.context_seed || {}),
    vendor_proposals: [
      { id: 'vp-itech-2026', service_category: 'security', file_hash: itechSha, extracted_data: approvedFixture([byKey['itech-2026-a']], itechSha), created_at: '2026-09-17T21:00:00Z' },
      { id: 'vp-packet', service_category: 'security', file_hash: packetSha, extracted_data: approvedFixture(packetItems, packetSha), created_at: '2026-09-17T21:00:00Z' },
    ],
    bid_requests: [], library_documents: [] };
  const db = fakeDb(seed);
  const attachments = [itechFile, packetFile, enveraFile].map((f) => ({ filename: f, buffer: bufFor(f), isPdf: true }));
  const extracted = [];
  const extract0 = async (buf, meta) => { extracted.push(meta.filename); return { items: meta.filename === enveraFile ? [{ ...byKey['envera-q19538-2-standalone'], document: { ...byKey['envera-q19538-2-standalone'].document, sha256: sha(buf) } }] : [], diagnostic: { invalid: [] } }; };
  const extract = async (buf, meta) => { const r0 = await extract0(buf, meta); return transformExtract ? transformExtract(r0, meta) : r0; };
  const email = { ...fx.board_email, id: 'em-1016', sender_email: fx.board_email.from };
  const facts = await D.boardDecisionFactsDetailed(db, fx.community.id, `${email.subject}\n${email.body}`, { today: fx.today, mode: 'transition' });
  const r = await W.prepareComparison({ supabase: db, communityId: fx.community.id, communityName: fx.community.name, email, attachments, today: fx.today, mode, factsDetailed: facts, extract, mgmtId: 'mgmt', greetingName: 'Hugh', previewCache, reprocess });
  return { result: r, facts, extracted, writes: db.writes, fixture: fx };
}

function report({ result: r, facts, extracted, writes }) {
  const C = require('../lib/vendors/proposal_comparison');
  const L = [];
  L.push(`MODE: ${r.mode} (writes attempted: ${writes.length})`);
  L.push(`DETECTED: ${r.detection.reasons.join('; ')}`);
  L.push(`REQUIREMENTS (Board's words): ${r.record.requirements.notes.join('; ')}`);
  L.push(`DOCUMENTS: ${r.record.documents.map((d) => `${d.filename} [${d.origin}]`).join(' | ')}; extracted fresh: ${extracted.join(', ') || 'none (all already on file)'}`);
  L.push('LINE ITEMS SOURCE (per document):');
  for (const x of r.extraction_log || []) L.push(`  ${x.file} [${x.sha256.slice(0, 12)}]: ${x.source}${x.cached_as_version ? ` (cached as v${x.cached_as_version})` : ''}${x.version ? ` (would be v${x.version})` : ''}${(x.differs || []).length ? `; DIFFERS from the current version${x.compared ? ` (v${x.compared.version}, ${x.compared.status})` : ''}: ${x.differs.map((d) => `${d.field} ${d.approved} -> ${d.new}`).join(', ')}` : (x.extracted && (x.version || x.cached_as_version > 1) ? `; no difference from the current version${x.compared ? ` (v${x.compared.version}, ${x.compared.status})` : ''}` : '')}`);
  if ((r.record.notes || []).length) { L.push('NOTES:'); for (const n of r.record.notes) L.push(`  ${n}`); }
  L.push('LINE ITEMS SOURCE (per proposal):');
  for (const n of r.record.proposals.filter((x) => x.status !== 'duplicate')) { const qs = (r.record.quantities.find((q) => q.key === n.key) || {}).status; L.push(`  ${n.vendor_name} ${n.document_date}: ${{ stored: 'approved, stored on the record', pending_approval: 'stored, pending approval (provisional)', preview: 'preview cache (provisional, not approved)', not_yet_stored: 'fresh extraction, not stored (provisional)', none: 'no line items' }[qs] || qs}`); }
  L.push('\nCLASSIFICATION');
  for (const n of r.record.proposals) L.push(`  ${n.status.padEnd(10)} ${n.vendor_name} ${n.document_date || ''} (${(n.source || {}).filename}${(n.source || {}).pages ? ` pp.${n.source.pages}` : ''}) : ${n.status_reason}`);
  L.push(`\nNORMALIZED COSTS (${r.record.horizon_months}-month horizon)`);
  for (const n of r.record.proposals.filter((x) => !['duplicate'].includes(x.status))) L.push(`  ${n.vendor_name} ${n.document_date}: upfront ${C.money(n.upfront_cents)} + tax ${C.money(n.upfront_tax_cents)} = ${C.money(n.upfront_total_cents)}; monthly counted ${C.money(n.recurring_counted_monthly_cents)}; min commitment ${C.money(n.minimum_commitment_cents)}; TCO (recommended configuration) ${C.money(n.tco_cents)}${n.addon_monthly_cents ? `; optional add-on ${C.money(n.addon_monthly_cents)}/month, not recommended (TCO with it ${C.money(n.tco_with_addons_cents)})` : ''}`);
  L.push(`\nRANKING: ${r.record.ranking.ranked.map((x) => `${x.rank}. ${x.vendor_name} ${C.money(x.tco_cents)}`).join('; ') || 'none viable'}`);
  for (const x of r.record.ranking.not_viable) L.push(x.statement ? `  not viable: ${x.vendor_name}: ${x.statement} [approved statement; computed (internal): ${x.reasons.join('; ')}]` : `  not viable: ${x.vendor_name}: ${x.reasons.join('; ')}`);
  L.push(`RECOMMENDATION: ${(r.record.recommendation || {}).vendor_name || 'none'}; funding ${JSON.stringify(r.record.ranking.funding && { source: r.record.ranking.funding.source, label: r.record.ranking.funding.label, basis: r.record.ranking.funding.basis })}`);
  L.push('\nCONFIDENCE LABELS');
  for (const f of facts.funds) { L.push(`  ${f.fund} ${C.money(f.balance_cents)}: ${f.label} (${f.reason})`); for (const a of f.accounts) L.push(`     ${a.account_number} ${a.account_name} ${C.money(a.balance_cents)}: ${a.label}`); }
  L.push(`  budget actuals: ${facts.budget && facts.budget.label}; payables: ${facts.payables && facts.payables.label}; mode ${facts.mode}`);
  const cc = r.record.review && r.record.review.conclusions;
  const rv = r.record.recommendation && r.record.review.by_proposal[r.record.recommendation.key];
  if (cc && rv) {
    L.push('\nCONCLUSIONS (kept separate)');
    L.push(`  Vendor recommendation: ${cc.vendor_recommendation.vendor} (${cc.vendor_recommendation.basis})`);
    L.push(`  Project recommendation: ${cc.project_recommendation.decision} (${cc.project_recommendation.basis})`);
    L.push(`  Preliminary funding recommendation: ${cc.funding_recommendation.source || 'none'} (${cc.funding_recommendation.basis}; ${cc.funding_recommendation.label || 'n/a'})`);
    L.push(`  Reserve-study status: ${cc.reserve_study_status.label}`);
    L.push(`  Contract readiness: ${cc.contract_readiness.label}`);
    L.push(`  Monitoring plan: ${cc.monitoring_plan.label}`);
    const sec = (title, list, f) => { L.push(`\n${title}`); for (const x of list) L.push(`  ${f(x)}`); };
    sec('STRENGTHS', rv.strengths, (x) => `[${x.lens}] ${x.text}  <${x.source}>`);
    sec('WEAKNESSES / RISKS', rv.weaknesses_risks, (x) => `[${x.lens}${x.severity === 'minor' ? ', minor' : ''}] ${x.text}  <${x.source}>`);
    sec('MISSING INFORMATION / DOCUMENTS (tracked, not requested yet)', rv.missing_documents, (x) => `${x.label}${x.note ? ` (${x.note})` : ''}  <${x.source}>`);
    sec('REQUIRED CONDITIONS BEFORE SIGNING', rv.required_conditions, (x) => `${x.text}  <${x.source}>`);
    sec('ITEMS FOR COUNSEL REVIEW (flags, no legal conclusions)', rv.counsel_review, (x) => `${x.label}: ${x.status}`);
    sec('COMMUNITY CONTEXT USED (from trustEd records)', rv.community_context_used, (x) => `<${x.source}> ${x.text}`);
    L.push(`  (gathered ${(r.record.community_context || []).length} relevant finding(s); irrelevant history omitted)`);
  }
  L.push('\nOPEN ITEMS (routine diligence, queued, NOT sent)');
  for (const i of r.record.open_items) L.push(`  [${i.material ? 'material' : 'minor'}] ${i.vendor}: ${i.topic}: ${i.request}`);
  L.push('\nWORKFLOW WRITES THAT WOULD HAPPEN (none performed)');
  L.push(`  bid_requests ${r.plan.bid_request.op}: ${JSON.stringify(r.plan.bid_request.row || r.plan.bid_request.patch)}`);
  for (const p of r.plan.proposals) L.push(`  vendor_proposals ${p.op} ${p.key}${p.id ? ` (${p.id})` : ''}`);
  L.push(`  vendor_comparisons insert: ${r.plan.comparison.row.recommendation_summary}`);
  L.push(`  rfp_decision_log: ${r.plan.audit.length} audit rows`);
  for (const a of r.record.audit) L.push(`     ${a.action}: ${a.note}`);
  L.push('\nBOARD EXECUTIVE SUMMARY');
  L.push(r.summary);
  const chk = D.checkDecisionReady(r.summary, { confidence: { mode: facts.mode, cash_label: facts.cash_label } });
  L.push(`\ncheckDecisionReady: ${chk.ok ? 'ok' : JSON.stringify(chk.issues)}`);
  return L.join('\n');
}

async function liveRun(args) {
  require('dotenv').config();
  const { createClient } = require('@supabase/supabase-js');
  const db = readOnly(createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY));
  const cid = args.community;
  const { data: c, error } = await db.from('communities').select('id, name').eq('id', cid).maybeSingle();
  if (error || !c) throw new Error(`community ${cid} not found: ${error ? error.message : 'no row'}`);
  const gm = require('../lib/email/graph_attachments');
  const text = args.mailbox && args['graph-id'] ? await gm.fetchMessageText(args.mailbox, args['graph-id']).catch(() => '') : '';
  // The stored copy of the message being answered: its ids exclude it (and its thread copies) from
  // the community context, so the analysis never cites the message it is answering.
  let stored = null;
  if (args['graph-id']) {
    const { data: m, error: me } = await db.from('email_messages').select('id, graph_id, internet_message_id, conversation_id, subject, body_full, body_preview, received_at, sender_email').eq('graph_id', args['graph-id']).limit(1);
    if (me) console.warn('stored message lookup failed:', me.message); else stored = (m || [])[0] || null;
  }
  const bodyText = typeof text === 'string' ? text : (text && text.body) || '';
  const email = { ...(stored || {}), graph_id: args['graph-id'] || (stored && stored.graph_id) || null, subject: args.subject || (stored && stored.subject) || 'proposals', body: bodyText || (stored && (stored.body_full || stored.body_preview)) || '' };
  const facts = await D.boardDecisionFactsDetailed(db, cid, email.body);
  if (args.reprocess && (!args['requested-by'] || !args.reason)) throw new Error('--reprocess needs --requested-by=<name> and --reason="..."');
  const reprocess = args.reprocess ? { requested_by: args['requested-by'], reason: args.reason } : null;
  const previewCache = args['preview-cache'] ? fileCache(args['preview-cache']) : null;
  const r = await W.prepareComparison({ supabase: db, communityId: cid, communityName: c.name, email, mailbox: args.mailbox, graphId: args['graph-id'], mode: 'dry_run', factsDetailed: facts, reprocess, previewCache });
  if (!r.is_matter) return `Not a comparison matter: ${JSON.stringify(r.detection)}`;
  return report({ result: r, facts, extracted: [], writes: [] });
}

if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] == null ? true : m[2]] : [a, true]; }));
  (async () => {
    if (args.live) { console.log(await liveRun(args)); return; }
    const out = await fixtureRun();
    if (args.json) console.log(JSON.stringify(out.result.record, null, 2));
    else console.log(report(out));
  })().catch((e) => { console.error('dry run failed:', e.message); process.exit(1); });
}

module.exports = { fixtureRun, report, fakeDb, readOnly, fileCache };
