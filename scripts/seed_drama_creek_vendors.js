// ============================================================================
// scripts/seed_drama_creek_vendors.js  (Ed 2026-08-20)
// ----------------------------------------------------------------------------
// Fills the Drama Creek vendor directory so it demos as a product.
//
// Ed: "we can populate drama creek with examples, i need a working demo for
// next week that makes the bankers say wow."
//
// An empty directory demos as an idea. A directory with three years of
// neighbour-reported prices demos as the thing no competitor has: what your
// neighbours actually paid, from people who live on your street, with no vendor
// paying to be listed.
//
// DRAMA CREEK IS FICTIONAL (is_demo = true). Every vendor, price and comment
// below is invented for the demo. No real company is named, no real homeowner
// is quoted, and nothing here touches a live community. That is deliberate: a
// demo built on a real community's data is one screen-share away from showing a
// banker a homeowner's name and what they paid.
//
// Shaped to be believable rather than flattering:
//   - a spread of prices within each trade, because a range is the point
//   - some vendors with several reviews, some with one
//   - genuine negatives, because 100% positive reads as fake and the "would
//     hire again" signal means nothing if nobody ever says no
//   - dates across three years so the recency weighting has something to weigh
//
// IDEMPOTENT: keyed on vendor + date + property, so a re-run tops up.
//
//   node scripts/seed_drama_creek_vendors.js --dry-run
//   node scripts/seed_drama_creek_vendors.js
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const DRY = process.argv.includes('--dry-run');

// [category slug, vendor, contact, phone, email, project, $, would hire, did well, could improve, YYYY, M]
const REVIEWS = [
  // ---- Lawn & Landscaping -------------------------------------------------
  ['lawn_landscaping', 'Verde Lawn & Landscape', 'Miguel Ortega', '(281) 555-0142', 'miguel@verdelawn.example',
   'Weekly mowing, edging and beds', 21000, true,
   'Same crew every week, never had to chase them. They text when they are on the way.', null, 2026, 6],
  ['lawn_landscaping', 'Verde Lawn & Landscape', 'Miguel Ortega', '(281) 555-0142', null,
   'Full bed redo with new plants and mulch', 148000, true,
   'Talked me out of a more expensive plan that would not have survived the summer.', 'Took two weeks longer than quoted.', 2025, 10],
  ['lawn_landscaping', 'Verde Lawn & Landscape', null, null, null,
   'Weekly mowing', 19500, true, 'Reliable and reasonable.', null, 2024, 5],
  ['lawn_landscaping', 'Bluebonnet Grounds Co.', 'Dana Whitfield', '(832) 555-0119', 'dana@bluebonnetgrounds.example',
   'Sprinkler zone repair and controller replacement', 62500, true,
   'Found two broken heads the last company missed. Explained the controller so I can set it myself.', null, 2026, 4],
  ['lawn_landscaping', 'Bluebonnet Grounds Co.', null, null, null,
   'Tree trimming, three live oaks', 95000, true, 'Cleaned up completely, you could not tell they had been there.', null, 2025, 2],
  ['lawn_landscaping', 'QuickCut Yard Service', null, '(713) 555-0188', null,
   'Weekly mowing', 14000, false, 'Cheapest quote I got.',
   'Missed three weeks in a row in July and did not answer the phone. Had to switch mid-season.', 2025, 7],

  // ---- Home Exterior ------------------------------------------------------
  ['home_exterior', 'Lone Star Roofing & Gutters', 'Ray Kessler', '(281) 555-0164', 'ray@lonestarroof.example',
   'Full roof replacement after April hail', 1875000, true,
   'Handled the insurance adjuster directly and got the claim approved after it was first denied. Crew was done in two days.', null, 2026, 6],
  ['home_exterior', 'Lone Star Roofing & Gutters', 'Ray Kessler', '(281) 555-0164', null,
   'Roof replacement, hail claim', 1740000, true,
   'Same story as half the street after the storm. Fair price, no upselling.', 'Dumpster sat in the driveway four days after they finished.', 2026, 5],
  ['home_exterior', 'Lone Star Roofing & Gutters', null, null, null,
   'Gutter replacement, full house', 285000, true, 'Quick and clean.', null, 2025, 9],
  ['home_exterior', 'Cypress Fence & Gate', 'Tomas Reyna', '(832) 555-0177', 'tomas@cypressfence.example',
   'Replaced 90 feet of cedar fence on the back line', 412000, true,
   'Matched the neighbours fence so the whole line looks right. Set the posts in concrete without being asked.', null, 2026, 3],
  ['home_exterior', 'Cypress Fence & Gate', 'Tomas Reyna', '(832) 555-0177', null,
   'Fence repair after the storm, 3 panels', 68000, true, 'Came out the same week.', null, 2025, 11],
  ['home_exterior', 'Cypress Fence & Gate', null, null, null,
   'New gate with hardware', 94000, true, 'Gate still swings true two years on.', null, 2024, 8],
  ['home_exterior', 'Precision Exterior Painting', 'Alan Boyd', '(713) 555-0155', 'alan@precisionexterior.example',
   'Exterior repaint, two storey, trim and doors', 745000, true,
   'Pressure washed, caulked and primed before painting. Two coats everywhere. It still looks new.', 'Not the cheapest by a good margin.', 2025, 4],
  ['home_exterior', 'Precision Exterior Painting', null, null, null,
   'Front door and shutters only', 98000, true, 'Small job and they still showed up on time.', null, 2026, 2],
  ['home_exterior', 'Gulf Coast Power Washing', null, '(281) 555-0133', null,
   'Driveway, walkway and patio', 42000, true, 'Driveway looks ten years younger.', null, 2026, 5],
  ['home_exterior', 'Gulf Coast Power Washing', null, null, null,
   'House wash and gutters', 38000, false, null,
   'Left streaks on the north side and would not come back to redo it.', 2025, 6],

  // ---- Home Interior ------------------------------------------------------
  ['home_interior', 'Hearth & Hand Handyman', 'Curtis Nabors', '(832) 555-0126', 'curtis@hearthandhand.example',
   'Hung shelves, fixed two doors, replaced a garbage disposal', 34000, true,
   'Did four small jobs in one visit that I had put off for a year. Charged by the hour and was honest about it.', null, 2026, 7],
  ['home_interior', 'Hearth & Hand Handyman', 'Curtis Nabors', '(832) 555-0126', null,
   'Attic ladder replacement', 52000, true, 'In and out in ninety minutes.', null, 2026, 1],
  ['home_interior', 'Hearth & Hand Handyman', null, null, null,
   'Various small repairs before listing the house', 78000, true, 'Made a punch list with me and worked through it.', null, 2025, 3],
  ['home_interior', 'Sablewood Flooring', 'Rita Mendes', '(281) 555-0171', 'rita@sablewoodfloors.example',
   'Luxury vinyl plank through the downstairs, 1,150 sq ft', 812000, true,
   'Moved the furniture themselves and put it all back. The transitions at the stairs are perfect.', null, 2025, 9],
  ['home_interior', 'Sablewood Flooring', null, null, null,
   'Carpet in three bedrooms', 385000, true, 'Fair price, good padding, no complaints.', null, 2024, 11],
  ['home_interior', 'Bright Home Cleaning', null, '(713) 555-0109', 'hello@brighthomeclean.example',
   'Deep clean, every other week thereafter', 18500, true,
   'Same two people every time, which matters when you are handing over a key.', null, 2026, 4],

  // ---- Plumbing -----------------------------------------------------------
  ['plumbing', 'Ranchwater Plumbing', 'Dale Kirby', '(281) 555-0147', 'dale@ranchwaterplumbing.example',
   'Water heater replacement, 50 gallon gas', 214000, true,
   'Came out the same day the old one flooded the garage. Took the old unit away and pulled the permit.', null, 2026, 2],
  ['plumbing', 'Ranchwater Plumbing', 'Dale Kirby', '(281) 555-0147', null,
   'Slab leak locate and repair', 386000, true,
   'Found it under the hall instead of jackhammering the whole slab like the first company wanted to.', 'Expensive, but the alternative quote was double.', 2025, 8],
  ['plumbing', 'Ranchwater Plumbing', null, null, null,
   'Kitchen faucet and disposal', 47000, true, 'Straightforward, no surprises.', null, 2026, 6],
  ['plumbing', 'AllHours Drain & Sewer', null, '(832) 555-0198', null,
   'Main line hydro jetting, roots', 68000, true, 'Camera down the line first so I could see the problem myself.', null, 2025, 12],
  ['plumbing', 'AllHours Drain & Sewer', null, null, null,
   'Emergency call, burst supply line', 92000, false, 'They did answer at 11pm.',
   'The after-hours rate was never mentioned until the invoice. Nearly triple.', 2026, 1],

  // ---- Electrical ---------------------------------------------------------
  ['electrical', 'Copperline Electric', 'Sean Duffy', '(713) 555-0162', 'sean@copperlineelectric.example',
   'Panel upgrade to 200 amp', 268000, true,
   'Pulled the permit, coordinated the utility disconnect, passed inspection first time.', null, 2025, 10],
  ['electrical', 'Copperline Electric', 'Sean Duffy', '(713) 555-0162', null,
   'Added two exterior outlets and a floodlight', 74000, true, 'Neat work, everything labelled in the panel.', null, 2026, 3],
  ['electrical', 'Copperline Electric', null, null, null,
   'Ceiling fan install, three rooms', 39000, true, 'On time and tidy.', null, 2024, 6],
  ['electrical', 'Bright Spark Electrical', null, '(281) 555-0115', null,
   'EV charger install in the garage', 158000, true, 'Ran the conduit cleanly and did the load calc properly.', null, 2026, 5],

  // ---- Heating & Cooling --------------------------------------------------
  ['heating_cooling', 'Cardinal Air Conditioning', 'Priya Raman', '(832) 555-0104', 'priya@cardinalac.example',
   'Full system replacement, 4 ton, 16 SEER', 1145000, true,
   'Three companies quoted. Cardinal was the only one that measured the ducts instead of just selling me a bigger unit.', null, 2025, 7],
  ['heating_cooling', 'Cardinal Air Conditioning', 'Priya Raman', '(832) 555-0104', null,
   'Summer service and coil clean', 18500, true, 'On the twice-a-year plan, they just show up.', null, 2026, 5],
  ['heating_cooling', 'Cardinal Air Conditioning', null, null, null,
   'Capacitor replacement, no cooling', 24500, true, 'Out in four hours in August, which is all that mattered.', null, 2026, 7],
  ['heating_cooling', 'SwiftCool HVAC', null, '(713) 555-0173', null,
   'Second opinion on a system replacement', 0, true,
   'Free second opinion and told me my system had years left. Saved me eleven thousand dollars.', null, 2025, 6],
  ['heating_cooling', 'SwiftCool HVAC', null, null, null,
   'Duct sealing', 142000, false, null,
   'Upstairs is no cooler than before. They came back once and then stopped returning calls.', 2025, 9],

  // ---- Pool ---------------------------------------------------------------
  ['pool', 'Clearwater Pool Care', 'Nick Alvarez', '(281) 555-0186', 'nick@clearwaterpoolcare.example',
   'Weekly service, chemicals included', 16500, true,
   'Sends a photo of the pool and the readings after every visit. Never had a green pool.', null, 2026, 6],
  ['pool', 'Clearwater Pool Care', 'Nick Alvarez', '(281) 555-0186', null,
   'Pump replacement, variable speed', 178000, true, 'Electric bill dropped enough to notice.', null, 2025, 5],
  ['pool', 'Clearwater Pool Care', null, null, null,
   'Weekly service', 15500, true, 'Two years, no complaints.', null, 2024, 4],
  ['pool', 'Blue Horizon Pools', null, '(832) 555-0121', null,
   'Replaster and new tile', 985000, true, 'Looks like a new pool.', 'Six weeks start to finish, about two longer than quoted.', 2025, 3],

  // ---- Pest Control -------------------------------------------------------
  ['pest_control', 'Sentry Pest Solutions', 'Wade Foster', '(713) 555-0138', 'wade@sentrypest.example',
   'Quarterly service, interior and perimeter', 12500, true,
   'Have not seen a roach since we started. Comes back between visits at no charge if you ask.', null, 2026, 7],
  ['pest_control', 'Sentry Pest Solutions', null, null, null,
   'Fire ant treatment, whole yard', 22000, true, 'Gone in a week and stayed gone all summer.', null, 2025, 6],
  ['pest_control', 'Sentry Pest Solutions', null, null, null,
   'Quarterly service', 11900, true, 'Same tech every visit, knows the house.', null, 2024, 9],
  ['pest_control', 'Gulf Termite & Pest', null, '(281) 555-0150', null,
   'Termite inspection and treatment', 148000, true, 'Thorough inspection with photos of everything they found.', null, 2026, 2],
];

(async () => {
  const { data: community, error: cErr } = await supabase.from('communities')
    .select('id, name, is_demo').ilike('name', '%drama creek%').maybeSingle();
  if (cErr) throw new Error('community lookup failed: ' + cErr.message);
  if (!community) throw new Error('Drama Creek not found');

  // Hard stop. This writes invented reviews with invented prices, and it must
  // never land in a community a real homeowner can open.
  if (!community.is_demo) {
    throw new Error('REFUSING: ' + community.name + ' is not flagged is_demo. Seed data belongs only in the demo community.');
  }

  const { data: cats, error: catErr } = await supabase.from('vendor_categories')
    .select('id, slug, label').eq('active', true);
  if (catErr) throw new Error('categories read failed: ' + catErr.message);
  const bySlug = Object.fromEntries((cats || []).map((c) => [c.slug, c]));

  const { data: props, error: pErr } = await supabase.from('properties')
    .select('id, street_address').eq('community_id', community.id).order('id').limit(80);
  if (pErr) throw new Error('properties read failed: ' + pErr.message);
  if (!props || !props.length) throw new Error('Drama Creek has no properties to attribute submissions to');

  console.log(community.name + ': ' + REVIEWS.length + ' reviews across '
    + new Set(REVIEWS.map((r) => r[0])).size + ' categories' + (DRY ? '  [DRY RUN]' : ''));

  let added = 0, skipped = 0, missing = new Set();
  for (let n = 0; n < REVIEWS.length; n++) {
    const [slug, vendor, contact, phone, email, project, cents, hire, well, improve, year, month] = REVIEWS[n];
    const cat = bySlug[slug];
    if (!cat) { missing.add(slug); continue; }

    // Spread across different homes so it reads as a neighbourhood, not one
    // very busy household.
    const prop = props[n % props.length];

    const { data: exists, error: exErr } = await supabase.from('vendor_experiences')
      .select('id').eq('community_id', community.id).eq('vendor_name', vendor)
      .eq('completed_year', year).eq('completed_month', month)
      .eq('property_id', prop.id).maybeSingle();
    if (exErr) throw new Error('dedup check failed: ' + exErr.message);
    if (exists) { skipped++; continue; }

    if (DRY) { added++; continue; }

    const { error } = await supabase.from('vendor_experiences').insert({
      community_id: community.id,
      property_id: prop.id,
      vendor_name: vendor,
      vendor_category_id: cat.id,
      project_type: project,
      price_paid_cents: cents > 0 ? cents : null,
      would_hire_again: hire,
      did_well: well,
      could_improve: improve,
      completed_month: month,
      completed_year: year,
      vendor_contact_name: contact,
      vendor_phone: phone,
      vendor_email: email,
      submitted_at: new Date(year, month, 14).toISOString(),
    });
    if (error) { console.warn('  ! ' + vendor + ': ' + error.message); continue; }
    added++;
  }

  if (missing.size) console.warn('  ! no active category for: ' + [...missing].join(', '));
  console.log('\n' + (DRY ? 'would add ' : 'added ') + added + ', ' + skipped + ' already there');

  if (DRY) return;

  const { data: all, error: aErr } = await supabase.from('vendor_experiences')
    .select('vendor_name, would_hire_again, price_paid_cents, vendor_categories:vendor_category_id(label)')
    .eq('community_id', community.id);
  if (aErr) throw new Error(aErr.message);

  const byCat = {};
  (all || []).forEach((r) => {
    const k = (r.vendor_categories && r.vendor_categories.label) || '?';
    byCat[k] = byCat[k] || { n: 0, vendors: new Set() };
    byCat[k].n++; byCat[k].vendors.add(r.vendor_name);
  });
  console.log('\nDIRECTORY NOW READS:');
  Object.entries(byCat).sort().forEach(([k, v]) =>
    console.log('  ' + k.padEnd(22) + v.n + ' reviews across ' + v.vendors.size + ' vendors'));
  const neg = (all || []).filter((r) => !r.would_hire_again).length;
  console.log('\n  ' + (all || []).length + ' reviews, ' + neg + ' would-not-hire-again ('
    + Math.round((neg / Math.max(1, (all || []).length)) * 100) + '%)');
  console.log('  A directory where nobody ever says no reads as advertising.');
})().catch((e) => { console.error('seed failed:', e.message); process.exit(1); });
