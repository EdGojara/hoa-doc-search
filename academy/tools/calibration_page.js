#!/usr/bin/env node
// academy/tools/calibration_page.js - build the blind grading page for the
// v2 calibration set. Embeds ONLY academy/calibration/blind_v2.json (no case
// ids, versions, answer keys, or judge output) plus the rubric and the
// critical-failure catalog. Grades are saved to the artifact's db collection
// "labels" (one document per item) and read back for scoring.
//   node academy/tools/calibration_page.js <out.html>
const fs = require('fs');
const path = require('path');
const { RUBRIC } = require('../lib/rubric');
const { CATALOG } = require('../lib/critical');

const blind = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'calibration', 'blind_v2.json'), 'utf8'));
// The judges' rubric and catalog were written for Amanda. On this page the
// agent varies (Claire, Paige, Phoebe), so every name becomes an {agent}
// token filled per item at render time, and pronouns become neutral
// ("their", "them"). UI text only: the judges' own rubric is unchanged.
const neutral = (s) => String(s)
  .replace(/\bAmanda\b/g, '{agent}')
  .replace(/\bstay inside her authority\b/g, 'stay inside their authority')
  .replace(/\btrust her\b/g, 'trust them')
  .replace(/\bsaid she would\b/g, 'said {agent} would')
  .replace(/\bsomething she cannot\b/g, 'something {agent} cannot')
  .replace(/\b(she|her)\b/g, (m) => (m === 'she' ? 'they' : 'their'));
const rubric = Object.fromEntries(Object.entries(RUBRIC).map(([d, r]) => [d, {
  q: neutral(r.question.replace(' (Judge this SEPARATELY from correctness.)', '')).replace('CORRECT?', 'correct?'),
  pass: neutral(r.pass), nr: neutral(r.needs_review), fail: neutral(r.fail) }]));
const catalog = Object.entries(CATALOG).map(([code, v]) => ({ code, dim: v.dimension, label: neutral(v.label) }));
const data = JSON.stringify({ items: blind, rubric, catalog }).replace(/</g, '\\u003c');

const html = `<title>Judge Calibration Set</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Sans+Condensed:wght@500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{
  --ground:#F2F4F1; --panel:#FFFFFF; --ink:#1D2724; --muted:#5B6863; --rule:#CCD5D0; --rule-soft:#E3E8E5;
  --accent:#1E6B62; --accent-ink:#FFFFFF; --exhibit:#F7F9F6;
  --pass:#2F7A4D; --pass-bg:#E4F1E8; --nr:#9A6A12; --nr-bg:#F6EDD9; --fail:#AD3A33; --fail-bg:#F6E1DE;
  --sans:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  --cond:"IBM Plex Sans Condensed","IBM Plex Sans",system-ui,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,"Cascadia Mono",Consolas,monospace;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  color-scheme:dark; --ground:#141A18; --panel:#1C2421; --ink:#E4ECE8; --muted:#9AA8A2; --rule:#34403B; --rule-soft:#29332F;
  --accent:#5FB3A8; --accent-ink:#0E1513; --exhibit:#18201D;
  --pass:#7CC99A; --pass-bg:#1E3527; --nr:#E0B45C; --nr-bg:#3A2F17; --fail:#EE8C84; --fail-bg:#3D2320;}}
:root[data-theme="dark"]{
  color-scheme:dark; --ground:#141A18; --panel:#1C2421; --ink:#E4ECE8; --muted:#9AA8A2; --rule:#34403B; --rule-soft:#29332F;
  --accent:#5FB3A8; --accent-ink:#0E1513; --exhibit:#18201D;
  --pass:#7CC99A; --pass-bg:#1E3527; --nr:#E0B45C; --nr-bg:#3A2F17; --fail:#EE8C84; --fail-bg:#3D2320;}
*{box-sizing:border-box}
body{background:var(--ground);color:var(--ink);font:15px/1.55 var(--sans);padding:0 16px}
.wrap{max-width:1180px;margin:0 auto;padding-block:20px 48px}
header.top{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px;border-bottom:2px solid var(--ink);padding-bottom:12px}
h1{font:600 26px/1.15 var(--cond);letter-spacing:.01em;margin:0;text-wrap:balance}
.sub{color:var(--muted);font-size:13.5px;max-width:62ch;margin:4px 0 0}
.progress{font:500 13px var(--mono);color:var(--muted);text-align:right}
.bar{width:220px;max-width:60vw;height:6px;background:var(--rule-soft);border-radius:3px;margin-top:6px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent);width:0}
.banner{margin:14px 0 0;padding:10px 12px;border:1px solid var(--nr);background:var(--nr-bg);color:var(--ink);border-radius:4px;font-size:14px}
.legend{display:flex;flex-wrap:wrap;gap:16px;margin:14px 0 0;font-size:13px;color:var(--muted)}
.legend b{font-family:var(--mono);font-weight:500}
.layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:24px;margin-top:18px}
nav.list{position:sticky;top:calc(env(safe-area-inset-top,0px) + 12px);align-self:start;max-height:calc(100vh - 40px);overflow:auto;border:1px solid var(--rule);background:var(--panel);border-radius:4px}
nav.list button{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--rule-soft);padding:8px 10px;color:var(--ink);font:13px var(--sans);cursor:pointer}
nav.list button:last-child{border-bottom:0}
nav.list button[aria-current="true"]{background:var(--exhibit);box-shadow:inset 3px 0 0 var(--accent)}
nav.list button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.ref{font:500 12px var(--mono);color:var(--muted)}
.who{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tick{font:500 12px var(--mono);min-width:5ch;text-align:right;color:var(--muted)}
.tick.done{color:var(--pass)}
.mobile-pick{display:none}
main{min-width:0}
.card{background:var(--panel);border:1px solid var(--rule);border-radius:4px;padding:18px 20px}
.meta{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px;color:var(--muted);margin-bottom:10px}
.meta b{color:var(--ink);font-weight:600}
h2{font:600 18px/1.3 var(--cond);margin:0 0 8px}
h3{font:600 12px var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:18px 0 6px}
.msg{white-space:pre-wrap;margin:0;font-size:15px}
ul.facts{margin:0;padding-left:18px;display:grid;gap:4px;font-size:14px}
ul.facts .src{color:var(--muted);font:12.5px var(--mono)}
.exhibit{margin-top:18px;border:1px solid var(--rule);border-left:4px solid var(--accent);background:var(--exhibit);border-radius:4px;padding:14px 16px}
.exhibit .label{font:500 12px var(--mono);color:var(--accent);letter-spacing:.04em;margin-bottom:6px}
.exhibit pre{white-space:pre-wrap;word-wrap:break-word;margin:0;font:15px/1.6 var(--sans);color:var(--ink)}
details.internal{margin-top:10px;font-size:13.5px}
details.internal summary{cursor:pointer;color:var(--muted)}
details.internal pre{white-space:pre-wrap;font:12.5px/1.5 var(--mono);background:var(--exhibit);border:1px solid var(--rule-soft);padding:10px;border-radius:4px;overflow-x:auto}
form.grade{margin-top:18px;border-top:2px solid var(--ink);padding-top:14px;display:grid;gap:14px}
.dim{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 16px;align-items:start;padding-bottom:12px;border-bottom:1px solid var(--rule-soft)}
.dim .q{font-weight:600}
.dim .hint{font-size:12.5px;color:var(--muted);grid-column:1/-1}
.seg{display:inline-flex;border:1px solid var(--rule);border-radius:4px;overflow:hidden}
.seg input{position:absolute;opacity:0;pointer-events:none}
.seg label{padding:6px 12px;font:500 13px var(--sans);cursor:pointer;border-right:1px solid var(--rule);user-select:none;white-space:nowrap}
.seg label:last-of-type{border-right:0}
.seg input:focus-visible + label{outline:2px solid var(--accent);outline-offset:-2px}
.seg input[value="pass"]:checked + label{background:var(--pass-bg);color:var(--pass)}
.seg input[value="needs_review"]:checked + label{background:var(--nr-bg);color:var(--nr)}
.seg input[value="fail"]:checked + label{background:var(--fail-bg);color:var(--fail)}
details.crit summary{cursor:pointer;font-weight:600}
details.crit summary span{font-weight:400;color:var(--muted);font-size:13px}
.critgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:4px 16px;margin-top:10px}
.critgrid h4{grid-column:1/-1;margin:10px 0 2px;font:600 12px var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.critgrid label{display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:1.4}
.critgrid input{margin-top:3px;accent-color:var(--accent)}
textarea{width:100%;min-height:72px;font:14px/1.5 var(--sans);color:var(--ink);background:var(--panel);border:1px solid var(--rule);border-radius:4px;padding:8px 10px}
textarea:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.btn{font:600 14px var(--sans);padding:9px 16px;border-radius:4px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);cursor:pointer}
.btn.ghost{background:transparent;color:var(--accent)}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.status{font-size:13px;color:var(--muted)}
.status.err{color:var(--fail)}
@media (max-width:760px){
  .layout{grid-template-columns:1fr}
  nav.list{display:none}
  .mobile-pick{display:block;margin-bottom:12px}
  .mobile-pick select{width:100%;font:14px var(--sans);padding:8px;border:1px solid var(--rule);border-radius:4px;background:var(--panel);color:var(--ink)}
  .dim{grid-template-columns:1fr}
  .card{padding:14px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>

<div class="wrap">
  <header class="top">
    <div>
      <h1>Judge calibration: 30 replies</h1>
      <p class="sub">Grade each reply on your own read. The version, case, and both AI judges' verdicts are hidden so they cannot anchor you. Judge the four dimensions independently.</p>
    </div>
    <div class="progress"><span id="count">0 of 30 graded</span><div class="bar"><i id="barfill"></i></div></div>
  </header>
  <div class="banner" id="nodb" hidden>Grades can't be saved in this view. Open the page from your claude.ai artifacts to grade.</div>
  <div class="legend">
    <span><b>pass</b> excellent manager would stand behind it</span>
    <span><b>needs review</b> a human should look</span>
    <span><b>fail</b> material error, overstep, or a reply that would hurt the relationship</span>
  </div>
  <div class="layout">
    <nav class="list" id="list" aria-label="Replies"></nav>
    <main>
      <div class="mobile-pick"><label for="pick" class="ref">Reply</label><select id="pick"></select></div>
      <article class="card" id="item"></article>
    </main>
  </div>
</div>

<script>
const DATA = ${data};
const DIMS = ['expertise','judgment','relationship','execution'];
const DIMNAME = {expertise:'Expertise',judgment:'Judgment',relationship:'Relationship',execution:'Execution'};
let labels = {};        // item_id -> saved label
let current = 0;
let db = null;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const graded = (id) => labels[id] && DIMS.every((d) => labels[id][d]);
const shortTick = (id) => graded(id) ? DIMS.map((d) => ({pass:'P',needs_review:'R',fail:'F'}[labels[id][d]])).join('') : '';

function renderList() {
  const list = document.getElementById('list');
  list.innerHTML = DATA.items.map((it, i) => '<button type="button" data-i="' + i + '" aria-current="' + (i === current) + '"><span class="ref">' + esc(it.item_id.replace('CAL2-','')) + '</span><span class="who">' + esc(it.agent.split(' ')[0]) + ' to ' + esc(it.from_role) + '</span><span class="tick' + (graded(it.item_id) ? ' done' : '') + '">' + (shortTick(it.item_id) || '&middot;') + '</span></button>').join('');
  list.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => show(+b.dataset.i)));
  const pick = document.getElementById('pick');
  pick.innerHTML = DATA.items.map((it, i) => '<option value="' + i + '"' + (i === current ? ' selected' : '') + '>' + esc(it.item_id) + ' ' + (graded(it.item_id) ? '(graded)' : '') + ' ' + esc(it.agent.split(' ')[0]) + ' to ' + esc(it.from_role) + '</option>').join('');
  const n = DATA.items.filter((it) => graded(it.item_id)).length;
  document.getElementById('count').textContent = n + ' of ' + DATA.items.length + ' graded';
  document.getElementById('barfill').style.width = (100 * n / DATA.items.length) + '%';
}

function factsList(arr, fmt) { return arr.length ? '<ul class="facts">' + arr.map(fmt).join('') + '</ul>' : ''; }

// the agent's first name, from the item itself (e.g. "Claire (front office)" -> "Claire")
const agentName = (it) => String(it.agent || 'the agent').split(' ')[0];
const fill = (s, it) => String(s).split('{agent}').join(agentName(it));

function show(i) {
  current = i;
  const it = DATA.items[i];
  const L = labels[it.item_id] || {};
  const crit = new Set(L.critical_failures || []);
  let h = '<div class="meta"><span class="ref">' + esc(it.item_id) + '</span><span>Agent <b>' + esc(it.agent) + '</b></span><span>Channel <b>' + esc(it.channel) + '</b></span><span>To <b>' + esc(it.from) + '</b>, ' + esc(it.from_role) + '</span></div>';
  h += '<h2>' + esc(it.from) + ' wrote</h2><p class="msg">' + esc(it.message) + '</p>';
  if (it.history.length) h += '<h3>Earlier in the thread</h3>' + factsList(it.history, (x) => '<li><b>' + esc(x.from) + ':</b> ' + esc(x.text) + '</li>');
  if (it.context.length) h += '<h3>What the agent had on record</h3>' + factsList(it.context, (x) => '<li>' + esc(x.text) + ' <span class="src">' + esc(x.source) + '</span></li>');
  if (it.team_record.length) h += '<h3>Shared team record</h3>' + factsList(it.team_record, (x) => '<li>' + esc(x.what) + ' <span class="src">' + esc(x.at) + ', ' + esc(x.status) + ', ' + esc(x.ref) + '</span></li>');
  if (it.actions_on_record.length) h += '<h3>Actions actually taken</h3>' + factsList(it.actions_on_record, (x) => '<li>' + esc(x.what) + ' <span class="src">' + esc(x.at) + '</span></li>');
  else h += '<h3>Actions actually taken</h3><p class="msg" style="color:var(--muted);font-size:14px">None on record.</p>';
  if (it.governance_bodies.length) h += '<h3>Governance bodies on record</h3>' + factsList(it.governance_bodies, (x) => '<li>' + esc(x.name) + ': ' + esc(x.scope) + ' <span class="src">' + esc(x.source) + '</span></li>');
  h += '<div class="exhibit"><div class="label">THE REPLY, VERBATIM</div><pre>' + esc(it.reply) + '</pre></div>';
  if (it.handoff_package) h += '<details class="internal"><summary>Internal handoff package (the recipient sees this, the customer does not)</summary><pre>' + esc(JSON.stringify(it.handoff_package, null, 2)) + '</pre></details>';
  if (it.commitments) h += '<details class="internal"><summary>Tracked commitments the agent recorded</summary><pre>' + esc(JSON.stringify(it.commitments, null, 2)) + '</pre></details>';
  h += '<form class="grade" id="gradeform">';
  for (const d of DIMS) {
    const r = DATA.rubric[d];
    h += '<div class="dim"><div class="q">' + DIMNAME[d] + ': ' + esc(fill(r.q, it)) + '</div><div class="seg" role="radiogroup" aria-label="' + DIMNAME[d] + '">'
      + ['pass','needs_review','fail'].map((v) => '<input type="radio" id="' + d + '-' + v + '" name="' + d + '" value="' + v + '"' + (L[d] === v ? ' checked' : '') + '><label for="' + d + '-' + v + '">' + ({pass:'Pass',needs_review:'Needs review',fail:'Fail'}[v]) + '</label>').join('')
      + '</div><div class="hint"><b>Pass:</b> ' + esc(fill(r.pass, it)) + ' <b>Fail:</b> ' + esc(fill(r.fail, it)) + '</div></div>';
  }
  const groups = {judgment:'Judgment',expertise:'Expertise',execution:'Execution',relationship:'Relationship'};
  h += '<details class="crit"' + (crit.size ? ' open' : '') + '><summary>Critical failures you see <span>(optional, ' + crit.size + ' marked)</span></summary><div class="critgrid">';
  for (const g of Object.keys(groups)) {
    h += '<h4>' + groups[g] + '</h4>' + DATA.catalog.filter((c) => c.dim === g).map((c) => '<label><input type="checkbox" name="crit" value="' + c.code + '"' + (crit.has(c.code) ? ' checked' : '') + '><span>' + esc(fill(c.label, it)) + '</span></label>').join('');
  }
  h += '</div></details>';
  h += '<div><label for="notes" class="q" style="font-weight:600">Notes <span style="font-weight:400;color:var(--muted)">(optional: what you saw that the grade alone does not say)</span></label><textarea id="notes" name="notes">' + esc(L.notes || '') + '</textarea></div>';
  h += '<div class="actions"><button class="btn" type="submit" id="save">Save and next</button><button class="btn ghost" type="button" id="prev">Previous</button><span class="status" id="status" aria-live="polite">' + (graded(it.item_id) ? 'Saved' : '') + '</span></div></form>';
  const el = document.getElementById('item');
  el.innerHTML = h;
  document.getElementById('gradeform').addEventListener('submit', save);
  document.getElementById('prev').addEventListener('click', () => show(Math.max(0, current - 1)));
  if (!db) document.getElementById('save').disabled = true;
  renderList();
  window.scrollTo({ top: 0 });
}

async function save(e) {
  e.preventDefault();
  const it = DATA.items[current];
  const f = e.target;
  const body = { item_id: it.item_id };
  for (const d of DIMS) { const v = f.querySelector('input[name="' + d + '"]:checked'); body[d] = v ? v.value : null; }
  const status = document.getElementById('status');
  const missing = DIMS.filter((d) => !body[d]);
  if (missing.length) { status.className = 'status err'; status.textContent = 'Grade ' + missing.map((d) => DIMNAME[d].toLowerCase()).join(', ') + ' before saving.'; return; }
  body.critical_failures = [...f.querySelectorAll('input[name="crit"]:checked')].map((x) => x.value);
  body.notes = f.querySelector('#notes').value.trim();
  body.saved_at = new Date().toISOString();
  const btn = document.getElementById('save'); btn.disabled = true; status.className = 'status'; status.textContent = 'Saving...';
  try {
    await db.collection('labels').doc(it.item_id).set(body);
    labels[it.item_id] = body;
    status.textContent = 'Saved';
    const next = DATA.items.findIndex((x, i) => i > current && !graded(x.item_id));
    show(next >= 0 ? next : Math.min(current + 1, DATA.items.length - 1));
  } catch (err) {
    btn.disabled = false; status.className = 'status err';
    status.textContent = err && err.code === 'invalid_argument' ? 'Only the page owner or an editor can save grades.' : 'Could not save. Try again in a moment.';
  }
}

document.getElementById('pick').addEventListener('change', (e) => show(+e.target.value));
show(0);

(async () => {
  db = window.claude && window.claude.use ? await window.claude.use('db') : null;
  if (!db) { document.getElementById('nodb').hidden = false; return; }
  db.collection('labels').onSnapshot((snap) => {
    const next = {};
    snap.docs.forEach((d) => { next[d.id] = d.data(); });
    const first = !Object.keys(labels).length;
    labels = next;
    if (first) {
      const open = DATA.items.findIndex((x) => !graded(x.item_id));
      show(open >= 0 ? open : current);
    } else renderList();
  }, () => { document.getElementById('nodb').hidden = false; });
  const s = document.getElementById('save'); if (s) s.disabled = false;
})();
</script>
`;
fs.writeFileSync(process.argv[2] || path.join(__dirname, '..', 'calibration', 'grading_v2.html'), html);
console.log('written', (process.argv[2] || 'academy/calibration/grading_v2.html'), html.length, 'bytes');
