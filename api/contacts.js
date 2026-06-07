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
const { parseContactInfoXlsx, computeContactMethodsDiff } = require('../lib/contacts/contact_methods_import');

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
      // Counters for changes that were SKIPPED because the target row
      // has data_verified_at set — protects template-import work from
      // being silently overwritten by Vantaca syncs. Operator sees these
      // counts in the apply summary and knows to handle the changes
      // manually if a verified row's data really did change.
      skipped_verified_property_changes: 0,
      skipped_verified_emails:           0,
      skipped_verified_phones:           0,
    };
    const today = new Date().toISOString().slice(0, 10);

    // Pre-fetch verified status for every property + contact that this
    // apply might touch. One query each, build sets for O(1) lookup in
    // the loops below. Properties + contacts in this batch are bounded
    // (max ~hundreds per sync), so the .in() lookups are safe.
    const targetPropIds = new Set();
    (diff.property_field_changes || []).forEach(i => targetPropIds.add(i.property_id));
    const targetContactIds = new Set();
    (diff.email_additions || []).forEach(i => targetContactIds.add(i.contact_id));
    (diff.phone_additions || []).forEach(i => targetContactIds.add(i.contact_id));

    const verifiedPropertyIds = new Set();
    if (targetPropIds.size > 0) {
      const { data: vp } = await supabase
        .from('properties')
        .select('id, data_verified_at')
        .in('id', Array.from(targetPropIds));
      (vp || []).forEach(p => { if (p.data_verified_at) verifiedPropertyIds.add(p.id); });
    }
    const verifiedContactIds = new Set();
    if (targetContactIds.size > 0) {
      const { data: vc } = await supabase
        .from('contacts')
        .select('id, data_verified_at')
        .in('id', Array.from(targetContactIds));
      (vc || []).forEach(c => { if (c.data_verified_at) verifiedContactIds.add(c.id); });
    }

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
        // Verified-row protection: don't overwrite operator-signed truth
        if (verifiedPropertyIds.has(item.property_id)) {
          applied.skipped_verified_property_changes += 1;
          continue;
        }
        const patch = { updated_at: new Date().toISOString() };
        for (const [field, change] of Object.entries(item.changes)) patch[field] = change.to;
        const { error: uErr } = await supabase.from('properties').update(patch).eq('id', item.property_id);
        if (!uErr) applied.properties_updated += 1;
      }
    }

    // --- OWNERSHIP CHANGES (route to review queue, do NOT auto-apply) --------
    // Per project_property_data_architecture + Ed's 2026-05-21 requirement:
    // ownership transitions need explicit human approval. Vantaca can be wrong
    // (typos, premature recording before deed transfer, mistaken updates).
    // Auto-applying creates audit-trail problems if Bedrock has to back out.
    //
    // Instead of closing/opening ownerships here, we INSERT proposals into
    // ownership_change_proposals (status='pending'). Staff reviews + approves
    // from the queue UI; the approve_ownership_proposal() function then does
    // the transition atomically.
    //
    // applied.ownership_proposals_created replaces the old
    // ownerships_ended/created counts for this category.
    const wantOwnerChanges = apply.ownership_changes === 'all' || Array.isArray(apply.ownership_changes);
    applied.ownership_proposals_created = 0;
    if (wantOwnerChanges && diff.ownership_changes) {
      const select = apply.ownership_changes === 'all' ? null : new Set(apply.ownership_changes);
      for (const item of diff.ownership_changes) {
        if (select && !select.has(item.property_id)) continue;
        // Find the current contact (for snapshot) — best effort
        const { data: currentOwnership } = await supabase
          .from('property_ownerships')
          .select('contact_id, contacts(id, full_name, primary_email, primary_phone)')
          .eq('property_id', item.property_id)
          .is('end_date', null)
          .order('is_primary', { ascending: false })
          .limit(1)
          .maybeSingle();

        const { error: propErr } = await supabase
          .from('ownership_change_proposals')
          .insert({
            property_id: item.property_id,
            community_id: communityId,
            current_contact_id:    currentOwnership?.contact_id || null,
            current_owner_name:    currentOwnership?.contacts?.full_name || item.prior_owner || null,
            current_owner_email:   currentOwnership?.contacts?.primary_email || null,
            current_owner_phone:   currentOwnership?.contacts?.primary_phone || null,
            proposed_owner_name:   item.new_owner,
            proposed_owner_email:  item.new_email,
            proposed_owner_phone:  item.new_phone,
            proposed_mailing_address: item.new_mailing_address || null,
            proposed_homeowner_id: item.new_homeowner_id || null,
            source:                'vantaca_import',
            source_filename:       sync.source_filename || null,
            source_batch_id:       syncId,
            vantaca_account_id:    item.vantaca_account_id || null,
            status:                'pending',
          });
        if (!propErr) applied.ownership_proposals_created += 1;
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
        if (verifiedContactIds.has(item.contact_id)) {
          applied.skipped_verified_emails += 1;
          continue;
        }
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
        if (verifiedContactIds.has(item.contact_id)) {
          applied.skipped_verified_phones += 1;
          continue;
        }
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
      .select('id, name, legal_name, slug, vantaca_code, total_lots, active, city, state, zip, website_url')
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

// Single community fetch — used by the Annual Meeting Notice tab to
// surface the community's website URL so the operator knows whether
// the mailing PDF will include the bios callout with a link.
router.get('/communities/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('communities')
      .select('id, name, legal_name, slug, vantaca_code, total_lots, active, city, state, zip, website_url')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'community not found' });
    res.json(data);
  } catch (err) {
    console.error('[communities.get]', err);
    res.status(500).json({ error: err.message || 'failed to fetch community' });
  }
});

// Single-community patch. Limited whitelist — only fields the UI
// surfaces are accepted; everything else is silently ignored to keep
// the inline-edit flow scoped + safe. Currently supports:
//   - website_url   (homeowner-facing community site URL, used by AMN)
//   - city / state / zip   (default geo for new properties)
router.patch('/communities/:id', express.json(), async (req, res) => {
  try {
    const ALLOWED = ['website_url', 'city', 'state', 'zip'];
    const patch = {};
    for (const k of ALLOWED) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, k)) {
        // Treat empty string as NULL — operator clearing a field, not
        // saving "" which the AMN renderer would mis-interpret as a
        // present-but-blank URL and print "available at ." with a bad
        // link.
        const v = req.body[k];
        patch[k] = (v === '' || v == null) ? null : v;
      }
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'no editable fields provided' });
    }
    if (patch.website_url && !/^https?:\/\//i.test(patch.website_url)) {
      return res.status(400).json({ error: 'website_url must start with http:// or https://' });
    }
    const { data, error } = await supabase
      .from('communities')
      .update(patch)
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .select('id, name, website_url, city, state, zip')
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'community not found' });
    res.json(data);
  } catch (err) {
    console.error('[communities.patch]', err);
    res.status(500).json({ error: err.message || 'failed to patch community' });
  }
});

// ---------------------------------------------------------------------------
// PROPERTIES
// ---------------------------------------------------------------------------
// ============================================================================
// is_likely_rental heuristic (Ed 2026-06-08)
// ----------------------------------------------------------------------------
// PURPOSE: surface properties that are PROBABLY rentals but don't have an
// explicit renter residency on file yet. Lets operators triage the
// "find rentals we haven't captured" backlog without manually scanning.
//
// RULE:
//   • If a current residency exists AND type is anything OTHER than
//     'unknown', trust the data. The flag is FALSE — we already know.
//     (renter → it IS a rental, not "likely". owner_occupied / family /
//     vacant → not a rental.)
//   • If no current residency OR residency_type='unknown' AND there's
//     an owner whose MAILING address differs from the PROPERTY's
//     street address → flag as likely rental.
//   • Address compare uses street-portion only (everything before the
//     first comma, lowercased, whitespace collapsed). Avoids false
//     positives from formatting differences in city/state/zip.
//
// Returns { flag: boolean, reason: string, owner_mailing?, property_street? }
// ----------------------------------------------------------------------------
function _normalizeStreetOnly(addr) {
  if (!addr) return '';
  const beforeComma = String(addr).split(',')[0];
  return beforeComma
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,#]/g, '')
    .trim();
}
function computeIsLikelyRental({ propertyAddress, ownerMailingAddress, currentResidencyType }) {
  // Trust explicit residency data
  if (currentResidencyType === 'renter') {
    return { flag: false, reason: 'Confirmed renter on file' };
  }
  if (currentResidencyType === 'owner_occupied') {
    return { flag: false, reason: 'Confirmed owner-occupied' };
  }
  if (currentResidencyType === 'family_member') {
    return { flag: false, reason: 'Confirmed family member' };
  }
  if (currentResidencyType === 'vacant') {
    return { flag: false, reason: 'Confirmed vacant' };
  }
  // currentResidencyType is null, undefined, or 'unknown' → heuristic time
  if (!ownerMailingAddress) {
    return { flag: false, reason: 'No owner mailing address on file' };
  }
  if (!propertyAddress) {
    return { flag: false, reason: 'No property address' };
  }
  const propStreet = _normalizeStreetOnly(propertyAddress);
  const ownerStreet = _normalizeStreetOnly(ownerMailingAddress);
  if (!propStreet || !ownerStreet) {
    return { flag: false, reason: 'Address data incomplete' };
  }
  if (propStreet === ownerStreet) {
    return { flag: false, reason: 'Owner mailing matches property (likely owner-occupied)' };
  }
  return {
    flag: true,
    reason: 'Owner mails to a different address — likely rental',
    owner_mailing: ownerMailingAddress,
    property_street: propertyAddress,
  };
}

router.get('/properties', async (req, res) => {
  try {
    const communityId = req.query.community_id;
    // Paginated — .limit(2000) was getting silently clamped to 1000 by
    // Supabase PostgREST's server-side cap (CLAUDE.md scar 2026-06-01).
    // Walk pages of 1000 until exhausted so Waterview's 1171 properties
    // all return.
    const PAGE = 1000;
    let all = [];
    let from = 0;
    while (true) {
      let q = supabase.from('v_current_property_owners').select('*');
      if (communityId) q = q.eq('community_id', communityId);
      const { data, error } = await q.order('street_address').range(from, from + PAGE - 1);
      if (error) return res.status(500).json({ error: error.message });
      if (!data || data.length === 0) break;
      all = all.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
      if (from > 100000) break;
    }

    // Pull current residency types for the same property ids so we can
    // compute is_likely_rental per-row. Same pagination discipline.
    const propertyIds = all.map(p => p.property_id).filter(Boolean);
    const residencyByPropId = new Map();
    if (propertyIds.length) {
      // Batch IN-list 500 at a time to keep URL length sane
      for (let i = 0; i < propertyIds.length; i += 500) {
        const batch = propertyIds.slice(i, i + 500);
        const { data: rrows } = await supabase
          .from('property_residencies')
          .select('property_id, residency_type, start_date')
          .in('property_id', batch)
          .is('end_date', null);
        for (const r of (rrows || [])) {
          // If multiple current residencies somehow exist (data quality
          // issue), keep the latest by start_date
          const existing = residencyByPropId.get(r.property_id);
          if (!existing || (r.start_date || '') > (existing.start_date || '')) {
            residencyByPropId.set(r.property_id, r);
          }
        }
      }
    }
    // Enrich each row
    for (const p of all) {
      const res = residencyByPropId.get(p.property_id);
      const rentalIntel = computeIsLikelyRental({
        propertyAddress: p.street_address,
        ownerMailingAddress: p.owner_mailing_address,
        currentResidencyType: res?.residency_type || null,
      });
      p.current_residency_type = res?.residency_type || null;
      p.is_likely_rental = rentalIntel.flag;
      p.likely_rental_reason = rentalIntel.reason;
    }
    res.json({ properties: all });
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

    const [{ data: ownerships }, { data: residencies }, { data: activeLease }] = await Promise.all([
      supabase.from('property_ownerships')
        .select('*, contacts(id, full_name, primary_email, primary_phone)')
        .eq('property_id', req.params.id)
        .order('start_date', { ascending: false }),
      supabase.from('property_residencies')
        .select('*, contacts(id, full_name, primary_email, primary_phone)')
        .eq('property_id', req.params.id)
        .order('start_date', { ascending: false }),
      // v_active_leases — only returns a row if there's a current renter
      // residency; consumed by the Property Detail UI's lease section
      supabase.from('v_active_leases')
        .select('*')
        .eq('property_id', req.params.id)
        .maybeSingle(),
    ]);

    // Compute is_likely_rental intel for the panel chip.
    // Find current residency (end_date IS NULL) and current owner mailing.
    const currentRes = (residencies || []).find(r => !r.end_date) || null;
    const currentOwner = (ownerships || []).find(o => !o.end_date) || null;
    const ownerContact = currentOwner?.contacts || null;
    let ownerMailing = null;
    if (ownerContact?.id) {
      // contacts join from /properties/:id doesn't bring mailing_address
      // by default — fetch it explicitly.
      try {
        const { data: cFull } = await supabase
          .from('contacts')
          .select('mailing_address')
          .eq('id', ownerContact.id)
          .maybeSingle();
        ownerMailing = cFull?.mailing_address || null;
      } catch (_) { /* leave null */ }
    }
    const rentalIntel = computeIsLikelyRental({
      propertyAddress: prop.street_address,
      ownerMailingAddress: ownerMailing,
      currentResidencyType: currentRes?.residency_type || null,
    });

    res.json({
      property: prop,
      ownerships: ownerships || [],
      residencies: residencies || [],
      active_lease: activeLease || null,
      is_likely_rental: rentalIntel.flag,
      likely_rental_reason: rentalIntel.reason,
      owner_mailing_address: ownerMailing,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PROPERTY RESIDENCIES — CRUD for the rental/owner-occupied/vacant lifecycle
// of a property. Lease tracking columns added in migration 116.
// ---------------------------------------------------------------------------
router.patch('/property-residencies/:id', express.json(), async (req, res) => {
  try {
    const allowed = [
      'residency_type', 'start_date', 'end_date',
      'lease_start_date', 'lease_end_date', 'lease_pdf_path',
      'monthly_rent', 'security_deposit', 'lease_renewal_count',
      'notes', 'notes_renter', 'contact_id',
    ];
    const validTypes = ['owner_occupied', 'renter', 'family_member', 'vacant', 'unknown'];
    const patch = { updated_at: new Date().toISOString() };
    allowed.forEach((k) => { if (k in (req.body || {})) patch[k] = req.body[k]; });
    if ('residency_type' in patch && !validTypes.includes(patch.residency_type)) {
      return res.status(400).json({ error: 'invalid_residency_type' });
    }
    const { data, error } = await supabase
      .from('property_residencies').update(patch).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ residency: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/property-residencies/add-renter
// One-shot "add a renter to this property" — creates the renter contact
// (or reuses an existing one matched by phone) AND the residency row in
// the same request. Ends any current residency first.
//
// Body:
//   { property_id, full_name, primary_phone?, primary_email?,
//     lease_end_date?, lease_start_date?, monthly_rent?, notes? }
//
// Returns { contact, residency, reused_contact: bool }
//
// Phone-match dedupe: if a contact already exists with the same last-10
// of primary_phone, we reuse it instead of creating a duplicate.
// Single-source-of-truth discipline.
// ----------------------------------------------------------------------------
router.post('/property-residencies/add-renter', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.property_id) return res.status(400).json({ error: 'property_id_required' });
    if (!b.full_name || !String(b.full_name).trim()) {
      return res.status(400).json({ error: 'full_name_required' });
    }
    const fullName = String(b.full_name).trim();
    const primaryEmail = (b.primary_email || '').trim() || null;
    const primaryPhone = (b.primary_phone || '').trim() || null;

    // Dedupe — if a contact already exists with the same last-10 of phone,
    // reuse that contact. Single source of truth for the renter as a person.
    let contact = null;
    let reusedContact = false;
    if (primaryPhone) {
      const last10 = primaryPhone.replace(/\D/g, '').slice(-10);
      if (last10.length === 10) {
        const { data: candidates } = await supabase
          .from('contacts')
          .select('id, full_name, primary_phone, primary_email')
          .or(`primary_phone.ilike.%${last10}%,secondary_phone.ilike.%${last10}%,notification_phone.ilike.%${last10}%`)
          .limit(5);
        contact = (candidates || []).find((c) => {
          for (const f of ['primary_phone', 'secondary_phone', 'notification_phone']) {
            const d = String(c[f] || '').replace(/\D/g, '').slice(-10);
            if (d === last10) return true;
          }
          return false;
        }) || null;
        if (contact) reusedContact = true;
      }
    }

    // Create the contact if no match
    if (!contact) {
      const { data: created, error: createErr } = await supabase
        .from('contacts')
        .insert({
          full_name: fullName,
          primary_phone: primaryPhone,
          primary_email: primaryEmail,
          notes: 'Added via Add Renter workflow',
        })
        .select()
        .single();
      if (createErr) return res.status(500).json({ error: createErr.message });
      contact = created;
    }

    // End any current residency on this property
    const today = new Date().toISOString().slice(0, 10);
    await supabase
      .from('property_residencies')
      .update({ end_date: today, updated_at: new Date().toISOString() })
      .eq('property_id', b.property_id)
      .is('end_date', null);

    // Insert the new renter residency
    const { data: residency, error: resErr } = await supabase
      .from('property_residencies')
      .insert({
        property_id: b.property_id,
        contact_id: contact.id,
        residency_type: 'renter',
        start_date: b.start_date || today,
        lease_start_date: b.lease_start_date || null,
        lease_end_date: b.lease_end_date || null,
        monthly_rent: b.monthly_rent || null,
        notes: b.notes || null,
        source: 'manual',
      })
      .select()
      .single();
    if (resErr) return res.status(500).json({ error: resErr.message });

    res.json({ contact, residency, reused_contact: reusedContact });
  } catch (err) {
    console.error('[contacts] add-renter failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/property-residencies', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.property_id) return res.status(400).json({ error: 'property_id_required' });
    if (!b.residency_type) return res.status(400).json({ error: 'residency_type_required' });
    const validTypes = ['owner_occupied', 'renter', 'family_member', 'vacant', 'unknown'];
    if (!validTypes.includes(b.residency_type)) return res.status(400).json({ error: 'invalid_residency_type' });

    // If end_previous=true, end any current residency on this property first
    // (preserves audit trail — old residency stays in the table with end_date set).
    const today = new Date().toISOString().slice(0, 10);
    if (b.end_previous) {
      await supabase
        .from('property_residencies')
        .update({ end_date: today, updated_at: new Date().toISOString() })
        .eq('property_id', b.property_id)
        .is('end_date', null);
    }
    const payload = {
      property_id: b.property_id,
      contact_id: b.contact_id || null,
      residency_type: b.residency_type,
      start_date: b.start_date || today,
      end_date: b.end_date || null,
      lease_start_date: b.lease_start_date || null,
      lease_end_date: b.lease_end_date || null,
      lease_pdf_path: b.lease_pdf_path || null,
      monthly_rent: b.monthly_rent || null,
      security_deposit: b.security_deposit || null,
      notes: b.notes || null,
      notes_renter: b.notes_renter || null,
      source: b.source || 'manual',
    };
    const { data, error } = await supabase
      .from('property_residencies').insert(payload).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ residency: data });
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

// ---------------------------------------------------------------------------
// BULK CLEAN incomplete mailing addresses for a community.
// ---------------------------------------------------------------------------
// Use case: Vantaca exports populate contacts.mailing_address with just
// the street ("4902 Beech Fern Drive") for owner-occupied homes,
// because Vantaca assumes the property's full address is implicit.
// trustEd inherited that mess. This endpoint finds all contacts in a
// community whose mailing_address is street-only (matches the property
// street, no ZIP), and NULLs them out. Setting NULL is more honest than
// either keeping the broken string or duplicating the property address —
// it explicitly says "mailing = property, no separate address on file"
// which is true for owner-occupied homes.
//
// Returns the count cleaned + a sample for confirmation.
// ---------------------------------------------------------------------------
router.post('/communities/:id/clean-redundant-mailings', express.json(), async (req, res) => {
  try {
    const communityId = req.params.id;
    // Pull all properties + their current owners for this community.
    const PAGE = 1000;
    let owners = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('v_current_property_owners')
        .select('property_id, street_address, owner_contact_id, owner_mailing_address')
        .eq('community_id', communityId)
        .range(from, from + PAGE - 1);
      if (error) return res.status(500).json({ error: error.message });
      if (!data || data.length === 0) break;
      owners = owners.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
      if (from > 100000) break;
    }
    // Find contact_ids where mailing_address is set, doesn't have a 5-digit
    // zip, AND starts with (or equals) the property street — meaning it's
    // the same address as the property, just incomplete.
    const HAS_ZIP = /\b\d{5}(-\d{4})?\b/;
    const toClean = [];
    for (const o of owners) {
      const mail = (o.owner_mailing_address || '').trim();
      if (!mail) continue;
      if (HAS_ZIP.test(mail)) continue;
      if (!o.owner_contact_id || !o.street_address) continue;
      const propStreet = o.street_address.toLowerCase();
      if (mail.toLowerCase() === propStreet || mail.toLowerCase().startsWith(propStreet.slice(0, Math.min(12, propStreet.length)))) {
        toClean.push({
          contact_id: o.owner_contact_id,
          property_street: o.street_address,
          old_mailing: o.owner_mailing_address
        });
      }
    }
    if (toClean.length === 0) {
      return res.json({ cleaned: 0, sample: [], message: 'No incomplete mailings matched property street — nothing to clean.' });
    }
    // Dry run support — if ?dry_run=true was passed, return the count without writing.
    if (req.query.dry_run === 'true' || req.body?.dry_run === true) {
      return res.json({ cleaned: 0, would_clean: toClean.length, sample: toClean.slice(0, 10), dry_run: true });
    }
    // NULL them out in chunks. Supabase doesn't support "WHERE id IN (long list)"
    // cleanly at huge sizes, so chunk by 500.
    const CHUNK = 500;
    let updated = 0;
    for (let i = 0; i < toClean.length; i += CHUNK) {
      const ids = toClean.slice(i, i + CHUNK).map(r => r.contact_id);
      const { error } = await supabase
        .from('contacts')
        .update({ mailing_address: null, updated_at: new Date().toISOString() })
        .in('id', ids);
      if (error) {
        console.error('[clean-redundant-mailings] chunk failed:', error);
        return res.status(500).json({ error: error.message, partial_cleaned: updated });
      }
      updated += ids.length;
    }
    res.json({ cleaned: updated, sample: toClean.slice(0, 10) });
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
    const allowed = [
      'full_name','preferred_name',
      'primary_email','primary_phone','secondary_email','secondary_phone',
      'notification_phone','mailing_address','notes',
      'preferred_language',
      'sms_opt_in','sms_opt_out','email_opt_out',
    ];
    const patch = { updated_at: new Date().toISOString() };
    allowed.forEach((k) => { if (k in (req.body || {})) patch[k] = req.body[k]; });
    // Stamp the timestamp side-fields when an opt-in/out flag flips so the
    // audit trail captures WHEN (the boolean alone doesn't tell you).
    const nowIso = new Date().toISOString();
    if ('sms_opt_in' in patch && patch.sms_opt_in) {
      patch.sms_opt_in_at = nowIso;
      patch.sms_opt_in_source = req.body.sms_opt_in_source || 'staff_edit';
    }
    if ('sms_opt_out' in patch && patch.sms_opt_out) patch.sms_opt_out_at = nowIso;
    if ('email_opt_out' in patch && patch.email_opt_out) patch.email_opt_out_at = nowIso;
    const { data, error } = await supabase
      .from('contacts').update(patch).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ contact: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// CONTACT PREFERENCES — upsert for the per-contact granular comm prefs
// (general/billing channel split, payment confirmation email, payment
// reminders text + phone). One row per contact (UNIQUE on contact_id);
// absent row defaults to implicit values in the application layer.
// ---------------------------------------------------------------------------
router.put('/contacts/:id/preferences', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    // Validate enum fields against the migration 110 CHECK constraints
    const channelEnum = ['paper','email','both','suppress'];
    const upsertPayload = { contact_id: req.params.id, updated_at: new Date().toISOString() };
    if ('general_comm_channel' in b) {
      if (!channelEnum.includes(b.general_comm_channel)) return res.status(400).json({ error: 'invalid_general_comm_channel' });
      upsertPayload.general_comm_channel = b.general_comm_channel;
    }
    if ('billing_comm_channel' in b) {
      if (!channelEnum.includes(b.billing_comm_channel)) return res.status(400).json({ error: 'invalid_billing_comm_channel' });
      upsertPayload.billing_comm_channel = b.billing_comm_channel;
    }
    if ('payment_confirmation_email_enabled' in b) upsertPayload.payment_confirmation_email_enabled = !!b.payment_confirmation_email_enabled;
    if ('payment_reminders_text_enabled' in b) upsertPayload.payment_reminders_text_enabled = !!b.payment_reminders_text_enabled;
    if ('payment_reminders_phone' in b) upsertPayload.payment_reminders_phone = b.payment_reminders_phone || null;
    if ('notes' in b) upsertPayload.notes = b.notes || null;

    const { data, error } = await supabase
      .from('contact_preferences')
      .upsert(upsertPayload, { onConflict: 'contact_id' })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ preferences: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// HOMEOWNERS LIST — contact-centric view of current property owners across
// the portfolio. Aggregates property_ownerships (current only) joined with
// contacts + properties + communities, groups by contact, returns one row
// per homeowner with their full property list.
//
// Query params:
//   community_id   (optional) — limit to one community
//   q              (optional) — case-insensitive search on name + email
//
// Used by the Homes & Owners "👤 Homeowners" section as the person-first
// entry point (vs. the property-first list right above it). Click any
// row → opens the Homeowner Profile modal.
// ---------------------------------------------------------------------------
router.get('/homeowners', async (req, res) => {
  try {
    const communityId = (req.query.community_id || '').trim();
    const q = (req.query.q || '').trim().toLowerCase();

    const { data, error } = await supabase
      .from('property_ownerships')
      .select(`
        contact_id, property_id, is_primary, start_date,
        contacts ( id, full_name, preferred_name, primary_email, primary_phone, mailing_address, preferred_language ),
        properties ( id, street_address, unit, community_id,
                     communities ( id, name ) )
      `)
      .is('end_date', null)
      .limit(5000);
    if (error) return res.status(500).json({ error: error.message });

    // Group by contact_id with optional community filter + search
    const byContact = new Map();
    (data || []).forEach((row) => {
      if (!row.contact_id || !row.contacts) return;
      const prop = row.properties || {};
      if (communityId && prop.community_id !== communityId) return;
      const name = (row.contacts.full_name || '').toLowerCase();
      const email = (row.contacts.primary_email || '').toLowerCase();
      if (q && !name.includes(q) && !email.includes(q)) return;

      const existing = byContact.get(row.contact_id) || {
        contact_id: row.contact_id,
        full_name: row.contacts.full_name,
        preferred_name: row.contacts.preferred_name,
        primary_email: row.contacts.primary_email,
        primary_phone: row.contacts.primary_phone,
        mailing_address: row.contacts.mailing_address,
        preferred_language: row.contacts.preferred_language,
        properties: [],
        communities: new Set(),
      };
      existing.properties.push({
        property_id: prop.id,
        street_address: prop.street_address,
        unit: prop.unit,
        community_id: prop.community_id,
        community_name: prop.communities?.name || '',
        is_primary: row.is_primary,
        owned_since: row.start_date,
      });
      if (prop.communities?.name) existing.communities.add(prop.communities.name);
      byContact.set(row.contact_id, existing);
    });

    const homeowners = Array.from(byContact.values())
      .map((h) => ({ ...h, communities: Array.from(h.communities) }))
      .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));

    res.json({ homeowners, count: homeowners.length });
  } catch (err) {
    console.error('[contacts.homeowners]', err);
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

// ---------------------------------------------------------------------------
// SINGLE CONTACT — basic record only (used for editor pre-fill).
// ---------------------------------------------------------------------------
router.get('/contacts/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.json({ contact: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// HOMEOWNER PROFILE — the aggregate "everything about this person" payload.
// Backs the Homeowner Profile modal in Homes & Owners. Single round-trip
// instead of 8 fetches from the browser.
//
// Shape:
//   {
//     contact:        { ...flat contacts row + preferred_language etc. },
//     preferences:    { ...contact_preferences row or null },
//     properties:     [ { property, ownership, residency, latest_ar } ],
//     ownership_history:   [ ...older closed ownerships across all props ],
//     active_tags:    [ { id, tag_key, community_id, community_name, note, granted_at, granted_by } ],
//     notes:          [ ...homeowner_notes ordered pinned desc, created_at desc ],
//     portal_logins:  [ { portal_user, scoped_properties: [...] } ],
//     interactions:   [ ...recent N interactions where contact_id = :id ],
//     calls:          [ ...recent voice calls where caller_homeowner_id = :id ]
//   }
// ---------------------------------------------------------------------------
router.get('/contacts/:id/profile', async (req, res) => {
  try {
    const id = req.params.id;

    // 1. Contact itself (required — 404 if not found)
    const { data: contact, error: cErr } = await supabase
      .from('contacts').select('*').eq('id', id).maybeSingle();
    if (cErr) return res.status(500).json({ error: cErr.message });
    if (!contact) return res.status(404).json({ error: 'not_found' });

    // 2-N. Parallel fan-out for everything else.
    const [
      prefRes, methodsRes, ownRes, resRes, tagRes, noteRes,
      portalRes, intRes, callRes
    ] = await Promise.all([
      supabase.from('contact_preferences').select('*').eq('contact_id', id).maybeSingle(),
      supabase.from('contact_methods')
        .select('*')
        .eq('contact_id', id)
        .order('method_type')
        .order('is_primary', { ascending: false })
        .order('created_at'),
      supabase.from('property_ownerships')
        .select('id, property_id, start_date, end_date, vesting, is_primary, source, properties(id, street_address, unit, city, state, zip, community_id, communities(id, name))')
        .eq('contact_id', id)
        .order('end_date', { ascending: true, nullsFirst: true })
        .order('start_date', { ascending: false }),
      supabase.from('property_residencies')
        .select('id, property_id, start_date, end_date, residency_type, lease_end_date, properties(id, street_address, unit, community_id, communities(id, name))')
        .eq('contact_id', id)
        .is('end_date', null),
      supabase.from('homeowner_tags')
        .select('id, tag_key, community_id, note, granted_at, granted_by, communities(id, name)')
        .eq('contact_id', id)
        .is('revoked_at', null)
        .order('granted_at', { ascending: false }),
      supabase.from('homeowner_notes')
        .select('*, communities(id, name), properties(id, street_address)')
        .eq('contact_id', id)
        .order('pinned', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(50),
      supabase.from('portal_users')
        .select('id, email, full_name, role, status, last_login_at, first_login_at, invited_at, login_count')
        .eq('contact_id', id),
      supabase.from('interactions')
        .select('id, community_id, property_id, type, direction, subject, content, delivery_method, certified_tracking_number, status, sent_at, received_at, ai_drafted, ai_classification, thread_id, parent_interaction_id, created_at')
        .eq('contact_id', id)
        .order('sent_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(30),
      supabase.from('homeowner_calls')
        .select('id, community_id, started_at, ended_at, duration_seconds, status, brief, handoff_offered, handoff_accepted, handoff_reason, compliance_flag')
        .eq('caller_homeowner_id', id)
        .order('started_at', { ascending: false })
        .limit(10),
    ]);

    // Surface non-fatal errors as warnings but don't abort — profile still
    // renders with whatever loaded.
    const warnings = [];
    [['preferences', prefRes], ['contact_methods', methodsRes], ['ownerships', ownRes], ['residencies', resRes],
     ['tags', tagRes], ['notes', noteRes], ['portal_logins', portalRes],
     ['interactions', intRes], ['calls', callRes]
    ].forEach(([k, r]) => { if (r.error) warnings.push({ section: k, error: r.error.message }); });

    // Roll up ownerships into "properties" (current + historical), then attach
    // latest AR snapshot for current-owned properties.
    const allOwnerships = ownRes.data || [];
    const currentOwnerships = allOwnerships.filter((o) => !o.end_date);
    const currentPropertyIds = currentOwnerships.map((o) => o.property_id);

    let arByProperty = {};
    if (currentPropertyIds.length > 0) {
      const { data: arRows } = await supabase
        .from('owner_ar_snapshots')
        .select('property_id, snapshot_date, balance_total, bucket_0_30, bucket_31_60, bucket_61_90, bucket_91_120, bucket_over_120, at_legal, in_collections, payment_plan_active, enforcement_stage, approved_at')
        .in('property_id', currentPropertyIds)
        .order('snapshot_date', { ascending: false });
      // Keep only the most recent snapshot per property
      (arRows || []).forEach((row) => {
        if (!arByProperty[row.property_id]) arByProperty[row.property_id] = row;
      });
    }

    // Build properties array (one entry per currently-owned property)
    const residenciesByProperty = {};
    (resRes.data || []).forEach((r) => { residenciesByProperty[r.property_id] = r; });
    const properties = currentOwnerships.map((o) => ({
      ownership: {
        id: o.id, start_date: o.start_date, vesting: o.vesting,
        is_primary: o.is_primary, source: o.source,
      },
      property: o.properties || null,
      residency: residenciesByProperty[o.property_id] || null,
      latest_ar: arByProperty[o.property_id] || null,
    }));

    const ownershipHistory = allOwnerships.filter((o) => o.end_date);

    // Violations across all properties currently owned. Returns recent +
    // open; lets the profile surface "Drona has 2 open + 5 cured" without
    // a separate round-trip.
    let violations = [];
    if (currentPropertyIds.length > 0) {
      const { data: vRows } = await supabase
        .from('violations')
        .select(`
          id, property_id, current_stage, opened_at, cure_period_ends_at,
          resolved_at, resolved_via, board_priority_at_open,
          enforcement_categories ( label ),
          properties ( street_address, unit )
        `)
        .in('property_id', currentPropertyIds)
        .order('opened_at', { ascending: false })
        .limit(50);
      violations = vRows || [];
    }

    // ARC submissions — pulled from community_applications joined on
    // homeowner emails. Schema check: community_applications has
    // submitter_email per migration 021 / 027.
    let arc_applications = [];
    const homeownerEmails = [contact.primary_email, contact.secondary_email]
      .concat((methodsRes.data || []).filter((m) => m.method_type === 'email').map((m) => m.value))
      .filter(Boolean)
      .filter((e, i, arr) => arr.indexOf(e) === i); // dedup
    if (homeownerEmails.length > 0) {
      try {
        const { data: arcRows } = await supabase
          .from('community_applications')
          .select('id, community_id, submitter_email, submitter_name, application_type, subject, final_status, created_at, communities(id, name)')
          .in('submitter_email', homeownerEmails)
          .order('created_at', { ascending: false })
          .limit(30);
        arc_applications = arcRows || [];
      } catch (_) { /* table or fields may not exist; non-fatal */ }
    }

    res.json({
      contact,
      preferences: prefRes.data || null,
      contact_methods: methodsRes.data || [],
      properties,
      ownership_history: ownershipHistory,
      active_tags: tagRes.data || [],
      notes: noteRes.data || [],
      portal_logins: portalRes.data || [],
      interactions: intRes.data || [],
      calls: callRes.data || [],
      violations,
      arc_applications,
      warnings,
    });
  } catch (err) {
    console.error('[contacts/:id/profile]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// CONTACT METHODS — N emails + phones per contact with per-method notification
// subscriptions (per migration 114). When a primary method is added/edited,
// also syncs back to contacts.primary_email / .primary_phone so legacy code
// reading the flat columns (voice caller-phone resolution, etc.) continues
// to see the latest values.
// ---------------------------------------------------------------------------
router.post('/contacts/:id/methods', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.method_type || !['email','phone'].includes(b.method_type)) {
      return res.status(400).json({ error: 'method_type must be email or phone' });
    }
    if (!b.value || !String(b.value).trim()) {
      return res.status(400).json({ error: 'value_required' });
    }
    const payload = {
      contact_id: req.params.id,
      method_type: b.method_type,
      subtype: b.subtype || null,
      value: String(b.value).trim(),
      label: b.label || null,
      is_primary: !!b.is_primary,
      notify_general: b.notify_general !== false,
      notify_events: b.notify_events !== false,
      notify_billing: b.notify_billing !== false,
      notify_violations: b.notify_violations !== false,
      notify_arc_decisions: b.notify_arc_decisions !== false,
      notify_emergency: b.notify_emergency !== false,
      notify_payment_confirm: !!b.notify_payment_confirm,
      notes: b.notes || null,
    };
    // If marking as primary, demote any existing primary of the same method_type
    if (payload.is_primary) {
      await supabase
        .from('contact_methods')
        .update({ is_primary: false, updated_at: new Date().toISOString() })
        .eq('contact_id', req.params.id)
        .eq('method_type', payload.method_type)
        .eq('is_primary', true);
    }
    const { data, error } = await supabase
      .from('contact_methods').insert(payload).select().single();
    if (error) return res.status(500).json({ error: error.message });
    // Sync back to contacts.primary_email / .primary_phone if this is primary
    if (data.is_primary) {
      const syncField = data.method_type === 'email' ? 'primary_email' : 'primary_phone';
      await supabase.from('contacts').update({ [syncField]: data.value, updated_at: new Date().toISOString() }).eq('id', req.params.id);
    }
    res.json({ method: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/contact-methods/:methodId', express.json(), async (req, res) => {
  try {
    const allowed = [
      'subtype','value','label','is_primary',
      'notify_general','notify_events','notify_billing','notify_violations',
      'notify_arc_decisions','notify_emergency','notify_payment_confirm',
      'notes','verified_at','verified_via',
    ];
    const patch = { updated_at: new Date().toISOString() };
    allowed.forEach((k) => { if (k in (req.body || {})) patch[k] = req.body[k]; });

    // Fetch existing to know contact_id + method_type for primary-demotion + sync
    const { data: existing } = await supabase
      .from('contact_methods').select('*').eq('id', req.params.methodId).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'not_found' });

    // If flipping is_primary=true, demote any other primary of same method_type
    if (patch.is_primary === true) {
      await supabase
        .from('contact_methods')
        .update({ is_primary: false, updated_at: new Date().toISOString() })
        .eq('contact_id', existing.contact_id)
        .eq('method_type', existing.method_type)
        .eq('is_primary', true)
        .neq('id', req.params.methodId);
    }

    const { data, error } = await supabase
      .from('contact_methods').update(patch).eq('id', req.params.methodId).select().single();
    if (error) return res.status(500).json({ error: error.message });

    // Sync back to contacts.primary_email / .primary_phone if this is now primary
    if (data.is_primary) {
      const syncField = data.method_type === 'email' ? 'primary_email' : 'primary_phone';
      await supabase.from('contacts').update({ [syncField]: data.value, updated_at: new Date().toISOString() }).eq('id', data.contact_id);
    }
    res.json({ method: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/contact-methods/:methodId', async (req, res) => {
  try {
    const { error } = await supabase
      .from('contact_methods').delete().eq('id', req.params.methodId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// BULK CONTACT METHODS IMPORT — 3-tab xlsx (Address / Email / Phone) joined
// to contacts by vantaca_account_id. Same staged-preview-then-apply pattern
// as the Vantaca homeowner import: nothing writes to contact_methods until
// staff explicitly approves selections.
//
// POST /api/contacts/methods/import        — multipart, parse + diff, persist sync_log row, return preview
// POST /api/contacts/methods/import/:id/apply  — apply selected items
// GET  /api/contacts/methods/import/recent — list recent uploads
// ---------------------------------------------------------------------------
router.post('/contacts/methods/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'no_file_uploaded' });

    const parsed = parseContactInfoXlsx(req.file.buffer);
    if ((parsed.emails.length + parsed.phones.length + parsed.addresses.length) === 0) {
      return res.status(400).json({ error: 'no_recognized_rows', warnings: parsed.warnings });
    }

    const diff = await computeContactMethodsDiff(supabase, parsed);

    const { data: logRow, error: logErr } = await supabase
      .from('contact_methods_sync_log')
      .insert({
        uploaded_by: req.body.uploaded_by || null,
        file_name: req.file.originalname || null,
        total_rows: parsed.emails.length + parsed.phones.length + parsed.addresses.length,
        parsed_data: parsed,
        diff_summary: diff,
        status: 'previewed',
      })
      .select()
      .single();
    if (logErr) return res.status(500).json({ error: logErr.message });

    res.json({
      sync_log_id: logRow.id,
      file_name: req.file.originalname,
      sheet_counts: {
        addresses: parsed.addresses.length,
        emails: parsed.emails.length,
        phones: parsed.phones.length,
        balances: parsed.balances ? parsed.balances.length : 0,
      },
      counts: diff.counts,
      preview: diff,
      warnings: parsed.warnings,
    });
  } catch (err) {
    console.error('[contacts/methods/import]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/contacts/methods/import/:id/apply', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const { data: log, error: logErr } = await supabase
      .from('contact_methods_sync_log')
      .select('*').eq('id', req.params.id).maybeSingle();
    if (logErr || !log) return res.status(404).json({ error: 'sync_log_not_found' });
    if (log.status === 'applied') return res.status(409).json({ error: 'already_applied' });

    const diff = log.diff_summary || {};
    const apply = (req.body && req.body.apply) || {};
    const today = new Date().toISOString();

    const applied = {
      methods_added: 0,
      methods_primary_flipped: 0,
      methods_inconsistencies_resolved: 0,
      mailing_addresses_updated: 0,
      errors: [],
    };

    // Helper for resolving "all" vs Array<row_index> vs Array<{row, action}>
    const wantAll = (v) => v === 'all';
    const rowSet = (v) => Array.isArray(v) ? new Set(v.map((x) => typeof x === 'object' ? x.row : x)) : null;
    const actionMap = (v) => {
      if (!Array.isArray(v)) return null;
      const m = new Map();
      v.forEach((x) => { if (x && typeof x === 'object' && x.row != null) m.set(x.row, x.action || 'skip'); });
      return m;
    };

    // ---- FLAT-FIELD-ONLY MATCHES (silent sync into contact_methods) --------
    // These are MATCH classifications where the value is on the contact's
    // legacy primary/secondary flat field but not yet in contact_methods.
    // Auto-sync them so per-method notification subscriptions can target.
    // Always applied (no opt-in / opt-out from the UI — they're already on
    // file, just in a different shape).
    const flatSyncItems = ((diff.methods?.match) || []).filter((m) => m._flat_field_only);
    let flatSyncCount = 0;
    for (const item of flatSyncItems) {
      try {
        const { error } = await supabase.from('contact_methods').insert({
          contact_id: item.contact_id,
          method_type: item.method_type,
          value: item.value,
          is_primary: !!item._flat_is_primary,
          label: 'auto-synced from legacy flat field',
        });
        if (!error) flatSyncCount += 1;
      } catch (_) { /* non-fatal — flat field still works for sends */ }
    }
    applied.flat_field_synced_to_methods = flatSyncCount;

    // ---- NEW methods (insert) ------------------------------------------------
    const newItems = (diff.methods?.new) || [];
    if (newItems.length > 0) {
      const selected = wantAll(apply.new) ? newItems : (() => {
        const set = rowSet(apply.new);
        return set ? newItems.filter((r) => set.has(r.row)) : [];
      })();
      // For inserting primaries, first demote any existing primary of the same
      // (contact_id, method_type) so the unique-ish "one primary" invariant holds.
      // We do this in-loop because Promise.all of demote+insert can race.
      for (const item of selected) {
        try {
          if (item.is_primary) {
            await supabase
              .from('contact_methods')
              .update({ is_primary: false, updated_at: today })
              .eq('contact_id', item.contact_id)
              .eq('method_type', item.method_type)
              .eq('is_primary', true);
          }
          const { error: insErr } = await supabase.from('contact_methods').insert({
            contact_id: item.contact_id,
            method_type: item.method_type,
            value: item.value,
            is_primary: !!item.is_primary,
            subtype: item.inferred_subtype || null,
            label: item.label || null,
          });
          if (insErr) { applied.errors.push({ phase: 'new', row: item.row, error: insErr.message }); continue; }
          applied.methods_added += 1;
          // Sync to contacts.primary_email/.primary_phone if this becomes primary
          if (item.is_primary) {
            const syncField = item.method_type === 'email' ? 'primary_email' : 'primary_phone';
            await supabase.from('contacts').update({ [syncField]: item.value, updated_at: today }).eq('id', item.contact_id);
          }
        } catch (e) {
          applied.errors.push({ phase: 'new', row: item.row, error: e.message });
        }
      }
    }

    // ---- PRIMARY FLIPS (existing method, just toggle is_primary to match file) ----
    const flipItems = (diff.methods?.primary_flip) || [];
    if (flipItems.length > 0) {
      const selected = wantAll(apply.primary_flip) ? flipItems : (() => {
        const set = rowSet(apply.primary_flip);
        return set ? flipItems.filter((r) => set.has(r.row)) : [];
      })();
      for (const item of selected) {
        try {
          // If flipping TO primary, first demote any existing primary of same type for this contact
          if (item.file_primary) {
            await supabase
              .from('contact_methods')
              .update({ is_primary: false, updated_at: today })
              .eq('contact_id', item.contact_id)
              .eq('method_type', item.method_type)
              .eq('is_primary', true)
              .neq('id', item.existing_method_id);
          }
          const { error: updErr } = await supabase
            .from('contact_methods')
            .update({ is_primary: !!item.file_primary, updated_at: today })
            .eq('id', item.existing_method_id);
          if (updErr) { applied.errors.push({ phase: 'primary_flip', row: item.row, error: updErr.message }); continue; }
          applied.methods_primary_flipped += 1;
        } catch (e) {
          applied.errors.push({ phase: 'primary_flip', row: item.row, error: e.message });
        }
      }
    }

    // ---- INCONSISTENT (file says primary, db has different primary on file) ----
    // apply.inconsistent expected shape: [{ row, action: 'keep_file' | 'keep_db' | 'add_both' | 'skip' }]
    const incItems = (diff.methods?.inconsistent) || [];
    if (incItems.length > 0) {
      const actions = actionMap(apply.inconsistent);
      for (const item of incItems) {
        const action = actions ? actions.get(item.row) : (apply.inconsistent === 'keep_db' ? 'keep_db' : null);
        if (!action || action === 'skip') continue;
        try {
          if (action === 'keep_db') {
            // No-op for the DB; mark resolved
            applied.methods_inconsistencies_resolved += 1;
            continue;
          }
          if (action === 'keep_file') {
            // Insert the file's value as the new primary, demote current primary
            await supabase
              .from('contact_methods')
              .update({ is_primary: false, updated_at: today })
              .eq('contact_id', item.contact_id)
              .eq('method_type', item.method_type)
              .eq('is_primary', true);
            await supabase.from('contact_methods').insert({
              contact_id: item.contact_id,
              method_type: item.method_type,
              value: item.file_value,
              is_primary: true,
              subtype: null,
            });
            const syncField = item.method_type === 'email' ? 'primary_email' : 'primary_phone';
            await supabase.from('contacts').update({ [syncField]: item.file_value, updated_at: today }).eq('id', item.contact_id);
            applied.methods_inconsistencies_resolved += 1;
            applied.methods_added += 1;
          } else if (action === 'add_both') {
            // Keep current primary; add file's value as non-primary
            await supabase.from('contact_methods').insert({
              contact_id: item.contact_id,
              method_type: item.method_type,
              value: item.file_value,
              is_primary: false,
              subtype: null,
            });
            applied.methods_inconsistencies_resolved += 1;
            applied.methods_added += 1;
          }
        } catch (e) {
          applied.errors.push({ phase: 'inconsistent', row: item.row, error: e.message });
        }
      }
    }

    // ---- MAILING addresses ---------------------------------------------------
    const mailingNew = (diff.mailing?.new) || [];
    const mailingInc = (diff.mailing?.inconsistent) || [];
    if (mailingNew.length > 0) {
      const selected = wantAll(apply.mailing_new) ? mailingNew : (() => {
        const set = rowSet(apply.mailing_new);
        return set ? mailingNew.filter((r) => set.has(r.row)) : [];
      })();
      for (const item of selected) {
        try {
          const { error: e } = await supabase.from('contacts').update({ mailing_address: item.value, updated_at: today }).eq('id', item.contact_id);
          if (e) { applied.errors.push({ phase: 'mailing_new', row: item.row, error: e.message }); continue; }
          applied.mailing_addresses_updated += 1;
        } catch (e) {
          applied.errors.push({ phase: 'mailing_new', row: item.row, error: e.message });
        }
      }
    }
    if (mailingInc.length > 0) {
      const actions = actionMap(apply.mailing_inconsistent);
      for (const item of mailingInc) {
        const action = actions ? actions.get(item.row) : null;
        if (!action || action === 'skip' || action === 'keep_db') continue;
        if (action === 'keep_file') {
          try {
            const { error: e } = await supabase.from('contacts').update({ mailing_address: item.file_value, updated_at: today }).eq('id', item.contact_id);
            if (e) { applied.errors.push({ phase: 'mailing_inconsistent', row: item.row, error: e.message }); continue; }
            applied.mailing_addresses_updated += 1;
          } catch (e) {
            applied.errors.push({ phase: 'mailing_inconsistent', row: item.row, error: e.message });
          }
        }
      }
    }

    await supabase
      .from('contact_methods_sync_log')
      .update({
        status: 'applied',
        applied_at: today,
        applied_by: (req.body && req.body.applied_by) || null,
        applied_summary: applied,
      })
      .eq('id', log.id);

    res.json({ ok: true, applied });
  } catch (err) {
    console.error('[contacts/methods/import/apply]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// SMART EXTRACT — Claude reads pasted text OR an uploaded PDF/image and
// returns suggested contact_methods for staff to review + add.
//
// POST /api/contacts/:id/methods/extract
//   - multipart with 'file' (PDF or image, ≤10MB) OR
//   - JSON body with { text: '...' }
//   - returns { suggestions: [{ method_type, value, is_primary, subtype, label, confidence }], raw_text }
//
// Used by the profile modal's "✨ Smart extract" section. Suggestions are
// pre-filtered against the contact's existing contact_methods so duplicates
// don't appear (idempotent — paste the same signature twice, second time
// shows no suggestions).
// ---------------------------------------------------------------------------
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function _extractContactInfoFromClaude(input) {
  const prompt = `Read the following and extract every email address, phone number, and mailing address you can find. Distinguish primary vs secondary if context suggests it (e.g., "preferred" or "main" → primary). Infer subtype where possible (cell/mobile, work, home, spouse, property_manager).

Return ONLY a JSON object (no markdown, no commentary):
{
  "emails": [
    { "value": "string", "is_primary": true | false, "subtype": "personal" | "work" | "spouse" | "property_manager" | null, "label": "string or null", "confidence": "high" | "medium" | "low" }
  ],
  "phones": [
    { "value": "string formatted as found", "is_primary": true | false, "subtype": "cell" | "home" | "work" | "fax" | "spouse" | null, "label": "string or null", "confidence": "high" | "medium" | "low" }
  ],
  "mailing_address": "string or null — single composed mailing address if found",
  "name_hint": "string or null — if a name appears, return it for verification"
}

Confidence guide:
- high: explicitly labeled (e.g., "Email: ...", "Cell: ...", "Work phone: ...")
- medium: clear context but no explicit label
- low: ambiguous (could be either type, partial info)`;

  const content = [];
  if (input.text) {
    content.push({ type: 'text', text: `${prompt}\n\nTEXT:\n${String(input.text).slice(0, 8000)}` });
  } else if (input.fileBuffer && input.fileMimeType) {
    // PDF or image → use document/image content block
    if (input.fileMimeType === 'application/pdf') {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: input.fileBuffer.toString('base64') },
      });
      content.push({ type: 'text', text: prompt });
    } else if (input.fileMimeType.startsWith('image/')) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: input.fileMimeType, data: input.fileBuffer.toString('base64') },
      });
      content.push({ type: 'text', text: prompt });
    } else {
      throw new Error(`unsupported_file_type: ${input.fileMimeType}`);
    }
  } else {
    throw new Error('no_text_or_file_provided');
  }

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1500,
    messages: [{ role: 'user', content }],
  });
  const text = (resp.content[0]?.text || '').trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

router.post('/contacts/:id/methods/extract', upload.single('file'), async (req, res) => {
  try {
    // Body comes either as multipart with file (req.file) or JSON with text (req.body.text)
    let pastedText = req.body?.text;
    if (typeof pastedText !== 'string') pastedText = null;

    let extracted;
    try {
      extracted = await _extractContactInfoFromClaude({
        text: pastedText,
        fileBuffer: req.file?.buffer,
        fileMimeType: req.file?.mimetype,
      });
    } catch (err) {
      console.error('[contacts/methods/extract] Claude failed:', err.message);
      return res.status(500).json({ error: 'extraction_failed', detail: err.message });
    }

    // Pull existing contact_methods for this contact so we can dedupe suggestions
    const { data: existing } = await supabase
      .from('contact_methods')
      .select('method_type, value')
      .eq('contact_id', req.params.id);
    const existingEmails = new Set(((existing || []).filter((m) => m.method_type === 'email')).map((m) => String(m.value).toLowerCase()));
    const existingPhonesDigits = new Set(((existing || []).filter((m) => m.method_type === 'phone')).map((m) => String(m.value).replace(/\D+/g, '')));

    // Normalize + dedupe suggestions
    const suggestions = [];
    (extracted.emails || []).forEach((e) => {
      const v = String(e.value || '').trim().toLowerCase();
      if (!v || !v.includes('@')) return;
      if (existingEmails.has(v)) return; // already on file
      suggestions.push({
        method_type: 'email',
        value: v,
        is_primary: !!e.is_primary,
        subtype: e.subtype || null,
        label: e.label || null,
        confidence: e.confidence || 'medium',
      });
    });
    (extracted.phones || []).forEach((p) => {
      const v = String(p.value || '').trim();
      if (!v) return;
      const digits = v.replace(/\D+/g, '');
      if (digits.length < 7) return;
      if (existingPhonesDigits.has(digits)) return;
      suggestions.push({
        method_type: 'phone',
        value: v,
        is_primary: !!p.is_primary,
        subtype: p.subtype || null,
        label: p.label || null,
        confidence: p.confidence || 'medium',
      });
    });

    res.json({
      suggestions,
      mailing_address_suggestion: extracted.mailing_address || null,
      name_hint: extracted.name_hint || null,
      raw_extraction: extracted,
    });
  } catch (err) {
    console.error('[contacts/methods/extract]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/contacts/methods/import/recent', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('contact_methods_sync_log')
      .select('id, uploaded_by, uploaded_at, file_name, total_rows, status, applied_at, applied_summary, diff_summary')
      .order('uploaded_at', { ascending: false })
      .limit(20);
    if (error) return res.status(500).json({ error: error.message });
    const slim = (data || []).map((r) => ({
      ...r,
      // Strip the heavy detail blob from the list response
      diff_summary: r.diff_summary ? { counts: r.diff_summary.counts } : null,
    }));
    res.json({ uploads: slim });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// HOMEOWNER TAGS — add + revoke. Tags are time-bounded so "delete" is really
// "set revoked_at = now()" to preserve history.
// ---------------------------------------------------------------------------
router.post('/contacts/:id/tags', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.tag_key) return res.status(400).json({ error: 'tag_key_required' });
    const { data, error } = await supabase
      .from('homeowner_tags')
      .insert({
        contact_id:   req.params.id,
        community_id: b.community_id || null,
        tag_key:      b.tag_key,
        note:         b.note || null,
        granted_by:   b.granted_by || null,
      })
      .select('id, tag_key, community_id, note, granted_at, granted_by, communities(id, name)')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ tag: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/homeowner-tags/:tagId/revoke', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const { data, error } = await supabase
      .from('homeowner_tags')
      .update({
        revoked_at: new Date().toISOString(),
        revoked_by: b.revoked_by || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.tagId)
      .is('revoked_at', null)
      .select()
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'not_found_or_already_revoked' });
    res.json({ tag: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// HOMEOWNER NOTES — staff workspace (NEVER customer-visible). Add + edit.
// ---------------------------------------------------------------------------
router.post('/contacts/:id/notes', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.note_text || !b.note_text.trim()) return res.status(400).json({ error: 'note_text_required' });
    if (!b.author_email) return res.status(400).json({ error: 'author_email_required' });
    const { data, error } = await supabase
      .from('homeowner_notes')
      .insert({
        contact_id:   req.params.id,
        community_id: b.community_id || null,
        property_id:  b.property_id || null,
        note_text:    b.note_text.trim(),
        category:     b.category || 'general',
        author_email: b.author_email,
        pinned:       !!b.pinned,
      })
      .select('*, communities(id, name), properties(id, street_address)')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ note: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/homeowner-notes/:noteId', express.json(), async (req, res) => {
  try {
    const allowed = ['note_text', 'category', 'pinned', 'community_id', 'property_id'];
    const patch = { updated_at: new Date().toISOString() };
    allowed.forEach((k) => { if (k in (req.body || {})) patch[k] = req.body[k]; });
    const { data, error } = await supabase
      .from('homeowner_notes')
      .update(patch)
      .eq('id', req.params.noteId)
      .select('*, communities(id, name), properties(id, street_address)')
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.json({ note: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/homeowner-notes/:noteId', async (req, res) => {
  try {
    const { error } = await supabase
      .from('homeowner_notes').delete().eq('id', req.params.noteId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
