#!/usr/bin/env node
// ============================================================================
// scripts/visual_snapshot.js  (Issue #6, 2026-09-29)
// ----------------------------------------------------------------------------
// Visual QA harness for the Trusted app pages. Renders each page from disk in
// fixture mode (sample data, no server, no login) at desktop, laptop, tablet
// and phone widths, and fails if the page throws, logs a console error, or
// scrolls sideways. Screenshots land in visual-snapshots/ (git-ignored) for
// review against the v3 design reference.
//
//   node scripts/visual_snapshot.js            all pages, all widths
//   node scripts/visual_snapshot.js today      one page
//
// Add a page: put it under public/app/, give it a fixture in
// public/app/fixtures/<name>.fixture.js, and add it to PAGES below.
// ============================================================================
const path = require('path');
const fs = require('fs');

const PAGES = ['today'];
const WIDTHS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1280, height: 720 },
  { name: 'tablet', width: 1024, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'visual-snapshots');

(async () => {
  const puppeteer = require('puppeteer');
  const only = process.argv[2];
  const pages = only ? PAGES.filter((p) => p === only) : PAGES;
  if (!pages.length) { console.error('unknown page', only); process.exit(2); }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ headless: 'new' });
  let failures = 0;
  try {
    for (const name of pages) {
      const file = path.join(ROOT, 'public', 'app', name + '.html');
      for (const w of WIDTHS) {
        const page = await browser.newPage();
        const problems = [];
        page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
        page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|supabase/i.test(m.text())) problems.push('console: ' + m.text()); });
        await page.setViewport({ width: w.width, height: w.height });
        await page.goto('file:///' + file.replace(/\\/g, '/') + '?fixture=1', { waitUntil: 'networkidle0', timeout: 45000 });
        await page.evaluate(() => document.fonts && document.fonts.ready);
        await new Promise((r) => setTimeout(r, 300));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 1) problems.push('horizontal scroll: ' + overflow + 'px wider than the viewport');
        const shot = path.join(OUT, `${name}-${w.name}.png`);
        await page.screenshot({ path: shot, fullPage: true });
        await page.close();
        if (problems.length) { failures += 1; console.error(`FAIL ${name} @ ${w.name}\n  ` + problems.join('\n  ')); }
        else console.log(`ok   ${name} @ ${w.name} → ${path.relative(ROOT, shot)}`);
      }
    }
  } finally { await browser.close(); }
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('visual_snapshot failed:', e.message); process.exit(1); });
