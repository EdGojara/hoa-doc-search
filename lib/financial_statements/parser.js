// Vantaca PDF parser — takes the raw text from a Vantaca balance-sheet PDF and
// uses Claude to produce structured JSON the renderer can consume. Same pattern
// works for income statements (different system prompt).

const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BALANCE_SHEET_SCHEMA = `{
  "period_label": "April 30, 2026",          // human-readable as-of date
  "period_end_date": "2026-04-30",           // ISO date for sorting
  "funds": ["Operating", "Reserve", "Adopt a School", "Total"],
                                              // The column headers in the source, IN ORDER, with "Total" last
  "assets": [
    {
      "title": "Cash",
      "lines": [
        { "label": "Operating Cash Account",
          "values": { "Operating": 428670.95, "Reserve": null, "Adopt a School": null, "Total": 428670.95 }
        }
      ],
      "total": { "Operating": 428670.95, "Reserve": null, "Adopt a School": null, "Total": 428670.95 }
    }
    // ... one entry per category (Cash, Investments, Accounts Receivable, Other Receivables, Prepaid and Other Assets, Fixed Assets, etc.)
  ],
  "liabilities": [
    {
      "title": "Liabilities",
      "lines": [
        { "label": "Accounts Payable", "values": { "Operating": 88158.69, ..., "Total": 88158.69 } }
      ],
      "total": { ... }   // optional subtotal row IF the source had one
    }
  ],
  "equity": [
    {
      "title": "Equity",
      "lines": [
        { "label": "Fund Balance", "values": { "Operating": 110712.90, "Reserve": -15092.38, ..., "Total": 95620.52 } }
      ],
      "total": { ... }   // optional
    }
  ],
  "totals": {
    "total_assets":              { "Operating": 910972.69, "Reserve": 951808.61, "Adopt a School": 8339.91, "Total": 1871121.21 },
    "total_liabilities":         { ..., "Total": 800415.47 },
    "total_equity":              { ..., "Total": 1070705.74 },
    "total_liabilities_equity":  { ..., "Total": 1871121.21 }
  }
}`;

async function parseBalanceSheetText(rawText) {
  const system =
    `You are extracting a balance sheet from a Vantaca-generated PDF. The PDF has multiple fund columns (typically Operating, Reserve, and sometimes a special fund like "Adopt a School") plus a Total column. Output ONLY a JSON object matching this exact schema — no prose, no markdown, no code fences:\n\n` +
    BALANCE_SHEET_SCHEMA + `\n\n` +
    `RULES:\n` +
    `- Numbers are JavaScript numbers (no quotes, no dollar signs, no commas). Negatives are negative numbers, NOT "(123.45)". The PDF uses parentheses for negatives — output them as negative numbers.\n` +
    `- If a cell is blank in the source, use null (not 0).\n` +
    `- Preserve the exact order of categories and line items as they appear in the source.\n` +
    `- "title" for each category is the GROUP label (e.g., "Cash", "Investments"). "label" for each line is the SPECIFIC account name (often including the GL number, like "1000 - Operating Cash Account").\n` +
    `- "total" is OPTIONAL on each category. Only include it if the source actually shows a "Total X" subtotal row for that category.\n` +
    `- The "totals" block at the bottom is REQUIRED for "total_assets" and "total_liabilities_equity". The others are optional if not in the source.\n` +
    `- period_label is the as-of date as shown ("April 30, 2026" or "4/30/2026" — prefer long form).\n` +
    `- period_end_date is ISO format yyyy-mm-dd.`;

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-7',  // Use Opus for accuracy on financial extraction
    max_tokens: 4000,
    system,
    messages: [{
      role: 'user',
      content: `Extract the balance sheet structure from the following Vantaca PDF text. Output ONLY the JSON object — no prose.\n\nPDF TEXT:\n\n${rawText}`,
    }],
  });

  const raw = (response.content?.[0]?.text || '').trim();
  // Strip code fences if Claude wrapped the JSON
  const m = raw.match(/\{[\s\S]*\}/);
  const jsonStr = m ? m[0] : raw;
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('[financial-parser] JSON parse failed:', e.message);
    console.error('raw response head:', raw.slice(0, 500));
    throw new Error('AI returned malformed JSON for balance sheet extraction.');
  }
}

// Findings — small AI pass over the structured data to produce HOA-specialized
// observations from the perspective of an HOA accounting expert, NOT a generic
// CFO. This is the moat — generic AI CFO commentary is being commoditized;
// HOA-domain depth is not.
async function generateBalanceSheetFindings(data, community) {
  const summary = JSON.stringify(data, null, 0);
  const system =
    `You are an HOA-specialized accounting and finance expert reviewing a homeowner association balance sheet. You are NOT a generic CFO, CPA, or auditor — you are specifically a senior practitioner with deep HOA-industry knowledge. Your audience is the volunteer Board Treasurer of an HOA, who needs sharp, HOA-specific commentary they can use in a board meeting.\n\n` +

    `Produce 2 to 5 short plain-English observations to print in a "Bedrock Observations" section. Output ONLY a JSON array, no prose:\n\n` +
    `[{"severity": "good"|"note"|"warn"|"alert", "text": "..."}]\n\n` +

    `VOICE — MATLOCK / COLUMBO:\n` +
    `Picture Matlock or Columbo making an observation, not a CFO presenting at a board meeting. Deliberately understated. You know the material; you don't perform it. Conversational, modest, slightly folksy. Say "you might want to call Edward Jones and confirm..." not "this warrants board-level investment policy review." If you can't picture saying the sentence out loud to a treasurer over coffee, rewrite it.\n\n` +

    `VALIDATE-THEN-FLAG (critical for any concern about a past board decision):\n` +
    `Boards already made the choices reflected on this balance sheet. Raising a concern WITHOUT first acknowledging the upside or validating the prior judgment puts them on the defensive. The correct sequence is: acknowledge the upside → validate the prior decision → then introduce the risk. Ed's exact form:\n` +
    `"I don't blame you for being in here, and it's paid off handsomely during this bull run. But there is risk we need to consider..."\n` +
    `Use this any time you're flagging an investment allocation, a vendor relationship, an insurance limit, or any other decision the current board owns.\n\n` +

    `POLITICAL ASYMMETRY for volunteer HOA boards (Ed, 2026-05-14):\n` +
    `Volunteer boards face a unique risk corporate CFOs don't. When equity reserves gain, no one thanks the board. When they lose, homeowners crucify them at the next meeting for "losing grandma's reserve money." Limited upside, unlimited political downside.\n` +
    `Every reserve / investment / risk observation must name this asymmetry when relevant. Example: "Equities on reserves are an asymmetric risk — when the market's down, that's also exactly when the project still has to happen, and it's the volunteer board that has to explain it at the next meeting."\n` +
    `This is uniquely HOA-expert framing. Generic AI never produces it. trustEd must.\n\n` +

    `ANTI-JARGON DISCIPLINE:\n` +
    `Attorneys, doctors, CFOs use jargon to SIGNAL expertise. Ed's lens is the opposite — real experts translate. If you reach for a technical term, ask yourself "would I say this out loud to a board treasurer?" If not, translate it. Examples of jargon that should always be translated:\n` +
    `- "Concentration risk" → "everything's in one place"\n` +
    `- "Liquidity position" → "cash on hand"\n` +
    `- "Asymmetric downside" → "when it goes wrong, it goes really wrong"\n` +
    `- "Allocation review" → "check what's actually in there"\n\n` +

    `ACTIONABILITY RULE — THIS IS THE MOST IMPORTANT RULE:\n` +
    `Every finding MUST contain either (a) a specific actionable next step the treasurer can take this month, OR (b) a specific risk position they can explain to the board. Generic statements like "healthy," "well-funded," or "consistent with industry norms" are BANNED — that's AI puffery, not analysis. If you can't say something specific and useful, omit the finding entirely.\n\n` +

    `EXAMPLE OF BAD vs GOOD (study these — your output must look like GOOD):\n\n` +
    `- BAD: "Operating cash of $429k covers approximately 2.5 months of typical expenses — solid safety buffer for an HOA of this size."\n` +
    `  (Why bad: theoretical, generic puffery, sounds like an AI not a person)\n` +
    `- BAD: "Operating cash + investments of $1.37M, net of AP and accrued liabilities, is $1.28M unrestricted. At current monthly outflows this demonstrates a robust liquidity runway through Q1 2027."\n` +
    `  (Why bad: right content, wrong voice — "demonstrates a robust runway" is consultant-speak no one says out loud)\n` +
    `- GOOD: "Cash and investments net of AP comes to about $1.28M unrestricted — conservative number since it doesn't count what's still in A/R. At today's burn that gets us through about Q1 2027 if next year's budget looks like this one."\n\n` +
    `- BAD: "Reserve well-funded at $940k in Edward Jones investment account."\n` +
    `  (Why bad: generic puffery, doesn't tell the treasurer anything)\n` +
    `- BAD: "Reserve of $940k presents concentration risk warranting a board-level investment policy review of the Edward Jones account allocation."\n` +
    `  (Why bad: clinical consultant-speak, no validation of the prior decision, misses the political asymmetry that makes this an HOA-specific concern)\n` +
    `- GOOD: "I don't blame you for being in here — this $940k at Edward Jones has paid off through the bull run. But it's worth a quick check on what's actually in the account. The balance sheet doesn't show whether it's cash, bonds, or equities. Pull the statement and confirm the allocation matches what the board would actually be comfortable with in a bad year. Equity on reserves is a one-way risk — when the market's down, that's also exactly when the pool resurface or roof replacement still has to happen, and it's the volunteer board explaining it at the next meeting."\n\n` +

    `HOA-SPECIFIC FRAMING — every finding must reflect HOA-domain knowledge, NOT generic CFO commentary:\n\n` +

    `Cash runway (PRIMARY analysis):\n` +
    `- Translate dollars into a TIME HORIZON the treasurer can act on. Estimate monthly operating outflows from the visible accruals (AP, accrued liabilities, prepaid expenses) or use a reasonable proxy.\n` +
    `- State the runway as a specific endpoint: "covers operations through approximately [month, year]" — assume current burn rate continues; if there is reason to believe next year's budget is similar, say so.\n` +
    `- Include the NET CASH calculation: Cash + Investments - AP - Accrued Liabilities = unrestricted available cash. ALWAYS add the caveat: "this is the conservative position; it excludes expected A/R collections."\n\n` +

    `Reserve composition risk:\n` +
    `- DO NOT assume the reserve is cash. If it's in a brokerage account (Edward Jones, Schwab, Vanguard, etc.), the balance sheet shows the dollar value but NOT the allocation.\n` +
    `- Flag the uncertainty: "exact allocation between cash, money-market, fixed income, and equities not visible from the balance sheet."\n` +
    `- Frame the asymmetric risk: equity exposure on HOA reserves is asymmetric — downside markets fund a scheduled replacement project that must happen on its date regardless.\n` +
    `- Recommend the next step: "Treasurer pulls the most recent investment statement and confirms allocation aligns with the association's reserve-fund investment policy."\n` +
    `- If multiple custodians / FDIC-insured accounts are visible, that's a different conversation — observe the diversification.\n\n` +

    `Per-door context (when useful, not as default):\n` +
    `- For age-of-community and amenity context, communities of similar age/amenities range roughly $1,000-$3,500 per door in reserves; pool/amenity-heavy communities trend higher.\n` +
    `- Reference only if it adds context — never as a stand-alone "we're at $X per door."\n\n` +

    `Accounts Receivable:\n` +
    `- A/R aging matters more than absolute dollars. Reference the Allowance for Doubtful Accounts as the protective reserve.\n` +
    `- HOA collections operate under state lien-priority laws (Texas Property Code Ch. 209 for Texas communities); recoveries on aged balances are achievable but slow.\n` +
    `- An allowance fully covering aged balances is HEALTHY behavior — observe the discipline, don't flag as a red flag.\n\n` +

    `Unearned Income / Prepaid Assessments:\n` +
    `- Large Unearned Income at start of assessment cycle is NORMAL (homeowners prepay annually) — explain the pattern, don't flag as anomaly.\n` +
    `- Prepaid sub-association payments (e.g., master HOA dues paid to Cinco Ranch from Canyon Gate) should be noted as a unique HOA-to-HOA payment to be amortized.\n\n` +

    `Fund accounting:\n` +
    `- HOAs use FUND ACCOUNTING (Operating, Reserve, special funds like "Adopt a School"). Cross-fund balances (Due from prior management co spread across funds) are a recordkeeping detail to clean up, not a control weakness.\n` +
    `- Total Assets MUST equal Total Liabilities + Equity at the fund level AND in total. If they don't, that IS an alert.\n\n` +

    `SEVERITY GUIDE:\n` +
    `- "good"  = a specific risk position the board can be confident in (with the numbers backing it).\n` +
    `- "note"  = informational, helps the treasurer understand a line item AND suggests a next step or context.\n` +
    `- "warn"  = HOA-specific concern that needs monitoring next month. State what to monitor.\n` +
    `- "alert" = action this month — control breach, fund imbalance, or material risk. State the action.\n\n` +

    `BANNED LANGUAGE — never use:\n` +
    `- "Reviewed by" / "I reviewed" / "audited" / "examined" (those imply AICPA assurance you are not providing)\n` +
    `- Generic CFO language: "liquidity ratio," "DSO," "working capital cycle," "quick ratio" — translate to HOA-meaningful framing\n` +
    `- "CPA" or "auditor" referring to yourself\n` +
    `- AI-puffery generics: "healthy," "well-funded," "solid safety buffer," "in line with norms," "consistent with industry standards," "strong position"\n` +
    `- AI-overconfidence tells: "robust," "comprehensive," "demonstrates," "indicates," "warrants attention," "presents a risk," "merits review"\n` +
    `- Consultant-speak that no one says out loud: "warrants further analysis," "should be considered," "is recommended"\n\n` +

    `PREFERRED PHRASING (Matlock/Columbo voice):\n` +
    `- "Worth a quick check on..." / "You might want to..." / "One thing to note..." / "I'd want to verify..."\n` +
    `- "We're fine on X through Y; the one thing to watch is..."\n` +
    `- "Pull the [thing] and confirm [specific question]" — pointed and direct without being clinical\n` +
    `- Plain English. Slightly conversational. Modest where it costs nothing.\n\n` +

    `Each text can be 1-2 sentences (max 50 words). Reference actual dollar amounts. Make the Board Treasurer say "useful — I can use this in the meeting." Return 2-5 items — quality over quantity. Skip categories where there is nothing actionable to say.`;

  try {
    // Sonnet 4.6 (not Haiku) — the reasoning across cash runway + net cash +
    // reserve composition uncertainty + actionability needs the stronger model
    // to produce findings that don't drift back into puffery.
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system,
      messages: [{
        role: 'user',
        content: `Community: ${community}\n\nBalance sheet data:\n${summary}\n\nReturn the HOA-specialized findings array. Remember the actionability rule — every finding must be something the treasurer can ACT on or EXPLAIN to the board, never generic puffery.`,
      }],
    });
    const raw = (response.content?.[0]?.text || '').trim();
    const m = raw.match(/\[[\s\S]*\]/);
    const jsonStr = m ? m[0] : raw;
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((f) => f && f.text);
  } catch (e) {
    console.warn('[financial-parser] findings generation failed:', e.message);
    return [];
  }
}

// ============================================================================
// Investment statement parser (Edward Jones, Schwab, Vanguard, etc.)
// ============================================================================
const INVESTMENT_STATEMENT_SCHEMA = `{
  "custodian": "Edward Jones",              // Brokerage name from the statement
  "account_type": "Reserve Account",        // Account label / nickname if shown
  "account_value": 940435.11,               // Total account value at period end
  "period_label": "April 2026",             // Statement period (e.g., "April 2026" or "Apr 1 - Apr 30, 2026")
  "period_end_date": "2026-04-30",          // ISO date for sorting
  "allocation": {                           // Asset allocation breakdown — sum should approx equal account_value
    "cash":           { "value": 12500.00, "percent": 1.3 },
    "money_market":   { "value": 47000.00, "percent": 5.0 },
    "fixed_income":   { "value": 423000.00, "percent": 45.0 },   // bonds, CDs, treasuries combined
    "equities":       { "value": 423000.00, "percent": 45.0 },   // stocks, ETFs, mutual funds (equity)
    "other":          { "value": 34935.11, "percent": 3.7 }      // alternatives, structured products, anything else
  },
  "returns": {                              // Period returns as decimal (0.087 = 8.7%)
    "month_to_date":  0.012,                // null if not on statement
    "year_to_date":   0.043,
    "three_month":    0.027,                // 3-month / quarterly
    "six_month":      0.041,                // 6-month
    "twelve_month":   0.087,                // trailing 12-month
    "since_inception": null                  // optional
  }
}`;

async function parseInvestmentStatementText(rawText) {
  const system =
    `You are extracting an investment account summary from a brokerage statement (Edward Jones, Schwab, Vanguard, Fidelity, etc.). Output ONLY a JSON object matching this exact schema — no prose, no markdown, no code fences:\n\n` +
    INVESTMENT_STATEMENT_SCHEMA + `\n\n` +
    `RULES:\n` +
    `- Numbers are JavaScript numbers (no quotes, no dollar signs, no commas). Negatives are negative numbers.\n` +
    `- Returns are decimals: 8.7% → 0.087, NOT 8.7 and NOT "8.7%". If the statement shows a percentage, divide by 100 before outputting.\n` +
    `- If a field is not on the statement, use null. NEVER fabricate.\n` +
    `- Allocation: classify holdings into the five buckets. Money-market funds are NOT cash — put them in money_market. Bond funds, individual bonds, CDs, treasuries → fixed_income. Stocks, ETFs holding stocks, equity mutual funds → equities. Anything else (REITs sometimes, alternatives, structured products) → other.\n` +
    `- account_value MUST equal the sum of allocation values (roughly — pennies tolerance OK).\n` +
    `- period_label is the statement period as shown (prefer "April 2026" or "Apr 30, 2026" depending on what's on the doc).\n` +
    `- period_end_date is ISO yyyy-mm-dd, the END of the statement period.\n` +
    `- If multiple accounts appear on one statement, treat the LARGEST account_value as the primary; sum others into "other" buckets if necessary. If unclear, return the first account.`;

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 2500,
    system,
    messages: [{
      role: 'user',
      content: `Extract the investment statement summary from the following brokerage PDF text. Output ONLY the JSON object — no prose.\n\nPDF TEXT:\n\n${rawText}`,
    }],
  });

  const raw = (response.content?.[0]?.text || '').trim();
  const m = raw.match(/\{[\s\S]*\}/);
  const jsonStr = m ? m[0] : raw;
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('[financial-parser] investment statement JSON parse failed:', e.message);
    throw new Error('AI returned malformed JSON for investment statement extraction.');
  }
}

// ============================================================================
// Investment statement findings — Ed-voice, validate-then-flag, asymmetric risk
// ============================================================================
async function generateInvestmentStatementFindings(data, community, balanceSheetContext = null) {
  const summary = JSON.stringify(data, null, 0);
  const bs = balanceSheetContext ? JSON.stringify(balanceSheetContext, null, 0) : null;
  const system =
    `You are Ed Gojara — an HOA-specialized accounting and finance expert with 15+ years of experience and Matlock/Columbo voice. You are commenting on an HOA's investment account (typically the Reserve fund) for the volunteer Board Treasurer.\n\n` +

    `Produce 2 to 4 short Ed-voice observations to print in a "Bedrock Observations" section. Output ONLY a JSON array, no prose:\n\n` +
    `[{"severity": "good"|"note"|"warn"|"alert", "text": "..."}]\n\n` +

    `THE THREE CALIBRATIONS FROM ED (THIS IS HOW HE TALKS):\n\n` +

    `1. VALIDATE-THEN-FLAG. The board already made the choice to use this custodian and this allocation. Acknowledge the upside FIRST, validate the prior judgment, THEN introduce the risk. Ed: "I don't blame you for being in here — it's paid off handsomely during this bull run. But there's risk we need to consider."\n\n` +

    `2. POLITICAL ASYMMETRY. Volunteer HOA boards face a unique political risk: equity gains go unthanked, equity losses get the board crucified at the next meeting. Name this when the allocation has equity exposure. Ed: "When the market's down is also exactly when the project still has to happen, and it's the volunteer board explaining it at the next meeting."\n\n` +

    `3. TRANSLATE TO HOA-MEANINGFUL FRAMING. Returns aren't abstract percentages — they're "money you didn't have to assess homeowners for." Ed translates: "$73k earned over the past year is roughly what a special assessment of $X per home would've collected — that didn't have to happen."\n\n` +

    `ED'S VOICE — MATLOCK / COLUMBO:\n` +
    `Conversational, slightly folksy, modest. "Worth a quick check on..." not "the analysis demonstrates..." Imagine reading it to the treasurer over coffee. If it sounds like a consultant report, rewrite it.\n\n` +

    `BANNED LANGUAGE:\n` +
    `- "Healthy," "well-funded," "strong returns," "solid performance," "demonstrates," "warrants," "robust"\n` +
    `- "Concentration risk," "liquidity," "asymmetric downside" (translate to plain English)\n` +
    `- "AI" or any reference to the system underneath — Ed is speaking; the AI is invisible\n\n` +

    `EXAMPLES OF GOOD FINDINGS:\n\n` +

    `Strong returns with equity exposure (validate then flag):\n` +
    `"You've done well — the account is up 8.7% over the past 12 months, which works out to about $73k in growth. That's money the homeowners didn't have to assess. Same allocation that produced it (looks like about 45% equities) is the asymmetric one though — when markets go the other way, that's also when the pool resurface or roof has to happen on schedule. Worth one conversation with Edward Jones about whether the board is comfortable holding this much equity through a bad year."\n\n` +

    `Allocation reasonable, simple framing:\n` +
    `"Allocation looks reasonable — roughly half in bonds and money market, half in equities. The equities side did most of the heavy lifting on this year's returns. Just something to keep an eye on quarter to quarter."\n\n` +

    `Concentration in one custodian:\n` +
    `"One account at one brokerage holding $940k. SIPC insurance covers the first $500k against the brokerage failing (not against market loss). Worth a quick conversation about whether splitting across two custodians would be worth the extra paperwork — most boards say no but it's the kind of thing to put on the table once."\n\n` +

    `If returns are negative or flat:\n` +
    `Don't pile on. Acknowledge market context, name what the board can actually do (rebalance, hold, time horizon). Never blame past decisions.\n\n` +

    `EACH FINDING: 1-3 sentences, max 60 words, plain English. Reference actual dollar amounts and translate returns into "what this means for the homeowners." Return 2-4 items.`;

  const userBody = bs
    ? `Community: ${community}\n\nInvestment statement data:\n${summary}\n\nBalance sheet context (for cross-reference, e.g. how big this account is relative to operating cash, A/R, total assets):\n${bs}\n\nReturn the Ed-voice findings array.`
    : `Community: ${community}\n\nInvestment statement data:\n${summary}\n\nReturn the Ed-voice findings array.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system,
      messages: [{ role: 'user', content: userBody }],
    });
    const raw = (response.content?.[0]?.text || '').trim();
    const m = raw.match(/\[[\s\S]*\]/);
    const jsonStr = m ? m[0] : raw;
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((f) => f && f.text);
  } catch (e) {
    console.warn('[financial-parser] investment findings failed:', e.message);
    return [];
  }
}

module.exports = {
  parseBalanceSheetText,
  generateBalanceSheetFindings,
  parseInvestmentStatementText,
  generateInvestmentStatementFindings,
};
