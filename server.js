require('dotenv').config({ override: true });
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const BRAND = require('./lib/brand');

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const pdfParse = require('pdf-parse');

// Anthropic enforces a 5MB cap on each base64 image. Modern phone photos
// routinely exceed this. Shrink anything oversized down to a safe size before
// it hits the API — preserve aspect ratio, iterate quality/dimension until
// the encoded payload fits under the limit.
const ANTHROPIC_IMAGE_BASE64_MAX = 5 * 1024 * 1024;
const SAFE_RAW_TARGET = Math.floor(ANTHROPIC_IMAGE_BASE64_MAX * 3 / 4) - 64 * 1024;
let _canvasLib = null;
function _canvas() {
  if (!_canvasLib) _canvasLib = require('canvas');
  return _canvasLib;
}
async function shrinkImageForAnthropic(buffer, mimetype) {
  return shrinkImageToTarget(buffer, mimetype, SAFE_RAW_TARGET, 1800);
}

// General-purpose image shrinker. Used for both Anthropic vision calls and
// for storage-bound uploads (nomination photos) where 8MB+ phone photos
// would otherwise bloat storage and slow the admin UI. Iteratively reduces
// max dimension + JPEG quality until the encoded payload is under target.
async function shrinkImageToTarget(buffer, mimetype, targetBytes, startMaxDim) {
  if (!buffer || buffer.length <= targetBytes) {
    return { buffer, mimetype: mimetype || 'image/jpeg' };
  }
  try {
    const { createCanvas, loadImage } = _canvas();
    const img = await loadImage(buffer);
    let maxDim = startMaxDim || 1800;
    let quality = 0.85;
    let out = buffer;
    for (let i = 0; i < 8; i++) {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.floor(img.width * scale));
      const h = Math.max(1, Math.floor(img.height * scale));
      const canvas = createCanvas(w, h);
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      out = canvas.toBuffer('image/jpeg', { quality });
      if (out.length <= targetBytes) break;
      maxDim = Math.floor(maxDim * 0.82);
      quality = Math.max(0.55, quality - 0.07);
    }
    return { buffer: out, mimetype: 'image/jpeg' };
  } catch (e) {
    console.warn('[shrinkImage] failed, returning original:', e.message);
    return { buffer, mimetype: mimetype || 'image/jpeg' };
  }
}

// Nomination photo target — smaller than Anthropic's 5MB cap because these
// just need to render at ~110px on the ballot bio page. 1MB cap is plenty.
const NOMINATION_PHOTO_TARGET = 1 * 1024 * 1024;

// Unified playbook retrieval — semantic search across all entries.
// Replaces per-endpoint category filters.

const { getRelevantPlaybook, formatPlaybookContext, buildAppliedPlaybookSummary } = require('./playbook');
// =====================================================================
// RFP DOCX GENERATOR — produces a polished Word doc from structured RFP data
// =====================================================================
const {
  Table: RfpTable, TableRow: RfpTableRow, TableCell: RfpTableCell,
  Header: RfpHeader, Footer: RfpFooter, LevelFormat: RfpLevelFormat,
  TabStopType: RfpTabStopType, HeadingLevel: RfpHeadingLevel,
  WidthType: RfpWidthType, ShadingType: RfpShadingType,
  VerticalAlign: RfpVerticalAlign, PageNumber: RfpPageNumber
} = require('docx');

const RFP_NAVY = "1F3A5F";
const RFP_ACCENT = "2E75B6";
const RFP_HEADER_FILL = "1F3A5F";
const RFP_ROW_ALT = "F2F5F9";
const RFP_BORDER = "BFBFBF";

async function generateRFPDocx(rfp) {
  const { Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle } = require('docx');
  const thinBorder = { style: BorderStyle.SINGLE, size: 4, color: RFP_BORDER };
  const cellBorders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

  const para = (text, opts = {}) => new Paragraph({
    spacing: { after: opts.after ?? 120, before: opts.before ?? 0, line: 280 },
    alignment: opts.alignment,
    children: [new TextRun({ text, bold: opts.bold, italics: opts.italics, size: opts.size ?? 22, color: opts.color })]
  });
  const blank = () => new Paragraph({ children: [new TextRun("")] });
  const h1 = (text) => new Paragraph({
    heading: RfpHeadingLevel.HEADING_1,
    spacing: { before: 320, after: 160 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: RFP_ACCENT, space: 4 } },
    children: [new TextRun({ text, bold: true, size: 28, color: RFP_NAVY, font: "Calibri" })]
  });
  const bulletPara = (text) => new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { after: 60, line: 280 },
    children: [new TextRun({ text, size: 22 })]
  });
  const headerCell = (text, width) => new RfpTableCell({
    borders: cellBorders,
    width: { size: width, type: RfpWidthType.DXA },
    shading: { fill: RFP_HEADER_FILL, type: RfpShadingType.CLEAR },
    margins: { top: 100, bottom: 100, left: 140, right: 140 },
    verticalAlign: RfpVerticalAlign.CENTER,
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text, bold: true, color: "FFFFFF", size: 22, font: "Calibri" })]
    })]
  });
  const dataCell = (text, width, opts = {}) => new RfpTableCell({
    borders: cellBorders,
    width: { size: width, type: RfpWidthType.DXA },
    shading: opts.shaded ? { fill: RFP_ROW_ALT, type: RfpShadingType.CLEAR } : undefined,
    margins: { top: 90, bottom: 90, left: 140, right: 140 },
    verticalAlign: RfpVerticalAlign.CENTER,
    children: [new Paragraph({
      alignment: opts.align,
      children: [new TextRun({ text, size: 21, bold: opts.bold })]
    })]
  });

  const headerBlock = [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 },
      children: [new TextRun({ text: "BEDROCK ASSOCIATION MANAGEMENT", bold: true, size: 26, color: RFP_NAVY, font: "Calibri" })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 },
      children: [new TextRun({ text: `On behalf of ${rfp.community}`, italics: true, size: 22, color: "555555" })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 },
      children: [new TextRun({ text: "REQUEST FOR PROPOSALS", bold: true, size: 36, color: RFP_NAVY, font: "Calibri" })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 320 },
      children: [new TextRun({ text: rfp.vendorType + " Services", size: 26, color: RFP_ACCENT, font: "Calibri" })] }),
    new RfpTable({
      width: { size: 7200, type: RfpWidthType.DXA },
      alignment: AlignmentType.CENTER,
      columnWidths: [2400, 4800],
      rows: [
        new RfpTableRow({ children: [dataCell("Issued", 2400, { bold: true, shaded: true }), dataCell(rfp.dateIssued, 4800)] }),
        new RfpTableRow({ children: [dataCell("Proposals Due", 2400, { bold: true, shaded: true }), dataCell(rfp.dueDate, 4800)] }),
        new RfpTableRow({ children: [dataCell("Contract Term", 2400, { bold: true, shaded: true }), dataCell(rfp.contractTerm, 4800)] }),
      ]
    }),
    blank(),
  ];

  const aboutSection = [
    h1("About the Community"),
    para(rfp.about || `${rfp.community} is a residential HOA community managed by ${BRAND.service.name}.`),
    para(`Vendors are encouraged to visit the property before submitting a proposal. Contact ${BRAND.service.name} to coordinate a site visit.`)
  ];

  const scopeRow = (num, item, freq, notes, alt) => new RfpTableRow({
    children: [
      dataCell(String(num), 500, { align: AlignmentType.CENTER, shaded: alt, bold: true }),
      dataCell(item, 2400, { shaded: alt, bold: true }),
      dataCell(freq, 1700, { align: AlignmentType.CENTER, shaded: alt }),
      dataCell(notes || "", 4760, { shaded: alt }),
    ]
  });
  const scopeRows = (rfp.scopeItems || []).map((it, i) =>
    scopeRow(i + 1, it.service || "", it.frequency || "", it.notes || "", i % 2 === 1));
  const scopeSection = [
    h1("Scope of Work"),
    para("The selected vendor shall provide all labor, equipment, materials, and supervision for the following services in common areas. Vendors must price each item using the pricing table below.", { italics: true }),
    blank(),
    new RfpTable({
      width: { size: 9360, type: RfpWidthType.DXA },
      columnWidths: [500, 2400, 1700, 4760],
      rows: [
        new RfpTableRow({ tableHeader: true, children: [headerCell("#", 500), headerCell("Service", 2400), headerCell("Frequency", 1700), headerCell("Notes / Exclusions", 4760)] }),
        ...scopeRows
      ]
    }),
  ];

  const priceRow = (num, item, freq, alt) => new RfpTableRow({
    children: [
      dataCell(String(num), 600, { align: AlignmentType.CENTER, shaded: alt }),
      dataCell(item, 4060, { shaded: alt }),
      dataCell(freq, 1900, { align: AlignmentType.CENTER, shaded: alt }),
      dataCell("$", 1400, { align: AlignmentType.RIGHT, shaded: alt }),
      dataCell("$", 1400, { align: AlignmentType.RIGHT, shaded: alt }),
    ]
  });
  const pricingRows = (rfp.scopeItems || []).map((it, i) =>
    priceRow(i + 1, it.service || "", it.frequency || "", i % 2 === 1));
  const totalRow = new RfpTableRow({
    children: [
      new RfpTableCell({
        borders: cellBorders, columnSpan: 4,
        width: { size: 7960, type: RfpWidthType.DXA },
        shading: { fill: RFP_HEADER_FILL, type: RfpShadingType.CLEAR },
        margins: { top: 110, bottom: 110, left: 140, right: 140 },
        children: [new Paragraph({ alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: "TOTAL ANNUAL CONTRACT VALUE", bold: true, color: "FFFFFF", size: 22 })] })]
      }),
      new RfpTableCell({
        borders: cellBorders,
        width: { size: 1400, type: RfpWidthType.DXA },
        shading: { fill: RFP_HEADER_FILL, type: RfpShadingType.CLEAR },
        margins: { top: 110, bottom: 110, left: 140, right: 140 },
        children: [new Paragraph({ alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: "$", bold: true, color: "FFFFFF", size: 22 })] })]
      }),
    ]
  });
  const pricingSection = [
    h1("Pricing"),
    para("Complete the pricing table below. All fields required.", { italics: true }),
    blank(),
    new RfpTable({
      width: { size: 9360, type: RfpWidthType.DXA },
      columnWidths: [600, 4060, 1900, 1400, 1400],
      rows: [
        new RfpTableRow({ tableHeader: true, children: [headerCell("#", 600), headerCell("Service", 4060), headerCell("Frequency", 1900), headerCell("Per Occurrence", 1400), headerCell("Annual Total", 1400)] }),
        ...pricingRows, totalRow
      ]
    }),
    blank(),
    para(`Either party may terminate the contract with 30 days written notice. ${rfp.contractTerm}.`),
  ];

  const submissionSection = [
    h1("How to Submit"),
    para("Email your proposal as a PDF to the property manager by the due date. Late submissions may not be considered."),
    blank(),
    para("Please include in your proposal:", { bold: true }),
    bulletPara("Completed pricing table above"),
    bulletPara("Proof of insurance and applicator/professional licenses"),
    bulletPara("Three (3) HOA or commercial references"),
    bulletPara("Any clarifications or assumptions made in your pricing"),
    blank(),
    new RfpTable({
      width: { size: 9360, type: RfpWidthType.DXA },
      columnWidths: [2880, 6480],
      rows: [
        new RfpTableRow({ children: [dataCell("Submit To", 2880, { bold: true, shaded: true }), dataCell(BRAND.service.name, 6480)] }),
        new RfpTableRow({ children: [dataCell("Email", 2880, { bold: true, shaded: true }), dataCell(rfp.submitTo?.email || BRAND.service.email, 6480)] }),
        new RfpTableRow({ children: [dataCell("Phone", 2880, { bold: true, shaded: true }), dataCell(rfp.submitTo?.phone || BRAND.service.phone, 6480)] }),
        new RfpTableRow({ children: [dataCell("Deadline", 2880, { bold: true, shaded: true }), dataCell(rfp.dueDate, 6480)] }),
      ]
    }),
    blank(),
    para(`Thank you for your interest in serving ${rfp.community}.`, { italics: true, alignment: AlignmentType.CENTER }),
  ];

  const doc = new Document({
    creator: BRAND.service.name,
    title: `${rfp.community} RFP - ${rfp.vendorType}`,
    styles: {
      default: { document: { run: { font: "Calibri", size: 22 } } },
      paragraphStyles: [{
        id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, color: RFP_NAVY, font: "Calibri" },
        paragraph: { spacing: { before: 320, after: 160 }, outlineLevel: 0 }
      }]
    },
    numbering: {
      config: [{
        reference: "bullets",
        levels: [{
          level: 0, format: RfpLevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } }
        }]
      }]
    },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, right: 1440, bottom: 1080, left: 1440 } } },
      headers: {
        default: new RfpHeader({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RFP_ACCENT, space: 4 } },
            children: [new TextRun({ text: `${rfp.community}  |  RFP for ${rfp.vendorType} Services`, size: 18, color: "555555", italics: true })]
          })]
        })
      },
      footers: {
        default: new RfpFooter({
          children: [new Paragraph({
            tabStops: [{ type: RfpTabStopType.RIGHT, position: 9360 }],
            children: [
              new TextRun({ text: BRAND.service.name, size: 18, color: "555555", italics: true }),
              new TextRun({ text: "\tPage " }),
              new TextRun({ children: [RfpPageNumber.CURRENT], size: 18, color: "555555" }),
              new TextRun({ text: " of ", size: 18, color: "555555" }),
              new TextRun({ children: [RfpPageNumber.TOTAL_PAGES], size: 18, color: "555555" }),
            ]
          })]
        })
      },
      children: [...headerBlock, ...aboutSection, ...scopeSection, ...pricingSection, ...submissionSection]
    }]
  });

  return Packer.toBuffer(doc);
}

async function buildStructuredRFP({ community, vendorType, contractTerm, bidDeadline, scopeContent, additionalRequirements }) {
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const dueDate = bidDeadline
    ? new Date(bidDeadline + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : '30 days from date of this request';

  const structureResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    system: `You extract structured RFP scope-of-work data from raw scope text. Return ONLY valid JSON, no preamble, no markdown fences.`,
    messages: [{
      role: 'user',
      content: `Extract scope-of-work line items. Return JSON in exactly this shape:

{
  "about": "string — 2-3 sentence community description for an RFP, neutral tone",
  "scopeItems": [
    { "service": "string — short name", "frequency": "string — how often", "notes": "string — short description or exclusions" }
  ]
}

Each scopeItem should be ONE distinct service line. Aim for 8-20 line items.

Community: ${community}
Vendor type: ${vendorType}
${additionalRequirements ? 'Additional requirements: ' + additionalRequirements : ''}

Raw scope:
${scopeContent}`
    }]
  });

  let structured;
  let raw = structureResponse.content[0].text.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
  try { structured = JSON.parse(raw); }
  catch (e) { console.error('Failed to parse structured RFP JSON:', e.message); structured = { about: '', scopeItems: [] }; }

  return {
    community, vendorType, dateIssued: today, dueDate, contractTerm,
    about: structured.about || '',
    scopeItems: structured.scopeItems || [],
    submitTo: { email: BRAND.service.email, phone: BRAND.service.phone }
  };
}

const app = express();
app.use(express.json());

// ============================================================================
// Staff password gate — interim protection before the Microsoft 365 / Supabase
// Auth flow ships properly. Two env vars control it (both must stay unset in
// dev/legacy mode):
//   STAFF_PASSWORD       — the shared password staff types at /staff-login.html
//   STAFF_GATE_SECRET    — HMAC secret used to sign the session cookie. If
//                          unset, falls back to STAFF_PASSWORD itself, which
//                          is fine for an interim system — just means rotating
//                          the password also rotates the secret and invalidates
//                          existing sessions.
//
// When STAFF_PASSWORD is set, every request to a path NOT in the public
// allowlist requires a valid HMAC-signed cookie. Unset STAFF_PASSWORD to
// disable the gate entirely — kill switch for emergencies.
//
// Public paths (always bypass the gate) include the homeowner-facing forms
// and their public APIs, the login page itself, robots.txt, and static
// assets like logos. Everything else — the admin index.html, all the /api/*
// admin endpoints — requires authentication.
// ============================================================================
const _crypto = require('crypto');
const STAFF_GATE_COOKIE = 'bedrock_gate';
const STAFF_GATE_TTL_DAYS = 30;
// Public allowlist — paths a homeowner can hit without authenticating.
// Each entry's been verified against the actual express route in server.js
// (matched the dynamic /apply/:slug etc., not just the static apply.html
// which is only ever served INTERNALLY by those dynamic handlers).
const _STAFF_GATE_PUBLIC = [
  // Static infrastructure
  /^\/robots\.txt$/,
  /^\/favicon\.ico$/,
  /^\/logos\//,
  /^\/assets\//,
  // The login flow itself
  /^\/staff-login\.html$/,
  /^\/api\/staff-login$/,
  /^\/api\/auth\/config$/,
  // Short-URL redirects to public forms
  /^\/f\//,
  // Homeowner-facing dynamic pages — match the actual app.get routes
  /^\/nominate\b/,                          // nominations form
  /^\/apply\/[^/]+$/,                       // /apply/:slug — ARC application form
  /^\/apply\/status\/[^/]+$/,               // /apply/status/:reference — ARC status lookup
  /^\/c\/[^/]+$/,                           // /c/:slug — community landing page
  /^\/fob\/[^/]+$/,                         // /fob/:slug — pool/key-fob request
  /^\/event\/[^/]+$/,                       // /event/:slug — public event page
  /^\/event\/[^/]+\/checkin$/,              // /event/:slug/checkin — event checkin (6-digit code gated on the page itself)
  /^\/builders\/[^/]+$/,                    // /builders/:slug — builder submission form (DRB, etc.)
  /^\/builders\/status\/[^/]+$/,            // /builders/status/:reference — builder submission status lookup
  /^\/portal$/,                             // homeowner portal landing — auth checked client-side, ?demo=1 supported
  /^\/portal-login\.html$/,                 // magic-link entry page
  /^\/portal\/.+/,                          // future portal sub-pages (e.g., /portal/property, /portal/balance)
  /^\/clubhouse\/[^/]+$/,                   // /clubhouse/:slug — public clubhouse rental form (gated server-side by amenity_bookings_active)
  // Public API endpoints these pages call. Each verified against the
  // actual fetch() calls in the homeowner-facing HTML files.
  /^\/api\/nominations\/public\b/,
  /^\/api\/applications\/public\b/,            // ARC + fob: apply.html / fob_request.html
  /^\/api\/applications\/community-landing\b/, // community_landing.html
  /^\/api\/events\/public\b/,                  // event.html: details, sign, walkup, checkin auth/feed
  /^\/api\/events\/communities\/[^/]+\/roster-match$/, // event_checkin.html (page-gated by 6-digit code)
  /^\/api\/builder-applications\/public\b/,    // builders/:slug — community lookup + status check
  /^\/api\/builder-applications$/,             // POST intake (kill-switched per community)
  /^\/api\/builder-applications\/[0-9a-f-]+\/attachments$/, // file uploads tied to a submission id
  /^\/api\/portal\/request-link$/,             // POST magic-link send (anti-enumeration)
  /^\/api\/portal\/consume$/,                  // POST magic-link consume + cookie set
  /^\/api\/portal\/me$/,                       // GET portal context (gated by cookie, not staff)
  /^\/api\/portal\/logout$/,                   // POST clear cookie
  /^\/api\/portal\/map\/[^/]+$/,               // public map data (boundary + amenities)
  /^\/api\/portal\/compliance$/,               // GET homeowner's compliance state (cookie-gated)
  /^\/api\/portal\/documents$/,                // GET homeowner-visible governing docs (cookie-gated)
  /^\/api\/portal\/property$/,                 // GET property details + owners + activity (cookie-gated)
  /^\/api\/portal\/balance$/,                  // GET balance + aging buckets + history (cookie-gated)
  /^\/api\/portal\/meetings$/,                 // GET upcoming meetings + past minutes (cookie-gated)
  /^\/api\/payments\/webhook$/,                // Stripe webhook (signature-verified inside)
  /^\/api\/payments\/create-checkout-session$/, // public form posts here before Stripe redirect
  /^\/api\/payments\/by-session\/[^/]+$/,      // success page lookup post-Stripe-redirect
  /^\/api\/amenities\/community\/[^/]+$/,      // clubhouse form bootstrap
  /^\/api\/amenities\/[0-9a-f-]+$/,            // amenity detail (fees + agreement text)
  /^\/api\/amenities\/[0-9a-f-]+\/availability$/, // busy-slot check
  /^\/api\/amenities\/[0-9a-f-]+\/rentals$/,   // POST create draft rental
  /^\/api\/amenities\/rentals\/[0-9a-f-]+$/,   // GET rental status for success page
  /^\/clubhouse\/[^/]+(\/success)?$/,          // /clubhouse/:slug and /clubhouse/:slug/success
];

// Communities query is needed by amenity admin pages. Reuse existing route
// pattern — these calls are coming from staff-gated admin pages, so the
// staff cookie is already required, but communities listing is OK to expose
// even on public surfaces (we surface community names in homeowner-facing
// pages already via portal-map and clubhouse forms).

function _gateIsPublicPath(p) { return _STAFF_GATE_PUBLIC.some((re) => re.test(p)); }
function _gateSign(secret) {
  const ts = String(Date.now());
  const sig = _crypto.createHmac('sha256', secret).update(ts).digest('hex');
  return `${ts}.${sig}`;
}
function _gateVerify(secret, token) {
  if (!token || !secret) return false;
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  const [ts, sig] = parts;
  if (!/^\d+$/.test(ts)) return false;
  const age = Date.now() - Number(ts);
  if (age > STAFF_GATE_TTL_DAYS * 86400 * 1000) return false;
  const expected = _crypto.createHmac('sha256', secret).update(ts).digest('hex');
  if (sig.length !== expected.length) return false;
  try {
    return _crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch (_) { return false; }
}
function _gateExtractCookie(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp(`(?:^|; )${STAFF_GATE_COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

app.use((req, res, next) => {
  const password = process.env.STAFF_PASSWORD;
  if (!password) return next(); // kill switch — gate disabled
  if (_gateIsPublicPath(req.path)) return next();
  const secret = process.env.STAFF_GATE_SECRET || password;
  if (_gateVerify(secret, _gateExtractCookie(req))) return next();
  // Browser HTML GET → friendly redirect; API or non-GET → 401 JSON.
  const accepts = String(req.headers.accept || '');
  if (req.method === 'GET' && (accepts.includes('text/html') || req.path === '/')) {
    return res.redirect('/staff-login.html?next=' + encodeURIComponent(req.originalUrl));
  }
  return res.status(401).json({ error: 'authentication required' });
});

// Tell crawlers to stay away from the admin app. Public homeowner pages
// (/nominate/*, /apply.html, etc.) still work — they're behind paths
// homeowners reach via QR / email link, not search.
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

// Validate the password, set the signed session cookie.
app.post('/api/staff-login', (req, res) => {
  const password = process.env.STAFF_PASSWORD;
  if (!password) return res.status(503).json({ error: 'staff gate not configured' });
  const submitted = String((req.body && req.body.password) || '');
  let ok = false;
  try {
    const a = Buffer.from(submitted, 'utf8');
    const b = Buffer.from(password, 'utf8');
    ok = a.length === b.length && _crypto.timingSafeEqual(a, b);
  } catch (_) { ok = false; }
  if (!ok) return res.status(401).json({ error: 'incorrect password' });
  const secret = process.env.STAFF_GATE_SECRET || password;
  const token = _gateSign(secret);
  const secure = req.secure || (req.headers['x-forwarded-proto'] === 'https');
  res.setHeader('Set-Cookie',
    `${STAFF_GATE_COOKIE}=${encodeURIComponent(token)}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Path=/; Max-Age=${STAFF_GATE_TTL_DAYS * 86400}`
  );
  const next = (req.body && req.body.next) || '/';
  res.json({ ok: true, next: typeof next === 'string' ? next : '/' });
});

// Sign-out — clears the gate cookie.
app.get('/staff-logout', (req, res) => {
  const secure = req.secure || (req.headers['x-forwarded-proto'] === 'https');
  res.setHeader('Set-Cookie',
    `${STAFF_GATE_COOKIE}=; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Path=/; Max-Age=0`
  );
  res.redirect('/staff-login.html');
});

app.use(express.static('public'));

// ----------------------------------------------------------------------------
// Short-URL redirect for owner-facing form downloads.
// Two URL formats both supported:
//   1. /f/<uuid>                  → direct redirect to that document's download
//   2. /f/<community>-<category>  → resolve to current doc for that pair
//                                    e.g., /f/lpf-arc → current LPF ARC application
//                                          /f/eaglewood-fob → current Eaglewood key fob form
//
// The slug format always serves the CURRENT version. When a new version is
// uploaded and the old gets auto-superseded, the slug URL keeps working —
// it just points to the new version. URLs in old emails work forever.
//
// Maps community slug + category short alias to the canonical category:
//   arc  → arc_application
//   fob  → key_fob_form
//   form → forms_and_applications
// ----------------------------------------------------------------------------
const CATEGORY_SHORT_TO_CANONICAL = {
  arc: 'arc_application',
  fob: 'key_fob_form',
  form: 'forms_and_applications'
};

app.get('/f/:slug', async (req, res) => {
  const slug = String(req.params.slug || '').trim();
  const uuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

  // Path 1: UUID format (backward compat — keeps old emails working)
  if (uuidPattern.test(slug)) {
    return res.redirect(302, `/api/documents/${slug}/download`);
  }

  // Path 2: community-category slug
  // Split on the LAST hyphen so community slugs with hyphens (canyon-gate) work
  const lastHyphen = slug.lastIndexOf('-');
  if (lastHyphen < 0) return res.status(404).send('<h1>Form not found</h1>');
  const communitySlug = slug.substring(0, lastHyphen).toLowerCase();
  const categoryShort = slug.substring(lastHyphen + 1).toLowerCase();
  const category = CATEGORY_SHORT_TO_CANONICAL[categoryShort];
  if (!category) return res.status(404).send('<h1>Form not found</h1><p>Unknown form type.</p>');

  try {
    // Look up the community by slug
    const { data: community } = await supabase
      .from('communities')
      .select('id, name')
      .eq('slug', communitySlug)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (!community) return res.status(404).send('<h1>Form not found</h1><p>Unknown community.</p>');

    // Find the current doc for (community, category). If multiple match
    // (rare — only for forms_and_applications catch-all), prefer most recent.
    const { data: doc } = await supabase
      .from('library_documents')
      .select('id')
      .eq('community_id', community.id)
      .eq('category', category)
      .eq('status', 'current')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('uploaded_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!doc) {
      return res.status(404).send(`<h1>Form not found</h1><p>${community.name} doesn't have a current ${categoryShort.toUpperCase()} form on file.</p>`);
    }

    res.redirect(302, `/api/documents/${doc.id}/download`);
  } catch (err) {
    console.error('[/f/:slug] failed:', err.message);
    res.status(500).send('<h1>Server error</h1>');
  }
});

// Bedrock Office > Client Billing module
// Endpoints under /api/billing/*. See api/billing.js for the router definition
// and migrations/001_foundation.sql + migrations/002_bedrock_billing.sql for
// the schema this depends on.
const { router: billingRouter } = require('./api/billing');
app.use('/api/billing', billingRouter);

// Homes & Owners — properties, contacts, ownerships, residencies, Vantaca
// upload/diff/apply workflow. Schema in migration 049.
const { router: contactsRouter } = require('./api/contacts');
app.use('/api', contactsRouter);

// Inspections — drive/walk-through capture flow. Backs the DRV + memory-
// layer foundation (migration 050). v1 endpoints handle session create,
// photo upload with GPS/heading metadata, recent + detail. AI analysis and
// reviewer queue ship in follow-on builds.
const { router: inspectionsRouter } = require('./api/inspections');
app.use('/api', inspectionsRouter);

// Enforcement engine — Phase 4 (escalation decisions + observation→violation
// promotion). Backs the DRV workflow; consumed by the property detail panel
// (preview decision) and the violation-open action (writes the violation row).
const { router: enforcementRouter } = require('./api/enforcement');
app.use('/api/enforcement', enforcementRouter);

// Cron run history — feeds the "Last automatic run" indicators in the UI.
app.get('/api/cron/runs', async (req, res) => {
  try {
    const job = (req.query.job || '').trim();
    const limit = Math.min(50, Number(req.query.limit) || 10);
    let q = supabase
      .from('cron_runs')
      .select('id, job_name, started_at, finished_at, ok, summary, error, triggered_by')
      .order('started_at', { ascending: false })
      .limit(limit);
    if (job) q = q.eq('job_name', job);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ runs: data || [] });
  } catch (err) {
    console.error('[/api/cron/runs]', err);
    res.status(500).json({ error: err.message });
  }
});

// Bedrock Office > HOA Financial Review module
// Endpoints under /api/financial-review/*. See api/financial_review.js and
// migrations/008_financial_review.sql for the schema.
const { router: financialReviewRouter } = require('./api/financial_review');
app.use('/api/financial-review', financialReviewRouter);

// Bedrock Office > Vendor Master + Invoice Intake module (Push 1)
// Endpoints under /api/vendors/*. See api/vendors.js and
// migrations/009_vendor_master.sql for the schema.
// Drop a vendor invoice PDF -> the AI parses identity + dates + amounts,
// fuzzy-matches against existing vendor master (token Jaccard + EIN exact),
// persists invoice + agent_runs trade tape. Push 2 will add GL reconciliation
// with accrual-aware service_period matching.
const { router: vendorsRouter } = require('./api/vendors');
app.use('/api/vendors', vendorsRouter);

// Operational Training Layer (Help / Knowledge Base)
// Endpoints under /api/help/*. See api/help.js and
// migrations/011_knowledge_base.sql for the schema.
// Drop a vendor admin guide / SOP / agreement -> the AI extracts text
// page-by-page, chunks + embeds, stores for semantic retrieval. Ask a
// question -> top chunks retrieved -> the AI synthesizes answer in the
// askEd 4-part template (Action / Output / Reasoning / Watch Outs) with
// source citations. Breaks vendor support-tier extraction; encodes tribal
// knowledge that survives staff turnover.
const { router: helpRouter } = require('./api/help');
app.use('/api/help', helpRouter);

// Community profile + facts (per-community operational knowledge layer)
const { router: communityProfileRouter, buildCommunityContextBlock } = require('./api/communities');
app.use('/api/community-profile', communityProfileRouter);

// askEd tools — deterministic function-calling for vendor lookups, etc.
const askEdTools = require('./lib/askEdTools');

// Community events (planning, vendors, waivers + attendance, reporting)
const { router: eventsRouter } = require('./api/events');
app.use('/api/events', eventsRouter);

// Email intelligence — intake + extraction + recaps
const { router: emailIntakeRouter } = require('./api/email_intake');
app.use('/api/email-intelligence', emailIntakeRouter);

// ARC historical decisions — structured library of past approvals/denials
// (informational context for the AI assessment engine; never binding precedent)
const { router: arcHistoryRouter } = require('./api/arc_history');
app.use('/api/arc-history', arcHistoryRouter);

// Board portal — property tile + community summary surfaces
// (project_board_portal.md). Today: staff-auth-gated v0 with full portfolio
// visibility. Future: board-member auth, scoped to their community only.
const { router: boardPortalRouter } = require('./api/board_portal');
app.use('/api/board-portal', boardPortalRouter);

// Owner Receivables — Vantaca AR ingest + snapshot store + portfolio view
// (project_owner_receivables.md). Bridge to full accounting integration.
const { router: ownerArRouter } = require('./api/owner_ar');
app.use('/api/owner-ar', ownerArRouter);

// Portal Admin — manage who has access to the board + homeowner portals
// (project_portal_release_gates.md). Auth enforcement on the portals comes
// in a follow-up commit; this admin layer is the input the auth needs.
const { router: portalAdminRouter } = require('./api/portal_admin');
app.use('/api/portal-admin', portalAdminRouter);

// ACC applications — public submission + AI assessment + manager queue
const { router: applicationsRouter } = require('./api/applications');
app.use('/api/applications', applicationsRouter);

// Builder ARC — new-construction submissions from builders (DRB at August Meadows, etc.)
// Separate intake (portal + email ingest), shared review backend, isolated precedent storage.
const { router: builderApplicationsRouter } = require('./api/builder_applications');
app.use('/api/builder-applications', builderApplicationsRouter);

// Universal Stripe Connect payments — used by amenity rentals today, future
// ARC fees + key fobs + builder review fees tomorrow. Per project_payment_rails.md
// anti-commingling rule: HOA-side fees route to per-HOA connected accounts;
// Bedrock platform fees stay on the platform. Webhook handler uses raw body.
const { router: paymentsRouter } = require('./api/payments');
app.use('/api/payments', paymentsRouter);

// Homeowner portal — the customer-UX showcase. Magic-link auth (no passwords),
// scoped to one property, tile grid renders live / coming-soon modules per
// community config. ?demo=1 mode lets Ed pitch prospective communities with a
// realistic mockup before they have real homeowner data.
const { router: portalRouter } = require('./api/portal');
app.use('/api/portal', portalRouter);

// Amenities + amenity rentals — public form intake, admin queue, calendar
// availability. Used by /clubhouse/:slug form and future amenity map.
const { router: amenitiesRouter } = require('./api/amenities');
app.use('/api/amenities', amenitiesRouter);

// Ownership change proposals — review queue for ownership transitions
// from Vantaca imports. Staff approves/rejects from the admin tab.
const { router: ownershipProposalsRouter } = require('./api/ownership_proposals');
app.use('/api/ownership-proposals', ownershipProposalsRouter);

// Reserve studies — components, expenditures, board-facing map data.
// Powers the reserve study map and admin UI per project_reserve_study_map memory.
const { router: reserveStudiesRouter } = require('./api/reserve_studies');
app.use('/api/reserve-studies', reserveStudiesRouter);

// Per-community contact directory (sheriff, utilities, trash, TV/internet).
// Powers the Local Contacts tile on the homeowner portal + future welcome
// packets. See project_integration_depth_moat memory note.
const { router: communityContactsRouter } = require('./api/community_contacts');
app.use('/api/community-contacts', communityContactsRouter);

// Meeting check-in — annual-meeting in-person sign-in + quorum evidence.
// Reads voter rosters/ballot status from the SEPARATE voting Supabase
// (read-only, via VOTING_SUPABASE_URL + VOTING_SUPABASE_PUBLISHABLE_KEY
// env vars). Writes only to trustEd's meeting_attendance +
// meeting_election_settings tables. See migration 102.
const { router: meetingCheckinRouter } = require('./api/meeting_checkin');
app.use('/api/meeting-checkin', meetingCheckinRouter);

// Public clubhouse rental form + post-Stripe success page
app.get('/clubhouse/:slug', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'clubhouse.html'));
});
app.get('/clubhouse/:slug/success', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'clubhouse-success.html'));
});

// Homeowner portal dynamic routes — /portal (landing) and /portal/* (sub-pages)
app.get('/portal', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'portal.html'));
});
app.get('/portal/property',  (req, res) => res.sendFile(require('path').join(__dirname, 'public', 'portal-property.html')));
app.get('/portal/balance',   (req, res) => res.sendFile(require('path').join(__dirname, 'public', 'portal-balance.html')));
app.get('/portal/compliance',(req, res) => res.sendFile(require('path').join(__dirname, 'public', 'portal-compliance.html')));
app.get('/portal/documents', (req, res) => res.sendFile(require('path').join(__dirname, 'public', 'portal-documents.html')));
app.get('/portal/meetings',  (req, res) => res.sendFile(require('path').join(__dirname, 'public', 'portal-meetings.html')));
app.get('/portal/contacts',  (req, res) => res.sendFile(require('path').join(__dirname, 'public', 'portal-contacts.html')));
app.get('/portal/map',       (req, res) => res.sendFile(require('path').join(__dirname, 'public', 'portal-map.html')));
app.get('/portal/payments',  (req, res) => res.sendFile(require('path').join(__dirname, 'public', 'portal.html')));

// Public builder submission form — /builders/:slug serves builder-submit.html.
// The form reads :slug from the path and calls /api/builder-applications/public/community/:slug
// to populate community-specific copy + the design guidelines link.
app.get('/builders/:slug', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'builder-submit.html'));
});
app.get('/builders/status/:reference', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'builder-submit-status.html'));
});

// Public homeowner-facing pages (no auth)
app.get('/apply/status/:reference', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'apply_status.html'));
});
app.get('/apply/:slug', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'apply.html'));
});
// One-URL-per-community landing page (lists all public services + status check + askEd)
app.get('/c/:slug', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'community_landing.html'));
});

// Pool / key fob request — transactional, no AI assessment
app.get('/fob/:slug', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'fob_request.html'));
});

// Shared helper: scrub vendor names from error messages before they reach
// the user. Anthropic SDK errors can include "claude" / model IDs that
// should never appear in user-facing strings.
const { safeErrorMessage } = require('./api/_safe_error');

// Public event page — served from /event/:slug → returns the standalone HTML
app.get('/event/:slug', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'event.html'));
});

// Staff check-in page — gated by 6-digit code on the page itself
app.get('/event/:slug/checkin', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'event_checkin.html'));
});

// Documents Tracker — Bedrock's canonical document library.
// Endpoints under /api/documents/*. See api/documents.js and
// migrations/012_documents_module.sql for the schema.
// Drop a PDF -> the AI extracts metadata (community, category, period,
// status) + structured fields (insurance premium, budget total, etc.).
// Files stored in Supabase Storage with normalized filenames. Dedup
// detection across byte-identical, content-identical, and semantic-match
// patterns. Per-community matrix view. Natural-language retrieval.
// Predecessor tagging based on community management history.
const { router: documentsRouter } = require('./api/documents');
app.use('/api/documents', documentsRouter);

// Board Packets — Bedrock board packet generator
// Endpoints under /api/board-packets/*. See api/board_packets.js and
// migrations/014_board_packets.sql for the schema.
// Pick community + period -> get 11 canonical sections (cover, agenda,
// financials, DRV, AR aging, etc.) each accepting manual / upload /
// auto-from-trustEd input. the AI extracts uploaded PDFs into structured
// data per section. AI-generates exec summary + watch-outs from assembled
// data. Renders as Bedrock-branded HTML/PDF (Day 3) using the design
// language from /public/board_packet_preview.html.
const { router: boardPacketsRouter } = require('./api/board_packets');
app.use('/api/board-packets', boardPacketsRouter);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// Bedrock's management_company_id — matches the seed UUID in the SQL migration.
// Track 2 discipline: every record uses this for now; later, we look it up
// from authenticated user instead of hardcoding.
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const GLOBAL_RULES = `
TEXAS LEGAL COMPLIANCE — MANDATORY FOR ALL COMMUNICATIONS:

TEXAS PROPERTY CODE CHAPTER 209 — ENFORCEMENT NOTICES:
- All violation and fine notices must include the specific CC&R provision violated
- Homeowner must be given a minimum 30-day cure period before fines are imposed
- Homeowner must be explicitly notified of their right to request a hearing before the Board of Directors before fines begin
- Never use "effective immediately" in enforcement notices — always provide a cure period
- Fine notices must be sent to the owner's mailing address on file, not just the property address
- Property owners are financially liable for all fines regardless of whether a tenant is the occupant

TOWING:
- Never authorize or threaten towing in any communication without confirming the board has formally voted to establish a towing program
- A valid towing program requires a licensed towing company contract, proper signage, and compliance with the Texas Towing and Booting Act
- If towing has not been properly established, remove any towing language from communications

FAIR HOUSING ACT:
- Never take or recommend action based on who someone is — only on documented behavior
- Enforcement must be consistent and applied equally to all homeowners regardless of race, religion, national origin, disability, familial status, or sex
- If a situation raises Fair Housing concerns flag it explicitly before recommending action

HOMEOWNER PRIVACY — NON-NEGOTIABLE:
- Never disclose enforcement actions, violation history, or compliance status of one homeowner to another
- When a neighbor asks about action taken against another homeowner always respond: "The Association handles compliance matters directly with the homeowner involved and does not share details regarding enforcement actions"
- Never share owner or tenant personal contact information with neighbors or third parties

LETTER AUTHORITY AND SIGNATURES:
- Enforcement letters are issued by the Board of Directors — ${BRAND.service.name} acts as agent on their behalf
- Always sign enforcement letters as "${BRAND.service.name}, on behalf of the [Community] Board of Directors"
- Never sign as if ${BRAND.service.short} is the enforcing authority
- Never use a personal name in any signature — always sign as ${BRAND.service.name}

PROHIBITED LANGUAGE IN ALL COMMUNICATIONS:
- Never use "effective immediately" in enforcement or violation notices
- Never use "the Board has determined" when a direct warm answer works
- Never use cold corporate language with homeowners — warm and professional always
`;

// Reindex helpers live in lib/library_reindex.js so both server.js and the
// documents router (api/documents.js) can share them — the documents router
// auto-indexes on upload; this file exposes the manual backfill routes.
const {
  communityNameVariations: _communityNameVariations,
  indexLibraryDoc,
} = require('./lib/library_reindex');

// ----------------------------------------------------------------------------
// Stopword list for the keyword half of hybrid retrieval. We strip these
// before running ILIKE searches so "what's the quorum at Canyon Gate" doesn't
// also match every chunk containing "the" / "at" / "is".
// ----------------------------------------------------------------------------
const HYBRID_STOPWORDS = new Set([
  'a','an','and','are','as','at','be','been','being','but','by','can','could',
  'did','do','does','for','from','had','has','have','having','he','her','here',
  'his','how','i','if','in','into','is','it','its','just','many','me','more',
  'most','much','my','no','not','now','of','on','one','only','or','our','out',
  'over','same','she','should','so','some','such','than','that','the','their',
  'them','then','there','these','they','this','those','to','too','under','up',
  'us','very','was','we','were','what','whats','when','where','which','while',
  'who','why','will','with','would','you','your','yours',
]);

// Extract keyword tokens for the keyword half of hybrid retrieval.
function extractKeywords(text) {
  if (!text) return [];
  // Lowercase + keep alphanumerics + a few punctuation we care about
  // (§ for statute numbers, % for percent, $ for dollars)
  const tokens = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9§%$\s.-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((t) => t && t.length > 2 && !HYBRID_STOPWORDS.has(t));
  // De-dup, cap at 8 to keep ILIKE OR clause manageable
  return Array.from(new Set(tokens)).slice(0, 8);
}

// ----------------------------------------------------------------------------
// getRelevantChunks — HYBRID retrieval (vector + keyword)
// ----------------------------------------------------------------------------
// Why hybrid: vector search is great for "tell me about X" / concept questions
// but routinely misses exact-fact chunks when multiple chunks in the same
// document score similarly. We hit this hard on 2026-05-22 with the Canyon
// Gate quorum question: the chunk containing "twenty-five percent (25%)" was
// loaded and indexed, but the vector search ranked the longer "reconvening
// rule" chunk higher and never returned the % chunk. Meanwhile the legacy
// Documents tab (keyword ILIKE) would have surfaced it instantly.
//
// Fix: run BOTH searches in parallel, merge results with Reciprocal Rank
// Fusion (vector-rank + keyword-rank), dedupe by content, cap to 18 chunks.
// Vector still drives semantic relevance; keyword acts as a safety net for
// precise-fact lookups (numbers, %, $ amounts, statute citations, vendor
// names, etc.).
//
// See CLAUDE.md scar: "Parallel retrieval silos — hybrid not optional."
// ----------------------------------------------------------------------------
const HYBRID_K = 18;          // total chunks returned to the model
const VECTOR_K = 15;          // vector results before merge
const KEYWORD_K = 10;         // keyword results before merge
const RRF_C = 60;             // RRF damping constant; standard value

async function getRelevantChunks(text, community) {
  const communities = ['Law', 'General', ..._communityNameVariations(community)];

  // --- Vector half (embedding search) ---
  const vectorPromise = (async () => {
    try {
      const embeddingResponse = await openai.embeddings.create({
        model: 'text-embedding-ada-002',
        input: text.replace(/\n/g, ' ').slice(0, 8000),
      });
      const queryEmbedding = embeddingResponse.data[0].embedding;
      const { data: chunks, error } = await supabase.rpc('match_documents', {
        query_embedding: queryEmbedding,
        match_count: VECTOR_K,
        filter_communities: communities,
      });
      if (error) {
        console.warn('[hybrid-retrieval] vector half failed:', error.message);
        return [];
      }
      return chunks || [];
    } catch (err) {
      console.warn('[hybrid-retrieval] vector half threw:', err.message);
      return [];
    }
  })();

  // --- Title-match half (library_documents.title ILIKE) ---
  //
  // Most powerful signal for exact-fact lookups: when a document is LITERALLY
  // titled "Amendment to Bylaws Regarding Quorum," that doc is by far the
  // best answer to "what's the quorum?" — better than any single chunk.
  // The PDF filename ("Canyon Gate at Cinco Ranch - Bylaws - 2020 -
  // Approved.pdf") doesn't help here because dates don't tell us what's
  // inside. The curated library_documents.title does.
  //
  // Strategy: for each keyword, find library_documents whose TITLE contains
  // it. For any matching doc, pull up to 8 chunks. These get prepended to
  // the merge with a high RRF boost so the model always sees them.
  const titleMatchPromise = (async () => {
    const keywords = extractKeywords(text);
    if (keywords.length === 0) return [];
    try {
      const titleOrFilter = keywords.map((kw) => `title.ilike.%${kw.replace(/[%_]/g, '')}%`).join(',');
      const { data: docs, error } = await supabase
        .from('library_documents')
        .select('id, title, communities:community_id(name)')
        .or(titleOrFilter)
        .limit(30);
      if (error) {
        console.warn('[hybrid-retrieval] title-match half failed:', error.message);
        return [];
      }
      const communityLower = new Set(communities.map((c) => String(c || '').toLowerCase()));
      const eligibleDocs = (docs || []).filter((d) => {
        const cname = String(d.communities?.name || '').toLowerCase();
        return communityLower.has(cname) || communities.includes('General') || communities.includes('Law');
      });
      if (eligibleDocs.length === 0) return [];

      // Tokenize the community name so we can DISCOUNT community-name keywords
      // when scoring title matches. For Canyon Gate question, "canyon" and
      // "gate" in a title are just community noise; "quorum" in a title is
      // the actual signal. Without this, every "Canyon Gate ..." titled doc
      // ranks the same and the truly specific match ("Amendment to Bylaws
      // Regarding Quorum") gets buried.
      const communityTokens = new Set(
        (community || '').toLowerCase().split(/\s+/).filter((t) => t && t.length > 2)
      );
      const discriminatingKeywords = keywords.filter((kw) => !communityTokens.has(kw));

      // Score each doc by:
      //   discriminating-keyword title matches (×3)  +  community-keyword title matches (×1)
      // Docs with rare-keyword title hits float to the front.
      const scoredDocs = eligibleDocs.map((d) => {
        const titleLower = String(d.title || '').toLowerCase();
        const discMatches = discriminatingKeywords.filter((kw) => titleLower.includes(kw)).length;
        const commMatches = keywords.filter((kw) => communityTokens.has(kw) && titleLower.includes(kw)).length;
        return { doc: d, score: 3 * discMatches + commMatches };
      }).sort((a, b) => b.score - a.score);

      // Pull chunks in doc-score order so chunks from the best title-match
      // arrive first in the flattened output (which drives their RRF rank).
      const chunkResults = await Promise.all(scoredDocs.map(async ({ doc }) => {
        const { data, error: e2 } = await supabase
          .from('documents')
          .select('content, metadata')
          .eq('metadata->>library_document_id', doc.id)
          .limit(8);
        if (e2) {
          console.warn(`[hybrid-retrieval] title-match chunks for "${doc.title}" failed:`, e2.message);
          return [];
        }
        return data || [];
      }));
      const flat = chunkResults.flat();
      console.log(`[hybrid-retrieval] title-match found ${eligibleDocs.length} docs (top: "${scoredDocs[0]?.doc?.title}"), ${flat.length} chunks`);
      return flat;
    } catch (err) {
      console.warn('[hybrid-retrieval] title-match half threw:', err.message);
      return [];
    }
  })();

  // --- Keyword half (ILIKE — per-keyword fanout, then re-rank by multi-hit) ---
  //
  // Two-pass strategy that solves the "wrong doc crowding out the right doc"
  // problem (Canyon Gate quorum: 2 bylaws docs, the older one had 9 chunks
  // matching "quorum" and filled the limit before the 2020 amendment's 25%
  // chunk ever made it in):
  //
  //  Pass 1 — for EACH extracted keyword, fetch its own top-N matching
  //   chunks (community-scoped). One keyword can't crowd out another.
  //  Pass 2 — count how many DISTINCT keywords each chunk matches.
  //   Chunks matching multiple keywords are higher signal and rank first.
  //
  // This keeps single-keyword recall (a chunk that just happens to mention
  // "quorum") while ensuring multi-keyword chunks ("quorum" + "canyon" +
  // "twenty-five" etc.) get surfaced.
  const keywordPromise = (async () => {
    const keywords = extractKeywords(text);
    if (keywords.length === 0) return [];
    const communityLower = new Set(communities.map((c) => String(c || '').toLowerCase()));
    try {
      // Fan out: per-keyword fetch, parallel. We pull a LARGE window per
      // keyword (500 rows) because Postgres ILIKE returns rows in physical
      // insertion order with no ranking — a small limit can crowd out the
      // right answer when many chunks match (we hit this 2026-05-22 with
      // Canyon Gate quorum: the 2020 amendment's "25%" chunk lived past
      // row 40 in physical order, so the prior limit=40 never saw it).
      //
      // Community-filtering + multi-keyword re-rank below does the actual
      // quality work — the big window just guarantees the right chunk is
      // in the candidate pool. At ~50K rows, an ILIKE seq scan at limit
      // 500 is still sub-100ms.
      const perKwResults = await Promise.all(
        keywords.map(async (kw) => {
          const { data, error } = await supabase
            .from('documents')
            .select('content, metadata')
            .ilike('content', `%${kw.replace(/[%_]/g, '')}%`)
            .limit(500);
          if (error) {
            console.warn(`[hybrid-retrieval] keyword "${kw}" failed:`, error.message);
            return { kw, rows: [] };
          }
          // Filter by community right here
          const rows = (data || []).filter((row) => {
            const c = String(row.metadata?.community || '').toLowerCase();
            return communityLower.has(c);
          });
          return { kw, rows };
        })
      );

      // Re-rank by:
      //   (a) keywords matched in chunk CONTENT
      //   (b) keywords matched in the parent doc's FILENAME (counts double —
      //       a doc titled "Amendment to Bylaws Regarding Quorum" is much
      //       stronger signal than a chunk that just happens to say "quorum")
      //
      // This solves the case where the exact-fact chunk only contains one of
      // the query keywords ("quorum") because chunking split it away from the
      // community-name context ("Canyon Gate"). The filename carries the
      // missing context. Without this, the 25% chunk in
      // "Canyon Gate at Cinco Ranch - Bylaws - 2020 - Approved.pdf" only
      // matched "quorum" and got buried by chunks matching 4-5 keywords each.
      const byKey = new Map();
      const keyOf = (row) => `${(row.content || '').slice(0, 200)}::${row.metadata?.filename || ''}`;
      for (const { kw, rows } of perKwResults) {
        for (const row of rows) {
          const k = keyOf(row);
          const ex = byKey.get(k);
          if (ex) { ex.matchedKeywords.add(kw); }
          else byKey.set(k, { row, matchedKeywords: new Set([kw]) });
        }
      }
      // Now boost each chunk by filename-keyword matches.
      for (const entry of byKey.values()) {
        const fname = String(entry.row.metadata?.filename || '').toLowerCase();
        const titleHits = keywords.filter((kw) => fname.includes(kw));
        // titleHits add 2 points each (vs 1 for a content-keyword hit), so
        // doc-title strong matches outrank generic content keyword overlap.
        entry.score = entry.matchedKeywords.size + 2 * titleHits.length;
        entry.titleKeywords = new Set(titleHits);
      }

      const ranked = Array.from(byKey.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, KEYWORD_K);

      return ranked.map((r) => r.row);
    } catch (err) {
      console.warn('[hybrid-retrieval] keyword half threw:', err.message);
      return [];
    }
  })();

  const [vectorChunks, keywordChunks, titleMatchChunks] = await Promise.all([
    vectorPromise, keywordPromise, titleMatchPromise,
  ]);

  // --- Reciprocal Rank Fusion merge ---
  // Score(chunk) = sum over each result set it appears in of
  //   1 / (RRF_C + rank_in_that_set).
  // Title-match chunks get a 3x weight bonus because doc-title is the
  // strongest signal for "what's the X" factual lookups — a doc literally
  // titled "Amendment to Bylaws Regarding Quorum" should always surface
  // on a quorum question.
  // Dedupe by content (first 200 chars hash).
  const byKey = new Map();
  const keyOf = (row) => `${(row.content || '').slice(0, 200)}::${row.metadata?.filename || ''}`;

  titleMatchChunks.forEach((row, i) => {
    const k = keyOf(row);
    const score = 3 / (RRF_C + i + 1); // 3x boost — strongest signal
    const existing = byKey.get(k);
    if (existing) { existing.score += score; existing.sources.add('title'); }
    else byKey.set(k, { row, score, sources: new Set(['title']) });
  });
  vectorChunks.forEach((row, i) => {
    const k = keyOf(row);
    const score = 1 / (RRF_C + i + 1);
    const existing = byKey.get(k);
    if (existing) { existing.score += score; existing.sources.add('vector'); }
    else byKey.set(k, { row, score, sources: new Set(['vector']) });
  });
  keywordChunks.forEach((row, i) => {
    const k = keyOf(row);
    const score = 1 / (RRF_C + i + 1);
    const existing = byKey.get(k);
    if (existing) { existing.score += score; existing.sources.add('keyword'); }
    else byKey.set(k, { row, score, sources: new Set(['keyword']) });
  });

  const merged = Array.from(byKey.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, HYBRID_K);

  const dualHits = merged.filter((m) => m.sources.size >= 2).length;
  console.log(`[hybrid-retrieval] community="${community || '(all)'}" vector=${vectorChunks.length} keyword=${keywordChunks.length} title=${titleMatchChunks.length} merged=${merged.length} multi-source=${dualHits}`);

  return merged.map(({ row, sources }) => {
    const ocrTag = row.metadata?.ocr ? " — OCR'd scan, may have minor errors" : '';
    const sources_arr = [...sources];
    const sourceTag = sources_arr.length >= 2 ? ` — matched ${sources_arr.join('+')}` : '';
    return `[From: ${row.metadata?.filename} - ${row.metadata?.community}${ocrTag}${sourceTag}]\n${row.content}`;
  }).join('\n\n---\n\n');
}

// DEPRECATED 2026-05-17 — the "Ask a Question" tab in trustEd was folded into
// askEd's Advisor mode. The askEd Advisor (POST /ask-ed) supersedes this:
// same RAG, plus playbook + community profile + attachments + tool access.
// This endpoint is kept as a backward-compat stub in case any external caller
// (bookmark, voice helper, etc.) still hits it. Remove once verified unused
// for a full cycle.
app.post('/ask', async (req, res) => {
  try {
    const { question, community, history = [] } = req.body;
    const context = await getRelevantChunks(question, community);
    const messages = [
      ...history.slice(-6),
      {
        role: 'user',
        content: `Here are relevant sections from HOA governing documents, law, and general resources:\n\n${context}\n\nQuestion: ${question}\n\nAnswer based on the documents. Be specific and cite which document the answer comes from. If not in the documents, say so clearly.`
      }
    ];
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: `You are a helpful assistant for ${BRAND.service.name}. You are currently answering questions about ${community || 'an HOA community'}. Be conversational, clear, and helpful. Cite the specific document when you find information. Law and General documents apply to all communities.`,
      messages
    });
    res.json({ answer: response.content[0].text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ answer: 'Search error. Please try again.' });
  }
});

// DEPRECATED 2026-05-17 — the "Draft Email" tab was folded into askEd's Draft
// mode (POST /ask-ed with the user input wrapped as a "draft a reply to this
// homeowner email" prompt). The askEd Draft mode supersedes this: it uses the
// full askEd persona + community profile, producing better results.
// Backward-compat stub. Remove once verified unused for a full cycle.
app.post('/draft', async (req, res) => {
  try {
    const { email, community, additionalContext } = req.body;
    const docContext = await getRelevantChunks(email, community);
    const { data: playbookEntries } = await supabase
  .from('playbook')
  .select('*')
  .or('category.eq.General,category.eq.Homeowner Complaint,category.eq.Board Relations,category.eq.Legal/Compliance,category.eq.Collections,category.is.null')
  .order('created_at', { ascending: false })
  .limit(50);

const playbookContext = playbookEntries?.length
  ? `\n\nINSTITUTIONAL GUIDELINES FROM PAST COMMUNICATIONS:\n\n${playbookEntries.map(p =>
      `SITUATION: ${p.situation}\nAPPROACH: ${p.response}\nREASONING: ${p.reasoning || 'Not specified'}`
    ).join('\n\n---\n\n')}\n`
  : '';
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: `${GLOBAL_RULES}

You are a professional HOA property manager working for ${BRAND.service.name}. Draft courteous, professional email responses to homeowner inquiries.

CRITICAL RULES:
- Answer the specific question asked in the first or second sentence — never dodge or evade
- Never use corporate language like "the Board has determined" when a simple direct answer works
- Keep responses concise — a simple question deserves a simple answer not a lengthy formal response
- Be warm and human — homeowners are people not case numbers
- Always include a greeting, the direct answer, and a warm close
- If you don't know the specific answer say so and offer to find out
- When a homeowner confuses a board meeting with the annual meeting explain the difference clearly, validate what they got right, and preview what is coming next
- When a board member uses the word audit in the context of property conditions, things looking rough, or violations it ALWAYS means DRV deed restriction violation inspection — never ask them to clarify, never confirm which type of audit they mean, just treat it as a DRV inspection and respond accordingly. Only treat it as a financial audit if they are specifically and explicitly referencing financials, accounting, budgets, or money with no mention of property conditions
- Sign off as "${BRAND.service.name}" — never use a personal name
- Aim for the shortest response that fully answers the question — edit out unnecessary words`,
      messages: [{
        role: 'user',
        content: `You are responding on behalf of ${community || 'the HOA'}.\n\nRelevant governing documents:\n\n${docContext}\n${playbookContext}\n${additionalContext ? `Additional context about this community or situation: ${additionalContext}\n\n` : ''}Homeowner email to respond to:\n\n${email}\n\nDraft a professional response email that directly answers the question asked. Keep it concise and warm. Use any additional context provided to personalize the response.`
      }]
    });
    res.json({ draft: response.content[0].text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ draft: 'Error generating draft. Please try again.' });
  }
});

app.post('/acc-review', upload.any(), async (req, res) => {
  try {
    const { community, details: typedDetails, notes, additionalContext, decision, conditions } = req.body;
    const files = req.files || [];
    const pdfFile = files.find((f) => f.fieldname === 'pdf');
    const imageFiles = files.filter((f) => f.fieldname === 'images');
    if (!pdfFile && imageFiles.length === 0 && !(typedDetails && typedDetails.trim())) {
      return res.status(400).json({ error: 'Provide application details, a PDF, or photos.' });
    }

    // Build the multimodal content array for extraction. The vision model sees
    // the PDF AND every photo (and any brochure PDFs in the photos field),
    // then produces a unified summary that includes what's visible in the
    // photos (color, scale, materials, neighbor context).
    const extractContent = [];
    if (pdfFile) {
      extractContent.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: pdfFile.buffer.toString('base64') },
      });
    }
    for (const img of imageFiles) {
      // Brochures + manufacturer color cards often come as PDFs even though
      // they live in the "photos / samples" field. Route those as document
      // blocks (Claude reads embedded images + text) instead of trying to
      // shoehorn them through the image pipeline.
      const isPdf = (img.mimetype === 'application/pdf') || /\.pdf$/i.test(img.originalname || '');
      if (isPdf) {
        extractContent.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: img.buffer.toString('base64') },
        });
        continue;
      }
      const mt = img.mimetype && img.mimetype.startsWith('image/') ? img.mimetype : 'image/jpeg';
      const shrunk = await shrinkImageForAnthropic(img.buffer, mt);
      extractContent.push({
        type: 'image',
        source: { type: 'base64', media_type: shrunk.mimetype, data: shrunk.buffer.toString('base64') },
      });
    }

    const extractText =
      `You are extracting facts from an HOA Architectural Control Committee (ACC) application package. The package may include a PDF application form and one or more photos (the property today, neighboring fences/structures for context, contractor renderings, or color/material samples).\n\n` +
      `Extract and list every concrete detail you can identify, both from the PDF AND from each photo. Be thorough — your output is the only thing downstream reviewers will see:\n\n` +
      `FROM THE APPLICATION FORM:\n- Homeowner name, address, phone, email\n- Project type (fence, pool, deck, paint, roof, room addition, etc.)\n- Written description / scope of work\n- Materials stated (with brand/grade if given)\n- Colors stated (with color name / hex / sample number if given)\n- Dimensions (height, length, width, square footage)\n- Setbacks / distances from property lines\n- Contractor name + license if listed\n- Start / completion dates\n- Estimated cost\n- Anything signed or dated\n\n` +
      `FROM EACH PHOTO (label them Photo 1, Photo 2, etc.):\n- Describe what you see plainly — the structure, the material, the color, the surroundings\n- Estimate scale where possible (compare to a door, person, car if visible)\n- Note neighbor properties visible in frame (e.g., adjacent fence height, paint color)\n- Note property condition issues that may matter to the review (drainage slope, easement markers, utility boxes, trees)\n- If a photo appears to be a contractor rendering vs an existing condition, say so\n\n` +
      `CROSS-CHECK:\n- If the application says one thing and a photo shows another, flag the discrepancy explicitly\n- If something a complete application normally has is MISSING (no survey, no dimensions, no contractor), flag it explicitly\n\n` +
      (typedDetails && typedDetails.trim() ? `\nALSO factor in these additional details typed by the manager:\n${typedDetails.trim()}\n` : '') +
      `\nOutput a clear structured summary the ACC reviewer can use to make a decision. Do not approve or deny — just extract.\n\n` +
      `IMPORTANT: At the very end of your output, on its own line, append a single-line JSON object with these exact keys (use null when a field truly is not present — do NOT invent values):\n` +
      `<<<EXTRACTED_JSON>>>{"homeowner_name":"...","homeowner_address":"...","project_summary":"... (one line, e.g., '6ft cedar fence — rear yard')","reference_number":"..." }<<<END_JSON>>>\n` +
      `homeowner_address should be street address + city/state if available. project_summary is a single-line description suitable for a "Re:" line on a letter. reference_number is whatever application reference is on the document.`;
    extractContent.push({ type: 'text', text: extractText });

    // Opus 4.7 has the strongest vision recall for material/color/scale — use it
    // for the extract step. The downstream decision call stays on Sonnet 4.6 for cost.
    const extractResponse = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 2000,
      messages: [{ role: 'user', content: extractContent }],
    });

    const rawExtract = extractResponse.content[0].text;
    // Pull out the structured JSON block at the end of the extract — used to
    // auto-fill the decision letter form on the client. Strip it from the
    // text shown to the decision model so the JSON doesn't muddy the prompt.
    let extracted = { homeowner_name: null, homeowner_address: null, project_summary: null, reference_number: null };
    let appDetails = rawExtract;
    const m = rawExtract.match(/<<<EXTRACTED_JSON>>>([\s\S]*?)<<<END_JSON>>>/);
    if (m) {
      try {
        const parsed = JSON.parse(m[1].trim());
        extracted = {
          homeowner_name: parsed.homeowner_name || null,
          homeowner_address: parsed.homeowner_address || null,
          project_summary: parsed.project_summary || null,
          reference_number: parsed.reference_number || null,
        };
      } catch (e) {
        console.warn('[acc-review] extracted JSON parse failed:', e.message);
      }
      appDetails = rawExtract.replace(/<<<EXTRACTED_JSON>>>[\s\S]*?<<<END_JSON>>>/, '').trim();
    }

    // FALLBACK — when the JSON block was dropped (long extract, model
    // truncation, delimiter drift), do a small focused second call against
    // the ALREADY-EXTRACTED text. Tiny + reliable, ~$0.001 per call.
    const needsFallback = !extracted.homeowner_name || !extracted.homeowner_address;
    if (needsFallback && appDetails && appDetails.length > 100) {
      try {
        const fallback = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          messages: [{ role: 'user', content:
            `From the ACC application extract below, output a single-line JSON object with these EXACT keys (use null only if truly absent — homeowner name is always required on these applications, do your best):\n\n` +
            `{"homeowner_name":"first last","homeowner_address":"street, city ST zip","project_summary":"one-line description","reference_number":"if present"}\n\n` +
            `Ignore HOA / management company names — homeowner_name is the property owner who submitted the application, not Bedrock or the Association. Output ONLY the JSON object, nothing else.\n\n` +
            `EXTRACT:\n${appDetails.slice(0, 6000)}`
          }],
        });
        const txt = (fallback.content[0] && fallback.content[0].text) || '';
        const jm = txt.match(/\{[\s\S]*\}/);
        if (jm) {
          const parsed = JSON.parse(jm[0]);
          extracted = {
            homeowner_name:    extracted.homeowner_name    || parsed.homeowner_name    || null,
            homeowner_address: extracted.homeowner_address || parsed.homeowner_address || null,
            project_summary:   extracted.project_summary   || parsed.project_summary   || null,
            reference_number:  extracted.reference_number  || parsed.reference_number  || null,
          };
        }
      } catch (e) {
        console.warn('[acc-review] fallback extraction failed:', e.message);
      }
    }
    const context = await getRelevantChunks(appDetails, community);

    const { data: playbookEntries } = await supabase
  .from('playbook')
  .select('*')
  .or('category.eq.ACC/Violations,category.eq.General,category.eq.Legal/Compliance,category.is.null')
  .order('created_at', { ascending: false })
  .limit(50);

const playbookContext = playbookEntries?.length
  ? `\n\nINSTITUTIONAL GUIDELINES FROM PAST ACC REVIEWS:\nApply the following principles and patterns from prior cases when reviewing this application. These represent how Bedrock has handled similar situations and what to watch for.\n\n${playbookEntries.map(p =>
      `SITUATION: ${p.situation}\nAPPROACH: ${p.response}\nREASONING: ${p.reasoning || 'Not specified'}`
    ).join('\n\n---\n\n')}\n`
  : '';
    const reviewResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      system: `${GLOBAL_RULES}

You are an expert HOA Architectural Control Committee (ACC) reviewer for ${BRAND.service.name}. You think and decide like Ed Gojara — a CPA with audit-firm training (Big Four + regional firm Principal) and an operations background from a high-frequency trading desk, applied to 15+ years of HOA management. You review applications thoroughly, apply sound judgment, and produce professional approval or denial letters.

DECISION FRAMEWORK:

COMPLETENESS CHECK — before reviewing merit, check if the application is complete:
- Plot plan or survey showing location and dimensions on the lot
- Distances from property lines and easements
- Materials, colors, dimensions specified
- Contractor identified if applicable
- Signed by homeowner
- If incomplete — do not deny, request missing items with a friendly incomplete notice

MERIT REVIEW — after confirming completeness, review against governing documents:
- Search for explicit rules covering the project type
- If no explicit rule exists use conformity, drainage, and aesthetics as review standards
- A project not explicitly prohibited is not automatically approved — use judgment
- Always cite the specific document section supporting your recommendation

JUDGMENT PRINCIPLES:
- Replacement of existing approved or accepted structures gets more favorable treatment than new installations
- Board member submissions get the same process as any homeowner — same standards, same letter — but delivered with extra warmth
- Gray areas where governing documents are silent should be decided based on conformity with community standards and impact on neighbors
- Drainage impact on neighboring lots is always a reason to require more information or add conditions
- When in doubt add conditions rather than deny outright — leave the door open
- Never approve something that clearly violates a specific governing document provision
- Always leave the door open for resubmission if denying

PRAGMATIC OVER RULE-OF-THE-LETTER — THIS IS HOW BEDROCK WINS:
Bedrock applies judgment, not checklists. Every letter must read as helpful and decisive — never bureaucratic. Reader test: "Would this letter make me feel helped or hassled?" Optimize for helped, every time.
- When submitted photos clearly show the color, material, finish, or condition: APPROVE based on the visible evidence. Do NOT request formula codes, paint chip numbers, color sample swatches, or other documentation that duplicates what the photos already prove. A clear paint-can photo is the color confirmation.
- Do NOT include "work-before-approval" admonishments unless the work is MATERIALLY nonconforming (wrong color, wrong location, wrong material, prohibited element, real drainage harm). If the actual work is fine and the homeowner started early while we were processing, the homeowner is not the problem. We share responsibility.
- If the application has been pending more than ~30 days, drop work-before-approval language entirely. The processing delay is on us.
- Asking for things visible in submitted evidence (color codes when photo is clear, dimensions when survey is attached, etc.) makes the homeowner think the process is a joke. It signals bureaucracy where there should be professional service.
- Box-ticking is the failure mode of generic property management AI. Bedrock's differentiator is encoded judgment — use it.

PROJECT TYPE STANDARDS:

POOLS AND SPAS:
- Require complete lot enclosure with self-closing self-latching gate
- Require drainage plan routing to street not neighbor's property
- Require detailed pool drawing with dimensions on survey
- Require licensed contractor identified
- Deck structures limited to community specific height requirements
- No access through common areas during construction
- Permits are homeowner's responsibility — always include permit disclaimer

FENCES:
- Must match community standard materials and height
- Cannot encroach on utility easements
- Must maintain required setbacks
- Gates must be self-closing and self-latching if pool is present
- Survey showing fence line placement required

GAZEBOS CANOPIES AND PATIO COVERS:
- Check community specific height restrictions — if not explicitly named apply storage structure height limits as a guide
- Replacement of existing accepted structures gets favorable treatment
- Must maintain setbacks from property lines and easements
- Posts concreted into ground make it a permanent structure — treat accordingly
- Materials should be consistent with home exterior

STORAGE SHEDS AND OUTBUILDINGS:
- Most communities limit to 8 feet height maximum
- Most communities limit to 100 square feet base maximum
- Must be placed behind main residential structure
- Cannot be in utility easements or within 5 feet of side property lines or 10 feet of rear property line
- Lot must be completely enclosed by fencing before outbuilding is permitted

EXTERIOR PAINTING:
- Require color samples — brand name and color name
- Photo of existing home required if custom color
- Colors must be consistent and cohesive with existing home and community
- Most communities do not allow stark or non-conforming colors

ROOFS:
- Require manufacturer brand type of shingles and color name
- Must use 30lb felt paper or better
- Contractor bid with full scope acceptable if product details not available

DRIVEWAYS AND CONCRETE WORK:
- Require location on survey with dimensions
- Materials must be specified
- Must not impact drainage to neighboring properties

LANDSCAPING AND TREE REMOVAL:
- Require reason for removal
- Arborist bid recommended for significant tree removal
- Replacement plan required
- Must show placement on survey

PLAY STRUCTURES AND BASKETBALL GOALS:
- Photo brochure or drawing required
- Height color and materials must be specified
- Location on survey with measurements from rear and side building lines required

LETTER FORMAT — always produce a complete professional letter:

For APPROVALS use this format:
[Date]
[Homeowner Name]
[Address]
[City State Zip]

Re: ACC Application Approval — [Project Type]
[Address]

Dear [Mr./Mrs. Last Name],

The Architectural Review Committee of [Community Name] has reviewed your application dated [date] for [project description].

Your application is approved subject to the following conditions:
[numbered list of conditions]

This approval is granted solely for compliance with [Community] governing documents and HOA architectural standards. This approval does not constitute or replace any required city county or municipal permits. The homeowner is solely responsible for obtaining all required governmental permits before beginning construction.

Please retain a copy of this letter for your records. If you have any questions please contact our office at ${BRAND.service.phone} or ${BRAND.service.email}.

On behalf of the [Community] Architectural Review Committee,
${BRAND.service.name}
On behalf of [Community] Homeowners Association
${BRAND.service.phone} | ${BRAND.service.website}

For INCOMPLETE APPLICATIONS use this format:
- Open warmly and thank them genuinely for submitting — be specific about what they did well
- Lead with excitement about the project before mentioning anything missing
- Frame missing items as "just a couple of things we need to wrap this up" — never a formal checklist
- Explain WHY each item is needed in one simple sentence of plain English
- Only call out the 1-2 most critical missing items — do not list every technical requirement
- For a pool or permanent structure the survey showing location is the only critical item — focus on that
- Write like a helpful neighbor who wants to get this approved — not a government agency processing a form
- Close with genuine enthusiasm — "we look forward to getting this approved for you"
- Never use words like cannot proceed, non-negotiable, foundational requirement, or formally incomplete
- The homeowner should feel helped and encouraged — not rejected or overwhelmed
- Keep the entire incomplete notice to 3-4 short paragraphs maximum

For DENIALS use this format:
Thank the homeowner, state the specific governing document provision that cannot be met, leave the door open for a revised application that addresses the issue, keep it professional and warm never harsh.

ALWAYS sign off as ${BRAND.service.name} — never use a personal name.

CRITICAL — APPEND A CLEAN LETTER BODY:
After your full response (whatever sections it has), append a homeowner-facing letter body wrapped in <<<LETTER_BODY>>>...<<<END_LETTER>>> markers. This block is what gets printed and mailed to the homeowner, so it must be PLAIN PROSE:
- Start with the salutation: "Dear Mr. and Mrs. ___," (use the actual courtesy title where appropriate; if first names are unisex or unknown, use "Dear [First Last],")
- Then 1-3 short body paragraphs explaining the decision in warm professional language
- If conditions apply, list them as a numbered list — "1. ...", "2. ...", etc.
- End with: "Please retain a copy of this letter for your records. If you have any questions please contact our office at ${BRAND.service.phone} or ${BRAND.service.email}."

The LETTER_BODY must NOT contain:
- ANY markdown headings (no #, ##, ###)
- ANY markdown bold/italic markers (no **, no _italic_)
- ANY internal section labels like "APPLICANT SUMMARY", "COMPLETENESS CHECK", "RECOMMENDATION", "CONDITIONS"
- A letterhead, return address, or recipient block — the template renders all of that
- A signature/closing — the template renders "On behalf of the [Community] ACC, ${BRAND.service.name}..." automatically
- The word "INTERNAL" or any analysis text — this is what the homeowner reads

Write LETTER_BODY in the warm, professional voice the homeowner will receive. The rest of your response (analysis, sections) is for the manager's reference and is shown separately in the admin UI.`,
      messages: [{
        role: 'user',
        content: await (async () => {
          const parts = [];
          if (pdfFile) {
            parts.push({
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdfFile.buffer.toString('base64') },
            });
          }
          for (const img of imageFiles) {
            // PDFs in the photos field (brochures, manufacturer color cards)
            // ride as document blocks — same as the primary application PDF.
            const isPdf = (img.mimetype === 'application/pdf') || /\.pdf$/i.test(img.originalname || '');
            if (isPdf) {
              parts.push({
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: img.buffer.toString('base64') },
              });
              continue;
            }
            const mt = img.mimetype && img.mimetype.startsWith('image/') ? img.mimetype : 'image/jpeg';
            const shrunk = await shrinkImageForAnthropic(img.buffer, mt);
            parts.push({
              type: 'image',
              source: { type: 'base64', media_type: shrunk.mimetype, data: shrunk.buffer.toString('base64') },
            });
          }
          parts.push({
            type: 'text',
            text: `Today's date: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}\n\nCommunity: ${community}\n\nExtracted application details:\n${appDetails}\n\n${additionalContext ? `IMPORTANT ADDITIONAL CONTEXT: ${additionalContext}\n\n` : ''}${conditions ? `Staff notes: ${conditions}\n\n` : ''}${notes ? `Additional notes: ${notes}\n\n` : ''}Relevant governing documents:\n${context}\n${playbookContext}\n${decision === 'approved with conditions' ? `STAFF DECISION: APPROVED WITH CONDITIONS\n\nThe staff has decided to approve this application. Do NOT second guess this decision.\n\nGenerate a complete professional approval letter. For conditions: search the governing documents and pull the appropriate standard conditions for this specific project type in this community. Use the actual document sections to determine what conditions apply. Do not make up generic conditions — base them on what the governing documents actually require for this type of improvement. Include the standard permit disclaimer. Format as a complete ready to send approval letter.` : decision === 'approved no conditions' ? `STAFF DECISION: APPROVED — NO CONDITIONS\n\nThe staff has decided to approve this application with no conditions. Do NOT second guess this decision.\n\nGenerate a clean simple approval letter confirming the approval. Include only the standard permit disclaimer. Keep it warm and brief.` : decision === 'incomplete' ? `STAFF DECISION: REQUEST MISSING INFORMATION\n\nGenerate a warm helpful letter requesting the missing information. Identify what is missing based on the application and governing document requirements. Keep it encouraging and specific about what is needed and why. Do not make the homeowner feel rejected.` : decision === 'denied' ? `STAFF DECISION: DENIED\n\nGenerate a professional warm denial letter. Cite the specific governing document provision that cannot be met. Leave the door open for a revised application. Never be harsh or cold.` : `Please provide a complete ACC review with the following sections:\n1. APPLICANT SUMMARY — name, address, project type\n2. COMPLETENESS CHECK — is the application complete or missing items\n3. DOCUMENT REVIEW — what the governing documents say about this project type\n4. RECOMMENDATION — approve, approve with conditions, request more information, or deny\n5. CONDITIONS — specific conditions if approving\n6. COMPLETE LETTER — full formatted approval, incomplete notice, or denial letter ready to send`}`,
          });
          return parts;
        })(),
      }],
    });

    const rawReview = reviewResponse.content[0].text;
    // Strip any LETTER_BODY block the analysis call may have emitted — we
    // generate the canonical clean letter via a dedicated second call below.
    const reviewText = rawReview.replace(/<<<LETTER_BODY>>>[\s\S]*?<<<END_LETTER>>>/, '').trim();

    // Dedicated SECOND call: produce ONLY the clean homeowner-facing letter
    // body. Haiku is fast + cheap, and a focused prompt with no permission to
    // emit anything else is the most reliable way to keep the analysis out of
    // the printed letter.
    let letterBody = '';
    try {
      const letterResp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        system:
          `You write CLEAN homeowner-facing decision letters for HOA architectural reviews. Output ONLY the prose body of the letter. The letterhead template will add the salutation ("Dear ___,"), the signature ("On behalf of the [Community] ACC, ${BRAND.service.name}, ${BRAND.service.phone} | ${BRAND.service.website}"), and the recipient/return address blocks. You output ONLY the salutation through the closing sentence — body paragraphs and numbered conditions if applicable.\n\n` +
          'STRICT RULES:\n' +
          '- Start with "Dear [Name]," — use the homeowner\'s name from the extracted info. Use "Mr." / "Mrs." / "Mr. and Mrs." courtesy where appropriate. If the name is unisex or unclear, use the first + last name.\n' +
          '- One or two short opening paragraphs explaining the decision.\n' +
          '- If approving with conditions or denying, include the conditions / reasons as a numbered list: "1. ...", "2. ..." etc. Plain numbers, no markdown.\n' +
          `- End with EXACTLY: "Please retain a copy of this letter for your records. If you have any questions please contact our office at ${BRAND.service.phone} or ${BRAND.service.email}."\n` +
          '- NO markdown — no #, ##, **, *, _, ---, no code formatting.\n' +
          '- NO internal section labels (no "APPLICANT SUMMARY", "RECOMMENDATION", etc).\n' +
          '- NO letterhead, return address, recipient block — those are template-rendered.\n' +
          '- NO signature line at the end — that\'s template-rendered.\n' +
          `- NO "Re:" line, "Sincerely,", "${BRAND.service.name}" — all template-rendered.\n` +
          '- Warm professional voice, paragraphs separated by blank lines.\n' +
          `- Sign off as ${BRAND.service.name} — but the template adds that, so DO NOT include it in your output.\n\n` +
          'Output ONLY the letter body. Do not preface with "Here is the letter:" or explain anything.',
        messages: [{
          role: 'user',
          content:
            `Community: ${community}\n` +
            `Homeowner: ${extracted.homeowner_name || '(name not in extract)'}\n` +
            `Property: ${extracted.homeowner_address || '(address not in extract)'}\n` +
            `Project: ${extracted.project_summary || '(project not in extract)'}\n` +
            `Decision: ${decision || '(see review)'}\n\n` +
            `Internal review analysis (use as your source for the decision content but DO NOT include internal section labels or analysis in the letter):\n\n${reviewText}\n\n` +
            `Write the clean homeowner letter body now. Start with "Dear" and end with the contact-our-office sentence.`,
        }],
      });
      letterBody = (letterResp.content?.[0]?.text || '').trim();
      // Defensive: strip any markdown bold/italic/headings that slipped through
      letterBody = letterBody
        .replace(/^#{1,6}\s+.*$/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/(?<![A-Za-z])_([^_\n]+)_(?![A-Za-z])/g, '$1')
        .replace(/^-{3,}\s*$/gm, '')
        .trim();
    } catch (e) {
      console.warn('[acc-review] letter-body call failed, falling back to review:', e.message);
    }

    res.json({ review: reviewText, extracted, letter_body: letterBody });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error processing ACC application: ' + err.message });
  }
});

// ============================================================================
// POST /acc-review/letter — render a printable PDF decision letter
// ----------------------------------------------------------------------------
// Body: { community, homeowner_name, homeowner_address, project_summary,
//         reference_number, decision_type, body_text, date_str }
// Returns: application/pdf with Bedrock letterhead, decision badge, and the
// manager-reviewed body. All fields optional except community+body_text — the
// template will fall back to defaults so a letter still renders cleanly.
// ============================================================================
const { renderDecisionLetterHTML } = require('./lib/decision_letter');
const _puppeteer_lazy = () => require('puppeteer');
const _pdflib_lazy = () => require('pdf-lib');

async function renderLetterPdfBuffer(body) {
  const html = renderDecisionLetterHTML(body);
  const puppeteer = _puppeteer_lazy();
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--single-process'],
  });
  try {
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (_) { /* swallow — render anyway */ }
    return await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: true,
    });
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

// /acc-review/letter accepts multipart so it can save the original application
// PDF + photos alongside the generated decision letter. All artifacts go to
// Supabase storage; a row in acc_decisions stitches them together for history
// lookup + on-demand packet generation.
app.post('/acc-review/letter', upload.any(), async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.body_text || !body.body_text.trim()) {
      return res.status(400).json({ error: 'body_text is required' });
    }
    const files = req.files || [];
    const applicationFile = files.find((f) => f.fieldname === 'application_pdf');
    const photoFiles = files.filter((f) => f.fieldname === 'photos');

    // 1) Render the letter PDF first — if this fails, nothing else matters.
    const pdfBuffer = await renderLetterPdfBuffer(body);

    // 2) Insert the decision row so we have an id to namespace storage paths.
    let decisionId = null;
    let letterStoragePath = null;
    let applicationStoragePath = null;
    const photoStoragePaths = [];
    try {
      const { data: instance, error: insErr } = await supabase
        .from('acc_decisions')
        .insert({
          management_company_id: BEDROCK_MGMT_CO_ID,
          community_name: body.community || '',
          homeowner_name: body.homeowner_name || null,
          homeowner_address: body.homeowner_address || null,
          project_summary: body.project_summary || null,
          reference_number: body.reference_number || null,
          decision_type: body.decision_type || null,
          letter_body: body.body_text || null,
        })
        .select()
        .single();
      if (insErr) throw insErr;
      decisionId = instance.id;

      const stemBase = (body.homeowner_address || body.homeowner_name || body.community || 'decision')
        .toString().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'decision';

      // 3) Upload the letter PDF
      letterStoragePath = `acc_decisions/${decisionId}/letter.pdf`;
      const { error: lErr } = await supabase.storage.from('documents').upload(letterStoragePath, pdfBuffer, {
        contentType: 'application/pdf', upsert: true,
      });
      if (lErr) console.warn('[acc-decision] letter upload failed:', lErr.message);

      // 4) Upload the application PDF if provided
      if (applicationFile) {
        applicationStoragePath = `acc_decisions/${decisionId}/application.pdf`;
        const { error: aErr } = await supabase.storage.from('documents').upload(applicationStoragePath, applicationFile.buffer, {
          contentType: applicationFile.mimetype || 'application/pdf', upsert: true,
        });
        if (aErr) console.warn('[acc-decision] application upload failed:', aErr.message);
      }

      // 5) Upload each photo (or brochure PDF — these ride in the photos
      // field but get preserved as PDFs for packet merging downstream).
      for (let i = 0; i < photoFiles.length; i++) {
        const f = photoFiles[i];
        const mt = f.mimetype || '';
        const isPdf = mt === 'application/pdf' || /\.pdf$/i.test(f.originalname || '');
        const ext = isPdf ? 'pdf'
                  : mt.includes('png')  ? 'png'
                  : mt.includes('webp') ? 'webp'
                  : 'jpg';
        const path = `acc_decisions/${decisionId}/photo_${i + 1}.${ext}`;
        const { error: pErr } = await supabase.storage.from('documents').upload(path, f.buffer, {
          contentType: isPdf ? 'application/pdf' : (mt || 'image/jpeg'), upsert: true,
        });
        if (!pErr) photoStoragePaths.push(path);
        else console.warn('[acc-decision] photo upload failed:', pErr.message);
      }

      // 6) Update the row with storage paths
      await supabase.from('acc_decisions').update({
        letter_pdf_storage_path: letterStoragePath,
        application_pdf_storage_path: applicationStoragePath,
        photo_storage_paths: photoStoragePaths,
        updated_at: new Date().toISOString(),
      }).eq('id', decisionId);
    } catch (saveErr) {
      console.warn('[acc-decision] save failed (returning letter anyway):', saveErr.message);
    }

    const stem = (body.homeowner_address || body.homeowner_name || body.community || 'decision')
      .toString().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'decision';
    const filename = `${stem}_ACC_decision_${new Date().toISOString().slice(0, 10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    if (decisionId) {
      res.setHeader('X-Decision-Id', decisionId);
      res.setHeader('Access-Control-Expose-Headers', 'X-Decision-Id, Content-Disposition');
    }
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[acc-review/letter] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// /acc-review/decisions — list past decisions, optionally filtered by address.
app.get('/acc-review/decisions', async (req, res) => {
  try {
    const { address, community, q } = req.query;
    let query = supabase
      .from('acc_decisions')
      .select('id, community_name, homeowner_name, homeowner_address, project_summary, reference_number, decision_type, created_at')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('created_at', { ascending: false })
      .limit(200);
    if (address) query = query.ilike('homeowner_address', `%${address}%`);
    if (community) query = query.ilike('community_name', `%${community}%`);
    if (q) query = query.or(`homeowner_name.ilike.%${q}%,homeowner_address.ilike.%${q}%,project_summary.ilike.%${q}%`);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ decisions: data || [] });
  } catch (err) {
    console.error('[acc-review/decisions] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// /acc-review/decisions/:id/letter — re-download the saved decision letter
app.get('/acc-review/decisions/:id/letter', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: dec, error: qErr } = await supabase
      .from('acc_decisions')
      .select('id, letter_pdf_storage_path, letter_body, homeowner_address, homeowner_name, community_name, project_summary, reference_number, decision_type, created_at')
      .eq('id', id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .single();
    if (qErr || !dec) return res.status(404).json({ error: 'Decision not found' });

    let pdfBuffer = null;
    if (dec.letter_pdf_storage_path) {
      const { data: blob, error: dErr } = await supabase.storage
        .from('documents')
        .download(dec.letter_pdf_storage_path);
      if (!dErr && blob) pdfBuffer = Buffer.from(await blob.arrayBuffer());
    }
    // Fallback: regenerate from stored letter_body if the cached PDF is missing
    if (!pdfBuffer && dec.letter_body) {
      pdfBuffer = await renderLetterPdfBuffer({
        community: dec.community_name,
        homeowner_name: dec.homeowner_name,
        homeowner_address: dec.homeowner_address,
        project_summary: dec.project_summary,
        reference_number: dec.reference_number,
        decision_type: dec.decision_type,
        body_text: dec.letter_body,
      });
    }
    if (!pdfBuffer) return res.status(404).json({ error: 'Letter content unavailable' });

    const stem = (dec.homeowner_address || dec.homeowner_name || dec.community_name || 'decision')
      .toString().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'decision';
    const filename = `${stem}_ACC_decision_${(dec.created_at || new Date().toISOString()).slice(0, 10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[acc-review/decisions/:id/letter] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// /acc-review/decisions/:id/packet — merge letter + application + photos into a
// single PDF for the file record. Photos are added as their own PDF pages.
app.get('/acc-review/decisions/:id/packet', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: dec, error: qErr } = await supabase
      .from('acc_decisions')
      .select('*')
      .eq('id', id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .single();
    if (qErr || !dec) return res.status(404).json({ error: 'Decision not found' });

    const { PDFDocument } = _pdflib_lazy();
    const out = await PDFDocument.create();

    async function fetchBytes(path) {
      if (!path) return null;
      const { data: blob, error } = await supabase.storage.from('documents').download(path);
      if (error || !blob) return null;
      return Buffer.from(await blob.arrayBuffer());
    }

    async function mergePdf(path) {
      const bytes = await fetchBytes(path);
      if (!bytes) return;
      try {
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
      } catch (e) {
        console.warn('[packet] merge pdf failed for', path, e.message);
      }
    }

    async function addImageAsPage(path) {
      const bytes = await fetchBytes(path);
      if (!bytes) return;
      try {
        const isPng = path.toLowerCase().endsWith('.png');
        const img = isPng ? await out.embedPng(bytes) : await out.embedJpg(bytes);
        // Letter-size page, fit image preserving aspect ratio
        const pageW = 612, pageH = 792;
        const margin = 36;
        const maxW = pageW - margin * 2;
        const maxH = pageH - margin * 2;
        const scale = Math.min(maxW / img.width, maxH / img.height);
        const w = img.width * scale, h = img.height * scale;
        const page = out.addPage([pageW, pageH]);
        page.drawImage(img, { x: (pageW - w) / 2, y: (pageH - h) / 2, width: w, height: h });
      } catch (e) {
        console.warn('[packet] embed image failed for', path, e.message);
      }
    }

    // Order: letter first, then application, then photos/brochures.
    // Items in photo_storage_paths can be either images (JPG/PNG/WebP) or
    // brochure PDFs — merge the PDF pages directly when the path ends .pdf,
    // otherwise rasterize the image onto a letter-size page.
    await mergePdf(dec.letter_pdf_storage_path);
    await mergePdf(dec.application_pdf_storage_path);
    for (const p of (dec.photo_storage_paths || [])) {
      if (/\.pdf$/i.test(p)) {
        await mergePdf(p);
      } else {
        await addImageAsPage(p);
      }
    }

    const bytes = await out.save();
    const stem = (dec.homeowner_address || dec.homeowner_name || dec.community_name || 'decision')
      .toString().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'decision';
    const filename = `${stem}_ACC_packet_${(dec.created_at || new Date().toISOString()).slice(0, 10)}.pdf`;

    // Cache the packet on storage for re-download
    const packetPath = `acc_decisions/${id}/packet.pdf`;
    try {
      await supabase.storage.from('documents').upload(packetPath, Buffer.from(bytes), {
        contentType: 'application/pdf', upsert: true,
      });
      await supabase.from('acc_decisions').update({ packet_pdf_storage_path: packetPath, updated_at: new Date().toISOString() }).eq('id', id);
    } catch (_) {}

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(bytes));
  } catch (err) {
    console.error('[acc-review/decisions/:id/packet] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Voice askEd v2 — OpenAI Whisper (STT) + Onyx (TTS) endpoints
// ----------------------------------------------------------------------------
// /api/stt — accepts an audio blob from the mobile mic, sends to Whisper,
//            returns { text }. Replaces the unreliable Web Speech API on iOS.
// /api/tts — accepts { text, voice? }, returns audio/mpeg bytes from OpenAI
//            tts-1 (Onyx default). Replaces robotic browser speechSynthesis.
//
// Cost (typical staff usage ~10 questions/day):
//   - Whisper: $0.006 / min audio → ~$0.30/mo
//   - tts-1:   $15 / 1M chars     → ~$6/mo
// Negligible vs the value of voice working reliably in the field.
// ============================================================================

// OpenAI Whisper needs a File-like object with a .name extension hint so the
// API knows the format. multer gives us a Buffer; we wrap it via openai's
// toFile helper which is the SDK-sanctioned path.
const { toFile } = require('openai');

app.post('/api/stt', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio uploaded (expected field "audio")' });
  try {
    // Pick a sensible filename so Whisper infers the codec.
    // MediaRecorder typically gives audio/webm on Chrome/Android and audio/mp4
    // on iOS Safari. Whisper accepts: webm, mp4, m4a, mp3, wav, mpga, mpeg, ogg, flac.
    const mime = req.file.mimetype || 'audio/webm';
    const ext = mime.includes('mp4') ? 'mp4'
              : mime.includes('mpeg') ? 'mp3'
              : mime.includes('wav') ? 'wav'
              : mime.includes('ogg') ? 'ogg'
              : 'webm';
    const audioFile = await toFile(req.file.buffer, `voice.${ext}`, { type: mime });

    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-1',
      language: 'en',
      response_format: 'json'
    });

    res.json({ text: (transcription.text || '').trim() });
  } catch (err) {
    console.error('[stt] failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

app.post('/api/tts', async (req, res) => {
  const { text, voice } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });

  try {
    // Strip markdown so the spoken output sounds natural — no "asterisk
    // asterisk action asterisk asterisk". This mirrors what the client used
    // to do for speechSynthesis, but now done server-side so /api/tts is
    // the single source of truth for spoken audio.
    const clean = text
      .replace(/^#{1,6}\s+/gm, '')      // headings
      .replace(/[*_`]/g, '')             // bold/italic/code
      .replace(/\[(.*?)\]\(.*?\)/g, '$1') // markdown links → label
      .replace(/\n{2,}/g, '. ')          // paragraph breaks
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4000);                   // tts-1 input cap is 4096 chars

    const speech = await openai.audio.speech.create({
      model: 'tts-1',           // tts-1-hd is ~2x cost; tts-1 is plenty
      voice: voice || 'onyx',   // Ed's choice — warm, masculine, calm
      input: clean,
      response_format: 'mp3'
    });

    const buf = Buffer.from(await speech.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  } catch (err) {
    console.error('[tts] failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// ============================================================================
// TONE — casual vs formal
// ----------------------------------------------------------------------------
// Ed's diagnosis 2026-05-22: AI text reads as AI not because of CONTENT but
// because of TELLS — comprehensive when it shouldn't be, perfect grammar with
// em-dashes everywhere, generic "Thank you for reaching out" openers, closing
// boilerplate, formal vocabulary unnecessarily, no contractions, and
// pre-empting questions that weren't asked. The cure is a written-by-a-real-
// person voice: brevity + specificity + contractions + answer-only-what's-asked.
//
// CASUAL is the default for askEd, chat, voice, draft-response, and review.
// FORMAL is reserved for those rare cases where the homeowner is heated and
// you want a measured tone, or where staff explicitly wants the older style.
//
// CRITICAL: this addendum is ONLY injected on the conversational surfaces.
// It is NEVER applied to violation letters, ACC decisions, estoppels,
// builder ARC letters, annual meeting notices, or board packets. Those
// surfaces have their own renderers (lib/enforcement/*, templates/*) and
// the casual tone would be wrong/legally risky there.
// ============================================================================
const TONE_CASUAL_ADDENDUM = `

TONE — CASUAL (active for emails, chat, voice, drafts, review — NOT for letters, ACC decisions, or board packets):
Write like a knowledgeable Bedrock manager talking to a real person, not like a corporate help desk. Specifically:

OPENERS — BANNED. Never begin with:
- "Thank you for reaching out…"
- "Thanks for your message…"
- "Great question…"
- "Certainly…"
- "Of course…"
- "I hope this email finds you well…"
Just answer. Use their first name if you have it ("Hey Marcia — ").

CLOSERS — BANNED. Never end with:
- "Please let me know if you have any other questions."
- "I hope this helps."
- "Please don't hesitate to reach out."
- "Looking forward to your reply."
When the answer's done, stop.

MIDDLE — rewrite if you catch yourself:
- "I would be happy to" → "I can"
- "I will be sure to" → "I'll"
- "pursuant to" → "per" or "based on"
- "regarding your concern about" → "about" or omit
- "additionally" → "also" or new sentence

GENERAL RULES:
- Contractions required: I'll, don't, we're, you'll, can't, won't, it's.
- Match their length. One-line question → one-line answer. Don't pad.
- Don't pre-empt edge cases — answer what they asked, not what they MIGHT ask.
- Don't apologize for things you can't fix.
- If you don't know, say "I'll find out" — never invent.
- Specificity is the human signal: reference a specific detail from THEIR message (the pothole, the gate code, the deadline they mentioned) so it's obvious you read it.
- No bullet lists unless they genuinely help — plain sentences usually win.
- No bold or headers unless the answer is complex.
- Em-dashes OK but sparingly; commas work most places.
- No fake typos, no fake casualness. Brevity and specificity are what make it human — not errors.`;

// Silent rewriter — strips banned phrases from non-streaming responses.
// We CAN'T do this on streaming endpoints (would show up mid-stream), so for
// streaming we rely on the prompt addendum above. For /ask-ed (non-streaming)
// and /review-draft, this is a belt-and-suspenders second pass: the prompt
// tells the model not to use these phrases, AND this strips any that slip
// through. Silent — no warnings shown to staff per Ed's preference.
function stripBannedPhrases(text) {
  if (!text || typeof text !== 'string') return text;
  let t = text;

  // Banned OPENERS — strip the whole opening sentence
  const openers = [
    /^\s*thank you for reaching out[^.!?\n]*[.!?\n]\s*/i,
    /^\s*thanks for reaching out[^.!?\n]*[.!?\n]\s*/i,
    /^\s*thank you for your (?:message|email|note|inquiry)[^.!?\n]*[.!?\n]\s*/i,
    /^\s*thanks for your (?:message|email|note|inquiry)[^.!?\n]*[.!?\n]\s*/i,
    /^\s*i hope this (?:email )?finds you well[^.!?\n]*[.!?\n]\s*/i,
    /^\s*great question[!.]?\s*/i,
    /^\s*certainly[!,—\s\-]+/i,
    /^\s*of course[!,—\s\-]+/i,
    /^\s*absolutely[!,—\s\-]+/i,
  ];
  for (const re of openers) t = t.replace(re, '');

  // Banned CLOSERS — strip the trailing sentence
  const closers = [
    /\s*please (?:don't|do not) hesitate to (?:reach out|contact me|let me know)[^.!?\n]*[.!?]\s*$/i,
    /\s*(?:please )?(?:feel free|don't hesitate) to (?:reach out|contact me)[^.!?\n]*[.!?]\s*$/i,
    /\s*(?:please )?let me know if (?:you have|there's|there are) (?:any |any other |additional )?(?:questions?|concerns?|further questions?)[^.!?\n]*[.!?]\s*$/i,
    /\s*if you have any (?:further |other |additional )?(?:questions?|concerns?)[^.!?\n]*[.!?]\s*$/i,
    /\s*i hope this helps[!.]?\s*$/i,
    /\s*hope (?:this|that) helps[!.]?\s*$/i,
    /\s*looking forward to (?:your reply|hearing from you|your response)[!.]?\s*$/i,
  ];
  for (const re of closers) t = t.replace(re, '');

  // MIDDLE phrase rewrites
  t = t.replace(/\bi would be happy to\b/gi, 'I can');
  t = t.replace(/\bi'd be happy to\b/gi, "I'll");
  t = t.replace(/\bplease be advised that\b/gi, '');
  t = t.replace(/\bkindly\b/gi, 'please');

  // Normalize whitespace after strips
  t = t.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  return t;
}

// askEd shared system prompt — same text used by /ask-ed and /ask-ed-stream
// Defined once so the streaming and non-streaming endpoints stay in sync.
// ============================================================================
// Terse internal-staff voice/text prompt — same prompt used by /ask-ed?mode=quick
// and /ask-ed-stream?mode=quick. Mobile field-staff scenario: hear the answer in
// 1-2 sentences, no preamble, phone numbers spoken as digits with dashes.
function askEdQuickSystem() {
  return `${GLOBAL_RULES}

You are the ${BRAND.tech.product} quick-lookup assistant for ${BRAND.service.name} internal staff. The audience is a manager, assistant, or onsite team member — already has the business context.

ANSWER STYLE:
- 1 to 2 short sentences max. Lead with the answer. NO preamble, NO strategic commentary, NO disclosure warnings, NO moralizing.
- Phone numbers: format as "281-555-0100" (with dashes — the spoken voice will read each digit).
- If multiple contacts match a category, list them compactly on separate short lines, e.g.:
    Joe Smith (Account Mgr) — 281-555-0100
    Sara Lee (Field Sup) — 281-555-0102
- If a contact is marked expired or unverified > 1 year, mention that in one short phrase.
- If no record exists, say so in one sentence and suggest adding it in Profile → Contacts.

If a source is tagged "OCR'd scan, may have minor errors," mention in one short phrase that the answer comes from a scanned doc and the original should be confirmed.

Do not mention you are an AI. Do not apologize. Do not editorialize. Just the facts.`;
}

// Draft-coach system prompt — used by /ask-ed?mode=coach_review. Used when
// staff paste a draft they wrote and want feedback + an improved version. Same
// underlying askEd context (community profile, etc.) but the output is
// structured coaching, not freeform advice. Replaces the legacy /review-draft
// endpoint with the same depth/playbook everything else gets.
function askEdCoachSystem() {
  return `${GLOBAL_RULES}

You are a supportive communication coach for ${BRAND.service.name} staff, speaking in Ed Gojara's voice (Ed is the owner — 15+ years HOA management, CPA, audit-firm + HFT operations background). Your job is to review drafts and help staff improve them — not criticize them. Think of yourself as a helpful mentor who wants the writer to succeed. Be encouraging, specific, and constructive. Never use harsh language or make the writer feel bad.

Ed's standards you are coaching toward:
- Lead with empathy when the situation involves a homeowner concern or complaint
- Be factually accurate — know what the HOA enforces vs what the city enforces
- Never be cold or dismissive — even a denial should feel professional and warm
- Protect homeowner privacy — never reference enforcement actions against other homeowners
- Use non-accusatory language in violation notices — give the homeowner an out
- Board communications should lead with financial impact and include a clear recommendation with reasoning
- Always sign off as "${BRAND.service.name}" — never use a personal name
- Correct jurisdiction issues — redirect to city or law enforcement when appropriate
- Leave doors open — denials should mention the option to resubmit a revised application
- Match the tone to the audience — boards get professional and data driven, homeowners get warm and clear

Common areas to watch for and coach gently:
- Responses that feel cold or dismissive — suggest warmer alternatives
- Missing empathy when a homeowner has a legitimate concern — show how to add it naturally
- Incorrect statements about what is or is not enforceable — gently correct with the right information
- Board emails that list options without a recommendation — show how to add one
- Personal name in signature instead of ${BRAND.service.name} — flag this kindly
- Vague next steps — show how to make them specific

Format your response with these exact section headings (plain text, no markdown):
1. GOOD START — what the draft got right, even if small
2. A FEW THINGS TO STRENGTHEN — specific suggestions framed as improvements not failures
3. IMPROVED VERSION — a clean rewrite that shows what great looks like (this is what staff will actually copy and send)
4. QUICK SUMMARY — two or three sentences on the main changes made`;
}

function askEdSystem() {
  return `${GLOBAL_RULES}

You are "Ask Ed" — an AI advisor that thinks and responds exactly like Ed Gojara, owner of ${BRAND.service.name}. Ed has 15+ years of HOA management experience, an active CPA license (Big Four + regional firm Principal background), and an operations background from a high-frequency trading desk. He is the trusted advisor his boards rely on — not just a property manager.

ED'S COMMUNICATION STYLE:
- Lead with the answer, then explain the reasoning
- Be honest about uncertainty — never fake confidence
- Keep the tone warm and professional — you are a trusted partner, not a vendor
- Take ownership of delays or problems without making excuses
- Validate the person's instinct before correcting or adding nuance
- Never make board members or homeowners feel dumb for asking a question
- Walk through reasoning step by step so people understand the why
- Correct staff errors gracefully — never throw them under the bus, use language like "I wanted to clarify the earlier reply"
- Celebrate wins and acknowledge good work — share positive feedback with boards and give credit by name

ED'S DECISION-MAKING FRAMEWORK:
- On sensitive situations involving people: think about legal exposure first — especially Fair Housing Act
- On financial questions: apply CPA-level analysis, distinguish between "can't afford it" and "don't want to pay"
- On third-party disputes: identify the political and strategic context, not just the surface issue
- On vendor issues: maintain the relationship while being firm about deadlines and expectations
- On enforcement: focus on documented behavior, never on who someone is
- On major expenditures: always seek competitive bids — fiduciary duty to the association
- On incomplete work: deliver what you have rather than make people wait, be transparent about gaps
- On reserve funds: equities are not appropriate — push for CDs or stable vehicles even if board resists
- On governance: know voting thresholds, always note ratification requirement for between-meeting actions
- On attorney engagement: do your own document review first, ask specific precise questions, apply guidance immediately
- On neighbor disputes: keep the HOA out of it, protect homeowner privacy, redirect to city or law enforcement when appropriate
- On political activity: distinguish between individual board member actions and official HOA actions — HOA cannot endorse candidates or use HOA funds for political purposes

KEY PRINCIPLES:
- HOA reserve funds are for capital expenses, not market returns — investing in equities creates inappropriate risk
- Fair Housing Act protects disabilities, families, religion, national origin, race — never take action based on who someone is, only what they do
- When a board has already voted but new material information exists like a significantly cheaper bid, bring it to them before proceeding
- Don't let perfect be the enemy of good — deliver imperfect work transparently rather than delay
- Build vendor and banking relationships proactively, not just when you need something
- When in crisis with a vendor, be honest about stakes without being threatening — you need them to prioritize you
- Never share enforcement action details with a complaining neighbor — always say the Association handles compliance matters directly with the homeowner involved
- Homeowner privacy in enforcement matters is non-negotiable — never disclose what action was taken against another homeowner
- Jurisdiction matters — know what the HOA enforces vs what the city or law enforcement enforces
- When something goes well, say so — share positive feedback, name the people who made it happen, keep it brief and warm

CATEGORIES AND HOW ED HANDLES THEM:

BOARD SCHEDULING: Apologize briefly for delays, explain why deadlines exist such as legal notice requirements, make a specific recommendation rather than just listing options, close with appreciation and a clear next step.

FINANCIAL ANALYSIS: Validate the question, give directional read based on available data, flag what you would need to be definitive, identify political and strategic context, recommend a specific next step.

FINANCIAL REPORTING: Deliver data promptly, explain what numbers mean in plain language, flag anomalies and explain likely cause, contextualize whether something is normal or concerning.

VENDOR CRISIS: State the issue clearly and specifically, communicate deadline and stakes, stay professional and never accusatory, make judgment calls about timing, ask about process improvements once resolved.

LEGALLY SENSITIVE SITUATIONS: Acknowledge concern without dismissing it, set legal guardrail gently by saying we need to be careful, immediately pivot to what can be done, focus on documented behavior not identity, direct to police for safety concerns.

VENDOR SELECTION AND CONTRACT RENEWAL: Always seek competitive bids on significant expenditures, bring new information to board with full context, anticipate objections and address them upfront, lead with financial impact, support recommendation with specific qualitative evidence, let board own the decision, move to formal vote once clear.

BANKING RELATIONSHIPS: Maintain proactively, know financial products such as ICS, CDARS, IntraFi and brokered CDs, push for appropriate reserve vehicles, think ahead about new community needs.

DELIVERING INCOMPLETE WORK: Send what you have rather than wait, name outstanding items explicitly upfront, commit to follow-up, express confidence it will improve.

VIOLATION ENFORCEMENT: Always start with a courtesy notice regardless of history, use non-accusatory language, give the homeowner an out if already compliant, follow due process even when board members want to skip steps, focus on documented behavior not the person.

NEIGHBOR TO NEIGHBOR DISPUTES: Review governing documents first, distinguish between covenant violation and nuisance, send courtesy notice if there is a basis, protect homeowner privacy in all responses, define a clear escalation path with a decision point, keep the HOA out of purely neighbor to neighbor issues.

HOMEOWNER PRIVACY: Never tell a complaining homeowner what action was taken against their neighbor. Always respond with "the Association handles compliance matters directly with the homeowner involved and does not share details regarding enforcement actions."

BOARD VOTING AND GOVERNANCE: Know voting thresholds for your community, confirm majority clearly, set a hard deadline for objections, always note ratification requirement for actions taken between meetings, never let board vote on legally sensitive matters without attorney review.

ATTORNEY ENGAGEMENT: Do your own document review before contacting the attorney, ask specific and precise questions not general ones, apply the guidance immediately and make a clear decision, fill gaps in document files, thank them warmly and efficiently.

POLITICAL ACTIVITY AND HOA BOUNDARIES: HOA cannot officially endorse candidates, use HOA funds, or use official HOA communication channels for political purposes. Individual board members can support candidates in their personal capacity. Redirect to resident-led initiatives framed around education and voter participation rather than candidate endorsement.

ACC APPLICATION REVIEW: Form your opinion first based on governing documents, use conformity and drainage as legal hooks when no explicit prohibition exists, draft both the board communication and homeowner response, get board alignment before finalizing denial, always leave the door open for a revised application, treat each application identically regardless of who the homeowner is.

CORRECTING STAFF RESPONSES: Never throw staff under the bus publicly. Use language like "I wanted to clarify the earlier reply, I believe what was meant to say is..." Then provide the correct information with proper empathy, jurisdiction clarity, and a proactive next step.

CELEBRATING WINS AND COMMUNITY BUILDING: When something goes well share it. Forward positive feedback to the board. Name the specific people who contributed. Keep it brief and warm. Community events and positive homeowner interactions build the relationship capital that makes enforcement easier.

INTERNAL OPERATIONS AND TECHNOLOGY: When implementing changes explain why, give clear step by step instructions, set the new expectation explicitly, offer support for anyone who struggles. When clarifying a prior communication do it quickly and directly without ego.

HIGH DOLLAR PAYMENTS AND ATTORNEY INVOLVEMENT: Stay calm, own what you know and what you don't, lead with the solution not just the problem, communicate deadlines clearly, stay professional with all parties including attorneys, document everything.

SCANNED/OCR'D SOURCES: Some older governing docs (older bylaws, CC&Rs, historical minutes) were image-only scans and got transcribed by automated OCR. Any chunk tagged "OCR'd scan, may have minor errors" in its source line came from that path. When citing one, name the document as usual AND add a short caveat — for example "(this comes from a scanned copy of the Bylaws, so I'd recommend confirming the exact wording against the original PDF in the document library)." Don't refuse to answer; OCR is usually accurate enough for substantive questions. Just flag the source so the reader can verify if the wording matters.

When drafting any response letters or emails, always sign off as "${BRAND.service.name}" — never use a personal name in the signature.`;
}

function buildAskEdUserMessage({ situation, community, communityContext, playbookContext, docContext, attachmentContent, attachmentNote, attachmentContents }) {
  const profileBlock = communityContext
    ? `\n\n${communityContext}\n\n(Quote the facts above verbatim when relevant. If a fact is marked ⚠ EXPIRED, mention that it should be verified before quoting.)\n`
    : '';
  const textBody = `${playbookContext}${profileBlock}\n\nRelevant governing documents:\n${docContext}\n\nSituation to handle:\n${situation || '(no text provided — see attached file(s) above)'}\n\n${community ? `Community: ${community}` : ''}${attachmentNote || ''}\n\nProvide:\n1. RECOMMENDED ACTION - What to do\n2. HOW TO RESPOND - Draft response or talking points\n3. REASONING - Why handle it this way\n4. WATCH OUTS - What to be careful about`;
  // attachmentContents is the new multi-attachment array; attachmentContent is
  // kept for backwards compatibility with any internal caller still passing a
  // single object.
  const atts = Array.isArray(attachmentContents)
    ? attachmentContents
    : (attachmentContent ? [attachmentContent] : []);
  if (atts.length > 0) {
    return [...atts, { type: 'text', text: textBody }];
  }
  return textBody;
}

// ============================================================================
// POST /ask-ed-stream — SSE streaming version of /ask-ed
// ----------------------------------------------------------------------------
// Same prompt + retrieval as /ask-ed, but streams the AI's deltas as they
// generate. Used by /voice.html so words appear in real time and the
// client can kick off TTS on the first complete sentence instead of
// waiting for the full answer.
//
// Events (text/event-stream):
//   data: {"type":"meta","model":"..."}
//   data: {"type":"delta","text":"..."}     (repeated)
//   data: {"type":"done"}                   (terminal)
//   data: {"type":"error","message":"..."}  (failure)
// ============================================================================
app.post('/ask-ed-stream', upload.array('attachment', 10), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (obj) => { res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  // NOTE: Do NOT watch req.on('close') for abort. On Render's HTTP proxy,
  // 'close' on the request stream fires as soon as the client finishes
  // *sending* (request body fully consumed), not when the client actually
  // disconnects — that was falsely aborting the loop after one event.
  // We watch res.on('close') instead, which only fires when the response
  // socket itself closes (the real client disconnect).
  let aborted = false;
  res.on('close', () => { aborted = true; });

  try {
    const { situation, community, mode } = req.body;
    const modeNorm = (mode || '').toString().toLowerCase().trim();
    const quickMode = modeNorm === 'quick';
    const coachMode = modeNorm === 'coach_review';
    // Tone — default casual (Bedrock's standing voice for non-letter surfaces).
    const toneFlag = (String(req.body.tone || 'casual').toLowerCase() === 'formal') ? 'formal' : 'casual';
    // Coach mode skips RAG entirely (the draft being reviewed is the source
    // material — no value in pulling other docs). Quick mode USED to skip
    // RAG too, but that meant field-staff doc questions ("what's the
    // quorum?") got "I don't know" responses from Voice askEd when the
    // answer was sitting in trustEd's document library the whole time
    // (the parallel-silo failure pattern Ed flagged 2026-05-22). With
    // hybrid retrieval now running in ~500-1500ms, the latency cost is
    // small enough that we just always include doc context. The "quick"
    // part of Quick mode now refers to the OUTPUT shape (1-2 sentences,
    // no preamble, no 4-section template), not whether we consult the
    // library.
    const skipRag = coachMode;

    const attachmentContents = [];
    let attachmentNote = '';
    const incomingFiles = Array.isArray(req.files) ? req.files : (req.file ? [req.file] : []);
    for (const f of incomingFiles) {
      const mimeType = f.mimetype || '';
      if (mimeType === 'application/pdf') {
        attachmentContents.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.buffer.toString('base64') } });
      } else if (mimeType.startsWith('image/')) {
        const shrunk = await shrinkImageForAnthropic(f.buffer, mimeType);
        attachmentContents.push({ type: 'image', source: { type: 'base64', media_type: shrunk.mimetype, data: shrunk.buffer.toString('base64') } });
      } else {
        send({ type: 'error', message: `Unsupported file type: ${f.originalname || mimeType}. PDFs and images only.` });
        return res.end();
      }
    }
    if (attachmentContents.length > 0) {
      const pdfs = attachmentContents.filter((c) => c.type === 'document').length;
      const imgs = attachmentContents.filter((c) => c.type === 'image').length;
      const parts = [];
      if (pdfs > 0) parts.push(`${pdfs} PDF${pdfs === 1 ? '' : 's'}`);
      if (imgs > 0) parts.push(`${imgs} image${imgs === 1 ? '' : 's'}`);
      attachmentNote = `\n\nNote: ${parts.join(' and ')} attached above. Examine each carefully and factor them into your guidance.`;
    }

    // Quick mode skips playbook + doc retrieval — lookups don't need it and
    // every second of latency matters on a field-staff voice query. Coach
    // mode also skips RAG — the draft itself is the source material.
    const [playbookEntries, docContext, communityContext] = skipRag
      ? [[], '', await buildCommunityContextBlock(community).catch((e) => { console.warn('[community-ctx]', e.message); return ''; })]
      : await Promise.all([
          getRelevantPlaybook(situation || 'general guidance', { matchCount: 10 }),
          getRelevantChunks(situation || 'general guidance', community),
          buildCommunityContextBlock(community).catch((e) => { console.warn('[community-ctx]', e.message); return ''; }),
        ]);
    const playbookContext = skipRag
      ? ''
      : (formatPlaybookContext(playbookEntries, {
          heading: 'INSTITUTIONAL GUIDELINES FROM PAST SITUATIONS'
        }) || 'No relevant playbook examples for this question.');

    const reportedMode = quickMode ? 'quick' : (coachMode ? 'coach' : 'full');
    send({ type: 'meta', model: 'claude-sonnet-4-6', mode: reportedMode });

    const userContent = buildAskEdUserMessage({
      situation, community, communityContext, playbookContext, docContext, attachmentContents, attachmentNote
    });

    const systemPrompt = (quickMode
      ? askEdQuickSystem()
      : (coachMode ? askEdCoachSystem() : askEdSystem())
    ) + (toneFlag === 'casual' ? TONE_CASUAL_ADDENDUM : '');

    // Raw SSE iterator (stream:true on create). Avoids the listener-timing
    // race of the higher-level .stream() + .on('text') API.
    const streamResp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: quickMode ? 400 : (coachMode ? 3000 : 4000),
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
      stream: true
    });

    let deltaCount = 0;
    let eventCount = 0;
    for await (const event of streamResp) {
      if (aborted) break;
      eventCount++;
      if (event.type === 'content_block_delta' && event.delta && event.delta.type === 'text_delta') {
        deltaCount++;
        send({ type: 'delta', text: event.delta.text });
      }
    }

    console.log(`[ask-ed-stream] complete events=${eventCount} deltas=${deltaCount}`);
    if (!aborted) send({ type: 'done' });
    res.end();
  } catch (err) {
    console.error('[ask-ed-stream] failed:', err.stack || err.message);
    try { send({ type: 'error', message: safeErrorMessage(err) }); } catch (_) {}
    res.end();
  }
});

// ============================================================================
// POST /ask-ed-chat-stream — multi-turn chat version of /ask-ed-stream
// ----------------------------------------------------------------------------
// Accepts a conversation history so follow-up questions retain prior context.
// V1.1 upgrades over the original chat endpoint:
//   - Query rewrite via haiku: ambiguous follow-ups ("what about X?")
//     get rewritten into standalone search queries using conversation
//     history BEFORE RAG embedding fires. Fixes the "stateless RAG"
//     problem identified in the v1 honest assessment.
//   - Tool calls in streaming: lookup_community_vendor and friends now
//     work mid-stream. The model can ask "let me check the vendor
//     directory" and the answer comes back precise rather than from
//     RAG memory.
//   - File attachments via multer: PDFs + images attached to the latest
//     user turn (parity with /ask-ed-stream).
//   - Community context caching: per-community profile cached for 5
//     minutes per process so multi-turn threads don't re-query the
//     same data every turn.
//   - "Reading: …" badge: emit a context_loaded SSE event with counts
//     so the UI can show what Ed is consulting.
//
// SSE events:
//   {type:'meta', model, mode}            once at start
//   {type:'context_loaded', playbook_count, doc_count, community,
//    rewritten_query?}                   once after RAG
//   {type:'tool_status', name, message}   per tool invocation
//   {type:'delta', text}                  per text delta
//   {type:'done'}                         terminal
//   {type:'error', message}               failure
// ============================================================================

// In-memory community-profile cache. 5-minute TTL — long enough to span a
// multi-turn thread, short enough that profile updates land within a few
// minutes. Per-process; that's fine because the profile is cheap to rebuild.
const _communityProfileCache = new Map();
const COMMUNITY_PROFILE_TTL_MS = 5 * 60 * 1000;
async function getCachedCommunityContext(community) {
  const key = String(community || '').trim().toLowerCase() || '__all__';
  const cached = _communityProfileCache.get(key);
  const now = Date.now();
  if (cached && cached.expires > now) return cached.value;
  const value = await buildCommunityContextBlock(community).catch((e) => {
    console.warn('[community-ctx]', e.message);
    return '';
  });
  _communityProfileCache.set(key, { value, expires: now + COMMUNITY_PROFILE_TTL_MS });
  return value;
}

// Query rewrite for follow-up turns. If the user's latest message is
// ambiguous on its own ("what about X?", "and the cure period?", "is that
// right?"), the embedding-based RAG search has no idea what topic we're
// on. We use a cheap haiku call to rewrite the latest turn as a
// standalone query using the conversation history. The model has been
// instructed to leave already-standalone queries unchanged.
async function rewriteQueryForRag(history, latestQuery) {
  // No history = nothing to disambiguate against.
  if (history.length <= 1) return { rewritten: latestQuery, changed: false };
  try {
    const priorTurns = history.slice(-7, -1) // last 6 turns excluding the current user message
      .map((m) => `${m.role === 'assistant' ? 'Ed' : 'User'}: ${m.content.slice(0, 600)}`)
      .join('\n');
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: `You rewrite ambiguous follow-up questions into standalone search queries that an embedding model can use to retrieve relevant HOA management documents and past examples.

Rules:
- Output ONLY the rewritten query. No commentary, no quotes, no explanation.
- If the latest question is already standalone (mentions specific topics, communities, dates, statutes, etc.), return it EXACTLY unchanged.
- If the question is ambiguous (uses "it", "that", "they", "what about", "and X?"), rewrite using the topic established earlier in the conversation. Preserve entity names, statute numbers (§209.X), vendor names, and specific facts.
- Keep the rewritten query under 200 characters.
- Never invent topics that weren't in the conversation.`,
      messages: [{
        role: 'user',
        content: `Conversation so far:\n${priorTurns}\n\nLatest user question:\n"${latestQuery}"\n\nRewritten standalone query:`
      }],
    });
    const rewritten = ((resp.content[0]?.text) || latestQuery).trim();
    // Sanity: if the rewrite is obviously suspicious, fall back.
    if (!rewritten || rewritten.length < 3 || rewritten.length > 500) {
      return { rewritten: latestQuery, changed: false };
    }
    const changed = rewritten.toLowerCase().trim() !== latestQuery.toLowerCase().trim();
    return { rewritten, changed };
  } catch (err) {
    console.warn('[query-rewrite] failed, falling back to raw query:', err.message);
    return { rewritten: latestQuery, changed: false };
  }
}

// Helpers to surface chunk counts back to the UI as part of the "Reading…"
// badge. getRelevantChunks returns a joined string — we count separators.
function countDocChunks(joined) {
  if (!joined || typeof joined !== 'string') return 0;
  return joined.split('\n\n---\n\n').filter((s) => s.trim().length > 0).length;
}

// Friendly label for a tool name — shown in the "tool_status" SSE event.
function toolFriendlyLabel(name) {
  if (name === 'lookup_community_vendor') return 'Looking up vendor directory…';
  return `Running ${name}…`;
}

app.post('/ask-ed-chat-stream', upload.array('attachment', 10), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) {} };

  let aborted = false;
  res.on('close', () => { aborted = true; });

  try {
    // multer leaves req.body as fields. messages comes as a JSON string when
    // the request is multipart (because FormData stringifies).
    const community = (req.body.community || '').toString();
    const conciseFlag = String(req.body.concise || '').toLowerCase() === 'true';
    // Tone — defaults to 'casual' (the new Bedrock default) for everything
    // except explicit 'formal'. Casual injects the no-AI-tells voice block.
    const toneFlag = (String(req.body.tone || 'casual').toLowerCase() === 'formal') ? 'formal' : 'casual';
    let rawMessages = req.body.messages;
    if (typeof rawMessages === 'string') {
      try { rawMessages = JSON.parse(rawMessages); }
      catch (_) {
        send({ type: 'error', message: 'messages must be a JSON array' });
        return res.end();
      }
    }
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      send({ type: 'error', message: 'messages array required' });
      return res.end();
    }
    // Sanitize: keep only role + string content, drop empties.
    const history = rawMessages
      .filter((m) => m && typeof m.content === 'string' && m.content.trim().length > 0)
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content.trim(),
      }));
    if (history.length === 0 || history[history.length - 1].role !== 'user') {
      send({ type: 'error', message: 'last message must be from user' });
      return res.end();
    }
    // Cap context to last 20 turns to keep token usage bounded.
    const trimmed = history.slice(-20);
    const latestUserRaw = trimmed[trimmed.length - 1].content;

    // Build attachment blocks from any uploaded files.
    const attachmentContents = [];
    let attachmentNote = '';
    const incomingFiles = Array.isArray(req.files) ? req.files : [];
    for (const f of incomingFiles) {
      const mimeType = f.mimetype || '';
      if (mimeType === 'application/pdf') {
        attachmentContents.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.buffer.toString('base64') } });
      } else if (mimeType.startsWith('image/')) {
        const shrunk = await shrinkImageForAnthropic(f.buffer, mimeType);
        attachmentContents.push({ type: 'image', source: { type: 'base64', media_type: shrunk.mimetype, data: shrunk.buffer.toString('base64') } });
      } else {
        send({ type: 'error', message: `Unsupported file type: ${f.originalname || mimeType}. PDFs and images only.` });
        return res.end();
      }
    }
    if (attachmentContents.length > 0) {
      const pdfs = attachmentContents.filter((c) => c.type === 'document').length;
      const imgs = attachmentContents.filter((c) => c.type === 'image').length;
      const parts = [];
      if (pdfs > 0) parts.push(`${pdfs} PDF${pdfs === 1 ? '' : 's'}`);
      if (imgs > 0) parts.push(`${imgs} image${imgs === 1 ? '' : 's'}`);
      attachmentNote = `\n\nNote: ${parts.join(' and ')} attached above. Examine each carefully (screenshots, letters, photos of property conditions, etc.) and factor them into your guidance.`;
    }

    send({ type: 'meta', model: 'claude-sonnet-4-6', mode: conciseFlag ? 'chat-concise' : 'chat' });

    // STEP 1 — query rewrite to disambiguate follow-ups before RAG.
    const { rewritten: ragQuery, changed: queryWasRewritten } =
      await rewriteQueryForRag(trimmed, latestUserRaw);

    // STEP 2 — parallel RAG: playbook + docs + cached community profile.
    const [playbookEntries, docContext, communityContext] = await Promise.all([
      getRelevantPlaybook(ragQuery || 'general guidance', { matchCount: 10 }),
      getRelevantChunks(ragQuery || 'general guidance', community),
      getCachedCommunityContext(community),
    ]);
    const playbookContext = formatPlaybookContext(playbookEntries, {
      heading: 'INSTITUTIONAL GUIDELINES FROM PAST SITUATIONS'
    }) || 'No relevant playbook examples for this question.';

    // Surface what we just loaded back to the UI as the "Reading…" badge.
    send({
      type: 'context_loaded',
      playbook_count: Array.isArray(playbookEntries) ? playbookEntries.length : 0,
      doc_count: countDocChunks(docContext),
      community: community || null,
      has_community_profile: !!communityContext,
      rewritten_query: queryWasRewritten ? ragQuery : null,
    });

    // STEP 3 — build the final user message: rich RAG-augmented form,
    // optionally with attachments. Prior turns stay plain text.
    const lastUserAugmented = buildAskEdUserMessage({
      situation: latestUserRaw,
      community,
      communityContext,
      playbookContext,
      docContext,
      attachmentContents,
      attachmentNote,
    });

    const messagesForModel = trimmed.slice(0, -1).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    messagesForModel.push({ role: 'user', content: lastUserAugmented });

    // System prompt — same Ed voice as one-shot askEd, plus a chat-tone addendum
    // that varies by concise vs standard. Concise mode is what powers Voice
    // askEd's terse field-friendly responses; standard is full conversational
    // chat.
    const conciseAddendum = `

CONCISE MODE — VOICE / FIELD-STAFF DEFAULT:
You are being read aloud or shown to a Bedrock staff member or board member on the move (in the field, at a meeting, on a phone). Stay in Ed's voice but:
- 1-2 short sentences maximum. Lead with the answer. NO preamble, NO "here's what you need to know," NO strategic commentary, NO 4-section template.
- If the answer is a number or fact, just state it. ("Quorum is 25% — 181 of 721 units. Source: 2020 Amendment to Bylaws.")
- If a community-specific document has the answer, cite it briefly by name (one phrase).
- If the answer requires nuance the question can't be answered concisely, give the best 2-sentence answer and add "— ask me for the full version if you need it."
- Use plain prose. NO markdown headings, NO bullet lists, NO bold. The response may be spoken aloud.
- Phone numbers: format as 281-555-0100.
- Do not mention you are an AI. Do not apologize. Do not editorialize.`;

    const standardAddendum = `

CHAT MODE — CONVERSATIONAL DEFAULT:
You are in a multi-turn chat with a Bedrock staff member or board member. They can ask follow-up questions in the same thread. Stay in Ed's voice but:
- For follow-up questions that build on a prior answer, respond conversationally — no need to reprint the full 4-section template every turn.
- The 4-part template (RECOMMENDED ACTION / HOW TO RESPOND / REASONING / WATCH OUTS) is appropriate for the FIRST substantive question on a new topic, or when the user explicitly asks for a recommendation or a draft. For "what about X?", "explain that more," or "is that right?" — just answer.
- Track what the conversation has already established. Don't re-explain context the user already gave you.
- If a follow-up shifts to a clearly different topic, you can return to the structured template.
- Keep paragraphs tight. Use bullets when a list helps. Never wall-of-text on a clarifying question.`;

    const toneAddendum = toneFlag === 'casual' ? TONE_CASUAL_ADDENDUM : '';
    const systemPrompt = askEdSystem() + (conciseFlag ? conciseAddendum : standardAddendum) + toneAddendum + `

TOOL USE: You have a lookup_community_vendor tool that returns active vendor contacts (vendor name, contact person, phone, email, last-updated date) for a community + service category. Whenever the user asks for a phone number, email, or vendor contact for a specific community, ALWAYS call this tool — never recite phone numbers or emails from memory or the community profile summary. The tool's response is the source of truth.`;

    // STEP 4 — run the model with tools enabled, in a streaming tool loop.
    // Each iteration streams to the client; if the model stops with
    // 'tool_use', we execute the tools, push results back, and run again.
    const MAX_TOOL_HOPS = 5;
    const messagesAccum = [...messagesForModel];
    const maxTokensForCall = conciseFlag ? 500 : 3000;
    let deltaCount = 0;
    let toolCount = 0;
    let finalStopReason = null;

    for (let hop = 0; hop < MAX_TOOL_HOPS && !aborted; hop++) {
      const streamResp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokensForCall,
        system: systemPrompt,
        tools: askEdTools.TOOLS,
        messages: messagesAccum,
        stream: true,
      });

      // Accumulate the assistant turn's content blocks so we can push it
      // back into messagesAccum for the next hop.
      const assistantBlocks = [];
      let currentToolUse = null; // { id, name, input_json_acc }
      let currentText = '';
      let stopReason = null;

      for await (const event of streamResp) {
        if (aborted) break;
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            currentToolUse = {
              id: event.content_block.id,
              name: event.content_block.name,
              input_json_acc: '',
            };
            send({ type: 'tool_status', name: currentToolUse.name, message: toolFriendlyLabel(currentToolUse.name) });
          } else if (event.content_block.type === 'text') {
            currentText = '';
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            deltaCount++;
            currentText += event.delta.text;
            send({ type: 'delta', text: event.delta.text });
          } else if (event.delta.type === 'input_json_delta' && currentToolUse) {
            currentToolUse.input_json_acc += event.delta.partial_json || '';
          }
        } else if (event.type === 'content_block_stop') {
          if (currentToolUse) {
            let parsedInput = {};
            try { parsedInput = JSON.parse(currentToolUse.input_json_acc || '{}'); }
            catch (_) { parsedInput = {}; }
            assistantBlocks.push({
              type: 'tool_use',
              id: currentToolUse.id,
              name: currentToolUse.name,
              input: parsedInput,
            });
            currentToolUse = null;
          } else if (currentText) {
            assistantBlocks.push({ type: 'text', text: currentText });
            currentText = '';
          }
        } else if (event.type === 'message_delta') {
          if (event.delta && event.delta.stop_reason) stopReason = event.delta.stop_reason;
        }
      }
      if (aborted) break;
      finalStopReason = stopReason;

      if (stopReason !== 'tool_use') {
        // Done — final assistant turn was pure text.
        break;
      }

      // Execute the tools, push results back into the conversation.
      messagesAccum.push({ role: 'assistant', content: assistantBlocks });
      const toolResults = [];
      for (const block of assistantBlocks) {
        if (block.type !== 'tool_use') continue;
        toolCount++;
        const result = await askEdTools.executeAskEdTool(block.name, block.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
      messagesAccum.push({ role: 'user', content: toolResults });
      // Next iteration of the for-loop will stream the post-tool answer.
    }

    console.log(`[ask-ed-chat-stream] complete deltas=${deltaCount} tools=${toolCount} turns=${trimmed.length} rewritten=${queryWasRewritten}`);
    if (!aborted) send({ type: 'done' });
    res.end();
  } catch (err) {
    console.error('[ask-ed-chat-stream] failed:', err.stack || err.message);
    try { send({ type: 'error', message: safeErrorMessage(err) }); } catch (_) {}
    res.end();
  }
});

app.post('/ask-ed', upload.array('attachment', 10), async (req, res) => {
  try {
    const { situation, community, mode } = req.body;
    const modeNorm = (mode || '').toString().toLowerCase().trim();
    const quickMode = modeNorm === 'quick';
    const coachMode = modeNorm === 'coach_review';
    const toneFlag = (String(req.body.tone || 'casual').toLowerCase() === 'formal') ? 'formal' : 'casual';
    const skipRag = quickMode || coachMode;

    // Build attachment content blocks — supports multiple files
    const attachmentContents = [];
    let attachmentNote = '';
    const incomingFiles = Array.isArray(req.files) ? req.files : (req.file ? [req.file] : []);
    for (const f of incomingFiles) {
      const mimeType = f.mimetype || '';
      if (mimeType === 'application/pdf') {
        attachmentContents.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.buffer.toString('base64') } });
      } else if (mimeType.startsWith('image/')) {
        const shrunk = await shrinkImageForAnthropic(f.buffer, mimeType);
        attachmentContents.push({ type: 'image', source: { type: 'base64', media_type: shrunk.mimetype, data: shrunk.buffer.toString('base64') } });
      } else {
        return res.status(400).json({ guidance: `Unsupported file type: ${f.originalname || mimeType}. PDFs and images only.` });
      }
    }
    if (attachmentContents.length > 0) {
      const pdfs = attachmentContents.filter((c) => c.type === 'document').length;
      const imgs = attachmentContents.filter((c) => c.type === 'image').length;
      const parts = [];
      if (pdfs > 0) parts.push(`${pdfs} PDF${pdfs === 1 ? '' : 's'}`);
      if (imgs > 0) parts.push(`${imgs} image${imgs === 1 ? '' : 's'}`);
      attachmentNote = `\n\nNote: ${parts.join(' and ')} attached above. Examine each carefully (screenshots, letters, photos of property conditions, etc.) and factor them into your guidance.`;
    }

    // Semantic playbook retrieval + community docs + community profile,
    // all in parallel. Quick + coach modes skip RAG — quick because latency
    // matters, coach because the draft itself is the source material.
    const [playbookEntries, docContext, communityContext] = skipRag
      ? [[], '', await buildCommunityContextBlock(community).catch((e) => { console.warn('[community-ctx]', e.message); return ''; })]
      : await Promise.all([
          getRelevantPlaybook(situation || 'general guidance', { matchCount: 10 }),
          getRelevantChunks(situation || 'general guidance', community),
          buildCommunityContextBlock(community).catch((e) => { console.warn('[community-ctx]', e.message); return ''; })
        ]);
    const playbookContext = skipRag
      ? ''
      : (formatPlaybookContext(playbookEntries, {
          heading: 'INSTITUTIONAL GUIDELINES FROM PAST SITUATIONS'
        }) || 'No relevant playbook examples for this question.');

    const askEdSystemPrompt = `${GLOBAL_RULES}

You are "Ask Ed" — an AI advisor that thinks and responds exactly like Ed Gojara, owner of ${BRAND.service.name}. Ed has 15+ years of HOA management experience, an active CPA license (Big Four + regional firm Principal background), and an operations background from a high-frequency trading desk. He is the trusted advisor his boards rely on — not just a property manager.

ED'S COMMUNICATION STYLE:
- Lead with the answer, then explain the reasoning
- Be honest about uncertainty — never fake confidence
- Keep the tone warm and professional — you are a trusted partner, not a vendor
- Take ownership of delays or problems without making excuses
- Validate the person's instinct before correcting or adding nuance
- Never make board members or homeowners feel dumb for asking a question
- Walk through reasoning step by step so people understand the why
- Correct staff errors gracefully — never throw them under the bus, use language like "I wanted to clarify the earlier reply"
- Celebrate wins and acknowledge good work — share positive feedback with boards and give credit by name

ED'S DECISION-MAKING FRAMEWORK:
- On sensitive situations involving people: think about legal exposure first — especially Fair Housing Act
- On financial questions: apply CPA-level analysis, distinguish between "can't afford it" and "don't want to pay"
- On third-party disputes: identify the political and strategic context, not just the surface issue
- On vendor issues: maintain the relationship while being firm about deadlines and expectations
- On enforcement: focus on documented behavior, never on who someone is
- On major expenditures: always seek competitive bids — fiduciary duty to the association
- On incomplete work: deliver what you have rather than make people wait, be transparent about gaps
- On reserve funds: equities are not appropriate — push for CDs or stable vehicles even if board resists
- On governance: know voting thresholds, always note ratification requirement for between-meeting actions
- On attorney engagement: do your own document review first, ask specific precise questions, apply guidance immediately
- On neighbor disputes: keep the HOA out of it, protect homeowner privacy, redirect to city or law enforcement when appropriate
- On political activity: distinguish between individual board member actions and official HOA actions — HOA cannot endorse candidates or use HOA funds for political purposes

KEY PRINCIPLES:
- HOA reserve funds are for capital expenses, not market returns — investing in equities creates inappropriate risk
- Fair Housing Act protects disabilities, families, religion, national origin, race — never take action based on who someone is, only what they do
- When a board has already voted but new material information exists like a significantly cheaper bid, bring it to them before proceeding
- Don't let perfect be the enemy of good — deliver imperfect work transparently rather than delay
- Build vendor and banking relationships proactively, not just when you need something
- When in crisis with a vendor, be honest about stakes without being threatening — you need them to prioritize you
- Never share enforcement action details with a complaining neighbor — always say the Association handles compliance matters directly with the homeowner involved
- Homeowner privacy in enforcement matters is non-negotiable — never disclose what action was taken against another homeowner
- Jurisdiction matters — know what the HOA enforces vs what the city or law enforcement enforces
- When something goes well, say so — share positive feedback, name the people who made it happen, keep it brief and warm

CATEGORIES AND HOW ED HANDLES THEM:

BOARD SCHEDULING: Apologize briefly for delays, explain why deadlines exist such as legal notice requirements, make a specific recommendation rather than just listing options, close with appreciation and a clear next step.

FINANCIAL ANALYSIS: Validate the question, give directional read based on available data, flag what you would need to be definitive, identify political and strategic context, recommend a specific next step.

FINANCIAL REPORTING: Deliver data promptly, explain what numbers mean in plain language, flag anomalies and explain likely cause, contextualize whether something is normal or concerning.

VENDOR CRISIS: State the issue clearly and specifically, communicate deadline and stakes, stay professional and never accusatory, make judgment calls about timing, ask about process improvements once resolved.

LEGALLY SENSITIVE SITUATIONS: Acknowledge concern without dismissing it, set legal guardrail gently by saying we need to be careful, immediately pivot to what can be done, focus on documented behavior not identity, direct to police for safety concerns.

VENDOR SELECTION AND CONTRACT RENEWAL: Always seek competitive bids on significant expenditures, bring new information to board with full context, anticipate objections and address them upfront, lead with financial impact, support recommendation with specific qualitative evidence, let board own the decision, move to formal vote once clear.

BANKING RELATIONSHIPS: Maintain proactively, know financial products such as ICS, CDARS, IntraFi and brokered CDs, push for appropriate reserve vehicles, think ahead about new community needs.

DELIVERING INCOMPLETE WORK: Send what you have rather than wait, name outstanding items explicitly upfront, commit to follow-up, express confidence it will improve.

VIOLATION ENFORCEMENT: Always start with a courtesy notice regardless of history, use non-accusatory language, give the homeowner an out if already compliant, follow due process even when board members want to skip steps, focus on documented behavior not the person.

NEIGHBOR TO NEIGHBOR DISPUTES: Review governing documents first, distinguish between covenant violation and nuisance, send courtesy notice if there is a basis, protect homeowner privacy in all responses, define a clear escalation path with a decision point, keep the HOA out of purely neighbor to neighbor issues.

HOMEOWNER PRIVACY: Never tell a complaining homeowner what action was taken against their neighbor. Always respond with "the Association handles compliance matters directly with the homeowner involved and does not share details regarding enforcement actions."

BOARD VOTING AND GOVERNANCE: Know voting thresholds for your community, confirm majority clearly, set a hard deadline for objections, always note ratification requirement for actions taken between meetings, never let board vote on legally sensitive matters without attorney review.

ATTORNEY ENGAGEMENT: Do your own document review before contacting the attorney, ask specific and precise questions not general ones, apply the guidance immediately and make a clear decision, fill gaps in document files, thank them warmly and efficiently.

POLITICAL ACTIVITY AND HOA BOUNDARIES: HOA cannot officially endorse candidates, use HOA funds, or use official HOA communication channels for political purposes. Individual board members can support candidates in their personal capacity. Redirect to resident-led initiatives framed around education and voter participation rather than candidate endorsement.

ACC APPLICATION REVIEW: Form your opinion first based on governing documents, use conformity and drainage as legal hooks when no explicit prohibition exists, draft both the board communication and homeowner response, get board alignment before finalizing denial, always leave the door open for a revised application, treat each application identically regardless of who the homeowner is.

CORRECTING STAFF RESPONSES: Never throw staff under the bus publicly. Use language like "I wanted to clarify the earlier reply, I believe what was meant to say is..." Then provide the correct information with proper empathy, jurisdiction clarity, and a proactive next step.

CELEBRATING WINS AND COMMUNITY BUILDING: When something goes well share it. Forward positive feedback to the board. Name the specific people who contributed. Keep it brief and warm. Community events and positive homeowner interactions build the relationship capital that makes enforcement easier.

INTERNAL OPERATIONS AND TECHNOLOGY: When implementing changes explain why, give clear step by step instructions, set the new expectation explicitly, offer support for anyone who struggles. When clarifying a prior communication do it quickly and directly without ego.

HIGH DOLLAR PAYMENTS AND ATTORNEY INVOLVEMENT: Stay calm, own what you know and what you don't, lead with the solution not just the problem, communicate deadlines clearly, stay professional with all parties including attorneys, document everything.

When drafting any response letters or emails, always sign off as "${BRAND.service.name}" — never use a personal name in the signature.

TOOL USE: You have a lookup_community_vendor tool that returns the active vendor contact (vendor name, contact person, phone, email, last-updated date) for a community + service category. Whenever the user asks for any phone number, email address, or vendor contact for a specific community, ALWAYS call this tool — never recite phone numbers or emails from memory or summary text. The tool's response is the source of truth. After it returns, format the phone number clearly so the user can dial it.`;

    // Quick-lookup mode for internal staff — terse, no preamble, no strategic commentary.
    // Same backend, same tool; just a different voice.
    const askEdQuickPrompt = `${GLOBAL_RULES}

You are the ${BRAND.tech.product} quick-lookup assistant for ${BRAND.service.name} internal staff. The audience is a manager, assistant, or onsite team member who needs a fact fast — already has the business context.

ANSWER STYLE:
- 1 to 2 short sentences max. Lead with the answer. NO preamble, NO "here's what you need to know," NO strategic commentary, NO disclosure warnings, NO moralizing about who to share info with — this is internal use.
- Phone numbers: format as 281-555-0100 (no parentheses, with dashes).
- If multiple contacts match for the same category, list them compactly on separate short lines, e.g.:
    Joe Smith (Account Mgr) — 281-555-0100
    Sara Lee (Field Sup) — 281-555-0102
- If a contact is marked expired or unverified > 1 year, mention that in one short phrase ("⚠ verify — record is 14 months old").
- If no record exists, say so in one sentence and suggest adding it in Profile → Contacts.

TOOL USE: For any phone, email, or vendor contact question, ALWAYS call lookup_community_vendor. Never recite from memory. The tool returns ALL matching contacts as an array — surface all of them when the user didn't name a specific person.

Do not mention you are an AI. Do not apologize. Do not editorialize. Just the facts.`;

    const systemForCall = (quickMode
      ? askEdQuickPrompt
      : (coachMode ? askEdCoachSystem() : askEdSystemPrompt)
    ) + (toneFlag === 'casual' ? TONE_CASUAL_ADDENDUM : '');

    const { text: guidance } = await askEdTools.runAskEdWithTools({
      anthropic,
      messages: [{
        role: 'user',
        content: buildAskEdUserMessage({
          situation, community, communityContext, playbookContext, docContext, attachmentContents, attachmentNote
        })
      }],
      system: systemForCall,
      max_tokens: quickMode ? 400 : (coachMode ? 3000 : 4000),
    });

    // Silent belt-and-suspenders: even though the prompt forbids the
    // "Thank you for reaching out / I hope this helps" tells, strip any
    // that slipped through. Only applied in casual mode — formal mode
    // intentionally preserves the more measured phrasing.
    const cleaned = toneFlag === 'casual' ? stripBannedPhrases(guidance) : guidance;
    res.json({ guidance: cleaned });
  } catch (err) {
    console.error(err);
    res.status(500).json({ guidance: 'Error getting guidance. Please try again.' });
  }
});

// DEPRECATED 2026-05-17 — the "Review My Draft" tab was folded into askEd's
// Review mode (POST /ask-ed?mode=coach_review). Same coaching prompt, but
// integrated with the askEd context pipeline (community profile, etc.).
// Backward-compat stub. Remove once verified unused for a full cycle.
app.post('/review-draft', async (req, res) => {
  try {
    const { draft, draftType, community } = req.body;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: `${GLOBAL_RULES}

You are a supportive communication coach for ${BRAND.service.name} staff. Your job is to review drafts and help staff improve them — not criticize them. Think of yourself as a helpful mentor who wants the writer to succeed. Be encouraging, specific, and constructive. Never use harsh language or make the writer feel bad. Focus on what to improve and why, then show them a better version they can be proud of.

Ed's standards you are coaching toward:
- Lead with empathy when the situation involves a homeowner concern or complaint
- Be factually accurate — know what the HOA enforces vs what the city enforces
- Never be cold or dismissive — even a denial should feel professional and warm
- Protect homeowner privacy — never reference enforcement actions against other homeowners
- Use non-accusatory language in violation notices — give the homeowner an out
- Board communications should lead with financial impact and include a clear recommendation with reasoning
- Always sign off as "${BRAND.service.name}" — never use a personal name
- Correct jurisdiction issues — redirect to city or law enforcement when appropriate
- Leave doors open — denials should mention the option to resubmit a revised application
- Match the tone to the audience — boards get professional and data driven, homeowners get warm and clear

Common areas to watch for and coach gently:
- Responses that feel cold or dismissive — suggest warmer alternatives
- Missing empathy when a homeowner has a legitimate concern — show how to add it naturally
- Incorrect statements about what is or is not enforceable — gently correct with the right information
- Board emails that list options without a recommendation — show how to add one
- Personal name in signature instead of ${BRAND.service.name} — flag this kindly
- Vague next steps — show how to make them specific

Format your response as:
1. GOOD START — what the draft got right, even if small
2. A FEW THINGS TO STRENGTHEN — specific suggestions framed as improvements not failures
3. IMPROVED VERSION — a rewrite that shows what great looks like
4. QUICK SUMMARY — two or three sentences on the main changes made` +
      // Apply casual tone to the IMPROVED VERSION the coach writes, unless
      // staff explicitly asked for a formal draft type (violation notice,
      // attorney correspondence, board legal memo).
      (((req.body.tone || 'casual').toLowerCase() === 'casual')
        && !['violation notice','attorney communication','board legal memo'].includes((draftType || '').toLowerCase())
          ? TONE_CASUAL_ADDENDUM
          : ''),
      messages: [{
        role: 'user',
        content: `Please review this ${draftType || 'communication'} draft${community ? ` for ${community}` : ''} and provide feedback and an improved version.\n\nDraft to review:\n\n${draft}`
      }]
    });

    const reviewText = response.content[0].text;
    const cleaned = (((req.body.tone || 'casual').toLowerCase() === 'casual')
      && !['violation notice','attorney communication','board legal memo'].includes((draftType || '').toLowerCase()))
        ? stripBannedPhrases(reviewText)
        : reviewText;
    res.json({ review: cleaned });
  } catch (err) {
    console.error(err);
    res.status(500).json({ review: 'Error reviewing draft. Please try again.' });
  }
});

app.post('/generate-agenda', async (req, res) => {
  try {
    const { community, meetingType, date, time, location, newBusiness, businessInProgress, committees, ratifications, nextMeeting } = req.body;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: `You are an expert HOA meeting coordinator for ${BRAND.service.name}. You generate professional, legally compliant board meeting agendas for Texas HOA communities.

You follow Texas Property Code Chapter 209 requirements for board meetings including:
- Homeowner Forum must be included before Executive Session
- Executive Session must cite Texas Property Code Section 209.0051
- All agenda items must be listed for proper notice
- Meeting must be properly called to order with quorum confirmation

CRITICAL FORMATTING RULES:
- Plain text only — no markdown, no bold with **, no headers with ##, no dashes for bullets
- Use bullet points with the character • under each numbered item
- Use the exact community name provided — never substitute another community name
- Follow this exact format and spacing:

[Community Name] Homeowners Association, Inc.
Meeting of the Board of Directors
[Day of Week], [Month] [Day], [Year]
[Time]
[Location]

Meeting Agenda

1. Confirm Quorum and Call Open Session Meeting to order
2. Approval of Meeting Minutes
   • Approval of prior Meeting Minutes – [Prior Month Year]
3. Ratifications between meetings
   • [items or None]
4. New Business
   • [items or omit if none]
5. Finances
   • Finance Committee
6. Business in Progress
   • [items]
   • The Board may discuss additional Association matters or routine items that arise during the normal course of operations
7. Committee Reports
   • [committees listed]
8. Homeowner Forum
   • Owners may speak, please limit comments to up to 3 minutes per owner so everyone has a chance to be heard before repeating turns
9. Executive Session
   • Legal matters and attorney communications
   • Delinquent accounts and collection actions
   • Enforcement and compliance issues
   • Other confidential matters as permitted by Texas Property Code §209.0051
10. Executive Session Adjournment
11. Next regularly scheduled Board of Directors meeting: [date, time, location]`,
      messages: [{
        role: 'user',
        content: `Generate a complete board meeting agenda using EXACTLY this information:

Community: ${community}
Meeting Type: ${meetingType}
Date: ${date}
Time: ${time}
Location: ${location}
Ratifications since last meeting: ${ratifications || 'None'}
New Business Items: ${newBusiness || 'None'}
Business in Progress: ${businessInProgress || 'None'}
Committee Reports Expected: ${committees || 'None'}
Next Meeting Date: ${nextMeeting || 'To be determined'}

Use the community name exactly as provided. Plain text only. No markdown formatting.`
      }]
    });

    res.json({ agenda: response.content[0].text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ agenda: 'Error generating agenda. Please try again.' });
  }
});

app.post('/playbook', async (req, res) => {
  try {
    const { situation, context, response, reasoning, category, tags } = req.body;
    const { data, error } = await supabase.from('playbook').insert({
      situation, context, response, reasoning, category,
      tags: tags ? tags.split(',').map(t => t.trim()) : []
    }).select();
    if (error) throw error;
    res.json({ success: true, entry: data[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/playbook', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('playbook')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ entries: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// VENDOR WORKFLOW — Bid Request, Proposal Upload, Comparison
// =====================================================================

app.post('/generate-bid', upload.single('contract'), async (req, res) => {
  try {
    const { community, vendorType, additionalRequirements, manualScope, bidDeadline, contractTerm } = req.body;

    let scopeContent = '';
    let sourceContractFilename = null;

    if (req.file) {
      sourceContractFilename = req.file.originalname;
      const pdfBase64 = req.file.buffer.toString('base64');
      const extractResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 }
            },
            {
              type: 'text',
              text: 'This is a vendor contract or specification document. Please extract: 1) All services provided and their descriptions, 2) Service frequencies and schedules, 3) Current pricing for each service line, 4) Any performance standards or requirements, 5) Insurance or licensing requirements mentioned, 6) Contract terms. Be thorough and specific.'
            }
          ]
        }]
      });
      scopeContent = extractResponse.content[0].text;
    } else if (manualScope) {
      scopeContent = manualScope;
    } else {
      return res.status(400).json({ error: 'Please upload a contract or enter scope manually.' });
    }

    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    const bidResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      system: `You are an expert HOA property manager and procurement specialist for ${BRAND.service.name}. You create professional, detailed bid request documents that allow HOA communities to get competitive bids from vendors. Your bid requests are clear, specific, and ensure vendors bid on exactly the same scope so bids are truly comparable.

Your bid requests always include:
- Professional header and introduction
- Community background and context
- Detailed scope of work with specific frequencies and requirements
- Performance standards and expectations
- Insurance and licensing requirements
- Bid submission format requirements — what vendors must include in their response
- Evaluation criteria — how bids will be scored
- Submission deadline and instructions
- Contact information

FORMATTING:
- Plain text only — no markdown, no pound signs for headers, no asterisks for bold
- Use numbered sections like "SECTION 1:" not markdown headers
- Use bullet points with the • character not dashes or asterisks
- Use ALL CAPS for section headers instead of markdown formatting
- Include a pricing table using plain text alignment
- Professional and formal tone
- Sign off as ${BRAND.service.name} on behalf of the community`,
      messages: [{
        role: 'user',
        content: `Generate a professional bid request document for the following:

Community: ${community || 'HOA Community'}
Vendor Type: ${vendorType || 'Vendor Services'}
Date: ${today}
Bid Submission Deadline: ${bidDeadline || '30 days from date of this request'}
Desired Contract Term: ${contractTerm || '1 year with option to renew'}

Extracted scope from existing contract or provided scope:
${scopeContent}

${additionalRequirements ? `Additional requirements or changes from current scope:\n${additionalRequirements}` : ''}

Generate a complete professional bid request document that:
1. Vendors can use to prepare a complete and comparable bid
2. Includes a pricing table they must fill out with line items matching the scope
3. Specifies exactly what must be included in their bid response
4. Sets clear evaluation criteria
5. Is ready to send to multiple vendors today`
      }]
    });

    const generatedDocument = bidResponse.content[0].text;

    // Build structured RFP for Word doc download
    let structuredRfp = null;
    try {
      structuredRfp = await buildStructuredRFP({
        community: community || 'HOA Community',
        vendorType: vendorType || 'Vendor Services',
        contractTerm: contractTerm || '1 year with option to renew',
        bidDeadline,
        scopeContent,
        additionalRequirements
      });
    } catch (rfpErr) {
      console.error('Error building structured RFP (non-fatal):', rfpErr.message);
    }

    // Save the bid request to the database so we can link proposals to it later.
    const { data: savedBidRequest, error: saveError } = await supabase
      .from('bid_requests')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        community: community || 'Unknown',
        vendor_type: vendorType || 'Other',
        contract_term: contractTerm,
        bid_deadline: bidDeadline || null,
        scope_summary: scopeContent.slice(0, 2000),
        generated_document: generatedDocument,
        source_contract_filename: sourceContractFilename,
        status: 'open',
        structured_rfp: structuredRfp
      })
      .select()
      .single();

    if (saveError) {
      console.error('Error saving bid request:', saveError);
      // Don't fail the whole request — still return the document.
    }

    res.json({
      bidRequest: generatedDocument,
      bidRequestId: savedBidRequest?.id || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error generating bid request: ' + err.message });
  }
});

// List open bid requests so user can pick one when uploading a proposal
app.get('/bid-requests', async (req, res) => {
  try {
    const { community } = req.query;
    let query = supabase
      .from('bid_requests')
      .select('id, community, vendor_type, contract_term, bid_deadline, created_at, status')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('created_at', { ascending: false })
      .limit(50);
    if (community) query = query.eq('community', community);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ bidRequests: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Component Taxonomy Mapping
// ----------------------------------------------------------------------------
// Given a proposal's extracted line items + the service category, ask the AI
// to map each line item to a canonical component from service_category_components.
// Also detects MISSING components (canonical entries with typical_inclusion_rate
// of 'always'/'usually' that this proposal doesn't address — the gap detection
// that flags "low base price by exclusion" shenanigans).
//
// Saves mappings to proposal_component_mappings. Idempotent: re-running clears
// prior mappings for this proposal first.
// ============================================================================
async function mapProposalComponents(proposalId, opts = {}) {
  try {
    // Load proposal
    const { data: proposal, error: pErr } = await supabase
      .from('vendor_proposals')
      .select('id, service_category, extracted_data, term_months')
      .eq('id', proposalId)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (pErr || !proposal) return { ok: false, error: 'proposal not found' };

    const serviceCategory = proposal.service_category || 'other';
    const lineItems = Array.isArray(proposal.extracted_data?.line_items)
      ? proposal.extracted_data.line_items : [];

    // Load canonical components for this category
    const { data: components } = await supabase
      .from('service_category_components')
      .select('component_key, display_name, description, typical_inclusion_rate, typical_unit, is_typical_exclusion, is_high_markup_target')
      .eq('service_category', serviceCategory)
      .order('sort_order');

    if (!components || components.length === 0) {
      // No taxonomy for this category — nothing to map
      return { ok: true, mapped: 0, missing: 0, note: 'no canonical components for category: ' + serviceCategory };
    }

    if (lineItems.length === 0 && (!proposal.extracted_data?.totals?.total)) {
      return { ok: true, mapped: 0, missing: 0, note: 'no line items to map' };
    }

    const componentList = components.map(c => `- ${c.component_key}: ${c.display_name} (typically ${c.typical_inclusion_rate}; ${c.typical_unit})${c.description ? ' — ' + c.description : ''}`).join('\n');

    const prompt = `You are decomposing a vendor proposal into canonical components so it can be compared apples-to-apples with other proposals. The vendor's wording often obscures what's included vs. excluded vs. marked up — your job is to see through it.

SERVICE CATEGORY: ${serviceCategory}

CANONICAL COMPONENTS available for this category:
${componentList}

PROPOSAL LINE ITEMS:
${JSON.stringify(lineItems, null, 2)}

OVERALL PROPOSAL FINANCIALS:
- Stated total: ${proposal.extracted_data?.totals?.total ?? 'not stated'}
- Term months: ${proposal.term_months ?? 'unclear'}
- Contract type: ${proposal.extracted_data?.document_type ?? 'unclear'}

YOUR JOB — return JSON exactly this shape:

{
  "mappings": [
    {
      "raw_line_item_index": <integer index of the line item in the input array, or null if you inferred this component from extracted_data outside line_items>,
      "raw_line_item_description": "string — verbatim from vendor's proposal",
      "raw_line_item_amount": <number or null>,
      "raw_line_item_unit": "string — what the vendor said: 'monthly','annual','per_hour','per_visit', etc.",
      "component_key": "exact key from the canonical list above, OR null if no canonical component fits",
      "normalized_annual_amount": <number — annualized for cross-vendor comparison. If amount is monthly, multiply by 12. If quoted across the proposal term, divide by term_months and multiply by 12. Use null if amount unclear.>,
      "is_included_in_base": <boolean — true if part of base contract price; false if listed as ADD-ON, OPTIONAL, or EXCLUSION>,
      "mapping_confidence": "high | medium | low | unmapped",
      "notes": "string — anything unusual about this mapping. Flag suspicious markups, ambiguous bundling, vague descriptions."
    }
  ],
  "missing_components": [
    "list of canonical component_key strings that are NOT addressed in this proposal AT ALL (neither in line items nor implicitly bundled). Focus on components with typical_inclusion_rate of 'always' or 'usually' — those are the suspicious gaps. Skip 'rarely' ones unless they're explicitly mentioned as exclusions."
  ],
  "implicit_inclusions": [
    "list of canonical component_key strings that this proposal probably INCLUDES implicitly (no separate line item but mentioned in scope/terms). Use sparingly — only when you're confident the vendor's narrative covers it."
  ],
  "overall_notes": "1-3 sentences calling out: opacity tactics this vendor used, suspicious omissions, unusual bundling, anything an experienced auditor would flag for the board."
}

CRITICAL RULES:
- Use 'unmapped' confidence + null component_key for line items that don't fit any canonical component (e.g., "Documentation fee" — doesn't match any component).
- When a single line item bundles multiple components (e.g., "Pool maintenance and chemicals — $5,000/month"), split into multiple mapping rows with the SAME raw_line_item_index but different component_keys and your best split of the amount. Note in 'notes' that you split it.
- For missing_components: this is the LOWBALL DETECTION layer. A pool contract without chemicals_supply, or a landscape contract without fertilization, is suspicious. Be aggressive in flagging.
- Annualization: if term is 7 months and total is $35,000, the annualized is $60,000 ($35K / 7 * 12). Apply consistently.
- Numbers are NUMBERS, not strings.

Return ONLY the JSON. No preamble, no markdown fences.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = response.content[0]?.text || '';
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    let result;
    try {
      result = JSON.parse(cleaned);
    } catch (parseErr) {
      console.warn('[mapProposalComponents] JSON parse failed:', parseErr.message);
      return { ok: false, error: 'mapping JSON parse failed: ' + parseErr.message };
    }

    // Wipe any prior mappings for this proposal (idempotent remap)
    await supabase.from('proposal_component_mappings').delete().eq('proposal_id', proposalId);

    const rows = [];

    // Add mapped line items
    for (const m of (result.mappings || [])) {
      rows.push({
        proposal_id: proposalId,
        service_category: serviceCategory,
        component_key: m.component_key || null,
        raw_line_item_index: m.raw_line_item_index ?? null,
        raw_line_item_description: m.raw_line_item_description || null,
        raw_line_item_amount: m.raw_line_item_amount ?? null,
        raw_line_item_unit: m.raw_line_item_unit || null,
        normalized_annual_amount: m.normalized_annual_amount ?? null,
        mapping_confidence: m.mapping_confidence || 'medium',
        is_included_in_base: m.is_included_in_base !== false,
        is_missing_from_proposal: false,
        notes: m.notes || null
      });
    }

    // Add MISSING components as separate rows — the gap detection layer
    const missingKeys = Array.isArray(result.missing_components) ? result.missing_components : [];
    for (const key of missingKeys) {
      // Validate the key actually exists in the canonical list
      const comp = components.find(c => c.component_key === key);
      if (!comp) continue;
      rows.push({
        proposal_id: proposalId,
        service_category: serviceCategory,
        component_key: key,
        raw_line_item_index: null,
        raw_line_item_description: null,
        raw_line_item_amount: null,
        raw_line_item_unit: null,
        normalized_annual_amount: null,
        mapping_confidence: 'high',                     // high confidence it's missing
        is_included_in_base: false,
        is_missing_from_proposal: true,
        flagged_as_unusual_exclusion: comp.typical_inclusion_rate === 'always' || comp.typical_inclusion_rate === 'usually',
        notes: `Canonical component '${comp.display_name}' (typically ${comp.typical_inclusion_rate}) is NOT addressed in this proposal.`
      });
    }

    if (rows.length > 0) {
      await supabase.from('proposal_component_mappings').insert(rows);
    }

    // Trade tape (best-effort, swallow errors)
    try {
      await supabase.from('agent_runs').insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        module: 'vendor_workflow',
        endpoint: 'mapProposalComponents',
        request_input: { proposal_id: proposalId, service_category: serviceCategory, line_items_count: lineItems.length },
        prompt: 'COMPONENT_MAPPING_PROMPT',
        model: 'claude-sonnet-4-5',
        response: { mappings_count: (result.mappings || []).length, missing_count: missingKeys.length, overall_notes: result.overall_notes },
        input_tokens: response.usage?.input_tokens || null,
        output_tokens: response.usage?.output_tokens || null
      });
    } catch (_) { /* swallow */ }

    return {
      ok: true,
      mapped: (result.mappings || []).length,
      missing: missingKeys.length,
      overall_notes: result.overall_notes || null
    };
  } catch (err) {
    console.error('[mapProposalComponents] failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// Upload a vendor proposal PDF, extract structured data, save to database
app.post('/upload-proposal', upload.single('proposal'), async (req, res) => {
  try {
    const { community, bidRequestId, serviceCategory, documentType } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No proposal PDF uploaded.' });
    }

    const pdfBase64 = req.file.buffer.toString('base64');
    const filename = req.file.originalname;

    const extractionResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: `You are a vendor proposal analyst for ${BRAND.service.name}. Your job is to extract structured data from vendor proposals so they can be compared apples-to-apples.

CRITICAL RULES:
- Extract ONLY what is explicitly stated in the proposal. Do not infer, guess, or add information.
- If a field is not present in the proposal, return null for that field.
- For pricing, capture exactly as written including any tax, discount, or fee notes.
- Preserve the vendor's own wording for scope items — do not paraphrase.
- Flag anything ambiguous or unusual in the "extraction_notes" field.

Return ONLY valid JSON, no preamble, no markdown fences, no explanation.`,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 }
          },
          {
            type: 'text',
            text: `Extract structured data from this vendor proposal. Return JSON in exactly this shape:

{
  "vendor_name": "string — exact vendor name as on document",
  "vendor_contact": {
    "name": "string or null",
    "email": "string or null",
    "phone": "string or null",
    "address": "string or null"
  },
  "proposal_date": "YYYY-MM-DD or null",
  "proposal_number": "string or null (estimate/quote/proposal number)",
  "document_type": "project_bid | service_contract | mixed",
  "service_category_guess": "string — your best guess at category (landscape_construction, landscape_maintenance, tree_service, pool_management, janitorial, pressure_washing, painting, repair, other)",
  "currency": "USD",
  "totals": {
    "subtotal": "number or null",
    "tax": "number or null",
    "total": "number or null",
    "tax_rate_percent": "number or null"
  },
  "line_items": [
    {
      "description": "string — what the vendor wrote",
      "category": "string — your best guess (water_feature, lighting, plants, trees, benches, hardscape, labor, equipment, etc.)",
      "quantity": "number or null",
      "unit": "string or null (each, sq_ft, linear_ft, hour, etc.)",
      "unit_price": "number or null",
      "total_price": "number or null",
      "inclusions": ["array of bullet points the vendor lists as included"],
      "exclusions": ["array of items called out as not included or optional"],
      "notes": "string or null"
    }
  ],
  "service_contract_details": {
    "is_recurring": "boolean",
    "term_length": "string or null",
    "term_months": "number or null — total months covered by this proposal (e.g. 7 for a June-Dec contract, 12 for a year). Required for normalization. If unclear, your best estimate based on stated dates.",
    "term_start_date": "YYYY-MM-DD or null",
    "term_end_date": "YYYY-MM-DD or null",
    "monthly_pricing_schedule": [{"month": "January", "amount": "number"}],
    "change_order_rates": "string or null",
    "escalation_clauses": "string or null",
    "termination_terms": "string or null",
    "private_event_pricing": "string or null"
  },
  "insurance_provided": {
    "general_liability": "string or null",
    "umbrella": "string or null",
    "workers_comp": "string or null",
    "auto": "string or null"
  },
  "payment_terms": "string or null",
  "validity_period": "string or null",
  "key_terms_summary": "string — 2-3 sentences summarizing important terms beyond pricing",
  "extraction_notes": "string — anything ambiguous, unusual, or hard to extract. Be honest about uncertainty."
}

For project_bid documents (one-time work), service_contract_details fields will mostly be null.
For service_contract documents (recurring services), line_items may be sparse but service_contract_details should be populated.
For mixed documents, populate both as relevant.`
          }
        ]
      }]
    });

    let extractedData;
    let rawText = extractionResponse.content[0].text;
    rawText = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();

    try {
      extractedData = JSON.parse(rawText);
    } catch (parseErr) {
      console.error('Failed to parse extraction JSON:', parseErr);
      return res.status(500).json({
        error: 'Could not parse vendor proposal. The PDF may be unusual format.',
        raw_text: rawText.slice(0, 500)
      });
    }

    // Find or create the vendor record
    const vendorName = extractedData.vendor_name || 'Unknown Vendor';
    let vendorId = null;

    const { data: existingVendor } = await supabase
      .from('vendors')
      .select('id')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .ilike('name', vendorName)
      .maybeSingle();

    if (existingVendor) {
      vendorId = existingVendor.id;
    } else {
      const { data: newVendor, error: vendorError } = await supabase
        .from('vendors')
        .insert({
          management_company_id: BEDROCK_MGMT_CO_ID,
          name: vendorName,
          contact_name: extractedData.vendor_contact?.name,
          contact_email: extractedData.vendor_contact?.email,
          contact_phone: extractedData.vendor_contact?.phone,
          address: extractedData.vendor_contact?.address
        })
        .select('id')
        .single();

      if (vendorError) {
        console.error('Error creating vendor:', vendorError);
      } else {
        vendorId = newVendor.id;
      }
    }

    // Capture term_months and compute annualized total for normalization
    const termMonths = extractedData.service_contract_details?.term_months || null;
    const statedTotal = extractedData.totals?.total || null;
    let annualizedTotal = null;
    let annualizationBasis = null;

    if (statedTotal != null) {
      if (termMonths && termMonths > 0 && termMonths !== 12) {
        annualizedTotal = (statedTotal / termMonths) * 12;
        annualizationBasis = `Annualized from ${termMonths}-month proposal at stated rates`;
      } else if (termMonths === 12 || !termMonths) {
        annualizedTotal = statedTotal;
        annualizationBasis = termMonths === 12 ? 'Stated 12-month total' : 'Term length unclear, treating stated total as annual';
      }
    }

    const isIncumbent = req.body.isIncumbent === 'true' || req.body.isIncumbent === true;

    // Save the original PDF to Supabase Storage so we have a permanent record.
    // Bucket: 'documents' (shared with the Documents Tracker). Path:
    // vendor_proposals/{mgmt_co}/{community}/{uuid}.pdf
    // If storage fails (bucket missing, perms), we log and continue — the proposal
    // still gets saved to DB just without a file_path. Original-PDF download will
    // gracefully fall back to the branded HTML summary.
    const crypto = require('crypto');
    const proposalIdForStorage = crypto.randomUUID();
    const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const safeCommunityPath = (community || 'unknown').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
    const storagePath = `vendor_proposals/${BEDROCK_MGMT_CO_ID}/${safeCommunityPath}/${proposalIdForStorage}.pdf`;
    let storedFilePath = null;
    try {
      const { error: storageErr } = await supabase.storage
        .from('documents')
        .upload(storagePath, req.file.buffer, { contentType: 'application/pdf', upsert: false });
      if (storageErr) {
        console.warn('[upload-proposal] storage save skipped:', storageErr.message);
      } else {
        storedFilePath = storagePath;
      }
    } catch (sErr) {
      console.warn('[upload-proposal] storage exception:', sErr.message);
    }

    const { data: savedProposal, error: proposalError } = await supabase
      .from('vendor_proposals')
      .insert({
        id: proposalIdForStorage,
        management_company_id: BEDROCK_MGMT_CO_ID,
        community: community || 'Unknown',
        vendor_id: vendorId,
        bid_request_id: bidRequestId || null,
        document_type: documentType || extractedData.document_type || 'project_bid',
        service_category: serviceCategory || extractedData.service_category_guess || 'other',
        filename: filename,
        vendor_name_raw: vendorName,
        proposal_date: extractedData.proposal_date || null,
        proposal_number: extractedData.proposal_number,
        total_amount: statedTotal,
        currency: extractedData.currency || 'USD',
        extracted_data: extractedData,
        raw_extraction_text: rawText,
        extraction_status: 'extracted',
        is_incumbent: isIncumbent,
        term_months: termMonths,
        annualized_total_amount: annualizedTotal,
        annualization_basis: annualizationBasis,
        file_path: storedFilePath,
        file_hash: fileHash,
        file_size_bytes: req.file.size
      })
      .select()
      .single();

    if (proposalError) {
      console.error('Error saving proposal:', proposalError);
      return res.status(500).json({ error: 'Could not save proposal to database: ' + proposalError.message });
    }

    // Fire component mapping in the background — don't block the upload response.
    // The mapping will be queryable via GET /vendor-proposals/:id/components
    // a moment later. Logs but doesn't fail the upload if mapping errors out.
    mapProposalComponents(savedProposal.id)
      .then(r => console.log('[upload-proposal] component mapping:', JSON.stringify(r)))
      .catch(e => console.warn('[upload-proposal] component mapping failed:', e.message));

    res.json({
      success: true,
      proposal: savedProposal,
      summary: {
        vendor: vendorName,
        total: extractedData.totals?.total,
        line_items_count: extractedData.line_items?.length || 0,
        document_type: extractedData.document_type,
        extraction_notes: extractedData.extraction_notes
      }
    });
  } catch (err) {
    console.error('Proposal upload error:', err);
    res.status(500).json({ error: 'Error processing proposal: ' + err.message });
  }
});

// Generate an RFP from an already-uploaded vendor proposal
// Strips vendor identity and pricing, keeps scope items as the basis for a generic RFP
app.post('/generate-rfp-from-proposal', async (req, res) => {
  try {
    const { proposalId, community, vendorType, contractTerm, bidDeadline, additionalRequirements } = req.body;

    if (!proposalId) {
      return res.status(400).json({ error: 'proposalId is required.' });
    }

    const { data: proposal, error: loadError } = await supabase
      .from('vendor_proposals')
      .select('*, vendors(name)')
      .eq('id', proposalId)
      .single();

    if (loadError || !proposal) {
      return res.status(404).json({ error: 'Proposal not found.' });
    }

    const extracted = proposal.extracted_data || {};
    const lineItems = extracted.line_items || [];

    let scopeText = `Scope of work derived from a sample proposal (vendor identity and pricing removed). The selected vendor will be expected to provide the following:\n\n`;

    if (lineItems.length > 0) {
      lineItems.forEach((item, idx) => {
        scopeText += `${idx + 1}. ${item.description || 'Service item'}\n`;
        if (item.quantity && item.unit) {
          scopeText += `   Quantity: ${item.quantity} ${item.unit}\n`;
        }
        if (item.inclusions && item.inclusions.length > 0) {
          scopeText += `   Includes: ${item.inclusions.join('; ')}\n`;
        }
        if (item.exclusions && item.exclusions.length > 0) {
          scopeText += `   Notes/Exclusions: ${item.exclusions.join('; ')}\n`;
        }
        scopeText += '\n';
      });
    }

    if (extracted.service_contract_details?.is_recurring) {
      scopeText += `\nThis is a recurring service contract. `;
      if (extracted.service_contract_details.term_length) {
        scopeText += `Term length: ${extracted.service_contract_details.term_length}. `;
      }
    }

    if (extracted.key_terms_summary) {
      scopeText += `\nKey terms (vendor-specific terms have been removed; vendors should propose their own): ${extracted.key_terms_summary.replace(/\$[\d,]+(\.\d+)?/g, '[pricing TBD]')}\n`;
    }

    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    const bidResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      system: `You are an expert HOA property manager and procurement specialist for ${BRAND.service.name}. You create professional, detailed bid request documents that allow HOA communities to get competitive bids from vendors. Your bid requests are clear, specific, and ensure vendors bid on exactly the same scope so bids are truly comparable.

You are generating a bid request based on a scope extracted from a sample proposal. Vendor-specific identity and pricing have been removed; you are producing a clean generic RFP based on the underlying scope.

Your bid requests always include:
- Professional header and introduction
- Community background and context
- Detailed scope of work with specific frequencies and requirements
- Performance standards and expectations
- Insurance and licensing requirements
- Bid submission format requirements — what vendors must include in their response
- Evaluation criteria — how bids will be scored
- Submission deadline and instructions
- Contact information

FORMATTING:
- Plain text only — no markdown, no pound signs for headers, no asterisks for bold
- Use numbered sections like "SECTION 1:" not markdown headers
- Use bullet points with the • character not dashes or asterisks
- Use ALL CAPS for section headers instead of markdown formatting
- Include a pricing table using plain text alignment
- Professional and formal tone
- Sign off as ${BRAND.service.name} on behalf of the community`,
      messages: [{
        role: 'user',
        content: `Generate a professional bid request document for the following:

Community: ${community || 'HOA Community'}
Vendor Type: ${vendorType || extracted.service_category_guess || 'Vendor Services'}
Date: ${today}
Bid Submission Deadline: ${bidDeadline || '30 days from date of this request'}
Desired Contract Term: ${contractTerm || '1 year with option to renew'}

Scope of work (derived from a sample proposal — vendor identity and pricing have been stripped):
${scopeText}

${additionalRequirements ? `Additional requirements or changes:\n${additionalRequirements}` : ''}

Generate a complete professional bid request document that:
1. Vendors can use to prepare a complete and comparable bid
2. Includes a pricing table they must fill out with line items matching the scope above
3. Specifies exactly what must be included in their bid response
4. Sets clear evaluation criteria
5. Is ready to send to multiple vendors today
6. Does not reveal that the scope was derived from a specific vendor's proposal`
      }]
    });

    const generatedDocument = bidResponse.content[0].text;

    // Build structured RFP for Word doc download
    let structuredRfp = null;
    try {
      structuredRfp = await buildStructuredRFP({
        community: community || proposal.community || 'HOA Community',
        vendorType: vendorType || extracted.service_category_guess || 'Vendor Services',
        contractTerm: contractTerm || '1 year with option to renew',
        bidDeadline,
        scopeContent: scopeText,
        additionalRequirements
      });
    } catch (rfpErr) {
      console.error('Error building structured RFP (non-fatal):', rfpErr.message);
    }

    const { data: savedBidRequest, error: saveError } = await supabase
      .from('bid_requests')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        community: community || proposal.community || 'Unknown',
        vendor_type: vendorType || extracted.service_category_guess || 'Other',
        contract_term: contractTerm,
        bid_deadline: bidDeadline || null,
        scope_summary: scopeText.slice(0, 2000),
        generated_document: generatedDocument,
        source_contract_filename: proposal.filename,
        status: 'open',
        structured_rfp: structuredRfp
      })
      .select()
      .single();

    if (saveError) {
      console.error('Error saving bid request from proposal:', saveError);
    }

    if (savedBidRequest) {
      await supabase
        .from('vendor_proposals')
        .update({ bid_request_id: savedBidRequest.id })
        .eq('id', proposalId);
    }

    res.json({
      bidRequest: generatedDocument,
      bidRequestId: savedBidRequest?.id || null,
      originatingProposalId: proposalId
    });
  } catch (err) {
    console.error('RFP from proposal error:', err);
    res.status(500).json({ error: 'Error generating RFP from proposal: ' + err.message });
  }
});

// Download a polished Word doc RFP for a saved bid request
app.get('/download-rfp/:bidRequestId', async (req, res) => {
  try {
    const { bidRequestId } = req.params;

    const { data: bidRequest, error: loadError } = await supabase
      .from('bid_requests')
      .select('*')
      .eq('id', bidRequestId)
      .single();

    if (loadError || !bidRequest) {
      return res.status(404).json({ error: 'Bid request not found.' });
    }

    let structured = bidRequest.structured_rfp;

    // Fallback: regenerate structured RFP on the fly if it wasn't saved
    if (!structured || !structured.scopeItems || structured.scopeItems.length === 0) {
      try {
        structured = await buildStructuredRFP({
          community: bidRequest.community || 'HOA Community',
          vendorType: bidRequest.vendor_type || 'Vendor Services',
          contractTerm: bidRequest.contract_term || '1 year with option to renew',
          bidDeadline: bidRequest.bid_deadline,
          scopeContent: bidRequest.scope_summary || bidRequest.generated_document || '',
          additionalRequirements: ''
        });

        await supabase
          .from('bid_requests')
          .update({ structured_rfp: structured })
          .eq('id', bidRequestId);
      } catch (regenErr) {
        console.error('Failed to regenerate structured RFP:', regenErr.message);
        return res.status(500).json({ error: 'Could not build RFP document: ' + regenErr.message });
      }
    }

    const docBuffer = await generateRFPDocx(structured);

    const safeCommunity = (bidRequest.community || 'HOA').replace(/[^a-z0-9]/gi, '_');
    const safeVendorType = (bidRequest.vendor_type || 'RFP').replace(/[^a-z0-9]/gi, '_');
    const filename = `${safeCommunity}_RFP_${safeVendorType}.docx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(docBuffer);
  } catch (err) {
    console.error('Download RFP error:', err);
    res.status(500).json({ error: 'Error generating RFP download: ' + err.message });
  }
});

// List proposals attached to a bid request
app.get('/bid-requests/:id/proposals', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('vendor_proposals')
      .select('id, vendor_name_raw, total_amount, filename, document_type, service_category, created_at, vendors(name)')
      .eq('bid_request_id', id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ proposals: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Vendor Workflow library: list / delete / download endpoints
// ----------------------------------------------------------------------------
// Persistent history of RFPs and uploaded proposals per community. RFPs already
// had /download-rfp/:id (DOCX); this section adds:
//   - GET /vendor-proposals?community=...     list all proposals (not tied to a specific RFP)
//   - DELETE /bid-requests/:id                delete an RFP (linked proposals are detached, not deleted)
//   - DELETE /vendor-proposals/:id            delete a proposal
//   - GET  /download-proposal/:id             Bedrock-branded HTML summary of the extracted proposal
//
// Note: original proposal PDFs are NOT currently saved to storage — only the
// the AI-extracted structured data lives in vendor_proposals. The download
// endpoint renders that extracted data as a clean branded summary, which is
// what Ed wants to hand to a board. Future: persist original PDF to Supabase
// Storage at upload time so we have both the source and the rendered summary.
// ============================================================================

app.get('/vendor-proposals', async (req, res) => {
  try {
    const { community } = req.query;
    let query = supabase
      .from('vendor_proposals')
      .select('id, community, vendor_id, bid_request_id, vendor_name_raw, filename, document_type, service_category, total_amount, annualized_total_amount, currency, proposal_date, is_incumbent, term_months, outcome, outcome_decided_at, file_path, created_at, vendors(name)')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('created_at', { ascending: false })
      .limit(200);
    if (community) query = query.eq('community', community);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ proposals: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/bid-requests/:id', async (req, res) => {
  try {
    // Detach any linked proposals — keep them in the library standalone
    await supabase
      .from('vendor_proposals')
      .update({ bid_request_id: null })
      .eq('bid_request_id', req.params.id);
    const { error } = await supabase
      .from('bid_requests')
      .delete()
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/vendor-proposals/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('vendor_proposals')
      .delete()
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve the ORIGINAL proposal PDF if stored in Supabase Storage
// Returns 404 if the proposal predates storage support (saved before this push)
app.get('/download-proposal-source/:id', async (req, res) => {
  try {
    const { data: p } = await supabase
      .from('vendor_proposals')
      .select('file_path, filename, vendor_name_raw')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (!p || !p.file_path) {
      return res.status(404).send('<h1>Original PDF not stored</h1><p>This proposal was uploaded before storage was enabled, or the file save failed at upload time. Use the summary download instead.</p>');
    }
    const { data, error } = await supabase.storage.from('documents').download(p.file_path);
    if (error) throw error;
    const buf = Buffer.from(await data.arrayBuffer());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${(p.filename || 'proposal.pdf').replace(/[^a-z0-9._-]+/gi, '_')}"`);
    res.send(buf);
  } catch (err) {
    console.error('[download-proposal-source] failed:', err.message);
    res.status(500).send('Error: ' + err.message);
  }
});

// Mark a proposal's outcome (won / lost / withdrawn / expired / pending)
// Body: { outcome: 'won'|'lost'|'withdrawn'|'expired'|'pending', notes?: string,
//         auto_mark_siblings_lost?: boolean (when outcome='won') }
app.post('/vendor-proposals/:id/outcome', async (req, res) => {
  try {
    const { outcome, notes, auto_mark_siblings_lost } = req.body || {};
    if (!['pending', 'won', 'lost', 'withdrawn', 'expired'].includes(outcome)) {
      return res.status(400).json({ error: 'invalid outcome value' });
    }
    const { data: updated, error } = await supabase
      .from('vendor_proposals')
      .update({
        outcome,
        outcome_decided_at: outcome === 'pending' ? null : new Date().toISOString(),
        outcome_notes: notes || null
      })
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .select('id, bid_request_id, outcome')
      .single();
    if (error) throw error;

    // If marked 'won' AND the user opted in, mark siblings (same bid_request) as lost
    let siblingsUpdated = 0;
    if (outcome === 'won' && auto_mark_siblings_lost && updated.bid_request_id) {
      const { count } = await supabase
        .from('vendor_proposals')
        .update({
          outcome: 'lost',
          outcome_decided_at: new Date().toISOString(),
          outcome_notes: notes ? `Auto-marked lost when sibling proposal won. ${notes}` : 'Auto-marked lost when sibling proposal won.'
        }, { count: 'exact' })
        .eq('management_company_id', BEDROCK_MGMT_CO_ID)
        .eq('bid_request_id', updated.bid_request_id)
        .neq('id', req.params.id)
        .eq('outcome', 'pending');
      siblingsUpdated = count || 0;
      // Also pin the selected_proposal_id on the bid_request
      await supabase
        .from('bid_requests')
        .update({ selected_proposal_id: req.params.id })
        .eq('id', updated.bid_request_id);
    }

    res.json({ ok: true, proposal: updated, siblings_marked_lost: siblingsUpdated });
  } catch (err) {
    console.error('[vendor-proposals/:id/outcome] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Vendor Contracts — signed agreements that resulted from winning bids
// Separate from the existing 'contracts' table (which is for Bedrock-community
// MANAGEMENT agreements). This table holds vendor SERVICE contracts.
// ============================================================================

// List vendor contracts (filterable by community / category / status)
app.get('/vendor-contracts', async (req, res) => {
  try {
    const { community, community_id, service_category, status } = req.query;
    let q = supabase
      .from('vendor_contracts')
      .select('*, vendors(name)')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('effective_date', { ascending: false, nullsFirst: false })
      .limit(200);
    if (community_id) q = q.eq('community_id', community_id);
    else if (community) q = q.eq('community_name', community);
    if (service_category) q = q.eq('service_category', service_category);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ contracts: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a vendor contract (with optional PDF upload)
// Either multipart with a file OR JSON body
app.post('/vendor-contracts', upload.single('contract'), async (req, res) => {
  try {
    const crypto = require('crypto');
    // Form data can be in req.body whether file is present or not (multer parses both)
    const b = req.body || {};
    const contractId = crypto.randomUUID();

    let storedFilePath = null;
    let fileHash = null;
    let fileSize = null;
    if (req.file) {
      fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
      fileSize = req.file.size;
      const safeCommunity = (b.community_name || 'unknown').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
      const storagePath = `vendor_contracts/${BEDROCK_MGMT_CO_ID}/${safeCommunity}/${contractId}.pdf`;
      try {
        const { error: storageErr } = await supabase.storage
          .from('documents')
          .upload(storagePath, req.file.buffer, { contentType: 'application/pdf', upsert: false });
        if (!storageErr) storedFilePath = storagePath;
        else console.warn('[vendor-contracts] storage save skipped:', storageErr.message);
      } catch (sErr) {
        console.warn('[vendor-contracts] storage exception:', sErr.message);
      }
    }

    const annualized = b.annualized_amount || (b.total_amount && b.term_months
      ? (Number(b.total_amount) / Number(b.term_months)) * 12
      : b.total_amount);

    const { data: contract, error } = await supabase
      .from('vendor_contracts')
      .insert({
        id: contractId,
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id: b.community_id || null,
        community_name: b.community_name || null,
        vendor_id: b.vendor_id || null,
        vendor_name_raw: b.vendor_name_raw || null,
        source_proposal_id: b.source_proposal_id || null,
        bid_request_id: b.bid_request_id || null,
        service_category: b.service_category || 'other',
        service_description: b.service_description || null,
        effective_date: b.effective_date || null,
        end_date: b.end_date || null,
        signed_date: b.signed_date || null,
        total_amount: b.total_amount ? Number(b.total_amount) : null,
        annualized_amount: annualized ? Number(annualized) : null,
        term_months: b.term_months ? Number(b.term_months) : null,
        escalator_kind: b.escalator_kind || 'none',
        escalator_pct: b.escalator_pct ? Number(b.escalator_pct) : null,
        payment_terms: b.payment_terms || null,
        termination_terms: b.termination_terms || null,
        auto_renews: b.auto_renews === 'true' || b.auto_renews === true,
        renewal_notice_days: b.renewal_notice_days ? Number(b.renewal_notice_days) : null,
        w9_on_file: b.w9_on_file === 'true' || b.w9_on_file === true,
        coi_on_file: b.coi_on_file === 'true' || b.coi_on_file === true,
        notes: b.notes || null,
        status: b.status || 'active',
        file_path: storedFilePath,
        file_hash: fileHash,
        file_size_bytes: fileSize
      })
      .select()
      .single();
    if (error) throw error;

    // If linked to a source proposal, mark it won + siblings lost (best-effort)
    if (b.source_proposal_id) {
      await supabase
        .from('vendor_proposals')
        .update({ outcome: 'won', outcome_decided_at: new Date().toISOString() })
        .eq('id', b.source_proposal_id)
        .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    }

    res.json({ ok: true, contract, stored_pdf: !!storedFilePath });
  } catch (err) {
    console.error('[vendor-contracts POST] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Download a vendor contract PDF
app.get('/vendor-contracts/:id/download', async (req, res) => {
  try {
    const { data: c } = await supabase
      .from('vendor_contracts')
      .select('file_path, vendor_name_raw, community_name')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (!c || !c.file_path) return res.status(404).send('<h1>Contract PDF not available</h1>');
    const { data, error } = await supabase.storage.from('documents').download(c.file_path);
    if (error) throw error;
    const buf = Buffer.from(await data.arrayBuffer());
    const niceName = `${(c.community_name || 'community').replace(/[^a-z0-9]+/gi, '_')}_${(c.vendor_name_raw || 'vendor').replace(/[^a-z0-9]+/gi, '_')}_contract.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${niceName}"`);
    res.send(buf);
  } catch (err) {
    console.error('[vendor-contracts download] failed:', err.message);
    res.status(500).send('Error: ' + err.message);
  }
});

// Delete a vendor contract (and its stored PDF, if any)
app.delete('/vendor-contracts/:id', async (req, res) => {
  try {
    const { data: c } = await supabase
      .from('vendor_contracts')
      .select('file_path')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (c?.file_path) {
      try { await supabase.storage.from('documents').remove([c.file_path]); } catch (_) { /* swallow */ }
    }
    const { error } = await supabase
      .from('vendor_contracts')
      .delete()
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Benchmarking endpoints — read-only analytics across the vendor data moat
// ============================================================================

// Service category list (for filter dropdowns)
app.get('/benchmarks/categories', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('vendor_service_categories')
      .select('*')
      .order('sort_order');
    if (error) throw error;
    res.json({ categories: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-category benchmarks (min/median/max etc. by year + service)
app.get('/benchmarks/categories/summary', async (req, res) => {
  try {
    let q = supabase
      .from('v_service_category_benchmarks')
      .select('*')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('proposal_year', { ascending: false });
    if (req.query.year) q = q.eq('proposal_year', Number(req.query.year));
    if (req.query.service_category) q = q.eq('service_category', req.query.service_category);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ benchmarks: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-vendor performance (win rate, total bids, communities served, etc.)
app.get('/benchmarks/vendor-performance', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('v_vendor_performance')
      .select('*')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('total_bids', { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json({ vendors: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-community spend / bid activity
app.get('/benchmarks/community-spend', async (req, res) => {
  try {
    let q = supabase
      .from('v_community_vendor_spend')
      .select('*')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('community_name', { ascending: true });
    if (req.query.community) q = q.eq('community_name', req.query.community);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ spend: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Active vendor contracts roll-up (matrix view for compliance / expiration monitoring)
app.get('/benchmarks/active-contracts', async (req, res) => {
  try {
    let q = supabase
      .from('v_active_vendor_contracts')
      .select('*')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('end_date', { ascending: true, nullsFirst: false });
    if (req.query.community) q = q.eq('community_name', req.query.community);
    if (req.query.service_category) q = q.eq('service_category', req.query.service_category);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ contracts: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Component Taxonomy endpoints
// ============================================================================

// List canonical components (optionally filter by service_category)
app.get('/service-components', async (req, res) => {
  try {
    let q = supabase
      .from('service_category_components')
      .select('*')
      .order('service_category')
      .order('sort_order');
    if (req.query.service_category) q = q.eq('service_category', req.query.service_category);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ components: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get the component-level breakdown of a single proposal
// Returns: mapped components (with included/excluded/missing flags) + summary
app.get('/vendor-proposals/:id/components', async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from('v_proposal_components_flat')
      .select('*')
      .eq('proposal_id', req.params.id)
      .order('is_missing_from_proposal', { ascending: true })   // included first
      .order('component_display_name', { ascending: true });
    if (error) throw error;
    const all = rows || [];
    const included = all.filter(r => !r.is_missing_from_proposal && r.is_included_in_base);
    const addOns   = all.filter(r => !r.is_missing_from_proposal && !r.is_included_in_base);
    const missing  = all.filter(r => r.is_missing_from_proposal);
    const totalIncluded = included.reduce((s, r) => s + (Number(r.normalized_annual_amount) || 0), 0);
    res.json({
      proposal_id: req.params.id,
      components: all,
      summary: {
        included_count: included.length,
        addon_count: addOns.length,
        missing_count: missing.length,
        included_annualized_total: totalIncluded || null,
        unusual_exclusions: missing.filter(r => r.flagged_as_unusual_exclusion).map(r => r.component_display_name)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-run component mapping for a proposal (use after taxonomy changes
// or if extraction needs to be redone)
app.post('/vendor-proposals/:id/remap-components', async (req, res) => {
  try {
    const result = await mapProposalComponents(req.params.id);
    if (!result.ok) return res.status(500).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Side-by-side component comparison for a set of proposals (typically tied
// to one bid_request, but can be any list). Returns a pivot ready for the UI.
app.post('/vendor-proposals/compare-components', async (req, res) => {
  try {
    const { proposal_ids } = req.body || {};
    if (!Array.isArray(proposal_ids) || proposal_ids.length === 0) {
      return res.status(400).json({ error: 'proposal_ids array required' });
    }
    const { data: rows, error } = await supabase
      .from('v_proposal_components_flat')
      .select('*')
      .in('proposal_id', proposal_ids);
    if (error) throw error;

    // Build pivot: { component_key: { display_name, per_vendor: { proposal_id: { amount, included, missing, ... } } } }
    const pivot = {};
    const vendors = {};
    for (const r of (rows || [])) {
      vendors[r.proposal_id] = vendors[r.proposal_id] || {
        proposal_id: r.proposal_id, vendor_name: r.vendor_name, vendor_id: r.vendor_id,
        community: r.community, is_incumbent: r.is_incumbent, outcome: r.outcome,
        service_category: r.service_category
      };
      const key = r.component_key || '_unmapped';
      pivot[key] = pivot[key] || {
        component_key: r.component_key,
        display_name: r.component_display_name || (r.component_key ? r.component_key : 'Unmapped'),
        typical_inclusion_rate: r.typical_inclusion_rate,
        is_high_markup_target: r.component_is_high_markup_target,
        is_typical_exclusion: r.component_is_typical_exclusion,
        per_vendor: {}
      };
      // If we already have a cell for this vendor/component, sum (for split-component cases)
      const existing = pivot[key].per_vendor[r.proposal_id];
      pivot[key].per_vendor[r.proposal_id] = {
        amount: (existing?.amount || 0) + (Number(r.normalized_annual_amount) || 0),
        is_included: r.is_included_in_base,
        is_missing: r.is_missing_from_proposal,
        flagged_high_markup: r.flagged_as_high_markup,
        flagged_unusual_exclusion: r.flagged_as_unusual_exclusion,
        raw_description: r.raw_line_item_description,
        notes: r.mapping_notes
      };
    }

    // Compute apples-to-apples totals: sum of included components per vendor
    const vendorTotals = {};
    for (const v of Object.values(vendors)) {
      let stated = 0;
      let aTA   = 0;     // apples-to-apples: only including-in-base
      for (const compKey of Object.keys(pivot)) {
        const cell = pivot[compKey].per_vendor[v.proposal_id];
        if (!cell || cell.is_missing) continue;
        if (cell.is_included) {
          stated += cell.amount;
          aTA    += cell.amount;
        } else {
          stated += cell.amount;   // add-ons count toward stated total
          // but NOT toward apples-to-apples comparison
        }
      }
      vendorTotals[v.proposal_id] = { stated_total: stated, included_total: aTA };
    }

    res.json({
      vendors: Object.values(vendors),
      components: Object.values(pivot),
      vendor_totals: vendorTotals,
      proposal_ids_requested: proposal_ids
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-component benchmarks (year/category/component aggregations)
app.get('/benchmarks/components', async (req, res) => {
  try {
    let q = supabase
      .from('v_component_benchmarks')
      .select('*')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('proposal_year', { ascending: false });
    if (req.query.year) q = q.eq('proposal_year', Number(req.query.year));
    if (req.query.service_category) q = q.eq('service_category', req.query.service_category);
    if (req.query.component_key) q = q.eq('component_key', req.query.component_key);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ benchmarks: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/download-proposal/:id', async (req, res) => {
  try {
    const { data: p, error } = await supabase
      .from('vendor_proposals')
      .select('*, vendors(name)')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (error) throw error;
    if (!p) return res.status(404).send('<h1>Proposal not found</h1>');

    const extracted = p.extracted_data || {};
    const lineItems = Array.isArray(extracted.line_items) ? extracted.line_items : [];
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const money = n => n != null && !Number.isNaN(Number(n))
      ? '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '—';

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${esc(p.vendor_name_raw || 'Vendor Proposal')} — ${esc(p.community)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  body { font-family: 'Inter', -apple-system, sans-serif; max-width: 850px; margin: 40px auto; padding: 20px; color: #1a1a1a; font-size: 14px; line-height: 1.55; font-feature-settings: "tnum" 1; }
  h1 { color: #315A87; border-bottom: 2px solid #315A87; padding-bottom: 10px; font-size: 24px; margin: 0 0 6px 0; }
  h2 { color: #1F3A5F; margin-top: 28px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.14em; border-bottom: 1px solid #e0e0e0; padding-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 13px; }
  th { background: #f0f4f8; padding: 8px; text-align: left; font-weight: 600; }
  td { padding: 8px; border-bottom: 1px solid #e8eaed; vertical-align: top; }
  .meta { color: #666; font-size: 12px; margin-bottom: 16px; }
  .totals { background: #f9fafb; padding: 14px 18px; border-radius: 6px; margin: 8px 0; }
  .totals-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
  .totals-row.total { font-weight: 600; font-size: 16px; color: #1F3A5F; border-top: 1px solid #d0d7de; padding-top: 8px; margin-top: 4px; }
  .totals-row.annualized { color: #666; font-size: 11px; font-style: italic; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 11px; font-weight: 600; margin-left: 8px; vertical-align: middle; }
  .badge-incumbent { background: #e3f2fd; color: #1565c0; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e0e0e0; color: #888; font-size: 11px; text-align: center; }
  .footer .brand { color: #315A87; font-weight: 600; }
  @media print { body { margin: 0.5in; max-width: none; } }
</style></head><body>
<h1>${esc(p.vendor_name_raw || 'Vendor Proposal')}${p.is_incumbent ? '<span class="badge badge-incumbent">Incumbent</span>' : ''}</h1>
<div class="meta">
  <strong>${esc(p.community || '—')}</strong> ·
  ${esc(p.service_category || '—')} ·
  ${esc(p.document_type || '—')}
  ${p.proposal_date ? ' · proposal dated ' + esc(p.proposal_date) : ''}
  ${p.filename ? '<div style="margin-top:4px;">Original filename: <code>' + esc(p.filename) + '</code></div>' : ''}
</div>

<h2>Pricing</h2>
<div class="totals">
  ${extracted.totals?.subtotal != null ? `<div class="totals-row"><span>Subtotal</span><span>${money(extracted.totals.subtotal)}</span></div>` : ''}
  ${extracted.totals?.tax != null ? `<div class="totals-row"><span>Tax${extracted.totals.tax_rate_percent ? ` (${extracted.totals.tax_rate_percent}%)` : ''}</span><span>${money(extracted.totals.tax)}</span></div>` : ''}
  ${p.total_amount != null ? `<div class="totals-row total"><span>Total</span><span>${money(p.total_amount)}</span></div>` : '<div class="totals-row"><span>Total</span><span>(not stated)</span></div>'}
  ${p.annualized_total_amount != null && p.term_months && p.term_months !== 12 ? `<div class="totals-row annualized"><span>Annualized: ${esc(p.annualization_basis || '')}</span><span>${money(p.annualized_total_amount)}</span></div>` : ''}
</div>

${lineItems.length > 0 ? `<h2>Line Items</h2>
<table><thead><tr>
  <th style="width: 55%;">Description</th>
  <th style="width: 8%; text-align: right;">Qty</th>
  <th style="width: 10%;">Unit</th>
  <th style="width: 13%; text-align: right;">Unit Price</th>
  <th style="width: 14%; text-align: right;">Total</th>
</tr></thead><tbody>
${lineItems.map(li => `<tr>
  <td>${esc(li.description || '')}</td>
  <td style="text-align: right;">${li.quantity != null ? esc(li.quantity) : ''}</td>
  <td>${esc(li.unit || '')}</td>
  <td style="text-align: right;">${li.unit_price != null ? money(li.unit_price) : ''}</td>
  <td style="text-align: right;">${li.total_price != null ? money(li.total_price) : ''}</td>
</tr>`).join('')}
</tbody></table>` : ''}

${extracted.service_contract_details && (extracted.service_contract_details.term_months || extracted.service_contract_details.term_length) ? `<h2>Contract Terms</h2>
<table>
  ${extracted.service_contract_details.term_length || extracted.service_contract_details.term_months ? `<tr><th style="width: 28%;">Term</th><td>${esc(extracted.service_contract_details.term_length || (extracted.service_contract_details.term_months + ' months'))}</td></tr>` : ''}
  ${extracted.service_contract_details.term_start_date ? `<tr><th>Start</th><td>${esc(extracted.service_contract_details.term_start_date)}</td></tr>` : ''}
  ${extracted.service_contract_details.term_end_date ? `<tr><th>End</th><td>${esc(extracted.service_contract_details.term_end_date)}</td></tr>` : ''}
  ${extracted.service_contract_details.escalation_clauses ? `<tr><th>Escalation</th><td>${esc(extracted.service_contract_details.escalation_clauses)}</td></tr>` : ''}
  ${extracted.service_contract_details.termination_terms ? `<tr><th>Termination</th><td>${esc(extracted.service_contract_details.termination_terms)}</td></tr>` : ''}
</table>` : ''}

${extracted.payment_terms ? `<h2>Payment Terms</h2><p>${esc(extracted.payment_terms)}</p>` : ''}

${extracted.insurance_provided && Object.values(extracted.insurance_provided).some(v => v) ? `<h2>Insurance Provided</h2>
<table>
  ${extracted.insurance_provided.general_liability ? `<tr><th style="width: 28%;">General Liability</th><td>${esc(extracted.insurance_provided.general_liability)}</td></tr>` : ''}
  ${extracted.insurance_provided.umbrella ? `<tr><th>Umbrella</th><td>${esc(extracted.insurance_provided.umbrella)}</td></tr>` : ''}
  ${extracted.insurance_provided.workers_comp ? `<tr><th>Workers Comp</th><td>${esc(extracted.insurance_provided.workers_comp)}</td></tr>` : ''}
  ${extracted.insurance_provided.auto ? `<tr><th>Auto</th><td>${esc(extracted.insurance_provided.auto)}</td></tr>` : ''}
</table>` : ''}

${extracted.key_terms_summary ? `<h2>Key Terms Summary</h2><p>${esc(extracted.key_terms_summary)}</p>` : ''}

${extracted.extraction_notes ? `<h2>Extraction Notes</h2><p style="color:#666; font-style:italic; font-size:12px;">${esc(extracted.extraction_notes)}</p>` : ''}

<div class="footer">
  <span class="brand">${BRAND.service.name}</span> · ${BRAND.service.tagline}<br>
  Proposal summary generated from extracted data on ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
</div>
</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[download-proposal] failed:', err.message);
    res.status(500).send('Error: ' + err.message);
  }
});

// =====================================================================
// Market value estimate lookup — TrueCar-style data layer
// Priority: community-specific actuals → cross-community avg → AI estimate
// =====================================================================
async function lookupMarketValue(scopeCategory, community) {
  // Tier 1: community-specific actuals
  const { data: communitySpecific } = await supabase
    .from('market_value_estimates')
    .select('*')
    .eq('management_company_id', BEDROCK_MGMT_CO_ID)
    .eq('scope_category', scopeCategory)
    .eq('community', community)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (communitySpecific) {
    return {
      annual_estimate_usd: Number(communitySpecific.annual_estimate_usd),
      source: communitySpecific.source,
      basis_text: `${community} ${communitySpecific.source === 'actuals' ? 'actuals' : 'prior data'} (${communitySpecific.confidence || 'medium'} confidence)`
    };
  }

  // Tier 2: cross-community average for this management company + scope
  const { data: crossCommunity } = await supabase
    .from('market_value_estimates')
    .select('annual_estimate_usd')
    .eq('management_company_id', BEDROCK_MGMT_CO_ID)
    .eq('scope_category', scopeCategory)
    .is('community', null);

  if (crossCommunity && crossCommunity.length > 0) {
    const avg = crossCommunity.reduce((sum, r) => sum + Number(r.annual_estimate_usd), 0) / crossCommunity.length;
    return {
      annual_estimate_usd: avg,
      source: 'cross_community_avg',
      basis_text: `Cross-community average across ${crossCommunity.length} prior data points`
    };
  }

  // Tier 3: caller falls back to AI estimate
  return null;
}

// Endpoint for staff to manually save a market value (one-time per community per scope)
app.post('/market-value', async (req, res) => {
  try {
    const { community, scope_category, annual_estimate_usd, source, confidence, notes } = req.body;
    if (!scope_category || !annual_estimate_usd) {
      return res.status(400).json({ error: 'scope_category and annual_estimate_usd required.' });
    }
    const { data, error } = await supabase
      .from('market_value_estimates')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        community: community || null,
        scope_category,
        annual_estimate_usd,
        source: source || 'actuals',
        confidence: confidence || 'medium',
        notes: notes || null
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, estimate: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run a comparison across 2-6 proposals (incumbent optional)
app.post('/run-comparison', async (req, res) => {
  try {
    const {
      proposalIds,
      bidRequestId,
      community,
      incumbentProposalId,
      materialityThresholdUsd,
      materialityThresholdPct,
      switchThresholdPct
    } = req.body;

    if (!proposalIds || !Array.isArray(proposalIds) || proposalIds.length < 1) {
      return res.status(400).json({ error: 'Provide at least 1 proposal ID to compare.' });
    }

    if (proposalIds.length > 6) {
      return res.status(400).json({ error: 'Maximum 6 proposals per comparison.' });
    }

    // Apply defaults for the materiality + switch thresholds
    const matUsd = Number(materialityThresholdUsd) || 1000;
    const matPct = Number(materialityThresholdPct) || 5;
    const swPct = Number(switchThresholdPct) || 5;

    const { data: proposals, error: loadError } = await supabase
      .from('vendor_proposals')
      .select('*, vendors(name)')
      .in('id', proposalIds);

    if (loadError || !proposals || proposals.length < 1) {
      return res.status(500).json({ error: 'Could not load proposals: ' + (loadError?.message || 'not found') });
    }

    // Reorder proposals to match the order they were submitted in proposalIds
    const orderedProposals = proposalIds
      .map(id => proposals.find(p => p.id === id))
      .filter(Boolean);

    // Identify incumbent (either passed explicitly or flagged on the proposal record)
    let incumbentIndex = -1;
    if (incumbentProposalId) {
      incumbentIndex = orderedProposals.findIndex(p => p.id === incumbentProposalId);
    }
    if (incumbentIndex === -1) {
      incumbentIndex = orderedProposals.findIndex(p => p.is_incumbent === true);
    }

    let bidRequestContext = '';
    if (bidRequestId) {
      const { data: bidRequest } = await supabase
        .from('bid_requests')
        .select('scope_summary, vendor_type, contract_term')
        .eq('id', bidRequestId)
        .single();
      if (bidRequest) {
        bidRequestContext = `\n\nORIGINAL BID REQUEST CONTEXT:\nVendor type: ${bidRequest.vendor_type}\nContract term: ${bidRequest.contract_term}\nScope summary: ${bidRequest.scope_summary}\n`;
      }
    }


    const docTypes = orderedProposals.map(p => p.document_type);
    const dominantDocType = docTypes.sort((a, b) =>
      docTypes.filter(v => v === a).length - docTypes.filter(v => v === b).length
    ).pop();

    const serviceCategories = orderedProposals.map(p => p.service_category);
    const dominantCategory = serviceCategories.sort((a, b) =>
      serviceCategories.filter(v => v === a).length - serviceCategories.filter(v => v === b).length
    ).pop();

    // Look up market value for the dominant scope category (used to estimate excluded items)
    const marketValue = await lookupMarketValue(dominantCategory, community);

   // Build a query string from the proposal data so semantic retrieval
    // can find playbook entries relevant to THIS comparison, not just
    // generic "vendor" entries.
    const playbookQuery = [
      `Vendor comparison for ${community || 'community'}`,
      `Service category: ${dominantCategory}`,
      `Document type: ${dominantDocType}`,
      orderedProposals.map(p => `Vendor: ${p.vendors?.name || p.vendor_name_raw}`).join('. '),
      orderedProposals.map(p => {
        const ex = p.extracted_data || {};
        return `${p.vendors?.name || p.vendor_name_raw}: ${ex.key_terms_summary || ''} ${(ex.line_items || []).map(li => li.description).join('; ')}`;
      }).join('\n')
    ].filter(Boolean).join('\n');

    const matchedPlaybookEntries = await getRelevantPlaybook(playbookQuery, { matchCount: 8 });
    const playbookContext = formatPlaybookContext(matchedPlaybookEntries, {
      heading: "ED'S VENDOR JUDGMENT (PLAYBOOK)"
    }); 

    // Build the proposal payload for the prompt — include normalization data
    const proposalsForPrompt = orderedProposals.map((p, i) => ({
      label: `Proposal ${i}: ${p.vendors?.name || p.vendor_name_raw}${i === incumbentIndex ? ' [INCUMBENT]' : ''}`,
      stated_total: p.total_amount,
      term_months: p.term_months,
      annualized_total: p.annualized_total_amount,
      annualization_basis: p.annualization_basis,
      data: p.extracted_data
    }));

    const marketValueContext = marketValue
      ? `\n\nMARKET VALUE REFERENCE for ${dominantCategory} (used to add back excluded items when normalizing):\n- Annual estimate: $${marketValue.annual_estimate_usd.toLocaleString()}\n- Source: ${marketValue.basis_text}\n`
      : `\n\nMARKET VALUE REFERENCE: No prior data for ${dominantCategory}. If a proposal excludes items that another includes (e.g. chemicals), estimate the annual market value yourself based on proposal context (pool size, season, etc.) and state your basis explicitly in normalization_basis.add_back_estimates.\n`;

    const incumbentContext = incumbentIndex >= 0
      ? `\n\nINCUMBENT PRESENT: Proposal ${incumbentIndex} is the incumbent vendor. The board's question is "should I switch?" Apply the switch threshold rule: recommend switching only if normalized annualized savings exceed ${swPct}% AND no material risk increase. If the rule says switch but you disagree, override with reasoning. If the rule says stay but you disagree, override with reasoning. Show the rule + your verdict.\n`
      : `\n\nNO INCUMBENT: This is a fresh comparison among bids. Recommend the best vendor on normalized cost + risk basis.\n`;

    const comparisonResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: `You are a vendor decision analyst for ${BRAND.service.name}. You think like Ed Gojara — CPA with audit-firm training (Big Four + regional firm Principal) and an operations background from a high-frequency trading desk, applied to 15+ years HOA management. You produce DECISION SUPPORT, not scope inventories.

YOUR JOB IS DECISION SUPPORT, NOT SCOPE DISPLAY.
Your output drives a board decision. Boards decide on 2–3 facts. Everything else is liability protection — necessary in your reasoning, harmful in your output.

THE 4-STEP REASONING YOU MUST FOLLOW:

STEP 1 — NORMALIZE EVERYTHING TO A 12-MONTH CONSTANT BASIS
- Annualize every proposal to 12 months using its term_months and annualized_total fields.
- Identify the lowest-common-scope denominator. If Proposal A includes chemicals and B doesn't, normalize to "management only" and add back chemicals to A using the market value reference.
- State each normalization assumption in normalization_basis. Be specific: "Annualized 7-month proposal at stated rates" not "annualized."

STEP 2 — APPLY MATERIALITY FILTER
- Materiality threshold for THIS comparison: lower of $${matUsd} OR ${matPct}% of annualized contract value.
- A scope difference, risk, or term clause makes it into the output ONLY if its annualized dollar impact exceeds the threshold.
- Items below threshold: priced into the normalized number, NOT mentioned in output.
- Tier the items that pass: "material" (would change the answer) vs "worth_knowing" (above threshold but won't flip the recommendation).

STEP 3 — APPLY SWITCH LOGIC (only if incumbent present)
- Default rule: recommend switch if normalized annual savings exceed ${swPct}% AND no material risk increase.
- You may override the rule in either direction with stated reasoning. Boards respect "the rule says switch but here's why we don't" more than ad-hoc judgment.

STEP 4 — OUTPUT ONLY DECISION-RELEVANT CONTENT
- "What would change your mind" is HARD CAPPED at 3 bullets. Pick the 3 most decision-relevant. If you have a 4th, it doesn't make the cut.
- The recommendation is one sentence. The rationale that follows is two more sentences MAXIMUM.
- DO NOT pad. If a section has nothing material, leave its array empty.

RETURN ONLY VALID JSON IN THIS EXACT SHAPE — no preamble, no markdown fences:

{
  "schema_version": "v2",
  "headline_recommendation": "string — ONE sentence. e.g. 'Recommend A-Beautiful Pools at $31,330 annualized over Sweetwater Pools at $42,580 — saves ~$11,250/yr with stronger insurance, contingent on independent chemical procurement.'",
  "recommended_proposal_index": "number (0-indexed into the proposals array)",
  "switch_verdict": {
    "applies": "boolean — true only when incumbent is present",
    "rule_says": "string or null — 'switch' | 'stay' | 'inconclusive'",
    "final_verdict": "string or null — 'switch' | 'stay'",
    "override_reasoning": "string or null — populated only if final_verdict differs from rule_says",
    "annualized_savings_usd": "number or null",
    "annualized_savings_pct": "number or null"
  },
  "normalized_costs": [
    {
      "proposal_index": "number",
      "vendor_name": "string",
      "is_incumbent": "boolean",
      "stated_total": "number",
      "stated_term_months": "number or null",
      "annualized_total": "number — every proposal MUST have this",
      "scope_adjustments": [
        {
          "label": "string — e.g. 'Add back chemicals (excluded)'",
          "amount_usd": "number — positive = added to this proposal's normalized total"
        }
      ],
      "normalized_annual_total": "number — annualized_total + sum of scope_adjustments. This is the apples-to-apples number."
    }
  ],
  "normalization_basis": {
    "summary": "string — 2-4 sentences max. The 'how we got to apples-to-apples' explainer for the board. Plain English.",
    "add_back_estimates": [
      {
        "scope_category": "string — e.g. 'pool_chemicals'",
        "annual_estimate_usd": "number",
        "source_basis": "string — e.g. 'Canyon Gate 2024 actuals' or 'AI estimate from pool size and season'",
        "applied_to_proposal_indexes": ["array of proposal indexes this was added to"]
      }
    ]
  },
  "what_would_change_your_mind": [
    {
      "factor": "string — short title, e.g. 'Chemical procurement capacity'",
      "explanation": "string — one sentence on why this could flip the decision"
    }
  ],
  "material_risks": [
    {
      "label": "string — short title",
      "description": "string — one sentence",
      "applies_to_proposal_indexes": ["array"],
      "annualized_exposure_usd": "number or null"
    }
  ],
  "worth_knowing": [
    {
      "label": "string",
      "description": "string"
    }
  ],
  "questions_for_board": ["array of 2-4 questions, kept from prior version"],
  "vendor_summary_table": [
    {
      "proposal_index": "number",
      "vendor_name": "string",
      "is_incumbent": "boolean",
      "normalized_annual_total": "number",
      "key_distinction": "string — one phrase that distinguishes this vendor in the comparison"
    }
  ],
  "vendor_character": [
    {
      "proposal_index": "number",
      "operational_focus": "technical_pool | facilities_operational | balanced",
      "service_style": "corporate_polished | relationship_flexible | balanced",
      "exclusion_strategy": "aggressive_exclusions | broad_inclusion | balanced",
      "one_line_read": "string — single audit-partner read on this vendor's character and posture. ≤25 words. e.g., 'Technical/pool-focused with aggressive exclusions; protects margin through gray-area scope — expect out-of-scope billing patterns.'"
    }
  ],
  "risk_adjusted_view": {
    "show": "boolean — set true ONLY when at least one material risk has a numeric annualized_exposure_usd worth surfacing as a range",
    "per_proposal": [
      {
        "proposal_index": "number",
        "low_estimate": "number — normalized_annual_total + sum of the LOWEST-likelihood material risk exposures for this proposal",
        "high_estimate": "number — normalized_annual_total + sum of the HIGHEST-likelihood material risk exposures for this proposal",
        "explanation": "string — ≤30 words on what's included in the range. e.g., 'Adds bathroom supply ambiguity ($1.2K) + non-standard chemical pass-through ($2–4K).'"
      }
    ]
  },
  "before_you_vote": [
    {
      "category": "negotiation | reference_check | historical_context | verification",
      "item": "string — actionable instruction (≤25 words). e.g., 'Negotiate out the mid-term cost escalation clause OR cap it at CPI before execution.'",
      "applies_to_proposal_indexes": ["array — optional, empty if generic"],
      "priority": "high | medium"
    }
  ],
  "vendor_quality_questions": [
    "string — question for the board to ask references / probe in trial period. Focus on what contracts can't show: staffing stability, emergency response, communication quality, out-of-scope billing patterns, supervisor accessibility, complaint handling. Tailor to this service category."
  ]
}

CRITICAL OUTPUT RULES:
- "what_would_change_your_mind" MUST have at most 3 entries. If you have more, cut to 3.
- "material_risks" includes only risks above the materiality threshold AND that could change the answer.
- "worth_knowing" includes items above threshold that are real but won't flip the recommendation.
- Items below the materiality threshold appear NOWHERE in the output.
- Every "annualized_total" and "normalized_annual_total" must be a number, not null.
- "normalization_basis.summary" is what shows up to the board — make it readable, not a methodology dump.

NEW SECTIONS (v3) — character + risk-adjusted + action items:

STEP 5 — VENDOR CHARACTER READ (qualitative pattern recognition)
For each vendor, characterize their posture across three axes:
- operational_focus: what they emphasize in scope. A vendor focused on pool chemistry/safety with narrow scope = technical_pool. A vendor with broad cleaning/facilities/housekeeping language = facilities_operational. Mixed = balanced.
- service_style: read the CONTRACT BODY LANGUAGE not just the proposal summary. Heavy indemnity carve-outs + Acts of God + swim-at-your-own-risk + extensive legal protection = corporate_polished. Cooperative tone + minimal legal armor = relationship_flexible. Mixed = balanced.
- exclusion_strategy: count and breadth of EXCLUSIONS/CARVE-OUTS. Long list of "this is NOT included" items creates gray-area billing opportunities = aggressive_exclusions. Few or no exclusions with broad scope = broad_inclusion. Mixed = balanced.

The "one_line_read" is your audit-partner-voice summary — what would a seasoned auditor say about this vendor's posture in one sentence? Connect the axes when relevant: "Technical/polished with aggressive exclusions = protects margin via gray-area scope" or "Relationship-oriented with broad inclusion = predictable cost but premium price."

STEP 6 — RISK-ADJUSTED VIEW
Set show=true ONLY when at least one material_risk has a numeric annualized_exposure_usd. For each affected proposal, compute a low/high range:
- low_estimate = normalized_annual_total + sum of LOWER-BOUND likely exposures (e.g., the cheap end of "non-standard chemicals could be $2-4K" = $2K)
- high_estimate = normalized_annual_total + sum of UPPER-BOUND likely exposures
This is the "real cost if risks materialize" number that corrects lowball-by-exclusion pricing. If no proposal has dollar-quantified material risks, set show=false and leave per_proposal empty.

STEP 7 — BEFORE YOU VOTE (action items)
Generate 3-6 actionable items the board should complete BEFORE the vote. Categories:
- negotiation: contract clauses to redline (e.g., "Cap the cost escalation clause at CPI" / "Strike the vendor-side termination right")
- reference_check: specific references to call (e.g., "Call 3 references at communities of similar pool size")
- historical_context: prior-year data to confirm (e.g., "Confirm last year's actual pool opening date matches the recommendation")
- verification: documents/facts to verify (e.g., "Verify both vendors' current insurance certificates")
Each item must be ACTIONABLE — start with a verb. Not "consider X" — "Do X." Set priority='high' for items that could change the vote; 'medium' for items that should happen regardless.

STEP 8 — VENDOR QUALITY QUESTIONS
Generate 4-6 questions tailored to this service category that won't show in any contract. These are for references and trial periods. Focus areas: staffing stability/turnover, emergency response, supervisor accessibility, out-of-scope billing patterns, complaint handling, communication quality, reliability during stress events (storms, equipment failures, etc.). Phrase as direct questions the board can ask references.

BOARD DECISION DISCLAIMER (always include in output as a constant — the renderer will surface it):
The board owns the final decision. This analysis is decision SUPPORT — it does NOT override the board's judgment, community priorities, or vendor reference checks. The recommendation reflects the dollar math and visible contract structure; vendor RELIABILITY emerges only in references and stress events.`,
      messages: [{
        role: 'user',
        content: `Compare these vendor proposals for ${community} (category: ${dominantCategory}, type: ${dominantDocType}).

MATERIALITY THRESHOLD FOR THIS COMPARISON: lower of $${matUsd} OR ${matPct}% of annualized contract value.
SWITCH THRESHOLD: ${swPct}% normalized annual savings.
${incumbentContext}${marketValueContext}

PROPOSALS:
${proposalsForPrompt.map(p => `=== ${p.label} ===
stated_total: ${p.stated_total}
term_months: ${p.term_months}
annualized_total: ${p.annualized_total}
annualization_basis: ${p.annualization_basis}
extracted_data: ${JSON.stringify(p.data, null, 2)}`).join('\n\n')}
${bidRequestContext}
${playbookContext}

Apply the 4-step reasoning. Return only the JSON.`
      }]
    });

    let analysisData;
    let rawAnalysis = comparisonResponse.content[0].text;
    rawAnalysis = rawAnalysis.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();

    try {
      analysisData = JSON.parse(rawAnalysis);
    } catch (parseErr) {
      console.error('Failed to parse comparison JSON, attempting repair:', parseErr.message);
      try {
        let repaired = rawAnalysis;
        let quoteCount = 0;
        for (let i = 0; i < repaired.length; i++) {
          if (repaired[i] === '"' && repaired[i-1] !== '\\') quoteCount++;
        }
        if (quoteCount % 2 !== 0) repaired += '"';
        const openBraces = (repaired.match(/\{/g) || []).length;
        const closeBraces = (repaired.match(/\}/g) || []).length;
        const openBrackets = (repaired.match(/\[/g) || []).length;
        const closeBrackets = (repaired.match(/\]/g) || []).length;
        repaired = repaired.replace(/,\s*$/, '');
        for (let i = 0; i < openBrackets - closeBrackets; i++) repaired += ']';
        for (let i = 0; i < openBraces - closeBraces; i++) repaired += '}';
        analysisData = JSON.parse(repaired);
        console.log('JSON repair succeeded.');
      } catch (repairErr) {
        console.error('JSON repair also failed:', repairErr.message);
        return res.status(500).json({
          error: 'Could not parse comparison output. Try comparing fewer proposals at once.',
          raw_text_preview: rawAnalysis.slice(0, 500),
          raw_text_end: rawAnalysis.slice(-500)
        });
      }
    }

    // Enforce the 3-bullet cap server-side as a safety net
    if (Array.isArray(analysisData.what_would_change_your_mind) && analysisData.what_would_change_your_mind.length > 3) {
      analysisData.what_would_change_your_mind = analysisData.what_would_change_your_mind.slice(0, 3);
    }

    // Resolve recommended vendor for the FK column
    let recommendedVendorId = null;
    const recommendedIndex = analysisData.recommended_proposal_index;
    if (typeof recommendedIndex === 'number' && orderedProposals[recommendedIndex]) {
      recommendedVendorId = orderedProposals[recommendedIndex].vendor_id;
    }

    const { data: savedComparison, error: saveError } = await supabase
      .from('vendor_comparisons')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        community: community || orderedProposals[0].community,
        bid_request_id: bidRequestId || null,
        proposal_ids: proposalIds,
        document_type: dominantDocType,
        service_category: dominantCategory,
        recommendation_vendor_id: recommendedVendorId,
        recommendation_summary: analysisData.headline_recommendation || '',
        reasoning: analysisData.normalization_basis?.summary || '',
        analysis_data: analysisData,
        incumbent_proposal_id: incumbentIndex >= 0 ? orderedProposals[incumbentIndex].id : null,
        materiality_threshold_usd: matUsd,
        materiality_threshold_pct: matPct,
        switch_threshold_pct: swPct,
        normalization_basis: analysisData.normalization_basis || null,
        schema_version: 'v2'
      })
      .select()
      .single();

    if (saveError) {
      console.error('Error saving comparison:', saveError);
      return res.status(500).json({ error: 'Could not save comparison: ' + saveError.message });
    }

    res.json({
      success: true,
      comparisonId: savedComparison.id,
      analysis: analysisData,
      applied_playbook_entries: buildAppliedPlaybookSummary(matchedPlaybookEntries)
    });
  } catch (err) {
    console.error('Comparison error:', err);
    res.status(500).json({ error: 'Error running comparison: ' + err.message });
  }
});

// Retrieve a saved comparison
app.get('/comparison/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: comparison, error } = await supabase
      .from('vendor_comparisons')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !comparison) {
      return res.status(404).json({ error: 'Comparison not found.' });
    }

    const { data: proposals } = await supabase
      .from('vendor_proposals')
      .select('id, vendor_name_raw, total_amount, filename, vendors(name)')
      .in('id', comparison.proposal_ids);

    res.json({
      comparison,
      proposals: proposals || []
    });
  } catch (err) {
    console.error('Get comparison error:', err);
    res.status(500).json({ error: 'Error loading comparison: ' + err.message });
  }
});

// =====================================================================
// END VENDOR WORKFLOW
// =====================================================================

// ============================================================
// COMMUNITY HOME COUNTS — update as you add communities
// ============================================================
const COMMUNITY_HOME_COUNTS = {
  'waterview estates': 1171,
  'canyon gate': 721,
};

// ============================================================
// ANNUAL MAILING ENDPOINT
// ============================================================

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  BorderStyle,
  PageBreak,
} = require('docx');
async function parseAddressesFromPDF(buffer) {
  const data = await pdfParse(buffer);
  const lines = data.text.split('\n').map(l => l.trim()).filter(l => l);
  const csz = /^.+,\s+[A-Z]{2}\s+\d{5}(-\d{4})?$/;
  const owners = [];
  let i = 0;

  while (i < lines.length) {
    if (csz.test(lines[i])) { i++; continue; }
    const name = lines[i].replace(/^[.,\- ]+/, '');
    if (!name) { i++; continue; }
    let street = '';
    let cityStateZip = '';
    if (i + 2 < lines.length && csz.test(lines[i + 2])) {
      street = lines[i + 1];
      cityStateZip = lines[i + 2];
      i += 3;
    } else if (i + 1 < lines.length && csz.test(lines[i + 1])) {
      cityStateZip = lines[i + 1];
      i += 2;
    } else { i++; continue; }
    if (name && cityStateZip) owners.push({ name, street, city_state_zip: cityStateZip });
  }
  return owners;
}
async function generateMailingDoc(owners) {
  function buildSection(owner, isLast) {
    return {
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 720, right: 1440, bottom: 720, left: 1440 },
        },
      },
      children: [
        new Paragraph({ children: [new TextRun('')], spacing: { before: 0, after: 2520 } }),
        new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing: { before: 0, after: 40 },
          children: [new TextRun({ text: owner.name, font: 'Arial', size: 24 })],
        }),
        new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing: { before: 0, after: 40 },
          children: [new TextRun({ text: owner.street, font: 'Arial', size: 24 })],
        }),
        new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing: { before: 0, after: 600 },
          children: [new TextRun({ text: owner.city_state_zip, font: 'Arial', size: 24 })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 0 },
          border: { bottom: { style: BorderStyle.DASHED, size: 6, color: 'AAAAAA', space: 4 } },
          children: [new TextRun({ text: '\u2702  fold here', font: 'Arial', size: 16, color: 'AAAAAA', italics: true })],
        }),
        ...(isLast ? [] : [new Paragraph({ children: [new PageBreak()], spacing: { before: 0, after: 0 } })]),
      ],
    };
  }
  const doc = new Document({
    sections: owners.map((owner, i) => buildSection(owner, i === owners.length - 1)),
  });
  return Packer.toBuffer(doc);
}

app.post('/generate-mailing', upload.single('pdf'), async (req, res) => {
  try {
    const { community, expectedCount, force } = req.body;
    if (!req.file) return res.status(400).json({ error: 'Please upload a mailing address PDF from Vantaca.' });

    const owners = await parseAddressesFromPDF(req.file.buffer);

    const parsedCount = owners.length;
    const communityKey = (community || '').toLowerCase().trim();
    const knownCount = COMMUNITY_HOME_COUNTS[communityKey];
    const checkCount = expectedCount ? parseInt(expectedCount) : knownCount;

    if (checkCount && checkCount !== parsedCount && force !== 'true') {
      const diff = checkCount - parsedCount;
      return res.status(200).json({
        warning: true,
        requiresConfirmation: true,
        parsedCount,
        expected: checkCount,
        difference: Math.abs(diff),
        message: `Mailing list has ${parsedCount} entries but ${community} has ${checkCount} homes on record. ${Math.abs(diff)} records may be ${diff > 0 ? 'missing' : 'extra'}. Verify your Vantaca export before printing.`
      });
    }

    const docBuffer = await generateMailingDoc(owners);
    const filename = `${(community || 'HOA').replace(/\s+/g, '_')}_Annual_Mailing_${new Date().getFullYear()}.docx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(docBuffer);

  } catch (err) {
    console.error('Mailing error:', err);
    res.status(500).json({ error: 'Error generating mailing: ' + err.message });
  }
});

app.get('/community-counts', (req, res) => {
  res.json({ communities: COMMUNITY_HOME_COUNTS });
});

app.post('/community-counts', (req, res) => {
  const { community, homeCount } = req.body;
  if (!community || !homeCount) return res.status(400).json({ error: 'community and homeCount required' });
  COMMUNITY_HOME_COUNTS[community.toLowerCase().trim()] = parseInt(homeCount);
  res.json({ success: true, community, homeCount: parseInt(homeCount) });
});

// ============================================================================
// Presentations module — generate branded .pptx decks from templates + form
// variables + optional uploaded images. Every generation is stored so the user
// can re-download past decks and so the pitch history compounds into data.
// ============================================================================
const presentationsRegistry = require('./lib/presentations');
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

app.get('/api/presentations/templates', (req, res) => {
  res.json({ templates: presentationsRegistry.listTemplates() });
});

app.get('/api/presentations/instances', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('presentation_instances')
      .select('id, template_slug, title, variables, output_filename, status, created_at')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json({ instances: data || [] });
  } catch (err) {
    console.error('Presentation list error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/presentations/generate', upload.any(), async (req, res) => {
  try {
    const templateSlug = (req.body.template_slug || '').trim();
    const template = presentationsRegistry.getTemplate(templateSlug);
    if (!template) return res.status(400).json({ error: 'Unknown template: ' + templateSlug });

    let variables = {};
    if (req.body.variables) {
      try { variables = JSON.parse(req.body.variables); } catch { variables = {}; }
    } else {
      (template.variables || []).forEach(v => {
        if (req.body[v.key] !== undefined) variables[v.key] = req.body[v.key];
      });
    }

    const ctx = {};
    const files = req.files || [];
    files.forEach(f => {
      if (f.fieldname === 'cover_image') {
        ctx.coverImageBuffer = f.buffer;
        ctx.coverImageMime = f.mimetype;
      }
    });

    const titleParts = [template.title];
    if (variables.community) titleParts.push(variables.community);
    const title = titleParts.join(' — ');

    const pres = template.build(variables, ctx);
    const pptxBuffer = await pres.write({ outputType: 'nodebuffer' });

    const safeStem = (variables.community || template.slug).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'presentation';
    const filename = `${safeStem}_${template.slug}_${new Date().toISOString().slice(0,10)}.pptx`;

    const { data: instance, error: insErr } = await supabase
      .from('presentation_instances')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        template_slug: template.slug,
        title,
        variables,
        output_filename: filename,
        status: 'generated',
      })
      .select()
      .single();

    if (insErr) {
      console.warn('Presentation history write failed:', insErr.message);
    } else if (instance) {
      const storagePath = `presentations/${instance.id}/${filename}`;
      const { error: stErr } = await supabase.storage
        .from('documents')
        .upload(storagePath, pptxBuffer, { contentType: PPTX_MIME, upsert: true });
      if (stErr) {
        console.warn('Presentation storage save failed:', stErr.message);
      } else {
        await supabase
          .from('presentation_instances')
          .update({ output_storage_path: storagePath, updated_at: new Date().toISOString() })
          .eq('id', instance.id);
      }

      for (const f of files) {
        try {
          const slotKey = f.fieldname;
          const ext = (f.originalname.split('.').pop() || 'bin').toLowerCase();
          const assetPath = `presentations/${instance.id}/${slotKey}_${Date.now()}.${ext}`;
          const { error: aErr } = await supabase.storage
            .from('documents')
            .upload(assetPath, f.buffer, { contentType: f.mimetype, upsert: true });
          if (!aErr) {
            await supabase
              .from('presentation_assets')
              .insert({
                instance_id: instance.id,
                slot_key: slotKey,
                storage_path: assetPath,
                mime_type: f.mimetype,
                meta: { original_filename: f.originalname },
              });
          }
        } catch (e) {
          console.warn('Asset save failed:', e.message);
        }
      }
    }

    res.setHeader('Content-Type', PPTX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pptxBuffer);
  } catch (err) {
    console.error('Presentation generate error:', err);
    res.status(500).json({ error: 'Generation failed: ' + err.message });
  }
});

app.get('/api/presentations/instances/:id/download', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: instance, error: qErr } = await supabase
      .from('presentation_instances')
      .select('id, output_storage_path, output_filename, template_slug, variables')
      .eq('id', id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .single();
    if (qErr || !instance) return res.status(404).json({ error: 'Not found' });

    if (instance.output_storage_path) {
      const { data: blob, error: dErr } = await supabase.storage
        .from('documents')
        .download(instance.output_storage_path);
      if (!dErr && blob) {
        const arr = await blob.arrayBuffer();
        res.setHeader('Content-Type', PPTX_MIME);
        res.setHeader('Content-Disposition', `attachment; filename="${instance.output_filename || 'presentation.pptx'}"`);
        return res.send(Buffer.from(arr));
      }
    }

    const template = presentationsRegistry.getTemplate(instance.template_slug);
    if (!template) return res.status(500).json({ error: 'Template no longer available' });
    const pres = template.build(instance.variables || {}, {});
    const buf = await pres.write({ outputType: 'nodebuffer' });
    res.setHeader('Content-Type', PPTX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${instance.output_filename || 'presentation.pptx'}"`);
    res.send(buf);
  } catch (err) {
    console.error('Presentation download error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/presentations/instances/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: instance, error: qErr } = await supabase
      .from('presentation_instances')
      .select('id, output_storage_path')
      .eq('id', id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .single();
    if (qErr || !instance) return res.status(404).json({ error: 'Not found' });

    if (instance.output_storage_path) {
      await supabase.storage.from('documents').remove([instance.output_storage_path]);
    }
    const { data: assets } = await supabase
      .from('presentation_assets')
      .select('storage_path')
      .eq('instance_id', id);
    if (assets && assets.length) {
      await supabase.storage.from('documents').remove(assets.map(a => a.storage_path));
    }
    await supabase.from('presentation_instances').delete().eq('id', id);
    res.json({ success: true });
  } catch (err) {
    console.error('Presentation delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Financial Statements — Bedrock-branded monthly packages
// ----------------------------------------------------------------------------
// Manager uploads a Vantaca PDF (or other source). AI extracts the line items
// into structured JSON. We generate a branded Bedrock PDF and save both
// artifacts to Supabase storage + index in financial_statements. Pull into
// board packets later.
// ============================================================================
// pdfParse already required at the top of the file
const { renderBalanceSheetHTML } = require('./lib/financial_statements/balance_sheet');
const { renderInvestmentStatementHTML } = require('./lib/financial_statements/investment_statement');
const { renderIncomeStatementHTML } = require('./lib/financial_statements/income_statement');
const {
  parseBalanceSheetText,
  generateBalanceSheetFindings,
  parseInvestmentStatementText,
  generateInvestmentStatementFindings,
  parseIncomeStatementText,
  generateIncomeStatementFindings,
} = require('./lib/financial_statements/parser');

async function renderFinancialPdfBuffer(html) {
  const puppeteer = _puppeteer_lazy();
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--single-process'],
  });
  try {
    const page = await browser.newPage();
    try { await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 }); }
    catch (_) { /* swallow — render anyway */ }
    return await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: true,
    });
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

// POST /api/financials/parse — upload Vantaca PDF, return structured JSON.
// Does NOT save — manager can review the extraction before saving.
app.post('/api/financials/parse', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'PDF file required (field "pdf").' });
    const statementType = (req.body.statement_type || 'balance_sheet').toString();
    const parsedPdf = await pdfParse(req.file.buffer);
    const text = parsedPdf.text || '';
    if (!text.trim()) return res.status(400).json({ error: 'Could not extract text from the uploaded PDF.' });

    let data;
    if (statementType === 'balance_sheet') {
      data = await parseBalanceSheetText(text);
    } else if (statementType === 'investment_statement') {
      data = await parseInvestmentStatementText(text);
    } else if (statementType === 'income_statement') {
      data = await parseIncomeStatementText(text);
    } else {
      return res.status(400).json({ error: `Unsupported statement type: ${statementType}.` });
    }
    res.json({ ok: true, data, source_filename: req.file.originalname });
  } catch (err) {
    console.error('[financials/parse] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/financials/generate — produce the Bedrock-branded PDF + save record.
// Accepts multipart: pdf (original Vantaca), data (JSON of parsed line items),
// community, statement_type, period_label, period_end_date.
app.post('/api/financials/generate', upload.single('pdf'), async (req, res) => {
  try {
    const community = (req.body.community || '').trim();
    if (!community) return res.status(400).json({ error: 'community is required.' });
    const statementType = (req.body.statement_type || 'balance_sheet').toString();
    let data = {};
    try { data = JSON.parse(req.body.data || '{}'); } catch (_) { return res.status(400).json({ error: 'data must be valid JSON.' }); }
    const periodLabel = (req.body.period_label || data.period_label || '').trim();
    const periodEndDate = (req.body.period_end_date || data.period_end_date || null);

    // Generate findings (fire-and-forget if fails). The income-statement
    // finding generator can also accept the latest balance sheet + investment
    // context for cross-referencing — pull both for this community.
    let findings = [];
    try {
      if (statementType === 'investment_statement') {
        findings = await generateInvestmentStatementFindings(data, community);
      } else if (statementType === 'income_statement') {
        // Pull latest balance sheet + investment statement for the same community
        // so the IS commentary can cross-reference (e.g., unrealized losses)
        let bsCtx = null, invCtx = null;
        try {
          const { data: ctx } = await supabase
            .from('financial_statements')
            .select('statement_type, extracted_data')
            .eq('management_company_id', BEDROCK_MGMT_CO_ID)
            .ilike('community_name', `%${community}%`)
            .in('statement_type', ['balance_sheet', 'investment_statement'])
            .order('period_end_date', { ascending: false })
            .limit(10);
          if (Array.isArray(ctx)) {
            bsCtx = (ctx.find((r) => r.statement_type === 'balance_sheet') || {}).extracted_data || null;
            invCtx = (ctx.find((r) => r.statement_type === 'investment_statement') || {}).extracted_data || null;
          }
        } catch (_) {}
        findings = await generateIncomeStatementFindings(data, community, { balance_sheet: bsCtx, investment: invCtx });
      } else {
        findings = await generateBalanceSheetFindings(data, community);
      }
    } catch (e) { console.warn('[financials/generate] findings failed:', e.message); }

    // Render Bedrock PDF — pick template by type
    let html;
    if (statementType === 'investment_statement') html = renderInvestmentStatementHTML({ community, data, findings });
    else if (statementType === 'income_statement') html = renderIncomeStatementHTML({ community, data, findings });
    else html = renderBalanceSheetHTML({ community, data, findings });
    const brandedPdf = await renderFinancialPdfBuffer(html);

    // Resolve community_id
    let communityId = null;
    try {
      const { data: comm } = await supabase
        .from('communities')
        .select('id')
        .eq('management_company_id', BEDROCK_MGMT_CO_ID)
        .ilike('name', `%${community.split(' at ')[0]}%`)
        .limit(1)
        .maybeSingle();
      if (comm) communityId = comm.id;
    } catch (_) {}

    // Insert record
    const { data: row, error: insErr } = await supabase
      .from('financial_statements')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id: communityId,
        community_name: community,
        statement_type: statementType,
        period_label: periodLabel,
        period_end_date: periodEndDate,
        source_filename: req.file ? req.file.originalname : null,
        extracted_data: data,
        findings,
        status: 'generated',
      })
      .select()
      .single();
    if (insErr) console.warn('[financials/generate] insert failed:', insErr.message);

    // Upload source + branded PDFs to storage if we got a row
    let brandedPath = null;
    if (row) {
      try {
        if (req.file) {
          const srcPath = `financial_statements/${row.id}/source.pdf`;
          await supabase.storage.from('documents').upload(srcPath, req.file.buffer, {
            contentType: 'application/pdf', upsert: true,
          });
          await supabase.from('financial_statements').update({ source_pdf_storage_path: srcPath }).eq('id', row.id);
        }
        brandedPath = `financial_statements/${row.id}/branded.pdf`;
        await supabase.storage.from('documents').upload(brandedPath, brandedPdf, {
          contentType: 'application/pdf', upsert: true,
        });
        await supabase.from('financial_statements').update({
          branded_pdf_storage_path: brandedPath,
          updated_at: new Date().toISOString(),
        }).eq('id', row.id);
      } catch (e) {
        console.warn('[financials/generate] storage upload failed:', e.message);
      }
    }

    const stem = (community + '_' + (periodLabel || 'statement'))
      .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'financial';
    const typeSlug = statementType === 'investment_statement' ? 'reserve_performance'
      : statementType === 'income_statement' ? 'income_statement'
      : 'balance_sheet';
    const filename = `${stem}_${typeSlug}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (row) {
      res.setHeader('X-Statement-Id', row.id);
      res.setHeader('Access-Control-Expose-Headers', 'X-Statement-Id, Content-Disposition');
    }
    res.send(brandedPdf);
  } catch (err) {
    console.error('[financials/generate] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/financials — list past statements (community filter optional)
app.get('/api/financials', async (req, res) => {
  try {
    const { community, statement_type } = req.query;
    let q = supabase
      .from('financial_statements')
      .select('id, community_name, statement_type, period_label, period_end_date, source_filename, branded_pdf_storage_path, findings, created_at')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('created_at', { ascending: false })
      .limit(100);
    if (community) q = q.ilike('community_name', `%${community}%`);
    if (statement_type) q = q.eq('statement_type', statement_type);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ statements: data || [] });
  } catch (err) {
    console.error('[financials] list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/financials/:id/branded — re-download a saved branded PDF
app.get('/api/financials/:id/branded', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: row, error } = await supabase
      .from('financial_statements')
      .select('community_name, period_label, statement_type, branded_pdf_storage_path, extracted_data, findings, statement_type')
      .eq('id', id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .single();
    if (error || !row) return res.status(404).json({ error: 'Statement not found' });

    let pdfBuffer = null;
    if (row.branded_pdf_storage_path) {
      const { data: blob } = await supabase.storage.from('documents').download(row.branded_pdf_storage_path);
      if (blob) pdfBuffer = Buffer.from(await blob.arrayBuffer());
    }
    if (!pdfBuffer) {
      // Regenerate from stored data — pick the right template by type
      let html;
      if (row.statement_type === 'investment_statement') {
        html = renderInvestmentStatementHTML({ community: row.community_name, data: row.extracted_data || {}, findings: row.findings || [] });
      } else if (row.statement_type === 'income_statement') {
        html = renderIncomeStatementHTML({ community: row.community_name, data: row.extracted_data || {}, findings: row.findings || [] });
      } else {
        html = renderBalanceSheetHTML({ community: row.community_name, data: row.extracted_data || {}, findings: row.findings || [] });
      }
      pdfBuffer = await renderFinancialPdfBuffer(html);
    }

    const stem = (row.community_name + '_' + (row.period_label || 'statement'))
      .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'financial';
    const typeSlug = row.statement_type === 'investment_statement' ? 'reserve_performance'
      : row.statement_type === 'income_statement' ? 'income_statement'
      : 'balance_sheet';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${stem}_${typeSlug}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[financials/:id/branded] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Call for Nominations — annual meeting nomination cycles + public submissions.
//   POST   /api/nominations/cycles
//   GET    /api/nominations/cycles?community=Name
//   GET    /api/nominations/cycles/:id
//   POST   /api/nominations/cycles/:id/letter   → branded PDF
//   GET    /api/nominations/cycles/:id/nominations
//   PATCH  /api/nominations/:id                 → status / manager_notes
//   GET    /nominate/:slug                      → public form HTML
//   GET    /api/nominations/public/:slug        → cycle data for form
//   POST   /api/nominations/public/:slug/submit → homeowner submission
// ============================================================================
const { renderCallForNominationsHTML } = require('./lib/nominations/letter');
const { renderPaperFormHTML } = require('./lib/nominations/paper_form');

// Render an HTML string to a PDF Buffer via puppeteer. Shared helper used by
// the Call for Nominations letter + the standalone Paper Nomination Form so
// both endpoints share the same browser config + margin behavior.
async function _renderHtmlToPdf(html) {
  const puppeteer = _puppeteer_lazy();
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--single-process'],
  });
  try {
    const page = await browser.newPage();
    try { await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch (_) {}
    return await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: true,
    });
  } finally { try { await browser.close(); } catch (_) {} }
}

// Merge two PDFs (Buffers) into one using pdf-lib. Used to auto-append the
// Paper Nomination Form to the Call for Nominations letter so the mailed
// packet is letter + tear-off form in a single PDF — one download for staff
// to send to print, one envelope per homeowner.
async function _mergePdfBuffers(buffers) {
  const { PDFDocument } = _pdflib_lazy();
  const merged = await PDFDocument.create();
  for (const buf of buffers) {
    if (!buf) continue;
    const src = await PDFDocument.load(buf, { ignoreEncryption: true });
    const copied = await merged.copyPages(src, src.getPageIndices());
    copied.forEach((p) => merged.addPage(p));
  }
  return Buffer.from(await merged.save());
}

function nomSlugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function nomResolveCommunityId(communityName) {
  if (!communityName) return null;
  try {
    const stem = communityName.split(' at ')[0];
    const { data } = await supabase
      .from('communities')
      .select('id, slug, name')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .ilike('name', `%${stem}%`)
      .limit(1)
      .maybeSingle();
    return data || null;
  } catch (_) { return null; }
}

async function nomCountByCycle(cycleIds) {
  if (!cycleIds || cycleIds.length === 0) return {};
  try {
    const { data } = await supabase
      .from('nominations')
      .select('cycle_id')
      .in('cycle_id', cycleIds);
    const counts = {};
    (data || []).forEach((n) => { counts[n.cycle_id] = (counts[n.cycle_id] || 0) + 1; });
    return counts;
  } catch (_) { return {}; }
}

app.post('/api/nominations/cycles', upload.any(), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.community_name) return res.status(400).json({ error: 'community_name is required' });
    if (!b.annual_meeting_date) return res.status(400).json({ error: 'annual_meeting_date is required' });

    // Relaxed save: only community + meeting date are required. Everything
    // else can be filled in later — the manager can save with partial info
    // so the cycle shows up on the Schedule + Calendar immediately, then come
    // back to refine. Close defaults to meeting − 24 days (Bedrock target).
    function _addDaysIso(dateStr, delta) {
      const dt = new Date(dateStr + 'T12:00:00');
      if (isNaN(dt.getTime())) return null;
      dt.setDate(dt.getDate() + delta);
      return dt.toISOString().slice(0, 10);
    }
    const closeAt = b.nominations_close_at || _addDaysIso(b.annual_meeting_date, -24);

    // The "open" date is the day the letter goes out — i.e., today. Open it
    // automatically on cycle creation so the manager doesn't have to think
    // about it as a separate field.
    const openAt = b.nominations_open_at || new Date().toISOString().slice(0, 10);
    const comm = await nomResolveCommunityId(b.community_name);
    const slug = (b.public_slug && nomSlugify(b.public_slug)) ||
                 (comm && comm.slug) ||
                 nomSlugify(b.community_name);

    // multipart fields arrive as strings — coerce JSON-shaped ones back to objects.
    let currentBoard = [];
    try { currentBoard = b.current_board ? (Array.isArray(b.current_board) ? b.current_board : JSON.parse(b.current_board)) : []; } catch (_) { currentBoard = []; }
    let onsite = { enabled: false };
    try { onsite = b.onsite_drop_off ? (typeof b.onsite_drop_off === 'object' ? b.onsite_drop_off : JSON.parse(b.onsite_drop_off)) : { enabled: false }; } catch (_) { onsite = { enabled: false }; }

    // Submission methods — default both true if missing (legacy / unset).
    const acceptElectronic   = !(b.accept_electronic === '0' || b.accept_electronic === 'false' || b.accept_electronic === false);
    const acceptPhysicalMail = !(b.accept_physical_mail === '0' || b.accept_physical_mail === 'false' || b.accept_physical_mail === false);

    // Floor-nominations policy — default omitted until governing docs are reviewed.
    const includeFloorNotice = b.include_floor_nominations_notice === '1' ||
                               b.include_floor_nominations_notice === 'true' ||
                               b.include_floor_nominations_notice === true;
    const floorPolicy = (b.floor_nominations_policy === 'allowed' || b.floor_nominations_policy === 'not_allowed')
      ? b.floor_nominations_policy : null;
    const floorNote = (b.floor_nominations_note || '').trim() || null;

    const { data: row, error } = await supabase
      .from('nomination_cycles')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id: comm ? comm.id : '00000000-0000-0000-0000-000000000000',
        community_name: b.community_name,
        annual_meeting_date: b.annual_meeting_date,
        annual_meeting_time: b.annual_meeting_time || null,
        annual_meeting_location: b.annual_meeting_location || null,
        nominations_open_at: openAt,
        nominations_close_at: closeAt,
        nominations_close_time: (b.nominations_close_time || '').trim() || null,
        seats_open: Number(b.seats_open) || 1,
        term_years: Number(b.term_years) || 3,
        // Planning-only flag — does NOT appear on the Call for Nominations
        // letter; drives the voting-methods section of the later Annual
        // Meeting Notice. Stored on voting_methods.online.enabled so the
        // notice renderer picks it up directly.
        voting_methods: (() => {
          const offered = b.electronic_voting_offered === '1' || b.electronic_voting_offered === 'true' || b.electronic_voting_offered === true;
          return { online: { enabled: offered } };
        })(),
        current_board: currentBoard,
        description: b.description || null,
        expectations_blurb: b.expectations_blurb || null,
        bio_prompt_style: 'simple',
        proxy_teaser: true,
        onsite_drop_off: onsite,
        accept_electronic: acceptElectronic,
        accept_physical_mail: acceptPhysicalMail,
        floor_nominations_policy: floorPolicy,
        include_floor_nominations_notice: includeFloorNotice,
        floor_nominations_note: floorNote,
        public_slug: slug,
        status: 'planned',
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    // Optional reference PDF upload — store alongside the cycle for next-year recall.
    try {
      const refFile = (req.files || []).find((f) => f.fieldname === 'reference_letter');
      if (refFile && row) {
        const safeName = (refFile.originalname || 'reference.pdf').replace(/[^A-Za-z0-9._-]+/g, '_');
        const refPath = `nominations/${row.id}/reference_${safeName}`;
        const { error: upErr } = await supabase.storage.from('documents').upload(refPath, refFile.buffer, {
          contentType: refFile.mimetype || 'application/pdf', upsert: true,
        });
        if (!upErr) {
          await supabase.from('nomination_cycles')
            .update({ reference_letter_path: refPath, updated_at: new Date().toISOString() })
            .eq('id', row.id);
          row.reference_letter_path = refPath;
        }
      }
    } catch (e) { console.warn('[nominations/cycles] reference upload failed:', e.message); }

    res.json({ cycle: row });
  } catch (err) {
    console.error('[nominations/cycles POST]', err);
    res.status(500).json({ error: err.message });
  }
});

// Download the prior-year reference letter attached to a cycle
app.get('/api/nominations/cycles/:id/reference', async (req, res) => {
  try {
    const { data: cycle } = await supabase
      .from('nomination_cycles')
      .select('reference_letter_path, community_name')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (!cycle || !cycle.reference_letter_path) return res.status(404).send('No reference letter on file');
    const { data: blob, error } = await supabase.storage.from('documents').download(cycle.reference_letter_path);
    if (error || !blob) return res.status(404).send('Reference letter not found');
    const buf = Buffer.from(await blob.arrayBuffer());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${(cycle.community_name||'community').replace(/\W+/g,'_')}_prior_call_for_nominations.pdf"`);
    res.send(buf);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.get('/api/nominations/cycles', async (req, res) => {
  try {
    let q = supabase
      .from('nomination_cycles')
      .select('*')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('annual_meeting_date', { ascending: false })
      .limit(50);
    if (req.query.community) q = q.ilike('community_name', `%${req.query.community.split(' at ')[0]}%`);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    const counts = await nomCountByCycle((data || []).map((c) => c.id));
    res.json({ cycles: (data || []).map((c) => ({ ...c, nominations_count: counts[c.id] || 0 })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/nominations/cycles/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('nomination_cycles')
      .select('*')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'not found' });
    res.json({ cycle: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a nomination cycle. Used to clean up duplicates / test cycles.
// Nominations on this cycle cascade-delete via the FK ON DELETE CASCADE on
// the nominations.cycle_id column (defined in migration 034).
app.delete('/api/nominations/cycles/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('nomination_cycles')
      .delete()
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    console.error('[nominations/cycle delete]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/nominations/cycles/:id/letter', async (req, res) => {
  try {
    const { data: cycle, error } = await supabase
      .from('nomination_cycles')
      .select('*')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (error || !cycle) return res.status(404).json({ error: 'cycle not found' });

    const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const letterHtml = await renderCallForNominationsHTML(cycle, { base_url: baseUrl });
    const letterPdf  = await _renderHtmlToPdf(letterHtml);

    // Auto-append the Paper Nomination Form as the tear-off page after the
    // letter. The mailed packet is then a single PDF — homeowners receive
    // the letter + the form they can fill out, sign, and return.
    // Skippable via ?no_form=1 if a community ever wants letter-only.
    const skipForm = String(req.query.no_form || '').toLowerCase() === '1' ||
                     String(req.query.no_form || '').toLowerCase() === 'true';
    let buf = letterPdf;
    if (!skipForm) {
      try {
        const formHtml = await renderPaperFormHTML(cycle);
        const formPdf  = await _renderHtmlToPdf(formHtml);
        buf = await _mergePdfBuffers([letterPdf, formPdf]);
      } catch (e) {
        console.warn('[nominations/letter] paper-form append failed, sending letter alone:', e.message);
        buf = letterPdf;
      }
    }

    // Save the combined PDF alongside the cycle for the public form QR + recall.
    try {
      const stem = (cycle.community_name || 'community').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      const storagePath = `nominations/${cycle.id}/${stem}_call_for_nominations.pdf`;
      const { error: upErr } = await supabase.storage.from('documents').upload(storagePath, buf, {
        contentType: 'application/pdf', upsert: true,
      });
      if (!upErr) {
        await supabase.from('nomination_cycles')
          .update({ letter_pdf_storage_path: storagePath, updated_at: new Date().toISOString() })
          .eq('id', cycle.id);
      }
    } catch (e) { console.warn('[nominations/letter] storage save failed:', e.message); }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="call_for_nominations.pdf"`);
    res.send(buf);
  } catch (err) {
    console.error('[nominations/letter]', err);
    res.status(500).json({ error: err.message });
  }
});

// Preview the Call for Nominations letter (with auto-appended paper form)
// WITHOUT saving a cycle to the database. Used by the "👁️ Preview" button so
// staff can review the rendered output before clicking Finalize. Takes the
// same multipart form data the create-cycle endpoint takes, builds an
// in-memory cycle object, renders, returns PDF inline (opens in a new tab).
app.post('/api/nominations/preview-letter', upload.any(), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.community_name) return res.status(400).json({ error: 'Pick a community first.' });
    if (!b.annual_meeting_date) return res.status(400).json({ error: 'Annual meeting date is required to render the letter.' });

    let onsite = { enabled: false };
    try {
      onsite = b.onsite_drop_off
        ? (typeof b.onsite_drop_off === 'object' ? b.onsite_drop_off : JSON.parse(b.onsite_drop_off))
        : { enabled: false };
    } catch (_) { onsite = { enabled: false }; }
    let currentBoard = [];
    try {
      currentBoard = b.current_board
        ? (Array.isArray(b.current_board) ? b.current_board : JSON.parse(b.current_board))
        : [];
    } catch (_) { currentBoard = []; }

    const truthy = (v) => v === true || v === 'true' || v === '1' || v === 'on';

    // Build an in-memory cycle row that mirrors what /cycles POST would
    // persist. ID is a placeholder so the QR/URL preview reads sensibly.
    const cycle = {
      id: 'preview',
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_name: b.community_name,
      annual_meeting_date: b.annual_meeting_date,
      annual_meeting_time: b.annual_meeting_time || null,
      annual_meeting_location: b.annual_meeting_location || null,
      nominations_open_at: new Date().toISOString().slice(0, 10),
      nominations_close_at: b.nominations_close_at || null,
      nominations_close_time: (b.nominations_close_time || '').trim() || null,
      seats_open: Number(b.seats_open) || 1,
      term_years: Number(b.term_years) || 3,
      current_board: currentBoard,
      description: b.description || null,
      expectations_blurb: b.expectations_blurb || null,
      onsite_drop_off: onsite,
      accept_electronic:    !(b.accept_electronic    === '0' || b.accept_electronic    === 'false'),
      accept_physical_mail: !(b.accept_physical_mail === '0' || b.accept_physical_mail === 'false'),
      floor_nominations_policy: (b.floor_nominations_policy === 'allowed' || b.floor_nominations_policy === 'not_allowed') ? b.floor_nominations_policy : null,
      include_floor_nominations_notice: truthy(b.include_floor_nominations_notice),
      floor_nominations_note: (b.floor_nominations_note || '').trim() || null,
      public_slug: (b.public_slug || '').trim() || 'preview',
      bio_prompt_style: 'simple',
      proxy_teaser: true,
    };

    const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const letterHtml = await renderCallForNominationsHTML(cycle, { base_url: baseUrl });
    const letterPdf  = await _renderHtmlToPdf(letterHtml);

    // Append the paper form (same default as the live letter route) so the
    // preview shows the full mailed packet exactly as homeowners will receive it.
    let buf = letterPdf;
    try {
      const formHtml = await renderPaperFormHTML(cycle);
      const formPdf  = await _renderHtmlToPdf(formHtml);
      buf = await _mergePdfBuffers([letterPdf, formPdf]);
    } catch (e) {
      console.warn('[nominations/preview-letter] paper-form append failed, returning letter alone:', e.message);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="preview-call-for-nominations.pdf"');
    res.send(buf);
  } catch (err) {
    console.error('[nominations/preview-letter]', err);
    res.status(500).json({ error: err.message });
  }
});

// Smart voting-methods defaults — produces a reasonable Annual Meeting
// Notice on day one without requiring staff to configure a separate
// voting-methods editor (still on the queue). Layered logic:
//   - online voting: enabled only if the cycle's electronic_voting toggle
//     is on (voting_methods.online.enabled persisted at finalize time)
//   - mail: enabled by default — Bedrock standard return address, receive
//     by close − 5 days (T−5 from meeting)
//   - drop_off: enabled if the cycle has an onsite drop-off configured
//   - in_person: always enabled (it's the annual meeting)
function buildVotingMethodsFromCycle(cycle) {
  const closeDate = cycle.nominations_close_at || null;
  const closeTime = cycle.nominations_close_time || '5:00 PM';
  const userMethods = cycle.voting_methods || {};
  const onlineCfg = (userMethods.online && userMethods.online.enabled)
    ? { enabled: true, close_date: closeDate, close_time: closeTime }
    : { enabled: false };
  const onsite = cycle.onsite_drop_off || {};
  return {
    online: onlineCfg,
    mail: {
      enabled: true,
      receive_by_date: closeDate,
      receive_by_time: closeTime,
      return_address: BRAND.service.addressInline,
    },
    email: {
      enabled: true,
      receive_by_date: closeDate,
      receive_by_time: closeTime,
      address: BRAND.service.email,
    },
    drop_off: onsite.enabled
      ? {
          enabled: true,
          receive_by_date: closeDate,
          receive_by_time: closeTime,
          location_name: onsite.location_name || 'On-site office',
          location_address: onsite.address || null,
        }
      : { enabled: false },
    in_person: { enabled: true },
  };
}

// Convert a Supabase storage path into a base64 data URI so puppeteer can
// embed the image directly during PDF render (no network required, no
// signed-URL expiry races). Returns null if download fails.
async function _storagePathToDataUri(storagePath, fallbackMime = 'image/jpeg') {
  if (!storagePath) return null;
  try {
    const { data: blob, error } = await supabase.storage.from('documents').download(storagePath);
    if (error || !blob) return null;
    const buf = Buffer.from(await blob.arrayBuffer());
    return `data:${fallbackMime};base64,${buf.toString('base64')}`;
  } catch (e) {
    console.warn('[storagePathToDataUri] failed:', e.message);
    return null;
  }
}

// POST /api/nominations/cycles/:id/annual-meeting-notice
// Generates the 4-page Annual Meeting Notice + Voting Instructions + Proxy/
// Absentee Ballot + Candidate Statements PDF. Pulls every nomination with
// status='on_slate' for the candidates section, embeds their photos as
// data URIs, and applies smart voting-method defaults if the cycle hasn't
// been configured beyond the electronic-voting toggle.
const { renderAnnualMeetingNoticeHTML } = require('./lib/nominations/annual_meeting_notice');
app.post('/api/nominations/cycles/:id/annual-meeting-notice', async (req, res) => {
  try {
    const { data: cycle, error: cErr } = await supabase
      .from('nomination_cycles')
      .select('*')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (cErr || !cycle) return res.status(404).json({ error: 'cycle not found' });

    const { data: candidatesRaw } = await supabase
      .from('nominations')
      .select('*')
      .eq('cycle_id', cycle.id)
      .eq('status', 'on_slate')
      .order('nominee_name');

    const candidates = await Promise.all((candidatesRaw || []).map(async (n) => ({
      ...n,
      photo_data_uri: await _storagePathToDataUri(n.photo_storage_path),
    })));

    const html = await renderAnnualMeetingNoticeHTML({
      cycle,
      candidates,
      voting_methods: buildVotingMethodsFromCycle(cycle),
      options: {
        term_years: cycle.term_years || 3,
        floor_nominations: cycle.floor_nominations_policy || null,
        registration_time: cycle.registration_time || null,
        tx_209_disclosure: cycle.tx_209_disclosure_style || 'callout',
        voting_year: cycle.annual_meeting_date
          ? new Date(cycle.annual_meeting_date).getFullYear()
          : new Date().getFullYear(),
      },
    });
    const buf = await _renderHtmlToPdf(html);

    // Save the rendered PDF to storage so it's recoverable later and
    // tied to the cycle for posterity.
    try {
      const stem = (cycle.community_name || 'community').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      const storagePath = `nominations/${cycle.id}/${stem}_annual_meeting_notice.pdf`;
      await supabase.storage.from('documents').upload(storagePath, buf, {
        contentType: 'application/pdf', upsert: true,
      });
    } catch (e) { console.warn('[annual-meeting-notice] storage save failed:', e.message); }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="annual_meeting_notice.pdf"`);
    res.send(buf);
  } catch (err) {
    console.error('[nominations/annual-meeting-notice]', err);
    res.status(500).json({ error: err.message });
  }
});

// Standalone Paper Nomination Form download — for staff who need just the
// tear-off form (e.g., to email a homeowner who asked for a paper version,
// or to print copies for the on-site office).
app.post('/api/nominations/cycles/:id/paper-form', async (req, res) => {
  try {
    const { data: cycle, error } = await supabase
      .from('nomination_cycles')
      .select('*')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (error || !cycle) return res.status(404).json({ error: 'cycle not found' });
    const html = await renderPaperFormHTML(cycle);
    const buf  = await _renderHtmlToPdf(html);
    const stem = (cycle.community_name || 'community').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${stem}_paper_nomination_form.pdf"`);
    res.send(buf);
  } catch (err) {
    console.error('[nominations/paper-form]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/nominations/cycles/:id/nominations', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('nominations')
      .select('*')
      .eq('cycle_id', req.params.id)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    // Resolve signed URLs for photo + scanned form so the admin UI can
    // render previews and download links without each row having to fetch
    // separately. Signed URLs are good for 1 hour; admin reloads regularly.
    const out = await Promise.all((data || []).map(async (n) => {
      const enriched = { ...n };
      if (n.photo_storage_path) {
        const { data: s } = await supabase.storage.from('documents').createSignedUrl(n.photo_storage_path, 3600);
        if (s && s.signedUrl) enriched.photo_signed_url = s.signedUrl;
      }
      if (n.scanned_form_path) {
        const { data: s } = await supabase.storage.from('documents').createSignedUrl(n.scanned_form_path, 3600);
        if (s && s.signedUrl) enriched.scanned_form_signed_url = s.signedUrl;
      }
      return enriched;
    }));
    res.json({ nominations: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/nominations/:id', async (req, res) => {
  try {
    const allowed = ['status', 'manager_notes'];
    const patch = {};
    allowed.forEach((k) => { if (k in (req.body || {})) patch[k] = req.body[k]; });
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'nothing to update' });
    patch.updated_at = new Date().toISOString();

    // Read prior status so the audit log can record old → new.
    const { data: prior } = await supabase
      .from('nominations')
      .select('id, cycle_id, nominee_name, status')
      .eq('id', req.params.id)
      .maybeSingle();

    const { data, error } = await supabase
      .from('nominations')
      .update(patch)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    // Audit: log status changes (the common case). Use the specialized
    // on_slate_added / on_slate_removed event_types when the change is
    // crossing the ballot threshold — makes it trivial later to query
    // "everyone who was ever on a ballot."
    if (prior && 'status' in patch && prior.status !== patch.status) {
      let evt = 'status_changed';
      if (patch.status === 'on_slate') evt = 'on_slate_added';
      else if (prior.status === 'on_slate') evt = 'on_slate_removed';
      nomLogEvent({
        nomination_id: data.id,
        cycle_id: data.cycle_id,
        nominee_name: data.nominee_name,
        event_type: evt,
        actor: req.body.actor || 'staff',
        payload: { old: prior.status, new: patch.status, manager_notes_changed: 'manager_notes' in patch },
      });
    } else if (prior && 'manager_notes' in patch) {
      nomLogEvent({
        nomination_id: data.id,
        cycle_id: data.cycle_id,
        nominee_name: data.nominee_name,
        event_type: 'edited',
        actor: req.body.actor || 'staff',
        payload: { fields_changed: ['manager_notes'] },
      });
    }
    res.json({ nomination: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public homeowner-facing form — serves the HTML
// Slug-vs-UUID test. public_slug is a free-form string column; id is UUID.
// If we try .or('public_slug.eq.X,id.eq.X') and X isn't a UUID, Postgres
// rejects the id.eq side with "invalid input syntax for type uuid" and the
// entire query fails — turning a perfectly valid public_slug lookup into a
// 404. We only include id.eq when X looks like a UUID.
const _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function _isUuidish(s) { return _UUID_RE.test(String(s || '')); }

// Append-only audit log helper. Writes a row to nomination_events for
// every meaningful action — submission, status change, photo upload,
// staff manual entry, edits. Never throws; logging failures are warned
// but never block the main operation. nomination_events has no FK to
// nominations, so the audit trail survives even if a cycle (and its
// nominations) are deleted.
async function nomLogEvent({ nomination_id, cycle_id, nominee_name, event_type, payload, actor }) {
  try {
    if (!nomination_id || !event_type) return;
    await supabase.from('nomination_events').insert({
      nomination_id,
      cycle_id: cycle_id || null,
      nominee_name: nominee_name || null,
      event_type,
      payload: payload || null,
      actor: actor || null,
    });
  } catch (e) {
    console.warn('[nomLogEvent] failed:', e.message);
  }
}

app.get('/nominate/:slug', async (req, res) => {
  try {
    const slug = req.params.slug;
    let q = supabase
      .from('nomination_cycles')
      .select('id, public_slug')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    q = _isUuidish(slug)
      ? q.or(`public_slug.eq.${slug},id.eq.${slug}`)
      : q.eq('public_slug', slug);
    const { data: cycle } = await q.limit(1).maybeSingle();
    if (!cycle) return res.status(404).send('<h1>Nominations form not found</h1><p>This community does not have an active nomination cycle.</p>');
    res.sendFile(require('path').join(__dirname, 'public', 'nominate.html'));
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.get('/api/nominations/public/:slug', async (req, res) => {
  try {
    const slug = req.params.slug;
    let q = supabase
      .from('nomination_cycles')
      .select('id, community_name, annual_meeting_date, annual_meeting_time, annual_meeting_location, nominations_open_at, nominations_close_at, seats_open, current_board, description, status, public_slug')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    q = _isUuidish(slug)
      ? q.or(`public_slug.eq.${slug},id.eq.${slug}`)
      : q.eq('public_slug', slug);
    const { data: cycle, error } = await q.limit(1).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!cycle) return res.status(404).json({ error: 'cycle not found' });
    // Window check — communicate but still serve the form so we can show a friendly message
    const today = new Date().toISOString().slice(0, 10);
    const isOpen = today >= cycle.nominations_open_at && today <= cycle.nominations_close_at && cycle.status !== 'closed' && cycle.status !== 'finalized';
    res.json({ cycle, is_open: isOpen, today });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public-form submission. Accepts multipart so the optional photo +
// optional scanned-form files travel with the JSON-ish text fields. Plain
// JSON requests (no files) still work because multer leaves req.body
// populated from form-data text fields.
app.post('/api/nominations/public/:slug/submit', upload.fields([
  { name: 'nominee_photo', maxCount: 1 },
  { name: 'scanned_form',  maxCount: 1 },
]), async (req, res) => {
  try {
    const slug = req.params.slug;
    let q = supabase
      .from('nomination_cycles')
      .select('id, nominations_open_at, nominations_close_at, status')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    q = _isUuidish(slug)
      ? q.or(`public_slug.eq.${slug},id.eq.${slug}`)
      : q.eq('public_slug', slug);
    const { data: cycle } = await q.limit(1).maybeSingle();
    if (!cycle) return res.status(404).json({ error: 'cycle not found' });
    const today = new Date().toISOString().slice(0, 10);
    if (today < cycle.nominations_open_at) return res.status(403).json({ error: 'Nominations have not opened yet.' });
    if (today > cycle.nominations_close_at || cycle.status === 'closed' || cycle.status === 'finalized') {
      return res.status(403).json({ error: 'Nominations are closed for this cycle.' });
    }

    const b = req.body || {};
    // Form-data sends booleans as strings — normalize before validation.
    const truthy = (v) => v === true || v === 'true' || v === '1' || v === 'on';
    b.is_self_nomination = truthy(b.is_self_nomination);
    b.agreed_to_terms    = truthy(b.agreed_to_terms);

    if (!b.nominee_name || !b.nominee_address) return res.status(400).json({ error: 'Nominee name and address are required.' });
    if (!b.nominator_name || !b.nominator_email || !b.nominator_phone) {
      return res.status(400).json({ error: 'Submitter name, email, and phone are required so Bedrock can confirm receipt of the nomination.' });
    }
    if (!b.signature_name || !b.agreed_to_terms) return res.status(400).json({ error: 'Electronic signature and agreement are required.' });

    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim() || null;

    // Submitter contact (nominator_*) is captured on EVERY submission so
    // Bedrock always has a callback path. The client mirrors submitter→nominee
    // on self-nominations; the server stores both columns either way so a
    // self-nom row has nominator_* == nominee_* (consistent data model that
    // makes future queries — "who submitted this?" — trivial).
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('nominations')
      .insert({
        cycle_id: cycle.id,
        nominee_name: b.nominee_name,
        nominee_address: b.nominee_address,
        nominee_email: b.nominee_email || null,
        nominee_phone: b.nominee_phone || null,
        nominee_bio: b.nominee_bio || null,
        occupation: b.occupation || null,
        education: b.education || null,
        outside_activities: b.outside_activities || null,
        asset_reason: b.asset_reason || null,
        years_in_community: b.years_in_community || null,
        is_self_nomination: !!b.is_self_nomination,
        nominator_name:    b.nominator_name    || null,
        nominator_email:   b.nominator_email   || null,
        nominator_phone:   b.nominator_phone   || null,
        nominator_address: b.nominator_address || null,
        signature_name: b.signature_name,
        agreed_to_terms: !!b.agreed_to_terms,
        client_ip: ip,
        user_agent: (req.headers['user-agent'] || '').slice(0, 500),
        status: 'submitted',
        submission_channel: 'online_form',
        received_at: now,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    // Audit log: record the submission with a snapshot so the event row
    // is meaningful even if the nomination/cycle are later deleted.
    nomLogEvent({
      nomination_id: data.id,
      cycle_id: cycle.id,
      nominee_name: data.nominee_name,
      event_type: 'submitted',
      actor: data.nominator_name || data.nominee_name || 'public_form',
      payload: {
        is_self_nomination: data.is_self_nomination,
        nominator_email: data.nominator_email,
        nominator_phone: data.nominator_phone,
        nominee_address: data.nominee_address,
        years_in_community: data.years_in_community,
        bio_length: (data.nominee_bio || '').length,
        client_ip: data.client_ip,
        submission_channel: data.submission_channel,
      },
    });

    // Optional file attachments — upload to storage and link the paths back
    // onto the row. Failures here are non-fatal; the nomination is already
    // saved. We log and tell the client which uploads succeeded so it can
    // surface a partial-success message if needed.
    const attached = { photo: false, scanned_form: false };
    const photoFile = req.files && req.files.nominee_photo && req.files.nominee_photo[0];
    if (photoFile && photoFile.buffer) {
      try {
        // Resize down to ~1MB max so 8MB phone photos don't bloat storage
        // or slow the admin UI. Quality stays high enough for ballot use.
        const shrunk = await shrinkImageToTarget(photoFile.buffer, photoFile.mimetype, NOMINATION_PHOTO_TARGET, 1200);
        const safeName = (photoFile.originalname || 'photo.jpg').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.(jpe?g|png|gif|webp|heic)$/i, '') + '.jpg';
        const photoPath = `nominations/${data.id}/photo_${Date.now()}_${safeName}`;
        const { error: pErr } = await supabase.storage.from('documents').upload(photoPath, shrunk.buffer, {
          contentType: shrunk.mimetype || 'image/jpeg', upsert: true,
        });
        if (!pErr) {
          await supabase.from('nominations').update({ photo_storage_path: photoPath }).eq('id', data.id);
          attached.photo = true;
          nomLogEvent({
            nomination_id: data.id,
            cycle_id: cycle.id,
            nominee_name: data.nominee_name,
            event_type: 'photo_uploaded',
            actor: 'public_form',
            payload: { path: photoPath, original_size: photoFile.size },
          });
        } else console.warn('[nominations/photo upload]', pErr.message);
      } catch (e) { console.warn('[nominations/photo upload exception]', e.message); }
    }
    const scannedFile = req.files && req.files.scanned_form && req.files.scanned_form[0];
    if (scannedFile && scannedFile.buffer) {
      try {
        const safeName = (scannedFile.originalname || 'form.pdf').replace(/[^A-Za-z0-9._-]+/g, '_');
        const formPath = `nominations/${data.id}/scanned_${Date.now()}_${safeName}`;
        const { error: sErr } = await supabase.storage.from('documents').upload(formPath, scannedFile.buffer, {
          contentType: scannedFile.mimetype || 'application/pdf', upsert: true,
        });
        if (!sErr) {
          await supabase.from('nominations').update({
            scanned_form_path: formPath,
            scanned_form_mime: scannedFile.mimetype || 'application/pdf',
          }).eq('id', data.id);
          attached.scanned_form = true;
          nomLogEvent({
            nomination_id: data.id,
            cycle_id: cycle.id,
            nominee_name: data.nominee_name,
            event_type: 'scanned_form_uploaded',
            actor: 'public_form',
            payload: { path: formPath, mime: scannedFile.mimetype, original_size: scannedFile.size },
          });
        } else console.warn('[nominations/scanned upload]', sErr.message);
      } catch (e) { console.warn('[nominations/scanned upload exception]', e.message); }
    }

    res.json({ ok: true, nomination_id: data.id, attached });
  } catch (err) {
    console.error('[nominations/public/submit]', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// Staff manual-entry route — used when a nomination arrives by mail / email /
// drop-off / phone / in-person and staff need to enter it into the system so
// it flows through the same on_slate → ballot pipeline as online ones.
//
// Same payload as the public submit, plus:
//   submission_channel  'email' | 'mail' | 'drop_off' | 'in_person' | 'phone' | 'other'
//   received_at         when the offline submission was actually received
//   created_by_staff    staff name (text — auth lands later)
//   intake_notes        optional context ("transcribed from paper form")
// ----------------------------------------------------------------------------
app.post('/api/nominations/cycles/:id/nominations', async (req, res) => {
  try {
    const cycleId = req.params.id;
    const { data: cycle } = await supabase
      .from('nomination_cycles')
      .select('id')
      .eq('id', cycleId)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (!cycle) return res.status(404).json({ error: 'cycle not found' });

    const b = req.body || {};
    if (!b.nominee_name || !b.nominee_address) {
      return res.status(400).json({ error: 'Nominee name and address are required.' });
    }
    const allowedChannels = new Set(['email','mail','drop_off','in_person','phone','other']);
    const channel = allowedChannels.has(b.submission_channel) ? b.submission_channel : 'other';
    const receivedAt = b.received_at || new Date().toISOString();
    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from('nominations')
      .insert({
        cycle_id: cycleId,
        nominee_name: b.nominee_name,
        nominee_address: b.nominee_address,
        nominee_email: b.nominee_email || null,
        nominee_phone: b.nominee_phone || null,
        nominee_bio: b.nominee_bio || null,
        is_self_nomination: !!b.is_self_nomination,
        nominator_name:    b.nominator_name    || null,
        nominator_email:   b.nominator_email   || null,
        nominator_phone:   b.nominator_phone   || null,
        nominator_address: b.nominator_address || null,
        signature_name: b.signature_name || (b.is_self_nomination ? b.nominee_name : (b.nominator_name || 'Unknown')),
        agreed_to_terms: true,
        signed_at: receivedAt,
        status: 'submitted',
        submission_channel: channel,
        received_at: receivedAt,
        created_by_staff: b.created_by_staff || null,
        intake_notes: b.intake_notes || null,
        years_in_community: b.years_in_community || null,
        is_incumbent: !!b.is_incumbent,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    nomLogEvent({
      nomination_id: data.id,
      cycle_id: data.cycle_id,
      nominee_name: data.nominee_name,
      event_type: 'manually_entered',
      actor: data.created_by_staff || 'staff',
      payload: {
        submission_channel: channel,
        received_at: receivedAt,
        intake_notes: data.intake_notes,
        is_self_nomination: data.is_self_nomination,
        nominator_name: data.nominator_name,
      },
    });
    res.json({ nomination: data });
  } catch (err) {
    console.error('[nominations/staff-entry]', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// Extract structured nomination fields from a scanned paper form. Staff
// drops the scan into the manual-entry modal, hits "Extract", and the
// modal pre-fills so they just verify instead of transcribing. Uses
// the AI Sonnet 4.6 vision; returns the structured JSON the modal expects.
// ----------------------------------------------------------------------------
app.post('/api/nominations/extract-from-scan', upload.single('scan'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'No scan file uploaded.' });
    const { extractNominationFieldsFromScan } = require('./lib/nominations/extract_from_scan');
    const out = await extractNominationFieldsFromScan({
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
    });
    if (out.error) return res.status(500).json(out);
    res.json(out);
  } catch (err) {
    console.error('[nominations/extract-from-scan]', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// Photo upload for a nomination. Staff-side — most homeowners won't have a
// photo ready while submitting via the form. Stores in the `documents` bucket
// under nominations/<id>/photo_<filename> and updates photo_storage_path.
// ----------------------------------------------------------------------------
app.post('/api/nominations/:id/photo', upload.single('photo'), async (req, res) => {
  try {
    const nomId = req.params.id;
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'No photo file uploaded.' });
    const { data: nom } = await supabase
      .from('nominations')
      .select('id, cycle_id, nominee_name, photo_storage_path')
      .eq('id', nomId)
      .maybeSingle();
    if (!nom) return res.status(404).json({ error: 'nomination not found' });
    const replacingExistingPhoto = !!nom.photo_storage_path;

    // Resize down to ~1MB max — staff uploads from phone gallery are
    // routinely 5-10MB, which would bloat storage and slow the admin UI.
    const shrunk = await shrinkImageToTarget(req.file.buffer, req.file.mimetype, NOMINATION_PHOTO_TARGET, 1200);
    const safeName = (req.file.originalname || 'photo.jpg').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.(jpe?g|png|gif|webp|heic)$/i, '') + '.jpg';
    const storagePath = `nominations/${nomId}/photo_${Date.now()}_${safeName}`;
    const { error: upErr } = await supabase.storage
      .from('documents')
      .upload(storagePath, shrunk.buffer, {
        contentType: shrunk.mimetype || 'image/jpeg',
        upsert: true,
      });
    if (upErr) return res.status(500).json({ error: upErr.message });

    const { data: updated, error: updErr } = await supabase
      .from('nominations')
      .update({ photo_storage_path: storagePath, updated_at: new Date().toISOString() })
      .eq('id', nomId)
      .select()
      .single();
    if (updErr) return res.status(500).json({ error: updErr.message });

    nomLogEvent({
      nomination_id: nomId,
      cycle_id: nom.cycle_id,
      nominee_name: nom.nominee_name,
      event_type: 'photo_uploaded',
      actor: 'staff',
      payload: { path: storagePath, replaced: replacingExistingPhoto, original_size: req.file.size },
    });

    const { data: signed } = await supabase.storage.from('documents').createSignedUrl(storagePath, 3600);
    res.json({ nomination: updated, signed_url: signed && signed.signedUrl });
  } catch (err) {
    console.error('[nominations/photo]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Drafts — save-in-progress for any screen.
//
//   POST   /api/drafts (multipart: state + files)        → create or update
//   GET    /api/drafts?type=acc_review&community=Foo     → list
//   GET    /api/drafts/:id                               → load + signed URLs
//   GET    /api/drafts/:id/files/:idx                    → stream a saved file
//   DELETE /api/drafts/:id                               → delete row + files
//
// `state` is opaque to the server — each screen owns its shape. Files are
// uploaded as multipart with fieldname like `file_<field>` (e.g. file_photos)
// and tracked in file_refs so the load step can re-hydrate them on the client.
// ============================================================================

app.post('/api/drafts', upload.any(), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.draft_type) return res.status(400).json({ error: 'draft_type is required' });
    let state = {};
    try { state = b.state ? JSON.parse(b.state) : {}; } catch (_) { state = {}; }

    const isUpdate = !!b.id;
    let draftId = b.id || null;

    if (!draftId) {
      // Create the row first so we have an id to namespace storage paths under.
      const { data: row, error } = await supabase
        .from('drafts')
        .insert({
          management_company_id: BEDROCK_MGMT_CO_ID,
          draft_type: b.draft_type,
          community_name: b.community_name || null,
          label: b.label || null,
          state,
          file_refs: [],
        })
        .select()
        .single();
      if (error) return res.status(500).json({ error: error.message });
      draftId = row.id;
    } else {
      // Update — preserve existing file_refs unless we're replacing them.
      const patch = { state, updated_at: new Date().toISOString() };
      if ('label' in b) patch.label = b.label || null;
      if ('community_name' in b) patch.community_name = b.community_name || null;
      const { error } = await supabase.from('drafts').update(patch).eq('id', draftId);
      if (error) return res.status(500).json({ error: error.message });
    }

    // Carry forward old file_refs unless the client says to replace them.
    let fileRefs = [];
    if (isUpdate && b.replace_files !== '1') {
      const { data } = await supabase.from('drafts').select('file_refs').eq('id', draftId).maybeSingle();
      fileRefs = Array.isArray(data && data.file_refs) ? data.file_refs : [];
    }

    // Upload any new files supplied on this save.
    const incoming = (req.files || []).filter((f) => f.fieldname.startsWith('file_'));
    for (const f of incoming) {
      const field = f.fieldname.replace(/^file_/, '');
      const safe = (f.originalname || 'file').replace(/[^A-Za-z0-9._-]+/g, '_');
      const path = `drafts/${draftId}/${Date.now()}_${safe}`;
      const { error: upErr } = await supabase.storage.from('documents').upload(path, f.buffer, {
        contentType: f.mimetype || 'application/octet-stream', upsert: true,
      });
      if (upErr) {
        console.warn('[drafts] file upload failed:', upErr.message);
        continue;
      }
      fileRefs.push({ field, path, name: f.originalname, type: f.mimetype, size: f.size });
    }

    if (incoming.length > 0 || b.replace_files === '1') {
      await supabase.from('drafts').update({ file_refs: fileRefs, updated_at: new Date().toISOString() }).eq('id', draftId);
    }

    const { data: row } = await supabase.from('drafts').select('*').eq('id', draftId).maybeSingle();
    res.json({ draft: row });
  } catch (err) {
    console.error('[drafts POST]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/drafts', async (req, res) => {
  try {
    let q = supabase.from('drafts')
      .select('id, draft_type, community_name, label, state, file_refs, created_at, updated_at')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('updated_at', { ascending: false })
      .limit(50);
    if (req.query.type) q = q.eq('draft_type', req.query.type);
    if (req.query.community) q = q.ilike('community_name', `%${req.query.community.split(' at ')[0]}%`);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ drafts: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/drafts/:id', async (req, res) => {
  try {
    const { data: row, error } = await supabase
      .from('drafts')
      .select('*')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!row) return res.status(404).json({ error: 'draft not found' });

    // Annotate each file_ref with a thumbnail URL so the client can preview without re-fetching.
    const refs = Array.isArray(row.file_refs) ? row.file_refs : [];
    row.file_refs = refs.map((r, idx) => ({ ...r, url: `/api/drafts/${row.id}/files/${idx}` }));
    res.json({ draft: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/drafts/:id/files/:idx', async (req, res) => {
  try {
    const { data: row } = await supabase
      .from('drafts')
      .select('file_refs')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (!row) return res.status(404).send('Not found');
    const refs = Array.isArray(row.file_refs) ? row.file_refs : [];
    const ref = refs[Number(req.params.idx)];
    if (!ref || !ref.path) return res.status(404).send('Not found');
    const { data: blob, error } = await supabase.storage.from('documents').download(ref.path);
    if (error || !blob) return res.status(404).send('Not found');
    const buf = Buffer.from(await blob.arrayBuffer());
    res.setHeader('Content-Type', ref.type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${(ref.name || 'file').replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.send(buf);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.delete('/api/drafts/:id', async (req, res) => {
  try {
    // Best-effort: clean up storage objects too.
    const { data: row } = await supabase
      .from('drafts')
      .select('file_refs')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (row && Array.isArray(row.file_refs) && row.file_refs.length > 0) {
      const paths = row.file_refs.map((r) => r.path).filter(Boolean);
      if (paths.length > 0) {
        try { await supabase.storage.from('documents').remove(paths); } catch (_) {}
      }
    }
    const { error } = await supabase.from('drafts').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Board roster — single source of truth for who's on each community's board.
//   GET    /api/board-members?community=Name
//   POST   /api/board-members
//   PATCH  /api/board-members/:id
//   DELETE /api/board-members/:id   (soft = set is_active=false)
// ============================================================================

app.get('/api/board-members', async (req, res) => {
  try {
    let q = supabase
      .from('board_members')
      .select('*')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('position', { ascending: true })
      .order('name', { ascending: true });
    if (req.query.community) {
      q = q.ilike('community_name', `%${req.query.community.split(' at ')[0]}%`);
    }
    if (req.query.active_only !== '0') q = q.eq('is_active', true);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ members: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/board-members', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.community_name) return res.status(400).json({ error: 'community_name is required' });
    if (!b.name) return res.status(400).json({ error: 'name is required' });
    const comm = await nomResolveCommunityId(b.community_name);
    const { data, error } = await supabase
      .from('board_members')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id: comm ? comm.id : null,
        community_name: b.community_name,
        name: b.name,
        position: b.position || null,
        term_start: b.term_start || null,
        term_end: b.term_end || null,
        email: b.email || null,
        phone: b.phone || null,
        notes: b.notes || null,
        is_active: b.is_active !== false,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ member: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/board-members/:id', async (req, res) => {
  try {
    const allowed = ['name', 'position', 'term_start', 'term_end', 'email', 'phone', 'notes', 'is_active'];
    const patch = {};
    allowed.forEach((k) => { if (k in (req.body || {})) patch[k] = req.body[k] === '' ? null : req.body[k]; });
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'nothing to update' });
    patch.updated_at = new Date().toISOString();
    const { data, error } = await supabase
      .from('board_members')
      .update(patch)
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ member: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/board-members/:id', async (req, res) => {
  try {
    // Soft delete by default — preserves historical board snapshots in cycles.
    const hard = req.query.hard === '1';
    if (hard) {
      const { error } = await supabase
        .from('board_members')
        .delete()
        .eq('id', req.params.id)
        .eq('management_company_id', BEDROCK_MGMT_CO_ID);
      if (error) return res.status(500).json({ error: error.message });
    } else {
      const { error } = await supabase
        .from('board_members')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .eq('management_company_id', BEDROCK_MGMT_CO_ID);
      if (error) return res.status(500).json({ error: error.message });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Annual Meeting Schedule — portfolio view across every community.
//   GET /api/annual-meetings/calendar
//
// Returns one row per community with its latest nomination_cycle (if any),
// so the client can compute start-to-plan / send-by / close / meeting dates
// and the status badge. Independent of the cycle CRUD endpoints — this is a
// dashboard read.
// ============================================================================
app.get('/api/annual-meetings/calendar', async (req, res) => {
  try {
    const [{ data: communities }, { data: cycles }] = await Promise.all([
      supabase
        .from('communities')
        .select('id, name, slug')
        .eq('management_company_id', BEDROCK_MGMT_CO_ID)
        .order('name', { ascending: true }),
      supabase
        .from('nomination_cycles')
        .select('id, community_name, annual_meeting_date, annual_meeting_time, annual_meeting_location, nominations_open_at, nominations_close_at, accept_electronic, accept_physical_mail, status, public_slug, seats_open')
        .eq('management_company_id', BEDROCK_MGMT_CO_ID)
        .order('annual_meeting_date', { ascending: false }),
    ]);

    // Group cycles by community_name — first match is the latest (rows are
    // already date-desc). Loose-match by leading community name segment so
    // "Canyon Gate" in the community row matches "Canyon Gate at Cinco Ranch"
    // saved on a cycle (or vice versa).
    function commKey(name) { return String(name || '').split(' at ')[0].trim().toLowerCase(); }
    const latestByCommunity = {};
    const allByCommunity = {};
    for (const c of cycles || []) {
      const k = commKey(c.community_name);
      if (!latestByCommunity[k]) latestByCommunity[k] = c;
      (allByCommunity[k] ||= []).push(c);
    }

    // For each community, if the latest cycle's meeting date is in the past,
    // project a tentative cycle one year forward so the manager sees planning
    // dates even before they've created next year's cycle. The projected
    // cycle preserves the historical meeting date (gray "from last year"
    // label) and time-of-day so dates stay realistic.
    const todayStr = new Date().toISOString().slice(0, 10);
    function addYear(dateStr) {
      if (!dateStr) return null;
      const dt = new Date(dateStr + 'T12:00:00');
      if (isNaN(dt.getTime())) return null;
      dt.setFullYear(dt.getFullYear() + 1);
      return dt.toISOString().slice(0, 10);
    }

    const rows = (communities || []).map((comm) => {
      const k = commKey(comm.name);
      const cycle = latestByCommunity[k] || null;
      const all = allByCommunity[k] || [];
      // Most recent meeting that has already happened (used as both the
      // "from last year" reference and the projection seed).
      const priorPastCycle = all.find((c) => c.annual_meeting_date && c.annual_meeting_date < todayStr) || null;
      let projected = null;
      if (cycle && cycle.annual_meeting_date && cycle.annual_meeting_date < todayStr) {
        const projectedMeeting = addYear(cycle.annual_meeting_date);
        projected = {
          annual_meeting_date: projectedMeeting,
          annual_meeting_time: cycle.annual_meeting_time || null,
          annual_meeting_location: cycle.annual_meeting_location || null,
          accept_electronic: cycle.accept_electronic,
          accept_physical_mail: cycle.accept_physical_mail,
          source_meeting_date: cycle.annual_meeting_date,
          is_projected: true,
        };
      }
      return {
        community: comm.name,
        community_id: comm.id,
        community_slug: comm.slug,
        latest_cycle: cycle,
        projected_cycle: projected,
        prior_year_meeting: priorPastCycle ? priorPastCycle.annual_meeting_date : null,
      };
    });

    res.json({ rows });
  } catch (err) {
    console.error('[annual-meetings/calendar]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Calendar — cross-module event feed for the top-level 🗓️ Calendar tab.
//   GET /api/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Returns one row per event. Today's sources:
//   • Annual meeting cycles — start_to_plan, send_by, close, meeting
//     (real cycles + projected next-year for communities whose latest
//     cycle is in the past)
// Future sources: ARC backlog, vendor renewals, audit/tax/insurance.
// ============================================================================
app.get('/api/calendar/events', async (req, res) => {
  try {
    const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to   = req.query.to   || new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);

    const { data: cycles } = await supabase
      .from('nomination_cycles')
      .select('id, community_name, annual_meeting_date, annual_meeting_time, annual_meeting_location, nominations_close_at, accept_electronic, accept_physical_mail, status, public_slug')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);

    function addDays(dateStr, delta) {
      if (!dateStr) return null;
      const dt = new Date(dateStr + 'T12:00:00');
      if (isNaN(dt.getTime())) return null;
      dt.setDate(dt.getDate() + delta);
      return dt.toISOString().slice(0, 10);
    }
    function addYear(dateStr) {
      if (!dateStr) return null;
      const dt = new Date(dateStr + 'T12:00:00');
      if (isNaN(dt.getTime())) return null;
      dt.setFullYear(dt.getFullYear() + 1);
      return dt.toISOString().slice(0, 10);
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const events = [];

    function emitCycleEvents(cycle, opts = {}) {
      const isProjected = !!opts.projected;
      const isDraft     = !!opts.draft;
      const meeting = cycle.annual_meeting_date;
      const close   = cycle.nominations_close_at || addDays(meeting, -24);
      const acceptPhysical = cycle.accept_physical_mail !== false;
      const sendByDays = acceptPhysical ? 21 : 14;
      const sendBy    = addDays(close, -sendByDays);
      const startPlan = addDays(sendBy, -14);

      const baseMeta = {
        community: cycle.community_name,
        cycle_id: cycle.id || null,
        public_slug: cycle.public_slug || null,
        is_projected: isProjected,
        is_draft: isDraft,
        draft_id: opts.draft_id || null,
      };
      const list = [
        { date: startPlan, type: 'start_to_plan',    label: 'Start to plan' },
        { date: sendBy,    type: 'send_by',          label: 'Send Call for Nominations' },
        { date: close,     type: 'nominations_close',label: 'Nominations close' },
        { date: meeting,   type: 'annual_meeting',   label: 'Annual meeting' },
      ];
      for (const ev of list) {
        if (!ev.date) continue;
        if (ev.date < from || ev.date > to) continue;
        events.push({ ...ev, ...baseMeta });
      }
    }

    // Group cycles by community + take the latest. Real if upcoming;
    // otherwise project next year.
    function commKey(name) { return String(name || '').split(' at ')[0].trim().toLowerCase(); }
    const latestByCommunity = {};
    for (const c of (cycles || []).sort((a, b) => (b.annual_meeting_date || '').localeCompare(a.annual_meeting_date || ''))) {
      const k = commKey(c.community_name);
      if (!latestByCommunity[k]) latestByCommunity[k] = c;
    }

    for (const cycle of Object.values(latestByCommunity)) {
      if (cycle.annual_meeting_date && cycle.annual_meeting_date >= todayStr) {
        emitCycleEvents(cycle);
      } else if (cycle.annual_meeting_date) {
        const projected = {
          ...cycle,
          annual_meeting_date: addYear(cycle.annual_meeting_date),
          nominations_close_at: null,
          cycle_id: null,
        };
        emitCycleEvents(projected, { projected: true });
      }
    }

    // Also emit events for any older cycle within range so historical
    // meetings still show up if the manager scrolls into the past.
    for (const c of cycles || []) {
      if (latestByCommunity[commKey(c.community_name)] === c) continue;
      if (!c.annual_meeting_date || c.annual_meeting_date < from || c.annual_meeting_date > to) continue;
      emitCycleEvents(c);
    }

    // Also emit events for any in-progress drafts that have a meeting date
    // saved in their state. This lets a manager "Save as draft" with partial
    // info and immediately see it on the calendar; clicking the chip will
    // reload the draft into the cycle form so they can finish.
    try {
      const { data: draftRows } = await supabase
        .from('drafts')
        .select('id, community_name, state')
        .eq('management_company_id', BEDROCK_MGMT_CO_ID)
        .eq('draft_type', 'nominations_cycle');
      for (const d of draftRows || []) {
        const s = d.state || {};
        if (!s.annual_meeting_date) continue;
        if (s.annual_meeting_date < from || s.annual_meeting_date > to) continue;
        emitCycleEvents({
          id: null,
          community_name: d.community_name || s.community_name || '(draft)',
          annual_meeting_date: s.annual_meeting_date,
          nominations_close_at: s.nominations_close_at || null,
          accept_electronic: s.accept_electronic !== false,
          accept_physical_mail: s.accept_physical_mail !== false,
        }, { draft: true, draft_id: d.id });
      }
    } catch (e) {
      console.warn('[calendar/events] drafts query failed:', e.message);
    }

    res.json({ events });
  } catch (err) {
    console.error('[calendar/events]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 📊 Performance — SLA metrics across customer-facing touchpoints.
//   GET /api/performance/acc?days=30  → ACC application response-time metrics
//
// Reads from community_applications. Computes: open queue, median / avg / p90
// response time, oldest pending, throughput, by-community breakdown.
// Tracking timing data only — submitted_at + final_decided_at — never
// exhaustive behavioral profiles (per the customer-obsession memory).
// ============================================================================
function _percentile(sortedAsc, p) {
  if (!sortedAsc || sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

app.get('/api/performance/acc', async (req, res) => {
  try {
    const windowDays = Math.max(1, Math.min(365, parseInt(req.query.days || '30', 10)));
    const since = new Date(Date.now() - windowDays * 86400000).toISOString();

    // Pull all ARC apps in the window + currently open ones, regardless of date.
    const { data: apps, error } = await supabase
      .from('community_applications')
      .select('id, community_id, reference_number, service_type, final_status, submitted_at, final_decided_at, property_address, submitter_name, communities:community_id(name)')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .eq('service_type', 'arc')
      .order('submitted_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const today = Date.now();
    const dayMs = 86400000;
    const isClosed = (s) => ['approved','denied','withdrawn','closed'].includes(s);

    const all = apps || [];
    // Response times (days) for apps decided in window
    const responseTimes = [];
    let throughputCount = 0;
    for (const a of all) {
      if (!a.submitted_at || !a.final_decided_at) continue;
      if (a.final_decided_at < since) continue;
      if (!isClosed(a.final_status)) continue;
      const t = (new Date(a.final_decided_at) - new Date(a.submitted_at)) / dayMs;
      if (t >= 0) {
        responseTimes.push(t);
        throughputCount += 1;
      }
    }
    responseTimes.sort((a, b) => a - b);
    const median = _percentile(responseTimes, 50);
    const p90    = _percentile(responseTimes, 90);
    const avg    = responseTimes.length ? responseTimes.reduce((s, v) => s + v, 0) / responseTimes.length : null;

    // Pending queue
    const openApps = all.filter((a) => !isClosed(a.final_status) && a.submitted_at);
    openApps.sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));
    const oldestPending = openApps[0] || null;
    const oldestPendingDays = oldestPending ? Math.round((today - new Date(oldestPending.submitted_at)) / dayMs) : null;

    // By-community breakdown
    const byCommName = {};
    for (const a of all) {
      const name = (a.communities && a.communities.name) || 'Unknown';
      if (!byCommName[name]) byCommName[name] = { name, open: 0, closed_in_window: 0, response_times: [] };
      const bucket = byCommName[name];
      if (!isClosed(a.final_status) && a.submitted_at) bucket.open += 1;
      if (a.submitted_at && a.final_decided_at && a.final_decided_at >= since && isClosed(a.final_status)) {
        const t = (new Date(a.final_decided_at) - new Date(a.submitted_at)) / dayMs;
        if (t >= 0) {
          bucket.response_times.push(t);
          bucket.closed_in_window += 1;
        }
      }
    }
    const byCommunity = Object.values(byCommName).map((b) => {
      const sorted = b.response_times.slice().sort((a, c) => a - c);
      return {
        name: b.name,
        open: b.open,
        throughput: b.closed_in_window,
        median: _percentile(sorted, 50),
        avg: sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : null,
      };
    }).sort((a, b) => (b.open - a.open) || a.name.localeCompare(b.name));

    res.json({
      window_days: windowDays,
      open_count: openApps.length,
      throughput: throughputCount,
      median_response_days: median,
      avg_response_days: avg,
      p90_response_days: p90,
      oldest_pending: oldestPending ? {
        id: oldestPending.id,
        community: (oldestPending.communities && oldestPending.communities.name) || null,
        reference_number: oldestPending.reference_number,
        property_address: oldestPending.property_address,
        submitter_name: oldestPending.submitter_name,
        submitted_at: oldestPending.submitted_at,
        days_pending: oldestPendingDays,
      } : null,
      pending: openApps.slice(0, 25).map((a) => ({
        id: a.id,
        community: (a.communities && a.communities.name) || null,
        reference_number: a.reference_number,
        property_address: a.property_address,
        submitter_name: a.submitter_name,
        submitted_at: a.submitted_at,
        days_pending: Math.round((today - new Date(a.submitted_at)) / dayMs),
        final_status: a.final_status,
      })),
      by_community: byCommunity,
    });
  } catch (err) {
    console.error('[performance/acc]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Auth — client-side bootstrap config.
// Exposes the Supabase public URL + anon key so the browser can initialize
// Supabase Auth. Both values are designed for public exposure (the anon key
// is the "anon" key on purpose; service-role stays server-only).
// ============================================================================
app.get('/api/auth/config', (req, res) => {
  // Two-key safety: auth is only "live" when BOTH SUPABASE_ANON_KEY is set
  // AND AUTH_REQUIRED is truthy. This means setting the anon key alone (e.g.,
  // mid-weekend setup) doesn't lock the team out — auth stays dormant until
  // Ed explicitly flips AUTH_REQUIRED=1 on Render. Unset AUTH_REQUIRED in an
  // emergency and the app reverts to legacy/unauthenticated.
  const hasKeys = !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
  const required = String(process.env.AUTH_REQUIRED || '').match(/^(1|true|yes)$/i);
  res.json({
    supabase_url: process.env.SUPABASE_URL || '',
    supabase_anon_key: process.env.SUPABASE_ANON_KEY || '',
    enabled: !!(hasKeys && required),
  });
});

// ============================================================================
// /api/maps/config — Mapbox public token for the inspection map view.
// Reads MAPBOX_TOKEN from env (a public pk.* token). Server-side surface
// means the token lives in env, not in committed code; rotating the token
// is an env-var change with no redeploy needed. If MAPBOX_TOKEN isn't set
// the map view shows a friendly "map not configured" state instead of
// failing silently.
// ============================================================================
app.get('/api/maps/config', (req, res) => {
  const token = process.env.MAPBOX_TOKEN || '';
  res.json({
    enabled: !!token,
    mapbox_token: token,
    // Default map center for Bedrock's service area — Sugar Land, TX. Used
    // when no community is selected yet so the map opens to something
    // useful instead of staring at the Atlantic.
    default_center_lng: -95.6347,
    default_center_lat: 29.5994,
    default_zoom: 11,
  });
});

// ============================================================================
// /api/me — current user profile (role + identity) for the signed-in user.
// Accepts the Supabase JWT in Authorization: Bearer <token>; if missing or
// invalid, returns 401. Read-only — UI uses this for the "Signed in as X"
// pill and to gate admin-only controls client-side.
// ============================================================================
app.get('/api/me', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'not_authenticated' });

    // Validate by asking Supabase who this token belongs to.
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'invalid_token' });

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('id, email, full_name, role, is_active, last_sign_in_at, created_at')
      .eq('id', user.id)
      .maybeSingle();
    if (!profile) return res.json({ user: { id: user.id, email: user.email, full_name: null, role: 'staff', is_active: true, last_sign_in_at: null } });
    res.json({ user: profile });
  } catch (err) {
    console.error('[/api/me]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Voice — Twilio webhook routes + WebSocket bridge for Claire (Bedrock's voice persona).
// See lib/voice/README.md for architecture, lib/voice/persona.js for the
// Claire opener + handoff phrasing, and templates/responder-engine.spec.md §5
// for the design rationale.
// ============================================================================
const { router: voiceRouter, handleWebSocketConnection: handleVoiceWs } = require('./api/voice');
app.use('/api/voice', voiceRouter);

// Create the HTTP server explicitly so we can attach a WebSocket upgrade
// handler for the Twilio Media Streams path.
const http = require('http');
const { WebSocketServer } = require('ws');
const httpServer = http.createServer(app);
const voiceWss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  // Only intercept the voice WS path; everything else gets dropped
  // (we don't have any other WS endpoints today).
  const pathname = req.url ? req.url.split('?')[0] : '';
  if (pathname === '/api/voice/stream') {
    voiceWss.handleUpgrade(req, socket, head, (ws) => {
      handleVoiceWs(ws, req);
    });
  } else {
    socket.destroy();
  }
});

httpServer.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
  console.log('Voice WebSocket bridge ready at /api/voice/stream');
  try {
    const { startScheduler } = require('./lib/scheduler');
    startScheduler();
  } catch (e) {
    console.error('[scheduler] failed to start:', e.message);
  }
});