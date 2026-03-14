/**
 * Fix Stragglers
 *
 * Targeted fix for specific puzzles that failed due to JSON parse errors.
 * Uses a more aggressive JSON extraction approach and a simpler prompt.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=key node fix-stragglers.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const UPDATED_FILE  = path.join(__dirname, 'data', 'puzzles.updated.json');
const REWORK_FILE   = path.join(__dirname, 'data', 'puzzles.rework-fixed.json');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL   = 'claude-haiku-4-5-20251001';

// The 3 remaining puzzles (0-indexed)
const STRAGGLER_INDEXES = [108, 556, 662]; // #109, #557, #663

const SYSTEM_PROMPT = `You write clues for a physiotherapy diagnosis guessing game.
Return ONLY a raw JSON object with no explanation, preamble, or markdown. Nothing else — just the JSON.`;

function buildPrompt(puzzle) {
  return `Rewrite all 5 clues for this puzzle using a progressive reveal:
- Clue 1 (Complaint): Very broad, 10+ conditions possible
- Clue 2 (Activity): Narrows to body region/movement pattern
- Clue 3 (History): Eliminates most possibilities
- Clue 4 (Examination): Specific clinical findings
- Clue 5 (Imaging): Near-definitive diagnostic result

Answer: "${puzzle.answer}" [${puzzle.category}]

Never name the diagnosis. Each clue adds NEW information. Terse clinical language.

Return exactly this JSON and nothing else:
{"answer":"${puzzle.answer}","clues":[{"label":"Complaint","text":"..."},{"label":"Activity","text":"..."},{"label":"History","text":"..."},{"label":"Examination","text":"..."},{"label":"Imaging","text":"..."}]}`;
}

function extractJSON(text) {
  // Try direct parse first
  try { return JSON.parse(text); } catch {}

  // Try to find JSON object in the text
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }

  // Try extracting from code block
  const codeMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeMatch) {
    try { return JSON.parse(codeMatch[1].trim()); } catch {}
  }

  throw new Error('Could not extract valid JSON from response');
}

function callAPI(userPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.error) return reject(new Error(response.error.message));
          const text = response.content[0].text.trim();
          console.log(`    Raw response: ${text.slice(0, 80)}...`);
          resolve(extractJSON(text));
        } catch (e) {
          reject(new Error(e.message));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  if (!API_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }

  const puzzleData = JSON.parse(fs.readFileSync(UPDATED_FILE, 'utf8'));
  const outputData = JSON.parse(fs.readFileSync(REWORK_FILE, 'utf8'));

  console.log(`\n=== Fixing ${STRAGGLER_INDEXES.length} stragglers ===\n`);

  for (const gi of STRAGGLER_INDEXES) {
    const puzzle = puzzleData.puzzles[gi];
    console.log(`[#${gi+1}] "${puzzle.answer}"`);

    let success = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result = await callAPI(buildPrompt(puzzle));
        if (result.clues && result.clues.length === 5) {
          outputData.puzzles[gi].clues = result.clues;
          outputData.puzzles[gi]._reworked = true;
          console.log(`    OK (attempt ${attempt})\n`);
          success = true;
          break;
        } else {
          console.log(`    Bad clue count: ${result.clues?.length}`);
        }
      } catch (err) {
        console.log(`    Attempt ${attempt} error: ${err.message.slice(0, 80)}`);
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    if (!success) console.log(`    FAILED after 3 attempts — keeping original clues\n`);

    fs.writeFileSync(REWORK_FILE, JSON.stringify(outputData, null, 2));
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('Done. Output: data/puzzles.rework-fixed.json');
}

main().catch(err => { console.error(err.message); process.exit(1); });
