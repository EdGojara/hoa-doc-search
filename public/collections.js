// ============================================================================
// public/collections.js  (Ed 2026-10-12)
// Accounting -> Homeowners -> Collections. The association-wide collections queue:
// eligible accounts (with every restriction shown), Amanda's prepared batches, Kat's
// verification, staff approval, the print file, and recording USPS certified mailings.
// API: /api/collections (lib/collections/notices.js).
// ============================================================================
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (c) => { if (c == null) return ''; const n = Number(c); const t = '$' + (Math.abs(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return n < 0 ? `(${t})` : t; };
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const api = async (url, opts) => { const r = await fetch(url, opts); const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.message || j.error || `HTTP ${r.status}`), { body: j }); return j; };
  const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const BS = { prepared: ['#475569', '#f1f5f9', 'Prepared'], verified: ['#1e40af', '#dbeafe', 'Verified by Kat: ready to approve'], verification_failed: ['#991b1b', '#fee2e2', 'Verification failed'], approved: ['#166534', '#dcfce7', 'Approved: print'], printed: ['#0f766e', '#ccfbf1', 'Printed: record mailing'], mailed: ['#14532d', '#bbf7d0', 'Mailed'], cancelled: ['#64748b', '#f1f5f9', 'Cancelled'] };
  const pill = (s) => { const v = BS[s] || [ '#475569', '#f1f5f9', s ]; return `<span style="font-size:10.5px; font-weight:700; padding:2px 8px; border-radius:9px; color:${v[0]}; background:${v[1]}; white-space:nowrap;">${esc(v[2])}</span>`; };
  let CID = null; let ROOT = null;

  async function render(cid, root) {
    CID = cid; ROOT = root;
    root.innerHTML = '<div class="muted" style="padding:24px;">Loading collections...</div>';
    let el, bs;
    try { [el, bs] = await Promise.all([api(`/api/collections/eligible?community_id=${CID}`), api(`/api/collections/batches?community_id=${CID}`)]); }
    catch (e) { root.innerHTML = `<div class="card" style="padding:20px;">${e.body && e.body.error === 'migration_515_required' ? 'Collections notices need <strong>migration 515</strong> (Documents &rarr; Migration status). Nothing has been prepared or mailed.' : 'Could not load collections: ' + esc(e.message)}</div>`; return; }
    if (el.community_blocked) { root.innerHTML = `<div class="card" style="padding:20px;">${esc(el.community_blocked)}</div>`; return; }
    const cfg = el.config || {}; const t = cfg.template || {}; const fee = cfg.fee || {};
    const accts = el.accounts || [];
    const eligible = accts.filter((a) => a.eligible);
    root.innerHTML = `
      <div class="card" style="margin-bottom:14px;">
        <h2 class="sec" style="margin:0 0 8px;">Collections: certified delinquency notices</h2>
        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; font-size:12.5px;">
          <div style="padding:10px 12px; border:1px solid #e2e8f0; border-radius:8px;"><strong>Template</strong> v${esc(t.version)}: ${t.status === 'approved' ? '<span style="color:#166534; font-weight:700;">approved for mailing</span>' : '<span style="color:#92400e; font-weight:700;">not yet approved</span>'}
            <div class="muted">${esc(t.source_note || '')}</div>
            ${(t.counsel_questions || []).length ? `<details style="margin-top:4px;"><summary>${t.counsel_questions.length} question(s) for counsel</summary><ol style="margin:6px 0 0 16px; padding:0;">${t.counsel_questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ol></details>` : ''}
            ${t.status !== 'approved' ? `<button id="cl-tpl" data-id="${esc(t.id)}" style="margin-top:6px; padding:5px 12px; border:1px solid #0B1D34; border-radius:6px; background:#fff; cursor:pointer;">Approve wording (owner)</button>` : ''}</div>
          <div style="padding:10px 12px; border:1px solid #e2e8f0; border-radius:8px;"><strong>Policy</strong>: certified notice when the oldest assessment is ${esc(cfg.trigger_days)} days past due (after a ${esc(cfg.grace_days)}-day grace period). Cure period on the letter: ${esc(t.cure_days)} days from the notice date.</div>
          <div style="padding:10px 12px; border:1px solid #e2e8f0; border-radius:8px;"><strong>Certified-letter fees</strong><br>
            Charged to the homeowner on mailing: <strong>${fee.charges_homeowner ? fmt(fee.homeowner_fee_cents) : 'none'}</strong>${fee.charges_homeowner ? '' : `<div class="muted">${esc((fee.why_not || []).join('; '))}</div>`}
            Bedrock's management-agreement rate (billed to the association): <strong>${fee.bedrock_fee_cents != null ? fmt(fee.bedrock_fee_cents) : 'not in the contract'}</strong>${fee.differs ? '<div style="color:#92400e;">The two amounts differ.</div>' : ''}
            <div style="margin-top:6px;"><input id="cl-fee" style="width:80px;" placeholder="$"> <label><input type="checkbox" id="cl-auto"> charge on mailing</label> <button id="cl-fee-save" style="padding:3px 10px; border:1px solid #cbd5e1; border-radius:6px; background:#fff; cursor:pointer;">Save (owner)</button></div></div>
        </div>
      </div>
      <div class="card" style="margin-bottom:14px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;"><h2 class="sec" style="margin:0;">Accounts (${eligible.length} eligible of ${accts.length} with a balance)</h2>
          <div style="font-size:12px;">Notice date (= mailing date) <input type="date" id="cl-date" value="${today()}"> <button id="cl-prep" style="padding:7px 14px; border:none; border-radius:7px; background:#0B1D34; color:#fff; font-weight:600; cursor:pointer;">Prepare notices for selected</button></div></div>
        <table style="margin-top:8px;"><thead><tr><th></th><th>Property</th><th>Owner</th><th class="num">Balance</th><th class="num">Days past due</th><th>Status</th></tr></thead><tbody>
        ${accts.map((a) => `<tr><td>${a.eligible ? `<input type="checkbox" class="cl-pick" value="${a.property_id}" checked>` : ''}</td><td>${esc(a.street_address || '')}</td><td>${esc(a.owner_name || '')}</td><td class="num">${fmt(a.balance_cents)}</td><td class="num">${a.oldest_assessment_due ? a.days_past_due : ''}</td><td>${a.eligible ? '<span style="color:#166534; font-weight:600;">Eligible</span>' : `<span class="muted" style="font-size:11.5px;">${esc(a.holds.join('; '))}</span>`}</td></tr>`).join('') || '<tr><td colspan="6" class="muted" style="text-align:center; padding:14px;">No balances due.</td></tr>'}
        </tbody></table>
        <div id="cl-prep-out" style="margin-top:8px; font-size:12.5px;"></div>
      </div>
      <div class="card"><h2 class="sec" style="margin:0 0 8px;">Batches</h2>
        <table><thead><tr><th>Notice date</th><th>Status</th><th class="num">Notices</th><th class="num">Mailed</th><th class="num">Total due</th><th>Prepared</th><th></th></tr></thead><tbody>
        ${(bs.batches || []).map((b) => `<tr><td>${esc(b.notice_date)}</td><td>${pill(b.status)}</td><td class="num">${b.notices}</td><td class="num">${b.mailed}</td><td class="num">${fmt(b.total_due_cents)}</td><td class="muted" style="font-size:11.5px;">${esc(b.prepared_by)}</td><td><button data-b="${b.id}" style="padding:4px 10px; border:1px solid #cbd5e1; border-radius:6px; background:#fff; cursor:pointer;">Open</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted" style="text-align:center; padding:14px;">No batches yet.</td></tr>'}
        </tbody></table><div id="cl-batch" style="margin-top:12px;"></div></div>`;
    root.querySelector('#cl-prep').addEventListener('click', prepare);
    root.querySelectorAll('[data-b]').forEach((x) => x.addEventListener('click', () => openBatch(x.dataset.b)));
    const tb = root.querySelector('#cl-tpl'); if (tb) tb.addEventListener('click', async () => { if (!confirm('Approve this wording for mailing? It is the association\'s current letter; the counsel questions stay attached.')) return; try { await post(`/api/collections/templates/${tb.dataset.id}/approve`); render(CID, ROOT); } catch (e) { alert(e.message); } });
    root.querySelector('#cl-fee-save').addEventListener('click', async () => { const v = root.querySelector('#cl-fee').value.trim(); if (!v) return alert('Enter the fee in dollars.'); try { await api('/api/collections/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ community_id: CID, fee_cents: Math.round(Number(v.replace(/[$,]/g, '')) * 100), autopost: root.querySelector('#cl-auto').checked }) }); render(CID, ROOT); } catch (e) { alert(e.message); } });
  }

  async function prepare() {
    const out = ROOT.querySelector('#cl-prep-out');
    const ids = [...ROOT.querySelectorAll('.cl-pick:checked')].map((x) => x.value);
    if (!ids.length) { out.textContent = 'Select at least one eligible account.'; return; }
    out.textContent = `Preparing ${ids.length} notice(s) and verifying...`;
    try {
      const j = await post('/api/collections/batches', { community_id: CID, notice_date: ROOT.querySelector('#cl-date').value, property_ids: ids });
      out.innerHTML = j.batch ? `Prepared ${j.notices.length} notice(s). Kat's verification: ${j.verification.ok ? '<strong style="color:#166534;">passed</strong>' : `<strong style="color:#991b1b;">${j.verification.failed} failed</strong>`}.` : esc(j.message || 'Nothing prepared.');
      setTimeout(() => render(CID, ROOT).then(() => j.batch && openBatch(j.batch.id)), 600);
    } catch (e) { out.innerHTML = `<span style="color:#991b1b;">${esc(e.message)}</span>`; }
  }

  async function openBatch(id) {
    const box = ROOT.querySelector('#cl-batch');
    box.innerHTML = '<div class="muted">Loading batch...</div>';
    let j; try { j = await api(`/api/collections/batches/${id}`); } catch (e) { box.innerHTML = `<span style="color:#991b1b;">${esc(e.message)}</span>`; return; }
    const b = j.batch; const v = b.verification || {};
    const R = Object.fromEntries((v.results || []).map((r) => [r.notice_id, r]));
    box.innerHTML = `<div style="border:1px solid #cbd5e1; border-radius:10px; padding:12px;">
      <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; align-items:center;"><div><strong>Batch of ${esc(b.notice_date)}</strong> ${pill(b.status)} <span class="muted" style="font-size:11.5px;">prepared by ${esc(b.prepared_by)}${b.verified_at ? `; verified by ${esc(b.verified_by)} ${esc(String(b.verified_at).slice(0, 16).replace('T', ' '))}` : ''}${b.approved_by ? `; approved by ${esc(b.approved_by)}` : ''}</span></div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          ${['prepared', 'verified', 'verification_failed'].includes(b.status) ? '<button data-act="verify">Re-verify (Kat)</button>' : ''}
          ${b.status === 'verified' ? '<button data-act="approve" style="background:#166534; color:#fff; border:none;">Approve for printing</button>' : ''}
          ${b.batch_pdf_url ? `<a href="${esc(b.batch_pdf_url)}" target="_blank" rel="noopener" style="padding:5px 12px; border:1px solid #0B1D34; border-radius:6px; text-decoration:none;">Open print file</a>` : ''}
          ${b.status === 'approved' ? '<button data-act="printed">Mark printed</button>' : ''}
          ${['prepared', 'verified', 'verification_failed', 'approved', 'printed'].includes(b.status) ? '<button data-act="redate">Re-date</button><button data-act="cancel">Cancel batch</button>' : ''}
        </div></div>
      ${v.results ? `<div style="margin:8px 0; font-size:12.5px;">Kat's check: ${v.ok ? '<strong style="color:#166534;">every notice ties to the ledger, the fee setting and its dates</strong>' : `<strong style="color:#991b1b;">${v.failed} of ${v.notices} notice(s) failed</strong>`}.</div>` : ''}
      <table style="font-size:12.5px;"><thead><tr><th>Owner / property</th><th class="num">Ledger</th><th class="num">Fee</th><th class="num">Amount due</th><th>Deadline</th><th>Notice</th><th>Mailing</th></tr></thead><tbody>
      ${j.notices.map((n) => { const r = R[n.id]; return `<tr><td>${esc(n.owner_name || '')}<div class="muted" style="font-size:11px;">${esc((n.mailing_address || {}).street || '')} &middot; acct ${esc(n.account_number || '')}</div>${r && !r.ok ? `<div style="color:#991b1b; font-size:11px;">${r.errors.map(esc).join('<br>')}</div>` : ''}</td>
        <td class="num">${fmt(n.ledger_balance_cents)}</td><td class="num">${n.fee_cents ? fmt(n.fee_cents) : ''}</td><td class="num"><strong>${fmt(n.amount_due_cents)}</strong></td><td>${esc(n.deadline_date)}</td>
        <td>${n.status === 'cancelled' ? `<span class="muted">cancelled</span>` : `<a href="${n.pdf_url ? esc(n.pdf_url) : `/api/collections/notices/${n.id}/preview`}" target="_blank" rel="noopener">${n.pdf_url ? 'Issued PDF' : 'Preview'}</a>`}</td>
        <td>${n.status === 'mailed' ? `USPS ${esc(n.certified_tracking_number)}<br><span class="muted">${esc(n.mailed_date)}${n.regular_mail_confirmed ? ' + regular mail' : ''}</span>` : n.status === 'printed' ? `<input class="cl-trk" data-n="${n.id}" placeholder="USPS certified #" style="width:170px;"> <label style="font-size:11px;"><input type="checkbox" class="cl-reg" data-n="${n.id}"> regular copy mailed</label> <button class="cl-mail" data-n="${n.id}">Record</button>` : ['draft', 'approved'].includes(n.status) ? `<button class="cl-cancel" data-n="${n.id}">Cancel</button>` : ''}</td></tr>`; }).join('')}
      </tbody></table>
      <div class="muted" style="font-size:11.5px; margin-top:8px;">Mailing must happen on the notice date (${esc(b.notice_date)}): the letter, its ${esc((j.notices[0] || {}).deadline_date ? '' : '')}deadline and the statement are all dated from it. If the batch goes out on another day, use Re-date to rebuild it. The homeowner fee (if any) posts only when a mailing is recorded, once per notice.</div>
      <div id="cl-bmsg" style="margin-top:6px;"></div></div>`;
    const msg = (t, bad) => { box.querySelector('#cl-bmsg').innerHTML = `<span style="color:${bad ? '#991b1b' : '#166534'};">${esc(t)}</span>`; };
    box.querySelectorAll('button[data-act]').forEach((x) => { x.style.cssText += 'padding:5px 12px; border-radius:6px; cursor:pointer;'; x.addEventListener('click', async () => {
      const act = x.dataset.act;
      try {
        if (act === 'verify') await post(`/api/collections/batches/${id}/verify`);
        if (act === 'approve') { if (!confirm(`Approve ${j.notices.filter((n) => n.status === 'draft').length} notice(s) for printing? Kat re-checks every notice first; the issued PDFs are then fixed.`)) return; msg('Approving and rendering the issued PDFs...'); await post(`/api/collections/batches/${id}/approve`); }
        if (act === 'printed') await post(`/api/collections/batches/${id}/printed`);
        if (act === 'redate') { const d = prompt('New notice date (the day it will be mailed), YYYY-MM-DD:', today()); if (!d) return; const r = await post(`/api/collections/batches/${id}/redate`, { notice_date: d }); await render(CID, ROOT); if (r.batch) openBatch(r.batch.id); return; }
        if (act === 'cancel') { const why = prompt('Why cancel this batch? (nothing has been mailed or charged)'); if (!why) return; await post(`/api/collections/batches/${id}/cancel`, { reason: why }); }
        await render(CID, ROOT); openBatch(id);
      } catch (e) { msg(e.message, true); }
    }); });
    box.querySelectorAll('.cl-mail').forEach((x) => x.addEventListener('click', async () => {
      const nid = x.dataset.n; const trk = box.querySelector(`.cl-trk[data-n="${nid}"]`).value; const reg = box.querySelector(`.cl-reg[data-n="${nid}"]`).checked;
      const d = prompt('Date mailed (must be the notice date), YYYY-MM-DD:', b.notice_date); if (!d) return;
      try { const r = await post(`/api/collections/notices/${nid}/mail`, { tracking_number: trk, mailed_date: d, regular_mail_confirmed: reg }); msg(`Mailing recorded. Fee: ${r.fee ? r.fee.status : 'n/a'}${r.fee && r.fee.journal_reference ? ` (${r.fee.journal_reference})` : ''}. Bedrock billing: ${r.billing ? r.billing.status : 'n/a'}.`); setTimeout(() => openBatch(id), 900); }
      catch (e) { msg(e.message, true); }
    }));
    box.querySelectorAll('.cl-cancel').forEach((x) => x.addEventListener('click', async () => { const why = prompt('Why cancel this notice?'); if (!why) return; try { await post(`/api/collections/notices/${x.dataset.n}/cancel`, { reason: why }); openBatch(id); } catch (e) { msg(e.message, true); } }));
  }

  window.renderCollections = render;
})();
