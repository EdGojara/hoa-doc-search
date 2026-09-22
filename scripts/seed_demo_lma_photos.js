#!/usr/bin/env node
/**
 * seed_demo_lma_photos.js — sample field-photo evidence for the Sterling Ridge
 * DEMO tenant, so the board can see the physical-asset photo/history experience
 * without live field photos. Reuses the EXISTING asset-evidence primitive:
 * images go to the 'documents' storage bucket (same as violation + report
 * photos) and each is a board_map_reports row tied to community_asset_id +
 * related_project_id (mig 445). Photo TYPE rides the caption convention
 * ("PROGRESS · note") until a first-class photo_type column lands.
 *
 * The images are ORIGINAL, clearly-labelled "DEMO SAMPLE" stylised scenes — not
 * real CLMA photographs. Idempotent (stable ids + upsert). DEMO tenant only.
 *
 *   node scripts/seed_demo_lma_photos.js --execute
 */
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const EXECUTE = process.argv.includes('--execute');
const LMA = 'e0100000-0000-4000-a000-000000000000';
const E = (n) => `e011${String(n).padStart(4, '0')}-0000-4000-a000-000000000000`; // asset (geography seed order)
const P = (n) => `e017${String(n).padStart(4, '0')}-0000-4000-a000-000000000000`; // project (ops seed order)
const duid = (k) => { const h = crypto.createHash('md5').update('lma-photo:' + k).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; };

// A small, ORIGINAL stylised "scene" SVG — obviously a demo placeholder (watermark),
// varied by palette so before / progress / after read differently at a glance.
function sceneSVG(title, typeLabel, dateLabel, palette) {
  const P_ = {
    dry:  { sky:'#cdd8e0', g1:'#b9a97e', g2:'#9c8a5c', accent:'#8a7b52' },
    work: { sky:'#c3d3df', g1:'#9fae7a', g2:'#7f8f54', accent:'#e0873a' },
    green:{ sky:'#bcd6ea', g1:'#4f9e5f', g2:'#2e7d47', accent:'#2e7d5b' },
    lush: { sky:'#bcd6ea', g1:'#57a866', g2:'#2f8a4d', accent:'#B8892B' },
  }[palette] || { sky:'#cdd8e0', g1:'#9fae7a', g2:'#7f8f54', accent:'#5a6b83' };
  const trees = [90,150,210,470,540].map((x,i)=>`<circle cx="${x}" cy="${168-(i%2)*10}" r="${16+(i%3)*4}" fill="${P_.g2}" opacity="0.85"/><rect x="${x-2}" y="168" width="4" height="14" fill="#6b5a3a"/>`).join('');
  const machine = palette==='work' ? `<rect x="250" y="150" width="70" height="34" rx="4" fill="${P_.accent}"/><rect x="262" y="140" width="16" height="12" fill="#333"/><circle cx="266" cy="188" r="9" fill="#222"/><circle cx="308" cy="188" r="9" fill="#222"/>` : '';
  const monument = /monument/i.test(title) ? `<rect x="270" y="120" width="60" height="64" rx="3" fill="${palette==='lush'?'#d8cdb6':'#b3a892'}" stroke="#8a7d63"/><rect x="286" y="132" width="28" height="40" fill="${palette==='lush'?'#efe7d3':'#c9bda2'}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="200" viewBox="0 0 640 200">
  <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${P_.sky}"/><stop offset="1" stop-color="#e7eef4"/></linearGradient>
  <linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${P_.g1}"/><stop offset="1" stop-color="${P_.g2}"/></linearGradient></defs>
  <rect width="640" height="200" fill="url(#s)"/>
  <rect y="112" width="640" height="88" fill="url(#g)"/>
  <ellipse cx="320" cy="120" rx="360" ry="26" fill="#000" opacity="0.05"/>
  ${trees}${monument}${machine}
  <rect x="0" y="0" width="640" height="200" fill="none" stroke="#000" stroke-opacity="0.06" stroke-width="10"/>
  <g font-family="Public Sans, Segoe UI, sans-serif">
    <rect x="0" y="164" width="640" height="36" fill="#0B1D34" opacity="0.72"/>
    <text x="14" y="187" fill="#fff" font-size="14" font-weight="700">${title}</text>
    <text x="626" y="187" fill="#eaf1fb" font-size="12.5" text-anchor="end">${typeLabel} · ${dateLabel}</text>
    <rect x="14" y="12" width="132" height="22" rx="11" fill="#B8892B"/>
    <text x="80" y="27" fill="#0B1D34" font-size="11" font-weight="800" text-anchor="middle" letter-spacing="1">DEMO SAMPLE</text>
  </g>
</svg>`;
}

// [key, assetId, projectId, type, dateISO, caption, palette]
const PHOTOS = [
  ['m7-before',    E(3), P(1), 'before',       '2026-07-12', 'Controller enclosure before replacement; zone not holding pressure', 'dry'],
  ['m7-progress',  E(3), P(1), 'progress',     '2026-08-26', 'AquaFlow replacing the controller and re-terminating zones',        'work'],
  ['m7-latest',    E(3), P(1), 'field_update', '2026-09-18', 'New controller installed; zones under test',                        'green'],
  ['monw-before',  E(4), P(3), 'before',       '2026-06-10', 'Monument stonework weathered, color beds thin',                    'dry'],
  ['monw-after',   E(4), P(3), 'after',        '2026-06-22', 'Refurbished stone and replanted entrance color',                   'lush'],
  ['m3-progress',  E(1), P(4), 'progress',     '2026-09-10', 'Median 3 renovation underway; new sod and steel borders',          'work'],
];
const LABEL = { field_update:'FIELD_UPDATE', before:'BEFORE', progress:'PROGRESS', after:'AFTER', inspection:'INSPECTION', issue:'ISSUE' };

async function assetName(id) { const { data } = await sb.from('community_assets').select('name').eq('id', id).maybeSingle(); return data ? data.name : 'Asset'; }

async function main() {
  console.log(`\nSterling Ridge DEMO field photos — ${EXECUTE ? 'EXECUTE' : 'DRY RUN'} — ${PHOTOS.length} sample photos\n`);
  for (const [key, aid, pid, type, date, caption] of PHOTOS) console.log(`  ${key.padEnd(14)} ${LABEL[type].padEnd(13)} ${date}  asset ${aid.slice(0,8)}  proj ${pid.slice(0,8)}`);
  if (!EXECUTE) { console.log('\nDRY RUN — no writes.'); return; }

  let done = 0;
  for (const [key, aid, pid, type, date, caption, palette] of PHOTOS) {
    const nm = await assetName(aid);
    const svg = sceneSVG(nm, LABEL[type].replace('_', ' '), new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), palette);
    const path = `board-map-reports/${LMA}/asset-${aid}/demo-${key}.svg`;
    const { error: upErr } = await sb.storage.from('documents').upload(path, Buffer.from(svg), { contentType: 'image/svg+xml', upsert: true });
    if (upErr) throw new Error('upload ' + key + ': ' + upErr.message);
    const row = {
      id: duid(key), community_id: LMA, community_asset_id: aid, related_project_id: pid,
      reported_by_name: 'Project Manager', reporter_role: 'staff',
      description: LABEL[type] + ' · ' + caption, photo_path: path, photo_bucket: 'documents',
      status: 'new', created_at: new Date(date + 'T15:00:00Z').toISOString(),
    };
    const { error: insErr } = await sb.from('board_map_reports').upsert(row, { onConflict: 'id' });
    if (insErr) throw new Error('row ' + key + ': ' + insErr.message);
    done++;
  }
  console.log(`\nEXECUTE complete: ${done} demo field photos uploaded + linked to their assets/projects (DEMO tenant only).`);
}
main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
