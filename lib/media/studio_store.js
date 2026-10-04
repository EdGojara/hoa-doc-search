// ============================================================================
// lib/media/studio_store.js  (Issue #10 Media Studio V1) — project persistence
// ----------------------------------------------------------------------------
// V1 keeps projects as JSON files (one per project) because no schema migration
// was authorized for this pass. The interface (list / get / save) is the seam a
// table-backed store replaces later (proposal: templates/media-studio-v1-schema.proposal.md).
// IMPORTANT: on Render the disk is ephemeral, so this store is for local review
// only; it is not a production record until the table lands.
// ============================================================================
const fs = require('fs');
const path = require('path');

const DIR = () => process.env.MEDIA_STUDIO_DIR || path.join(__dirname, '..', '..', 'data', 'media_studio');
const ID = /^[0-9a-f]{12}$/;

function ensure() { fs.mkdirSync(DIR(), { recursive: true }); }
const file = (id) => { if (!ID.test(String(id))) throw Object.assign(new Error('bad project id'), { code: 'NOT_FOUND' }); return path.join(DIR(), `${id}.json`); };

function get(id) {
  const f = file(id);
  if (!fs.existsSync(f)) throw Object.assign(new Error('project not found'), { code: 'NOT_FOUND' });
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function save(project) {
  ensure();
  const f = file(project.id); const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(project, null, 2)); fs.renameSync(tmp, f); // atomic replace
  return project;
}

function list({ limit = 200 } = {}) {
  ensure();
  const out = [];
  for (const n of fs.readdirSync(DIR())) {
    if (!/^[0-9a-f]{12}\.json$/.test(n)) continue;
    try {
      const p = JSON.parse(fs.readFileSync(path.join(DIR(), n), 'utf8'));
      out.push({ id: p.id, title: p.title, kind: p.kind, status: p.status, production_mode: p.production_mode, target_seconds: p.target_seconds, created_at: p.created_at, updated_at: p.updated_at });
    } catch (e) { console.warn('[media_studio] unreadable project file', n, e.message); }
  }
  return out.sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at))).slice(0, limit);
}

module.exports = { get, save, list, DIR };
