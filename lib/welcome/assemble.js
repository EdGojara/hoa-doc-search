// ============================================================================
// lib/welcome/assemble.js — build the welcome-packet bundle for one property.
// ----------------------------------------------------------------------------
// Extract → validate → render, stage one. This file does the reading and the
// deciding; lib/welcome/render.js does nothing but print what it is handed.
//
// Two hard rules shape it:
//
//   1. NOTHING IS INVENTED. Every fact printed to a new owner comes out of the
//      canonical table for that fact — trash from communities.trash_schedule,
//      numbers from community_contacts, amenities from amenities, "what gets
//      noticed here" from this community's own violations. If a table is empty
//      the section does not print. There is no filler copy, because filler copy
//      addressed to a homeowner is a statement the association did not make.
//
//   2. AN EMPTY SECTION IS REPORTED, NOT SWALLOWED. `missing` comes back beside
//      `sections`, so the operator sees "Quail Ridge has no contacts and no
//      trash schedule" BEFORE sending, not after the owner notices. A thin
//      packet that renders silently is the silent-failure shape this codebase
//      keeps getting bitten by.
//
// Read-only. Nothing here writes.
// ============================================================================

const { fetchAllQuery } = require('../db/fetch_all');
const { SECTIONS } = require('./sections');
const { canDo } = require('../community/lifecycle');

const COMMUNITY_BASE_COLUMNS = [
  'id', 'name', 'slug', 'legal_name', 'website_url', 'profile', 'trash_schedule',
  'portal_active', 'portal_module_config',
  'acc_fee_cents', 'acc_fee_payer', 'arc_active', 'financials_active',
  'letter_sender_name', 'letter_sender_title', 'management_status', 'is_demo',
];
// welcome_packet_note arrives with migration 384. Code deploys before a
// migration is applied through the admin runner, and PostgREST fails the WHOLE
// select on one unknown column, so asking for it unconditionally would 500
// every packet in that window. Ask once, fall back once, cache the answer.
let HAS_WELCOME_NOTE = null;

async function readCommunity(supabase, community_id) {
  const cols = COMMUNITY_BASE_COLUMNS.slice();
  if (HAS_WELCOME_NOTE !== false) cols.push('welcome_packet_note');
  const { data, error } = await supabase.from('communities')
    .select(cols.join(', ')).eq('id', community_id).maybeSingle();
  if (!error) {
    if (HAS_WELCOME_NOTE === null) HAS_WELCOME_NOTE = true;
    return data;
  }
  if (HAS_WELCOME_NOTE !== false && /welcome_packet_note|schema cache|does not exist/i.test(error.message || '')) {
    console.warn('[welcome] welcome_packet_note not present yet (migration 384 unapplied) — packets print without the community note.');
    HAS_WELCOME_NOTE = false;
    const retry = await supabase.from('communities')
      .select(COMMUNITY_BASE_COLUMNS.join(', ')).eq('id', community_id).maybeSingle();
    if (retry.error) throw retry.error;
    return retry.data;
  }
  throw error;
}

// Enforcement stages that mean the case is still open. Matches the list in
// api/home_sales.js — kept in step deliberately; both answer "is this live".
const OPEN_STAGES = ['courtesy_1', 'courtesy_2', 'certified_209', 'fine_assessed'];

// Governing-document categories a homeowner is actually entitled to read.
// Financial and vendor documents are association records too, but they are not
// what a new owner needs on day one, and listing them invites a request we
// would have to route through the board.
const HOMEOWNER_DOC_CATEGORIES = [
  ['declaration_ccrs', 'Declaration of Covenants, Conditions & Restrictions'],
  ['bylaws', 'Bylaws'],
  ['rules_and_regulations', 'Rules and Regulations'],
  ['resolutions_and_policies', 'Board resolutions and policies'],
  ['design_document', 'Architectural design guidelines'],
  ['arc_application', 'Architectural review application'],
  ['forms_and_applications', 'Forms and applications'],
  ['annual_budget', 'Annual budget'],
];

const titleCaseDay = (d) => String(d || '').charAt(0).toUpperCase() + String(d || '').slice(1);
const money = (cents) => '$' + (Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Assemble everything a welcome packet prints for one property.
 *
 * @param {object} supabase service-role client
 * @param {object} opts
 * @param {string} opts.community_id  required
 * @param {string} opts.property_id   required
 * @param {string} [opts.occasion]    'resale' | 'new_construction' | 'onboarding' | 'manual'
 * @param {string} [opts.owner_name]  overrides the owner of record (a buyer we
 *                                    just recorded may not have propagated yet)
 * @param {string} [opts.owner_email]
 * @param {string} [opts.effective_date] closing date, where there is one
 * @param {string} [opts.today]       injectable for tests
 *
 * @returns {Promise<object>} bundle. `allowed:false` means the lifecycle gate
 *   refused (or the ids do not resolve) — see `reason`.
 */
async function assembleWelcomePacket(supabase, opts = {}) {
  const { community_id, property_id } = opts;
  if (!community_id) throw new Error('community_id required');
  if (!property_id) throw new Error('property_id required');
  const today = opts.today || new Date().toISOString().slice(0, 10);

  // The gate first. Assembling a packet for a community we are handing off
  // wastes a Chrome launch and, worse, produces an artifact somebody might send.
  const gate = await canDo('welcome', community_id, { today });
  if (!gate.allowed) {
    return {
      allowed: false, reason: gate.reason, community: gate.row || null,
      property: null, owner: null, sections: {}, included: [], missing: [],
    };
  }

  const [community, propRes, ownerRes] = await Promise.all([
    readCommunity(supabase, community_id),
    supabase.from('properties')
      .select('id, community_id, street_address, unit, city, state, zip')
      .eq('id', property_id).maybeSingle(),
    supabase.from('v_current_property_owners').select('*').eq('property_id', property_id).maybeSingle(),
  ]);
  if (propRes.error) throw propRes.error;
  if (ownerRes.error) throw ownerRes.error;

  const property = propRes.data;
  const empty = { sections: {}, included: [], missing: [] };
  if (!community) return { allowed: false, reason: 'community_not_found', community: null, property: null, owner: null, ...empty };
  if (!property) return { allowed: false, reason: 'property_not_found', community, property: null, owner: null, ...empty };
  // Defense in depth: never assemble across a community boundary.
  if (property.community_id !== community_id) {
    return { allowed: false, reason: 'property_not_in_community', community, property: null, owner: null, ...empty };
  }

  const ownerRow = ownerRes.data || null;
  const owner = {
    // A closing we just recorded is the newer fact than the view, so an
    // explicitly supplied name wins.
    name: opts.owner_name || (ownerRow && ownerRow.owner_name) || null,
    email: opts.owner_email || (ownerRow && (ownerRow.owner_email || ownerRow.primary_email)) || null,
    contact_id: (ownerRow && ownerRow.owner_contact_id) || null,
    of_record_name: (ownerRow && ownerRow.owner_name) || null,
  };

  const profile = community.profile || {};
  const sections = {};

  // -- welcome ---------------------------------------------------------------
  sections.welcome = {
    community_name: community.name,
    legal_name: community.legal_name || null,
    property_address: [property.street_address, property.unit].filter(Boolean).join(' '),
    city_state_zip: [property.city, [property.state, property.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    owner_name: owner.name,
    effective_date: opts.effective_date || null,
    note: community.welcome_packet_note || null,   // null until migration 384
  };

  // -- contacts + amenities (read once, used by three sections) --------------
  const [contactsRes, amenRes] = await Promise.all([
    supabase.from('community_contacts')
      .select('id, category, name, phone, email, url, notes, display_order')
      .eq('community_id', community_id).eq('is_published', true)
      .order('display_order').limit(200),
    supabase.from('amenities')
      .select('id, name, amenity_type, hours_text, is_rentable, street_address, status, display_order')
      .eq('community_id', community_id).order('display_order').limit(100),
  ]);
  if (contactsRes.error) throw contactsRes.error;
  if (amenRes.error) throw amenRes.error;

  const allContacts = contactsRes.data || [];
  const mgmtContacts = allContacts.filter((c) => c.category === 'management');
  const otherContacts = allContacts.filter((c) => c.category !== 'management');

  // -- manager ---------------------------------------------------------------
  // This one ALWAYS prints. "Who do I call" is the whole reason a new owner
  // keeps the packet, and Bedrock's office line is a fact we always have. What
  // can be missing is the NAMED manager, and that is reported as a gap on a
  // section that still printed rather than by dropping the section.
  const managerName = community.letter_sender_name || profile.primary_contact_name || null;
  sections.manager = {
    manager_name: managerName,
    manager_title: community.letter_sender_title || (managerName ? 'Community Manager' : null),
    onsite: profile.onsite === 'yes',
    onsite_hours: profile.onsite_hours || profile.office_hours || null,
    community_email: profile.primary_email || null,
    community_phone: profile.primary_phone || null,
    extra: mgmtContacts,
    // Read by the readiness loop below, stripped before the snapshot is stored.
    _gap: managerName ? null : 'No named community manager, so the packet gives the office line only.',
  };

  // -- assessments -----------------------------------------------------------
  // Suppressed entirely when financial work is off for the community: telling a
  // new owner what to pay and where, for books we do not keep, is worse than
  // saying nothing.
  const annual = Number(profile.assessment_annual);
  sections.assessments = (community.financials_active !== false && Number.isFinite(annual) && annual > 0) ? {
    annual_dollars: annual,
    frequency: profile.assessment_frequency || 'annual',
    fiscal_year_end: profile.fiscal_year_end || null,
    online_payments: community.portal_active === true,
  } : null;

  // -- portal ----------------------------------------------------------------
  const modules = community.portal_module_config || {};
  const liveTiles = Object.entries(modules)
    .filter((entry) => entry[1] && entry[1].status === 'live')
    .map((entry) => entry[0]);
  sections.portal = community.portal_active === true ? {
    url: profile.homeowner_portal_url || community.website_url || null,
    tiles: liveTiles,
  } : null;

  // -- claire ----------------------------------------------------------------
  // The differentiator, and cheap: this is TEXT introducing Claire, not the
  // embodied video (that is metered and belongs in the QR onboarding flow, not
  // printed per owner). Only prints where Claire is actually live for the
  // community, so "just ask Claire" is a promise the platform keeps.
  const claireLive = community.portal_active === true && !!(modules.claire && modules.claire.status === 'live');
  sections.claire = claireLive ? {
    in_portal: true,
  } : null;

  // -- arc -------------------------------------------------------------------
  const accFee = Number(community.acc_fee_cents || 0);
  sections.arc = community.arc_active !== false ? {
    fee_cents: accFee,
    fee_payer: community.acc_fee_payer || 'community',
    // Only a fee the HOMEOWNER pays belongs in a homeowner's packet. A fee on
    // the association's Bedrock bill is not their business and quoting it reads
    // as a charge they will see.
    fee_label: (accFee > 0 && community.acc_fee_payer === 'homeowner') ? money(accFee) : null,
    submit_via_portal: community.portal_active === true && !!(modules.arc && modules.arc.status === 'live'),
    guidelines_on_file: false, // set from the document scan below
  } : null;

  // -- compliance: what this community actually cites ------------------------
  // The most useful page in the packet, and the one no competitor can print:
  // not "please comply with the covenants" but the five things owners HERE were
  // actually noticed for in the last twelve months.
  const since = new Date(new Date(today + 'T00:00:00Z').getTime() - 365 * 864e5).toISOString().slice(0, 10);
  const violations = await fetchAllQuery(
    () => supabase.from('violations')
      .select('id, primary_category_id, opened_at, current_stage')
      .eq('community_id', community_id)
      .gte('opened_at', since),
    { orderBy: 'id', pageSize: 1000, cap: 60000 },
  );

  const counts = new Map();
  for (const v of violations) {
    if (!v.primary_category_id) continue;
    counts.set(v.primary_category_id, (counts.get(v.primary_category_id) || 0) + 1);
  }
  const topIds = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map((e) => e[0]);

  let topCategories = [];
  if (topIds.length) {
    const [catRes, prioRes] = await Promise.all([
      supabase.from('enforcement_categories')
        .select('id, label, observation_template').in('id', topIds),
      // The counsel-verified covenant hook, where one has been locked in for
      // this community. Never AI-generated at print time: a covenant quote in a
      // homeowner's hands is an assertion about their deed.
      supabase.from('community_enforcement_priorities')
        .select('category_id, governing_doc_reference, governing_doc_section_title, governing_doc_quote')
        .eq('community_id', community_id).in('category_id', topIds).is('end_date', null),
    ]);
    if (catRes.error) throw catRes.error;
    if (prioRes.error) throw prioRes.error;
    const byId = Object.fromEntries((catRes.data || []).map((c) => [c.id, c]));
    const citeById = Object.fromEntries((prioRes.data || []).map((p) => [p.category_id, p]));
    topCategories = topIds.map((id) => {
      const cat = byId[id];
      if (!cat) return null;
      const cite = citeById[id] || {};
      return {
        label: cat.label,
        count: counts.get(id),
        // observation_template ONLY. enforcement_categories.description is
        // written for the inspector, not the owner — it says things like "for
        // loose garbage use Trash Debris instead", which is our taxonomy
        // leaking into a homeowner's mail. observation_template is the phrasing
        // that already goes out in letters, so it is safe to print.
        what_it_means: cat.observation_template || null,
        citation_reference: cite.governing_doc_reference || null,
        citation_title: cite.governing_doc_section_title || null,
        citation_quote: cite.governing_doc_quote || null,
      };
    }).filter(Boolean).slice(0, 5);
  }

  sections.compliance = topCategories.length ? {
    window_months: 12,
    total_opened: violations.length,
    still_open: violations.filter((v) => OPEN_STAGES.indexOf(v.current_stage) !== -1).length,
    categories: topCategories,
  } : null;

  // -- trash -----------------------------------------------------------------
  const ts = community.trash_schedule || null;
  const collection = (ts && Array.isArray(ts.collection_days)) ? ts.collection_days : [];
  sections.trash = (collection.length || (ts && ts.notes)) ? {
    collection_days: collection.map(titleCaseDay),
    recycling_days: (Array.isArray(ts.recycling_days) ? ts.recycling_days : []).map(titleCaseDay),
    curbside_deadline: ts.curbside_deadline || null,
    heavy_trash_pattern: ts.heavy_trash_pattern || null,
    holidays_no_service: ts.holidays_no_service === true,
    notes: ts.notes || null,
    vendor: allContacts.find((c) => c.category === 'trash') || null,
  } : null;

  // -- amenities -------------------------------------------------------------
  const amenities = (amenRes.data || []).filter((a) => !a.status || a.status === 'active');
  sections.amenities = amenities.length ? {
    items: amenities.map((a) => ({
      name: a.name,
      type: a.amenity_type,
      hours: a.hours_text || null,
      rentable: a.is_rentable === true,
      address: a.street_address || null,
    })),
  } : null;

  // -- contacts --------------------------------------------------------------
  sections.contacts = otherContacts.length ? { items: otherContacts } : null;

  // -- documents -------------------------------------------------------------
  const { data: docRows, error: docErr } = await supabase.from('library_documents')
    .select('id, title, category')
    .eq('community_id', community_id)
    .in('category', HOMEOWNER_DOC_CATEGORIES.map((p) => p[0]))
    .limit(500);
  if (docErr) throw docErr;
  const haveCats = new Set((docRows || []).map((d) => d.category));
  const docList = HOMEOWNER_DOC_CATEGORIES.filter((p) => haveCats.has(p[0])).map((p) => ({ category: p[0], label: p[1] }));
  sections.documents = docList.length ? {
    items: docList,
    via_portal: !!(community.portal_active && modules.documents && modules.documents.status === 'live'),
  } : null;
  if (sections.arc) sections.arc.guidelines_on_file = haveCats.has('design_document');

  // -- readiness -------------------------------------------------------------
  // Two kinds of gap, reported the same way so neither can hide:
  //   absent  — the section did not print at all
  //   partial — it printed, but a fact inside it is missing
  const included = [];
  const missing = [];
  for (const def of SECTIONS) {
    const sec = sections[def.key];
    if (!sec) {
      missing.push({ key: def.key, title: def.title, fix: def.fix, required: !!def.required, partial: false });
      continue;
    }
    included.push(def.key);
    if (sec._gap) {
      missing.push({ key: def.key, title: def.title, fix: def.fix, required: !!def.required, partial: true, detail: sec._gap });
    }
    delete sec._gap;
  }

  return {
    allowed: true,
    reason: null,
    community,
    property,
    owner,
    occasion: opts.occasion || 'resale',
    effective_date: opts.effective_date || null,
    generated_at: new Date().toISOString(),
    sections,
    included,
    missing,
  };
}

module.exports = { assembleWelcomePacket, HOMEOWNER_DOC_CATEGORIES };
