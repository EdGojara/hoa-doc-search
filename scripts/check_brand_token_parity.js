#!/usr/bin/env node
// ============================================================================
// scripts/check_brand_token_parity.js  (Issue #6 review, 2026-09-29)
// ----------------------------------------------------------------------------
// The Trusted product tokens live in public/brand.css (--tx-*) and are mirrored
// in lib/brand.js (productColors). Two hand-kept copies drift silently, so this
// FAILS `npm test` when they disagree: every hex/rgba --tx-* colour in
// brand.css must exist in productColors with the same value, and vice versa.
// Name mapping: --tx-gold-ink <-> goldInk, --tx-console-bg <-> consoleBg, etc.
// Non-colour tokens (--tx-radius, --tx-shadow) are CSS-only and skipped.
// ============================================================================
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'brand.css'), 'utf8');
const brand = require('../lib/brand.js');
const product = brand.productColors || (brand.default && brand.default.productColors);
if (!product) { console.error('✗ lib/brand.js has no productColors'); process.exit(1); }

const camel = (s) => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const cssTokens = {};
for (const m of css.matchAll(/--tx-([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
  const val = m[2].trim();
  if (/^(#[0-9a-f]{3,8}|rgba?\()/i.test(val)) cssTokens[camel(m[1])] = val.toUpperCase().replace(/\s+/g, '');
}

const problems = [];
for (const [k, v] of Object.entries(cssTokens)) {
  if (!(k in product)) problems.push(`brand.css --tx-${k} (${v}) missing from lib/brand.js productColors`);
  else if (String(product[k]).toUpperCase().replace(/\s+/g, '') !== v) problems.push(`${k}: brand.css ${v} vs lib/brand.js ${product[k]}`);
}
for (const k of Object.keys(product)) if (!(k in cssTokens)) problems.push(`lib/brand.js productColors.${k} has no --tx- token in brand.css`);

if (problems.length) {
  console.error('✗ Brand token parity failed (public/brand.css vs lib/brand.js):\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`✓ Brand token parity: ${Object.keys(cssTokens).length} --tx-* colours match lib/brand.js productColors.`);
