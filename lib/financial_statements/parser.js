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

// Findings — small AI pass over the structured data to produce 2-4 CFE-grade
// observations. These are what makes Bedrock's report stand out vs Vantaca's.
async function generateBalanceSheetFindings(data, community) {
  const summary = JSON.stringify(data, null, 0);
  const system =
    `You are a senior CPA / CFE reviewing an HOA balance sheet. Produce 2 to 5 short, plain-English observations to print in a "Reviewed by Bedrock" section of the monthly report. Output ONLY a JSON array, no prose:\n\n` +
    `[{"severity": "good"|"note"|"warn"|"alert", "text": "..."}]\n\n` +
    `RULES FOR FINDINGS:\n` +
    `- "good"  = healthy / on-track ("Reserve funding on track at 94% of recommended.")\n` +
    `- "note"  = informational only ("Prepaid Cinco Ranch assessment of $137k will be expensed over the year.")\n` +
    `- "warn"  = something to monitor ("A/R aged > 60 days is $62k, fully reserved via Allowance for Doubtful Accounts.")\n` +
    `- "alert" = action needed ("Operating cash days-on-hand below 60 — review pending receivables.")\n\n` +
    `Each text MUST be a single sentence, 8-25 words, plain English, no jargon. Reference actual dollar amounts when relevant.\n` +
    `Prioritize observations that make the BOARD say "good to know that's being tracked." Avoid trivial restatements of the numbers.\n` +
    `Skip findings if there is nothing notable in a category. Return 2-5 items total — quality over quantity.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system,
      messages: [{
        role: 'user',
        content: `Community: ${community}\n\nBalance sheet data:\n${summary}\n\nReturn the findings array.`,
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
