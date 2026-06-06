-- 167: Two more empathy-pattern playbook entries flagged by Ed 2026-06-06:
--
--   1. Homeowner upset about being denied amenity access (pool / fob /
--      clubhouse) because they're behind on assessments. Very common,
--      emotionally charged (kids' summer, dignity at the gate), and
--      has a CLEAR path back — pay current + late + reinstate. The
--      empathy posture acknowledges what they're protecting (kids,
--      dignity, fairness) AND walks them through the exact reinstatement
--      path so the conversation ends with agency, not shame.
--
--   2. Account at collections counsel — homeowner wants to discuss but
--      we can't (TX rules of professional conduct + FDCPA scoping). This
--      is the hardest empathy moment because the boundary IS the help.
--      The playbook entry covers: warm acknowledgment, honest boundary
--      naming, redirect to the attorney with rationale ("so they can do
--      their job cleanly, not because we're brushing you off"), give
--      the caller agency for the hardship piece (raise it with the
--      attorney directly).
--
-- Companion code change in same ship:
--   - persona_helpers.js: detectAtLegalMatter pattern detector
--   - bridge.js: at_legal takes precedence over generic compliance
--   - persona.js: buildHandoffOffer 'at_legal' variant (warm, names
--     the boundary AND the why)

BEGIN;

-- ---------------------------------------------------------------------------
-- 4) AMENITY-DENIED scenario — pool / fob / clubhouse denied for delinquency
-- ---------------------------------------------------------------------------
INSERT INTO playbook (situation, response, reasoning, category, applies_to)
SELECT
  'A homeowner is upset because they were denied access to a community amenity (pool, key fob, clubhouse rental, gate access, sport court) due to being behind on their HOA assessments. They may have been turned away at the pool gate in front of their kids and neighbors, or their fob was deactivated, or their reserved clubhouse rental was canceled. Often emotionally charged — kids are upset, the homeowner feels embarrassed or judged, and they may be defensive about why they''re behind.',

  $$This is one of the highest-emotion enforcement moments in HOA management. The homeowner usually isn't really fighting about the rule — they're protecting one or more of:
• their kids'' summer (most common — kids can't swim with friends, can't have a birthday party at the clubhouse)
• their dignity at the gate (being turned away in front of neighbors, feeling judged)
• their sense of fairness (they may believe the assessments are wrong, disputed, or unfair)
• their household stability (often there's a real hardship behind the delinquency — job loss, medical, divorce — that they haven't volunteered)

The empathy pivot:
"That's a tough spot — you're trying to keep your kids' summer normal and figure this out at the same time. Let me walk you through exactly where things stand and how to get access turned back on as fast as possible."

What NOT to say:
• Do not lead with "your account is delinquent and access is denied per HOA policy" — accurate but cold, and they already know
• Do not say "I hear you're frustrated" — generic, breaks trust
• Do not moralize about why they're behind — never appropriate
• Do not promise the board will make exceptions — you don't have that authority and consistent enforcement is a fair-housing requirement

What to DO:
1. Acknowledge what they're protecting (most commonly: their kids' experience or their dignity).
2. Be specific about the EXACT balance owed: current assessment, late fees, attorney fees if any. Pull from the AR data. No round numbers; exact amounts.
3. State the reinstatement path simply: pay this amount, access turns back on within [community-specific timeline — usually same-day or next-business-day for fob, same-day for pool gate].
4. Offer a payment plan ONLY if the community's board has an approved payment plan policy on file. If they do, name it; if they don't, do NOT improvise — say honestly "I don't have authority to set up a custom plan; let me have the manager look at whether a structured arrangement is possible."
5. If they hint at hardship (job loss, medical, divorce, etc.), validate it without prying: "Sounds like a hard stretch. The board sometimes considers hardship situations on a case-by-case basis — would you like me to flag that with the manager?" This gives them agency without promising an outcome.
6. If they dispute the underlying balance (claim a payment posted that didn't get applied, claim assessments are wrong), document the dispute and offer to research — do NOT argue the number on the spot. The AR ledger is the source of truth; if there's a real discrepancy, it gets fixed by reconciliation, not by phone debate.

Gold-standard line for the reinstatement piece:
"The fastest path is [exact amount]. Once that's posted, your fob/pool access turns back on by [timing]. If that amount isn't workable in one shot, the manager can look at whether a structured arrangement is possible for your community — want me to flag that for follow-up?"

End with concrete agency: they choose what happens next. Pay now, request hardship review, dispute the balance with documentation. They walk away with options, not just a denial.$$,

  'Amenity-access enforcement is fair-housing-critical: the rules must apply consistently across the portfolio. That said, HOW we deliver the answer determines whether the homeowner accepts it or escalates. Cold delivery of an accurate policy answer is a brand-damaging interaction that produces complaints, board emails, and (sometimes) fair-housing claims based on perceived differential treatment. Warm delivery of the SAME accurate policy answer turns a denial moment into a "Bedrock helped me figure this out" moment. The empathy posture is the operational difference; the substance is identical. This is consistent enforcement done with dignity — the structural moat per memory note.',

  'empathy-pattern',
  ARRAY['claire', 'asked', 'inbox_draft']
WHERE NOT EXISTS (
  SELECT 1 FROM playbook
  WHERE category = 'empathy-pattern'
    AND situation LIKE 'A homeowner is upset because they were denied access to a community amenity%'
);

-- ---------------------------------------------------------------------------
-- 5) AT-LEGAL scenario — account turned over to collections counsel
-- ---------------------------------------------------------------------------
INSERT INTO playbook (situation, response, reasoning, category, applies_to)
SELECT
  'A homeowner''s account has been turned over to the HOA''s collection attorney (often RMWBH or similar TX firm). The homeowner is calling because they got a demand letter, or their balance has grown to include attorney fees, or they just want to "talk to someone" about it. The HOA management company CANNOT discuss specifics of the account once the matter is with collections counsel — Texas rules of professional conduct + FDCPA scoping require that all communication about the matter route through the attorney representing the HOA.',

  $$This is one of the hardest empathy moments because the boundary IS the help. Continuing to discuss the account specifics with the homeowner after legal counsel has the file would:
• Violate TX rules of professional conduct (the attorney represents the HOA on this matter; opposing party communication routes through them)
• Risk FDCPA exposure (the management company stepping into "settling" a debt outside the attorney's framework)
• Muddy the legal record (any promise / partial payment acceptance / "deal" struck verbally creates conflict with the attorney's collection strategy)
• Risk an inadvertent waiver of the HOA's legal position (e.g., manager says "we'll accept $X to settle" — the attorney is now bound by an unauthorized verbal commitment)

Even if Ed personally wants to help, even if the homeowner is sympathetic, even if there's an obvious mistake on the file — once the matter is at legal, the path back is THROUGH the attorney, not around them.

The empathy posture for this moment:

Step 1 — Acknowledge what they're carrying. They're often distressed (lien threat, fees stacking, possible foreclosure, embarrassment). Often there's a real financial or life-event story behind it.

Step 2 — Name the boundary HONESTLY and warmly:
"Here's the honest piece — once an account moves to collections counsel, I'm not able to discuss the specifics on our side. That's not me brushing you off — it's so the attorney handling your file can do their job cleanly. The way these things work, anything that gets negotiated has to go through them, not around them. That actually protects you too, because there's a clear record of what was agreed."

Step 3 — Direct them to the attorney with rationale:
"Their direct contact is [attorney name + phone + email — pulled from the community's at-legal record]. The faster you reach out to them, the faster you have clarity on what your options are. They handle these conversations every day."

Step 4 — Give them agency on the hardship piece IF it applies:
"If there's something on the personal side — job change, medical, family — that you want them to know about, raise that with them directly. Collection attorneys can sometimes structure things differently when they understand the situation. I can't promise an outcome, but the conversation has to happen with them, not with us."

Step 5 — Close honestly:
"I know this isn't the answer you were hoping for, but it's the cleanest path forward. Reach out to them today if you can — that's the move that opens up your options."

What NOT to do:
• Do not discuss balance specifics, fee amounts, payoff figures, or settlement scenarios
• Do not promise the manager will "look into it" — the manager can't either, same rule
• Do not say "we tried to work with you" — even if accurate, it sounds defensive
• Do not offer to "talk to the attorney for you" — the homeowner contacts them directly; we don't broker
• Do not validate their dispute about the underlying amount — that's the attorney's analysis to make

When Claire detects an at-legal situation (homeowner mentions collection attorney, demand letter, lien filed, "my account is in legal"), the system automatically routes to the at_legal handoff variant. Claire does NOT continue discussing the account; she delivers the empathy-framed boundary and the attorney contact, then ends the call cleanly. Generic compliance handoff is too cold for this moment — the at_legal variant has the boundary-with-warmth language built in.$$,

  'The at-legal boundary is where the most well-intentioned managers get the management company sued or sanctioned. It happens because the human reflex is to help — and the homeowner''s emotional state pulls hard for help. The system has to enforce the boundary structurally because the operator''s gut will push the wrong way. Ed encoded the empathy framework precisely so this boundary doesn''t feel cold — the homeowner gets acknowledgment AND honest scope AND clear direction to the right party. Pisey Sam Oeurn 2026-06-05 was a similar boundary moment (HOA can''t order removal from her lot); this is the harder cousin because the homeowner is the delinquent party AND distressed AND the legal posture is more constrained.',

  'empathy-pattern',
  ARRAY['claire', 'asked', 'inbox_draft']
WHERE NOT EXISTS (
  SELECT 1 FROM playbook
  WHERE category = 'empathy-pattern'
    AND situation LIKE '%turned over to the HOA%collection attorney%'
);

COMMIT;
