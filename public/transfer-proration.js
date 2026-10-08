// public/transfer-proration.js  (Ed 2026-10-08, GitHub issue #94)
// The assessment proration a builder-to-homeowner transfer posts, shown to
// staff BEFORE anything is written (Home Sales "Record closing" and Ownership
// Review "Approve" share this). The numbers come from the server's plan
// (transfer_proration_plan, migration 500); nothing is calculated here.
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => (Number(c) < 0 ? '-' : '') + '$' + (Math.abs(Number(c || 0)) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const day = (d) => { if (!d) return ''; const t = new Date(String(d).slice(0, 10) + 'T00:00:00'); return isNaN(t) ? d : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
  const pct = (p) => String(Number(p));
  const row = (k, v, strong) => '<tr><td style="padding:3px 12px 3px 0; color:#5b6472; vertical-align:top;">' + k + '</td><td style="padding:3px 0; text-align:right; vertical-align:top; overflow-wrap:anywhere;' + (strong ? ' font-weight:700;' : '') + '">' + v + '</td></tr>';
  const box = (inner, tone) => '<div style="margin:10px 0; padding:12px 14px; border-radius:8px; border:1px solid ' + (tone === 'warn' ? '#e8b86d; background:#fff8ec' : '#d8d2c2; background:#fff') + ';">' + inner + '</div>';

  // The calculation table. plan = transfer_proration_plan output.
  function breakdown(p) {
    const prior = Number(p.builder_prior_billed_cents || 0);
    const adj = Number(p.builder_adjustment_cents || 0);
    return '<table style="border-collapse:collapse; font-size:13.5px; width:100%;">'
      + row('Annual assessment', money(p.annual_assessment_cents))
      + row('Builder rate (' + esc(p.builder) + ')', pct(p.builder_rate_pct) + '%')
      + row('Homeowner rate', '100%')
      + row('Transfer date', day(p.settlement_date))
      + row('Builder days', esc(p.builder_days) + ' of ' + esc(p.days_in_year) + ' (' + day(p.builder_period_start) + ' to ' + day(p.builder_period_end) + ')')
      + row('Homeowner days', esc(p.homeowner_days) + ' of ' + esc(p.days_in_year) + ' (' + day(p.homeowner_period_start) + ' to ' + day(p.homeowner_period_end) + ')')
      + row('Builder prorated amount', money(p.builder_due_cents), true)
      + row('Homeowner prorated amount', money(p.homeowner_due_cents), true)
      + (prior ? row('Already billed to the builder this year', money(prior)) : '')
      + row(adj >= 0 ? 'Builder charge to post' : 'Builder credit to post', money(adj))
      + row('Charge to the new owner', money(p.homeowner_due_cents))
      + '</table>'
      + '<div style="font-size:12px; color:#5b6472; margin-top:6px;">' + books(p) + '</div>';
  }

  // The GL the posting makes, on the community's own revenue treatment.
  function books(p) {
    const inc = p.income_account || '4000', dfr = p.deferral_account, adj = Number(p.builder_adjustment_cents || 0), rec = p.homeowner_recognition;
    if (p.deferral_adjustment) {
      const d = p.deferral_adjustment;
      return 'Required when resolved: Dr ' + d.income_account + ' ' + money(d.income_reversal_cents) + ', Dr ' + d.deferral_account + ' ' + money(d.deferral_reversal_cents)
        + ', Cr 1300 AR ' + money(d.ar_credit_cents) + '; the ' + d.deferral_account + ' schedule reduced ' + money(d.schedule_reduction_monthly_cents) + '/month for '
        + d.schedule_reduction_months + ' months from ' + day(d.schedule_reduction_from) + '.';
    }
    return 'Books, dated ' + day(p.settlement_date) + ': '
      + (adj > 0 ? 'Dr 1300 AR / Cr ' + inc + ' ' + money(adj) + ' (builder, its months have elapsed); ' : adj < 0 ? 'Dr ' + inc + ' / Cr 1300 AR ' + money(-adj) + ' (builder); ' : '')
      + (dfr ? 'Dr 1300 AR / Cr ' + dfr + ' Unearned ' + money(p.homeowner_due_cents) + ' (new owner), released to ' + inc + ' ' + money(rec && rec.monthly_cents) + '/month for ' + (rec && rec.term_months) + ' months from ' + day(rec && rec.start_month) + '.'
             : 'Dr 1300 AR / Cr ' + inc + ' ' + money(p.homeowner_due_cents) + ' (new owner).');
  }

  // The staged-proration queue. items = GET /api/assessment-proration/transfer/queue.
  const BADGE = { 'Staged': 'background:#fff3dc; color:#8a5a00;', 'Ready to Post': 'background:#e3f4e6; color:#1d6b2f;', 'Blocked': 'background:#fde7e7; color:#a12828;' };
  function queueHtml(items) {
    if (!items || !items.length) return '';
    const rows = items.map((it) => {
      const why = (it.reasons || []).map(esc).join('; ');
      const detail = it.status === 'Blocked'
        ? '<div style="font-size:12px; color:#5b6472; margin-top:3px;">' + why
          + ((it.builder_prior_rows || []).length ? '<br>Builder activity this year: ' + it.builder_prior_rows.map((x) => day(x.date) + ' ' + esc(x.description) + ' ' + money(x.amount_cents)).join('; ') : '')
          + (it.deferral_adjustment ? '<br>' + esc(books({ deferral_adjustment: it.deferral_adjustment })) : '') + '</div>'
        : (why ? '<div style="font-size:12px; color:#5b6472; margin-top:3px;">' + why + '</div>' : '');
      const action = it.status === 'Ready to Post' ? '<button class="btn" style="padding:4px 10px; font-size:12.5px;" data-tpq="' + esc(it.proposal_id) + '">Review &amp; post</button>' : '';
      return '<tr><td>' + esc(it.property || '') + '</td><td>' + esc(it.outgoing_owner || it.builder || '') + ' <span class="muted">→</span> ' + esc(it.incoming_owner || '') + '</td>'
        + '<td>' + day(it.settlement_date) + '</td><td class="num">' + money(it.builder_due_cents) + (Number(it.builder_prior_billed_cents) ? '<div style="font-size:11.5px; color:#5b6472;">net of ' + money(it.builder_prior_billed_cents) + ' billed</div>' : '') + '</td>'
        + '<td class="num">' + money(it.homeowner_due_cents) + '</td>'
        + '<td><span class="badge" style="' + (BADGE[it.status] || '') + '">' + esc(it.status) + '</span>' + detail + '</td><td>' + action + '</td></tr>'
        + '<tr data-tpq-row="' + esc(it.proposal_id) + '" style="display:none;"><td colspan="7"></td></tr>';
    }).join('');
    return '<div class="card"><h2 class="sec">Builder transfer prorations</h2>'
      + '<div class="muted" style="margin-bottom:10px; font-size:12.5px;">Assessment prorations recorded at a builder-to-homeowner closing and not yet posted. Recalculated each time this list loads. Nothing posts until you review and confirm it.</div>'
      + '<div style="overflow-x:auto;"><table style="min-width:640px;"><thead><tr><th>Property</th><th>Outgoing → Incoming owner</th><th>Settlement</th><th class="num">Builder prorated</th><th class="num">Homeowner prorated</th><th>Status</th><th></th></tr></thead><tbody>'
      + rows + '</tbody></table></div></div>';
  }

  // Wire the queue's "Review & post" buttons inside container el. onDone reloads.
  function wireQueue(el, onDone) {
    el.querySelectorAll('[data-tpq]').forEach((b) => b.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = b.getAttribute('data-tpq');
      const row = el.querySelector('[data-tpq-row="' + id + '"]'); const cell = row.firstChild;
      row.style.display = ''; cell.innerHTML = '<span class="muted">Recalculating…</span>';
      const post = async (confirmed) => {
        const r = await fetch('/api/assessment-proration/transfer/' + encodeURIComponent(id) + '/post', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: confirmed === true }) });
        const j = await r.json();
        if (r.status === 409 && j.proration) {
          cell.innerHTML = '';
          cell.appendChild(confirmPanel(j, { confirmLabel: 'Confirm and post', onConfirm: () => { cell.innerHTML = '<span class="muted">Posting…</span>'; post(true); }, onAck: () => {} }));
          return;
        }
        if (!r.ok || j.error) { cell.innerHTML = '<span class="badge err">' + esc(j.error || ('HTTP ' + r.status)) + '</span>'; return; }
        cell.innerHTML = resultHtml(j.proration, null);
        if (onDone) setTimeout(onDone, 1500);
      };
      post(false);
    }));
  }

  // The panel shown when the server asks for confirmation (409).
  // onConfirm / onAck are called when staff choose to proceed.
  function confirmPanel(body, { onConfirm, onAck, confirmLabel }) {
    const p = body.proration || {};
    const wrap = document.createElement('div');
    if (body.code === 'proration_blocked') {
      const rows = (p.builder_prior_rows || []).map((x) => '<li>' + day(x.date) + ' ' + esc(x.description) + ' ' + money(x.amount_cents) + '</li>').join('');
      wrap.innerHTML = box('<b>Assessment proration needs a person</b> (' + esc(p.builder || 'builder') + ' to new owner)'
        + '<div style="margin:6px 0;">' + esc((p.blocked_text || []).join('; ')) + '.</div>'
        + (rows ? '<div>The builder\'s assessment activity this year:</div><ul style="margin:4px 0 8px 18px;">' + rows + '</ul>' : '')
        + '<div style="font-size:12.5px;">Nothing is guessed. You can record the ownership change now; the proration stays open until the ledger is clear, then post it from the sale.</div>'
        + '<button class="btn" data-tp="ack" style="margin-top:8px;">Record the transfer, leave the proration open</button>', 'warn');
      wrap.querySelector('[data-tp="ack"]').addEventListener('click', (e) => { e.preventDefault(); onAck(); });
    } else {
      const notReady = p.posting_ready === false;
      wrap.innerHTML = box('<b>Assessment proration</b> (' + esc(p.builder || 'builder') + ' to ' + esc(p.buyer_name || 'new owner') + ')'
        + '<div style="margin:8px 0;">' + breakdown(p) + '</div>'
        + (notReady ? '<div style="margin:6px 0; padding:8px 10px; border-radius:6px; background:#fff8ec; border:1px solid #e8b86d; font-size:12.5px;"><b>Will be staged, not posted.</b> This community\'s accounting conversion is not posted yet, so the year\'s billing is not in trustEd\'s books. Recording the closing saves this calculation with the transfer; no charge, credit or GL entry is made. After the conversion posts, it is recomputed against the converted ledger and shown again before it posts.</div>' : '')
        + '<button class="btn" data-tp="ok" style="margin-top:4px;">' + (confirmLabel || (notReady ? 'Confirm, record, and stage the proration' : 'Confirm and record')) + '</button>');
      wrap.querySelector('[data-tp="ok"]').addEventListener('click', (e) => { e.preventDefault(); onConfirm(); });
    }
    return wrap;
  }

  // After the transfer: what happened to the proration.
  function resultHtml(r, retryJs) {
    if (!r) return '';
    if (r.status === 'posted' || r.status === 'already_posted' || r.status === 'completed_retry') {
      return '<span class="badge ok">Assessment proration posted</span> builder ' + money(r.builder_adjustment_cents) + ', new owner ' + money(r.homeowner_due_cents) + (r.journal_reference ? ' · GL ' + esc(r.journal_reference) : '') + (r.recognition_schedule_id ? ' · released monthly by its recognition schedule' : '') + '.';
    }
    if (r.status === 'staged') return '<span class="badge" style="background:#fff3dc; color:#8a5a00;">Assessment proration staged</span> builder ' + money(r.builder_adjustment_cents) + ', new owner ' + money(r.homeowner_due_cents) + '. Nothing posted: it posts after the accounting conversion, with a fresh confirmation.';
    if (r.status === 'blocked') return '<span class="badge err">Assessment proration not posted</span> ' + esc((r.blocked_text || r.blocked_reasons || []).join('; ')) + '. Resolve the ledger, then post it.' + (retryJs ? ' <a class="link" onclick="' + retryJs + '">Post proration</a>' : '');
    if (r.status === 'pending') return '<span class="badge err">Assessment proration NOT posted yet</span> ' + esc(r.error || '') + (retryJs ? ' <a class="link" onclick="' + retryJs + '">Retry</a>' : '');
    return '';
  }

  window.TransferProration = { breakdown, books, confirmPanel, resultHtml, money, queueHtml, wireQueue };
})();
