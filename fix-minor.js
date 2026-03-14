/**
 * Fix MINOR_FIX Puzzles
 *
 * Reads batch-reviews.json, finds all MINOR_FIX puzzles, sends them to the API
 * in batches of 5 for targeted clue improvements. Light touch — just fix the
 * specific issue identified, don't rewrite everything.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=key node fix-minor.js
 *   ANTHROPIC_API_KEY=key node fix-minor.js --count=20  (test first)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const UPDATED_FILE   = path.join(__dirname, 'data', 'puzzles.updated.json');
const BATCH_FILE     = path.join(__dirname, 'data', 'batch-reviews.json');
const OUTPUT_FILE    = path.join(__dirname, 'data', 'puzzles.minor-fixed.json');
const PROGRESS_FILE  = path.join(__dirname, 'data', '.fix_minor_progress.json');

const API_KEY        = process.env.ANTHROPIC_API_KEY;
const MODEL          = 'claude-haiku-4-5-20251001';
const BATCH_SIZE     = 5;
const DELAY_MS       = 500;
const MAX_RETRIES    = 3;

const SYSTEM_PROMPT = `You are fixing clues for Physiodle, a Wordle-style physiotherapy diagnosis game.

GAME RULES:
- 5 clues: Complaint → Activity → History → Examination → Imaging
- Each clue must add NEW information that narrows the differential
- Clue 1 should be broad (10+ possible conditions), Clue 5 near-definitive

YOUR TASK: You will receive puzzles that have MINOR issues. For each puzzle you get:
- The current 5 clues
- The specific issue identified by a reviewer

Make TARGETED fixes only. Do NOT rewrite clues that are already working well.
Common minor fixes:
- One clue slightly overlaps with another → rewrite just that one clue to add distinct info
- A clue is too generic → add more specific clinical detail
- Progression stumbles at one point → adjust the problematic clue
- Clue 5 isn't specific enough → add definitive imaging findings

KEEP the clinical style: third person, terse, realistic physiotherapy language.
KEEP clues that are already good — only change what's broken.

Respond with ONLY valid JSON array, no markdown.`;

function buildBatchPrompt(batch) {
  const puzzleTexts = batch.map((item, idx) => {
    const clueLines = item.puzzle.clues
      .map((c, i) => `  C${i+1} (${c.label}): "${c.text}"`)
      .join('\n');

    return `PUZZLE ${idx+1}: "${item.puzzle.answer}" [${item.puzzle.category}]
ISSUE: ${item.reason}
${clueLines}`;
  }).join('\n\n');

  return `Fix these ${batch.length} puzzles. For each, return ALL 5 clues (even unchanged ones) with targeted fixes based on the identified issue.

${puzzleTexts}

Respond with a JSON array:
[
  {
    "index": 0,
    "answer": "Condition Name",
    "clues": [
      {"label": "Complaint", "text": "..."},
      {"label": "Activity", "text": "..."},
      {"label": "History", "text": "..."},
      {"label": "Examination", "text": "..."},
      {"label": "Imaging", "text": "..."}
    ]
  }
]

Only change clues that need fixing. Keep good clues exactly as they are.`;
}

function callAPI(userPrompt, retries = 0) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
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
        if (res.statusCode === 429 || res.statusCode >= 500) {
          if (retries < MAX_RETRIES) {
            const wait = Math.pow(2, retries) * 2000;
            console.log(`    ⏳ Retrying in ${wait/1000}s...`);
            setTimeout(() => callAPI(userPrompt, retries + 1).then(resolve).catch(reject), wait);
          } else {
            reject(new Error(`API error ${res.statusCode}`));
          }
          return;
        }
        try {
          const response = JSON.parse(data);
          if (response.error) return reject(new Error(response.error.message));
          const text = response.content[0].text.trim();
          const cleaned = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
          resolve(JSON.parse(cleaned));
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });

    req.on('error', (e) => {
      if (retries < MAX_RETRIES) {
        setTimeout(() => callAPI(userPrompt, retries + 1).then(resolve).catch(reject), 2000);
      } else { reject(e); }
    });

    req.write(body);
    req.end();
  });
}

async function main() {
  if (!API_KEY) { console.error('❌ Missing ANTHROPIC_API_KEY'); process.exit(1); }

  const args = process.argv.slice(2);
  const countArg = args.find(a => a.startsWith('--count='));
  const countLimit = countArg ? parseInt(countArg.split('=')[1]) : null;

  // Load data
  const puzzleData = JSON.parse(fs.readFileSync(UPDATED_FILE, 'utf8'));
  const batchReviews = JSON.parse(fs.readFileSync(BATCH_FILE, 'utf8'));

  // Also include DNS-errored puzzles from Run 1 that weren't rewritten
  const reviews = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'reviews.json'), 'utf8'));
  const dnsErrorIndices = new Set(Object.values(reviews).filter(r => r.error).map(r => r.index));

  // Get MINOR_FIX puzzles + DNS errors not already READY
  const minorFixList = Object.values(batchReviews)
    .filter(r => r.verdict === 'MINOR_FIX' || (dnsErrorIndices.has(r.globalIndex) && r.verdict !== 'READY'))
    .sort((a, b) => a.globalIndex - b.globalIndex);

  // Deduplicate
  const seen = new Set();
  const toFix = minorFixList.filter(r => {
    if (seen.has(r.globalIndex)) return false;
    seen.add(r.globalIndex);
    return true;
  });

  // Load or create output
  let outputData;
  try {
    outputData = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
  } catch {
    outputData = JSON.parse(JSON.stringify(puzzleData));
  }

  let progress = {};
  try { progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch { progress = { completed: [] }; }

  // Filter out already completed
  const completedSet = new Set(progress.completed || []);
  const remaining = toFix.filter(r => !completedSet.has(r.globalIndex));

  const total = countLimit ? Math.min(countLimit, remaining.length) : remaining.length;
  const totalBatches = Math.ceil(total / BATCH_SIZE);

  console.log(`\n🔧 MINOR FIX Pipeline`);
  console.log(`   Total MINOR_FIX puzzles: ${toFix.length}`);
  console.log(`   Already completed: ${completedSet.size}`);
  console.log(`   To process: ${total} (${totalBatches} batches of ${BATCH_SIZE})`);
  console.log('');

  let processed = 0, errors = 0;

  for (let b = 0; b < totalBatches; b++) {
    const batchItems = remaining.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    if (batchItems.length === 0) break;

    const batch = batchItems.map(r => ({
      globalIndex: r.globalIndex,
      puzzle: puzzleData.puzzles[r.globalIndex],
      reason: r.reason || 'Minor clue improvements needed'
    }));

    const indices = batch.map(b => b.globalIndex + 1).join(',');
    process.stdout.write(`[Batch ${b+1}/${totalBatches}] #${indices} `);

    try {
      const prompt = buildBatchPrompt(batch);
      const results = await callAPI(prompt);

      results.forEach((r, idx) => {
        const gi = batch[idx].globalIndex;
        if (r.clues && r.clues.length === 5) {
          outputData.puzzles[gi].clues = r.clues;
          outputData.puzzles[gi]._minor_fixed = true;
        }
        progress.completed = progress.completed || [];
        progress.completed.push(gi);
      });

      console.log(`✓ (${batch.length} fixed)`);
      processed += batch.length;

    } catch (err) {
      console.log(`ERROR: ${err.message.slice(0, 50)}`);
      errors++;
    }

    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(outputData, null, 2));

    if (b < totalBatches - 1) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log('\n' + '─'.repeat(50));
  console.log(`✅ Minor fixes done! ${processed} puzzles fixed.`);
  if (errors > 0) console.log(`   ${errors} batch errors`);
  console.log(`📦 Output: data/puzzles.minor-fixed.json`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
