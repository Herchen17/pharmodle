const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

// ─── CONFIG ────────────────────────────────────────────────
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5';
const OUTPUT_FILE = './full-batch-puzzles.json';
const PROGRESS_FILE = './full-batch-progress.json';
const DELAY_MS = 400;
const SAVE_EVERY = 10; // Save progress every N puzzles
const TARGET_PUZZLES = 750;

// ─── LOAD DATA ─────────────────────────────────────────────
const allDrugs = JSON.parse(fs.readFileSync('./puzzle-drug-list.json', 'utf8'));
const classGroups = JSON.parse(fs.readFileSync('./drug-class-groups.json', 'utf8'));

// Load ALL previously generated puzzles (batch 1 + batch 2)
const batch1 = JSON.parse(fs.readFileSync('./test-puzzles-all.json', 'utf8')).puzzles;
const batch2 = JSON.parse(fs.readFileSync('./batch2-puzzles.json', 'utf8')).puzzles;
const existingDrugs = new Set([...batch1, ...batch2].map(p => p.answer.toLowerCase()));
const nextId = Math.max(...batch1.map(p => p.id), ...batch2.map(p => p.id)) + 1;

console.log(`Previously generated: ${existingDrugs.size} puzzles (next ID: ${nextId})`);

// ─── RESUME SUPPORT ─────────────────────────────────────────
let resumeData = { completed: [], errors: [], lastIndex: 0 };
if (fs.existsSync(PROGRESS_FILE)) {
  resumeData = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  console.log(`Resuming from progress file: ${resumeData.completed.length} already done, starting at index ${resumeData.lastIndex}`);
  // Add resumed drugs to existing set to avoid re-generating
  resumeData.completed.forEach(p => existingDrugs.add(p.answer.toLowerCase()));
}

// ─── DRUG SELECTION ─────────────────────────────────────────
function isGoodDrug(drug) {
  const name = drug.name;
  if (existingDrugs.has(name.toLowerCase())) return false;
  if (/\band\b/i.test(name)) return false;
  if (/\bwith\b/i.test(name)) return false;
  if (/antivenom/i.test(name)) return false;
  if (!drug.has_amh_content) return false;
  if (name.length > 30) return false;
  return true;
}

// Deduplicate by base name — keep the primary entry (no parenthetical) or first match
const candidates = allDrugs.filter(isGoodDrug);
const baseNameMap = new Map();
candidates.forEach(d => {
  const base = d.name.replace(/\s*\(.*\)/, '').toLowerCase();
  if (!baseNameMap.has(base)) {
    baseNameMap.set(base, d);
  } else {
    // Prefer the one without parenthetical, or the one with more AMH content
    const existing = baseNameMap.get(base);
    const existingHasParen = /\(/.test(existing.name);
    const newHasParen = /\(/.test(d.name);
    if (existingHasParen && !newHasParen) {
      baseNameMap.set(base, d); // Prefer clean name
    } else if (d.content_length > existing.content_length) {
      baseNameMap.set(base, d); // Prefer more content
    }
  }
});

const uniqueDrugs = Array.from(baseNameMap.values());

// Shuffle
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const shuffled = shuffle(uniqueDrugs).slice(0, TARGET_PUZZLES);
console.log(`Selected ${shuffled.length} unique drugs for generation`);

// ─── TYPE & DIFFICULTY ASSIGNMENT ───────────────────────────
// Target: 43% drug_id, 25% mixed_profile, 17% adr_case, 15% drug_interaction
const typeWeights = [
  { type: 'drug_id', fraction: 0.43 },
  { type: 'mixed_profile', fraction: 0.25 },
  { type: 'adr_case', fraction: 0.17 },
  { type: 'drug_interaction', fraction: 0.15 },
];

let typeAssignments = [];
typeWeights.forEach(tw => {
  const count = Math.round(shuffled.length * tw.fraction);
  for (let i = 0; i < count; i++) typeAssignments.push(tw.type);
});
// Fill any remainder with drug_id
while (typeAssignments.length < shuffled.length) typeAssignments.push('drug_id');
typeAssignments = shuffle(typeAssignments);

const difficulties = ['easy', 'medium', 'hard'];

const puzzleInputs = shuffled.map((drug, i) => {
  const type = typeAssignments[i];
  const diff = drug.difficulty || difficulties[Math.floor(Math.random() * 3)];
  // Clean drug name: remove parenthetical qualifiers for the puzzle answer
  const cleanName = drug.name.replace(/\s*\(.*\)$/, '');
  return { drug, cleanName, type, difficulty: diff };
});

// ─── CLASSMATES ─────────────────────────────────────────────
function findClassmates(drugName) {
  const mates = [];
  const clean = drugName.replace(/\s*\(.*\)$/, '').toLowerCase();
  for (const [groupName, members] of Object.entries(classGroups)) {
    if (Array.isArray(members) && members.some(m => m.toLowerCase() === clean || m.toLowerCase() === drugName.toLowerCase())) {
      members.forEach(m => {
        if (m.toLowerCase() !== clean && m.toLowerCase() !== drugName.toLowerCase()) mates.push(m);
      });
    }
  }
  return [...new Set(mates)].slice(0, 10);
}

// ─── PROMPTS ────────────────────────────────────────────────
const typeInstructions = {
  drug_id: "Drug ID puzzle: identify a drug from its pharmacological profile and clinical use.\nClue labels: Clinical Context → Key Feature → Pharmacology Clue → Narrowing Detail → Identifying Detail\nClue 1 should describe a broad therapeutic area or clinical scenario. Clue 5 should contain a unique identifying fact.",
  adr_case: "ADR Case puzzle: identify the drug causing an adverse reaction from a clinical vignette.\nClue labels: Patient Presentation → Investigations → Key Finding → Drug Clue → Identifying Detail\nClue 1 should describe patient symptoms without naming any drug. Build toward the specific drug-ADR link.",
  drug_interaction: "Drug Interaction puzzle: identify the drug causing a clinically significant interaction.\nClue labels: Clinical Scenario → Co-prescribed Drugs → Interaction Effect → Mechanism Clue → Identifying Detail\nClue 1 should describe a patient on multiple medications with a problem. Do NOT name the answer drug in co-prescribed drugs.",
  mixed_profile: "Mixed Profile puzzle: identify a drug from mixed clinical, pharmacological, and historical knowledge.\nClue labels: Clinical Context → Pharmacology Clue → Key Feature → Narrowing Detail → Identifying Detail\nDraw from multiple knowledge domains. Can include regulatory, historical, or formulation facts."
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
- NEVER mention other specific drug names in clues 1-4 (e.g., don't say 'unlike warfarin...')

### Three-Tier Answer System
For each puzzle, you MUST assess:
- aliases: Brand names and alternative generic names for the answer (use International Nonproprietary Names as primary, include major regional brand names)
- acceptable_alternatives: Other drugs that genuinely fit ALL 5 clues equally well (max 3). If your clues distinguish the answer from all class-mates, this should be empty []
- near_misses: Same-class drugs ruled out by at least one specific clue detail. Include drugs[] and feedback string explaining why

### International Context
- Use INN (International Nonproprietary Names) as primary drug names
- Include major international brand names in aliases
- Avoid country-specific scheduling, PBS, or regulatory status clues
- Use metric units for all measurements
- Stick to established pharmacology that is internationally consistent

### Quality Standards
- Each clue: 15-60 words, clinically accurate, no redundancy between clues
- Explanation: 2-3 sentences summarising why this drug is the answer
- Every fact must be verifiable against standard pharmacology references
- Self-rate confidence 1-5 honestly

### OUTPUT FORMAT
Respond with ONLY valid JSON, no markdown formatting, no explanation outside the JSON.`;

function buildUserPrompt(drugName, chapter, classmates, type, difficulty) {
  const labels = clueLabelsMap[type];
  return `Generate a Pharmodle puzzle for the drug: ${drugName}

Drug details:
- Therapeutic chapter: ${chapter}
- Drug class-mates (same class): ${classmates.join(', ') || 'none identified'}
- Assigned puzzle type: ${type}
- Difficulty target: ${difficulty}

Puzzle type instructions:
${typeInstructions[type]}

Clue labels for this type: ${labels.join(' → ')}

IMPORTANT REMINDERS:
- The answer "${drugName}" must NEVER appear in any clue text (check carefully!)
- No brand names of ${drugName} in clues 1-4
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

// ─── MAIN GENERATION LOOP ───────────────────────────────────
async function main() {
  const client = new Anthropic({ apiKey: API_KEY });
  const results = [...resumeData.completed];
  const errors = [...resumeData.errors];
  const startIndex = resumeData.lastIndex;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const typeCounts = {};
  const diffCounts = {};
  puzzleInputs.forEach(pi => {
    typeCounts[pi.type] = (typeCounts[pi.type] || 0) + 1;
    diffCounts[pi.difficulty] = (diffCounts[pi.difficulty] || 0) + 1;
  });

  console.log(`\n=== Pharmodle Full Generation ===`);
  console.log(`Model: ${MODEL}`);
  console.log(`Target: ${puzzleInputs.length} puzzles`);
  console.log(`Starting from index: ${startIndex} (${results.length} already completed)`);
  console.log(`Type distribution:`, typeCounts);
  console.log(`Difficulty distribution:`, diffCounts);
  console.log(`\nStarting generation...\n`);

  const startTime = Date.now();

  for (let i = startIndex; i < puzzleInputs.length; i++) {
    const { drug, cleanName, type, difficulty } = puzzleInputs[i];
    const classmates = findClassmates(drug.name);
    const userPrompt = buildUserPrompt(cleanName, drug.chapter || '', classmates, type, difficulty);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = i > startIndex ? ((i - startIndex) / ((Date.now() - startTime) / 60000)).toFixed(1) : '—';
    const eta = i > startIndex ? (((puzzleInputs.length - i) / ((i - startIndex) / ((Date.now() - startTime) / 60000))) / 60).toFixed(1) : '—';

    process.stdout.write(`[${i+1}/${puzzleInputs.length}] ${cleanName} (${type}, ${difficulty}) [${elapsed}s, ${rate}/min, ETA: ${eta}h]... `);

    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const text = response.content[0].text;
      let jsonStr = text;
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) jsonStr = jsonMatch[1];

      const puzzle = JSON.parse(jsonStr.trim());
      puzzle.id = nextId + i;
      // Ensure clean answer name
      puzzle.answer = cleanName;
      results.push(puzzle);

      const inTok = response.usage?.input_tokens || 0;
      const outTok = response.usage?.output_tokens || 0;
      totalInputTokens += inTok;
      totalOutputTokens += outTok;
      console.log(`✓ (${inTok}+${outTok} tok)`);

    } catch (err) {
      console.log(`✗ ${err.message.substring(0, 80)}`);
      errors.push({ drug: cleanName, type, difficulty, error: err.message, index: i });

      // If rate limited, wait longer
      if (err.status === 429) {
        console.log('  Rate limited — waiting 30s...');
        await new Promise(r => setTimeout(r, 30000));
      }
    }

    // Save progress incrementally
    if ((i + 1) % SAVE_EVERY === 0 || i === puzzleInputs.length - 1) {
      const progress = { completed: results, errors, lastIndex: i + 1 };
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress));

      if ((i + 1) % 50 === 0) {
        console.log(`\n--- Progress: ${results.length} generated, ${errors.length} errors, ${totalInputTokens + totalOutputTokens} total tokens ---\n`);
      }
    }

    // Rate limit delay
    if (i < puzzleInputs.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  // ─── SAVE FINAL RESULTS ────────────────────────────────────
  const output = {
    puzzles: results,
    metadata: {
      generated: new Date().toISOString(),
      model: MODEL,
      count: results.length,
      errors: errors.length,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      estimated_cost: `$${((totalInputTokens * 0.8 + totalOutputTokens * 4) / 1000000).toFixed(2)}`,
    }
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  const duration = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`\n=== Generation Complete ===`);
  console.log(`Duration: ${duration} minutes`);
  console.log(`Generated: ${results.length}/${puzzleInputs.length}`);
  console.log(`Errors: ${errors.length}`);
  console.log(`Tokens: ${totalInputTokens} in + ${totalOutputTokens} out = ${totalInputTokens + totalOutputTokens} total`);
  console.log(`Est. cost: ${output.metadata.estimated_cost}`);
  console.log(`Saved to: ${OUTPUT_FILE}`);

  if (errors.length > 0) {
    console.log(`\nFailed drugs (${errors.length}):`);
    errors.forEach(e => console.log(`  - ${e.drug} [${e.type}]: ${e.error.substring(0, 60)}`));
  }

  // Quick stats
  const tc = {}, dc = {};
  results.forEach(p => {
    tc[p.type] = (tc[p.type] || 0) + 1;
    dc[p.difficulty] = (dc[p.difficulty] || 0) + 1;
  });
  console.log(`\nActual type distribution:`, tc);
  console.log(`Actual difficulty distribution:`, dc);
}

main().catch(console.error);
