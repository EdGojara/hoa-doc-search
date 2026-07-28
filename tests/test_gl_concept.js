// Tests for the GL domain-concept lexicon (lib/accounting/gl_classifier.js).
// Scar (Ed 2026-07-28, Superior LawnCare 43166 at Waterview): a vendor who does
// BOTH landscaping and irrigation billed irrigation PARTS — "Sprays Head Rain
// Bird", "Nozzle RainBird", "Valve PEB", "Bubbler" — and every line coded to
// 5200 Landscape by vendor-history count, because none of the words match the
// account name "Irrigation Repair & Maintenance". The line's own vocabulary
// should win. This locks that in: irrigation part-language must route to the
// irrigation account when the chart has one.
require('dotenv').config();
const assert = require('assert');
const { matchAccountByConcept } = require('../lib/accounting/gl_classifier');

let pass = 0;
const ok = (d, c) => { assert.ok(c, d); pass++; };

// A Waterview-shaped chart: both accounts exist, so the split must be by line.
const chart = [
  { id: 'irr',  account_number: '5125', account_name: 'Irrigation Repair & Maintenance', account_type: 'expense' },
  { id: 'land', account_number: '5200', account_name: 'Landscape Operating & Management', account_type: 'expense' },
  { id: 'cash', account_number: '1000', account_name: 'Operating Cash', account_type: 'asset' },
];
const acct = (d) => { const r = matchAccountByConcept(d, chart); return r && r.acct.id; };

// The actual mis-coded lines from invoice 43166 — every one must land on 5125.
ok('Sprays Head Rain Bird -> irrigation', acct('Sprays Head 1812 Rain Bird') === 'irr');
ok('Nozzle RainBird -> irrigation', acct('Nozzle RainBird') === 'irr');
ok('Valve 2" PEB Rainbird -> irrigation', acct('Valve 2" PEB Rainbird') === 'irr');
ok('Bubblers Rain Bird -> irrigation', acct('Bubblers Rain Bird') === 'irr');
ok('Cap Bubbler -> irrigation', acct('Cap Bubbler') === 'irr');
ok('Box Valve 12" x 18" -> irrigation', acct('Box Valve 12" x 18"') === 'irr');

// Landscaping vocabulary must stay on the landscape account, not bleed to irrigation.
ok('Monthly mowing -> landscaping', acct('Monthly Mowing Service') === 'land');
ok('Mulch install -> landscaping', acct('Mulch install and bed cleanup') === 'land');
ok('Fertilization -> landscaping', acct('Turf Fertilization') === 'land');

// No false positives on unrelated / uninformative lines.
ok('Labor alone -> no concept (magnitude heuristic handles it)', matchAccountByConcept('Labor', chart) === null);
ok('empty -> null', matchAccountByConcept('', chart) === null);

// No account, no guess: a chart WITHOUT an irrigation account must return null
// rather than force-fit an irrigation line somewhere wrong.
const noIrr = chart.filter((a) => a.id !== 'irr');
ok('irrigation line with no irrigation account -> null', matchAccountByConcept('Nozzle RainBird', noIrr) === null);

console.log(`gl_concept: ${pass} assertions passed`);
