-- ============================================================================
-- 385 — Board Learning. Education for board members, in the board portal.
-- ----------------------------------------------------------------------------
-- Ed 2026-08-25: "board education in our portal as a feature ... many board
-- members are new and genuinely don't know what to do."
--
-- The differentiator is NOT a generic course library (CAI already sells that).
-- It is education grounded in Texas Chapter 209 and, through the tutor endpoint,
-- in THIS community's own governing documents, delivered where the board already
-- works. This table holds the portfolio-wide written modules; the AI tutor
-- (api/board_portal.js POST /learning/ask) grounds answers in the community's
-- docs via the existing hybrid retrieval, no new content stored per community.
--
-- LEGAL-ACCURACY DISCIPLINE. Board education sits next to legal advice, which is
-- a liability line. So:
--   * review_status starts 'draft'. Content is educational and general; a law
--     firm reviews it and flips it to 'counsel_reviewed' before it carries that
--     weight. The portal shows the status honestly.
--   * modules teach the framework and always defer specifics to the community's
--     own documents and to counsel. They are not a substitute for either.
--   * the tutor cites its sources and refuses to render a legal opinion on a
--     consequential matter, pointing to counsel instead.
--
-- Record ownership: workpaper (Bedrock IP). This is Bedrock-authored education
-- reused across every community, not a community-scoped association record.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS board_learning_modules (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           TEXT NOT NULL UNIQUE,
  category       TEXT NOT NULL
                   CHECK (category IN ('fiduciary','meetings','records','enforcement','finance','architectural','elections','general')),
  title          TEXT NOT NULL,
  summary        TEXT NOT NULL,              -- one line, shown on the card
  body           TEXT NOT NULL,              -- markdown, the module content
  key_points     TEXT[] NOT NULL DEFAULT '{}',
  statute_refs   TEXT[] NOT NULL DEFAULT '{}',  -- e.g. 'Tex. Prop. Code ch. 209'
  source_note    TEXT,                        -- where the content comes from
  review_status  TEXT NOT NULL DEFAULT 'draft'
                   CHECK (review_status IN ('draft','counsel_reviewed')),
  reviewed_by    TEXT,                        -- firm / attorney who signed off
  reviewed_at    TIMESTAMPTZ,
  read_minutes   INTEGER NOT NULL DEFAULT 3,
  display_order  INTEGER NOT NULL DEFAULT 100,
  is_published   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS board_learning_published_idx
  ON board_learning_modules (display_order) WHERE is_published = TRUE;

DROP TRIGGER IF EXISTS trg_board_learning_updated_at ON board_learning_modules;
CREATE TRIGGER trg_board_learning_updated_at
  BEFORE UPDATE ON board_learning_modules
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

COMMENT ON TABLE board_learning_modules IS
  'Board-education modules shown in the board portal. Workpaper (Bedrock IP). Content is general education, not legal advice; review_status gates whether a law firm has signed off.';
COMMENT ON COLUMN board_learning_modules.review_status IS
  'draft = Bedrock-authored, awaiting a law firm review. counsel_reviewed = a firm signed off (record who in reviewed_by).';

GRANT SELECT, INSERT, UPDATE, DELETE ON board_learning_modules TO service_role;
GRANT SELECT ON board_learning_modules TO authenticated;

-- ---------------------------------------------------------------------------
-- Seed: six core modules. Draft, pending a law firm review. Content is general
-- Texas HOA governance education; specifics always defer to the community's own
-- governing documents and to counsel.
-- ---------------------------------------------------------------------------
INSERT INTO board_learning_modules (slug, category, title, summary, body, key_points, statute_refs, source_note, display_order, read_minutes)
VALUES
(
  'what-a-board-does', 'fiduciary',
  'What a board member actually does',
  'Your role, your duties, and whose interest you serve.',
  E'Welcome to the board. If this is new to you, the most important thing to understand is that you are now a fiduciary. That means you are legally expected to act in the best interest of the association as a whole, not any one owner, not your own street, and not your own preferences.\n\nThree duties sit under that:\n\n**Duty of care.** Come prepared, read what you are sent, ask questions, and make decisions based on real information. You do not have to be an expert. You do have to pay attention and use good judgment.\n\n**Duty of loyalty.** Put the association ahead of your personal interest. If a vote affects you, a vendor you know, or your own property, say so and step back from it.\n\n**Duty to act within your authority.** The association runs on its governing documents (the declaration, the bylaws, the rules) and on Texas law. The board''s power comes from those documents. When they and the law are silent or unclear, that is exactly when to ask your manager or counsel before acting.\n\nYou are not alone in this. Bedrock handles the day-to-day operations; the board sets policy, handles the exceptions, and makes the decisions that carry legal weight. Fines, liens, and denials are board decisions, and money does not leave the association''s account without one.',
  ARRAY['You are a fiduciary: act for the association as a whole','Duty of care: come prepared and decide on real information','Duty of loyalty: disclose conflicts and step back from them','Your authority comes from the governing documents and Texas law'],
  ARRAY['Tex. Prop. Code ch. 209'],
  'Bedrock Association Management. General education, pending law-firm review.',
  10, 4
),
(
  'board-meetings-and-notice', 'meetings',
  'Board meetings, notice, and executive session',
  'When the board can meet, what owners must be told, and what stays private.',
  E'Texas law treats HOA board meetings as generally open to the members, with notice. The details live in Chapter 209 of the Property Code and in your bylaws, and the two work together.\n\n**Open meetings.** Members are generally entitled to attend board meetings and to receive notice of them in advance. Decisions that bind the association are made at a meeting (or through a documented vote), not in a hallway or a group text.\n\n**Notice.** Owners must be given notice of a regular or special board meeting ahead of time, in the manner your documents and the statute require. Your manager handles the mechanics; the board''s job is to make sure real decisions happen at noticed meetings.\n\n**Executive session.** The board can meet privately for a narrow set of sensitive topics, commonly personnel, pending or threatened litigation, contract negotiations, enforcement actions, and matters involving an individual owner''s privacy. Any action or vote coming out of executive session is generally reported in the open meeting. Executive session is for sensitive discussion, not for making the association''s decisions out of the members'' view.\n\nWhen you are unsure whether something belongs in open or closed session, ask before the meeting, not after.',
  ARRAY['Board meetings are generally open to members, with advance notice','Binding decisions are made at meetings or by documented vote','Executive session is limited to specific sensitive topics','Actions from executive session are generally reported in the open meeting'],
  ARRAY['Tex. Prop. Code ch. 209'],
  'Bedrock Association Management. General education, pending law-firm review.',
  20, 4
),
(
  'records-and-owner-requests', 'records',
  'Association records and owner requests',
  'What records the association keeps, and owners'' right to see them.',
  E'Owners have a statutory right to inspect and copy many association records, and the association has to respond within the timeframes the law sets. Chapter 209 governs this, and your management agreement and bylaws add detail.\n\n**What this means for the board.** You do not have to personally pull records. Your manager handles production. But the board should understand that records requests are a legal obligation with deadlines, not optional, and that mishandling one is a common source of disputes.\n\n**Some records are protected.** Certain items are exempt or restricted, for example records involving another owner''s personal financial information, personnel matters, or attorney-client privileged communications. When a request touches those, the answer is not simply "no," it is a considered response, usually with the manager and sometimes counsel.\n\n**Keep the association''s records as the association''s.** Minutes, financials, contracts, and correspondence belong to the association. One reason to run on a platform like this is that those records stay organized and exportable rather than living in a departed manager''s inbox.',
  ARRAY['Owners have a statutory right to inspect and copy many records','Requests carry legal deadlines; your manager handles production','Some records are protected (privacy, personnel, privileged)','Association records belong to the association and must be retained'],
  ARRAY['Tex. Prop. Code ch. 209'],
  'Bedrock Association Management. General education, pending law-firm review.',
  30, 3
),
(
  'how-enforcement-works', 'enforcement',
  'How deed-restriction enforcement works',
  'The §209 ladder, cure rights and hearings, and why consistency matters.',
  E'Enforcing the deed restrictions is one of the board''s real responsibilities, and Texas law sets out how it has to be done. Getting the process wrong can void the action, so the steps matter as much as the result.\n\n**Notice and a chance to cure.** Before most enforcement actions, the owner generally must get written notice describing the violation and, where the law requires, an opportunity to cure it within a set period, and to request a hearing before the board. Your manager runs this ladder, courtesy notices, then a certified notice, and so on.\n\n**Hearings.** An owner can generally request a hearing before the board before certain actions. The board listens, and decides.\n\n**Fines and further action are board decisions.** The system prepares the case; a person on the board decides to fine, and money and liens require a board decision.\n\n**Consistency is the whole game.** The single most important thing a board can do here is apply the same rule the same way to everyone. Selective or inconsistent enforcement is what gets associations into trouble, both legally and with the neighbors. This is also where an operating system helps: the rule is applied uniformly, and every step is documented.',
  ARRAY['Enforcement follows a required notice-and-cure process','Owners generally may request a hearing before the board','Fines, liens, and legal referrals are board decisions','Consistency, the same rule for everyone, is the legal and practical key'],
  ARRAY['Tex. Prop. Code ch. 209'],
  'Bedrock Association Management. General education, pending law-firm review.',
  40, 5
),
(
  'assessments-budget-reserves', 'finance',
  'Assessments, the budget, and reserves',
  'How the money works, and the board''s duty to fund the future.',
  E'The association is a small nonprofit business, and the board is its board of directors. The money side comes down to three things.\n\n**The budget.** Each year the board approves a budget, what the association expects to spend on operations, insurance, landscaping, utilities, management, and everything else. Your manager builds it; the board reviews and adopts it.\n\n**Assessments.** Assessments are how owners fund that budget. If the budget goes up, assessments generally have to follow, within whatever limits your declaration sets. Setting assessments too low to avoid a hard conversation is a common and costly mistake.\n\n**Reserves.** Reserves are savings for large future repairs and replacements, the roofs, the roads, the pool. A reserve study projects what those cost and when. The board has a fiduciary duty to fund reserves responsibly, because under-funding them just pushes a special assessment onto future owners. "Keep assessments flat and skip the reserve contribution" feels good today and is exactly the decision boards later regret.\n\nYou do not have to be an accountant. You do have to read the financials you are sent, ask about anything you do not understand, and take reserve funding seriously.',
  ARRAY['The board adopts an annual budget','Assessments fund the budget, within the declaration''s limits','Reserves are savings for big future repairs, and funding them is a fiduciary duty','Under-funding reserves pushes a special assessment onto future owners'],
  ARRAY['Tex. Prop. Code ch. 209'],
  'Bedrock Association Management. General education, pending law-firm review.',
  50, 5
),
(
  'architectural-review', 'architectural',
  'Architectural review (ACC/ARC)',
  'Approving changes fairly, in writing, and consistently.',
  E'Most communities require owners to get approval before changing how their home looks from the outside, paint, fences, roofs, additions, and so on. The board (often through an architectural committee) is responsible for that review, and Texas law shapes how it has to be done.\n\n**Decisions in writing.** An architectural decision, especially a denial, generally has to be given to the owner in writing. A vague "no" invites a dispute; a clear decision that points to the specific guideline holds up.\n\n**Consistency and the guidelines.** Decisions should follow the community''s written architectural guidelines and prior decisions on similar requests. Approving a tan fence for one owner and denying it for the next is the fastest way to a fight. If the guidelines are silent, that is a signal to update them, not to decide case by case from memory.\n\n**Reasonable and timely.** Reviews should be handled within a reasonable, defined time. Sitting on a request is its own problem.\n\nBedrock runs the intake and prepares each decision against the community''s guidelines and history; the board or committee makes the call, and the decision goes out in the association''s name, in writing.',
  ARRAY['Owners generally need approval before exterior changes','Decisions, especially denials, should be in writing and specific','Follow the written guidelines and prior similar decisions','Handle requests within a reasonable, defined time'],
  ARRAY['Tex. Prop. Code ch. 209'],
  'Bedrock Association Management. General education, pending law-firm review.',
  60, 4
)
ON CONFLICT (slug) DO NOTHING;

COMMIT;

-- PostgREST caches the schema; a table it has not seen returns empty rather than
-- erroring. Reload so the new table is visible immediately.
NOTIFY pgrst, 'reload schema';
