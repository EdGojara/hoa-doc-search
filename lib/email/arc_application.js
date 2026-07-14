// ============================================================================
// lib/email/arc_application.js  (Ed 2026-07-14)
// ----------------------------------------------------------------------------
// A homeowner asking about building/installing something (shed, fence, patio)
// needs the actual ARC/architectural application to submit — not just a
// description of the process. This finds a community's BLANK application form
// (library_documents category 'arc_application', a form/review-application
// titled doc with a stored file) and returns it as a Graph fileAttachment ready
// for graphSend.sendAs. Best-effort: returns null if the community has no form.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BUCKET = 'documents';

// The blank form doc for a community, or null. { title, file_path }.
async function getArcApplicationForm(communityId) {
  if (!communityId) return null;
  try {
    const { data } = await supabase.from('library_documents')
      .select('title, file_path')
      .eq('community_id', communityId).eq('category', 'arc_application')
      .not('file_path', 'is', null)
      .or('title.ilike.%application form%,title.ilike.%review application%')
      .limit(1);
    const doc = data && data[0];
    return (doc && doc.file_path) ? doc : null;
  } catch (_) { return null; }
}

// The form downloaded from storage as a Graph fileAttachment (+ its title), or
// null. Caller appends to sendAs's attachments array.
async function getArcApplicationAttachment(communityId) {
  const doc = await getArcApplicationForm(communityId);
  if (!doc) return null;
  try {
    const { data: file, error } = await supabase.storage.from(BUCKET).download(doc.file_path);
    if (error || !file) return null;
    const buf = Buffer.from(await file.arrayBuffer());
    if (!buf.length || buf.length > 8 * 1024 * 1024) return null;
    const name = String(doc.title || 'Architectural Review Application').replace(/[^\w .\-]/g, '').slice(0, 80).trim() + '.pdf';
    return {
      title: doc.title,
      attachment: {
        '@odata.type': '#microsoft.graph.fileAttachment',
        name,
        contentType: 'application/pdf',
        contentBytes: buf.toString('base64'),
      },
    };
  } catch (_) { return null; }
}

module.exports = { getArcApplicationForm, getArcApplicationAttachment };
