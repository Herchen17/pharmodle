/**
 * Auto Re-grade Script (No API)
 *
 * Reads updated puzzles and applies intelligent re-grading logic.
 * Uses heuristics to evaluate progressive reveal quality without API calls.
 *
 * Usage:
 *   node auto-regrade.js              → re-grades all puzzles
 *   node auto-regrade.js --count=100  → grades first 100
 */

const fs = require('fs');
const path = require('path');

const UPDATED_FILE  = path.join(__dirname, 'data', 'puzzles.updated.json');
const OUTPUT_FILE   = path.join(__dirname, 'data', 'regraded-reviews.json');

// Load data
console.log('📖 Loading puzzles...');
const puzzleData = JSON.parse(fs.readFileSync(UPDATED_FILE, 'utf8'));
const puzzles = puzzleData.puzzles;

const args = process.argv.slice(2);
const countArg = args.find(a => a.startsWith('--count='));
const countLimit = countArg ? parseInt(countArg.split('=')[1]) : null;

const endIndex = countLimit ? Math.min(countLimit, puzzles.length) : puzzles.length;

console.log(`🔍 Analyzing ${endIndex} puzzles for quality...\n`);

// ─── Analysis Functions ────────────────────────────────────────────────────────

/**
 * Analyzes a single puzzle and returns a quality rating
 */
function gradePuzzle(puzzle) {
  const clues = puzzle.clues || [];
  if (clues.length < 5) return { quality: 'poor', reason: 'Missing clues' };

  const issues = [];

  // 1. CHECK CLUE 1 (should be very broad, generic symptoms)
  const c1 = clues[0]?.text || '';
  const c1HasDiagnosis = /palsy|tear|fracture|syndrome|disease|disorder|injury|rupture|infarction|edema|ulcer|neuropathy/i.test(c1);
  const c1TooMedical = /mri|xray|ct scan|ultrasound|imaging|biopsy|serology|culture|antigen/i.test(c1);
  const c1Vague = /pain|weakness|stiffness|discomfort|limitation|loss/.test(c1);

  if (c1HasDiagnosis || c1TooMedical) {
    issues.push('C1_too_specific');
  }
  if (!c1Vague) {
    issues.push('C1_not_descriptive_enough');
  }

  // 2. CHECK PROGRESSION: each clue should add new concept
  const c1Concepts = extractConcepts(c1);
  const c2Concepts = extractConcepts(clues[1]?.text || '');
  const c3Concepts = extractConcepts(clues[2]?.text || '');
  const c4Concepts = extractConcepts(clues[3]?.text || '');
  const c5Concepts = extractConcepts(clues[4]?.text || '');

  // Check for redundancy
  const c2NewConcepts = c2Concepts.filter(c => !c1Concepts.includes(c));
  const c3NewConcepts = c3Concepts.filter(c => !c1Concepts.includes(c) && !c2Concepts.includes(c));
  const c4NewConcepts = c4Concepts.filter(c => !c1Concepts.includes(c) && !c2Concepts.includes(c) && !c3Concepts.includes(c));
  const c5NewConcepts = c5Concepts.filter(c => !c1Concepts.includes(c) && !c2Concepts.includes(c) && !c3Concepts.includes(c) && !c4Concepts.includes(c));

  // Clue 2 should add functional/activity info
  const c2HasActivity = /activity|function|unable|can't|difficulty|movement|range|motion|strength/.test(clues[1]?.text || '');
  if (!c2HasActivity && c2NewConcepts.length < 2) {
    issues.push('C2_lacks_new_info');
  }

  // Clue 3 should add history/mechanism
  const c3HasHistory = /history|timeline|onset|mechanism|trauma|injury|accident|sport|work|after/.test(clues[2]?.text || '');
  if (!c3HasHistory && c3NewConcepts.length < 2) {
    issues.push('C3_lacks_new_info');
  }

  // Clue 4 should have exam findings
  const c4HasExam = /test|sign|findings|palpation|rom|range|strength|weakness|positive|negative|palpable/.test(clues[3]?.text || '');
  if (!c4HasExam && c4NewConcepts.length < 2) {
    issues.push('C4_lacks_new_info');
  }

  // Clue 5 should have imaging
  const c5HasImaging = /mri|xray|ct|ultrasound|imaging|scan|radiograph|image/.test(clues[4]?.text || '');
  if (!c5HasImaging) {
    issues.push('C5_missing_imaging');
  }

  // 3. CHECK FOR DIAGNOSIS NAMING (critical problem)
  const diagnosisName = puzzle.answer.toLowerCase();
  const diagnosisShort = diagnosisName.split(' ')[0]; // first word

  let namedIn = [];
  clues.forEach((c, i) => {
    const text = c.text.toLowerCase();
    if (text.includes(diagnosisName) || text.includes(diagnosisShort)) {
      namedIn.push(i + 1);
    }
  });

  if (namedIn.length > 0 && namedIn[0] === 1) {
    issues.push('C1_names_answer');
  } else if (namedIn.length > 0 && namedIn[0] <= 2) {
    issues.push('names_answer_too_early');
  }

  // 4. CHECK GENERIC CONTENT (too vague overall)
  const genericPhrases = /pain and/i.test(c1) + /pain and/i.test(clues[1]?.text || '') + /pain and/i.test(clues[2]?.text || '');
  if (genericPhrases >= 2) {
    issues.push('too_generic');
  }

  // ─── DETERMINE RATING ──────────────────────────────────────────────────────

  // Critical failures = POOR
  if (issues.includes('C1_names_answer') || issues.includes('names_answer_too_early') && namedIn[0] === 2) {
    return { quality: 'poor', reason: 'Diagnosis named too early, breaks game challenge', issues };
  }

  if (c2NewConcepts.length === 0 || c3NewConcepts.length === 0) {
    return { quality: 'poor', reason: 'Redundant clues - insufficient new information progression', issues };
  }

  // Multiple issues = NEEDS WORK
  if (issues.length >= 3) {
    return { quality: 'needs_work', reason: `Multiple issues with progression: ${issues.join(', ')}`, issues };
  }

  // Some issues but generally sound = NEEDS WORK
  if (issues.length >= 1) {
    return { quality: 'needs_work', reason: `Minor issues: ${issues.join(', ')}`, issues };
  }

  // No issues and good progression = GOOD
  if (c2NewConcepts.length >= 2 && c3NewConcepts.length >= 2 && c4NewConcepts.length >= 1 && c5HasImaging) {
    return { quality: 'good', reason: 'Strong progressive reveal with distinct information at each step', issues };
  }

  return { quality: 'needs_work', reason: 'Some clues could be stronger', issues };
}

/**
 * Extract key concepts from clue text for comparison
 */
function extractConcepts(text) {
  if (!text) return [];

  const concepts = [];

  // Extract keywords by category
  if (/age|year|old|adult|child|adolescent|infant/.test(text)) concepts.push('age');
  if (/sport|athlete|training|exercise|activity|game/.test(text)) concepts.push('activity_context');
  if (/pain|ache|discomfort|soreness/.test(text)) concepts.push('pain');
  if (/swelling|edema|inflammation|inflamed/.test(text)) concepts.push('swelling');
  if (/weakness|weak|strength|strong|paralysis|loss of/.test(text)) concepts.push('weakness');
  if (/movement|range|rom|flex|extend|motion|mobile/.test(text)) concepts.push('movement');
  if (/numbness|tingling|sensation|paresthesia|numb/.test(text)) concepts.push('sensation');
  if (/trauma|injury|fall|accident|hit|struck|impact/.test(text)) concepts.push('trauma');
  if (/gradual|sudden|acute|chronic|onset/.test(text)) concepts.push('onset');
  if (/positive|negative|test|sign|finding|palpation/.test(text)) concepts.push('exam_findings');
  if (/mri|xray|ct|imaging|ultrasound|scan/.test(text)) concepts.push('imaging');
  if (/history|prior|previous|past|before/.test(text)) concepts.push('history');
  if (/night|sleep|position|specific movement/.test(text)) concepts.push('timing_context');
  if (/inability|unable|difficulty|can't|cannot/.test(text)) concepts.push('functional_loss');

  return concepts;
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────

const regraded = {};

let good = 0, needsWork = 0, poor = 0;

for (let i = 0; i < endIndex; i++) {
  const puzzle = puzzles[i];
  const rating = gradePuzzle(puzzle);

  const key = `${puzzle.answer}_${i}`;
  regraded[key] = {
    index: i,
    answer: puzzle.answer,
    category: puzzle.category,
    overall_quality: rating.quality,
    reasoning: rating.reason,
    issues: rating.issues,
    regraded_at: new Date().toISOString()
  };

  const quality = rating.quality === 'good' ? '✓' :
                  rating.quality === 'needs_work' ? '~' : '✗';
  console.log(`[${i + 1}/${endIndex}] ${puzzle.answer.padEnd(40)} ${quality}`);

  if (rating.quality === 'good') good++;
  else if (rating.quality === 'needs_work') needsWork++;
  else poor++;
}

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(regraded, null, 2));

// ─── SUMMARY ───────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(60));
console.log(`✅ Re-graded ${endIndex} puzzles`);
console.log('═'.repeat(60));
console.log(`  ✓ Good:         ${good} (${(good * 100 / endIndex).toFixed(1)}%)`);
console.log(`  ~ Needs Work:   ${needsWork} (${(needsWork * 100 / endIndex).toFixed(1)}%)`);
console.log(`  ✗ Poor:         ${poor} (${(poor * 100 / endIndex).toFixed(1)}%)`);
console.log('');
console.log(`📄 Saved to: data/regraded-reviews.json`);
console.log('');

// Show poor puzzles
const poorPuzzles = Object.values(regraded).filter(r => r.overall_quality === 'poor');
if (poorPuzzles.length > 0) {
  console.log(`⚠️  POOR QUALITY (${poorPuzzles.length}):`);
  poorPuzzles.slice(0, 20).forEach(r => {
    console.log(`   ${r.index + 1}. ${r.answer.padEnd(35)} ${r.reasoning}`);
  });
  if (poorPuzzles.length > 20) console.log(`   ... and ${poorPuzzles.length - 20} more`);
}

console.log('');
console.log(`💡 Use this updated rating to update your reports:`);
console.log(`   node complete-comparison-report.js --use-regraded`);
