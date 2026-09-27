// public/trusted-pay-review.js  (Ed 2026-09-27)
// Trusted Pay review step for the homeowner portal pages (portal.html,
// portal-balance.html). One modal, one flow:
//   1. POST /api/portal/pay/quote  -> exact Assessment/Payment Amount, Payment
//      Processing Fee and Total Payment per method, from the SERVER.
//   2. The homeowner picks a method, reviews the three lines, and ticks an
//      UNCHECKED box that links the Trusted Pay Payment Terms and Conditions.
//      "Continue" stays disabled until the box is ticked.
//   3. POST /api/portal/pay/checkout with that method's signed quote token and
//      accept_terms: true. The server re-checks everything and records the
//      acceptance before Stripe is contacted.
// The browser never computes a fee and never sends an amount.
(function () {
  const usd = (c) => '$' + (Number(c) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const LABEL = { us_bank_account: 'Bank transfer (ACH)', card: 'Credit or debit card' };
  const FRIENDLY = {
    nothing_due: 'Your balance is $0. There is nothing to pay online.',
    community_stripe_not_onboarded: 'Online payment is not available yet for your community. Please mail a check.',
    payment_not_configured: 'Online payment is not available yet. Please mail a check.',
    test_mode_sandbox_only: 'Online payment is not available yet for your community. Please mail a check.',
    community_not_taking_payments: 'Online payment is not available for your community.',
    terms_not_accepted: 'Please tick the box to accept the payment terms.',
  };

  async function open({ propertyId, asOfLabel } = {}) {
    const old = document.getElementById('_tpModal'); if (old) old.remove();
    const modal = document.createElement('div');
    modal.id = '_tpModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(11,29,52,0.55);z-index:3000;display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.innerHTML = '<div style="background:#fff;border-radius:14px;max-width:460px;width:100%;padding:24px;box-shadow:0 16px 50px rgba(0,0,0,0.3);font-size:14px;color:#0B1D34;"><div id="_tpBody">Loading your payment details…</div></div>';
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    const body = modal.querySelector('#_tpBody');

    let q;
    try {
      const r = await fetch('/api/portal/pay/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ property_id: propertyId || null }) });
      q = await r.json().catch(() => ({}));
      if (!r.ok || !q.ok) throw new Error(FRIENDLY[q.error] || q.hint || 'We could not load your payment details. Please try again.');
    } catch (e) {
      body.innerHTML = `<p style="margin:0 0 14px;">${esc(e.message)}</p><div style="text-align:right;"><button id="_tpClose" style="padding:9px 16px;border:1px solid #cbd5e1;background:#fff;border-radius:8px;cursor:pointer;font-weight:600;">Close</button></div>`;
      body.querySelector('#_tpClose').onclick = close;
      return;
    }

    const options = q.options || [];
    body.innerHTML = `
      <h3 style="margin:0 0 4px;font-size:19px;">Review your payment</h3>
      <p style="margin:0 0 12px;color:#475569;font-size:13px;">${esc(q.property_label || '')}${asOfLabel ? ' &middot; ' + esc(asOfLabel) : ''}</p>
      ${options.map((o, i) => `
        <label style="display:block;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;margin-bottom:10px;cursor:pointer;">
          <input type="radio" name="_tpMethod" value="${i}" ${i === 0 ? 'checked' : ''}> <b>${LABEL[o.method] || esc(o.method)}</b>
          <table style="width:100%;margin-top:6px;font-size:13.5px;color:#334155;border-collapse:collapse;">
            <tr><td>Assessment/Payment Amount</td><td style="text-align:right;">${usd(o.amount_cents)}</td></tr>
            <tr><td>${esc(o.fee_label || 'Payment Processing Fee')}</td><td style="text-align:right;">${usd(o.payment_processing_fee_cents)}</td></tr>
            <tr><td><b>Total Payment</b></td><td style="text-align:right;"><b>${usd(o.total_cents)}</b></td></tr>
          </table>
        </label>`).join('')}
      <label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;color:#1e293b;margin:12px 0 14px;">
        <input type="checkbox" id="_tpAccept" style="margin-top:3px;">
        <span>I have reviewed the payment amount, Payment Processing Fee, and <a href="${esc((q.terms && q.terms.url) || '/pay/terms')}" target="_blank" rel="noopener">Trusted Pay Payment Terms and Conditions</a>, and I authorize this payment.</span>
      </label>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="_tpCancel" style="padding:9px 16px;border:1px solid #cbd5e1;background:#fff;border-radius:8px;cursor:pointer;font-weight:600;">Cancel</button>
        <button id="_tpGo" disabled style="padding:9px 18px;border:none;background:#0B1D34;color:#fff;font-weight:700;border-radius:8px;cursor:pointer;opacity:.5;">Continue to secure payment</button>
      </div>
      <div id="_tpErr" style="color:#b91c1c;font-size:12.5px;margin-top:10px;"></div>
      <p style="font-size:11.5px;color:#64748b;margin:10px 0 0;">You can cancel any time before continuing. Nothing is charged until you complete the secure payment page.</p>`;
    const go = body.querySelector('#_tpGo');
    const accept = body.querySelector('#_tpAccept');
    accept.onchange = () => { go.disabled = !accept.checked; go.style.opacity = accept.checked ? '1' : '.5'; };
    body.querySelector('#_tpCancel').onclick = close;
    go.onclick = async () => {
      if (!accept.checked) return;
      const o = options[Number((body.querySelector('input[name="_tpMethod"]:checked') || {}).value || 0)];
      go.disabled = true; go.textContent = 'Starting secure payment…';
      try {
        const r = await fetch('/api/portal/pay/checkout', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ property_id: propertyId || null, payment_method: o.method === 'card' ? 'card' : 'ach', quote_token: o.quote_token, accept_terms: true }),
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.checkout_url) { location.href = j.checkout_url; return; }
        throw new Error(FRIENDLY[j.error] || j.hint || 'We could not start the payment. Please try again.');
      } catch (e) {
        body.querySelector('#_tpErr').textContent = e.message;
        go.disabled = false; go.textContent = 'Continue to secure payment';
      }
    };
  }

  window.TrustedPayReview = { open };
})();
