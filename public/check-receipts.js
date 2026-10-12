// ============================================================================
// public/check-receipts.js  (Ed 2026-10-12)
// Accounting -> Homeowners -> Check Receipts. Scan checks, confirm the proposed owner
// account, record each payment once, record the bank's remote-deposit confirmation,
// match the deposit to the bank line, and return (reverse) a bounced check.
// API: /api/check-receipts (lib/payments/check_receipts.js).
// ============================================================================
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (c) => (c == null ? '' : '$' + (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const STATUS = {
    scanned: ['#475569', '#f1f5f9', 'Scanned'], matched: ['#1e40af', '#dbeafe', 'Matched: confirm'], recorded: ['#166534', '#dcfce7', 'Recorded (undeposited)'],
    deposited: ['#0f766e', '#ccfbf1', 'Deposited'], reconciled: ['#14532d', '#bbf7d0', 'Reconciled'], returned: ['#991b1b', '#fee2e2', 'Returned'],
    exception: ['#92400e', '#fef3c7', 'Exception: needs review'], voided: ['#64748b', '#f1f5f9', 'Voided'],
  };
  const pill = (s) => { const v = STATUS[s] || STATUS.scanned; return `<span style="font-size:10.5px; font-weight:700; padding:2px 8px; border-radius:9px; color:${v[0]}; background:${v[1]}; white-space:nowrap;">${v[2]}</span>`; };
  const api = async (url, opts) => { const r = await fetch(url, opts); const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.message || j.error || `HTTP ${r.status}`), { body: j, status: r.status }); return j; };
  const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let CID = null; let ROOT = null; let FILTER = 'open';

  async function render(cid, root) {
    CID = cid; ROOT = root;
    root.innerHTML = '<div class="muted" style="padding:24px;">Loading check receipts...</div>';
    let list, deps;
    try {
      [list, deps] = await Promise.all([api(`/api/check-receipts?community_id=${CID}`), api(`/api/check-receipts/deposits?community_id=${CID}`)]);
    } catch (e) {
      root.innerHTML = `<div class="card" style="padding:20px;">${e.body && e.body.error === 'migration_514_required' ? 'Check scanning needs <strong>migration 514</strong> (Documents &rarr; Migration status). Nothing has been recorded.' : 'Could not load check receipts: ' + esc(e.message)}</div>`;
      return;
    }
    const rows = list.receipts || [];
    const open = rows.filter((r) => ['scanned', 'matched', 'exception'].includes(r.status));
    const undeposited = rows.filter((r) => r.status === 'recorded');
    const shown = FILTER === 'open' ? open : FILTER === 'all' ? rows : rows.filter((r) => r.status === FILTER);
    const chip = (k, label, n) => `<span data-f="${k}" style="cursor:pointer; padding:4px 10px; border-radius:14px; font-size:12px; border:1px solid ${FILTER === k ? '#0B1D34' : '#e2e8f0'}; background:${FILTER === k ? '#0B1D34' : '#fff'}; color:${FILTER === k ? '#fff' : '#334155'};">${label} ${n != null ? `<strong>${n}</strong>` : ''}</span>`;
    root.innerHTML = `
      <div class="card" style="margin-bottom:14px;">
        <h2 class="sec" style="margin:0 0 8px;">Add checks</h2>
        <div id="cr-drop" role="button" tabindex="0" aria-label="Add checks: drop check images or PDFs here, or press Enter to choose files" aria-describedby="cr-drop-help"
          style="border:2px dashed #94a3b8; border-radius:12px; padding:30px 18px; text-align:center; cursor:pointer; background:#f8fafc; transition:background .15s, border-color .15s;">
          <div style="font-size:17px; font-weight:700; color:#0B1D34;">Drop checks here</div>
          <div style="font-size:13px; color:#334155; margin-top:4px;">or <span style="text-decoration:underline;">click to choose files</span></div>
          <div id="cr-drop-help" class="muted" style="font-size:12px; margin-top:8px;">Photos or scans of the front of each check, or a PDF from the scanner (one check per page). Reading starts right away. You can attach a back later if you need it.</div>
          <input type="file" id="cr-file" multiple accept="image/*,application/pdf" style="display:none;">
        </div>
        <div id="cr-up-status" role="status" aria-live="polite" style="font-size:12.5px; margin-top:8px;"></div>
        <div id="cr-queue" style="margin-top:6px;"></div>
        <div id="cr-batch" style="margin-top:10px;"></div>
        <div class="muted" style="font-size:11.5px; margin-top:8px;">Nothing is posted when a check is read. trustEd proposes the owner account (from the account number, the property address, earlier checks from the same bank account and the owner's name together, never the name alone) and checks for duplicates. A payment posts only when you press Record and confirm: <strong>Dr Undeposited Funds / Cr Accounts Receivable</strong>. Cash moves when you record the bank's deposit.</div>
      </div>
      <div class="card" style="margin-bottom:14px;">
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:10px;">
          <h2 class="sec" style="margin:0 10px 0 0;">Checks</h2>
          ${chip('open', 'Needs review', open.length)}${chip('recorded', 'Undeposited', undeposited.length)}${chip('deposited', 'Deposited', (list.counts || {}).deposited || 0)}${chip('reconciled', 'Reconciled', (list.counts || {}).reconciled || 0)}${chip('returned', 'Returned', (list.counts || {}).returned || 0)}${chip('all', 'All', rows.length)}
        </div>
        <table><thead><tr><th>Received</th><th>Check #</th><th class="num">Amount</th><th>Payer</th><th>Account</th><th>Status</th><th></th></tr></thead><tbody>
        ${shown.map((r) => `<tr><td>${esc(r.received_date)}</td><td>${esc(r.check_number || '')}</td><td class="num">${fmt(r.amount_cents)}</td><td>${esc(r.payer_name || '')}</td><td>${esc((r.properties && r.properties.street_address) || '')}</td><td>${pill(r.status)}${r.exception_reason ? `<div class="muted" style="font-size:11px; max-width:320px;">${esc(r.exception_reason)}</div>` : ''}</td><td><button data-open="${r.id}" style="padding:4px 10px; border:1px solid #cbd5e1; border-radius:6px; background:#fff; cursor:pointer;">Open</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted" style="text-align:center; padding:16px;">Nothing here.</td></tr>'}
        </tbody></table>
      </div>
      <div class="card" style="margin-bottom:14px;">
        <h2 class="sec" style="margin:0 0 6px;">Record a bank deposit</h2>
        <div class="muted" style="font-size:12.5px; margin-bottom:8px;">After the remote deposit, select the checks it contained and enter the bank's confirmation. Posts <strong>Dr Operating Cash / Cr Undeposited Funds</strong> for the total, dated the deposit date.</div>
        ${undeposited.length ? `<table><thead><tr><th></th><th>Received</th><th>Check #</th><th>Payer</th><th class="num">Amount</th></tr></thead><tbody>
          ${undeposited.map((r) => `<tr><td><input type="checkbox" class="cr-dep" value="${r.id}" data-amt="${r.amount_cents}" checked></td><td>${esc(r.received_date)}</td><td>${esc(r.check_number)}</td><td>${esc(r.payer_name || '')}</td><td class="num">${fmt(r.amount_cents)}</td></tr>`).join('')}
        </tbody></table>
        <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; margin-top:10px; font-size:12px;">
          <span>Selected: <strong id="cr-dep-total"></strong></span>
          <label>Deposit date<br><input type="date" id="cr-dep-date" value="${today()}"></label>
          <label>Bank confirmation / reference #<br><input id="cr-dep-ref" style="width:180px;"></label>
          <label>Bank confirmation total ($)<br><input id="cr-dep-total-bank" style="width:110px;" placeholder="must equal"></label>
          <label>Confirmation file (optional)<br><input type="file" id="cr-dep-file" accept="image/*,application/pdf"></label>
          <button id="cr-dep-go" style="padding:8px 16px; border:none; border-radius:7px; background:#0f766e; color:#fff; font-weight:600; cursor:pointer;">Record deposit</button>
        </div>` : '<div class="muted" style="font-size:12.5px;">No recorded checks are waiting for a deposit.</div>'}
        <h3 style="font-size:14px; margin:16px 0 6px;">Deposits</h3>
        <table><thead><tr><th>Date</th><th>Bank reference</th><th class="num">Checks</th><th class="num">Total</th><th>GL entry</th><th>Status</th><th></th></tr></thead><tbody>
        ${(deps.deposits || []).map((d) => `<tr><td>${esc(d.deposit_date)}</td><td>${esc(d.bank_reference)}</td><td class="num">${d.check_count}</td><td class="num">${fmt(d.total_cents)}</td><td>${esc((d.journal_entries && d.journal_entries.reference) || '')}</td><td>${d.status === 'reconciled' ? pill('reconciled') : pill('deposited')}</td><td>${d.status === 'deposited' ? `<button data-rec="${d.id}" style="padding:4px 10px; border:1px solid #cbd5e1; border-radius:6px; background:#fff; cursor:pointer;">Match bank line</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted" style="text-align:center; padding:12px;">No deposits recorded yet.</td></tr>'}
        </tbody></table>
      </div>
      <div id="cr-modal"></div>`;
    root.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('click', () => { FILTER = el.dataset.f; render(CID, ROOT); }));
    root.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', () => openReceipt(el.dataset.open)));
    root.querySelectorAll('[data-rec]').forEach((el) => el.addEventListener('click', () => reconcile(el.dataset.rec)));
    bindDrop();
    paintQueue();
    paintBatch();
    if (Q.msg) status(Q.msg);   // the last upload message survives a list refresh
    const depTotal = () => { const t = [...root.querySelectorAll('.cr-dep:checked')].reduce((s, x) => s + Number(x.dataset.amt), 0); const el = root.querySelector('#cr-dep-total'); if (el) el.textContent = fmt(t); };
    root.querySelectorAll('.cr-dep').forEach((x) => x.addEventListener('change', depTotal)); depTotal();
    const go = root.querySelector('#cr-dep-go'); if (go) go.addEventListener('click', deposit);
  }

  // ---- Upload: drop zone -> per-file upload (progress) -> reading -> batch review --------
  // State lives here, not in the DOM, so refreshing the checks list never loses an upload in
  // progress. Uploading or reading a check NEVER posts: Record is a separate confirmed click.
  const Q = { items: [], results: [], batchId: null, running: 0, seq: 0, msg: '' };
  const CONCURRENCY = 2;
  const OK_TYPE = (f) => /^image\//.test(f.type) || f.type === 'application/pdf' || /\.(pdf|jpe?g|png|heic|webp|gif)$/i.test(f.name);
  const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const status = (t) => { Q.msg = t; const el = ROOT && ROOT.querySelector('#cr-up-status'); if (el) el.textContent = t; };

  function bindDrop() {
    const zone = ROOT.querySelector('#cr-drop'); const input = ROOT.querySelector('#cr-file');
    if (!zone || !input) return;
    const hot = (on) => { zone.style.background = on ? '#eef6ff' : '#f8fafc'; zone.style.borderColor = on ? '#1e40af' : '#94a3b8'; };
    zone.addEventListener('click', (e) => { if (e.target !== input) input.click(); });
    zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); hot(true); }));
    ['dragleave', 'dragend'].forEach((ev) => zone.addEventListener(ev, () => hot(false)));
    zone.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); hot(false); addFiles(e.dataTransfer && e.dataTransfer.files); });
    input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
  }

  function addFiles(list) {
    const files = [...(list || [])];
    if (!files.length) return;
    if (!Q.batchId) Q.batchId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : null;
    for (const f of files) Q.items.push({ id: ++Q.seq, file: f, status: OK_TYPE(f) ? 'queued' : 'error', pct: 0, error: OK_TYPE(f) ? null : 'This is not an image or a PDF.', checks: 0 });
    status(`${files.length} file${files.length === 1 ? '' : 's'} added. Reading starts now.`);
    paintQueue(); pump();
  }

  function pump() {
    while (Q.running < CONCURRENCY) { const it = Q.items.find((x) => x.status === 'queued'); if (!it) break; upload(it); }
    if (!Q.running && Q.items.length && !Q.items.some((x) => x.status === 'queued')) {
      const found = Q.results.filter((r) => !r.error).length; const bad = Q.items.filter((x) => x.status === 'error').length;
      status(`Done: ${found} check${found === 1 ? '' : 's'} read${bad ? `, ${bad} file${bad === 1 ? ' needs' : 's need'} attention` : ''}. Review each check below; nothing is posted until you press Record.`);
      refreshList();
    }
  }

  function upload(it) {
    it.status = 'uploading'; it.pct = 0; it.error = null; Q.running++; paintQueue();
    const fd = new FormData(); fd.append('community_id', CID); if (Q.batchId) fd.append('scan_batch_id', Q.batchId); fd.append('files', it.file, it.file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/check-receipts/scan');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { it.pct = Math.round((e.loaded / e.total) * 100); paintQueue(); } };
    xhr.upload.onload = () => { it.status = 'reading'; paintQueue(); };
    const done = () => { Q.running--; paintQueue(); paintBatch(); pump(); };
    xhr.onload = () => {
      let j = {}; try { j = JSON.parse(xhr.responseText || '{}'); } catch (_) { /* not JSON */ }
      if (xhr.status >= 400) { it.status = 'error'; it.error = j.message || (j.error === 'migration_514_required' ? 'Check scanning is not switched on yet (migration 514).' : j.error) || `The server answered ${xhr.status}.`; return done(); }
      const rs = j.results || [];
      Q.results = Q.results.filter((r) => r._item !== it.id);
      for (const r of rs) Q.results.push({ ...r, _item: it.id });
      it.checks = rs.filter((r) => !r.error).length;
      const errs = rs.filter((r) => r.error);
      if (!rs.length || errs.length === rs.length) { it.status = 'error'; it.error = errs.length ? errs.map((r) => r.error).join(' ') : 'No check was found in this file.'; }
      else it.status = 'done';
      done();
    };
    xhr.onerror = () => { it.status = 'error'; it.error = 'The upload did not reach the server. Check the connection and press Retry.'; done(); };
    xhr.send(fd);
  }

  function paintQueue() {
    const box = ROOT && ROOT.querySelector('#cr-queue'); if (!box) return;
    if (!Q.items.length) { box.innerHTML = ''; return; }
    const label = (it) => ({ queued: 'Waiting', uploading: `Uploading ${it.pct}%`, reading: 'Reading the check...', done: `${it.checks} check${it.checks === 1 ? '' : 's'} found`, error: 'Needs attention' })[it.status];
    box.innerHTML = `<div style="display:flex; justify-content:space-between; align-items:center;"><strong style="font-size:13px;">Files</strong>${Q.running ? '' : '<button id="cr-clear" style="font-size:11.5px; padding:3px 10px; border:1px solid #cbd5e1; border-radius:6px; background:#fff; cursor:pointer;">Clear this batch</button>'}</div>
      ${Q.items.map((it) => `<div style="display:grid; grid-template-columns:minmax(0,1fr) 170px 70px; gap:10px; align-items:center; padding:6px 0; border-bottom:1px solid #f1f5f9; font-size:12.5px;">
        <div><div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(it.file.name)} <span class="muted">${kb(it.file.size)}</span></div>
          ${it.error ? `<div style="color:#991b1b; font-size:12px;">${esc(it.error)}</div>` : ''}</div>
        <div><div style="font-size:11.5px; color:${it.status === 'error' ? '#991b1b' : it.status === 'done' ? '#166534' : '#334155'};">${label(it)}</div>
          ${['uploading', 'reading'].includes(it.status) ? `<div style="height:5px; background:#e2e8f0; border-radius:3px; margin-top:3px;"><div style="height:5px; border-radius:3px; background:#1e40af; width:${it.status === 'reading' ? 100 : it.pct}%; ${it.status === 'reading' ? 'opacity:.5;' : ''}"></div></div>` : ''}</div>
        <div>${it.status === 'error' && OK_TYPE(it.file) ? `<button data-retry="${it.id}" style="font-size:11.5px; padding:3px 10px; border:1px solid #1e40af; color:#1e40af; border-radius:6px; background:#fff; cursor:pointer;">Retry</button>` : ''}</div></div>`).join('')}`;
    box.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', () => { const it = Q.items.find((x) => x.id === Number(b.dataset.retry)); if (!it) return; it.status = 'queued'; it.error = null; status(`Retrying ${it.file.name}.`); paintQueue(); pump(); }));
    const clr = box.querySelector('#cr-clear'); if (clr) clr.addEventListener('click', () => { Q.items = []; Q.results = []; Q.batchId = null; paintQueue(); paintBatch(); status(''); });
  }

  function paintBatch() {
    const box = ROOT && ROOT.querySelector('#cr-batch'); if (!box) return;
    const rows = Q.results;
    if (!rows.length) { box.innerHTML = ''; return; }
    const conf = (c) => (c ? `<span class="muted" style="font-size:11px;">(${esc(c)} confidence)</span>` : '');
    box.innerHTML = `<strong style="font-size:13px;">This batch: review each check</strong>
      <table style="margin-top:4px;"><thead><tr><th>File / page</th><th>Check #</th><th class="num">Amount</th><th>Payer</th><th>Proposed account</th><th>Warnings</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map((r, i) => {
        const where = `${esc(r.file || '')}${r.page ? ` <span class="muted">p.${r.page}/${r.pages}</span>` : ''}`;
        if (r.error) return `<tr><td>${where}</td><td colspan="7" style="color:#991b1b;">${esc(r.error)}</td></tr>`;
        if (r.duplicate) return `<tr><td>${where}</td><td colspan="5" style="color:#92400e;">${esc(r.detail || 'Already in trustEd.')}</td><td>${r.status ? pill(r.status) : ''}</td><td>${r.receipt_id ? `<button data-rev="${r.receipt_id}">Review</button>` : ''}</td></tr>`;
        const warns = [r.exception_reason, ...(r.duplicate_findings || []).map((d) => d.detail)].filter(Boolean);
        const p = r.proposed;
        return `<tr><td>${where}</td><td>${esc(r.check_number || '?')}</td><td class="num">${fmt(r.amount_cents)}</td><td>${esc(r.payer_name || '')}</td>
          <td>${p ? `${esc(p.street_address || '')} ${conf(p.confidence)}${p.chosen ? '' : '<div class="muted" style="font-size:11px;">possible match only</div>'}` : '<span class="muted">none found</span>'}</td>
          <td style="max-width:280px; font-size:11.5px; color:${warns.length ? '#92400e' : '#64748b'};">${warns.length ? warns.map(esc).join('<br>') : 'None'}</td>
          <td>${pill(r.status)}</td>
          <td style="white-space:nowrap;"><button data-rev="${r.receipt_id}">Review</button>${r.status === 'matched' ? ` <button data-rec="${i}" style="background:#166534; color:#fff; border:none;">Record</button>` : ''}</td></tr>`;
      }).join('')}</tbody></table>`;
    box.querySelectorAll('button').forEach((b) => { b.style.cssText += 'font-size:11.5px; padding:3px 10px; border-radius:6px; cursor:pointer;' + (b.dataset.rec ? '' : ' border:1px solid #cbd5e1; background:#fff;'); });
    box.querySelectorAll('[data-rev]').forEach((b) => b.addEventListener('click', () => openReceipt(b.dataset.rev)));
    box.querySelectorAll('[data-rec]').forEach((b) => b.addEventListener('click', () => recordFromBatch(Number(b.dataset.rec))));
  }

  // Record from the batch list: the same confirmed, once-only action as the review window.
  async function recordFromBatch(i) {
    const r = Q.results[i]; if (!r || r.status !== 'matched') return;
    if (!confirm(`Record check #${r.check_number} for ${fmt(r.amount_cents)} to ${(r.proposed && r.proposed.street_address) || 'the proposed account'}?\n\nPosts Dr Undeposited Funds / Cr Accounts Receivable.`)) return;
    const send = (note) => api(`/api/check-receipts/${r.receipt_id}/record`, json({ override_note: note || null }));
    try {
      let j;
      try { j = await send(null); }
      catch (e) {
        if (!(e.body && e.body.error === 'possible_duplicate')) throw e;
        const why = prompt(`${e.message}\n\nIf this is a different payment, say why to record it anyway:`);
        if (!why) return;
        j = await send(why);
      }
      r.status = 'recorded'; r.exception_reason = null; paintBatch();
      status(`Recorded check #${r.check_number} (${j.journal_reference || 'already recorded'}).`);
      refreshList();
    } catch (e) { alert(e.message); }
  }

  // Refresh the checks list and deposit section without touching the upload state.
  let refreshTimer = null;
  function refreshList() { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if (!Q.running) render(CID, ROOT); }, 400); }

  async function openReceipt(id) {
    const m = ROOT.querySelector('#cr-modal');
    m.innerHTML = '<div class="card">Loading...</div>';
    let j; try { j = await api(`/api/check-receipts/${id}`); } catch (e) { m.innerHTML = `<div class="card" style="color:#991b1b;">${esc(e.message)}</div>`; return; }
    const r = j.receipt; const editable = ['scanned', 'matched', 'exception'].includes(r.status);
    const cands = r.match_candidates || [];
    const finds = j.duplicate_findings || [];
    const p = j.preview;
    const input = (k, v, type = 'text') => `<input data-k="${k}" type="${type}" value="${esc(v == null ? '' : v)}" ${editable ? '' : 'disabled'} style="width:100%; padding:5px 7px; border:1px solid #cbd5e1; border-radius:5px;">`;
    m.innerHTML = `<div style="position:fixed; inset:0; background:rgba(11,29,52,.45); z-index:50; overflow:auto; padding:30px 16px;" id="cr-ov">
      <div class="card" style="max-width:1100px; margin:0 auto;">
        <div style="display:flex; justify-content:space-between; align-items:center;"><h2 class="sec" style="margin:0;">Check #${esc(r.check_number || '?')} ${pill(r.status)}</h2><button id="cr-x" style="border:none; background:none; font-size:22px; cursor:pointer;">&times;</button></div>
        ${r.exception_reason ? `<div style="margin:8px 0; padding:8px 12px; background:#fffbeb; border:1px solid #fde68a; border-radius:7px; font-size:12.5px; color:#92400e;">${esc(r.exception_reason)}</div>` : ''}
        <div style="display:grid; grid-template-columns:minmax(0,1.2fr) minmax(0,1fr); gap:18px; margin-top:10px;">
          <div>${r.front_url ? `<a href="${esc(r.front_url)}" target="_blank" rel="noopener"><img src="${esc(r.front_url)}" style="width:100%; border:1px solid #e2e8f0; border-radius:6px;" alt="check front"></a>` : '<div class="muted">No front image.</div>'}
            ${r.back_url ? `<a href="${esc(r.back_url)}" target="_blank" rel="noopener"><img src="${esc(r.back_url)}" style="width:100%; border:1px solid #e2e8f0; border-radius:6px; margin-top:8px;" alt="check back"></a>` : `<div style="font-size:12px; margin-top:8px; padding:8px 10px; border:1px dashed #cbd5e1; border-radius:6px;"><span class="muted">No back attached. It is not needed to record the payment; add it when you have it (deposit records, a dispute, a returned check).</span><br><label style="display:inline-block; margin-top:6px; cursor:pointer; color:#1e40af; text-decoration:underline;">Attach the back<input type="file" id="cr-back-file" accept="image/*,application/pdf" style="display:none;"></label> <span id="cr-back-msg"></span></div>`}</div>
          <div style="font-size:12.5px;">
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
              <label>Check #${input('check_number', r.check_number)}</label>
              <label>Amount ($)${input('amount', r.amount_cents != null ? (r.amount_cents / 100).toFixed(2) : '')}</label>
              <label>Check date${input('check_date', r.check_date, 'date')}</label>
              <label>Received<input value="${esc(r.received_date)}" disabled style="width:100%; padding:5px 7px; border:1px solid #e2e8f0; border-radius:5px;"></label>
              <label>Payer${input('payer_name', r.payer_name)}</label>
              <label>Account # written${input('written_account_number', r.written_account_number)}</label>
              <label style="grid-column:1/3;">Memo${input('memo', r.memo)}</label>
            </div>
            <div class="muted" style="margin-top:6px;">Payee: ${esc(r.payee_name || '?')} &middot; Bank: routing ${esc(r.routing_number || '?')}, account ending ${esc(r.account_last4 || '?')}</div>
            <h3 style="font-size:13px; margin:12px 0 4px;">Owner account</h3>
            ${cands.length ? cands.map((c) => `<label style="display:block; padding:6px 8px; border:1px solid ${c.property_id === r.property_id ? '#1e40af' : '#e2e8f0'}; border-radius:6px; margin-bottom:5px;">
                <input type="radio" name="cr-prop" value="${c.property_id}" ${c.property_id === r.property_id ? 'checked' : ''} ${editable ? '' : 'disabled'}> <strong>${esc(c.street_address)}</strong> <span class="muted">${esc((c.owner_names || []).join(' & '))} &middot; balance ${fmt(c.balance_cents)} &middot; ${esc(c.confidence)} confidence</span>
                <div style="font-size:11.5px; color:#475569; margin-left:20px;">${(c.evidence || []).map((e) => `&bull; ${esc(e.detail)} <span class="muted">(${esc(e.strength)})</span>`).join('<br>') || 'No corroborating evidence.'}</div></label>`).join('') : '<div class="muted">No candidate accounts were found.</div>'}
            ${editable ? `<div style="margin-top:6px;">Other property (trusted account #)<input id="cr-other" placeholder="account number" style="width:160px; margin-left:6px; padding:4px 6px; border:1px solid #cbd5e1; border-radius:5px;"></div>
              <label style="display:block; margin-top:6px;">Reason / note (required when you choose an account the system did not propose, or to record past a possible duplicate)<input id="cr-note" value="${esc(r.override_note || '')}" style="width:100%; padding:5px 7px; border:1px solid #cbd5e1; border-radius:5px;"></label>` : ''}
            ${finds.length ? `<h3 style="font-size:13px; margin:12px 0 4px;">Duplicate checks</h3>${finds.map((f) => `<div style="color:${f.severity === 'blocking' ? '#991b1b' : '#92400e'};">&bull; ${esc(f.detail)}</div>`).join('')}` : ''}
            ${p && !p.error ? `<h3 style="font-size:13px; margin:12px 0 4px;">How it applies (Tex. Prop. Code 209.0063)</h3>
              <table style="font-size:12px;"><tbody>${(p.applications || []).map((a) => `<tr><td>${esc(a.date)}</td><td>${esc(a.description || a.category)}</td><td class="num">${fmt(a.applied_cents)}</td></tr>`).join('')}
              ${p.unapplied_cents ? `<tr><td colspan="2">Unapplied credit (prepayment)</td><td class="num">${fmt(p.unapplied_cents)}</td></tr>` : ''}</tbody></table>` : p && p.error ? `<div style="color:#991b1b;">${esc(p.error)}</div>` : ''}
            ${r.status === 'returned' ? `<div style="margin-top:10px; color:#991b1b;">Returned: ${esc(r.return_reason || '')}</div>` : ''}
            <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:14px;">
              ${editable ? '<button id="cr-save" style="padding:7px 14px; border:1px solid #0B1D34; border-radius:7px; background:#fff; font-weight:600; cursor:pointer;">Save &amp; confirm account</button>' : ''}
              ${r.status === 'matched' ? '<button id="cr-record" style="padding:7px 14px; border:none; border-radius:7px; background:#166534; color:#fff; font-weight:600; cursor:pointer;">Record payment</button>' : ''}
              ${editable ? '<button id="cr-void" style="padding:7px 14px; border:1px solid #cbd5e1; border-radius:7px; background:#fff; cursor:pointer;">Void scan</button>' : ''}
              ${['recorded', 'deposited', 'reconciled'].includes(r.status) ? '<button id="cr-return" style="padding:7px 14px; border:1px solid #991b1b; border-radius:7px; background:#fff; color:#991b1b; font-weight:600; cursor:pointer;">Returned check (admin)</button>' : ''}
            </div>
            <div id="cr-msg" style="margin-top:8px;"></div>
          </div></div></div></div>`;
    const close = () => { m.innerHTML = ''; };
    const backIn = m.querySelector('#cr-back-file');
    if (backIn) backIn.addEventListener('change', async () => {
      const f = backIn.files[0]; if (!f) return;
      const bm = m.querySelector('#cr-back-msg'); bm.textContent = 'Uploading...';
      const fd = new FormData(); fd.append('back', f, f.name);
      try { await api(`/api/check-receipts/${id}/back`, { method: 'POST', body: fd }); openReceipt(id); }
      catch (e) { bm.innerHTML = `<span style="color:#991b1b;">${esc(e.message)}</span>`; }
    });
    m.querySelector('#cr-x').addEventListener('click', close);
    const msg = (t, bad) => { m.querySelector('#cr-msg').innerHTML = `<span style="color:${bad ? '#991b1b' : '#166534'};">${esc(t)}</span>`; };
    const note = () => (m.querySelector('#cr-note') || {}).value || '';
    const fields = () => { const o = {}; m.querySelectorAll('[data-k]').forEach((el) => { if (el.dataset.k === 'amount') o.amount_cents = Math.round(Number(String(el.value).replace(/[$,]/g, '')) * 100); else o[el.dataset.k] = el.value; }); return o; };
    const save = m.querySelector('#cr-save');
    if (save) save.addEventListener('click', async () => {
      try {
        const sel = m.querySelector('input[name="cr-prop"]:checked');
        let property_id = sel ? sel.value : null;
        const other = (m.querySelector('#cr-other') || {}).value;
        if (other) {
          const pj = await api(`/api/gl/${CID}/owners/search?q=${encodeURIComponent(other.trim())}`);
          const want = other.trim();
          const hits = (pj.owners || []).filter((o) => [o.trusted_account_number, o.vantaca_account_id].map((v) => String(v || '')).includes(want));
          if (hits.length !== 1) return msg(hits.length ? 'That account number matches more than one property.' : 'No property with that account number in this association.', true);
          property_id = hits[0].property_id;
        }
        const j2 = await api(`/api/check-receipts/${id}/confirm`, json({ fields: fields(), property_id, note: note() }));
        msg(j2.receipt.status === 'matched' ? 'Saved. Review how it applies, then record the payment.' : `Held: ${j2.receipt.exception_reason}`, j2.receipt.status !== 'matched');
        setTimeout(() => openReceipt(id), 700);
      } catch (e) { msg(e.message, true); }
    });
    const rec = m.querySelector('#cr-record');
    if (rec) rec.addEventListener('click', async () => {
      if (!confirm(`Record check #${r.check_number} for ${fmt(r.amount_cents)} to this owner account?\n\nPosts Dr Undeposited Funds / Cr Accounts Receivable, dated ${r.received_date}.`)) return;
      try { const j2 = await api(`/api/check-receipts/${id}/record`, json({ override_note: note() || null })); msg(`Recorded (${j2.journal_reference || 'already recorded'}).`); setTimeout(() => { close(); render(CID, ROOT); }, 900); }
      catch (e) { msg(e.message, true); }
    });
    const vd = m.querySelector('#cr-void');
    if (vd) vd.addEventListener('click', async () => { const why = prompt('Why void this scan? (nothing was posted)'); if (!why) return; try { await api(`/api/check-receipts/${id}/void`, json({ reason: why })); close(); render(CID, ROOT); } catch (e) { msg(e.message, true); } });
    const rt = m.querySelector('#cr-return');
    if (rt) rt.addEventListener('click', async () => {
      const why = prompt('Return reason (for example NSF, stop payment, account closed):'); if (!why) return;
      const d = prompt('Date the bank returned it (YYYY-MM-DD):', today()); if (!d) return;
      try { const j2 = await api(`/api/check-receipts/${id}/return`, json({ reason: why, return_date: d })); msg(`Reversed (${j2.journal_reference}). ${j2.note}`); setTimeout(() => { close(); render(CID, ROOT); }, 1500); }
      catch (e) { msg(e.message, true); }
    });
  }

  async function deposit() {
    const ids = [...ROOT.querySelectorAll('.cr-dep:checked')].map((x) => x.value);
    const fd = new FormData();
    fd.append('community_id', CID); fd.append('receipt_ids', ids.join(','));
    fd.append('deposit_date', ROOT.querySelector('#cr-dep-date').value); fd.append('bank_reference', ROOT.querySelector('#cr-dep-ref').value.trim());
    const bt = ROOT.querySelector('#cr-dep-total-bank').value.trim(); if (bt) fd.append('bank_total_cents', String(Math.round(Number(bt.replace(/[$,]/g, '')) * 100)));
    const f = ROOT.querySelector('#cr-dep-file').files[0]; if (f) fd.append('evidence', f);
    if (!confirm(`Record a deposit of ${ids.length} check(s)?\n\nPosts Dr Operating Cash / Cr Undeposited Funds.`)) return;
    try { const j = await api('/api/check-receipts/deposits', { method: 'POST', body: fd }); alert(`Deposit recorded (${j.journal_reference}).`); render(CID, ROOT); }
    catch (e) { alert(e.message); }
  }

  async function reconcile(depId) {
    try {
      const j = await api(`/api/check-receipts/deposits/${depId}/bank-lines`);
      const c = j.candidates || [];
      if (!c.length) return alert('No imported bank line matches this deposit yet (same amount, within a week of the deposit date). Import the bank statement in Bank Rec, then try again.');
      const pick = c.length === 1 ? c[0] : null;
      const choice = pick ? (confirm(`Match to the bank line ${pick.posting_date} ${fmt(pick.amount_cents)} "${pick.description || ''}"?`) ? pick : null)
        : c[Number(prompt(c.map((x, i) => `${i + 1}: ${x.posting_date} ${fmt(x.amount_cents)} ${x.description || ''}`).join('\n') + '\n\nWhich line? (number)')) - 1];
      if (!choice) return;
      await api(`/api/check-receipts/deposits/${depId}/reconcile`, json({ bank_transaction_id: choice.id }));
      render(CID, ROOT);
    } catch (e) { alert(e.message); }
  }

  window.renderCheckReceipts = render;
})();
