// Verify the elevation dropdown fix on production.
const fetch = global.fetch || require('node-fetch');
const BASE = 'https://my.bedrocktxai.com';

const results = [];
function rec(n, name, pass, detail) {
  results.push({ n, name, pass, detail });
  console.log('[' + (pass ? '✓' : 'X') + '] ' + n + '. ' + name + (detail ? ' — ' + detail : ''));
}

(async () => {
  // 1. DRB form page loads
  const drbHtml = await (await fetch(BASE + '/builders/august-meadows-drb')).text();
  rec(1, 'DRB form loads', drbHtml.length > 5000 && drbHtml.includes('DRB Plan'), 'length=' + drbHtml.length);

  // 2. Lennar form loads
  const lenHtml = await (await fetch(BASE + '/builders/still-creek-lennar')).text();
  rec(2, 'Lennar form loads', lenHtml.length > 5000 && lenHtml.includes('Lennar Plan'), 'length=' + lenHtml.length);

  // 3. DRB form has the combined picker
  rec(3, 'DRB has plan_selection dropdown', drbHtml.includes('name="plan_selection"'), '');

  // 4. DRB form has hidden inputs
  rec(4, 'DRB has hidden plan_number + elevation',
    drbHtml.includes('id="planNumberHidden"') && drbHtml.includes('id="elevationHidden"'), '');

  // 5. DRB hardcoded A/B/C/D dropdown is gone
  const hasOldDrbDropdown = drbHtml.includes('<option value="A">Elevation A</option>')
                         && drbHtml.includes('<option value="B">Elevation B</option>');
  rec(5, 'DRB hardcoded A/B/C/D dropdown removed', !hasOldDrbDropdown, hasOldDrbDropdown ? 'STILL PRESENT' : '');

  // 6. Lennar hidden inputs present
  rec(6, 'Lennar has hidden plan_number + elevation',
    lenHtml.includes('id="planNumberHidden"') && lenHtml.includes('id="elevationHidden"'), '');

  // 7. Lennar hardcoded C4 dropdown is gone
  const hasOldLenDropdown = lenHtml.includes('<option value="C4">Elevation C4</option>');
  rec(7, 'Lennar hardcoded C4 dropdown removed', !hasOldLenDropdown, hasOldLenDropdown ? 'STILL PRESENT' : '');

  // 8. Master plans endpoint returns DRB plans with all elevations
  const mpR = await fetch(BASE + '/api/builder-applications/public/master-plans?community=August%20Meadows&builder=DRB%20Group');
  const mp = await mpR.json();
  const drbPlans = mp.master_plans || [];
  const elevsPresent = new Set(drbPlans.map((p) => p.elevation));
  const karlaNeeded = ['L', 'M', 'O', 'P', 'Q', 'R', 'S'];
  const allPresent = karlaNeeded.every((e) => elevsPresent.has(e));
  rec(8, 'API returns L/M/O/P/Q/R/S elevations',
    allPresent && drbPlans.length >= 80,
    'plans=' + drbPlans.length + ', elevs=' + [...elevsPresent].sort().join(','));

  // 9. Sample lookup
  const samplePlan = drbPlans.find((p) => p.elevation === 'M' && p.plan_number === '1610');
  rec(9, 'Catalog includes Blanton 1610-M',
    !!samplePlan, samplePlan ? 'sqft=' + samplePlan.square_footage : 'not found');

  console.log('\n=================================');
  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass).length;
  console.log('PASSED: ' + pass + '/' + results.length);
  if (fail > 0) {
    console.log('FAILED:');
    for (const r of results) if (!r.pass) console.log('  - ' + r.n + '. ' + r.name + ' — ' + r.detail);
  }
})();
