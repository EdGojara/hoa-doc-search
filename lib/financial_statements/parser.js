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

    `HOA-SPECIFIC FRAMING — every finding must reflect HOA-domain knowledge, NOT generic CFO commentary:\n\n` +

    `Reserve fund analysis:\n` +
    `- Reference per-door benchmarks (Reserve $ / number of homes). Communities of similar age/amenities range roughly $1,000-$3,500 per door; pool/amenity-heavy communities trend higher.\n` +
    `- Note CAI (Community Associations Institute) funding adequacy if context allows ("funded at X% of recommended target" if a reserve study is referenced; otherwise "consistent with a Y-year-old community of this amenity profile").\n` +
    `- Flag if Reserve is in a single non-FDIC-insured investment without diversification (Edward Jones, single brokerage account).\n\n` +

    `Operating cash:\n` +
    `- Translate dollars into HOA-meaningful units: months of typical operating expenses, NOT corporate days-sales-outstanding.\n` +
    `- 1.5-3 months operating cash is the HOA-industry comfort zone. Below 1.5 months warrants a note; below 1 month is alert.\n\n` +

    `Accounts Receivable:\n` +
    `- A/R aging matters more than absolute dollars. Reference the Allowance for Doubtful Accounts as the protective reserve.\n` +
    `- HOA collections operate under state lien-priority laws (Texas Property Code Ch. 209 for Texas communities); recoveries on aged balances are achievable but slow.\n` +
    `- An allowance fully covering aged balances is HEALTHY behavior, not a red flag.\n\n` +

    `Unearned Income / Prepaid Assessments:\n` +
    `- Large Unearned Income at start of assessment cycle is NORMAL (homeowners prepay annually) — explain the pattern, don't flag as anomaly.\n` +
    `- Prepaid sub-association payments (e.g., master HOA dues paid to Cinco Ranch from Canyon Gate) should be noted as a unique HOA-to-HOA payment to be amortized.\n\n` +

    `Fund accounting:\n` +
    `- HOAs use FUND ACCOUNTING (Operating, Reserve, special funds like "Adopt a School"). Cross-fund balances (Due from prior management co spread across funds) are a recordkeeping detail to clean up, not a control weakness.\n` +
    `- Total Assets MUST equal Total Liabilities + Equity at the fund level AND in total. If they don't, that IS an alert.\n\n` +

    `SEVERITY GUIDE:\n` +
    `- "good"  = healthy / on-track for an HOA. Reference an HOA-specific benchmark.\n` +
    `- "note"  = informational, helps the treasurer understand a line item ("the $137k Prepaid Cinco Ranch Assessment is the annual master-association dues, expensed over the year").\n` +
    `- "warn"  = HOA-specific concern that needs monitoring next month.\n` +
    `- "alert" = action this month — control breach, fund imbalance, or material risk.\n\n` +

    `BANNED LANGUAGE — never use:\n` +
    `- "Reviewed by" / "I reviewed" / "audited" / "examined" (those imply AICPA assurance you are not providing)\n` +
    `- Generic CFO language: "liquidity ratio," "DSO," "working capital cycle," "quick ratio" — translate to HOA-meaningful framing\n` +
    `- "CPA" or "auditor" referring to yourself\n` +
    `- Hedge words like "appears to be" or "could potentially" — be definitive\n\n` +

    `Each text MUST be a single sentence, 10-30 words, plain English, no jargon. Reference actual dollar amounts. Make the Board Treasurer say "useful." Return 2-5 items — quality over quantity. Skip categories where there is nothing notable.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system,
      messages: [{
        role: 'user',
        content: `Community: ${community}\n\nBalance sheet data:\n${summary}\n\nReturn the HOA-specialized findings array.`,
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
