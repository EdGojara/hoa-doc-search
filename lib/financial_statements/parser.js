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
    `  (Why bad: clinical consultant-speak, "warrants" / "presents risk" are AI tells)\n` +
    `- GOOD: "Worth a quick check on the reserve. $940k sitting in one Edward Jones account — the balance sheet doesn't show what's actually in there (cash, bonds, equities). Pull the statement and confirm it lines up with the board's investment policy. Equities are an asymmetric risk on reserves — when the market's down is exactly when the project still has to happen."\n\n` +

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

module.exports = { parseBalanceSheetText, generateBalanceSheetFindings };
