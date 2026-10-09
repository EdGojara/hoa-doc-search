// public/close.js — Accounting > Close (Ed 2026-10-09: month-end close, PR A).
// Renders into accounting.html's #body. Server: /api/close (lib/close/*).
// The checklist is computed by the server from the books; this screen shows it,
// and lets the owner override a BLOCK (with a reason), an admin accept warnings,
// close the month, and reopen it (with a reason). Nothing here decides a result.
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = (c) => { if (c == null) return ''; const n = Number(c) / 100; const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return n < 0 ? `($${s})` : `$${s}`; };
  const monthName = (iso) => new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const dayName = (iso) => new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const when = (ts) => ts ? new Date(ts).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' CT' : '';

  const CSS = `
  .mec-top { display:flex; justify-content:space-between; align-items:flex-end; gap:16px; flex-wrap:wrap; margin-bottom:14px; }
  .mec-through { font-family:var(--font-serif); font-size:22px; color:var(--navy); }
  .mec-through small { display:block; font-family:Inter,system-ui,sans-serif; font-size:12px; color:var(--ink-faint); margin-top:2px; }
  .mec-grid { display:grid; grid-template-columns:260px minmax(0, 1fr); gap:16px; align-items:start; }
  .mec-grid > * { min-width:0; }
  @media (max-width: 860px) { .mec-grid { grid-template-columns:minmax(0, 1fr); } }
  .mec-months { padding:6px 0; }
  .mec-m { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:9px 14px; cursor:pointer; border-left:3px solid transparent; }
  .mec-m:hover { background:#faf8f2; }
  .mec-m.on { background:#f6f1e1; border-left-color:var(--gold); }
  .mec-m .n { font-weight:600; color:var(--navy); font-size:13.5px; }
  .chip { display:inline-block; font-size:11px; font-weight:700; padding:2px 9px; border-radius:999px; white-space:nowrap; }
  .chip.open { background:#eef2f7; color:#475569; } .chip.review { background:#fef3c7; color:#92400e; }
  .chip.ready { background:#dbeafe; color:#1e40af; } .chip.closed { background:#dcfce7; color:#166534; }
  .chip.override { background:#fde7c7; color:#7c2d12; border:1px solid #f0b46a; } .chip.locked { background:#f1f5f9; color:#64748b; }
  .chip.prior { background:transparent; color:#94a3b8; border:1px dashed #cbd5e1; }
  .mec-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap; border-bottom:1px solid var(--rule); padding-bottom:12px; margin-bottom:12px; }
  .mec-head h2 { font-family:var(--font-serif); font-size:24px; color:var(--navy); margin:0; }
  .mec-sub { color:var(--ink-soft); font-size:12.5px; margin-top:3px; }
  .mec-btns { display:flex; gap:8px; flex-wrap:wrap; }
  .mbtn { padding:8px 16px; border-radius:8px; border:1px solid var(--rule); background:#fff; color:var(--navy); font-weight:700; font-size:13px; cursor:pointer; }
  .mbtn.primary { background:var(--navy); color:#fff; border-color:var(--navy); }
  .mbtn.gold { background:var(--gold); color:var(--navy); border-color:var(--gold); }
  .mbtn[disabled] { opacity:.45; cursor:not-allowed; }
  .mec-tally { display:flex; gap:10px; margin:4px 0 14px; flex-wrap:wrap; }
  .tally { border:1px solid var(--rule); border-radius:10px; padding:8px 14px; min-width:110px; background:#fff; }
  .tally .v { font-size:20px; font-weight:800; font-variant-numeric:tabular-nums; } .tally .l { font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-faint); }
  .tally.p .v { color:#15803d; } .tally.w .v { color:#b45309; } .tally.b .v { color:#b91c1c; }
  .mec-group { margin:14px 0 6px; font-size:11px; font-weight:800; letter-spacing:.09em; text-transform:uppercase; color:var(--ink-faint); }
  .ctl { display:grid; grid-template-columns:78px minmax(0, 1fr) auto; gap:12px; padding:11px 0; border-bottom:1px solid #f1efe8; }
  .ctl > div { min-width:0; overflow-wrap:anywhere; }
  @media (max-width: 560px) { .ctl { grid-template-columns:70px minmax(0, 1fr); } .ctl .amt { grid-column:2; text-align:left; } }
  .st { font-size:11px; font-weight:800; letter-spacing:.05em; padding:3px 0; text-align:center; border-radius:6px; height:fit-content; }
  .st.PASS { background:#dcfce7; color:#166534; } .st.WARNING { background:#fef3c7; color:#92400e; } .st.BLOCK { background:#fee2e2; color:#991b1b; }
  .st.OVR { background:#fde7c7; color:#7c2d12; }
  .ctl .t { font-weight:700; color:var(--navy); font-size:13.5px; } .ctl .code { color:var(--ink-faint); font-weight:600; font-size:11px; margin-left:6px; }
  .ctl .x { color:var(--ink); font-size:13px; margin-top:3px; line-height:1.45; }
  .ctl .a { color:var(--ink-soft); font-size:12.5px; margin-top:5px; } .ctl .a b { color:var(--navy); }
  .ctl .o { margin-top:6px; font-size:12.5px; background:#fff7ed; border-left:3px solid #f0b46a; padding:6px 10px; border-radius:0 6px 6px 0; }
  .ctl .amt { text-align:right; font-variant-numeric:tabular-nums; font-weight:700; color:var(--navy); white-space:nowrap; font-size:13px; }
  .ctl .amt a { display:block; font-weight:600; font-size:12px; color:#8C6D1F; text-decoration:none; margin-top:4px; }
  .ctl .acts { margin-top:7px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:12.5px; }
  .lnk { background:none; border:none; padding:0; color:#8C6D1F; font-weight:700; cursor:pointer; font-size:12.5px; }
  .mec-hist { margin-top:18px; } .mec-hist .e { font-size:12.5px; padding:6px 0; border-bottom:1px solid #f1efe8; color:var(--ink-soft); }
  .mec-hist .e b { color:var(--navy); }
  .mec-dlg { position:fixed; inset:0; background:rgba(11,29,52,.45); display:flex; align-items:center; justify-content:center; z-index:50; padding:16px; }
  .mec-dlg > div { background:#fff; border-radius:12px; max-width:520px; width:100%; padding:20px 22px; box-shadow:0 20px 50px rgba(0,0,0,.25); }
  .mec-dlg h3 { font-family:var(--font-serif); color:var(--navy); margin:0 0 6px; font-size:20px; }
  .mec-dlg textarea { width:100%; min-height:90px; border:1px solid var(--rule); border-radius:8px; padding:9px 11px; font:inherit; font-size:13.5px; margin:10px 0; }
  .mec-err { color:#991b1b; font-size:12.5px; margin-top:6px; }
  .mec-note { font-size:12px; color:var(--ink-faint); margin-top:8px; }`;

  let state = { cid: null, periods: null, sel: null, detail: null, busy: false };
  const $ = (id) => document.getElementById(id);
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(await (window.chkAuthHeader ? window.chkAuthHeader() : {})) };
    const r = await fetch(`/api/close/${state.cid}${path}`, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || j.detail || `Request failed (${r.status})`);
    return j;
  }

  function chipFor(p) {
    if (p.prior_system && p.close_status !== 'closed') return p.locked_by_later_close ? '<span class="chip locked">Locked · prior system</span>' : '<span class="chip prior">Prior system</span>';
    if (p.close_status === 'closed') return p.close_label === 'closed_with_override' ? '<span class="chip override">Closed with override</span>' : '<span class="chip closed">Closed</span>';
    if (p.locked_by_later_close) return '<span class="chip locked">Locked</span>';
    if (p.close_status === 'ready_to_close') return '<span class="chip ready">Ready to close</span>';
    if (p.close_status === 'review') return '<span class="chip review">In review</span>';
    return '<span class="chip open">Open</span>';
  }

  async function render(cid) {
    state = { cid, periods: null, sel: state.cid === cid ? state.sel : null, detail: null, busy: false };
    if (!document.getElementById('mec-css')) { const s = document.createElement('style'); s.id = 'mec-css'; s.textContent = CSS; document.head.appendChild(s); }
    $('body').innerHTML = `<div class="mec-top"><div class="mec-through" id="mec-through">Month-end close</div></div>
      <div class="mec-grid"><div class="card mec-months" id="mec-months"><div class="muted" style="padding:14px;">Loading…</div></div>
      <div class="card" id="mec-detail"><div class="muted">Loading…</div></div></div>`;
    try {
      state.periods = await api('/periods');
    } catch (e) { $('mec-months').innerHTML = `<div class="mec-err" style="padding:14px;">${esc(e.message)}</div>`; $('mec-detail').innerHTML = ''; return; }
    const P = state.periods;
    $('mec-through').innerHTML = P.closed_through ? `Books closed through ${esc(dayName(P.closed_through))}<small>Every entry dated on or before this day is locked.</small>`
      : `No month is closed yet<small>${P.gl_cutover_date ? `Books kept in trustEd from ${esc(dayName(P.gl_cutover_date))}. ` : ''}Months close in order.</small>`;
    const today = new Date().toISOString().slice(0, 10);
    const months = P.periods.filter((p) => String(p.period_start) <= today).slice(0, 18);
    if (!state.sel) {
      const firstOpen = months.slice().reverse().find((p) => !p.prior_system && p.close_status !== 'closed' && String(p.period_end) < today);
      state.sel = (firstOpen || months.find((p) => !p.prior_system) || months[0] || {}).id;
    }
    $('mec-months').innerHTML = months.map((p) => `<div class="mec-m ${p.id === state.sel ? 'on' : ''}" data-id="${p.id}"><span class="n">${esc(monthName(p.period_end))}</span>${chipFor(p)}</div>`).join('') || '<div class="muted" style="padding:14px;">No periods set up.</div>';
    $('mec-months').querySelectorAll('.mec-m').forEach((el) => el.addEventListener('click', () => { state.sel = el.dataset.id; render(cid); }));
    if (state.sel) loadDetail();
  }

  async function loadDetail() {
    const box = $('mec-detail');
    try { state.detail = await api(`/periods/${state.sel}`); } catch (e) { box.innerHTML = `<div class="mec-err">${esc(e.message)}</div>`; return; }
    const d = state.detail; const p = d.period; const rec = d.record || {}; const viewer = d.viewer;
    const meta = (state.periods.periods || []).find((x) => x.id === p.id) || {};
    const isClosed = ['closed', 'locked'].includes(p.status);
    const isAdmin = viewer === 'owner' || viewer === 'admin';
    const blocks = d.results.filter((r) => r.status === 'BLOCK');
    const openBlocks = blocks.filter((r) => !r.override);
    const warns = d.results.filter((r) => r.status === 'WARNING');
    const unaccepted = warns.filter((r) => !r.accepted);
    let sub;
    if (isClosed) sub = `${rec.close_label === 'closed_with_override' ? '<span class="chip override">Closed with override</span> ' : '<span class="chip closed">Closed</span> '}Closed through ${esc(dayName(p.period_end))} · closed ${esc(when(rec.closed_at))} by ${esc(rec.closed_by || '')}`;
    else if (meta.locked_by_later_close) sub = 'Locked by a later month\'s close (entries dated in it cannot change).';
    else if (!d.run) sub = 'The checklist has not run for this month yet.';
    else sub = `Checklist run ${esc(when(d.run.run_at))} by ${esc(d.run.run_by)}${rec.reopen_count ? ` · reopened ${rec.reopen_count}× (last: “${esc(rec.reopen_reason || '')}”)` : ''}`;
    const tally = d.run ? `<div class="mec-tally"><div class="tally p"><div class="v">${d.results.filter((r) => r.status === 'PASS').length}</div><div class="l">Pass</div></div>
      <div class="tally w"><div class="v">${warns.length}</div><div class="l">Warning${unaccepted.length && !isClosed ? ` · ${unaccepted.length} open` : ''}</div></div>
      <div class="tally b"><div class="v">${blocks.length}</div><div class="l">Block${blocks.length ? ` · ${blocks.length - openBlocks.length} overridden` : ''}</div></div></div>` : '';
    const groups = [];
    for (const r of d.results) { let g = groups.find((x) => x.name === r.group); if (!g) groups.push(g = { name: r.group, rows: [] }); g.rows.push(r); }
    const row = (r) => {
      const st = r.status === 'BLOCK' && r.override ? '<div class="st OVR">OVERRIDE</div>' : `<div class="st ${r.status}">${r.status}</div>`;
      const amt = r.amount_cents != null && r.amount_cents !== 0 ? money(r.amount_cents) : (r.count ? `${r.count}` : '');
      const drill = r.drill ? `<a href="${esc(r.drill.href)}" target="_blank" rel="noopener">${esc(r.drill.label)} →</a>` : '';
      const acts = [];
      if (!isClosed && r.status === 'BLOCK' && !r.override && viewer === 'owner') acts.push(`<button class="lnk" data-ovr="${esc(r.code)}">Override (owner)…</button>`);
      if (!isClosed && r.status === 'WARNING' && !r.accepted && isAdmin) acts.push(`<label><input type="checkbox" class="mec-acc" value="${esc(r.code)}"> Accept this warning</label>`);
      if (r.status === 'WARNING' && r.accepted) acts.push('<span style="color:#166534; font-weight:700;">✓ Accepted</span>');
      return `<div class="ctl">${st}<div><div class="t">${esc(r.label)}<span class="code">${esc(r.code)}</span></div><div class="x">${esc(r.explanation)}</div>
        ${r.action ? `<div class="a"><b>Next step:</b> ${esc(r.action)}</div>` : ''}
        ${r.override ? `<div class="o"><b>Overridden by ${esc(r.override.actor)}</b> · ${esc(when(r.override.at))}<br>“${esc(r.override.reason)}”<br><span class="muted">The original BLOCK is kept in the close record.</span></div>` : ''}
        ${acts.length ? `<div class="acts">${acts.join('')}</div>` : ''}</div><div class="amt">${esc(amt)}${drill}</div></div>`;
    };
    const canClose = !isClosed && isAdmin && d.can_close;
    const closeTitle = isClosed ? '' : !isAdmin ? 'An admin or the owner closes a month.' : !d.run ? 'Run the checklist first.' : openBlocks.length ? `${openBlocks.length} BLOCK${openBlocks.length > 1 ? 's' : ''} need fixing or an owner override.` : unaccepted.length ? 'Accept the open warnings first.' : '';
    const ev = (d.events || []).slice().reverse().map((e) => {
      const what = { run: 'ran the checklist', block_overridden: `overrode BLOCK ${e.control_code}`, warnings_accepted: `accepted warnings ${((e.detail && e.detail.control_codes) || []).join(', ')}`, closed: `closed the month${e.detail && e.detail.label === 'closed_with_override' ? ' (with override)' : ''}`, reopened: 'reopened the month' }[e.event] || e.event;
      return `<div class="e"><b>${esc(e.actor)}</b> ${esc(what)} · ${esc(when(e.created_at))}${e.reason ? ` — “${esc(e.reason)}”` : ''}</div>`;
    }).join('');
    box.innerHTML = `<div class="mec-head"><div><h2>${esc(monthName(p.period_end))}</h2><div class="mec-sub">${sub}</div></div>
      <div class="mec-btns">
        ${!isClosed && !meta.locked_by_later_close ? '<button class="mbtn" id="mec-run">Run checklist</button>' : ''}
        ${!isClosed && isAdmin && unaccepted.length ? '<button class="mbtn gold" id="mec-accept" disabled>Accept selected warnings</button>' : ''}
        ${!isClosed && !meta.locked_by_later_close ? `<button class="mbtn primary" id="mec-close" ${canClose ? '' : 'disabled'} title="${esc(closeTitle)}">Close ${esc(monthName(p.period_end))}</button>` : ''}
        ${isClosed && isAdmin ? '<button class="mbtn" id="mec-reopen">Reopen…</button>' : ''}
      </div></div>
      ${tally}
      ${d.run ? groups.map((g) => `<div class="mec-group">${esc(g.name)}</div>${g.rows.map(row).join('')}`).join('') : '<div class="muted" style="padding:10px 0;">Run the checklist to see what this month needs before it can close. It reads the books; it posts nothing.</div>'}
      ${!isClosed && closeTitle && d.run ? `<div class="mec-note">${esc(closeTitle)}</div>` : ''}
      ${ev ? `<div class="mec-hist"><div class="mec-group">History</div>${ev}</div>` : ''}`;
    const runBtn = $('mec-run');
    if (runBtn) runBtn.addEventListener('click', async () => {
      runBtn.disabled = true; runBtn.textContent = 'Running…';
      try { await api(`/periods/${p.id}/run`, { method: 'POST', body: '{}' }); await render(state.cid); }
      catch (e) { runBtn.disabled = false; runBtn.textContent = 'Run checklist'; alertBox(e.message); }
    });
    const acc = $('mec-accept');
    if (acc) {
      const sync = () => { acc.disabled = !document.querySelectorAll('.mec-acc:checked').length; };
      document.querySelectorAll('.mec-acc').forEach((c) => c.addEventListener('change', sync));
      acc.addEventListener('click', () => {
        const codes = [...document.querySelectorAll('.mec-acc:checked')].map((c) => c.value);
        dialog({ title: `Accept ${codes.length} warning${codes.length > 1 ? 's' : ''}`, body: `You are accepting ${codes.join(', ')} for ${monthName(p.period_end)}. This is recorded with your name.`, placeholder: 'Note (optional)', minLen: 0, cta: 'Accept',
          onOk: (note) => api(`/periods/${p.id}/accept-warnings`, { method: 'POST', body: JSON.stringify({ run_id: d.run.id, control_codes: codes, note }) }) });
      });
    }
    document.querySelectorAll('[data-ovr]').forEach((b) => b.addEventListener('click', () => {
      const r = d.results.find((x) => x.code === b.dataset.ovr);
      dialog({ title: `Override ${r.code}`, body: `${r.label}: ${r.explanation}\n\nOnly the owner can close past a BLOCK. The original BLOCK stays in the close record, and the month will be labelled “Closed with override.”`,
        placeholder: 'Why is it right to close with this open? (10+ characters)', minLen: 10, cta: 'Override BLOCK',
        onOk: (reason) => api(`/periods/${p.id}/override`, { method: 'POST', body: JSON.stringify({ run_id: d.run.id, control_code: r.code, reason }) }) });
    }));
    const cl = $('mec-close');
    if (cl && canClose) cl.addEventListener('click', () => {
      const ovr = blocks.length;
      dialog({ title: `Close ${monthName(p.period_end)}`, body: `Closing locks every entry dated on or before ${dayName(p.period_end)}. Corrections then need an adjusting entry in an open month, or a reopen with a reason.${ovr ? `\n\nThis close carries ${ovr} owner override${ovr > 1 ? 's' : ''} and will be labelled “Closed with override.”` : ''}`,
        noInput: true, cta: 'Close the month', onOk: () => api(`/periods/${p.id}/close`, { method: 'POST', body: JSON.stringify({ run_id: d.run.id }) }) });
    });
    const ro = $('mec-reopen');
    if (ro) ro.addEventListener('click', () => dialog({ title: `Reopen ${monthName(p.period_end)}`, body: 'Reopening unlocks the month (and any earlier prior-system dates it locked). The reason, your name and the time are recorded. Later closed months must be reopened first.',
      placeholder: 'Reason for reopening (10+ characters)', minLen: 10, cta: 'Reopen', onOk: (reason) => api(`/periods/${p.id}/reopen`, { method: 'POST', body: JSON.stringify({ reason }) }) }));
  }

  function alertBox(msg) { dialog({ title: 'Not done', body: msg, noInput: true, cta: 'OK', onOk: async () => {} }); }
  function dialog({ title, body, placeholder, minLen = 0, cta, onOk, noInput = false }) {
    const w = document.createElement('div'); w.className = 'mec-dlg';
    w.innerHTML = `<div><h3>${esc(title)}</h3><div style="font-size:13.5px; color:var(--ink); white-space:pre-line;">${esc(body)}</div>
      ${noInput ? '' : `<textarea placeholder="${esc(placeholder || '')}"></textarea>`}<div class="mec-err"></div>
      <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:10px;"><button class="mbtn" data-x>Cancel</button><button class="mbtn primary" data-ok>${esc(cta)}</button></div></div>`;
    document.body.appendChild(w);
    const ta = w.querySelector('textarea'); if (ta) ta.focus();
    w.querySelector('[data-x]').addEventListener('click', () => w.remove());
    w.querySelector('[data-ok]').addEventListener('click', async () => {
      const v = ta ? ta.value.trim() : '';
      if (v.length < minLen) { w.querySelector('.mec-err').textContent = `Please write at least ${minLen} characters.`; return; }
      const ok = w.querySelector('[data-ok]'); ok.disabled = true;
      try { await onOk(v); w.remove(); if (state.cid) render(state.cid); }
      catch (e) { ok.disabled = false; w.querySelector('.mec-err').textContent = e.message; }
    });
  }

  window.renderMonthEndClose = render;
})();
