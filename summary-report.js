/**
 * Physiodle Review Pipeline — Summary Report
 *
 * Generates a comprehensive text + HTML summary of Run 1 (Clue Review) progress.
 * Shows overall stats, quality breakdown, POOR puzzles, most common issues, etc.
 *
 * Usage:
 *   node summary-report.js              → console output + generates data/summary-report.html
 *   node summary-report.js --open       → also opens in browser on Mac
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REVIEWS_FILE  = path.join(__dirname, 'data', 'reviews.json');
const PROGRESS_FILE = path.join(__dirname, 'data', '.review_progress.json');
const REPORT_FILE   = path.join(__dirname, 'data', 'summary-report.html');

// Load data
try {
  var reviews       = JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));
  var progress      = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
} catch (e) {
  console.error('❌ Could not load review data. Is the review still running?');
  process.exit(1);
}

const allReviews  = Object.values(reviews);
const validReviews = allReviews.filter(r => !r.error && r.clues);
const errorReviews = allReviews.filter(r => r.error);

const completed   = validReviews.length;
const errors      = errorReviews.length;
const total       = progress.lastIndex + 1;
const remaining   = 775 - total;

// Quality breakdown
const good        = validReviews.filter(r => r.overall_quality === 'good').length;
const needsWork   = validReviews.filter(r => r.overall_quality === 'needs_work').length;
const poor        = validReviews.filter(r => r.overall_quality === 'poor').length;

// Rewrite stats
const rewritten   = validReviews.filter(r => r.clues && r.clues.some(c => c.rewrite)).length;
const totalIssues = validReviews.reduce((sum, r) => {
  return sum + (r.clues ? r.clues.filter(c => c.severity !== 'ok').length : 0);
}, 0);

// Issue breakdown
const issueTypes = {};
validReviews.forEach(r => {
  if (!r.clues) return;
  r.clues.forEach(c => {
    if (c.issues) {
      c.issues.forEach(issue => {
        issueTypes[issue] = (issueTypes[issue] || 0) + 1;
      });
    }
  });
});

// Clue severity breakdown
const clueSeverity = { ok: 0, minor: 0, major: 0 };
validReviews.forEach(r => {
  if (!r.clues) return;
  r.clues.forEach(c => {
    clueSeverity[c.severity] = (clueSeverity[c.severity] || 0) + 1;
  });
});

// Category breakdown
const byCategory = {};
validReviews.forEach(r => {
  byCategory[r.category] = (byCategory[r.category] || 0) + 1;
});

// Poor puzzles
const poorPuzzles = validReviews.filter(r => r.overall_quality === 'poor');

// ─── Console output ────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(70));
console.log('🦴 PHYSIODLE PUZZLE REVIEW — RUN 1 SUMMARY');
console.log('═'.repeat(70));

console.log('\n📊 OVERALL PROGRESS');
console.log('─'.repeat(70));
console.log(`  Reviewed:     ${completed} / 775 (${(completed * 100 / 775).toFixed(1)}%)`);
console.log(`  Remaining:    ${remaining}`);
console.log(`  Errors:       ${errors}`);
if (remaining > 0) {
  const avgPerMin = completed / ((Date.now() - fs.statSync(PROGRESS_FILE).mtimeMs) / 60000);
  const etaMins = Math.ceil(remaining / avgPerMin);
  console.log(`  ETA:          ~${etaMins} minutes`);
}

console.log('\n📈 QUALITY BREAKDOWN');
console.log('─'.repeat(70));
console.log(`  ✓ Good:           ${good} (${(good * 100 / completed).toFixed(1)}%)`);
console.log(`  ~ Needs Work:     ${needsWork} (${(needsWork * 100 / completed).toFixed(1)}%)`);
console.log(`  ✗ Poor:           ${poor} (${(poor * 100 / completed).toFixed(1)}%)`);

console.log('\n🔧 REWRITE SUMMARY');
console.log('─'.repeat(70));
console.log(`  Puzzles rewritten:  ${rewritten} / ${completed} (${(rewritten * 100 / completed).toFixed(1)}%)`);
console.log(`  Total issue flags:  ${totalIssues} across all clues`);
console.log(`  Avg issues/puzzle:  ${(totalIssues / completed).toFixed(1)}`);

console.log('\n🎯 CLUE SEVERITY BREAKDOWN');
console.log('─'.repeat(70));
console.log(`  OK (no changes):    ${clueSeverity.ok} clues`);
console.log(`  Minor issues:       ${clueSeverity.minor} clues (${(clueSeverity.minor * 100 / (clueSeverity.ok + clueSeverity.minor + clueSeverity.major)).toFixed(1)}%)`);
console.log(`  Major issues:       ${clueSeverity.major} clues (${(clueSeverity.major * 100 / (clueSeverity.ok + clueSeverity.minor + clueSeverity.major)).toFixed(1)}%)`);

console.log('\n🚩 TOP ISSUE TYPES');
console.log('─'.repeat(70));
Object.entries(issueTypes)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8)
  .forEach(([type, count]) => {
    const pct = (count * 100 / totalIssues).toFixed(1);
    console.log(`  ${type.padEnd(20)} ${count.toString().padStart(3)} issues (${pct}%)`);
  });

console.log('\n📍 TOP CATEGORIES BY PUZZLE COUNT');
console.log('─'.repeat(70));
Object.entries(byCategory)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .forEach(([cat, count]) => {
    console.log(`  ${cat.padEnd(35)} ${count} puzzles`);
  });

if (poorPuzzles.length > 0) {
  console.log('\n⚠️  POOR QUALITY PUZZLES (' + poorPuzzles.length + ')');
  console.log('─'.repeat(70));
  poorPuzzles.slice(0, 20).forEach(r => {
    console.log(`  ${r.index + 1}. ${r.answer.padEnd(40)} (${r.category})`);
    if (r.notes) console.log(`     ${r.notes.slice(0, 120)}`);
  });
  if (poorPuzzles.length > 20) {
    console.log(`  ... and ${poorPuzzles.length - 20} more (see HTML report)`);
  }
}

console.log('\n' + '═'.repeat(70));
console.log(`📄 HTML Report: data/summary-report.html`);
console.log('═'.repeat(70) + '\n');

// ─── HTML Report ───────────────────────────────────────────────────────────────

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const issueChart = Object.entries(issueTypes)
  .sort((a, b) => b[1] - a[1])
  .map(([type, count]) => `
    <div style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <span style="font-size:13px;color:#374151">${escHtml(type)}</span>
        <span style="font-weight:600;color:#0d9488">${count}</span>
      </div>
      <div style="height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden">
        <div style="height:100%;background:#0d9488;width:${(count * 100 / totalIssues)}%"></div>
      </div>
    </div>
  `).join('');

const categoryChart = Object.entries(byCategory)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12)
  .map(([cat, count]) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#374151">${escHtml(cat)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600;color:#0d9488">${count}</td>
    </tr>
  `).join('');

const poorPuzzlesHtml = poorPuzzles.map(r => `
  <div style="padding:12px;border-bottom:1px solid #fee2e2;border-left:3px solid #dc2626">
    <div style="font-weight:600;color:#991b1b;margin-bottom:4px">${r.index + 1}. ${escHtml(r.answer)}</div>
    <div style="font-size:12px;color:#6b7280;margin-bottom:6px">${escHtml(r.category)}</div>
    ${r.notes ? `<div style="font-size:12px;color:#374151;font-style:italic;line-height:1.4">${escHtml(r.notes)}</div>` : ''}
  </div>
`).join('');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Physiodle Review Summary — Run 1</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; background: #f3f4f6; color: #1f2937; }
  .header { background: linear-gradient(135deg, #0d9488, #134e4a); color: white; padding: 32px; }
  .header h1 { margin: 0 0 8px; font-size: 28px; }
  .header p { margin: 0; opacity: .9; font-size: 15px; }
  .container { max-width: 1200px; margin: 32px auto; padding: 0 24px; }
  .card { background: white; border-radius: 8px; padding: 24px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  .card h2 { margin: 0 0 20px; font-size: 18px; color: #111; border-bottom: 2px solid #e5e7eb; padding-bottom: 12px; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .stat-box { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; }
  .stat-num { font-size: 32px; font-weight: 800; color: #0d9488; }
  .stat-label { font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: .5px; margin-top: 4px; }
  .progress-bar { height: 8px; background: #e5e7eb; border-radius: 4px; overflow: hidden; margin-top: 8px; }
  .progress-fill { height: 100%; background: linear-gradient(90deg, #0d9488, #059669); }
  .quality-row { display: flex; align-items: center; margin-bottom: 16px; }
  .quality-label { width: 120px; font-weight: 500; }
  .quality-bar { flex: 1; margin: 0 16px; }
  .quality-count { width: 60px; text-align: right; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #f9fafb; padding: 12px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; border-bottom: 1px solid #e5e7eb; }
  td { padding: 12px; border-bottom: 1px solid #e5e7eb; }
  .warning { color: #dc2626; font-weight: 600; }
  .success { color: #059669; font-weight: 600; }
</style>
</head>
<body>

<div class="header">
  <h1>🦴 Physiodle Review Pipeline — Run 1 Summary</h1>
  <p>Clue Review & Rewrite Summary • ${new Date().toLocaleString()}</p>
</div>

<div class="container">

  <!-- Overall Progress -->
  <div class="card">
    <h2>📊 Overall Progress</h2>
    <div class="stat-grid">
      <div class="stat-box">
        <div class="stat-num">${completed}</div>
        <div class="stat-label">Reviewed</div>
        <div style="margin-top:8px;font-size:13px;color:#6b7280">${(completed * 100 / 775).toFixed(1)}% of 775</div>
      </div>
      <div class="stat-box">
        <div class="stat-num">${remaining}</div>
        <div class="stat-label">Remaining</div>
        <div style="margin-top:8px;font-size:13px;color:#6b7280">${remaining > 0 ? '⏳ In progress...' : '✓ Complete'}</div>
      </div>
      <div class="stat-box">
        <div class="stat-num">${errors}</div>
        <div class="stat-label">Errors</div>
        <div style="margin-top:8px;font-size:13px;color:#${errors > 0 ? '92400e' : '059669'}">${errors > 0 ? 'See details' : 'None'}</div>
      </div>
      <div class="stat-box">
        <div class="stat-num">${rewritten}</div>
        <div class="stat-label">Rewritten</div>
        <div style="margin-top:8px;font-size:13px;color:#6b7280">${(rewritten * 100 / completed).toFixed(1)}% of reviewed</div>
      </div>
    </div>
    <div class="progress-bar">
      <div class="progress-fill" style="width: ${(completed * 100 / 775)}%"></div>
    </div>
  </div>

  <!-- Quality Breakdown -->
  <div class="card">
    <h2>📈 Quality Breakdown</h2>
    <div class="quality-row">
      <div class="quality-label">✓ Good</div>
      <div class="quality-bar">
        <div class="progress-bar"><div class="progress-fill" style="background:#059669;width:${(good * 100 / completed)}%"></div></div>
      </div>
      <div class="quality-count">${good} (${(good * 100 / completed).toFixed(1)}%)</div>
    </div>
    <div class="quality-row">
      <div class="quality-label">~ Needs Work</div>
      <div class="quality-bar">
        <div class="progress-bar"><div class="progress-fill" style="background:#d97706;width:${(needsWork * 100 / completed)}%"></div></div>
      </div>
      <div class="quality-count">${needsWork} (${(needsWork * 100 / completed).toFixed(1)}%)</div>
    </div>
    <div class="quality-row">
      <div class="quality-label">✗ Poor</div>
      <div class="quality-bar">
        <div class="progress-bar"><div class="progress-fill" style="background:#dc2626;width:${(poor * 100 / completed)}%"></div></div>
      </div>
      <div class="quality-count"><span class="warning">${poor} (${(poor * 100 / completed).toFixed(1)}%)</span></div>
    </div>
  </div>

  <!-- Clue-Level Issues -->
  <div class="card">
    <h2>🎯 Clue Severity Breakdown</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px">
      <div style="padding:16px;background:#f0fdf4;border-radius:6px;text-align:center">
        <div style="font-size:24px;font-weight:800;color:#059669">${clueSeverity.ok}</div>
        <div style="font-size:12px;color:#6b7280;margin-top:4px">No Changes Needed</div>
      </div>
      <div style="padding:16px;background:#fffbeb;border-radius:6px;text-align:center">
        <div style="font-size:24px;font-weight:800;color:#d97706">${clueSeverity.minor}</div>
        <div style="font-size:12px;color:#6b7280;margin-top:4px">Minor Issues</div>
      </div>
      <div style="padding:16px;background:#fee2e2;border-radius:6px;text-align:center">
        <div style="font-size:24px;font-weight:800;color:#dc2626">${clueSeverity.major}</div>
        <div style="font-size:12px;color:#6b7280;margin-top:4px">Major Issues</div>
      </div>
    </div>
  </div>

  <!-- Top Issues -->
  <div class="card">
    <h2>🚩 Most Common Issue Types</h2>
    ${issueChart}
  </div>

  <!-- Top Categories -->
  <div class="card">
    <h2>📍 Top Categories by Puzzle Count</h2>
    <table>
      <thead>
        <tr><th>Category</th><th style="text-align:right">Count</th></tr>
      </thead>
      <tbody>
        ${categoryChart}
      </tbody>
    </table>
  </div>

  <!-- Poor Puzzles -->
  ${poorPuzzles.length > 0 ? `
  <div class="card" style="border-left:4px solid #dc2626">
    <h2 style="color:#991b1b">⚠️  Poor Quality Puzzles (${poorPuzzles.length})</h2>
    <div style="background:#fff5f5;border-radius:6px;overflow:hidden">
      ${poorPuzzlesHtml}
    </div>
    <div style="margin-top:16px;padding:12px;background:#fef3c7;border-radius:6px;font-size:13px;color:#92400e">
      <strong>Note:</strong> These puzzles need manual review before approval. Check the clue rewrites in the live-report.html before finalizing.
    </div>
  </div>
  ` : ''}

  <!-- Next Steps -->
  <div class="card" style="background:#f0fdf4;border-left:4px solid #059669">
    <h2 style="border-color:#d1fae5">✓ Next Steps</h2>
    <ol style="margin:0;padding-left:20px;color:#365314;line-height:1.8">
      <li>Review the live report: <code style="background:#ffffff;padding:2px 6px;border-radius:3px">node live-report.js --open</code></li>
      <li>Check the ${poorPuzzles.length} poor-quality puzzles for manual corrections</li>
      <li>Approve the puzzles.updated.json when ready</li>
      <li>Deploy: <code style="background:#ffffff;padding:2px 6px;border-radius:3px">cp data/puzzles.updated.json data/puzzles.json</code></li>
      <li>Run Run 2 for explanations: <code style="background:#ffffff;padding:2px 6px;border-radius:3px">node review-puzzles.js --mode=explanations</code></li>
    </ol>
  </div>

</div>

</body>
</html>`;

fs.writeFileSync(REPORT_FILE, html);
console.log('✅ HTML report saved to: data/summary-report.html');

const args = process.argv.slice(2);
if (args.includes('--open')) {
  try { execSync(`open "${REPORT_FILE}"`); } catch (e) {}
}
