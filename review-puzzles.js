/**
 * Physiodle Puzzle Review Pipeline
 *
 * Two-pass system:
 *   Run 1 (--mode=clues):        Review & rewrite clues for progressive reveal
 *   Run 2 (--mode=explanations): Generate post-game explanations from approved clues
 *
 * Saves progress after every puzzle — safe to interrupt and resume.
 *
 * Usage:
 *   RUN 1 — Fix clues:
 *     ANTHROPIC_API_KEY=key node review-puzzles.js --mode=clues
 *     ANTHROPIC_API_KEY=key node review-puzzles.js --mode=clues --count=20
 *     → outputs: data/reviews.json, data/puzzles.updated.json
 *     → review & approve, then: cp data/puzzles.updated.json data/puzzles.json
 *
 *   RUN 2 — Add explanations (run AFTER approving clues):
 *     ANTHROPIC_API_KEY=key node review-puzzles.js --mode=explanations
 *     → reads from data/puzzles.json (your approved clues)
 *     → outputs: data/explanations.json, data/puzzles.explained.json
 *
 *   Common flags:
 *     --count=N     only process N puzzles
 *     --start=N     start from puzzle index N
 *     --dry-run     process first 3 only
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ─── Config ────────────────────────────────────────────────────────────────────

const PUZZLES_FILE    = path.join(__dirname, 'data', 'puzzles.json');
const API_KEY         = process.env.ANTHROPIC_API_KEY;
const MODEL           = 'claude-haiku-4-5-20251001';
const DELAY_MS        = 300;
const MAX_RETRIES     = 3;

// ─── Mode-specific file paths ──────────────────────────────────────────────────

const MODE_CONFIG = {
  clues: {
    reviewsFile:  path.join(__dirname, 'data', 'reviews.json'),
    updatedFile:  path.join(__dirname, 'data', 'puzzles.updated.json'),
    progressFile: path.join(__dirname, 'data', '.review_progress.json'),
  },
  explanations: {
    reviewsFile:  path.join(__dirname, 'data', 'explanations.json'),
    updatedFile:  path.join(__dirname, 'data', 'puzzles.explained.json'),
    progressFile: path.join(__dirname, 'data', '.explain_progress.json'),
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// RUN 1: CLUE REVIEW
// ═══════════════════════════════════════════════════════════════════════════════

const CLUES_SYSTEM_PROMPT = `You are reviewing clues for Physiodle, a Wordle-style daily game where players guess physiotherapy diagnoses.

GAME RULES:
- Players see clues one at a time, starting with Clue 1 (Complaint), then 2, 3, 4, 5
- Each wrong guess reveals the next clue
- Players get a maximum of 5 guesses
- The ENTIRE GAME depends on each clue adding MEANINGFUL NEW INFORMATION that narrows the differential

THE PROGRESSIVE REVEAL PRINCIPLE (MOST IMPORTANT):
Think of the 5 clues as a clinical reasoning funnel. Each clue MUST contribute new, distinct information that eliminates possibilities and inches the player closer to the answer. If two clues feel interchangeable or a player learns nothing new from a clue they didn't already know from the previous one, the clue has FAILED.

- Clue 1 (Complaint): Cast the widest net. Symptoms only — what the patient says. Should be plausible for 10+ different conditions. NO anatomy-specific language that gives away body region if avoidable. Age, gender, occupation, and onset character (acute/gradual/intermittent) are fine. A physio student reading ONLY this clue should be generating a broad differential list.

- Clue 2 (Activity): Functional limitations. What can't they do? This should narrow the differential to a body region or movement pattern, but NOT to a single diagnosis. The NEW information here is the functional impact — e.g., "can't reach overhead" narrows from 10+ conditions to maybe 5-6 shoulder/upper limb conditions.

- Clue 3 (History): Background, mechanism, timeline, comorbidities, prior treatments. This is where the clinical picture starts crystallising. The NEW information should eliminate 50-70% of remaining possibilities. After clues 1+2+3, a good clinician might have 2-3 diagnoses on their shortlist.

- Clue 4 (Examination): Specific objective findings — special tests, ROM measurements, palpation, neurological signs. This is the key discriminator. The NEW information here should differentiate between the remaining 2-3 possibilities. A skilled clinician should be fairly confident after this clue.

- Clue 5 (Imaging): Near-definitive. Specific imaging findings that confirm the diagnosis. After this, essentially only one answer is reasonable.

HOW TO EVALUATE EACH CLUE:
For each clue, ask: "What NEW information does this clue add that the previous clues didn't provide?" If the answer is "nothing much" or "it just rephrases the same thing", it's a problem. Specifically:
- Does Clue 2 add functional info NOT already implied by Clue 1?
- Does Clue 3 add history/mechanism NOT already covered?
- Does Clue 4 provide examination findings that actively DISTINGUISH between remaining candidates?
- Does Clue 5 provide imaging that CONFIRMS one specific diagnosis?

PROBLEMS TO FLAG:
- TOO EASY: Clue 1 or 2 essentially gives away the answer (e.g., "patient has carpal tunnel-like symptoms in the wrist")
- TOO HARD: Even Clue 5 is vague — a clinician still couldn't be confident
- NO NEW INFO: A clue adds nothing beyond what previous clues already established — just rephrases or elaborates without narrowing the differential further. This is the most common problem.
- WRONG ORDER: A later clue is MORE vague than an earlier one, or an earlier clue contains information that belongs in a later category
- GENERIC: A clue could apply to almost any musculoskeletal condition (e.g., "patient has pain and reduced ROM")
- INCONSISTENT: Clues don't tell a coherent clinical story about one patient
- NAMING THE ANSWER: A clue literally says the diagnosis name or a very obvious synonym

WHEN REWRITING:
- Preserve the clinical style: third person, terse, realistic
- Make sure your rewritten clue adds DISTINCT information from the other clues
- Each clue should make the player think "ah, now I can rule out X and Y" — there should be a tangible narrowing effect
- Clue 1 rewrites should be deliberately broad. Remove any giveaway anatomy or pathology terms.
- Clue 4/5 rewrites should be specific enough to be genuinely useful for diagnosis

You must respond with ONLY valid JSON, no markdown, no explanation outside the JSON.`;

function buildCluesPrompt(puzzle) {
  const clueLines = puzzle.clues
    .map((c, i) => `Clue ${i + 1} (${c.label}): "${c.text}"`)
    .join('\n');

  return `Review this Physiodle puzzle:

ANSWER: ${puzzle.answer}
CATEGORY: ${puzzle.category}

${clueLines}

For each clue, evaluate:
1. What NEW information does this clue add that previous clues didn't?
2. Does it meaningfully narrow the differential diagnosis?
3. Is the information appropriate for this clue's position in the sequence (1=broadest, 5=most specific)?

If a clue repeats, rephrases, or only marginally extends information from previous clues, flag it as "no_new_info".
If a clue is good on its own but belongs at a different position (e.g., examination-level specificity in a complaint clue), flag as "wrong_order".

Respond with this exact JSON structure:
{
  "overall_quality": "good" | "needs_work" | "poor",
  "clues": [
    {
      "index": 0,
      "label": "Complaint",
      "new_info": "brief description of what new info this clue adds (or 'redundant with clue X')",
      "issues": [],
      "severity": "ok" | "minor" | "major",
      "rewrite": null | "suggested rewrite text if needed"
    }
  ],
  "notes": "brief overall notes about progressive reveal quality, or null"
}

For "issues" use: "too_easy", "too_hard", "too_generic", "no_new_info", "names_answer", "wrong_order", "incoherent"
Only provide a "rewrite" if severity is "minor" or "major". Rewrites MUST add distinct information from the other clues.
Keep the same clinical style — third person, terse, clinical language.`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUN 2: EXPLANATION GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

const EXPLAIN_SYSTEM_PROMPT = `You are writing post-game explanations for Physiodle, a Wordle-style daily game where players guess physiotherapy diagnoses.

After a player guesses (or fails to guess) the answer, they see a short explanation. Your job is to write this.

The explanation should read like a concise clinical teaching moment — not a walkthrough of the clues, but an informative snapshot of the condition itself. The clues informed the presentation; now the explanation illuminates the condition behind it.

WHAT TO INCLUDE:
1. What the condition actually is — pathophysiology, who gets it, why
2. What makes it clinically distinctive — the key features that set it apart from similar conditions
3. Why the presentation in this puzzle is characteristic — weave in 1-2 details from the case naturally, not as "Clue X showed..."

STYLE:
- 3-4 sentences. Informative and satisfying, like a tutor explaining after a case.
- Condition-first: lead with what it is, not with what the clues said
- Clinical terminology appropriate for a physio student, but accessible
- The case details should appear naturally ("the bilateral nocturnal symptoms..." not "Clue 3 mentioned...")
- No fluff, no "Great job!", no game references

EXAMPLE TONE (for carpal tunnel syndrome):
"Carpal tunnel syndrome results from compression of the median nerve as it passes through the carpal tunnel at the wrist, most commonly due to tenosynovial thickening, fluid retention, or repetitive flexion loading. It classically presents with nocturnal paraesthesia in the thumb, index, and middle fingers — the median nerve distribution — often waking patients from sleep. Bilateral involvement and association with pregnancy, as seen here, reflects the role of systemic fluid retention. Phalen's and Tinel's tests, combined with nerve conduction findings of slowed distal latency, remain the diagnostic gold standard."

You must respond with ONLY valid JSON, no markdown, no explanation outside the JSON.`;

function buildExplainPrompt(puzzle) {
  const clueLines = puzzle.clues
    .map((c, i) => `Clue ${i + 1} (${c.label}): "${c.text}"`)
    .join('\n');

  return `Write a post-game explanation for this Physiodle puzzle:

ANSWER: ${puzzle.answer}
CATEGORY: ${puzzle.category}

${clueLines}

Respond with this exact JSON:
{
  "explanation": "Your 2-4 sentence explanation here"
}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED INFRASTRUCTURE
// ═══════════════════════════════════════════════════════════════════════════════

function callAPI(systemPrompt, userPrompt, maxTokens, retries = 0) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
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
            console.log(`    ⏳ Retrying in ${wait/1000}s (${res.statusCode})...`);
            setTimeout(() => callAPI(systemPrompt, userPrompt, maxTokens, retries + 1).then(resolve).catch(reject), wait);
          } else {
            reject(new Error(`API error ${res.statusCode}: ${data}`));
          }
          return;
        }
        try {
          const response = JSON.parse(data);
          if (response.error) return reject(new Error(response.error.message));
          const text = response.content[0].text.trim();
          const cleaned = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
          let parsed;
          try {
            parsed = JSON.parse(cleaned);
          } catch {
            // Try extracting JSON object from response
            const start = text.indexOf('{');
            const end = text.lastIndexOf('}');
            if (start !== -1 && end > start) {
              parsed = JSON.parse(text.slice(start, end + 1));
            } else {
              throw new Error('No valid JSON found in response');
            }
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    });

    req.on('error', (e) => {
      if (retries < MAX_RETRIES) {
        setTimeout(() => callAPI(systemPrompt, userPrompt, maxTokens, retries + 1).then(resolve).catch(reject), 2000);
      } else {
        reject(e);
      }
    });

    req.write(body);
    req.end();
  });
}

function applyClueRewrites(puzzle, review) {
  const updated = JSON.parse(JSON.stringify(puzzle));
  if (!review.clues) return updated;
  for (const cr of review.clues) {
    if (cr.rewrite && (cr.severity === 'minor' || cr.severity === 'major')) {
      if (updated.clues[cr.index]) {
        updated.clues[cr.index].text = cr.rewrite;
        updated.clues[cr.index]._rewritten = true;
      }
    }
  }
  return updated;
}

function loadJSON(filepath, fallback) {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); }
  catch { return fallback; }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) {
    console.error('❌ Missing ANTHROPIC_API_KEY environment variable.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const modeArg = args.find(a => a.startsWith('--mode='));
  const mode = modeArg ? modeArg.split('=')[1] : null;

  if (!mode || !['clues', 'explanations'].includes(mode)) {
    console.error('❌ Please specify a mode:');
    console.error('   --mode=clues          Review & fix clue quality (Run 1)');
    console.error('   --mode=explanations   Generate post-game explanations (Run 2)');
    process.exit(1);
  }

  const dryRun = args.includes('--dry-run');
  const startArg = args.find(a => a.startsWith('--start='));
  const countArg = args.find(a => a.startsWith('--count='));
  const forceStart = startArg ? parseInt(startArg.split('=')[1]) : null;
  const countLimit = countArg ? parseInt(countArg.split('=')[1]) : null;

  const config = MODE_CONFIG[mode];
  const puzzleData = JSON.parse(fs.readFileSync(PUZZLES_FILE, 'utf8'));
  const puzzles = puzzleData.puzzles;
  const reviews = loadJSON(config.reviewsFile, {});
  const progress = loadJSON(config.progressFile, { completedIndices: [], lastIndex: -1 });

  let updatedData;
  try {
    updatedData = JSON.parse(fs.readFileSync(config.updatedFile, 'utf8'));
  } catch {
    updatedData = JSON.parse(JSON.stringify(puzzleData));
  }

  const startIndex = forceStart !== null ? forceStart : progress.lastIndex + 1;
  const endIndex = dryRun     ? Math.min(startIndex + 3, puzzles.length)
                 : countLimit ? Math.min(startIndex + countLimit, puzzles.length)
                 : puzzles.length;

  const modeLabel = mode === 'clues' ? 'RUN 1 — Clue Review' : 'RUN 2 — Explanations';

  console.log(`\n🦴 Physiodle Puzzle Review Pipeline`);
  console.log(`   ${modeLabel}`);
  console.log(`   Model: ${MODEL}`);
  console.log(`   Puzzles: ${startIndex} → ${endIndex - 1} (${endIndex - startIndex} to process)`);
  if (countLimit) console.log(`   Limited to ${countLimit} puzzles`);
  console.log('');

  let reviewed = 0, flagged = 0, rewritten = 0, errors = 0;

  for (let i = startIndex; i < endIndex; i++) {
    const puzzle = puzzles[i];
    const key = `${puzzle.answer}_${i}`; // unique key (handles duplicate answer names)

    process.stdout.write(`[${i + 1}/${endIndex}] ${puzzle.answer.padEnd(40)}`);

    try {
      let review;

      if (mode === 'clues') {
        const prompt = buildCluesPrompt(puzzle);
        review = await callAPI(CLUES_SYSTEM_PROMPT, prompt, 1500);

        reviews[key] = {
          index: i,
          answer: puzzle.answer,
          category: puzzle.category,
          overall_quality: review.overall_quality,
          clues: review.clues,
          notes: review.notes,
          reviewed_at: new Date().toISOString()
        };

        const updatedPuzzle = applyClueRewrites(puzzle, review);
        updatedData.puzzles[i] = updatedPuzzle;

        const hasIssues = review.clues && review.clues.some(c => c.severity !== 'ok');
        const hasRewrites = review.clues && review.clues.some(c => c.rewrite);
        if (hasIssues) flagged++;
        if (hasRewrites) rewritten++;

        const quality = review.overall_quality === 'good' ? '✓' :
                        review.overall_quality === 'needs_work' ? '~' : '✗';
        const issues = review.clues
          ? review.clues.filter(c => c.severity !== 'ok').map(c => `C${c.index + 1}:${c.severity}`).join(' ')
          : '';
        console.log(`${quality} ${issues || 'clean'}`);

      } else {
        // mode === 'explanations'
        const prompt = buildExplainPrompt(puzzle);
        review = await callAPI(EXPLAIN_SYSTEM_PROMPT, prompt, 600);

        reviews[key] = {
          index: i,
          answer: puzzle.answer,
          explanation: review.explanation,
          generated_at: new Date().toISOString()
        };

        // Apply explanation to the updated puzzle data
        updatedData.puzzles[i] = JSON.parse(JSON.stringify(puzzle));
        updatedData.puzzles[i].explanation = review.explanation;

        console.log(`✓ ${review.explanation.slice(0, 70)}...`);
        reviewed++;
      }

      // Save progress
      progress.lastIndex = i;
      if (!progress.completedIndices.includes(i)) progress.completedIndices.push(i);
      fs.writeFileSync(config.progressFile, JSON.stringify(progress, null, 2));
      fs.writeFileSync(config.reviewsFile, JSON.stringify(reviews, null, 2));
      fs.writeFileSync(config.updatedFile, JSON.stringify(updatedData, null, 2));

      if (mode === 'clues') reviewed++;

    } catch (err) {
      console.log(`ERROR: ${err.message.slice(0, 60)}`);
      errors++;
      reviews[key] = { index: i, answer: puzzle.answer, error: err.message, reviewed_at: new Date().toISOString() };
      fs.writeFileSync(config.reviewsFile, JSON.stringify(reviews, null, 2));
    }

    if (i < endIndex - 1) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  // ─── Summary ──────────────────────────────────────────────────────────────

  console.log('\n' + '─'.repeat(50));
  console.log(`✅ Done! Processed ${reviewed} puzzles.`);
  if (mode === 'clues') {
    console.log(`   ${flagged} flagged with issues`);
    console.log(`   ${rewritten} had clues rewritten`);
  }
  if (errors > 0) console.log(`   ${errors} errors`);
  console.log('');

  if (mode === 'clues') {
    console.log(`📄 Reviews:  ${config.reviewsFile}`);
    console.log(`📦 Updated:  ${config.updatedFile}`);
    console.log('');

    const allReviews = Object.values(reviews).filter(r => !r.error);
    const poor = allReviews.filter(r => r.overall_quality === 'poor');
    if (poor.length > 0) {
      console.log(`⚠️  ${poor.length} puzzles rated POOR:`);
      poor.slice(0, 10).forEach(r => console.log(`   - ${r.answer} (${r.category}): ${(r.notes || '').slice(0, 120)}`));
      if (poor.length > 10) console.log(`   ... and ${poor.length - 10} more`);
    }

    console.log('');
    console.log(`Next steps:`);
    console.log(`   1. node trial-report.js              → view before/after HTML report`);
    console.log(`   2. Review and approve the changes`);
    console.log(`   3. cp data/puzzles.updated.json data/puzzles.json`);
    console.log(`   4. node review-puzzles.js --mode=explanations`);
  } else {
    console.log(`📄 Explanations: ${config.reviewsFile}`);
    console.log(`📦 Updated:      ${config.updatedFile}`);
    console.log('');
    console.log(`Next steps:`);
    console.log(`   1. cp data/puzzles.explained.json data/puzzles.json`);
    console.log(`   2. Push to GitHub to deploy`);
  }
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
