/**
 * Physiodle Review Inspector
 *
 * After running review-puzzles.js, use this to browse flagged puzzles,
 * compare original vs AI-suggested rewrites, and selectively apply changes.
 *
 * Usage:
 *   node inspect-reviews.js              → show all flagged puzzles
 *   node inspect-reviews.js --poor       → show only 'poor' quality
 *   node inspect-reviews.js --major      → show only major severity issues
 *   node inspect-reviews.js --category="Knee" → filter by category
 *   node inspect-reviews.js --stats      → summary stats only
 */

const fs = require('fs');
const path = require('path');

const REVIEWS_FILE = path.join(__dirname, 'data', 'reviews.json');
const PUZZLES_FILE = path.join(__dirname, 'data', 'puzzles.json');
const UPDATED_FILE = path.join(__dirname, 'data', 'puzzles.updated.json');

function main() {
  const args = process.argv.slice(2);
  const showStats = args.includes('--stats');
  const poorOnly = args.includes('--poor');
  const majorOnly = args.includes('--major');
  const catArg = args.find(a => a.startsWith('--category='));
  const category = catArg ? catArg.split('=')[1] : null;

  const reviews = JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));
  const originalPuzzles = JSON.parse(fs.readFileSync(PUZZLES_FILE, 'utf8')).puzzles;

  const allReviews = Object.values(reviews).filter(r => !r.error);

  // ─── Stats ────────────────────────────────────────────────────────────────
  const byQuality = {
    good: allReviews.filter(r => r.overall_quality === 'good').length,
    needs_work: allReviews.filter(r => r.overall_quality === 'needs_work').length,
    poor: allReviews.filter(r => r.overall_quality === 'poor').length,
  };

  const issueTypes = {};
  allReviews.forEach(r => {
    if (!r.clues) return;
    r.clues.forEach(c => {
      if (c.issues) c.issues.forEach(issue => {
        issueTypes[issue] = (issueTypes[issue] || 0) + 1;
      });
    });
  });

  const errors = Object.values(reviews).filter(r => r.error).length;

  console.log(`\n📊 Physiodle Review Stats`);
  console.log(`   Total reviewed: ${allReviews.length} (${errors} errors)`);
  console.log(`   ✓ Good:         ${byQuality.good}`);
  console.log(`   ~ Needs work:   ${byQuality.needs_work}`);
  console.log(`   ✗ Poor:         ${byQuality.poor}`);
  console.log('');
  console.log(`   Issues breakdown:`);
  Object.entries(issueTypes)
    .sort((a, b) => b[1] - a[1])
    .forEach(([type, count]) => {
      console.log(`   ${type.padEnd(20)} ${count}`);
    });

  if (showStats) return;

  // ─── Filter ───────────────────────────────────────────────────────────────
  let filtered = allReviews;

  if (poorOnly) filtered = filtered.filter(r => r.overall_quality === 'poor');
  if (majorOnly) filtered = filtered.filter(r =>
    r.clues && r.clues.some(c => c.severity === 'major')
  );
  if (category) filtered = filtered.filter(r =>
    r.category && r.category.toLowerCase().includes(category.toLowerCase())
  );

  // Only show ones that actually have issues
  filtered = filtered.filter(r => r.overall_quality !== 'good');

  console.log(`\n📋 Showing ${filtered.length} flagged puzzles:\n`);
  console.log('='.repeat(70));

  filtered.forEach((r, idx) => {
    const original = originalPuzzles[r.index];

    console.log(`\n[${idx + 1}/${filtered.length}] ${r.answer} (${r.category})`);
    console.log(`Quality: ${r.overall_quality.toUpperCase()}`);
    if (r.notes) console.log(`Notes: ${r.notes}`);
    console.log('');

    if (r.clues) {
      r.clues.forEach(c => {
        const label = `  C${c.index + 1} (${c.label})`;
        const originalText = original?.clues?.[c.index]?.text || '(not found)';

        if (c.severity === 'ok') {
          console.log(`${label}: ✓ OK`);
        } else {
          const issueStr = c.issues?.join(', ') || 'flagged';
          console.log(`${label}: [${c.severity.toUpperCase()}] ${issueStr}`);
          console.log(`    ORIGINAL: "${originalText}"`);
          if (c.rewrite) {
            console.log(`    REWRITE:  "${c.rewrite}"`);
          }
        }
      });
    }
    console.log('-'.repeat(70));
  });

  console.log(`\n💡 To apply all AI rewrites, run:`);
  console.log(`   cp data/puzzles.updated.json data/puzzles.json`);
  console.log(`\n💡 To selectively apply changes, edit data/puzzles.json directly`);
  console.log(`   using the rewrites shown above as a reference.\n`);
}

main();
