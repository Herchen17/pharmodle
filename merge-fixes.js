/**
 * Merge Fixes
 *
 * Combines the outputs of fix-minor.js and fix-rework.js into a single
 * final puzzles file ready for deployment.
 *
 * Priority order:
 *   1. Rework-fixed puzzles (data/puzzles.rework-fixed.json)
 *   2. Minor-fixed puzzles (data/puzzles.minor-fixed.json)
 *   3. Updated puzzles that were already READY (data/puzzles.updated.json)
 *
 * Usage:
 *   node merge-fixes.js
 */

const fs = require('fs');
const path = require('path');

const UPDATED_FILE     = path.join(__dirname, 'data', 'puzzles.updated.json');
const MINOR_FIXED_FILE = path.join(__dirname, 'data', 'puzzles.minor-fixed.json');
const REWORK_FIXED_FILE= path.join(__dirname, 'data', 'puzzles.rework-fixed.json');
const BATCH_FILE       = path.join(__dirname, 'data', 'batch-reviews.json');
const OUTPUT_FILE      = path.join(__dirname, 'data', 'puzzles.final.json');

console.log('\n🔗 Merging fixed puzzles...\n');

// Load base (updated from Run 1)
const baseData = JSON.parse(fs.readFileSync(UPDATED_FILE, 'utf8'));
const totalPuzzles = baseData.puzzles.length;

// Load batch reviews to know categories
const batchReviews = JSON.parse(fs.readFileSync(BATCH_FILE, 'utf8'));

// Try loading fix outputs
let minorData = null, reworkData = null;

try {
  minorData = JSON.parse(fs.readFileSync(MINOR_FIXED_FILE, 'utf8'));
  console.log(`  ✓ Minor fixes loaded (${MINOR_FIXED_FILE})`);
} catch {
  console.log(`  ⚠ No minor fixes file found — skipping`);
}

try {
  reworkData = JSON.parse(fs.readFileSync(REWORK_FIXED_FILE, 'utf8'));
  console.log(`  ✓ Rework fixes loaded (${REWORK_FIXED_FILE})`);
} catch {
  console.log(`  ⚠ No rework fixes file found — skipping`);
}

// Build final output starting from base
const finalData = JSON.parse(JSON.stringify(baseData));

let readyCount = 0, minorMerged = 0, reworkMerged = 0, unchanged = 0;

for (let i = 0; i < totalPuzzles; i++) {
  // Check if rework-fixed version exists and has updated clues
  if (reworkData && reworkData.puzzles[i] && reworkData.puzzles[i]._reworked) {
    finalData.puzzles[i].clues = reworkData.puzzles[i].clues;
    finalData.puzzles[i]._source = 'rework-fixed';
    reworkMerged++;
    continue;
  }

  // Check if minor-fixed version exists and has updated clues
  if (minorData && minorData.puzzles[i] && (minorData.puzzles[i]._minorFixed || minorData.puzzles[i]._minor_fixed)) {
    finalData.puzzles[i].clues = minorData.puzzles[i].clues;
    finalData.puzzles[i]._source = 'minor-fixed';
    minorMerged++;
    continue;
  }

  // Otherwise keep the updated (Run 1) version
  const key = Object.keys(batchReviews).find(k => batchReviews[k].globalIndex === i);
  if (key && batchReviews[key].verdict === 'READY') {
    finalData.puzzles[i]._source = 'ready';
    readyCount++;
  } else {
    finalData.puzzles[i]._source = 'unchanged';
    unchanged++;
  }
}

// Clean up internal markers before saving
finalData.puzzles.forEach(p => {
  delete p._reworked;
  delete p._minorFixed;
  delete p._source;
});

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalData, null, 2));

console.log('\n' + '═'.repeat(50));
console.log('📦 MERGE COMPLETE');
console.log('═'.repeat(50));
console.log(`  Already READY:    ${readyCount}`);
console.log(`  Minor-fixed:      ${minorMerged}`);
console.log(`  Rework-fixed:     ${reworkMerged}`);
console.log(`  Unchanged/other:  ${unchanged}`);
console.log(`  Total:            ${totalPuzzles}`);
console.log(`\n  Output: data/puzzles.final.json`);
console.log('');

// Optionally copy to puzzles.json for deployment
const args = process.argv.slice(2);
if (args.includes('--deploy')) {
  const deployFile = path.join(__dirname, 'data', 'puzzles.json');
  fs.copyFileSync(OUTPUT_FILE, deployFile);
  console.log('🚀 Copied to data/puzzles.json (ready for deployment)');
  console.log('');
}
