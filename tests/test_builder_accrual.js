// tests/test_builder_accrual.js  (GitHub #96)
// The JS side of the monthly builder accrual: the GL lines, the runner's
// idempotent flow (post each month once, finish, resume a part-way run), the
// scheduler's day gate, and the visibility items (Operations Feed, AR email).
// The SQL side is proven end to end in tests/sql/501_conversion_builder_e2e.mjs.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'; process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test';
const BA = require('../lib/accounting/builder_accrual');
const { builderCoverageItems } = require('../lib/feed/build');
const R = require('../lib/notifications/ar_reminder');

let pass = 0; let fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); } };

// A minimal supabase double: rpc by name, from(table) reads by table.
function fake({ rpc = {}, tables = {} } = {}) {
  const calls = [];
  const from = (table) => { const b = { filters: [], select() { return b; }, eq(c, v) { b.filters.push([c, v]); return b; }, in() { return b; }, order() { return b; }, limit() { return b; },
    maybeSingle() { const rows = (tables[table] || []).filter((r) => b.filters.every(([c, v]) => r[c] === v)); return Promise.resolve({ data: rows[0] || null, error: null }); },
    then(res, rej) { const v = typeof tables[table] === 'function' ? tables[table]() : { data: tables[table] || [], error: null }; return Promise.resolve(v).then(res, rej); } }; return b; };
  return { calls, from, rpc: async (name, args) => { calls.push([name, args]); const h = rpc[name]; return h ? h(args) : { data: null, error: { message: `no ${name}` } }; } };
}

(async () => {
  console.log('GL lines');
  const month = { period_end: '2026-07-31', amount_cents: 4204, lots: 2, lines: [{ property_id: 'p1', amount_cents: 2102, from: '2026-07-01', through: '2026-07-31', rounding_true_up_cents: 0 }, { property_id: 'p2', amount_cents: 2102, from: '2026-07-01', through: '2026-07-31', rounding_true_up_cents: 0 }] };
  const lines = BA.periodLines({ 1300: 'AR', 4000: 'INC' }, '1300', '4000', month);
  check('one AR debit per lot (naming the lot), one income credit; balanced',
    lines.length === 3 && lines.slice(0, 2).every((l) => l.account_id === 'AR' && l.property_id && l.debit_cents === 2102) && lines[2].account_id === 'INC' && lines[2].credit_cents === 4204 && !lines[2].property_id);
  const other = BA.periodLines({ 1310: 'AR2', 4010: 'INC2' }, '1310', '4010', month);
  check('another program\u2019s accounts (1310 / 4010): the lines follow the configuration', other.slice(0, 2).every((l) => l.account_id === 'AR2') && other[2].account_id === 'INC2');
  const dec = BA.periodLines({ 1300: 'AR', 4000: 'INC' }, '1300', '4000', { period_end: '2026-12-31', amount_cents: 2103, lines: [{ property_id: 'p1', amount_cents: 2103, from: '2026-12-01', through: '2026-12-31', rounding_true_up_cents: 1 }] });
  check('the December line names the year-end rounding true-up', /true-up 1 cents/.test(dec[0].memo));
  check('date helpers', BA.isDate('2026-02-28') && !BA.isDate('2026-02-30x') && !BA.isDate('') && BA.lastDayOfPrevMonth(new Date(Date.UTC(2026, 9, 1))) === '2026-09-30');

  console.log('runner');
  const staged = { status: 'staged', run_id: 'run1', batch_id: 'b1', through: '2026-08-31', ar_account_number: '1300', income_account_number: '4000', resumed: false, blocked: [{ street_address: '5450 Still Meadow', reason: 'builder_coverage_missing' }],
    periods: [{ ...month, pending: 2 }, { ...month, period_end: '2026-08-31', pending: 2 }] };
  const posted = []; const jes = [];
  const sb = fake({ rpc: { builder_accrual_stage: () => ({ data: staged, error: null }), builder_accrual_finish: (a) => ({ data: { status: a.p_period_end === '2026-08-31' ? 'posted' : 'staged' }, error: null }) },
    tables: { chart_of_accounts: [{ id: 'AR', account_number: '1300' }, { id: 'INC', account_number: '4000' }], journal_entries: jes } });
  const r1 = await BA.run(sb, { communityId: 'c1', through: '2026-08-31', actor: 'ed', post: async (o) => { posted.push(o); const e = { id: `je${posted.length}`, reference: `R${posted.length}`, community_id: 'c1', source_module: o.source_module, source_reference: o.source_reference }; jes.push(e); return { entry: e }; } });
  check('posts one entry per billing period through the normal posting path, keyed batch:period end, dated the period end, and reports the blocked lots',
    r1.status === 'posted' && posted.length === 2 && posted[0].source_reference === 'b1:2026-07-31' && posted[1].posting_date === '2026-08-31' && posted.every((p) => p.source_module === 'assessment_billing') && r1.blocked.length === 1, JSON.stringify(r1));
  check('each period is finished against its own entry', sb.calls.filter((c) => c[0] === 'builder_accrual_finish').map((c) => c[1].p_je).join(',') === 'je1,je2');
  // Resume: July already posted (entry exists), August pending -> only August is posted.
  const posted2 = [];
  const sb2 = fake({ rpc: { builder_accrual_stage: () => ({ data: { ...staged, resumed: true, periods: [{ ...month, pending: 0 }, { ...month, period_end: '2026-08-31', pending: 2 }] }, error: null }), builder_accrual_finish: () => ({ data: { status: 'posted' }, error: null }) },
    tables: { chart_of_accounts: [{ id: 'AR', account_number: '1300' }, { id: 'INC', account_number: '4000' }], journal_entries: [{ id: 'jeA', reference: 'RA', community_id: 'c1', source_module: 'assessment_billing', source_reference: 'b1:2026-08-31' }] } });
  const r2 = await BA.run(sb2, { communityId: 'c1', through: '2026-08-31', actor: 'ed', post: async (o) => { posted2.push(o); return { entry: { id: 'x' } }; } });
  check('a resumed run never posts twice: the existing August entry is reused, July is skipped', r2.status === 'completed_retry' && posted2.length === 0 && r2.posted.length === 1 && r2.posted[0].journal_entry_id === 'jeA', JSON.stringify(r2));
  const r3 = await BA.run(fake({ rpc: { builder_accrual_stage: () => ({ data: { status: 'nothing_to_accrue', plan: { periods: 0 } }, error: null }) } }), { communityId: 'c1', through: '2026-08-31', actor: 'ed' });
  check('nothing to accrue -> nothing posted', r3.status === 'nothing_to_accrue');
  let threw = null; try { await BA.run(sb, { communityId: 'c1', through: 'not-a-date', actor: 'ed' }); } catch (e) { threw = e.message; }
  check('refuses a through-date that is not a date', /must be a date/.test(threw || ''));
  let notAct = null; try { await BA.run(fake({ rpc: { builder_accrual_stage: () => ({ data: null, error: { message: 'the builder accrual is not activated for this community (activate it after the conversion is posted)' } }) } }), { communityId: 'c1', through: '2026-08-31', actor: 'ed' }); } catch (e) { notAct = e.message; }
  check('a program whose accrual is not activated is refused loudly (the database refuses the stage)', /not activated/.test(notAct || ''));
  const fin = fake({ rpc: { builder_accrual_stage: () => ({ data: staged, error: null }), builder_accrual_finish: () => ({ data: null, error: { message: 'journal entry R1 debits AR 1, the period\'s coverage is 4204' } }) },
    tables: { chart_of_accounts: [{ id: 'AR', account_number: '1300' }, { id: 'INC', account_number: '4000' }], journal_entries: [] } });
  let finErr = null; try { await BA.run(fin, { communityId: 'c1', through: '2026-08-31', actor: 'ed', post: async () => ({ entry: { id: 'j', reference: 'R1' } }) }); } catch (e) { finErr = e; }
  check('a month whose entry does not equal its coverage fails LOUDLY (finish_pending), never marked covered', finErr && finErr.code === 'finish_pending' && /could not be marked covered/.test(finErr.message));

  console.log('scheduler gate');
  const skip = await BA.runMonthlyIfDue({ supabase: fake(), today: new Date('2026-10-04T15:00:00Z') });
  check('not the 3rd (Central): skipped', skip.skipped === 'not the 3rd');
  const runs = [];
  const sbS = fake({ tables: { builder_assessment_programs: [{ community_id: 'c1', accrual_activated_at: '2026-07-02T00:00:00Z' }, { community_id: 'c2', accrual_activated_at: null }] }, rpc: { builder_accrual_stage: (a) => { runs.push([a.p_community_id, a.p_through]); return { data: { status: 'nothing_to_accrue' }, error: null }; } } });
  const ran = await BA.runMonthlyIfDue({ supabase: sbS, today: new Date('2026-10-03T15:00:00Z'), logger: { warn() {}, error() {} } });
  check('on Oct 3 it accrues through Sep 30, only for programs whose accrual was ACTIVATED after their conversion (c2 is listed as not activated, never run)',
    ran.through === '2026-09-30' && JSON.stringify(runs) === JSON.stringify([['c1', '2026-09-30']]) && ran.communities.length === 1 && JSON.stringify(ran.not_activated) === JSON.stringify(['c2']));
  const act = await BA.activate(fake({ rpc: { activate_builder_accrual: (a) => ({ data: { status: 'activated', activated_by: a.p_actor }, error: null }) } }), { communityId: 'c1', actor: 'ed@x' });
  let actErr = null; try { await BA.activate(fake({ rpc: { activate_builder_accrual: () => ({ data: null, error: { message: "the builder accrual is activated only after the community's accounting conversion is posted" } }) } }), { communityId: 'c1', actor: 'ed' }); } catch (e) { actErr = e.message; }
  check('activation records who; before the conversion posts it is refused', act.status === 'activated' && act.activated_by === 'ed@x' && /only after/.test(actErr || ''));

  console.log('visibility');
  const status = { applies: true, converted: true, status: 'red', expected_through: '2026-12-31', staged_run: null, accrual_active: true,
    lots: [{ street_address: '8301 Rustic Pine Trail', covered_through: '2026-11-30', severity: 'red', reason: 'behind' }, { street_address: '5450 Still Meadow', covered_through: null, severity: 'red', reason: 'coverage_missing' }, { street_address: '5302 Sleepy Fox', covered_through: '2026-12-31', severity: 'ok' }],
    open_reconciling_items: [{ id: 'i1', kind: 'deferral_residue', amount_cents: 200, account_number: '2205', created_at: '2026-10-08' }, { id: 'i2', kind: 'builder_position_unresolved', amount_cents: 9018, detail: { lot: '5450 Still Meadow' }, created_at: '2026-10-08' }] };
  const out = { section_errors: {} };
  const items = await builderCoverageItems(fake({ tables: { transfer_proration_builders: [{ community_id: 'c1', communities: { name: 'Still Creek Ranch' } }] }, rpc: { builder_coverage_status: () => ({ data: status, error: null }) } }), { communityId: null, today: '2027-01-05', out });
  check('Operations Feed: one HIGH item for the community (lots not covered, year closed) + one waiting item per open reconciling item',
    items.length === 3 && items[0].kind === 'builder_coverage' && items[0].priority === 'high' && /2 lots/.test(items[0].title) && /year has closed/.test(items[0].why)
      && items.filter((i) => i.kind === 'reconciling_item').length === 2 && /\$2\.00 in 2205/.test(items[1].title), JSON.stringify(items.map((i) => [i.kind, i.title, i.priority])));
  const na = await builderCoverageItems(fake({ tables: { transfer_proration_builders: [{ community_id: 'c1' }] }, rpc: { builder_coverage_status: () => ({ data: { ...status, accrual_active: false, status: 'amber', lots: status.lots.slice(2), open_reconciling_items: [] }, error: null }) } }), { today: '2026-07-02', out });
  check('converted but the accrual not activated: one item asking an admin to activate it', na.length === 1 && /not activated/.test(na[0].title));
  const ok = await builderCoverageItems(fake({ tables: { transfer_proration_builders: [{ community_id: 'c1' }] }, rpc: { builder_coverage_status: () => ({ data: { ...status, status: 'ok', lots: status.lots.slice(2), open_reconciling_items: [] }, error: null }) } }), { today: '2027-01-06', out });
  check('all current, nothing open: no feed item', ok.length === 0);
  const out2 = { section_errors: {} };
  const notInstalled = await builderCoverageItems(fake({ tables: { transfer_proration_builders: () => ({ data: null, error: { message: 'relation "transfer_proration_builders" does not exist' } }) } }), { today: '2027-01-06', out: out2 });
  check('before migrations 500/501: no item and no false error', notInstalled.length === 0 && !out2.section_errors.builder_coverage);
  const out3 = { section_errors: {} };
  await builderCoverageItems(fake({ tables: { transfer_proration_builders: [{ community_id: 'c1' }] }, rpc: { builder_coverage_status: () => ({ data: null, error: { message: 'permission denied' } }) } }), { today: '2027-01-06', out: out3 });
  check('a real read error shows as unavailable (never a false all-clear)', out3.section_errors.builder_coverage === 'permission denied');
  const secs = await R.builderCoverageSections(fake({ tables: { transfer_proration_builders: [{ community_id: 'c1', communities: { name: 'Still Creek Ranch' } }] }, rpc: { builder_coverage_status: () => ({ data: status, error: null }) } }), '2027-01-05');
  const txt = R.builderText(secs);
  check('AR email: coverage-through date, active builder lots, gaps / blocked lots and the open items',
    /Still Creek Ranch: RED · 3 lots · covered through 2026-11-30 \(expected 2026-12-31\)/.test(txt) && /5450 Still Meadow: no coverage \(coverage missing\)/.test(txt) && /\$2\.00 in 2205/.test(txt) && R.builderHtml(secs).includes('Builder assessments'), txt);
  check('AR email: a community with no builder rule adds nothing', R.builderText([]) === '' && R.builderHtml([]) === '');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
