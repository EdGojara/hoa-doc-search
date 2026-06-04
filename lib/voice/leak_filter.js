// ============================================================================
// lib/voice/leak_filter.js
// ----------------------------------------------------------------------------
// IP-protection screener for any text bound for a homeowner, board member,
// or employee outside the admin tier. Catches phrases that expose Bedrock's
// operating model, decision framework, or proprietary methodology before
// the text ships.
//
// Threat model (per memory: feedback_ip_protection.md):
//   - Competitors live in our managed communities and may sit on boards
//   - At least one named board member has already misappropriated a
//     Bedrock RFP template and claimed it as their own
//   - Any letter, email, askEd response, or board packet that describes
//     internal mechanics is a free competitor briefing
//
// Why this module instead of "be careful in prompts":
//   - Defense in depth. Prompts drift over time; a banned-phrase scrubber
//     is a final, deterministic gate.
//   - Works across every surface uniformly. One source of truth for what
//     "leaks" vs. what's safe to ship.
//
// Voice rules baked in:
//   - feedback_no_document_citation_voice.md — no verbatim Article/Section
//     references in customer-bound text; conversational phrasing only
//   - feedback_ip_protection.md — describe outcomes, not internal mechanics
//   - feedback_no_claude_branding.md — model identifiers never appear
//   - feedback_marketing_compliance.md — no "audit-grade" / "AI-powered"
//     marketing claims
// ============================================================================

// Phrases that should NEVER appear in customer/board/non-admin-employee text.
// Each entry: { pattern, why, replacement?, severity, moat? }
// severity = 'block' → call must fail; 'rewrite' → auto-substitute and warn;
//            'warn' → flag for review but ship.
// moat = true → rule fires at staff tier too (these expose Bedrock's
//   operating model / methodology — the actual secret sauce a competitor
//   on a board could brief themselves from). Untagged rules fire only at
//   customer tier; staff (community managers using askEd internally) see
//   the substance through because they need it to operate.
const BANNED_PHRASES = [
  // ---- Operating-model / methodology exposure (MOAT — block at staff too) ----
  { pattern: /\bdefensible\b/gi, why: 'litigation-posture word; reveals legal-defense framing', replacement: 'supported by the documents', severity: 'rewrite' },
  { pattern: /\bworkpaper(s)?\b/gi, why: 'internal CPA-style label', replacement: 'review notes', severity: 'rewrite', moat: true },
  { pattern: /\binternal\s+review\b/gi, why: 'reveals the system has internal vs external surfaces', replacement: 'committee review', severity: 'rewrite' },
  { pattern: /\bprocessing\s+strategy\b/gi, why: 'reveals decision playbook', severity: 'block', moat: true },
  { pattern: /\bthe\s+playbook\b/gi, why: 'reveals proprietary playbook', severity: 'block', moat: true },
  { pattern: /\btriangulat(e|ed|ion|ing)\b/gi, why: 'reveals multi-lens analytical framework', severity: 'block', moat: true },
  { pattern: /\bmulti-?lens\b/gi, why: 'reveals lens-firing framework', severity: 'block', moat: true },
  { pattern: /\bencode[- ]ed\b/gi, why: 'reveals encode-Ed product thesis', severity: 'block', moat: true },
  { pattern: /\bthe\s+system\s+flag(s|ged|ging)?\b/gi, why: 'reveals automated triage', severity: 'rewrite', replacement: 'we noticed' },
  { pattern: /\boperating\s+model\b/gi, why: 'reveals Bedrock operating-model framing', severity: 'rewrite', replacement: 'our process', moat: true },
  { pattern: /\bbedrock\s+(intelligence|ai|platform)\b/gi, why: 'reveals platform branding to non-admin audience', severity: 'rewrite', replacement: 'Bedrock' },
  { pattern: /\btrustEd\b/gi, why: 'product/platform brand name should not appear in customer-facing text', severity: 'rewrite', replacement: 'Bedrock' },
  { pattern: /\bsmell[- ]test\b/gi, why: 'internal HFT-derived term', severity: 'rewrite', replacement: 'review', moat: true },

  // ---- AI / model exposure ----
  { pattern: /\bpreliminary\s+AI\b/gi, why: 'reveals AI-first decisioning to homeowner audience', severity: 'rewrite', replacement: 'preliminary' },
  { pattern: /\bAI[- ]generated\b/gi, why: 'reveals AI authorship', severity: 'block' },
  { pattern: /\bAI[- ]assessment\b/gi, why: 'reveals AI-first decisioning', severity: 'rewrite', replacement: 'preliminary review' },
  { pattern: /\bclaude(?!-?code)\b/gi, why: 'underlying model name; never in customer surface', severity: 'block' },
  { pattern: /\banthropic\b/gi, why: 'underlying provider name; never in customer surface', severity: 'block' },
  { pattern: /\b(gpt|openai|chatgpt|gemini)\b/gi, why: 'other-model name; never in customer surface', severity: 'block' },
  { pattern: /\blarge\s+language\s+model\b/gi, why: 'AI implementation detail', severity: 'block' },

  // ---- Document-citation voice (feedback_no_document_citation_voice.md) ----
  // SOFTEN verbatim Article/Section/Paragraph references into conversational
  // register — do NOT block. The memory note's own rule is "convert the
  // citation register," e.g. "state law requires…" instead of "Section
  // 209.0051 requires…". Blocking deleted entire correct answers (the askEd
  // org-meeting bug, 2026-06-03): a §209 cite in a staff legal lookup is
  // citation VOICE, not a competitor-briefing IP leak. Rewrite keeps the
  // substance, strips the paralegal register, and stays forward-safe if a
  // staffer pastes the text into a homeowner email. The genuinely
  // catastrophic leaks (triangulation, encode-ed, model names) stay 'block'.
  // Ordering matters: the "Section X.Y - HEADING" TOC pattern must fire
  // BEFORE the bare "Section X.Y" pattern, otherwise we get
  // "the applicable rules - ORGANIZATION MEETING" (clunky text Ed flagged
  // 2026-06-03). Strip the citation entirely when it's adjacent to a
  // heading — the heading itself carries the meaning.
  { pattern: /\b(?:Article\s+[IVXLCDM]+(?:,?\s+Section\s+\d+(?:\.\d+)*)?|Section\s+\d+(?:\.\d+)*)\s*[-–—:]\s*(?=[A-Z])/g, why: 'TOC-style citation adjacent to heading', severity: 'rewrite', replacement: '' },
  { pattern: /\bArticle\s+[IVXLCDM]+(?:,?\s+Section\s+\d+(?:\.\d+)*)?\b/g, why: 'verbatim CC&R Article reference in customer voice', severity: 'rewrite', replacement: 'the bylaws' },
  { pattern: /\bSection\s+\d+(?:\.\d+)+\b/g, why: 'verbatim Section reference in customer voice', severity: 'rewrite', replacement: 'the bylaws' },
  { pattern: /\bparagraph\s+\d+(?:\.\d+)*\b/gi, why: 'verbatim paragraph reference in customer voice', severity: 'rewrite', replacement: 'that part' },
  { pattern: /\bTex\.?\s*Prop\.?\s*Code\b/gi, why: 'formal statute citation in customer voice', severity: 'rewrite', replacement: 'Texas state law' },
  { pattern: /\bTexas\s+Property\s+Code\b/gi, why: 'formal statute citation in customer voice', severity: 'warn' },
  { pattern: /§\s*\d{3}(?:\.\d+)*/g, why: 'statute section symbol in customer voice', severity: 'rewrite', replacement: 'state law' },
  { pattern: /\bCC&Rs?\b/g, why: 'jargon abbreviation; use "community standards" or "governing documents"', severity: 'rewrite', replacement: 'governing documents' },
  { pattern: /\bDeclaration\s+of\s+Covenants(?:,\s*Conditions\s+(?:and|&)\s+Restrictions)?\b/gi, why: 'formal document title in customer voice', severity: 'rewrite', replacement: 'governing documents' },

  // ---- Markdown / formatting that signals internal output ----
  { pattern: /^#{1,6}\s+\d+\.\s+(APPLICANT\s+SUMMARY|COMPLETENESS\s+CHECK|DOCUMENT\s+REVIEW|RECOMMENDATION|CONDITIONS|INTERNAL\s+NOTE)/gmi, why: 'internal analysis section header leaked into customer text', severity: 'block' },
  { pattern: /^\s*##?\s*\d+\.\s/gm, why: 'numbered section heading pattern from workpaper', severity: 'warn' },
  { pattern: /\[INTERNAL\b[^\]]*\]/gi, why: 'INTERNAL bracket tag', severity: 'block' },
  { pattern: /\bDO NOT (?:SEND|DISTRIBUTE|FORWARD|SHARE)\b/gi, why: 'internal-only stamp leaked', severity: 'block' },

  // ---- Marketing-compliance (feedback_marketing_compliance.md) ----
  { pattern: /\baudit[- ]grade\b/gi, why: 'banned audit-grade claim', severity: 'block' },
  { pattern: /\bfraud\s+detection\b/gi, why: 'service-claim language Ed has banned in marketing', severity: 'rewrite', replacement: 'review' },
  { pattern: /\bCPA[- ]grade\b/gi, why: 'banned credential-title-suffix claim', severity: 'block' },
];

// Phrases that are NEVER okay even with admin context (e.g., letterhead leaks).
// Audit 2026-06-04: expanded to cover model nicknames the underlying providers
// use in marketing — these slip into model output sometimes ("As a Sonnet
// 4.5 instance, I..."). Covered: Anthropic family (Sonnet/Haiku/Opus), open
// weights (Llama, Mistral, Qwen, DeepSeek), and xAI's Grok.
const ALWAYS_BLOCKED = [
  /\bclaude(?!-?code)\b/gi,
  /\banthropic\b/gi,
  /\b(gpt|openai|chatgpt|gemini)\b/gi,
  /\b(sonnet|haiku|opus|llama|mistral|deepseek|grok|qwen)\b/gi,
];

/**
 * Screen a string for IP-leak phrases.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {'customer'|'board'|'staff'|'admin'} [opts.audience='customer']
 *        Which audience this text is bound for. 'admin' is Ed and only
 *        Ed — bypasses most checks, keeps the ALWAYS_BLOCKED ones.
 * @param {boolean} [opts.autoRewrite=true]  Apply 'rewrite' replacements
 *        automatically. False = leave the original text but report.
 * @returns {{ok: boolean, text: string, violations: Array, rewrites: Array, blocks: Array}}
 */
function screenForLeaks(text, opts = {}) {
  const audience = opts.audience || 'customer';
  const autoRewrite = opts.autoRewrite !== false;
  const original = String(text || '');
  let out = original;
  const violations = [];
  const rewrites = [];
  const blocks = [];

  if (!original) return { ok: true, text: out, violations, rewrites, blocks };

  // Audience tiers (Ed 2026-06-03):
  //   admin    → Ed only. Just model names blocked, everything else through.
  //   staff    → community manager using an internal tool (askEd, lookups).
  //              They are professional operators who NEED full technical
  //              substance — section numbers, statute cites, document titles,
  //              the AI-implementation truth. We block ONLY the operating-model
  //              moat (`moat: true` rules) plus ALWAYS_BLOCKED model names.
  //              Forward-to-customer pathways re-screen at customer strictness.
  //   customer → homeowner / board / outside-the-firm audience. Full
  //              BANNED_PHRASES applies — citations soften to conversational
  //              ("the bylaws say…"), moat blocks fire, marketing claims block.
  let rules;
  if (audience === 'admin') {
    rules = ALWAYS_BLOCKED.map((p) => ({ pattern: p, why: 'never in any output', severity: 'block' }));
  } else if (audience === 'staff') {
    rules = [
      ...ALWAYS_BLOCKED.map((p) => ({ pattern: p, why: 'model name leak', severity: 'block' })),
      ...BANNED_PHRASES.filter((r) => r.moat === true),
    ];
  } else {
    rules = BANNED_PHRASES;
  }

  for (const rule of rules) {
    const matches = [...original.matchAll(rule.pattern)];
    if (matches.length === 0) continue;
    const violation = {
      code: rule.severity.toUpperCase(),
      severity: rule.severity,
      reason: rule.why,
      matches: matches.map((m) => m[0]).slice(0, 5),
      occurrences: matches.length,
    };
    violations.push(violation);

    if (rule.severity === 'block') {
      blocks.push(violation);
    } else if (rule.severity === 'rewrite' && autoRewrite && rule.replacement != null) {
      out = out.replace(rule.pattern, rule.replacement);
      rewrites.push({ ...violation, replacement: rule.replacement });
    }
  }

  return {
    ok: blocks.length === 0,
    text: out,
    violations,
    rewrites,
    blocks,
  };
}

/**
 * Convenience: throw if the text has any block-severity leak. Use on
 * surfaces where we WANT the request to fail rather than ship leaky text.
 */
function assertNoLeaks(text, opts = {}) {
  const r = screenForLeaks(text, opts);
  if (!r.ok) {
    const codes = r.blocks.map((b) => `${b.reason} (matched: "${b.matches.join('", "')}")`).join('; ');
    const err = new Error(`IP-leak guard fired: ${codes}`);
    err.code = 'IP_LEAK_BLOCKED';
    err.violations = r.violations;
    throw err;
  }
  return r.text;
}

module.exports = {
  screenForLeaks,
  assertNoLeaks,
  BANNED_PHRASES,
  ALWAYS_BLOCKED,
};
