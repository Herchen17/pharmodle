/**
 * FIX-POOR-PUZZLES.JS
 * Re-generates POOR-graded puzzles via Haiku API, replacing them in the batch.
 * Saves progress incrementally so it can be resumed if interrupted.
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5';
const FULL_BATCH_FILE = './full-batch-puzzles.json';
const PROGRESS_FILE = './fix-poor-progress.json';
const DELAY_MS = 500;
const MAX_RETRIES = 2;

// ─── REFERENCE DATA ──────────────────────────────────────────────────────────
const classGroups = JSON.parse(fs.readFileSync('./drug-class-groups.json', 'utf8'));
const allDrugs = JSON.parse(fs.readFileSync('./puzzle-drug-list.json', 'utf8'));
const drugMap = {};
allDrugs.forEach(d => { drugMap[d.name.toLowerCase()] = d; });

function findClassmates(drugName) {
  const mates = [];
  for (const [, members] of Object.entries(classGroups)) {
    if (Array.isArray(members) && members.some(m => m.toLowerCase() === drugName.toLowerCase())) {
      members.forEach(m => {
        if (m.toLowerCase() !== drugName.toLowerCase()) mates.push(m);
      });
    }
  }
  return [...new Set(mates)].slice(0, 10);
}

// ─── GRADER ──────────────────────────────────────────────────────────────────
const { gradePuzzle, loadReferenceData } = require('./pharmodle-auto-grader.js');
loadReferenceData();

// ─── PROMPTS ─────────────────────────────────────────────────────────────────
const typeInstructions = {
  drug_id: "Drug ID puzzle: identify a drug from its pharmacological profile and clinical use.\nClue labels: Clinical Context → Key Feature → Pharmacology Clue → Narrowing Detail → Identifying Detail\nClue 1 should describe a broad therapeutic area or clinical scenario. Clue 5 should contain a unique identifying fact.",
  adr_case: "ADR Case puzzle: identify the drug causing an adverse reaction from a clinical vignette.\nClue labels: Patient Presentation → Investigations → Key Finding → Drug Clue → Identifying Detail\nClue 1 should describe patient symptoms without naming any drug. Build toward the specific drug-ADR link.",
  drug_interaction: "Drug Interaction puzzle: identify the drug causing a clinically significant interaction.\nClue labels: Clinical Scenario → Co-prescribed Drugs → Interaction Effect → Mechanism Clue → Identifying Detail\nClue 1 should describe a patient on multiple medications with a problem. Do NOT name the answer drug in co-prescribed drugs.",
  mixed_profile: "Mixed Profile puzzle: identify a drug from mixed clinical, pharmacological, and historical knowledge.\nClue labels: Clinical Context → Pharmacology Clue → Key Feature → Narrowing Detail → Identifying Detail\nDraw from multiple knowledge domains. Can include regulatory, historical, or formulation facts.",
};

const clueLabelsMap = {
  drug_id: ["Clinical Context", "Key Feature", "Pharmacology Clue", "Narrowing Detail", "Identifying Detail"],
  adr_case: ["Patient Presentation", "Investigations", "Key Finding", "Drug Clue", "Identifying Detail"],
  drug_interaction: ["Clinical Scenario", "Co-prescribed Drugs", "Interaction Effect", "Mechanism Clue", "Identifying Detail"],
  mixed_profile: ["Clinical Context", "Pharmacology Clue", "Key Feature", "Narrowing Detail", "Identifying Detail"],
};

const SYSTEM_PROMPT = `You are a pharmacology puzzle generator for Pharmodle, a daily drug identification game for pharmacy students and pharmacists internationally.

You create ONE puzzle at a time where players identify a specific drug from 5 progressive clues following the DIAGNOSTIC FUNNEL methodology.

## CRITICAL RULES

### Progressive Narrowing (Diagnostic Funnel)
- Clue 1: Broad clinical context — compatible with 10+ drugs across multiple classes
- Clue 2: Narrows to a drug class or therapeutic area — ~5-8 drugs plausible
- Clue 3: Key pharmacological feature — ~3-4 drugs plausible
- Clue 4: Distinctive narrowing detail — ~1-2 drugs plausible
- Clue 5: Definitive identifying detail — only 1 drug matches all clues

### Absolute Prohibitions
- NEVER include the answer drug name (including partial matches) in ANY clue text
- NEVER include any alias or brand name of the answer in clues 1-4 (brand names in Clue 5 ARE allowed)
- NEVER mention the exact drug class name in Clues 1-2 (too narrowing)
- NEVER use CYP enzyme names before Clue 3
- NEVER use vague filler: 'commonly used', 'widely prescribed', 'frequently used', 'first-line', 'well-known', 'gold standard'
- NEVER mention other specific drug names in clues 1-4

### Three-Tier Answer System
For each puzzle, you MUST assess:
- aliases: Brand names and alternative generic names for the answer (INN primary, major international brands)
- acceptable_alternatives: Other drugs that genuinely fit ALL 5 clues equally well (max 3)
- near_misses: Same-class drugs ruled out by at least one specific clue detail

### International Context
- Use INN (International Nonproprietary Names) as primary drug names
- Avoid country-specific scheduling, PBS, or regulatory status clues
- Use metric units for all measurements
- Stick to established pharmacology that is internationally consistent

### Quality Standards
- Each clue: 15-60 words, clinically accurate, no redundancy between clues
- Explanation: 2-3 sentences summarising why this drug is the answer
- Every fact must be verifiable against standard pharmacology references

### OUTPUT FORMAT
Respond with ONLY valid JSON, no markdown formatting, no explanation outside the JSON.`;

function buildFixPrompt(drugName, chapter, classmates, type, difficulty, failures) {
  const labels = clueLabelsMap[type];

  // Build failure-specific warnings
  const failureWarnings = [];
  failures.forEach(f => {
    if (f.rule === 'NO_ANSWER_IN_CLUES') {
      failureWarnings.push(`⚠️ CRITICAL: The previous attempt FAILED because "${drugName}" appeared in a clue text. Do NOT write the drug name in ANY clue under any circumstances.`);
    }
    if (f.rule === 'NO_BRAND_BEFORE_CLUE5') {
      failureWarnings.push(`⚠️ CRITICAL: The previous attempt FAILED because a brand name of "${drugName}" appeared before Clue 5. Brand names are ONLY permitted in Clue 5.`);
    }
    if (f.rule === 'PROGRESSIVE_NARROWING') {
      failureWarnings.push(`⚠️ CRITICAL: The previous attempt FAILED the progressive narrowing check. Clue 1 must be broad enough for 10+ drugs. Do NOT use CYP enzymes in Clue 1.`);
    }
  });

  return `Generate a Pharmodle puzzle for the drug: ${drugName}

Drug details:
- Therapeutic chapter: ${chapter}
- Drug class-mates (same class): ${classmates.join(', ') || 'none identified'}
- Assigned puzzle type: ${type}
- Difficulty target: ${difficulty}

Puzzle type instructions:
${typeInstructions[type]}

Clue labels for this type: ${labels.join(' → ')}

${failureWarnings.join('\n')}

IMPORTANT REMINDERS:
- The answer "${drugName}" must NEVER appear in any clue text — search each clue carefully before outputting
- No brand names of ${drugName} in clues 1-4 (only allowed in Clue 5)
- No other specific drug names in clues 1-4
- No drug class name in clues 1-2
- Every fact must be pharmacologically accurate and internationally applicable
- Clue 1 should be genuinely broad (10+ drugs could fit)

Respond with this exact JSON structure:
{
  "answer": "${drugName}",
  "aliases": ["brand names", "alternative generic names"],
  "acceptable_alternatives": [],
  "near_misses": {
    "drugs": ["class-mate drugs ruled out by specific clues"],
    "feedback": "1 sentence explaining why answer is correct and near-misses are wrong"
  },
  "category": "therapeutic category",
  "domain": "specific domain",
  "type": "${type}",
  "difficulty": "${difficulty}",
  "clues": [
    {"label": "${labels[0]}", "text": "15-60 words"},
    {"label": "${labels[1]}", "text": "15-60 words"},
    {"label": "${labels[2]}", "text": "15-60 words"},
    {"label": "${labels[3]}", "text": "15-60 words"},
    {"label": "${labels[4]}", "text": "15-60 words"}
  ],
  "explanation": "2-3 sentences",
  "confidence": 5
}`;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  if (!API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY not set');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey: API_KEY });

  // Load full batch
  const batchData = JSON.parse(fs.readFileSync(FULL_BATCH_FILE, 'utf8'));
  const puzzles = batchData.puzzles || batchData;
  const puzzleById = {};
  puzzles.forEach((p, idx) => { puzzleById[p.id] = { puzzle: p, idx }; });

  // Find POOR puzzles by grading
  console.log('\n=== Identifying POOR puzzles ===');
  const gradeResults = puzzles.map(p => gradePuzzle(p));
  const poorResults = gradeResults.filter(r => r.grade === 'POOR');
  console.log(`Found ${poorResults.length} POOR puzzles to fix`);

  // Also fix NEEDS_WORK puzzles
  const needsWorkResults = gradeResults.filter(r => r.grade === 'NEEDS_WORK');
  console.log(`Found ${needsWorkResults.length} NEEDS_WORK puzzles to fix`);

  const toFix = [...poorResults, ...needsWorkResults];
  console.log(`Total to fix: ${toFix.length}`);

  // Load progress file (resume support)
  let progress = { fixed: [], failed: [], skipped: [] };
  if (fs.existsSync(PROGRESS_FILE)) {
    progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    console.log(`\nResuming: ${progress.fixed.length} already fixed, ${progress.failed.length} failed`);
  }
  const alreadyProcessed = new Set([
    ...progress.fixed.map(f => f.id),
    ...progress.failed.map(f => f.id),
    ...progress.skipped.map(f => f.id),
  ]);

  const remaining = toFix.filter(r => !alreadyProcessed.has(r.puzzleId));
  console.log(`Remaining to process: ${remaining.length}`);

  if (remaining.length === 0) {
    console.log('All done! Writing final output...');
  } else {
    console.log(`\nStarting fix generation...\n`);
  }

  let fixCount = 0;
  let failCount = 0;

  for (let i = 0; i < remaining.length; i++) {
    const gradeResult = remaining[i];
    const puzzleId = gradeResult.puzzleId;
    const answer = gradeResult.answer;
    const entry = puzzleById[puzzleId];

    if (!entry) {
      console.log(`[${i+1}/${remaining.length}] [${puzzleId}] ${answer} — NOT FOUND in batch, skipping`);
      progress.skipped.push({ id: puzzleId, answer });
      continue;
    }

    const origPuzzle = entry.puzzle;
    const drugInfo = drugMap[answer.toLowerCase()] || {};
    const chapter = drugInfo.chapter || origPuzzle.category || '';
    const classmates = findClassmates(answer);
    const type = origPuzzle.type || 'drug_id';
    const difficulty = origPuzzle.difficulty || 'medium';
    const failures = gradeResult.issues.filter(c => c.severity === 'FAIL');

    console.log(`[${i+1}/${remaining.length}] Fixing: ${answer} [${type}, ${difficulty}]`);
    console.log(`  Failures: ${failures.map(f => f.rule).join(', ')}`);

    let newPuzzle = null;
    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        console.log(`  Retry ${attempt}/${MAX_RETRIES}...`);
        await new Promise(r => setTimeout(r, 1000));
      }

      try {
        const response = await client.messages.create({
          model: MODEL,
          max_tokens: 1500,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildFixPrompt(answer, chapter, classmates, type, difficulty, failures) }],
        });

        const text = response.content[0].text;
        let jsonStr = text;
        const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) jsonStr = jsonMatch[1];

        const parsed = JSON.parse(jsonStr.trim());
        parsed.id = origPuzzle.id; // preserve original ID

        // Auto-grade the new puzzle
        const newGrade = gradePuzzle(parsed);
        const inputTokens = response.usage?.input_tokens || 0;
        const outputTokens = response.usage?.output_tokens || 0;
        console.log(`  Generated (${inputTokens}+${outputTokens} tokens) → grade: ${newGrade.grade}`);

        if (newGrade.grade === 'POOR') {
          const stillFailing = newGrade.issues.filter(c => c.severity === 'FAIL');
          console.log(`  ⚠️  Still POOR: ${stillFailing.map(f => f.rule).join(', ')}`);
          if (attempt < MAX_RETRIES) {
            lastError = `Still POOR after generation`;
            continue;
          }
          // Accept ACCEPTABLE or better even on final attempt
          // If still POOR after retries, keep it — don't lose data
          console.log(`  ⚠️  Accepting POOR after ${MAX_RETRIES + 1} attempts (best available)`);
        }

        newPuzzle = parsed;
        newPuzzle._newGrade = newGrade.grade;
        break;

      } catch (err) {
        lastError = err.message;
        console.error(`  ✗ Error: ${err.message}`);

        // Handle rate limits
        if (err.status === 429) {
          console.log('  Rate limited, waiting 30s...');
          await new Promise(r => setTimeout(r, 30000));
        }
      }
    }

    if (newPuzzle) {
      // Replace puzzle in array
      puzzles[entry.idx] = newPuzzle;
      progress.fixed.push({ id: puzzleId, answer, newGrade: newPuzzle._newGrade });
      delete newPuzzle._newGrade;
      fixCount++;
      console.log(`  ✓ Fixed`);
    } else {
      progress.failed.push({ id: puzzleId, answer, error: lastError });
      failCount++;
      console.log(`  ✗ FAILED after all retries`);
    }

    // Save progress every 10 puzzles
    if ((i + 1) % 10 === 0 || i === remaining.length - 1) {
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
      // Also update the main batch file
      const output = {
        puzzles,
        metadata: {
          ...batchData.metadata,
          lastFixRun: new Date().toISOString(),
          fixedCount: progress.fixed.length,
          failedCount: progress.failed.length,
        }
      };
      fs.writeFileSync(FULL_BATCH_FILE, JSON.stringify(output, null, 2));
      console.log(`  [Progress saved: ${progress.fixed.length} fixed total]`);
    }

    // Rate limit delay
    if (i < remaining.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  // ─── FINAL REPORT ─────────────────────────────────────────────────────────
  console.log('\n=== Fix Run Complete ===');
  console.log(`Fixed this run: ${fixCount}`);
  console.log(`Failed this run: ${failCount}`);
  console.log(`Total fixed (all runs): ${progress.fixed.length}`);
  console.log(`Total failed (all runs): ${progress.failed.length}`);

  // Re-grade the whole batch for final stats
  const finalPuzzles = JSON.parse(fs.readFileSync(FULL_BATCH_FILE, 'utf8')).puzzles;
  const finalResults = finalPuzzles.map(p => gradePuzzle(p));
  const finalGrades = { GOOD: 0, ACCEPTABLE: 0, NEEDS_WORK: 0, POOR: 0 };
  finalResults.forEach(r => finalGrades[r.grade] = (finalGrades[r.grade] || 0) + 1);
  console.log('\nFinal grade distribution:', finalGrades);
  console.log(`Good rate: ${((finalGrades.GOOD / finalPuzzles.length) * 100).toFixed(1)}%`);

  if (progress.failed.length > 0) {
    console.log('\nPersistently failed puzzles:');
    progress.failed.forEach(f => console.log(`  [${f.id}] ${f.answer}: ${f.error}`));
  }
}

main().catch(console.error);
