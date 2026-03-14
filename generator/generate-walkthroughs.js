/**
 * GENERATE-WALKTHROUGHS.JS
 * Generates post-game walkthrough text for each puzzle using Claude Haiku.
 * The walkthrough explains each clue's reasoning, helping players learn.
 *
 * Input:  final-puzzles.json (822 puzzles)
 * Output: final-puzzles.json (updated in-place with walkthrough field)
 * Progress: walkthrough-progress.json (resume support)
 *
 * Run: ANTHROPIC_API_KEY=... node generate-walkthroughs.js
 * Run limited: ANTHROPIC_API_KEY=... node generate-walkthroughs.js 10
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

// ─── CONFIG ─────────────────────────────────────────────────────
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5';
const INPUT_FILE = './final-puzzles.json';
const PROGRESS_FILE = './walkthrough-progress.json';
const DELAY_MS = 350;
const SAVE_EVERY = 25;
const LIMIT = parseInt(process.argv[2]) || 0; // e.g. "node generate-walkthroughs.js 10"

// ─── SYSTEM PROMPT ──────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a pharmacology educator writing post-game walkthroughs for Pharmodle, a daily drug identification game for pharmacy students and pharmacists.

Given a completed puzzle (answer + 5 clues), write a walkthrough that explains the reasoning behind each clue — what it reveals, why it matters, and how it narrows the answer. The goal is to teach pharmacology through the puzzle's logic.

## FORMAT
Write a single flowing paragraph (NOT bullet points, NOT numbered lists). 90–140 words. No markdown.

## CRITICAL RULES

### 1. Open with something specific to THIS drug
The very first sentence must say something concrete and interesting about the drug itself — a defining pharmacological fact, its clinical niche, mechanism, a key adverse effect, or a clinically relevant historical detail.

The opening must be CLINICALLY grounded. Draw your hook from pharmacology, not from the drug's cultural footprint or popularity.

DO NOT open with meta-commentary about the puzzle, the clues, or the game.

FORBIDDEN openers — do not use any variation of these:
❌ "[Drug] is a fascinating drug to identify through progressive reasoning."
❌ "This case required connecting a clinical presentation to its drug cause."
❌ "Drug interactions are among the most clinically important puzzles to solve."
❌ "[Drug] was identifiable through a combination of clinical, pharmacological, and historical knowledge."
❌ "The breadth of clues..."
❌ "Starting from its broad therapeutic area..."

Also forbidden — these specific patterns kill clinical rigor:
❌ Epidemiological scale language: "most prescribed worldwide", "leading cause globally", "millions of patients", "one of the most widely used"
❌ Narrative/dramatic flourishes: "revolutionised", "transformed", "catastrophe", "treacherous", "pharmacological accident", "a trap that catches prescribers"
❌ Colloquial asides: "and students alike", "the patient believes the drug is gone", "as every prescriber knows"
❌ Pop-science framing: "[Drug]'s journey from lab to clinic", "how a single molecule can become synonymous with..."

What makes a walkthrough INTERESTING is clinical precision and mechanistic insight — not storytelling.
✅ Counterintuitive pharmacology stated plainly: "Carbamazepine induces its own metabolism — doses must be escalated by 25–50% over the first month even as serum levels appear stable."
✅ Specific numbers that matter clinically: "TPMT-deficient patients accumulate thioguanine nucleotides to myelotoxic concentrations within 2 weeks at standard dosing."
✅ Mechanistic reasoning that rules things in or out: "Only a drug that both inhibits serotonin reuptake AND has mu-opioid activity could produce this serotonergic picture — ruling out pure opioids and pure antidepressants alike."

VARY THE OPENING STRUCTURE — do not default to "[Drug] is the only...". That pattern is sometimes the right choice, but using it repeatedly across puzzles makes every walkthrough feel the same. Draw from these different entry points instead:

- Mechanism + clinical consequence: "Carbamazepine induces its own metabolism via CYP3A4 — a process called autoinduction that forces dose escalation of 25–50% over the first month as clearance accelerates despite stable-looking serum levels."
- Adverse effect as the anchor: "Cholestatic jaundice appearing six weeks after completing a two-week antibiotic course is the clinical fingerprint of flucloxacillin hepatotoxicity — a delayed idiosyncratic reaction tied to HLA-B*57:01."
- Counterintuitive clinical fact: "Lithium's renal handling is identical to sodium — the kidney cannot distinguish between them — which is why any state of sodium depletion predictably causes lithium retention and toxicity."
- Mechanism-indication link: "Spironolactone's mineralocorticoid receptor antagonism drives potassium-sparing diuresis in heart failure, but its concurrent androgen receptor blockade is what makes it useful in PCOS and female-pattern hair loss."
- The clinical scenario itself: "A patient whose INR climbs to 8 after starting fluconazole has only one plausible anticoagulant on board — warfarin, whose S-enantiomer depends almost entirely on CYP2C9 for its clearance."

"[Drug] is the only..." is fine occasionally when it is the single most striking clinical fact, but it must not be the default.

### 2. Name the actual pharmacological content — don't talk about clues abstractly
When explaining what each clue revealed, name the specific pharmacological facts, not vague references to "the clues" or "the clinical details."

WRONG: "The clues progressively narrowed the field from a broad therapeutic area to a specific agent."
RIGHT: "Knowing it was an oral diabetes drug that doesn't cause hypoglycaemia as monotherapy already rules out sulfonylureas and insulin. The AMPK activation mechanism placed it firmly in the biguanide class."

WRONG: "The breadth of clues — spanning therapeutic use, mechanism, and unique characteristics — required integrating knowledge across multiple domains."
RIGHT: "Its use in both type 2 diabetes and polycystic ovary syndrome, combined with the AMPK mechanism and the lactic acidosis warning in renal impairment, leaves only one possibility."

### 3. Show the diagnostic funnel — explain why each piece of information rules things in or out
Don't just recite the facts. Explain the reasoning: "This rules out X because...", "Only [drug] has...", "Both Y and Z share this feature, but..."

### 4. End with the clinching identifier
The final sentence should state the one feature that is unique to this drug — the fact no other drug shares.

## GOOD EXAMPLE
For a puzzle about Metformin (drug_id type):
"The only biguanide in clinical use, metformin's story begins with the French lilac plant (Galega officinalis) — an unusual botanical origin for a cornerstone diabetes drug. An oral agent that reduces hepatic glucose output without stimulating insulin means no hypoglycaemia risk as monotherapy, immediately ruling out sulfonylureas. The AMPK activation mechanism and weight-neutral to modest weight-loss profile further narrow the field. Lactic acidosis in renal impairment is the landmark safety concern that every prescriber knows. The clincher: it must be withheld before iodinated contrast procedures — a requirement specific to metformin and no other oral glucose-lowering agent."

Respond with ONLY the walkthrough paragraph. No labels, no JSON, no markdown.`;

// ─── MAIN ─────────────────────────────────────────────────────────
async function main() {
  if (!API_KEY) {
    console.error('ERROR: Set ANTHROPIC_API_KEY');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey: API_KEY });

  // Load puzzles
  const raw = fs.readFileSync(INPUT_FILE, 'utf8');
  const data = JSON.parse(raw);
  const puzzles = data.puzzles || data;
  console.log(`Loaded ${puzzles.length} puzzles from ${INPUT_FILE}`);

  // Load progress (resume support)
  let progress = { completed: [] };
  if (fs.existsSync(PROGRESS_FILE)) {
    progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    console.log(`Resuming: ${progress.completed.length} walkthroughs already generated`);
  }
  const completedIds = new Set(progress.completed);

  // Filter to puzzles needing walkthroughs
  const remaining = puzzles.filter(p =>
    !completedIds.has(p.id) && (!p.walkthrough || p.walkthrough.trim().length < 20)
  );
  const toProcess = LIMIT > 0 ? remaining.slice(0, LIMIT) : remaining;
  console.log(`Remaining: ${remaining.length}${LIMIT > 0 ? ` (limited to ${toProcess.length})` : ''}`);

  if (toProcess.length === 0) {
    console.log('All walkthroughs done!');
    return;
  }

  let generated = 0;
  let errors = 0;
  const startTime = Date.now();

  for (let i = 0; i < toProcess.length; i++) {
    const puzzle = toProcess[i];
    const cluesSummary = puzzle.clues.map((c, j) =>
      `Clue ${j + 1} [${c.label}]: ${c.text}`
    ).join('\n');

    const userPrompt = `Write a walkthrough for this completed Pharmodle puzzle.

Drug: ${puzzle.answer}
Type: ${puzzle.type}
Category: ${puzzle.category}
Difficulty: ${puzzle.difficulty}

CLUES (in order they were revealed to the player):
${cluesSummary}

KEY PHARMACOLOGY (use these facts — mention the specific ones that matter most):
${puzzle.explanation}

Remember: open with something specific and interesting about ${puzzle.answer} itself. Do NOT use a generic opener. Name the actual pharmacological content from the clues — do not refer vaguely to "the clues" or "the details". Show the reasoning that rules things in and out.`;

    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const walkthrough = response.content[0].text.trim();
      const inputTokens = response.usage?.input_tokens || 0;
      const outputTokens = response.usage?.output_tokens || 0;

      // Update puzzle in-place
      puzzle.walkthrough = walkthrough;
      progress.completed.push(puzzle.id);
      generated++;

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = (generated / Math.max(elapsed / 60, 0.01)).toFixed(1);
      console.log(`[${i + 1}/${toProcess.length}] ${puzzle.answer} (${inputTokens}+${outputTokens} tok) — ${rate}/min`);

    } catch (err) {
      errors++;
      console.error(`[${i + 1}/${toProcess.length}] ${puzzle.answer} — ERROR: ${err.message}`);

      if (err.status === 429) {
        console.log('Rate limited — waiting 30s...');
        await new Promise(r => setTimeout(r, 30000));
        i--; // Retry
        continue;
      }
    }

    // Save progress periodically
    if ((generated + errors) % SAVE_EVERY === 0 || i === toProcess.length - 1) {
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
      if (data.puzzles) {
        fs.writeFileSync(INPUT_FILE, JSON.stringify(data, null, 2));
      } else {
        fs.writeFileSync(INPUT_FILE, JSON.stringify(puzzles, null, 2));
      }
      console.log(`  [Saved — ${progress.completed.length} total walkthroughs]`);
    }

    // Rate limit delay
    if (i < toProcess.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  // Final save
  if (data.puzzles) {
    fs.writeFileSync(INPUT_FILE, JSON.stringify(data, null, 2));
  } else {
    fs.writeFileSync(INPUT_FILE, JSON.stringify(puzzles, null, 2));
  }
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));

  // ─── SUMMARY ─────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  const withWalkthrough = puzzles.filter(p => p.walkthrough && p.walkthrough.length > 20).length;

  console.log('\n=== Walkthrough Generation Complete ===');
  console.log(`Generated this run:    ${generated}`);
  console.log(`Errors this run:       ${errors}`);
  console.log(`Total with walkthroughs: ${withWalkthrough}/${puzzles.length}`);
  console.log(`Time: ${elapsed} min`);

  // Cost estimate (Haiku: $0.80/M input, $4/M output)
  const estInputCost = (generated * 650 * 0.80) / 1_000_000;
  const estOutputCost = (generated * 220 * 4.00) / 1_000_000;
  console.log(`Est. cost this run: $${(estInputCost + estOutputCost).toFixed(2)}`);
  console.log(`Est. cost for 787 remaining: ~$${((787 * 650 * 0.80 + 787 * 220 * 4.00) / 1_000_000).toFixed(2)}`);
}

main().catch(console.error);
