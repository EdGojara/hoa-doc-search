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
// 2026-05-31 brand refresh — three-division architecture:
//   BRAND.parent  = Bedrock (master brand, corporate/website use)
//   BRAND.service = Bedrock Association Management (BAM) — the management firm
//   BRAND.tech    = Bedrock Intelligence (BI)            — the technology arm,
//                   which builds + ships trustEd
//
// Master mark: a gold "B" letterform with stepped-column internals — captures
// "bedrock = foundation + structure" without being heavy-handed. Heritage Gold
// (#D4AF37) preserved from the previous brand so all existing customer
// recognition equity carries forward.
//
// =============================================================================

const BRAND = Object.freeze({
  // ---------------------------------------------------------------------------
  // Parent brand — Bedrock (the master entity). Use on website, corporate
  // marketing material, press, deck title slides. The three divisions
  // (BAM, BI, trustEd) ladder up to this.
  // ---------------------------------------------------------------------------
  parent: Object.freeze({
    name: 'Bedrock',
    descriptor: 'Built on a foundation of trust.',
    longTagline: 'Built on a foundation of trust. Driven by clarity. Powered by intelligence.',
    pillars: ['Trust', 'Clarity', 'Intelligence'],
    pillarsUpper: 'TRUST · CLARITY · INTELLIGENCE',
    threeDivisionsUpper: 'ONE BRAND. THREE DIVISIONS. ENDLESS POSSIBILITIES.',
  }),

  // ---------------------------------------------------------------------------
  // Service side — Bedrock Association Management (the management firm)
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
  // Technology side — Bedrock Intelligence (ships trustEd)
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
  // Color tokens — 2026-05-31 refresh.
  //   Heritage Gold (#D4AF37) preserved exactly to retain recognition equity.
  //   Deep Navy shifted slightly cooler (#0B1424 → #0B1D34) per the new
  //     brand guidelines.
  //   Stone (#6B7280) and Light Gray (#F2F4F7) introduced as new tertiary
  //     surface tokens. Use Stone for muted UI text on light backgrounds and
  //     Light Gray for low-contrast surface fills.
  // ---------------------------------------------------------------------------
  colors: Object.freeze({
    navy: '#0B1D34',          // primary deep navy — wordmark + dark surfaces
    navyDeep: '#0B1D34',      // alias retained for backward-compat callers
    navySoft: '#142A4A',      // softer navy for cards/panels on navy bg
    gold: '#D4AF37',          // Heritage Gold — unchanged from prior brand
    goldBright: '#e8c96e',    // hover/highlight gold
    stone: '#6B7280',         // muted UI text on light bg, secondary labels
    lightGray: '#F2F4F7',     // subtle surface fill, light card bg
    ink: '#e8ecf3',           // primary text on DARK bg
    inkSoft: '#a8b2c4',       // secondary text on dark bg
    inkFaint: '#5a6680',      // tertiary/labels on dark bg
    cream: '#F2F4F7',         // BAM background, light body (alias of lightGray)
    grey: '#6B7280',          // legacy alias for Stone
    rule: 'rgba(232, 236, 243, 0.08)',
    ruleStrong: 'rgba(232, 236, 243, 0.16)',
  }),

  // ---------------------------------------------------------------------------
  // Typography — 2026-05-31 refresh.
  //   Cormorant family replaces Playfair Display for the serif. Semibold is
  //   the canonical wordmark weight; Garamond style with refined letterforms.
  //   Inter (sans) and JetBrains Mono (mono) retained.
  // ---------------------------------------------------------------------------
  fonts: Object.freeze({
    serif: "'Cormorant Garamond', 'Playfair Display', Georgia, 'Times New Roman', serif",
    sans: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    mono: "'JetBrains Mono', ui-monospace, monospace",
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
  }),

  // ---------------------------------------------------------------------------
  // Logo / mark file paths under /public/brand-assets/
  // ---------------------------------------------------------------------------
  logos: Object.freeze({
    fullLockup:     '/brand-assets/bedrock-lockup.svg',      // B-mark + BEDROCK wordmark, horizontal
    markEmail1x:    '/brand-assets/bedrock-mark-email-1x.png', // raster fallback for email clients
    markEmail2x:    '/brand-assets/bedrock-mark-email-2x.png',
    // Legacy aliases — older callers reference these keys; point at the new lockup
    bamFull:        '/brand-assets/bedrock-lockup.svg',
    bamMinimal:     '/brand-assets/bedrock-lockup.svg',
  }),

  // ---------------------------------------------------------------------------
  // Cornerstone mark — the new "B" letterform with stepped-column internals.
  // Inline SVG so it ships in every PDF / email without an external fetch.
  // Scales cleanly from favicon size (16px) up to letterhead hero (200px+).
  // ---------------------------------------------------------------------------

  /**
   * Renders the Bedrock B master mark. Returns an <img> tag referencing the
   * designer-produced SVG at /brand-assets/bedrock-mark.svg — the canonical
   * mark. The SVG is cached by the browser after first fetch and embeds
   * cleanly into puppeteer-rendered PDFs.
   *
   * The `opts.fill` / `opts.cutout` parameters are accepted for backward
   * compatibility but ignored — the master mark is gold-on-transparent and
   * works on any background.
   *
   * @param {object} [opts]
   * @param {number} [opts.height=36] - height in px
   * @param {string} [opts.label='Bedrock mark']
   * @returns {string} HTML-safe markup
   */
  cornerstoneSvg(opts = {}) {
    const height = opts.height || 36;
    const label = opts.label || 'Bedrock mark';
    return `<img src="/brand-assets/bedrock-mark.svg" alt="${label}" style="height:${height}px; width:auto; display:inline-block; vertical-align:middle;">`;
  },

  /**
   * Inline-SVG fallback version of the B mark — used by surfaces where
   * external <img> fetching isn't reliable (some email clients, embedded
   * preview cards). Hand-drawn approximation of the master mark; not
   * pixel-perfect, but readable as the brand at small sizes.
   * @param {object} [opts] same shape as cornerstoneSvg
   */
  cornerstoneInlineSvg(opts = {}) {
    const fill = opts.fill || this.colors.gold;
    const cutout = opts.cutout || this.colors.navy;
    const height = opts.height || 36;
    const width = Math.round(height * 0.77);
    const label = opts.label || 'Bedrock mark';
    return `<svg viewBox="0 0 100 130" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" aria-label="${label}">
  <g fill="${fill}">
    <path d="M 10 6 H 60 C 75 6 85 18 85 35 C 85 52 75 64 60 64 H 24 V 6 Z M 10 64 H 65 C 80 64 90 76 90 95 C 90 114 80 126 65 126 H 10 Z"/>
  </g>
  <g fill="${cutout}">
    <rect x="34" y="16" width="6" height="36"/>
    <rect x="46" y="12" width="6" height="40"/>
    <rect x="58" y="16" width="6" height="36"/>
    <rect x="34" y="76" width="6" height="40"/>
    <rect x="46" y="72" width="6" height="44"/>
    <rect x="58" y="76" width="6" height="40"/>
  </g>
</svg>`;
  },

  // ---------------------------------------------------------------------------
  // Pre-rendered HTML lockups for the most common surfaces. The system has
  // three named lockups (parent / service / tech) per the 2026-05-31 brand
  // architecture; each renderer picks the lockup matching its audience.
  // ---------------------------------------------------------------------------

  /**
   * Parent-brand vertical lockup — for corporate/marketing surfaces.
   * Mark above "BEDROCK" wordmark in serif + the three-pillar strapline.
   */
  parentLockupVertical() {
    return `<div class="bedrock-lockup-vertical" style="display:flex; flex-direction:column; align-items:center; gap:14px;">
  ${this.cornerstoneSvg({ height: 72 })}
  <div style="font-family:${this.fonts.serif}; font-weight:600; font-size:32px; letter-spacing:0.04em; color:#fff; line-height:1;">
    BEDROCK
  </div>
  <div style="font-family:${this.fonts.sans}; font-size:11px; letter-spacing:0.18em; color:${this.colors.gold}; text-transform:uppercase;">
    ${this.parent.pillarsUpper}
  </div>
</div>`;
  },

  /**
   * Tech-side vertical lockup — Bedrock Intelligence + trustEd product.
   * Use for login screens, deck title slides, app loading screens.
   */
  techLockupVertical() {
    return `<div class="bi-lockup-vertical">
  ${this.cornerstoneSvg({ height: 64 })}
  <div class="bi-wordmark" style="font-family:${this.fonts.serif}; font-size:24px; font-weight:600; color:var(--ink, ${this.colors.ink}); margin-top:14px; letter-spacing:0.02em;">
    BEDROCK <span style="color:${this.colors.gold};">INTELLIGENCE</span>
  </div>
  <div class="bi-tagline" style="margin-top:6px; font-family:${this.fonts.sans}; font-size:11px; letter-spacing:0.16em; color:var(--ink-faint, ${this.colors.inkFaint}); text-transform:uppercase;">
    ${this.tech.product} · ${this.tech.productDescriptor}
  </div>
</div>`;
  },

  /**
   * Tech-side horizontal lockup — cornerstone left of wordmark.
   * Use for app top nav, header bars, email signatures.
   */
  techLockupHorizontal(opts = {}) {
    const productLine = opts.includeProduct !== false
      ? `<div class="bi-product-line" style="font-family:${this.fonts.sans}; font-size:11px; color:var(--ink-faint, ${this.colors.inkFaint}); letter-spacing:0.10em; text-transform:uppercase; margin-top:3px;">
           ${this.tech.product} · ${this.tech.productDescriptor}
         </div>`
      : '';
    return `<div class="bi-lockup-horizontal" style="display:flex; align-items:center; gap:14px;">
  ${this.cornerstoneSvg({ height: 40 })}
  <div>
    <div class="bi-wordmark" style="font-family:${this.fonts.serif}; font-size:20px; font-weight:600; line-height:1.1; color:var(--ink, ${this.colors.ink}); letter-spacing:0.02em;">
      BEDROCK <span style="color:${this.colors.gold};">INTELLIGENCE</span>
    </div>
    ${productLine}
  </div>
</div>`;
  },

  /**
   * Service-side horizontal lockup — Bedrock Association Management.
   * Use for homeowner letters, board correspondence, BAM letterhead.
   */
  serviceLockupHorizontal() {
    return `<div class="bam-lockup-horizontal" style="display:flex; align-items:center; gap:14px;">
  ${this.cornerstoneSvg({ height: 40, cutout: '#FFFFFF' })}
  <div>
    <div class="bam-wordmark" style="font-family:${this.fonts.serif}; font-size:20px; font-weight:600; line-height:1.1; color:${this.colors.navy}; letter-spacing:0.02em;">
      BEDROCK <span style="color:${this.colors.gold};">ASSOCIATION MANAGEMENT</span>
    </div>
    <div class="bam-tagline" style="font-family:${this.fonts.mono}; font-size:10px; color:${this.colors.stone}; letter-spacing:0.18em; text-transform:uppercase; margin-top:3px;">
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

// Export the BRAND object as the default AND expose it as a named property
// on the same export. This way both import styles work:
//   const BRAND = require('./lib/brand');         (3+ callers — server.js etc.)
//   const { BRAND } = require('./lib/brand');     (4 callers — meeting_checkin,
//                                                  violation_letter, ar_reminder,
//                                                  postcard_reminder)
// Without the named-property exposure, the destructured callers got undefined
// and any access like BRAND.service crashed (Canyon Gate meeting-finalize HTTP
// 500, 2026-06-04). The dual-form export defends against the next caller
// guessing the wrong style without having to grep every renderer.
module.exports = BRAND;
module.exports.BRAND = BRAND;
