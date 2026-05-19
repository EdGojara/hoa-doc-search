// ============================================================================
// Contacts / Properties API
// ----------------------------------------------------------------------------
// Endpoints under /api/contacts/* and /api/properties/* for the Homes &
// Owners module. Backs the data spine (migration 049) — properties,
// contacts, ownerships, residencies, and the Vantaca-upload diff workflow.
//
// Endpoints (v1):
//   POST   /api/contacts/vantaca/upload     — parse upload, return diff preview, persist sync_log row
//   POST   /api/contacts/vantaca/apply/:id  — apply approved selections from a previewed sync_log
//   GET    /api/contacts/vantaca/recent     — recent sync_log entries
//   GET    /api/properties                  — list (by community, owner, etc.)
//   GET    /api/properties/:id              — full detail (owner + resident + history)
//   POST   /api/properties                  — manual create
//   PATCH  /api/properties/:id              — manual edit
//   GET    /api/contacts                    — list (by search, etc.)
//   POST   /api/contacts                    — manual create
//   PATCH  /api/contacts/:id                — manual edit
//   GET    /api/contacts/occupancy-summary  — per-community owner-occupancy rollup
//
// Apply flow is intentionally explicit: nothing in the parsed upload writes
// to the live spine until staff POSTs to /apply with the list of selections
// they approve. Diff sits in sync_log until then.
// ============================================================================

const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { parseVantacaExport, computeDiff } = require('../lib/contacts/vantaca_import');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const router = express.Router();

// ---------------------------------------------------------------------------
// VANTACA UPLOAD — parse + diff + preview (no writes to spine yet)
// ---------------------------------------------------------------------------
router.post('/contacts/vantaca/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'No file uploaded.' });
    const communityId = req.body.community_id;
    if (!communityId) return res.status(400).json({ error: 'community_id is required.' });

    const { rows, mapping, headers, errors } = parseVantacaExport(req.file.buffer, req.file.originalname);
    if (errors && errors.length > 0 && rows.length === 0) {
      return res.status(400).json({ error: errors.join(' '), headers });
    }

    const diff = await computeDiff(supabase, communityId, rows);
    const summary = {
      new_properties:          diff.new_properties.length,
      property_field_changes:  diff.property_field_changes.length,
      new_ownerships:          diff.new_ownerships.length,
      ownership_changes:       diff.ownership_changes.length,
      new_residencies:         diff.new_residencies.length,
      email_additions:         diff.email_additions.length,
      phone_additions:         diff.phone_additions.length,
      duplicate_rows:          (diff.duplicate_rows || []).length,
    };

    // Existing-property count for sanity-check banner ("upload has 134 rows,
    // community has 101 properties on file — is the export complete or are
    // there duplicates?").
    const { count: existingPropCount } = await supabase
      .from('properties')
      .select('id', { count: 'exact', head: true })
      .eq('community_id', communityId);

    // Sample rows for the diagnostic preview — staff verifies that the columns
    // we auto-detected actually contain what we think they do (e.g., catches
    // "owner_name" mapped to a numeric account-ID column).
    const sampleRows = (rows || []).slice(0, 3).map((row) => ({
      source_row:     row._source_row,
      account_id:     row.account_id,
      street_address: row.street_address,
      unit:           row.unit,
      city:           row.city,
      zip:            row.zip,
      owner_name:     row.owner_name,
      owner_email:    row.owner_email,
      resident_name:  row.resident_name,
      residency_type: row.residency_type,
    }));

    const { data: logRow, error: logErr } = await supabase
      .from('vantaca_sync_log')
      .insert({
        community_id: communityId,
        uploaded_by: req.body.uploaded_by || null,
        file_name: req.file.originalname || null,
        total_rows: rows.length,
        column_mapping: mapping,
        parsed_data: rows,
        diff_summary: { ...summary, detail: diff },
        status: 'previewed',
      })
      .select()
      .single();
    if (logErr) return res.status(500).json({ error: logErr.message });

    res.json({
      sync_log_id: logRow.id,
      file_name: req.file.originalname,
      total_rows: rows.length,
      existing_property_count: existingPropCount || 0,
      file_headers: headers || [],
      column_mapping: mapping,
      sample_rows: sampleRows,
      diff,
      summary,
      parser_warnings: errors || [],
    });
  } catch (err) {
    console.error('[contacts/vantaca/upload]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// VANTACA APPLY — commit selected diff items from a previewed sync_log row.
// Body shape:
//   {
//     apply: {
//       new_properties: [row_index, row_index, ...],     // selections by source_row
//       property_field_changes: [property_id, ...],
//       new_ownerships: [property_id, ...],
//       ownership_changes: [property_id, ...],
//       new_residencies: [property_id, ...],
//       email_additions: [contact_id, ...],
//       phone_additions: [contact_id, ...],
//     }
//   }
// "all" can be passed instead of arrays to apply everything in that category.
// ---------------------------------------------------------------------------
router.post('/contacts/vantaca/apply/:id', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const { data: log, error } = await supabase
      .from('vantaca_sync_log')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error || !log) return res.status(404).json({ error: 'sync_log not found' });
    if (log.status === 'applied') return res.status(409).json({ error: 'Already applied.' });

    const diff = (log.diff_summary && log.diff_summary.detail) || {};
    const apply = (req.body && req.body.apply) || {};
    const applied = {
      properties_created:    0,
      properties_updated:    0,
      contacts_created:      0,
      ownerships_created:    0,
      ownerships_ended:      0,
      residencies_created:   0,
      emails_updated:        0,
      phones_updated:        0,
    };
    const today = new Date().toISOString().slice(0, 10);

    // Helper: find or create a contact by name + email. Match is fuzzy on name
    // and exact on email (when both provided).
    async function findOrCreateContact({ full_name, primary_email, primary_phone, mailing_address }) {
      if (!full_name) return null;
      const nameNorm = full_name.toLowerCase().trim();
      let { data: matches } = await supabase
        .from('contacts')
        .select('*')
        .ilike('full_name', `%${nameNorm}%`)
        .limit(5);
      let match = null;
      if (matches && matches.length > 0) {
        // Prefer exact-name + same email; else exact-name; else first.
        match = matches.find((m) => m.full_name.toLowerCase().trim() === nameNorm && (primary_email ? (m.primary_email || '').toLowerCase() === primary_email.toLowerCase() : true))
             || matches.find((m) => m.full_name.toLowerCase().trim() === nameNorm)
             || matches[0];
      }
      if (match) return match;
      const { data: created, error: cErr } = await supabase
        .from('contacts')
        .insert({
          full_name,
          primary_email: primary_email || null,
          primary_phone: primary_phone || null,
          mailing_address: mailing_address || null,
        })
        .select()
        .single();
      if (cErr) throw cErr;
      applied.contacts_created += 1;
      return created;
    }

    // --- NEW PROPERTIES ----------------------------------------------------
    const wantNewProps = apply.new_properties === 'all' || Array.isArray(apply.new_properties);
    if (wantNewProps && diff.new_properties) {
      const select = apply.new_properties === 'all' ? null : new Set(apply.new_properties);
      for (const item of diff.new_properties) {
        if (select && !select.has(item.row)) continue;
        const { data: newProp, error: pErr } = await supabase
          .from('properties')
          .insert({
            community_id: log.community_id,
            street_address: item.property.street_address,
            unit: item.property.unit,
            city: item.property.city,
            state: item.property.state,
            zip: item.property.zip,
            lot_number: item.property.lot_number,
            vantaca_account_id: item.property.vantaca_account_id,
          })
          .select()
          .single();
        if (pErr) { console.warn('[apply/new_property]', pErr.message); continue; }
        applied.properties_created += 1;
        if (item.proposed_owner) {
          const contact = await findOrCreateContact(item.proposed_owner);
          if (contact) {
            await supabase.from('property_ownerships').insert({
              property_id: newProp.id,
              contact_id: contact.id,
              start_date: today,
              vesting: item.proposed_owner.vesting,
              is_primary: true,
              source: 'vantaca_import',
            });
            applied.ownerships_created += 1;
          }
        }
      }
    }

    // --- PROPERTY FIELD CHANGES --------------------------------------------
    const wantFieldChanges = apply.property_field_changes === 'all' || Array.isArray(apply.property_field_changes);
    if (wantFieldChanges && diff.property_field_changes) {
      const select = apply.property_field_changes === 'all' ? null : new Set(apply.property_field_changes);
      for (const item of diff.property_field_changes) {
        if (select && !select.has(item.property_id)) continue;
        const patch = { updated_at: new Date().toISOString() };
        for (const [field, change] of Object.entries(item.changes)) patch[field] = change.to;
        const { error: uErr } = await supabase.from('properties').update(patch).eq('id', item.property_id);
        if (!uErr) applied.properties_updated += 1;
      }
    }

    // --- OWNERSHIP CHANGES (close old, open new) ---------------------------
    const wantOwnerChanges = apply.ownership_changes === 'all' || Array.isArray(apply.ownership_changes);
    if (wantOwnerChanges && diff.ownership_changes) {
      const select = apply.ownership_changes === 'all' ? null : new Set(apply.ownership_changes);
      for (const item of diff.ownership_changes) {
        if (select && !select.has(item.property_id)) continue;
        // End all current ownerships on this property.
        const { data: ended } = await supabase
          .from('property_ownerships')
          .update({ end_date: today, updated_at: new Date().toISOString() })
          .eq('property_id', item.property_id)
          .is('end_date', null)
          .select();
        if (ended) applied.ownerships_ended += ended.length;
        // Open new ownership.
        const contact = await findOrCreateContact({
          full_name: item.new_owner,
          primary_email: item.new_email,
          primary_phone: item.new_phone,
        });
        if (contact) {
          await supabase.from('property_ownerships').insert({
            property_id: item.property_id,
            contact_id: contact.id,
            start_date: today,
            is_primary: true,
            source: 'vantaca_import',
          });
          applied.ownerships_created += 1;
        }
      }
    }

    // --- NEW OWNERSHIPS (property has no current owner on file) -----------
    const wantNewOwn = apply.new_ownerships === 'all' || Array.isArray(apply.new_ownerships);
    if (wantNewOwn && diff.new_ownerships) {
      const select = apply.new_ownerships === 'all' ? null : new Set(apply.new_ownerships);
      for (const item of diff.new_ownerships) {
        if (select && !select.has(item.property_id)) continue;
        const contact = await findOrCreateContact({
          full_name: item.contact_name,
          primary_email: item.contact_email,
          primary_phone: item.contact_phone,
        });
        if (contact) {
          await supabase.from('property_ownerships').insert({
            property_id: item.property_id,
            contact_id: contact.id,
            start_date: today,
            vesting: item.vesting,
            is_primary: true,
            source: 'vantaca_import',
          });
          applied.ownerships_created += 1;
        }
      }
    }

    // --- NEW RESIDENCIES (renter detection) -------------------------------
    const wantNewRes = apply.new_residencies === 'all' || Array.isArray(apply.new_residencies);
    if (wantNewRes && diff.new_residencies) {
      const select = apply.new_residencies === 'all' ? null : new Set(apply.new_residencies);
      for (const item of diff.new_residencies) {
        if (select && !select.has(item.property_id)) continue;
        // End any open residency on this property first.
        await supabase
          .from('property_residencies')
          .update({ end_date: today, updated_at: new Date().toISOString() })
          .eq('property_id', item.property_id)
          .is('end_date', null);
        const contact = await findOrCreateContact({
          full_name: item.resident_name,
          primary_email: item.resident_email,
          primary_phone: item.resident_phone,
        });
        await supabase.from('property_residencies').insert({
          property_id: item.property_id,
          contact_id: contact ? contact.id : null,
          start_date: today,
          residency_type: item.residency_type || 'renter',
          source: 'vantaca_import',
        });
        applied.residencies_created += 1;
      }
    }

    // --- EMAIL ADDITIONS (existing contact gets a new/updated email) ------
    const wantEmails = apply.email_additions === 'all' || Array.isArray(apply.email_additions);
    if (wantEmails && diff.email_additions) {
      const select = apply.email_additions === 'all' ? null : new Set(apply.email_additions);
      for (const item of diff.email_additions) {
        if (select && !select.has(item.contact_id)) continue;
        const { error: eErr } = await supabase
          .from('contacts')
          .update({ primary_email: item.new_email, updated_at: new Date().toISOString() })
          .eq('id', item.contact_id);
        if (!eErr) applied.emails_updated += 1;
      }
    }

    // --- PHONE ADDITIONS ---------------------------------------------------
    const wantPhones = apply.phone_additions === 'all' || Array.isArray(apply.phone_additions);
    if (wantPhones && diff.phone_additions) {
      const select = apply.phone_additions === 'all' ? null : new Set(apply.phone_additions);
      for (const item of diff.phone_additions) {
        if (select && !select.has(item.contact_id)) continue;
        const { error: pErr } = await supabase
          .from('contacts')
          .update({ primary_phone: item.new_phone, updated_at: new Date().toISOString() })
          .eq('id', item.contact_id);
        if (!pErr) applied.phones_updated += 1;
      }
    }

    await supabase
      .from('vantaca_sync_log')
      .update({
        status: 'applied',
        applied_at: new Date().toISOString(),
        applied_by: (req.body && req.body.applied_by) || null,
        applied_summary: applied,
      })
      .eq('id', log.id);

    res.json({ ok: true, applied });
  } catch (err) {
    console.error('[contacts/vantaca/apply]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// INFER RESIDENCY — scan existing properties in a community and populate
// property_residencies based on the contact-mailing-vs-property-address
// signal we already captured during the Vantaca upload.
//
// Rule:
//   - Primary owner's contact has a mailing_address that does NOT contain
//     the property's street_address (case-insensitive substring) → renter
//     (residency_type='renter', contact_id=null, since actual resident is unknown)
//   - Otherwise (no mailing_address, or mailing matches property)
//     → owner_occupied with contact_id = the owner's contact
//
// Idempotent: properties that already have an active residency record are
// left alone. Caller passes ?force=1 to override (closes existing + replaces).
//
// Returns:
//   { processed, created_renter, created_owner_occupied, skipped_existing, errors }
// ---------------------------------------------------------------------------
router.post('/contacts/infer-residency', express.json(), async (req, res) => {
  try {
    const communityId = (req.body && req.body.community_id) || req.query.community_id;
    if (!communityId) return res.status(400).json({ error: 'community_id is required.' });
    const force = req.body && req.body.force;
    const today = new Date().toISOString().slice(0, 10);
    // Batch size — keeps .in() URL under PostgREST's ~8KB ceiling
    // (200 UUIDs × ~38 chars + commas = ~7.6KB). Tuned for safety.
    const BATCH = 200;

    // Pull all properties for the community.
    const { data: properties, error: pErr } = await supabase
      .from('properties')
      .select('id, street_address, unit, city, state, zip')
      .eq('community_id', communityId);
    if (pErr) return res.status(500).json({ error: pErr.message });

    if (!properties || properties.length === 0) {
      return res.json({ processed: 0, created_renter: 0, created_owner_occupied: 0, skipped_existing: 0, errors: [] });
    }

    // Batch the .in() queries so large communities (1000+ properties)
    // don't blow past PostgREST's URL-length limit.
    const ownersByProp = new Map();
    const propsWithActiveResidency = new Set();
    for (let i = 0; i < properties.length; i += BATCH) {
      const chunkIds = properties.slice(i, i + BATCH).map((p) => p.id);
      const [oRes, rRes] = await Promise.all([
        supabase.from('property_ownerships')
          .select('property_id, contact_id, is_primary, end_date, contacts(id, full_name, mailing_address)')
          .in('property_id', chunkIds)
          .is('end_date', null),
        supabase.from('property_residencies')
          .select('property_id')
          .in('property_id', chunkIds)
          .is('end_date', null),
      ]);
      if (oRes.error) return res.status(500).json({ error: 'ownership query: ' + oRes.error.message });
      if (rRes.error) return res.status(500).json({ error: 'residency query: ' + rRes.error.message });
      (oRes.data || []).forEach((o) => {
        const existing = ownersByProp.get(o.property_id);
        if (!existing || (o.is_primary && !existing.is_primary)) ownersByProp.set(o.property_id, o);
      });
      (rRes.data || []).forEach((r) => propsWithActiveResidency.add(r.property_id));
    }

    // Build all the residency rows in memory first, then bulk insert in
    // batches. Single insert call per batch = ~5 calls for 1000 properties
    // vs 1000 individual calls = avoids both PostgREST hammering and the
    // request-timeout cliff that was killing Waterview (1171 properties).
    let createdRenter = 0;
    let createdOwner  = 0;
    let createdUnknown = 0;
    let skipped       = 0;
    const toInsert = [];
    const forceCloseIds = [];

    for (const prop of properties) {
      if (!force && propsWithActiveResidency.has(prop.id)) { skipped += 1; continue; }
      const ownership = ownersByProp.get(prop.id);
      const contact   = ownership && ownership.contacts;
      const mailing   = contact && contact.mailing_address;

      let residencyType = 'owner_occupied';
      let residencyContactId = ownership ? ownership.contact_id : null;
      if (mailing && prop.street_address) {
        const mailNorm = mailing.toLowerCase().replace(/\s+/g, ' ').trim();
        const propNorm = prop.street_address.toLowerCase().replace(/\s+/g, ' ').trim();
        const propHouseNumMatch = propNorm.match(/^\d+/);
        const houseNum = propHouseNumMatch ? propHouseNumMatch[0] : '';
        const propIsInMailing = houseNum && mailNorm.includes(houseNum) && mailNorm.includes(propNorm.replace(/^\d+\s*/, ''));
        if (!propIsInMailing) {
          residencyType = 'renter';
          residencyContactId = null;
        }
      }
      if (!ownership) {
        residencyType = 'unknown';
        residencyContactId = null;
      }

      if (force && propsWithActiveResidency.has(prop.id)) {
        forceCloseIds.push(prop.id);
      }
      toInsert.push({
        property_id:    prop.id,
        contact_id:     residencyContactId,
        start_date:     today,
        residency_type: residencyType,
        source:         'inferred_from_mailing_address',
      });
      if (residencyType === 'renter') createdRenter += 1;
      else if (residencyType === 'owner_occupied') createdOwner += 1;
      else createdUnknown += 1;
    }

    // Force-close in batches if requested
    const errors = [];
    if (force && forceCloseIds.length > 0) {
      for (let i = 0; i < forceCloseIds.length; i += BATCH) {
        const chunk = forceCloseIds.slice(i, i + BATCH);
        const { error: cErr } = await supabase
          .from('property_residencies')
          .update({ end_date: today, updated_at: new Date().toISOString() })
          .in('property_id', chunk)
          .is('end_date', null);
        if (cErr) errors.push({ phase: 'force_close', error: cErr.message });
      }
    }

    // Bulk insert in batches
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const chunk = toInsert.slice(i, i + BATCH);
      const { error: insErr } = await supabase.from('property_residencies').insert(chunk);
      if (insErr) {
        errors.push({ phase: 'insert', batch_start: i, error: insErr.message });
        // Subtract the failed batch from counts so the summary is honest
        chunk.forEach((row) => {
          if (row.residency_type === 'renter') createdRenter -= 1;
          else if (row.residency_type === 'owner_occupied') createdOwner -= 1;
          else createdUnknown -= 1;
        });
      }
    }

    res.json({
      processed: properties.length,
      created_renter: createdRenter,
      created_owner_occupied: createdOwner,
      created_unknown: createdUnknown,
      skipped_existing: skipped,
      errors,
    });
  } catch (err) {
    console.error('[contacts/infer-residency]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Recent sync log entries (for the "Recent uploads" panel).
// ---------------------------------------------------------------------------
router.get('/contacts/vantaca/recent', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('vantaca_sync_log')
      .select('id, community_id, uploaded_by, uploaded_at, file_name, total_rows, diff_summary, status, applied_at, applied_summary')
      .order('uploaded_at', { ascending: false })
      .limit(20);
    if (error) return res.status(500).json({ error: error.message });
    // Strip the heavy detail blob from the list response.
    const slim = (data || []).map((r) => ({
      ...r,
      diff_summary: r.diff_summary
        ? { ...r.diff_summary, detail: undefined }
        : null,
    }));
    res.json({ uploads: slim });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// COMMUNITIES — basic list endpoint. Returns active communities for this
// management company, sorted by name. Used by every UI that needs a
// community dropdown (Inspect, Homes & Owners, etc.). Lives here because
// the contacts router is already mounted at /api and the communities list
// is structural data the spine depends on.
//
// Query params (all optional):
//   include_inactive=1   include inactive communities too
// ---------------------------------------------------------------------------
router.get('/communities', async (req, res) => {
  try {
    let q = supabase
      .from('communities')
      .select('id, name, legal_name, slug, vantaca_code, total_lots, active')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('name');
    if (req.query.include_inactive !== '1') q = q.eq('active', true);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ communities: data || [] });
  } catch (err) {
    console.error('[communities.list]', err);
    res.status(500).json({ error: err.message || 'failed to list communities' });
  }
});

// ---------------------------------------------------------------------------
// PROPERTIES
// ---------------------------------------------------------------------------
router.get('/properties', async (req, res) => {
  try {
    const communityId = req.query.community_id;
    let q = supabase.from('v_current_property_owners').select('*');
    if (communityId) q = q.eq('community_id', communityId);
    q = q.order('street_address').limit(2000);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ properties: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/properties/:id', async (req, res) => {
  try {
    const { data: prop, error } = await supabase
      .from('properties')
      .select('*, communities(id, name)')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error || !prop) return res.status(404).json({ error: 'not found' });

    const [{ data: ownerships }, { data: residencies }] = await Promise.all([
      supabase.from('property_ownerships')
        .select('*, contacts(id, full_name, primary_email, primary_phone)')
        .eq('property_id', req.params.id)
        .order('start_date', { ascending: false }),
      supabase.from('property_residencies')
        .select('*, contacts(id, full_name, primary_email, primary_phone)')
        .eq('property_id', req.params.id)
        .order('start_date', { ascending: false }),
    ]);

    res.json({ property: prop, ownerships: ownerships || [], residencies: residencies || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/properties', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.community_id || !b.street_address) {
      return res.status(400).json({ error: 'community_id and street_address are required.' });
    }
    const { data, error } = await supabase
      .from('properties')
      .insert({
        community_id: b.community_id,
        street_address: b.street_address,
        unit: b.unit || null,
        city: b.city || null,
        state: b.state || 'TX',
        zip: b.zip || null,
        property_type: b.property_type || null,
        lot_number: b.lot_number || null,
        notes: b.notes || null,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ property: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/properties/:id', express.json(), async (req, res) => {
  try {
    const allowed = ['street_address','unit','city','state','zip','property_type','lot_number','notes','vantaca_account_id'];
    const patch = { updated_at: new Date().toISOString() };
    allowed.forEach((k) => { if (k in (req.body || {})) patch[k] = req.body[k]; });
    const { data, error } = await supabase
      .from('properties').update(patch).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ property: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// CONTACTS
// ---------------------------------------------------------------------------
router.get('/contacts', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    let query = supabase.from('contacts').select('*').order('full_name').limit(500);
    if (q) query = query.or(`full_name.ilike.%${q}%,primary_email.ilike.%${q}%`);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ contacts: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/contacts', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.full_name) return res.status(400).json({ error: 'full_name is required.' });
    const { data, error } = await supabase
      .from('contacts')
      .insert({
        full_name: b.full_name,
        preferred_name: b.preferred_name || null,
        primary_email: b.primary_email || null,
        primary_phone: b.primary_phone || null,
        mailing_address: b.mailing_address || null,
        notes: b.notes || null,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ contact: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/contacts/:id', express.json(), async (req, res) => {
  try {
    const allowed = ['full_name','preferred_name','primary_email','primary_phone','secondary_email','secondary_phone','mailing_address','notes'];
    const patch = { updated_at: new Date().toISOString() };
    allowed.forEach((k) => { if (k in (req.body || {})) patch[k] = req.body[k]; });
    const { data, error } = await supabase
      .from('contacts').update(patch).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ contact: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Owner-occupancy summary per community — drives the dashboard rollup.
// ---------------------------------------------------------------------------
router.get('/contacts/occupancy-summary', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('v_owner_occupancy_summary')
      .select('*');
    if (error) return res.status(500).json({ error: error.message });
    res.json({ summary: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
