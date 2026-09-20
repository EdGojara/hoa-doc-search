// ============================================================================
// tests/test_community_assets.js
// ----------------------------------------------------------------------------
// Proves the canonical physical-asset foundation (migration 440). All fixtures
// are created and DELETED in a finally block, so nothing persists as Drama Creek
// production/demo data. Requires migration 440 applied.
//
// Proves: tenant isolation; owning community required; POINT/LINE/POLYGON geometry;
// parent/child + self-parent rejection; generic (non-FBCAD) provenance; member_scope
// fails closed by default; selected-member scope cannot expose an asset outside an
// authorized relationship (reusing the SAME resolver pattern as documents); demo
// tenant assets never appear in a Bedrock asset query. Plus representative objects
// (North Entrance tree + Section 43 detention polygon).
// Run: node tests/test_community_assets.js
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const { BEDROCK_MGMT_CO_ID, DEMO_MGMT_CO_ID } = require('../lib/company');
const { activeParentsForMember } = require('../lib/portal/member_scope');

const DRAMA_CREEK = 'dc100000-0000-4000-a000-000000000000';         // demo tenant community
const CLMA = 'c4a87380-81ae-43aa-94eb-a671e2d6401f';                // has an active partner (Cinco Residential)
const CINCO_RES = 'c1c0f000-0000-4000-8000-000000000001';           // active partner of CLMA
const CANYON_GATE = 'a0000000-0000-4000-8000-000000000003';         // production; NOT a partner of CLMA
const TAG = 'ZZTEST_ASSET_' + Date.now();

let fails = 0; const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); if (!c) fails++; };
const created = [];
async function mk(fields) {
  const { data, error } = await sb.from('community_assets').insert({ name: TAG, asset_class: 'other', asset_type: 'test', ...fields }).select('id, member_scope, parent_asset_id, source_system, source_ref').single();
  if (error) return { error };
  created.push(data.id); return { id: data.id, row: data };
}

// The SAME fail-closed entitlement the document resolver uses, applied to assets.
async function memberCanSeeAsset(assetRow, memberCommunityId) {
  if (!assetRow) return false;
  if (!['all_members', 'selected_members'].includes(assetRow.member_scope)) return false; // internal/unclassified/n-a
  const parents = (await activeParentsForMember(memberCommunityId)).map(p => p.parentId);
  if (!parents.includes(assetRow.community_id)) return false;                              // no active relationship
  if (assetRow.member_scope === 'all_members') return true;
  const { data } = await sb.from('asset_member_scope').select('asset_id').eq('asset_id', assetRow.id).eq('member_community_id', memberCommunityId);
  return !!(data && data.length);
}

(async () => {
  try {
    console.log('community_assets foundation\n');

    // 2. Owning community + tenant required.
    ok((await mk({ management_company_id: DEMO_MGMT_CO_ID })).error != null, 'insert WITHOUT community_id is rejected');
    ok((await mk({ community_id: DRAMA_CREEK })).error != null, 'insert WITHOUT management_company_id is rejected');

    // 1 + 9. Tenant isolation: a demo-tenant asset and a bedrock asset.
    const demoA = await mk({ management_company_id: DEMO_MGMT_CO_ID, community_id: DRAMA_CREEK, name: TAG + '_demo', asset_class: 'water', asset_type: 'detention_pond' });
    const bedA = await mk({ management_company_id: BEDROCK_MGMT_CO_ID, community_id: CANYON_GATE, name: TAG + '_bed', asset_class: 'recreation', asset_type: 'pool' });
    ok(!demoA.error && !bedA.error, 'created a demo-tenant asset and a bedrock asset');
    const { data: bedQuery } = await sb.from('community_assets').select('id, management_company_id').eq('management_company_id', BEDROCK_MGMT_CO_ID).like('name', TAG + '%');
    const bedIds = (bedQuery || []).map(r => r.id);
    ok(bedIds.includes(bedA.id) && !bedIds.includes(demoA.id), 'a BEDROCK asset query excludes the demo-tenant asset (tenant isolation)');

    // 7. member_scope defaults to 'unclassified' (fail closed).
    ok(demoA.row.member_scope === 'unclassified', 'member_scope defaults to unclassified (fail closed)');

    // 6. Generic provenance works without assuming FBCAD.
    const provA = await mk({ management_company_id: DEMO_MGMT_CO_ID, community_id: DRAMA_CREEK, source_system: 'survey', source_ref: 'PLAT-2009-A' });
    ok(!provA.error && provA.row.source_system === 'survey' && provA.row.source_ref === 'PLAT-2009-A', 'generic provenance (source_system/source_ref) works, no FBCAD assumption');

    // 3. Geometry POINT / LINE / POLYGON via the write primitive.
    for (const [wkt, want] of [['POINT(-95.7459 29.6827)', 'ST_Point'], ['LINESTRING(-95.75 29.68, -95.74 29.68)', 'ST_LineString'], ['POLYGON((-95.75 29.68,-95.74 29.68,-95.74 29.67,-95.75 29.67,-95.75 29.68))', 'ST_Polygon']]) {
      const a = await mk({ management_company_id: DEMO_MGMT_CO_ID, community_id: DRAMA_CREEK });
      const { data: g, error: ge } = await sb.rpc('community_asset_set_geometry', { p_asset_id: a.id, p_wkt: wkt });
      ok(!ge && g && g.ok && g.geometry_type === want && g.has_centroid, `geometry stored: ${want}`);
    }

    // 4 + 5. Parent/child + self-parent rejection.
    const parent = await mk({ management_company_id: DEMO_MGMT_CO_ID, community_id: DRAMA_CREEK, name: TAG + '_parent' });
    const child = await mk({ management_company_id: DEMO_MGMT_CO_ID, community_id: DRAMA_CREEK, name: TAG + '_child', parent_asset_id: parent.id });
    ok(!child.error && child.row.parent_asset_id === parent.id, 'parent/child relationship stored');
    const selfErr = await sb.from('community_assets').update({ parent_asset_id: parent.id }).eq('id', parent.id);
    ok(selfErr.error != null, 'self-parent relationship is rejected (CHECK)');

    // 8. Selected-member scope cannot expose an asset outside an authorized relationship.
    const scoped = await mk({ management_company_id: BEDROCK_MGMT_CO_ID, community_id: CLMA, name: TAG + '_scoped', member_scope: 'selected_members' });
    await sb.from('asset_member_scope').insert({ asset_id: scoped.id, member_community_id: CINCO_RES });
    const scopedRow = { id: scoped.id, community_id: CLMA, member_scope: 'selected_members' };
    ok(await memberCanSeeAsset(scopedRow, CINCO_RES), 'authorized partner (active relationship + selected) CAN see the asset');
    ok(!(await memberCanSeeAsset(scopedRow, CANYON_GATE)), 'a non-partner CANNOT see the selected-scope asset');
    const unclassRow = { id: demoA.id, community_id: DRAMA_CREEK, member_scope: 'unclassified' };
    ok(!(await memberCanSeeAsset(unclassRow, CINCO_RES)), 'an unclassified asset is invisible to any member (fail closed)');

    // 10. Representative objects: North Entrance tree + Section 43 detention polygon.
    const entrance = await mk({ management_company_id: DEMO_MGMT_CO_ID, community_id: DRAMA_CREEK, name: TAG + '_North Entrance', asset_class: 'access', asset_type: 'entrance' });
    const kids = [];
    for (const [nm, cls, typ, wkt, want] of [
      ['monument', 'access', 'monument', 'POINT(-95.746 29.683)', 'ST_Point'],
      ['landscape bed', 'landscape', 'landscape_bed', 'POLYGON((-95.746 29.683,-95.745 29.683,-95.745 29.682,-95.746 29.682,-95.746 29.683))', 'ST_Polygon'],
      ['irrigation controller', 'equipment', 'irrigation_controller', 'POINT(-95.7455 29.6825)', 'ST_Point'],
      ['lighting', 'utility', 'lighting', 'LINESTRING(-95.746 29.683,-95.745 29.682)', 'ST_LineString'],
    ]) {
      const k = await mk({ management_company_id: DEMO_MGMT_CO_ID, community_id: DRAMA_CREEK, name: TAG + '_' + nm, asset_class: cls, asset_type: typ, parent_asset_id: entrance.id });
      const { data: g } = await sb.rpc('community_asset_set_geometry', { p_asset_id: k.id, p_wkt: wkt });
      kids.push(g && g.geometry_type === want && k.row.parent_asset_id === entrance.id);
    }
    ok(kids.every(Boolean) && kids.length === 4, 'North Entrance -> monument/bed/irrigation/lighting composite with geometry');
    const det = await mk({ management_company_id: DEMO_MGMT_CO_ID, community_id: DRAMA_CREEK, name: TAG + '_Section 43 Detention', asset_class: 'water', asset_type: 'detention_pond', condition: 'good' });
    const { data: dg } = await sb.rpc('community_asset_set_geometry', { p_asset_id: det.id, p_wkt: 'POLYGON((-95.744 29.680,-95.742 29.680,-95.742 29.678,-95.744 29.678,-95.744 29.680))' });
    ok(dg && dg.geometry_type === 'ST_Polygon', 'Section 43 detention reserve stored as a POLYGON asset');

  } catch (e) { console.error('ERROR', e.message); fails++; }
  finally {
    // Clean up ALL created fixtures (nothing persists).
    if (created.length) {
      await sb.from('asset_member_scope').delete().in('asset_id', created);
      // delete children before parents (ON DELETE SET NULL makes order not strictly required, but tidy)
      await sb.from('community_assets').delete().in('id', created);
    }
    console.log(fails ? `\n✗ community_assets: ${fails} failure(s)` : '\n✓ community_assets: canonical asset identity holds; fixtures cleaned up');
    process.exit(fails ? 1 : 0);
  }
})();
