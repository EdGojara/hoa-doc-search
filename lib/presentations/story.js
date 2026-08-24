// ============================================================================
// lib/presentations/story.js — the canonical Bedrock narrative, as DATA.
// ----------------------------------------------------------------------------
// Ed 2026-08-24: build the pitch INTO trustEd (slide-screens with embedded
// AI-team video), keep a PowerPoint export, and keep the DEMO separate from the
// PROPOSAL. The demo is evergreen and audience-neutral; a proposal is the
// bespoke commercial offer to one party and lives elsewhere.
//
// THIS FILE IS THE ONE PLACE THE STORY LIVES. The in-platform presentation
// (public/present.html via /api/presentations/story) renders these screens as
// HTML slide-screens with video; the PowerPoint export (lib/presentations/
// partner.js) is being pointed at this same content so the two cannot drift.
// Until that convergence lands, the WORDS here are the source of truth and
// partner.js must be kept in step by hand — a known, disclosed transitional
// state, not a second silo. (Do not fork the narrative into a third place.)
//
// EVERGREEN RULE: nothing in a screen (and above all nothing in a VIDEO) may
// name an audience, a date, a count, or any fact that changes. "Seven
// communities" does not belong in the video; it dates the expensive asset and
// forces a re-render when it moves. Audience-specific and time-specific framing
// is a CHEAP text screen (`audience` field), swapped per viewing for free.
//
// Videos are referenced by `topic` only (bedrock_ai / acc / for_boards / ...).
// The live URL is resolved at request time from claire_explainers by topic +
// language, so a re-rendered cut is picked up with no change here. A topic with
// no ready video yet renders as a labelled placeholder, never a broken embed.
// ============================================================================

// Screen types the HTML renderer and the pptx builder both understand:
//   cover       dark title screen
//   statement   section label + headline + body
//   points      numbered points (01/02/03 …)
//   columns     section label + headline + body + N labelled columns of items
//   compare     two-sided comparison (left vs right)
//   video       a screen built around one embedded explainer video
//   roadmap     labelled milestone columns
//   closing     dark tagline screen
//
// `audience` on a screen: 'all' (default, always shown) or one of
// 'bank' | 'board' | 'partner'. A non-'all' screen shows only when the viewer
// picked that audience. This is the ONLY place the demo bends per audience.

const SCREENS = [
  {
    id: 'cover',
    type: 'cover',
    theme: 'dark',
    kicker: 'bEdrock Intelligence',
    title: 'trustEd',
    tagline: 'Community. Simplified.',
  },

  {
    id: 'insight',
    type: 'statement',
    theme: 'light',
    label: '01 / The insight',
    headline: 'HOA software was built for the wrong customer.',
    body: 'For 40 years, every tool in this industry has been sold to management companies, back-office software for processing fees, mailing notices, and tracking work orders. The people who actually live in the community, and the boards who govern it, have been an afterthought.',
    columns: [
      { header: 'Built for', items: ['Property management companies. Generic, low-margin, one-size-fits-all.'] },
      { header: 'Homeowners get', items: ['A portal they rarely log into. PDFs forwarded from a vendor. No voice.'] },
      { header: 'Boards get', items: ['Quarterly binders. Generic templates. No real analysis of their community.'] },
    ],
  },

  {
    id: 'result',
    type: 'points',
    theme: 'light',
    label: '02 / The result',
    headline: 'A generic industry. Mistakes that repeat.',
    points: [
      { n: '01', head: 'Generic templates instead of judgment', body: 'An ACC denial letter looks the same whether it is a fence in Phoenix or a roof in Houston. Boards can tell. Homeowners can tell.' },
      { n: '02', head: 'Knowledge that walks out the door', body: 'Every time a property manager leaves, the community loses years of context. The software never learned it.' },
      { n: '03', head: 'Tools that get faster, not smarter', body: 'Year 5 of using the same platform looks identical to year 1. AP gets processed quicker. Nothing else compounds.' },
    ],
  },

  {
    id: 'bedrock_ai_video',
    type: 'video',
    theme: 'dark',
    label: 'Meet the platform',
    headline: 'This is what we built.',
    body: 'Not a chatbot bolted onto old software. An operating system that reads a community and acts on it.',
    video_topic: 'bedrock_ai',
  },

  {
    id: 'category',
    type: 'points',
    theme: 'light',
    label: '03 / The category',
    headline: 'New categories start where an intermediary stops being necessary.',
    body: 'None of these companies won by building a better version of the incumbent product. Each made the previous arrangement look like an accident of its era, and the incumbents could not follow without dismantling the revenue they were built on.',
    points: [
      { n: 'Salesforce', head: '', body: 'Sold CRM as a subscription when serious software meant a server in your building. On-premise vendors could not match it without cannibalising licence revenue.' },
      { n: 'AWS', head: '', body: 'Turned infrastructure into a utility. The question stopped being which servers to buy and became why anyone would buy servers.' },
      { n: 'Bedrock', head: '', body: 'Removes the management company as the thing an association waits behind. Incumbents cannot copy it without automating away the staffing model they bill for.' },
    ],
    footnote: 'The defensibility is the same in all three cases. It is not the technology, it is that the incumbent’s own economics prevent them from following.',
  },

  {
    id: 'philosophy',
    type: 'statement',
    theme: 'dark',
    label: '04 / Our philosophy',
    headline: 'Bespoke at scale. There is no substitute.',
    body: 'Almost no two Porsche 911s leave Zuffenhausen alike. Thousands of options, stitching, gearbox, paint, leather, mean each car is configured to its owner. Bedrock builds the same way. Each community gets trustEd tuned to its bylaws, its board, its history. Not a product we push hoping it fits, a system we configure.',
  },

  {
    id: 'building',
    type: 'compare',
    theme: 'light',
    label: '05 / What we are building',
    headline: 'Senior judgment, encoded as software.',
    body: 'trustEd reads the bylaws, the roster, the budget, and the board’s voice, and it acts the way years of running these communities taught us to act. Not faster. Better. And it gets sharper every month it is in use.',
    left: { label: 'Most HOA AI', head: 'Process the same thing faster.', sub: 'Year 5 looks like year 1. Replaceable.' },
    right: { label: 'trustEd', head: 'Process the same thing better.', sub: 'Every decision sharpens the next one.' },
  },

  {
    id: 'acc_video',
    type: 'video',
    theme: 'dark',
    label: 'See it work',
    headline: 'One decision, start to finish.',
    body: 'A homeowner asks. The system reads the governing documents, applies the community’s own history, and produces a decision a board would stand behind.',
    video_topic: 'acc',
  },

  {
    id: 'moat',
    type: 'points',
    theme: 'light',
    label: '06 / Why this cannot be copied',
    headline: 'Four layers. Each one compounds.',
    points: [
      { n: '01', head: 'Community-specific data', body: 'Roster, governing docs, decision history, vendor performance, structured per community, not a generic database.' },
      { n: '02', head: 'Encoded judgment', body: 'Eight lenses on every recommendation, from do the numbers add up to will this hold up in front of the board. Not a generic model with a prompt.' },
      { n: '03', head: 'End-to-end workflow', body: 'Intake, AI assessment, manager queue, finalize, status update. One loop. Competitors sell standalone modules.' },
      { n: '04', head: 'Brand ownership', body: 'Every artifact a homeowner sees is Bedrock-rendered. No vendor PDFs forwarded. The output is the proof.' },
    ],
  },

  // ---- The one screen that bends per audience -----------------------------
  // The demo stays evergreen; the "why this matters to you" beat is a cheap
  // text screen swapped by audience. Commercial specifics (a real proposal)
  // live elsewhere, deliberately kept separate from the demo.
  {
    id: 'fit_board',
    type: 'columns',
    theme: 'light',
    audience: 'board',
    label: '07 / What this means for your board',
    headline: 'A board that finally sees its own community.',
    body: 'Not a quarterly binder. Real analysis, decisions you can defend, and a record that does not walk out the door when a manager leaves.',
    columns: [
      { header: 'You get', items: ['Decisions grounded in your own governing documents', 'Analysis specific to your community, not a template', 'A record that compounds instead of resetting'] },
      { header: 'We carry', items: ['The platform and the senior judgment inside it', 'Every homeowner-facing artifact, Bedrock-rendered', 'The institutional memory, kept and growing'] },
    ],
  },
  {
    id: 'fit_partner',
    type: 'columns',
    theme: 'light',
    audience: 'partner',
    label: '07 / Where you fit',
    headline: 'Operators, not franchisees.',
    body: 'You join a small partnership of operators, each running a book of communities they would be proud to serve. The brand and the operating system are shared. The relationships are yours. You do not need fifteen years in this industry, trustEd carries that for you.',
    columns: [
      { header: 'What you bring', items: ['Business judgment, not code skill', 'Local network and presence', 'Willingness to invest in a real book', 'Care about doing the work properly'] },
      { header: 'What Bedrock carries', items: ['Brand and customer-facing artifacts', 'The trustEd platform on day one', 'Training, playbook, and ongoing support', 'Senior-grade judgment in every workflow'] },
    ],
  },
  {
    id: 'fit_bank',
    type: 'columns',
    theme: 'light',
    audience: 'bank',
    label: '07 / Why this works for a banking partner',
    headline: 'When we grow, so does the deposit base.',
    body: 'Every community we take on banks its operating and reserve accounts with our banking partner. Our growth is their deposit growth, and the better we run those accounts, the less risk they carry holding them.',
    columns: [
      { header: 'The bank gains', items: ['Operating and reserve deposits that grow', 'Positive Pay and automated reconciliation', 'Lower fraud and error risk on the accounts held', 'Clients glad they made the referral'] },
      { header: 'The clients get', items: ['A manager that runs on senior judgment', 'Branded artifacts, never vendor PDFs', 'A portal and an assistant they can reach', 'Boards that get real analysis'] },
    ],
  },

  {
    id: 'roadmap',
    type: 'roadmap',
    theme: 'dark',
    label: '08 / Where this goes',
    headline: 'The same operating system, across markets and verticals.',
    milestones: [
      { when: 'Now', head: 'Bedrock Management', body: 'A live book of communities on trustEd.' },
      { when: 'Next', head: 'Second market', body: 'Prove the model is geography-agnostic.' },
      { when: 'Then', head: 'Operator network', body: 'Second-act professionals, Bedrock brand.' },
      { when: 'Beyond', head: 'Vendor verticals', body: 'Pool. Landscape. Same architecture.' },
    ],
  },

  {
    id: 'closing',
    type: 'closing',
    theme: 'dark',
    title: 'Community. Simplified.',
    kicker: 'bEdrock Intelligence  ·  bedrocktxai.com',
  },
];

const AUDIENCES = ['general', 'bank', 'board', 'partner'];

/**
 * The ordered screens for one audience. Non-'all' screens appear only for their
 * audience; 'general' shows the evergreen spine with no fit screen.
 */
function getStory(audience = 'general') {
  const aud = AUDIENCES.indexOf(audience) === -1 ? 'general' : audience;
  return SCREENS.filter((s) => !s.audience || s.audience === aud);
}

/** Every video topic the story references, for pre-resolving URLs. */
function videoTopics() {
  return [...new Set(SCREENS.filter((s) => s.video_topic).map((s) => s.video_topic))];
}

module.exports = { SCREENS, AUDIENCES, getStory, videoTopics };
