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

// A title that names a property, a person, a specific project, or a decision is
// somebody's SUBMITTED application — never a blank form to hand out.
// The 'arc_application' category holds BOTH blank forms and completed
// submissions, and nothing here could tell them apart.
const NOT_A_BLANK_FORM = /\d{3,}|\b(approval|approved|denied|pending|repair|replacement|replace|removal|remove|install|addition|gazebo|shed|fence|patio|pergola|window|door|roof|driveway|walkway|sidewalk|tree|pool|deck|paint|siding|solar|generator)\b/i;
const isBlankForm = (title) => !NOT_A_BLANK_FORM.test(String(title || ''));

// The community's BLANK form, or null. FAILS CLOSED — sending nothing is always
// better than sending the wrong thing.
//
// Scar (Ed 2026-07-15): this query had no status filter, no provenance filter,
// no blank-vs-submitted test, and .limit(1) with NO ordering — so it returned an
// arbitrary row from 9 candidates. Live, it returned "Architectural Review
// Application - Roof Repair - 5114 Quill Rush Way": ANOTHER HOMEOWNER'S
// COMPLETED APPLICATION, with their address and project. Claire attaches this
// whenever she says "I'm sending you an application." That is a privacy breach
// (one owner's PII mailed to another), and it could also ship a retired
// predecessor (CastleCare) form under Bedrock's name. Ed: "nothing that is
// CastleCare should go to a homeowner."
async function getArcApplicationForm(communityId) {
  if (!communityId) return null;
  try {
    const { data } = await supabase.from('library_documents')
      .select('id, title, file_path, status, created_by_mgmt_company, uploaded_at')
      .eq('community_id', communityId).eq('category', 'arc_application')
      .eq('status', 'current')                       // never retired/superseded
      .neq('created_by_mgmt_company', 'Predecessor') // never a predecessor's form
      .not('file_path', 'is', null)
      .or('title.ilike.%application form%,title.ilike.%review application%')
      .limit(50);
    const blanks = (data || []).filter((d) => d.file_path && isBlankForm(d.title));
    if (!blanks.length) {
      console.warn(`[arc_application] no BLANK current ARC form for community ${communityId} — attaching nothing rather than risk sending someone else's application`);
      return null;
    }
    // Deterministic: Bedrock-authored first, then newest. Never arbitrary.
    blanks.sort((a, b) => {
      const rank = (d) => (d.created_by_mgmt_company === 'Bedrock' ? 1 : 0);
      return (rank(b) - rank(a)) || (new Date(b.uploaded_at || 0) - new Date(a.uploaded_at || 0));
    });
    return blanks[0];
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
