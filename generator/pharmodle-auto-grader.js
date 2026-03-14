/**
 * PHARMODLE AUTO-GRADER v1.0
 * 
 * Runs heuristic checks on generated puzzles to catch common issues
 * BEFORE human review. Catches ~60% of issues automatically.
 * 
 * Each check returns: { pass: bool, severity: 'FAIL'|'WARN', message: string }
 * 
 * FAIL = puzzle is rejected, needs rework
 * WARN = puzzle flagged for closer human review
 */

const fs = require('fs');

// ========== CONFIGURATION ==========

// Drug names and class names that should NEVER appear in early clues
// This is loaded from the drug class groups file
let DRUG_CLASS_NAMES = [];
let DRUG_NAMES = [];
let CLASS_GROUPS = {};

function loadReferenceData() {
  try {
    CLASS_GROUPS = JSON.parse(fs.readFileSync('./drug-class-groups.json', 'utf8'));
    DRUG_CLASS_NAMES = Object.keys(CLASS_GROUPS).map(n => n.toLowerCase());
    
    const drugList = JSON.parse(fs.readFileSync('./puzzle-drug-list.json', 'utf8'));
    DRUG_NAMES = drugList.map(d => d.name.toLowerCase());
  } catch (e) {
    console.error('Warning: Could not load reference data:', e.message);
  }
}

// Brand names that are extremely well-known (essentially give away the drug)
const GIVEAWAY_BRANDS = [
  'panadol', 'nurofen', 'voltaren', 'ventolin', 'lipitor', 'coversyl',
  'nexium', 'somac', 'norvasc', 'cardizem', 'lasix', 'aldactone',
  'tegretol', 'epilim', 'dilantin', 'valium', 'xanax', 'stilnox',
  'zoloft', 'lexapro', 'prozac', 'endep', 'seroquel', 'risperdal',
  'clozaril', 'lithicarb', 'prednefrin', 'predsol', 'metformin',
  'diabex', 'januvia', 'jardiance', 'ozempic', 'trulicity',
  'humira', 'enbrel', 'herceptin', 'keytruda', 'opdivo',
  'warfarin', 'clexane', 'xarelto', 'eliquis', 'pradaxa',
  'fosamax', 'prolia', 'suboxone', 'narcan'
];

// CYP enzyme names (shouldn't appear before clue 3)
const CYP_ENZYMES = [
  'cyp3a4', 'cyp2d6', 'cyp2c9', 'cyp2c19', 'cyp1a2', 'cyp2b6',
  'cyp2e1', 'cyp2a6', 'cyp3a5', 'p-glycoprotein', 'p-gp', 'pgp',
  'oatp', 'bcrp', 'mrp'
];

// Whitelisted alias exceptions: drugs where an alias is structurally unavoidable
// in pharmacologically accurate clues (e.g. "alcohol dehydrogenase" for ethanol,
// "rapamycin" in mTOR pathway for sirolimus, metabolite "norpethidine" for pethidine)
const ALIAS_WHITELIST = {
  'ethanol': ['alcohol'],      // "alcohol dehydrogenase", "alcohol use disorder" etc.
  'sirolimus': ['rapamycin', 'rapa'],  // mTOR = mechanistic Target Of Rapamycin
  'pethidine': ['pethidine'],  // metabolite "norpethidine" contains "pethidine"
  'vitamin k': ['vitamin k'],  // "vitamin K-dependent factors" is a standard term
};

// Generic/vague terms that shouldn't be standalone clues
const VAGUE_TERMS = [
  'commonly used', 'widely prescribed', 'very common', 'frequently used',
  'popular medication', 'well-known drug', 'first-line', 'second-line',
  'gold standard'
];

// ========== GRADING RULES ==========

function gradeRule_NoAnswerInClues(puzzle) {
  /** RULE 1: The answer drug name must NEVER appear in any clue text
   *  Exception: Aliases/brand names ARE allowed in Clue 5 (that's the identifying detail)
   *  Exception: In Clue 5, the answer name appearing INSIDE a longer word (e.g. metabolite
   *    "norfluoxetine" containing "fluoxetine", brand "Isopto Atropine" containing "atropine")
   *    is allowed — it's part of the identifying detail.
   *  The primary answer name as a standalone word in Clues 1-4 always fails. */
  const answer = puzzle.answer.toLowerCase();
  const aliases = (puzzle.aliases || []).map(a => a.toLowerCase());

  const results = [];
  for (let i = 0; i < puzzle.clues.length; i++) {
    const clueText = puzzle.clues[i].text.toLowerCase();
    const isClue5 = (i === 4);

    // Check whitelisted aliases for this drug
    const whitelistedAliases = (ALIAS_WHITELIST[answer] || []).map(a => a.toLowerCase());

    // Primary answer name check
    if (answer.length > 3 && clueText.includes(answer)) {
      // Check if this answer is whitelisted (e.g. "vitamin k" in "vitamin K-dependent")
      const isWhitelisted = whitelistedAliases.includes(answer);

      if (isClue5) {
        // In Clue 5: only fail if answer appears as a STANDALONE word
        // (allow it inside brand names / metabolite names like "norfluoxetine")
        const allMatches = [...clueText.matchAll(new RegExp(`\\S*${answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\S*`, 'gi'))];
        const hasStandaloneUse = allMatches.some(m => m[0].toLowerCase() === answer);
        if (hasStandaloneUse) {
          results.push({
            pass: false,
            severity: 'FAIL',
            rule: 'NO_ANSWER_IN_CLUES',
            message: `Clue 5 contains the answer "${answer}" as a standalone word`
          });
        }
        // If answer only appears embedded (e.g. "norfluoxetine"), that's OK in Clue 5
      } else if (isWhitelisted) {
        // Whitelisted: answer appears as part of a standard medical term — downgrade to WARN
        results.push({
          pass: false,
          severity: 'WARN',
          rule: 'NO_ANSWER_IN_CLUES',
          message: `Clue ${i + 1} contains whitelisted term "${answer}" (unavoidable in context)`
        });
      } else {
        // Clues 1-4: answer name always fails
        results.push({
          pass: false,
          severity: 'FAIL',
          rule: 'NO_ANSWER_IN_CLUES',
          message: `Clue ${i + 1} contains the answer "${answer}"`
        });
      }
    }

    // Aliases/brand names: allowed in Clue 5, FAIL in clues 1-4
    if (!isClue5) {
      for (const alias of aliases) {
        if (alias.length > 3 && clueText.includes(alias.toLowerCase())) {
          // Use word-boundary check to avoid matching alias as substring of another word
          // e.g. "retrovir" inside "antiretroviral" should NOT be flagged
          const escapedAlias = alias.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const wordBoundaryRegex = new RegExp(`\\b${escapedAlias}\\b`, 'i');
          if (!wordBoundaryRegex.test(clueText)) {
            continue; // Alias is embedded inside another word — not a real match
          }

          // Check if this alias (case-insensitive) is whitelisted for this drug
          if (whitelistedAliases.some(wa => alias.toLowerCase().includes(wa) || wa.includes(alias.toLowerCase()))) {
            results.push({
              pass: false,
              severity: 'WARN', // downgrade to WARN for whitelisted aliases
              rule: 'NO_ANSWER_IN_CLUES',
              message: `Clue ${i + 1} contains whitelisted alias "${alias}" (unavoidable in context)`
            });
          } else {
            results.push({
              pass: false,
              severity: 'FAIL',
              rule: 'NO_ANSWER_IN_CLUES',
              message: `Clue ${i + 1} contains alias/brand "${alias}" (only allowed in Clue 5)`
            });
          }
        }
      }
    }
  }
  return results.length > 0 ? results : [{ pass: true, rule: 'NO_ANSWER_IN_CLUES' }];
}

function gradeRule_NoClassNameEarly(puzzle) {
  /** RULE 2: Drug class name should not appear in Clues 1-2 
   *  (narrows too quickly, reduces funnel) */
  const answer = puzzle.answer.toLowerCase();
  
  // Find which class this drug belongs to
  let drugClass = null;
  for (const [cls, members] of Object.entries(CLASS_GROUPS)) {
    if (members.some(m => m.toLowerCase() === answer)) {
      drugClass = cls.toLowerCase();
      break;
    }
  }
  
  if (!drugClass) return [{ pass: true, rule: 'NO_CLASS_NAME_EARLY' }];
  
  const results = [];
  for (let i = 0; i < Math.min(2, puzzle.clues.length); i++) {
    const clueText = puzzle.clues[i].text.toLowerCase();
    if (clueText.includes(drugClass)) {
      results.push({
        pass: false,
        severity: 'WARN',
        rule: 'NO_CLASS_NAME_EARLY',
        message: `Clue ${i + 1} mentions drug class "${drugClass}" - narrows too quickly`
      });
    }
  }
  return results.length > 0 ? results : [{ pass: true, rule: 'NO_CLASS_NAME_EARLY' }];
}

function gradeRule_NoBrandNameBeforeClue5(puzzle) {
  /** RULE 3: Brand names should NOT appear before Clue 5
   *  Exception: For drug_interaction puzzles, co-prescribed drugs (which are NOT the answer)
   *  are allowed in Clues 1-4 since the puzzle is about identifying the interacting drug,
   *  and Clue 2 is literally labelled "Co-prescribed Drugs". */
  const answer = puzzle.answer.toLowerCase();
  const isDrugInteraction = puzzle.type === 'drug_interaction';
  const isAdrCase = puzzle.type === 'adr_case';

  const results = [];
  for (let i = 0; i < Math.min(4, puzzle.clues.length); i++) {
    const clueText = puzzle.clues[i].text.toLowerCase();
    for (const brand of GIVEAWAY_BRANDS) {
      if (clueText.includes(brand)) {
        const brandIsAnswer = (brand === answer || (puzzle.aliases || []).some(a => a.toLowerCase() === brand));
        // GIVEAWAY_BRANDS only matter if the brand IS the answer drug
        // Mentioning other well-known drugs (e.g. metformin in a sitagliptin puzzle) is legitimate context
        if (!brandIsAnswer) {
          continue; // Not the answer drug — allowed in any puzzle type
        }
        results.push({
          pass: false,
          severity: 'FAIL',
          rule: 'NO_BRAND_BEFORE_CLUE5',
          message: `Clue ${i + 1} contains brand name "${brand}" (only allowed in Clue 5)`
        });
      }
    }
    // Also check puzzle aliases (which include brand names)
    const whitelistedAliases = (ALIAS_WHITELIST[answer] || []).map(a => a.toLowerCase());
    for (const alias of (puzzle.aliases || [])) {
      if (alias.length > 3 && clueText.toLowerCase().includes(alias.toLowerCase())) {
        // Word-boundary check: don't match alias embedded inside another word
        // e.g. "Retrovir" inside "antiretroviral" should NOT be flagged
        const escapedAlias = alias.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const wordBoundaryRegex = new RegExp(`\\b${escapedAlias}\\b`, 'i');
        if (!wordBoundaryRegex.test(clueText)) {
          continue; // Alias is embedded inside another word — not a real match
        }

        // Skip if this alias is whitelisted (unavoidable in pharmacological context)
        if (whitelistedAliases.some(wa => alias.toLowerCase().includes(wa) || wa.includes(alias.toLowerCase()))) {
          continue; // Whitelisted alias — already caught by Rule 1 as WARN
        }
        results.push({
          pass: false,
          severity: 'FAIL',
          rule: 'NO_BRAND_BEFORE_CLUE5',
          message: `Clue ${i + 1} contains alias/brand "${alias}" (only allowed in Clue 5)`
        });
      }
    }
  }
  return results.length > 0 ? results : [{ pass: true, rule: 'NO_BRAND_BEFORE_CLUE5' }];
}

function gradeRule_NoCYPBeforeClue3(puzzle) {
  /** RULE 4: CYP enzyme references shouldn't appear before Clue 3 */
  const results = [];
  for (let i = 0; i < Math.min(2, puzzle.clues.length); i++) {
    const clueText = puzzle.clues[i].text.toLowerCase();
    for (const cyp of CYP_ENZYMES) {
      if (clueText.includes(cyp)) {
        results.push({
          pass: false,
          severity: 'WARN',
          rule: 'NO_CYP_BEFORE_CLUE3',
          message: `Clue ${i + 1} mentions "${cyp}" - too specific for early clue`
        });
      }
    }
  }
  return results.length > 0 ? results : [{ pass: true, rule: 'NO_CYP_BEFORE_CLUE3' }];
}

function gradeRule_ProgressiveNarrowing(puzzle) {
  /** RULE 5: Clues should progressively narrow. Check for:
   *  - Clue 1 should be broad (system/presentation level)
   *  - Clue 5 should be highly specific
   *  - No clue should be MORE broad than the previous one */
  
  // Heuristic: later clues should be more specific (shorter, more technical)
  const clues = puzzle.clues;
  if (clues.length < 5) {
    return [{
      pass: false,
      severity: 'FAIL',
      rule: 'PROGRESSIVE_NARROWING',
      message: `Only ${clues.length} clues (need exactly 5)`
    }];
  }
  
  // Check clue 1 isn't too specific
  const clue1 = clues[0].text.toLowerCase();
  const answer = puzzle.answer.toLowerCase();
  const isDrugInteraction = puzzle.type === 'drug_interaction';
  const isAdrCase = puzzle.type === 'adr_case';
  const answerAliases = (puzzle.aliases || []).map(a => a.toLowerCase());
  // CYP enzymes are always too specific for Clue 1
  for (const cyp of CYP_ENZYMES) {
    if (clue1.includes(cyp)) {
      return [{
        pass: false,
        severity: 'FAIL',
        rule: 'PROGRESSIVE_NARROWING',
        message: `Clue 1 contains specific term "${cyp}" - should be broad`
      }];
    }
  }
  // GIVEAWAY_BRANDS in Clue 1 only matter if it's a brand of the ANSWER drug
  // (mentioning other drugs like "combination with metformin" is legitimate context)
  for (const brand of GIVEAWAY_BRANDS) {
    if (clue1.includes(brand)) {
      const brandIsAnswer = (brand === answer || answerAliases.includes(brand));
      if (!brandIsAnswer) continue; // Other drug mentioned as context — fine
      return [{
        pass: false,
        severity: 'FAIL',
        rule: 'PROGRESSIVE_NARROWING',
        message: `Clue 1 contains specific term "${brand}" - should be broad`
      }];
    }
  }
  
  return [{ pass: true, rule: 'PROGRESSIVE_NARROWING' }];
}

function gradeRule_ClueLength(puzzle) {
  /** RULE 6: Each clue should be 15-80 words. Too short = vague, too long = convoluted */
  const results = [];
  for (let i = 0; i < puzzle.clues.length; i++) {
    const words = puzzle.clues[i].text.trim().split(/\s+/).length;
    if (words < 10) {
      results.push({
        pass: false,
        severity: 'WARN',
        rule: 'CLUE_LENGTH',
        message: `Clue ${i + 1} too short (${words} words, min 10)`
      });
    }
    if (words > 80) {
      results.push({
        pass: false,
        severity: 'WARN',
        rule: 'CLUE_LENGTH',
        message: `Clue ${i + 1} too long (${words} words, max 80)`
      });
    }
  }
  return results.length > 0 ? results : [{ pass: true, rule: 'CLUE_LENGTH' }];
}

function gradeRule_NoRedundancy(puzzle) {
  /** RULE 7: Clues should not repeat the same information */
  const results = [];
  const clueTexts = puzzle.clues.map(c => c.text.toLowerCase());
  
  for (let i = 0; i < clueTexts.length; i++) {
    for (let j = i + 1; j < clueTexts.length; j++) {
      // Check for significant overlap (shared 4+ word phrases)
      const words_i = clueTexts[i].split(/\s+/);
      const words_j = clueTexts[j].split(/\s+/);
      
      for (let k = 0; k < words_i.length - 3; k++) {
        const phrase = words_i.slice(k, k + 4).join(' ');
        if (phrase.length > 15 && clueTexts[j].includes(phrase)) {
          results.push({
            pass: false,
            severity: 'WARN',
            rule: 'NO_REDUNDANCY',
            message: `Clues ${i + 1} and ${j + 1} share phrase: "${phrase}"`
          });
          break;
        }
      }
    }
  }
  return results.length > 0 ? results : [{ pass: true, rule: 'NO_REDUNDANCY' }];
}

function gradeRule_HasExplanation(puzzle) {
  /** RULE 8: Every puzzle must have a non-empty explanation */
  if (!puzzle.explanation || puzzle.explanation.trim().length < 20) {
    return [{
      pass: false,
      severity: 'FAIL',
      rule: 'HAS_EXPLANATION',
      message: 'Missing or too-short explanation (min 20 chars)'
    }];
  }
  return [{ pass: true, rule: 'HAS_EXPLANATION' }];
}

function gradeRule_HasCorrectLabels(puzzle) {
  /** RULE 9: Clue labels must match the puzzle type */
  const typeLabels = {
    'drug_id': ['Clinical Context', 'Key Feature', 'Pharmacology Clue', 'Narrowing Detail', 'Identifying Detail'],
    'adr_case': ['Patient Presentation', 'Investigations', 'Key Finding', 'Drug Clue', 'Identifying Detail'],
    'drug_interaction': ['Clinical Scenario', 'Co-prescribed Drugs', 'Interaction Effect', 'Mechanism Clue', 'Identifying Detail'],
    'mixed_profile': ['Clinical Context', 'Pharmacology Clue', 'Key Feature', 'Narrowing Detail', 'Identifying Detail'],
  };
  
  const expectedLabels = typeLabels[puzzle.type];
  if (!expectedLabels) {
    return [{
      pass: false,
      severity: 'FAIL',
      rule: 'CORRECT_LABELS',
      message: `Unknown puzzle type: "${puzzle.type}"`
    }];
  }
  
  const actualLabels = puzzle.clues.map(c => c.label);
  const mismatch = actualLabels.some((l, i) => l !== expectedLabels[i]);
  
  if (mismatch) {
    return [{
      pass: false,
      severity: 'WARN',
      rule: 'CORRECT_LABELS',
      message: `Labels don't match type "${puzzle.type}". Expected: ${expectedLabels.join(', ')}. Got: ${actualLabels.join(', ')}`
    }];
  }
  return [{ pass: true, rule: 'CORRECT_LABELS' }];
}

function gradeRule_ValidStructure(puzzle) {
  /** RULE 10: Puzzle must have all required fields */
  const required = ['id', 'answer', 'category', 'type', 'difficulty', 'clues', 'explanation'];
  const missing = required.filter(f => !puzzle[f]);
  
  if (missing.length > 0) {
    return [{
      pass: false,
      severity: 'FAIL',
      rule: 'VALID_STRUCTURE',
      message: `Missing required fields: ${missing.join(', ')}`
    }];
  }
  
  if (!puzzle.aliases || !Array.isArray(puzzle.aliases)) {
    return [{
      pass: false,
      severity: 'WARN',
      rule: 'VALID_STRUCTURE',
      message: 'Missing aliases array'
    }];
  }
  
  if (!puzzle.acceptable_alternatives) {
    return [{
      pass: false,
      severity: 'WARN',
      rule: 'VALID_STRUCTURE',
      message: 'Missing acceptable_alternatives field (needed for three-tier system)'
    }];
  }
  
  if (!puzzle.near_misses) {
    return [{
      pass: false,
      severity: 'WARN',
      rule: 'VALID_STRUCTURE',
      message: 'Missing near_misses field (needed for three-tier system)'
    }];
  }
  
  return [{ pass: true, rule: 'VALID_STRUCTURE' }];
}

function gradeRule_NoVagueClues(puzzle) {
  /** RULE 11: Clues shouldn't use vague/generic filler language */
  const results = [];
  for (let i = 0; i < puzzle.clues.length; i++) {
    const clueText = puzzle.clues[i].text.toLowerCase();
    for (const vague of VAGUE_TERMS) {
      if (clueText.includes(vague)) {
        results.push({
          pass: false,
          severity: 'WARN',
          rule: 'NO_VAGUE_CLUES',
          message: `Clue ${i + 1} uses vague term "${vague}"`
        });
      }
    }
  }
  return results.length > 0 ? results : [{ pass: true, rule: 'NO_VAGUE_CLUES' }];
}

function gradeRule_AcceptableAlternativesNotTooMany(puzzle) {
  /** RULE 12: Cap acceptable alternatives at 3. More = bad puzzle. */
  const alts = puzzle.acceptable_alternatives || [];
  if (alts.length > 3) {
    return [{
      pass: false,
      severity: 'FAIL',
      rule: 'MAX_ALTERNATIVES',
      message: `${alts.length} acceptable alternatives (max 3) - puzzle needs better distinguishing clues`
    }];
  }
  return [{ pass: true, rule: 'MAX_ALTERNATIVES' }];
}

// ========== MAIN GRADING FUNCTION ==========

function gradePuzzle(puzzle) {
  const allResults = [];
  
  const rules = [
    gradeRule_ValidStructure,
    gradeRule_NoAnswerInClues,
    gradeRule_NoClassNameEarly,
    gradeRule_NoBrandNameBeforeClue5,
    gradeRule_NoCYPBeforeClue3,
    gradeRule_ProgressiveNarrowing,
    gradeRule_ClueLength,
    gradeRule_NoRedundancy,
    gradeRule_HasExplanation,
    gradeRule_HasCorrectLabels,
    gradeRule_NoVagueClues,
    gradeRule_AcceptableAlternativesNotTooMany,
  ];
  
  for (const rule of rules) {
    const results = rule(puzzle);
    allResults.push(...results);
  }
  
  const fails = allResults.filter(r => !r.pass && r.severity === 'FAIL');
  const warns = allResults.filter(r => !r.pass && r.severity === 'WARN');
  const passes = allResults.filter(r => r.pass);
  
  let grade;
  if (fails.length > 0) {
    grade = 'POOR';
  } else if (warns.length >= 3) {
    grade = 'NEEDS_WORK';
  } else if (warns.length > 0) {
    grade = 'ACCEPTABLE';
  } else {
    grade = 'GOOD';
  }
  
  return {
    puzzleId: puzzle.id,
    answer: puzzle.answer,
    grade,
    fails: fails.length,
    warns: warns.length,
    passes: passes.length,
    issues: allResults.filter(r => !r.pass),
    allResults,
  };
}

// ========== BATCH GRADING ==========

function gradeBatch(puzzles) {
  loadReferenceData();
  
  const results = puzzles.map(p => gradePuzzle(p));
  
  const summary = {
    total: results.length,
    good: results.filter(r => r.grade === 'GOOD').length,
    acceptable: results.filter(r => r.grade === 'ACCEPTABLE').length,
    needsWork: results.filter(r => r.grade === 'NEEDS_WORK').length,
    poor: results.filter(r => r.grade === 'POOR').length,
  };
  
  return { summary, results };
}

module.exports = { gradePuzzle, gradeBatch, loadReferenceData };

// CLI usage
if (require.main === module) {
  const inputFile = process.argv[2];
  if (!inputFile) {
    console.error('Usage: node pharmodle-auto-grader.js <puzzles.json>');
    process.exit(1);
  }
  
  const puzzles = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const { summary, results } = gradeBatch(Array.isArray(puzzles) ? puzzles : puzzles.puzzles || [puzzles]);
  
  console.log('\n=== AUTO-GRADE SUMMARY ===');
  console.log(`Total: ${summary.total}`);
  console.log(`GOOD: ${summary.good} (${(summary.good/summary.total*100).toFixed(0)}%)`);
  console.log(`ACCEPTABLE: ${summary.acceptable} (${(summary.acceptable/summary.total*100).toFixed(0)}%)`);
  console.log(`NEEDS WORK: ${summary.needsWork} (${(summary.needsWork/summary.total*100).toFixed(0)}%)`);
  console.log(`POOR: ${summary.poor} (${(summary.poor/summary.total*100).toFixed(0)}%)`);
  
  console.log('\n=== ISSUES ===');
  for (const r of results) {
    if (r.grade !== 'GOOD') {
      console.log(`\n[${r.grade}] #${r.puzzleId}: ${r.answer}`);
      for (const issue of r.issues) {
        console.log(`  ${issue.severity}: ${issue.message}`);
      }
    }
  }
  
  // Save full results
  const outputFile = inputFile.replace('.json', '-graded.json');
  fs.writeFileSync(outputFile, JSON.stringify({ summary, results }, null, 2));
  console.log(`\nFull results saved to: ${outputFile}`);
}
