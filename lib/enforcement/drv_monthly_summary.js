// ============================================================================
// lib/enforcement/drv_monthly_summary.js  (Ed 2026-08-06)
// ----------------------------------------------------------------------------
// The monthly, community-facing DRV summary that powers the Calendar's "DRV
// Summary" tab. It is DELIBERATELY not the billing Activity Report (that stays
// exactly as-is): this is a curated update for the association — a snapshot,
// the top violation TYPES by category, and a warm AI narrative + things-to-watch.
//
// Two rules baked in, both from Ed:
//  1. CURRENT MONTH ONLY, no carryovers. The category mix counts violations
//     OPENED in the month (new this month), never prior-month items still open.
//  2. Notice counts come from the same source the Activity Report uses —
//     `interactions` letters by postmark_date + type — so the numbers tie out:
//       letter_courtesy_1 = first notice, letter_courtesy_2 = second,
//       letter_209 = certified. (Voided violations are excluded from the mix.)
//
// Record ownership: workpaper while drafting; the delivered summary is an
// association_record (it goes to the board/community). No new table — reads
// existing violations + interactions.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 'YYYY-MM' -> { start:'YYYY-MM-01', endEx:'YYYY-MM-01' of next month, label }
function monthBounds(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) throw Object.assign(new Error('month must be YYYY-MM'), { code: 'invalid_input' });
  const y = Number(m[1]), mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw Object.assign(new Error('invalid month'), { code: 'invalid_input' });
  const start = `${m[1]}-${m[2]}-01`;
  const ny = mo === 12 ? y + 1 : y;
  const nmo = mo === 12 ? 1 : mo + 1;
  const endEx = `${ny}-${String(nmo).padStart(2, '0')}-01`;
  const label = new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { start, endEx, label };
}

async function countNotice(cid, type, start, endEx) {
  const { count, error } = await supabase.from('interactions')
    .select('*', { count: 'exact', head: true })
    .eq('community_id', cid).eq('type', type)
    .not('printed_at', 'is', null)
    .gte('postmark_date', start).lt('postmark_date', endEx);
  if (error) throw error;
  return count || 0;
}

// New (non-voided) violations opened in the month. Paginated + ordered so it is
// correct at any community size (the 1000-row cap scar).
async function fetchOpenedViolations(cid, start, endEx) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('violations')
      .select('primary_category_id, current_stage')
      .eq('community_id', cid)
      .gte('opened_at', start).lt('opened_at', endEx)
      .neq('current_stage', 'voided')
      .order('opened_at', { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function buildDrvSummaryData({ communityId, month }) {
  if (!communityId) throw Object.assign(new Error('community_id_required'), { code: 'invalid_input' });
  const { start, endEx, label } = monthBounds(month);

  const { data: comm, error: ce } = await supabase.from('communities').select('id, name').eq('id', communityId).maybeSingle();
  if (ce) throw ce;
  if (!comm) throw Object.assign(new Error('community_not_found'), { code: 'not_found' });

  const [first, second, certified, opened] = await Promise.all([
    countNotice(communityId, 'letter_courtesy_1', start, endEx),
    countNotice(communityId, 'letter_courtesy_2', start, endEx),
    countNotice(communityId, 'letter_209', start, endEx),
    fetchOpenedViolations(communityId, start, endEx),
  ]);

  const total = opened.length;
  const ids = [...new Set(opened.map((v) => v.primary_category_id).filter(Boolean))];
  const labelById = {};
  if (ids.length) {
    const { data: cats, error } = await supabase.from('enforcement_categories').select('id, label').in('id', ids);
    if (error) throw error;
    (cats || []).forEach((c) => { labelById[c.id] = c.label; });
  }
  const counts = {};
  for (const v of opened) {
    const k = labelById[v.primary_category_id] || 'Other';
    counts[k] = (counts[k] || 0) + 1;
  }
  // Percent of the NEW-this-month total. Sorted desc; ties broken by label.
  const categories = Object.entries(counts)
    .map(([category, count]) => ({ category, count, pct: total ? Math.round((count / total) * 100) : 0 }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

  return {
    community_id: communityId,
    community_name: comm.name,
    month,
    month_label: label,
    snapshot: {
      first_notices: first,
      second_notices: second,
      certified_letters: certified,
      new_violations: total,
    },
    categories,
  };
}

// Strip anything that isn't allowed in customer copy: em/en dashes -> comma,
// markdown bullets/asterisks -> clean. (Ed's no-em-dash rule for customer text.)
function cleanCustomerText(s) {
  return String(s || '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\*\*?([^*]+)\*\*?/g, '$1')
    .replace(/^\s*[-•]\s*/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Warm, community-facing narrative + 3 things to watch. Bedrock voice, honest,
// names the top categories. Never invents numbers — it is handed the real ones.
async function generateNarrative(data) {
  const top = data.categories.slice(0, 5).map((c) => `${c.category} (${c.pct}%)`).join(', ');
  const prompt = `You are writing a short, warm community update for the homeowners of ${data.community_name} about deed restriction activity in ${data.month_label}. This is friendly and reassuring, never scolding.

REAL DATA (do not invent or change any numbers):
- New violations noted this month: ${data.snapshot.new_violations}
- First notices: ${data.snapshot.first_notices}; Second notices: ${data.snapshot.second_notices}; Certified letters: ${data.snapshot.certified_letters}
- Top violation types this month: ${top || '(none)'}

Write TWO things and return STRICT JSON only:
{
  "message": "3-5 sentence warm paragraph. Thank neighbors, name the top 2-3 categories in plain language, add a seasonal/weather note if it fits the month, and reassure that a notice is just a friendly reminder and to contact management with questions.",
  "watch_items": ["three short action bullets tied to the top categories, imperative voice, each under 15 words"]
}

STRICT RULES: No em-dashes (use commas). No markdown. No exclamation-point overload. Do not restate raw counts as a list. Plain, human, specific. Output ONLY the JSON.`;

  try {
    const r = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
    });
    let txt = (r.content?.[0]?.text || '').trim();
    const jStart = txt.indexOf('{'), jEnd = txt.lastIndexOf('}');
    if (jStart >= 0 && jEnd > jStart) txt = txt.slice(jStart, jEnd + 1);
    const parsed = JSON.parse(txt);
    const message = cleanCustomerText(parsed.message);
    let watch = Array.isArray(parsed.watch_items) ? parsed.watch_items.map(cleanCustomerText).filter(Boolean).slice(0, 3) : [];
    if (!message) throw new Error('empty message');
    return { message, watch_items: watch };
  } catch (e) {
    // Honest fallback: a plain, correct message built from the real data — never
    // a blank or a broken artifact (silent-failure rule).
    const top3 = data.categories.slice(0, 3).map((c) => c.category).join(', ');
    return {
      message: cleanCustomerText(
        `Thank you to everyone who helps keep ${data.community_name} looking its best. This month the most common items were ${top3 || 'routine maintenance reminders'}. If you receive a notice, please know it is simply a friendly reminder to address something that may have been overlooked. Reach out to management anytime with questions or if you need a little extra time.`
      ),
      watch_items: data.categories.slice(0, 3).map((c) => `Address ${c.category.toLowerCase()} before it becomes a repeat notice.`),
      narrative_fallback: true,
    };
  }
}

async function buildDrvMonthlySummary({ communityId, month }) {
  const data = await buildDrvSummaryData({ communityId, month });
  const narrative = await generateNarrative(data);
  return { ...data, ...narrative };
}

module.exports = { buildDrvMonthlySummary, buildDrvSummaryData, monthBounds, cleanCustomerText };
