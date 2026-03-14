/**
 * Physiodle Puzzle Re-Grade Script
 *
 * Re-evaluates all puzzles based on UPDATED clues (not original).
 * Creates a new ratings file showing how good the clues are AFTER rewrites.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=key node regrade-puzzles.js
 *   ANTHROPIC_API_KEY=key node regrade-puzzles.js --count=50   (test first)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const UPDATED_FILE   = path.join(__dirname, 'data', 'puzzles.updated.json');
const REGRADED_FILE  = path.join(__dirname, 'data', 'regraded-reviews.json');
const PROGRESS_FILE  = path.join(__dirname, 'data', '.regrade_progress.json');

const API_KEY        = process.env.ANTHROPIC_API_KEY;
const MODEL          = 'claude-haiku-4-5-20251001';
const DELAY_MS       = 300;
const MAX_RETRIES    = 3;

// ─── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are evaluating clues for Physiodle, a Wordle-style daily game where players guess physiotherapy diagnoses.

GAME RULES:
- Players see clues one at a time, starting with Clue 1 (Complaint), then 2, 3, 4, 5
- Each wrong guess reveals the next clue
- Players get a maximum of 5 guesses
- The ENTIRE GAME depends on each clue adding MEANINGFUL NEW INFORMATION that narrows the differential

THE PROGRESSIVE REVEAL PRINCIPLE (MOST IMPORTANT):
Think of the 5 clues as a clinical reasoning funnel. Each clue MUST contribute new, distinct information that eliminates possibilities and inches the player closer to the answer. If two clues feel interchangeable or a player learns nothing new from a clue they didn't already know from the previous one, the clue has FAILED.

- Clue 1 (Complaint): Cast the widest net. Symptoms only. Should be plausible for 10+ different conditions. NO anatomy-specific language that gives away body region if avoidable. A physio student reading ONLY this clue should be generating a broad differential list.

- Clue 2 (Activity): Functional limitations. This should narrow the differential to a body region or movement pattern, but NOT to a single diagnosis. NEW information is the functional impact.

- Clue 3 (History): Background, mechanism, timeline. The clinical picture starts crystallising. NEW information should eliminate 50-70% of remaining possibilities.

- Clue 4 (Examination): Specific objective findings. This is the key discriminator. NEW information should differentiate between remaining 2-3 possibilities.

- Clue 5 (Imaging): Near-definitive. Specific imaging findings that confirm the diagnosis.

HOW TO EVALUATE:
For each clue, ask: "What NEW information does this clue add that the previous clues didn't?" If the answer is "nothing much" or "it just rephrases", it's a problem. Evaluate the ENTIRE SEQUENCE as a funnel.

RATING GUIDE:
- "good": All 5 clues work well together. Each adds distinct information. Progressive reveal is smooth. Clue 1 is vague, Clue 5 is definitive. A physiotherapy student would enjoy playing this.
- "needs_work": Some clues are redundant, or the progression isn't quite right, or one or two clues need tweaking. But overall playable and with some edits could be good.
- "poor": Fundamental structural flaw. Clue 1 gives away the answer, or clues are severely redundant, or the sequence doesn't narrow the differential, or the clinical story is incoherent. Needs major rework.

You must respond with ONLY valid JSON, no markdown, no explanation outside the JSON.`;

function buildPrompt(puzzle) {
  const clueLines = puzzle.clues
    .map((c, i) => `Clue ${i + 1} (${c.label}): "${c.text}"`)
    .join('\n');

  return `Evaluate this Physiodle puzzle (UPDATED CLUES):

ANSWER: ${puzzle.answer}
CATEGORY: ${puzzle.category}

${clueLines}

Rate the overall puzzle quality AFTER the clue updates. Focus on:
1. Does Clue 1 cast a wide enough net, or does it give away the answer?
2. Does each clue add NEW information that the previous ones didn't?
3. Is the progression from vague (C1) to definitive (C5) smooth?
4. Would a physio student find this puzzle fair and enjoyable?

Respond with:
{
  "overall_quality": "good" | "needs_work" | "poor",
  "reasoning": "1-2 sentences explaining your rating"
}`;
}

// ─── API call ──────────────────────────────────────────────────────────────────

function callAPI(prompt, retries = 0) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }]
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
            setTimeout(() => callAPI(prompt, retries + 1).then(resolve).catch(reject), wait);
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
          const parsed = JSON.parse(cleaned);
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });

    req.on('error', (e) => {
      if (retries < MAX_RETRIES) {
        setTimeout(() => callAPI(prompt, retries + 1).then(resolve).catch(reject), 2000);
      } else {
        reject(e);
      }
    });

    req.write(body);
    req.end();
  });
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) {
    console.error('❌ Missing ANTHROPIC_API_KEY');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const countArg = args.find(a => a.startsWith('--count='));
  const countLimit = countArg ? parseInt(countArg.split('=')[1]) : null;

  // Load data
  const puzzleData = JSON.parse(fs.readFileSync(UPDATED_FILE, 'utf8'));
  const puzzles = puzzleData.puzzles;

  let regraded = {};
  try {
    regraded = JSON.parse(fs.readFileSync(REGRADED_FILE, 'utf8'));
  } catch { }

  let progress = {};
  try {
    progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch {
    progress = { lastIndex: -1 };
  }

  const startIndex = progress.lastIndex + 1;
  const endIndex = countLimit ? Math.min(startIndex + countLimit, puzzles.length) : puzzles.length;

  console.log(`\n🦴 Re-grading Puzzles (Updated Clues)`);
  console.log(`   Model: ${MODEL}`);
  console.log(`   Puzzles: ${startIndex} → ${endIndex - 1} (${endIndex - startIndex} to process)`);
  console.log('');

  let reviewed = 0, errors = 0;

  for (let i = startIndex; i < endIndex; i++) {
    const puzzle = puzzles[i];
    const key = `${puzzle.answer}_${i}`;

    process.stdout.write(`[${i + 1}/${endIndex}] ${puzzle.answer.padEnd(40)}`);

    try {
      const prompt = buildPrompt(puzzle);
      const rating = await callAPI(prompt);

      regraded[key] = {
        index: i,
        answer: puzzle.answer,
        category: puzzle.category,
        overall_quality: rating.overall_quality,
        reasoning: rating.reasoning,
        regraded_at: new Date().toISOString()
      };

      const quality = rating.overall_quality === 'good' ? '✓' :
                      rating.overall_quality === 'needs_work' ? '~' : '✗';
      console.log(`${quality}`);

      reviewed++;

    } catch (err) {
      console.log(`ERROR`);
      errors++;
      regraded[key] = { index: i, answer: puzzle.answer, error: err.message };
    }

    // Save progress
    progress.lastIndex = i;
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
    fs.writeFileSync(REGRADED_FILE, JSON.stringify(regraded, null, 2));

    if (i < endIndex - 1) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  // Summary
  const allRegraded = Object.values(regraded).filter(r => !r.error);
  const good = allRegraded.filter(r => r.overall_quality === 'good').length;
  const needsWork = allRegraded.filter(r => r.overall_quality === 'needs_work').length;
  const poor = allRegraded.filter(r => r.overall_quality === 'poor').length;

  console.log('\n' + '─'.repeat(50));
  console.log(`✅ Done! Re-graded ${reviewed} puzzles.`);
  console.log(`   ✓ Good:        ${good} (${(good * 100 / reviewed).toFixed(1)}%)`);
  console.log(`   ~ Needs work:  ${needsWork} (${(needsWork * 100 / reviewed).toFixed(1)}%)`);
  console.log(`   ✗ Poor:        ${poor} (${(poor * 100 / reviewed).toFixed(1)}%)`);
  if (errors > 0) console.log(`   Errors:       ${errors}`);
  console.log('');
  console.log(`📄 Re-graded reviews: data/regraded-reviews.json`);
  console.log('');

  // Show poor puzzles
  const poorPuzzles = allRegraded.filter(r => r.overall_quality === 'poor');
  if (poorPuzzles.length > 0) {
    console.log(`⚠️  ${poorPuzzles.length} puzzles still rated POOR:`);
    poorPuzzles.slice(0, 15).forEach(r => {
      console.log(`   - ${r.answer} (${r.category}): ${r.reasoning.slice(0, 100)}`);
    });
    if (poorPuzzles.length > 15) console.log(`   ... and ${poorPuzzles.length - 15} more`);
  }
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
