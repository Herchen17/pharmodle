#!/usr/bin/env node
/**
 * Smart Puzzle Shuffler for Physiodle
 *
 * Reorders puzzles.json so that similar puzzles are spaced at least
 * MIN_GAP days apart. "Similar" means:
 *   1. Same category (e.g., two Knee puzzles)
 *   2. Same answer stem (e.g., "ACL Tear" and "Post-ACL Reconstruction")
 *
 * Algorithm:
 *   - Build similarity groups (category + answer-word overlap)
 *   - Use a greedy scheduler: for each slot, pick the puzzle whose similarity
 *     groups have the longest time since last used
 *   - Preserves puzzles already played (days 1 through currentDay) in their
 *     existing order, only reshuffles future puzzles
 *
 * Usage:
 *   node shuffle-puzzles.js [--min-gap 50] [--dry-run] [--preserve-days 10]
 *
 * Options:
 *   --min-gap N        Minimum days between similar puzzles (default: 50)
 *   --preserve-days N  Don't touch the first N puzzles (already played)
 *   --dry-run          Show report without saving
 */

const fs = require('fs');
const path = require('path');

// ── Parse args ──
const args = process.argv.slice(2);
function getArg(name, def) {
  const idx = args.indexOf('--' + name);
  return idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1]) : def;
}
const MIN_GAP = getArg('min-gap', 50);
const PRESERVE_DAYS = getArg('preserve-days', 0);
const DRY_RUN = args.includes('--dry-run');

// ── Load puzzles ──
const filePath = path.join(__dirname, 'data', 'puzzles.json');
const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const allPuzzles = raw.puzzles || raw;

console.log(`Loaded ${allPuzzles.length} puzzles`);
console.log(`Preserving first ${PRESERVE_DAYS} puzzles, reshuffling the rest`);
console.log(`Minimum gap between similar puzzles: ${MIN_GAP} days`);

// ── Split into preserved and shuffleable ──
const preserved = allPuzzles.slice(0, PRESERVE_DAYS);
const toShuffle = allPuzzles.slice(PRESERVE_DAYS);

// ── Build similarity groups ──
function getGroups(puzzle) {
  const groups = new Set();

  // Group by category (normalized)
  if (puzzle.category) {
    groups.add('cat:' + puzzle.category.toLowerCase().replace(/[^a-z]/g, ''));
  }

  // Group by significant answer words (>3 chars)
  const words = puzzle.answer.toLowerCase()
    .replace(/[''()-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .filter(w => !['post', 'acute', 'chronic', 'syndrome', 'disease', 'disorder', 'injury', 'type'].includes(w));

  words.forEach(w => groups.add('word:' + w));

  // Group by domain if available
  if (puzzle.domain) {
    groups.add('dom:' + puzzle.domain.toLowerCase().replace(/[^a-z]/g, ''));
  }

  return groups;
}

// ── Greedy scheduler ──
// For each slot, pick the puzzle whose groups have the longest minimum time since last seen
function greedyShuffle(puzzles, minGap, preservedGroups) {
  const remaining = [...puzzles];
  const scheduled = [];

  // Track last-seen day for each group
  // Initialize with preserved puzzles
  const lastSeen = {};
  preservedGroups.forEach((groups, dayIdx) => {
    groups.forEach(g => {
      lastSeen[g] = dayIdx; // 0-indexed from start
    });
  });

  const startIdx = preservedGroups.length;

  for (let slot = 0; slot < puzzles.length; slot++) {
    const currentIdx = startIdx + slot;

    let bestPuzzle = null;
    let bestScore = -Infinity;
    let bestIdx = 0;

    for (let i = 0; i < remaining.length; i++) {
      const p = remaining[i];
      const groups = getGroups(p);

      // Score = minimum distance from any of this puzzle's groups to their last occurrence
      let minDist = Infinity;
      groups.forEach(g => {
        if (lastSeen[g] !== undefined) {
          const dist = currentIdx - lastSeen[g];
          minDist = Math.min(minDist, dist);
        }
      });

      // If no group has been seen, distance is infinity (best case)
      if (minDist === Infinity) minDist = 9999;

      // Secondary tiebreaker: prefer different difficulty from recent
      const score = minDist;

      if (score > bestScore) {
        bestScore = score;
        bestPuzzle = p;
        bestIdx = i;
      }
    }

    // Place the best puzzle
    scheduled.push(bestPuzzle);
    remaining.splice(bestIdx, 1);

    // Update lastSeen
    getGroups(bestPuzzle).forEach(g => {
      lastSeen[g] = currentIdx;
    });
  }

  return scheduled;
}

// ── Build preserved groups map ──
const preservedGroups = preserved.map(p => getGroups(p));

// ── First pass: random shuffle to break original ordering ──
for (let i = toShuffle.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [toShuffle[i], toShuffle[j]] = [toShuffle[j], toShuffle[i]];
}

// ── Run greedy scheduler ──
console.log('\nRunning greedy scheduler...');
const shuffled = greedyShuffle(toShuffle, MIN_GAP, preservedGroups);

// ── Validate and report ──
const finalOrder = [...preserved, ...shuffled];

// Reassign IDs to match new order
finalOrder.forEach((p, i) => { p.id = i + 1; });

// Check for violations
let violations = 0;
const groupLastDay = {};
const violationDetails = [];

finalOrder.forEach((p, day) => {
  const groups = getGroups(p);
  groups.forEach(g => {
    if (groupLastDay[g] !== undefined) {
      const gap = day - groupLastDay[g];
      if (gap < MIN_GAP && g.startsWith('cat:')) {
        violations++;
        if (violationDetails.length < 20) {
          violationDetails.push(`Day ${day+1} "${p.answer}" ↔ Day ${groupLastDay[g]+1} (${g}, gap=${gap})`);
        }
      }
    }
    groupLastDay[g] = day;
  });
});

console.log(`\nResults:`);
console.log(`  Total puzzles: ${finalOrder.length}`);
console.log(`  Category gap violations (<${MIN_GAP} days): ${violations}`);
if (violationDetails.length > 0) {
  console.log(`  Some violations (unavoidable when categories have many puzzles):`);
  violationDetails.forEach(v => console.log(`    ${v}`));
}

// ── Category distribution check ──
const catCounts = {};
finalOrder.forEach(p => {
  const c = p.category || 'Unknown';
  catCounts[c] = (catCounts[c] || 0) + 1;
});
const bigCats = Object.entries(catCounts).filter(([, v]) => v > MIN_GAP).sort((a, b) => b[1] - a[1]);
if (bigCats.length > 0) {
  console.log(`\n  Categories with >${MIN_GAP} puzzles (impossible to avoid some violations):`);
  bigCats.forEach(([cat, count]) => {
    const maxGap = Math.floor(finalOrder.length / count);
    console.log(`    ${cat}: ${count} puzzles (max achievable gap: ~${maxGap} days)`);
  });
}

// ── Difficulty distribution per 30-day window ──
console.log(`\n  Difficulty distribution (per 30-day window):`);
for (let start = 0; start < Math.min(finalOrder.length, 180); start += 30) {
  const window = finalOrder.slice(start, start + 30);
  const easy = window.filter(p => p.difficulty === 'easy').length;
  const medium = window.filter(p => p.difficulty === 'medium').length;
  const hard = window.filter(p => p.difficulty === 'hard').length;
  console.log(`    Days ${start+1}-${start+30}: Easy=${easy} Medium=${medium} Hard=${hard}`);
}

// ── Save ──
if (!DRY_RUN) {
  // Backup original
  const backupPath = filePath.replace('.json', `.backup-${Date.now()}.json`);
  fs.copyFileSync(filePath, backupPath);
  console.log(`\n  Backed up original to ${backupPath}`);

  // Write new order
  const output = raw.puzzles ? { ...raw, puzzles: finalOrder } : finalOrder;
  if (output.metadata) {
    output.metadata.shuffled_date = new Date().toISOString().split('T')[0];
    output.metadata.min_gap = MIN_GAP;
    output.metadata.preserved_days = PRESERVE_DAYS;
  }
  fs.writeFileSync(filePath, JSON.stringify(output, null, 2));
  console.log(`  Saved shuffled puzzles to ${filePath}`);
} else {
  console.log(`\n  DRY RUN — no changes saved. Remove --dry-run to apply.`);
}
