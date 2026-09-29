#!/usr/bin/env node
// ============================================================================
// scripts/visual_snapshot.js  (Issue #6, 2026-09-29)
// ----------------------------------------------------------------------------
// Visual QA harness for the Trusted app pages. Serves public/ from a throwaway
// local static server (no app server, no database, no login) and renders each
// page in fixture mode (sample data) at desktop, laptop, tablet and phone
// widths. Fails if the page throws, logs a console error, or scrolls sideways.
// Screenshots land in visual-snapshots/ (git-ignored) for review against the
// v3 design reference.
//
//   node scripts/visual_snapshot.js            all pages, all widths
//   node scripts/visual_snapshot.js today      one page (by name)
//
// Add a page: put it under public/app/, give it a fixture in
// public/app/fixtures/, and add it to PAGES below ({ name, path }).
// ============================================================================
const path = require('path');
const fs = require('fs');

const PAGES = [
  { name: 'today', path: '/app/today.html?fixture=1' },
  { name: 'communities', path: '/app/communities.html?fixture=1' },
  { name: 'community', path: '/app/community.html?fixture=1&id=00000000-0000-4000-8000-00000000000b' },
  { name: 'community-ready', path: '/app/community.html?fixture=1&id=00000000-0000-4000-8000-00000000000a' },
  { name: 'community-leaving', path: '/app/community.html?fixture=1&id=00000000-0000-4000-8000-00000000000d' },
  { name: 'financial', path: '/app/financial.html?fixture=1' },
  { name: 'operations', path: '/app/operations.html?fixture=1' },
  { name: 'owners', path: '/app/owners.html?fixture=1' },
  { name: 'owners-search', path: '/app/owners.html?fixture=1&q=sample' },
];
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
  const express = require('express');
  const only = process.argv[2];
  const pages = only ? PAGES.filter((p) => p.name === only) : PAGES;
  if (!pages.length) { console.error('unknown page', only); process.exit(2); }
  fs.mkdirSync(OUT, { recursive: true });

  // Static server for public/ only; bound to localhost on a random port.
  const app = express();
  app.use(express.static(path.join(ROOT, 'public')));
  const server = await new Promise((resolve) => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
  const base = 'http://127.0.0.1:' + server.address().port;

  const browser = await puppeteer.launch({ headless: 'new' });
  let failures = 0;
  try {
    for (const pg of pages) {
      for (const w of WIDTHS) {
        const page = await browser.newPage();
        const problems = [];
        page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
        // 'Failed to load resource' is covered, with its URL, by the response check below.
        page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|supabase|Failed to load resource/i.test(m.text())) problems.push('console: ' + m.text()); });
        page.on('requestfailed', (r) => { if (r.url().startsWith(base)) problems.push('missing asset: ' + r.url().slice(base.length)); });
        page.on('response', (r) => { if (r.url().startsWith(base) && r.status() >= 400 && !r.url().endsWith('/favicon.ico')) problems.push(`HTTP ${r.status()}: ${r.url().slice(base.length)}`); });
        await page.setViewport({ width: w.width, height: w.height });
        await page.goto(base + pg.path, { waitUntil: 'networkidle0', timeout: 45000 });
        await page.evaluate(() => document.fonts && document.fonts.ready);
        await new Promise((r) => setTimeout(r, 300));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 1) problems.push('horizontal scroll: ' + overflow + 'px wider than the viewport');
        const shot = path.join(OUT, `${pg.name}-${w.name}.png`);
        await page.screenshot({ path: shot, fullPage: true });
        await page.close();
        if (problems.length) { failures += 1; console.error(`FAIL ${pg.name} @ ${w.name}\n  ` + problems.join('\n  ')); }
        else console.log(`ok   ${pg.name} @ ${w.name} → ${path.relative(ROOT, shot)}`);
      }
    }
  } finally { await browser.close(); server.close(); }
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('visual_snapshot failed:', e.message); process.exit(1); });
