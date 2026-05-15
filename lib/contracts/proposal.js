// ============================================================================
// proposal.js
// ----------------------------------------------------------------------------
// Bedrock management-proposal renderer. The customer-facing pitch document
// boards see before they decide. Companion to the management-agreement
// renderer — same brand palette, same merge-token approach, same data
// source. A marketing person enters prospect info once; this and the
// management agreement render from the same prospect row.
//
// Content is intentionally trustEd-era: leads with Ed's moat (CPA + CFE +
// ex-Big-4 partner + ex-HFT operator), the trustEd Intelligence platform,
// askEd for governing-doc queries, portfolio dashboards, SLA timestamps,
// and the multi-persona judgment framework. Drops the legacy ATG C3
// references and "we care about people" generics.
//
// Per the brand-the-output rule: rendered from data; never a forwarded
// vendor PDF.
// ============================================================================

const fs = require('fs');
const path = require('path');

const LOGOS_DIR = path.join(__dirname, '..', '..', 'public', 'logos');
const _dataUriCache = {};
function logoDataUri(filename) {
  if (!filename) return '';
  if (_dataUriCache[filename] !== undefined) return _dataUriCache[filename];
  try {
    const buf = fs.readFileSync(path.join(LOGOS_DIR, filename));
    const mime = filename.toLowerCase().endsWith('.jpg') || filename.toLowerCase().endsWith('.jpeg')
      ? 'image/jpeg' : 'image/png';
    _dataUriCache[filename] = `data:${mime};base64,` + buf.toString('base64');
  } catch (_) {
    _dataUriCache[filename] = '';
  }
  return _dataUriCache[filename];
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(String(d).length === 10 ? `${d}T12:00:00` : d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function fmtMoney(n) {
  const v = Number(n);
  if (!isFinite(v)) return '';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// computeProposedMonthlyFee — same precedence as management_agreement.js:
// override beats math beats fallback. Pricing is internal until we choose
// to render it on the proposal (which by default we DO — boards expect
// to see a number on a proposal).
function computeProposedMonthlyFee(prospect) {
  if (!prospect) return 0;
  if (prospect.monthly_fee_override != null) return Number(prospect.monthly_fee_override);
  if (prospect.lot_count_estimated && prospect.per_lot_monthly_fee) {
    return Number(prospect.lot_count_estimated) * Number(prospect.per_lot_monthly_fee);
  }
  return 0;
}

// renderProposalHTML — full HTML document for puppeteer → PDF.
async function renderProposalHTML({ prospect, primaryContact, contacts, defaults, today }) {
  const communityName = (prospect && prospect.community_name) || 'Your Community';
  const communityAddress = (prospect && prospect.community_address) || '';
  const monthly = computeProposedMonthlyFee(prospect);
  const termMonths = (prospect && prospect.term_months) || (defaults && defaults.default_term_months) || 12;
  const targetStart = prospect && prospect.target_start_date;
  const proposalDate = today || new Date();

  const bedrockLogo = logoDataUri('bedrock_logo.png');

  const greetingName = primaryContact && primaryContact.name
    ? `Dear ${escapeHtml(primaryContact.name)}`
    : `Dear ${escapeHtml(communityName)} Board`;

  const pricingLine = monthly > 0
    ? `<strong>${fmtMoney(monthly)} per month</strong> for an initial term of ${termMonths === 12 ? 'twelve (12) months' : `${termMonths} months`}, auto-renewing annually thereafter`
    : `A fixed monthly management fee, terms detailed in the management agreement that accompanies this proposal`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { size: Letter; margin: 0; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: #1a1a1a;
    line-height: 1.55;
    font-size: 11pt;
    margin: 0;
  }
  .page {
    width: 8.5in;
    min-height: 11in;
    padding: 0.7in 0.85in;
    page-break-after: always;
    position: relative;
  }
  .page:last-child { page-break-after: auto; }

  /* ===== COVER ===== */
  .cover {
    background: linear-gradient(135deg, #1E2761 0%, #2a3a8f 100%);
    color: #fff;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .cover-top {
    padding: 0.7in 0.85in 0.4in;
  }
  .cover-logo {
    height: 64px;
    filter: brightness(0) invert(1);
    margin-bottom: 24px;
  }
  .cover-tagline {
    font-size: 11pt;
    letter-spacing: 4px;
    text-transform: uppercase;
    color: #CADCFC;
    font-weight: 600;
  }
  .cover-middle {
    flex: 1;
    padding: 0 0.85in;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .cover-kicker {
    font-size: 12pt;
    letter-spacing: 6px;
    text-transform: uppercase;
    color: #CADCFC;
    font-weight: 700;
    margin-bottom: 16px;
  }
  .cover-title {
    font-size: 44pt;
    font-weight: 800;
    line-height: 1.05;
    margin: 0 0 12px;
    letter-spacing: -1px;
  }
  .cover-community {
    font-size: 22pt;
    font-weight: 600;
    color: #CADCFC;
    margin: 24px 0 4px;
  }
  .cover-sub {
    font-size: 11pt;
    color: rgba(255,255,255,0.75);
  }
  .cover-bottom {
    padding: 0.5in 0.85in;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    border-top: 1px solid rgba(202,220,252,0.25);
  }
  .cover-bottom .prepared {
    font-size: 9pt;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: #CADCFC;
    font-weight: 700;
  }
  .cover-bottom .prepared-by {
    font-size: 12pt;
    font-weight: 600;
    color: #fff;
    margin-top: 4px;
  }
  .cover-bottom .contact {
    text-align: right;
    font-size: 9.5pt;
    color: rgba(255,255,255,0.8);
    line-height: 1.7;
  }

  /* ===== INTERIOR PAGES ===== */
  .pg-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-bottom: 14px;
    border-bottom: 2px solid #1E2761;
    margin-bottom: 22px;
  }
  .pg-header img { height: 32px; }
  .pg-header .community-tag {
    font-size: 9pt;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: #475569;
    font-weight: 700;
  }

  .pg-footer {
    position: absolute;
    bottom: 0.4in;
    left: 0.85in;
    right: 0.85in;
    display: flex;
    justify-content: space-between;
    font-size: 8.5pt;
    color: #94A3B8;
    border-top: 1px solid #e2e8f0;
    padding-top: 8px;
  }

  h1.section {
    font-size: 22pt;
    font-weight: 800;
    color: #1E2761;
    margin: 0 0 6px;
    letter-spacing: -0.5px;
  }
  .section-kicker {
    font-size: 9pt;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: #1E2761;
    font-weight: 700;
    margin-bottom: 8px;
  }
  .lede {
    font-size: 13pt;
    color: #1f2937;
    line-height: 1.45;
    margin: 12px 0 22px;
  }
  p { margin: 0 0 12px; }

  h2 {
    font-size: 13pt;
    color: #1E2761;
    font-weight: 700;
    margin: 22px 0 8px;
  }
  ul.clean {
    margin: 0 0 14px;
    padding: 0;
    list-style: none;
  }
  ul.clean li {
    position: relative;
    padding-left: 22px;
    margin-bottom: 7px;
    line-height: 1.5;
  }
  ul.clean li::before {
    content: '';
    position: absolute;
    left: 0;
    top: 9px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #1E2761;
  }

  .qual-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    margin: 18px 0 6px;
  }
  .qual-card {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-left: 3px solid #1E2761;
    padding: 12px 14px;
    border-radius: 0 6px 6px 0;
  }
  .qual-card .label {
    font-size: 8.5pt;
    letter-spacing: 1.2px;
    text-transform: uppercase;
    color: #475569;
    font-weight: 700;
    margin-bottom: 3px;
  }
  .qual-card .value {
    font-size: 11pt;
    color: #1E2761;
    font-weight: 600;
    line-height: 1.4;
  }

  .pillar-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    margin-top: 14px;
  }
  .pillar {
    padding: 14px 16px;
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
  }
  .pillar h3 {
    font-size: 11pt;
    color: #1E2761;
    font-weight: 700;
    margin: 0 0 4px;
  }
  .pillar p {
    font-size: 10pt;
    color: #475569;
    margin: 0;
    line-height: 1.5;
  }

  .terms-card {
    margin: 16px 0;
    padding: 18px 22px;
    background: #1E2761;
    color: #fff;
    border-radius: 10px;
  }
  .terms-card .row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 6px 0;
    border-bottom: 1px solid rgba(202,220,252,0.2);
  }
  .terms-card .row:last-child { border-bottom: 0; }
  .terms-card .label {
    font-size: 9.5pt;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: #CADCFC;
    font-weight: 700;
  }
  .terms-card .value {
    font-size: 12pt;
    font-weight: 600;
  }
  .terms-card .value.big {
    font-size: 20pt;
    font-weight: 800;
  }

  .quote {
    margin: 18px 0;
    padding: 14px 18px;
    background: #f8fafc;
    border-left: 3px solid #CADCFC;
    font-style: italic;
    color: #334155;
    font-size: 10.5pt;
    line-height: 1.55;
  }

  .signature-pitch {
    margin-top: 20px;
    padding: 16px 18px;
    background: #fffbeb;
    border-left: 3px solid #b45309;
    color: #78350f;
    font-size: 11pt;
    line-height: 1.55;
  }
</style></head><body>

<!-- ============================================================ -->
<!-- COVER PAGE                                                    -->
<!-- ============================================================ -->
<div class="page cover">
  <div class="cover-top">
    ${bedrockLogo
      ? `<img src="${bedrockLogo}" alt="Bedrock" class="cover-logo">`
      : `<div style="font-size:32pt; font-weight:800; letter-spacing:1px;">BEDROCK</div>
         <div style="font-size:9pt; letter-spacing:3px; color:#CADCFC; font-weight:600; margin-top:2px;">ASSOCIATION MANAGEMENT</div>`}
    <div class="cover-tagline">Community. Simplified.</div>
  </div>
  <div class="cover-middle">
    <div class="cover-kicker">Management Proposal</div>
    <h1 class="cover-title">A modern foundation<br>for ${escapeHtml(communityName)}.</h1>
    <div class="cover-community">${escapeHtml(communityName)}</div>
    ${communityAddress ? `<div class="cover-sub">${escapeHtml(communityAddress)}</div>` : ''}
  </div>
  <div class="cover-bottom">
    <div>
      <div class="prepared">Prepared by</div>
      <div class="prepared-by">Edward Gojara</div>
      <div style="font-size:9pt; color:rgba(255,255,255,0.75); margin-top:4px; line-height:1.55;">Owner, Bedrock Association Management<br>Founder, Bedrock Intelligence &amp; trustEd</div>
      <div style="font-size:8.5pt; color:rgba(255,255,255,0.6); margin-top:6px;">${fmtDate(proposalDate)}</div>
    </div>
    <div class="contact">
      Bedrock Association Management, LLC<br>
      12808 W. Airport Blvd. #253, Sugar Land, TX 77498<br>
      (832) 588-2485 &nbsp;·&nbsp; info@bedrocktx.com &nbsp;·&nbsp; bedrocktx.com
    </div>
  </div>
</div>

<!-- ============================================================ -->
<!-- PAGE 2 — WHY BEDROCK                                          -->
<!-- ============================================================ -->
<div class="page">
  <div class="pg-header">
    <div>
      ${bedrockLogo ? `<img src="${bedrockLogo}" alt="Bedrock">` : `<strong style="color:#1E2761; font-size:14pt;">BEDROCK</strong>`}
    </div>
    <div class="community-tag">${escapeHtml(communityName)} · Proposal</div>
  </div>

  <div class="section-kicker">Why Bedrock</div>
  <h1 class="section">We don't outsource judgment.<br>We systematize it.</h1>
  <p class="lede">
    Most management companies promise responsiveness and care. Boards have heard it before — and they've been disappointed before. ${greetingName}, here is what is actually different about working with us.
  </p>

  <h2>The background that shaped the platform</h2>
  <p>
    trustEd was built by someone who has spent decades inside the systems boards rely on. Edward Gojara's career began at Big Four accounting firms, then continued as a Principal at a regional firm working with institutional clients. He later spent years in fraud-detection work, and then took on a senior operations role on a high-frequency trading desk, where speed, exception-handling, and the cost of error were daily disciplines.
  </p>
  <p>
    The trustEd platform borrows from each of those settings — disciplined financial preparation, careful skepticism, and the operations-engineering mindset of an environment where mistakes cannot recur. The result for your community is not a "we care about people" pitch. It is a management approach designed around the patterns that hurt other boards — surfacing them early, documenting decisions clearly, and keeping the recurring obligations of an association on schedule.
  </p>

  <h2>What that means for ${escapeHtml(communityName)}</h2>
  <div class="qual-grid">
    <div class="qual-card">
      <div class="label">Disciplined Financial Reporting</div>
      <div class="value">Monthly statements prepared with consistent process — proper chart of accounts, accruals, and variance analysis. The same clean view every month.</div>
    </div>
    <div class="qual-card">
      <div class="label">Strong Internal Controls</div>
      <div class="value">Standard control discipline applied consistently — segregation of duties, monthly bank reconciliations, vendor onboarding review, and competitive bidding on material expenditures.</div>
    </div>
    <div class="qual-card">
      <div class="label">Operations Engineering</div>
      <div class="value">Daily review of exceptions, kill switches when something is off, structured postmortems. The same problem does not have to come back to your board twice.</div>
    </div>
    <div class="qual-card">
      <div class="label">HOA Domain Depth</div>
      <div class="value">Texas Property Code, dedicatory-instrument interpretation, board governance, ARC enforcement — specialized HOA practice, not generic property management translated into HOA work.</div>
    </div>
  </div>

  <div class="quote">
    "Most boards measure their manager on responsiveness. We measure ourselves on whether the same problem ever has to come back to you twice."
    <div style="margin-top:6px; font-style:normal; font-size:9.5pt; color:#1E2761; font-weight:700;">— Edward Gojara</div>
  </div>

  <div class="pg-footer">
    <span>Bedrock Association Management, LLC</span>
    <span>${escapeHtml(communityName)} &nbsp;·&nbsp; Page 2</span>
  </div>
</div>

<!-- ============================================================ -->
<!-- PAGE 3 — trustEd: THE OPERATING SYSTEM                        -->
<!-- ============================================================ -->
<div class="page">
  <div class="pg-header">
    <div>
      ${bedrockLogo ? `<img src="${bedrockLogo}" alt="Bedrock">` : `<strong style="color:#1E2761; font-size:14pt;">BEDROCK</strong>`}
    </div>
    <div class="community-tag">${escapeHtml(communityName)} · Proposal</div>
  </div>

  <div class="section-kicker">Our Platform</div>
  <h1 class="section">trustEd — the operating system behind every Bedrock community.</h1>
  <p class="lede">
    trustEd is the Bedrock-built platform our team runs the entire community on. It is not a homeowner portal bolted onto generic property-management software. It is a purpose-built operating system for HOAs — designed around the way HOAs actually operate, not the way generic SaaS vendors think they do.
  </p>

  <div class="pillar-grid">
    <div class="pillar">
      <h3>askEd — instant governing-document answers</h3>
      <p>Every governing document — Bylaws, CC&amp;Rs, ARC guidelines, prior board minutes — is loaded and searchable in natural language. Questions that used to take a board member three days of email back-and-forth get answered in seconds, with the section cited.</p>
    </div>
    <div class="pillar">
      <h3>Portfolio dashboards</h3>
      <p>Annual meetings, vendor renewals, ARC backlog, audit/tax/insurance deadlines — every recurring obligation tracked across the full book of communities. Nothing falls through the cracks because the dashboard surfaces it before the deadline.</p>
    </div>
    <div class="pillar">
      <h3>SLA timestamps on every touchpoint</h3>
      <p>Each owner contact, ARC application, vendor request, and board task gets a start and end timestamp. Median, p90, and oldest-pending metrics are visible on every community — so service quality is measurable, not anecdotal.</p>
    </div>
    <div class="pillar">
      <h3>Multi-lens decision framework</h3>
      <p>For any significant board decision, the situation is considered from multiple perspectives — homeowner, board, manager, financial, governance, risk, and operational. The recommendation that reaches your board comes with the reasoning behind it, not just a generic answer.</p>
    </div>
  </div>

  <p style="margin-top:18px;">
    trustEd is included in your monthly management fee. There is no separate technology charge. It does not replace your manager — it amplifies what one person can deliver. The result for ${escapeHtml(communityName)}: a consistent process, clearly documented decisions, and a permanent record the board can rely on.
  </p>

  <div class="pg-footer">
    <span>Bedrock Association Management, LLC</span>
    <span>${escapeHtml(communityName)} &nbsp;·&nbsp; Page 3</span>
  </div>
</div>

<!-- ============================================================ -->
<!-- PAGE 4 — WHAT YOU GET                                         -->
<!-- ============================================================ -->
<div class="page">
  <div class="pg-header">
    <div>
      ${bedrockLogo ? `<img src="${bedrockLogo}" alt="Bedrock">` : `<strong style="color:#1E2761; font-size:14pt;">BEDROCK</strong>`}
    </div>
    <div class="community-tag">${escapeHtml(communityName)} · Proposal</div>
  </div>

  <div class="section-kicker">Scope of Services</div>
  <h1 class="section">What ${escapeHtml(communityName)} gets.</h1>
  <p class="lede">Full-service association management organized around the four areas where boards spend their time.</p>

  <h2>Operations</h2>
  <ul class="clean">
    <li>Monthly deed-restriction inspections with photo-documented violations</li>
    <li>Architectural Control Committee administration — homeowner application intake, board review workflow, decision letters</li>
    <li>Common-area and amenity inspections; vendor coordination for ongoing maintenance</li>
    <li>Board meeting preparation (agenda, packet, minutes) and attendance</li>
    <li>Annual meeting administration — Texas §209.0056-compliant notices, nominations, proxy/ballot, election</li>
    <li>Access-control and amenity-rental management for gated communities</li>
  </ul>

  <h2>Finance &amp; Reporting</h2>
  <ul class="clean">
    <li>Monthly financial statements delivered by the 15th — income statement, balance sheet, AR aging, budget-to-actual variance</li>
    <li>Oversight of the chart of accounts and accruals; coordination with the Association's accounting firm on year-end reporting</li>
    <li>Reserve study coordination; reserve-fund banking with conservative-vehicle guidance (CDs, ICS, CDARS — not equities)</li>
    <li>Assessment billing, lockbox processing, payment plan administration, attorney coordination for collections</li>
    <li>Vendor invoice review with GL-reconciliation discipline; competitive bid process on material expenditures</li>
  </ul>

  <h2>Compliance &amp; Risk</h2>
  <ul class="clean">
    <li>Texas Property Code monitoring — statute-driven notice timing, recall procedures, election administration</li>
    <li>Fair Housing Act guardrails on every enforcement action — documented behavior, never identity</li>
    <li>Insurance claim administration, certificate-of-insurance tracking for vendors, and coordination with the Association's insurance agent on annual renewals</li>
    <li>Records retention and document library — every contract, decision, and homeowner action archived and searchable</li>
  </ul>

  <h2>Communications</h2>
  <ul class="clean">
    <li>Homeowner inquiry response within one business day, with the answer cited to the governing documents</li>
    <li>Bedrock-branded community communications — every notice, mailing, and bespoke; no "Dear Homeowner" form letters</li>
    <li>Board communication — proactive updates, not just reactive answers to questions</li>
  </ul>

  <div class="pg-footer">
    <span>Bedrock Association Management, LLC</span>
    <span>${escapeHtml(communityName)} &nbsp;·&nbsp; Page 4</span>
  </div>
</div>

<!-- ============================================================ -->
<!-- PAGE 5 — PROPOSED TERMS                                       -->
<!-- ============================================================ -->
<div class="page">
  <div class="pg-header">
    <div>
      ${bedrockLogo ? `<img src="${bedrockLogo}" alt="Bedrock">` : `<strong style="color:#1E2761; font-size:14pt;">BEDROCK</strong>`}
    </div>
    <div class="community-tag">${escapeHtml(communityName)} · Proposal</div>
  </div>

  <div class="section-kicker">Proposed Terms</div>
  <h1 class="section">What this engagement looks like.</h1>
  <p class="lede">
    We propose a one-year engagement to manage ${escapeHtml(communityName)}, renewing annually thereafter. Pricing is structured around a fixed monthly management fee that covers the full scope above. The full fee schedule — including reimbursables and owner-billable charges — is in the management agreement that accompanies this proposal.
  </p>

  <div class="terms-card">
    <div class="row">
      <div class="label">Monthly management fee</div>
      <div class="value big">${monthly > 0 ? fmtMoney(monthly) : '—'}</div>
    </div>
    <div class="row">
      <div class="label">Initial term</div>
      <div class="value">${termMonths} month${termMonths === 1 ? '' : 's'}, auto-renewing</div>
    </div>
    ${targetStart ? `
    <div class="row">
      <div class="label">Target start date</div>
      <div class="value">${fmtDate(targetStart)}</div>
    </div>
    ` : ''}
    <div class="row">
      <div class="label">Annual fee escalator</div>
      <div class="value">CPI or 5%, whichever is lower</div>
    </div>
    <div class="row">
      <div class="label">Termination</div>
      <div class="value">30 days for cause, 60 days without cause</div>
    </div>
  </div>

  <h2>What's included</h2>
  <ul class="clean">
    <li>Full scope of services on the prior page</li>
    <li>Access to the trustEd platform (askEd, dashboards, SLA metrics) at no separate charge</li>
    <li>Monthly board meeting attendance and meeting preparation</li>
    <li>Annual meeting administration including election services</li>
    <li>All Bedrock-branded customer-facing communications</li>
  </ul>

  <h2>Reimbursable items (billed as incurred)</h2>
  <p>Postage, copies (excluding annual statements and annual meeting notices which are billed per-lot), out-of-pocket expenses on behalf of the Association, and work outside the standard scope. Full rates in the management agreement.</p>

  <h2>Owner-billable charges (collected from the homeowner where legally permitted)</h2>
  <p>Resale and refinance certificates, ARC application fees, late notices, certified demand letters, payment plans. These do not represent cost to the Association.</p>

  <div class="pg-footer">
    <span>Bedrock Association Management, LLC</span>
    <span>${escapeHtml(communityName)} &nbsp;·&nbsp; Page 5</span>
  </div>
</div>

<!-- ============================================================ -->
<!-- PAGE 6 — TRANSITION + NEXT STEPS                              -->
<!-- ============================================================ -->
<div class="page">
  <div class="pg-header">
    <div>
      ${bedrockLogo ? `<img src="${bedrockLogo}" alt="Bedrock">` : `<strong style="color:#1E2761; font-size:14pt;">BEDROCK</strong>`}
    </div>
    <div class="community-tag">${escapeHtml(communityName)} · Proposal</div>
  </div>

  <div class="section-kicker">Transition Plan</div>
  <h1 class="section">How we get from here to your first board meeting.</h1>
  <p class="lede">
    Switching management companies sounds disruptive. With proper planning it is not. The board's effort is concentrated in a single vote; we handle the rest.
  </p>

  <h2>The first 30 days</h2>
  <ul class="clean">
    <li>Board votes to terminate the current manager and engage Bedrock at a properly noticed meeting</li>
    <li>Bedrock drafts the termination notice and coordinates the document and funds handoff with the outgoing manager</li>
    <li>New operating and reserve accounts opened; board signatories established; bank access provisioned for every director</li>
    <li>Communication to all homeowners announcing the management transition, with a clear "what changes for you" paragraph</li>
    <li>Existing vendor contracts reviewed and indexed; expiring agreements flagged for board attention</li>
  </ul>

  <h2>Days 30–90</h2>
  <ul class="clean">
    <li>Complete records transfer (governing docs, prior minutes, financial history) — typically settled by day 60, fully resolved by day 90</li>
    <li>All governing documents indexed into askEd so the board can query them on day one</li>
    <li>First Bedrock monthly financial statement delivered by the 15th of the next full month</li>
    <li>Working agenda for upcoming board meeting circulated five business days in advance</li>
  </ul>

  <h2>What we will need from the board</h2>
  <ul class="clean">
    <li>A vote at a properly noticed meeting to engage Bedrock</li>
    <li>Signatures on the management agreement</li>
    <li>Authorization to open new bank accounts and provide signatories</li>
    <li>Introductions, where appropriate, to key vendors and the existing on-site team</li>
  </ul>

  <div class="signature-pitch">
    <strong>The accompanying management agreement</strong> contains the complete legal terms, full fee schedule, and signature blocks. We are happy to walk through it with the board on a call or at your next meeting. If the proposal works for ${escapeHtml(communityName)}, the next step is a board vote — and we can be at your first meeting as your manager within 30 days.
  </div>

  <p style="margin-top:18px;">Thank you for considering Bedrock. We would be glad to answer questions from any board member directly.</p>

  <p style="margin-top:20px;">Sincerely,</p>
  <p style="margin-top:30px; margin-bottom:2px;"><strong style="color:#1E2761;">Edward Gojara</strong></p>
  <p style="margin:0; font-size:10pt; color:#475569;">Owner, Bedrock Association Management, LLC<br>Founder, Bedrock Intelligence &amp; trustEd<br>(832) 588-2485 &nbsp;·&nbsp; info@bedrocktx.com</p>

  <div class="pg-footer">
    <span>Bedrock Association Management, LLC</span>
    <span>${escapeHtml(communityName)} &nbsp;·&nbsp; Page 6</span>
  </div>
</div>

</body></html>`;
}

module.exports = {
  renderProposalHTML,
  computeProposedMonthlyFee,
};
