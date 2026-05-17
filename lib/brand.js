// =============================================================================
// lib/brand.js — Bedrock brand single source of truth (server-side)
// =============================================================================
//
// To rebrand the entire system: edit this file. Every PDF, email subject,
// generated letter, server-rendered HTML page reads from BRAND.
//
// Frontend equivalent: public/brand.css (color/font tokens as CSS variables
// and reusable wordmark/cornerstone classes). When you change colors here,
// update them in public/brand.css too.
//
// Two brands live under this roof:
//   BRAND.service = Bedrock Association Management (BAM) — the management firm
//   BRAND.tech    = Bedrock Intelligence (BI)            — the technology arm,
//                   which builds + ships trustEd
//
// =============================================================================

const BRAND = Object.freeze({
  // ---------------------------------------------------------------------------
  // Service side — Bedrock Association Management
  // Use on: homeowner correspondence, board letters, budgets, estoppels,
  // coupon books, ARC decision letters, vendor RFPs (when issued on behalf
  // of the management firm), invoices.
  // ---------------------------------------------------------------------------
  service: Object.freeze({
    legal: 'Bedrock Association Management, LLC',
    name: 'Bedrock Association Management',
    short: 'Bedrock',
    descriptor: 'Association Management',
    tagline: 'Community. Simplified.',
    taglineUpper: 'COMMUNITY. SIMPLIFIED.',
    city: 'Sugar Land, Texas',
    cityShort: 'Sugar Land, TX',
    serviceArea: 'Houston-area HOAs',
    // Mailing address — used on letters, envelopes, contracts, footers.
    // Canonical format: "12808 W Airport Blvd, Ste 253, Sugar Land, TX 77478"
    // Confirmed against migration 007_bedrock_address_suite.sql which calls
    // this address out as the management firm's mailing address.
    address: '12808 W Airport Blvd, Ste 253',
    addressCityStateZip: 'Sugar Land, TX 77478',
    addressInline: '12808 W Airport Blvd, Ste 253, Sugar Land, TX 77478',
    phone: '(832) 588-2485',
    phoneRaw: '8325882485',
    email: 'info@bedrocktx.com',
    website: 'bedrocktx.com',
    websiteUrl: 'https://bedrocktx.com',
  }),

  // ---------------------------------------------------------------------------
  // Technology side — Bedrock Intelligence
  // Use on: trustEd app UI, login screens, board pitch decks, vendor
  // benchmarking output, anything that's product-of-Bedrock-Intelligence.
  // ---------------------------------------------------------------------------
  tech: Object.freeze({
    name: 'Bedrock Intelligence',
    short: 'Bedrock Intelligence',
    descriptor: 'Intelligence',
    product: 'trustEd',
    productDescriptor: 'operations platform',
    productSubtitle: 'A Bedrock Intelligence platform',
    tagline: 'Calm in the chaos.',
    taglineUpper: 'CALM IN THE CHAOS',
    website: 'bedrocktxai.com',
    websiteUrl: 'https://bedrocktxai.com',
    appUrl: 'https://app.bedrocktxai.com',
  }),

  // ---------------------------------------------------------------------------
  // Color tokens — match the canonical brand assets in C:\Users\edget\bedrock-brand\
  // ---------------------------------------------------------------------------
  colors: Object.freeze({
    navy: '#1A3050',          // primary body navy (BAM wordmark)
    navyDeep: '#0B1424',      // deep navy (BI bg, dark mode)
    navySoft: '#142847',      // softer navy for cards on dark bg
    gold: '#D4AF37',          // primary gold (mark, accents)
    goldBright: '#e8c96e',    // hover/highlight gold
    ink: '#e8ecf3',           // body text on dark bg
    inkSoft: '#a8b2c4',       // secondary text on dark bg
    inkFaint: '#5a6680',      // tertiary/labels on dark bg
    cream: '#F2F2F2',         // BAM background, light body
    grey: '#8B8F97',          // tagline grey
    rule: 'rgba(232, 236, 243, 0.08)',
    ruleStrong: 'rgba(232, 236, 243, 0.16)',
  }),

  // ---------------------------------------------------------------------------
  // Typography — Playfair Display serif + Inter sans + JetBrains Mono mono.
  // Google Fonts <link> for any page:
  //   https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600;1,400&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap
  // ---------------------------------------------------------------------------
  fonts: Object.freeze({
    serif: "'Playfair Display', Georgia, 'Times New Roman', serif",
    sans: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    mono: "'JetBrains Mono', ui-monospace, monospace",
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600;1,400&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
  }),

  // ---------------------------------------------------------------------------
  // Cornerstone mark — three stacked trapezoidal segments, the universal
  // Bedrock symbol that bridges the BAM and BI lockups.
  // ---------------------------------------------------------------------------

  /**
   * Inline SVG of the cornerstone mark. Drop into any HTML or PDF.
   * @param {object} [opts]
   * @param {string} [opts.fill='#D4AF37'] - fill color (gold by default)
   * @param {number} [opts.height=36]      - height in px; width auto-scales to match aspect
   * @param {string} [opts.label='Bedrock cornerstone mark']
   * @returns {string} HTML-safe SVG
   */
  cornerstoneSvg(opts = {}) {
    const fill = opts.fill || this.colors.gold;
    const height = opts.height || 36;
    const width = Math.round(height * 0.8);  // 88/110 aspect
    const label = opts.label || 'Bedrock cornerstone mark';
    return `<svg viewBox="0 0 88 110" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" aria-label="${label}">
  <polygon points="0,0 88,0 84,28 4,28" fill="${fill}"/>
  <polygon points="5,34 83,34 78,68 10,68" fill="${fill}"/>
  <polygon points="11,74 77,74 73,110 15,110" fill="${fill}"/>
</svg>`;
  },

  // ---------------------------------------------------------------------------
  // Pre-rendered HTML lockups for the most common surfaces. These wrap
  // the cornerstone + wordmark + tagline in a standard structure so every
  // surface looks identical with one helper call.
  // ---------------------------------------------------------------------------

  /**
   * The Bedrock Intelligence vertical lockup — cornerstone above wordmark.
   * Use for login screens, deck title slides, app loading screens.
   * Returns HTML; expects body bg to be navy-deep and to have brand.css loaded
   * (or equivalent --gold / --ink / --ink-faint CSS vars defined).
   */
  techLockupVertical() {
    return `<div class="bi-lockup-vertical">
  ${this.cornerstoneSvg({ height: 64 })}
  <div class="bi-wordmark" style="font-size:22px; color:var(--ink, ${this.colors.ink}); margin-top:14px;">
    Bedrock <em>Intelligence</em>
  </div>
  <div class="bi-tagline" style="margin-top:6px;">
    ${this.tech.taglineUpper}
  </div>
</div>`;
  },

  /**
   * The Bedrock Intelligence horizontal lockup — cornerstone left of wordmark.
   * Use for app top nav, header bars, email signatures.
   */
  techLockupHorizontal(opts = {}) {
    const productLine = opts.includeProduct !== false
      ? `<div class="bi-product-line" style="font-size:11px; color:var(--ink-faint, ${this.colors.inkFaint}); letter-spacing:0.08em; text-transform:uppercase; margin-top:3px;">
           ${this.tech.product} · ${this.tech.productDescriptor}
         </div>`
      : '';
    return `<div class="bi-lockup-horizontal" style="display:flex; align-items:center; gap:14px;">
  ${this.cornerstoneSvg({ height: 36 })}
  <div>
    <div class="bi-wordmark" style="font-size:19px; line-height:1.1; color:var(--ink, ${this.colors.ink});">
      Bedrock <em>Intelligence</em>
    </div>
    ${productLine}
  </div>
</div>`;
  },

  /**
   * The Bedrock Association Management horizontal lockup — cream/light treatment.
   * Use for homeowner letters, board correspondence, anything BAM-branded.
   */
  serviceLockupHorizontal() {
    return `<div class="bam-lockup-horizontal" style="display:flex; align-items:center; gap:14px;">
  ${this.cornerstoneSvg({ height: 36, fill: this.colors.gold })}
  <div>
    <div class="bam-wordmark" style="font-family:${this.fonts.serif}; font-size:19px; font-weight:500; line-height:1.1; color:${this.colors.navy}; letter-spacing:-0.01em;">
      Bedrock <em style="font-style:italic; color:${this.colors.gold}; font-weight:500;">Association Management</em>
    </div>
    <div class="bam-tagline" style="font-family:${this.fonts.mono}; font-size:10px; color:${this.colors.grey}; letter-spacing:0.18em; text-transform:uppercase; margin-top:3px;">
      ${this.service.taglineUpper}
    </div>
  </div>
</div>`;
  },

  // ---------------------------------------------------------------------------
  // Email + document footers — pre-formatted multi-line strings for plaintext.
  // ---------------------------------------------------------------------------

  /**
   * Plaintext signature block for BAM email/letter footers.
   * Returns multi-line string ready to drop into a template literal.
   */
  serviceEmailSignature() {
    return `${this.service.name}
${this.service.city}
${this.service.phone}
${this.service.email}
${this.service.website}`;
  },

  /**
   * Plaintext signature block for BI / trustEd product correspondence.
   */
  techEmailSignature() {
    return `${this.tech.name}  —  ${this.tech.product}
${this.tech.website}
${this.service.phone}`;
  },
});

module.exports = BRAND;
