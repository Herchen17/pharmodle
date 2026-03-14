/**
 * Complete Comparison Report — All Puzzles
 *
 * Generates a comprehensive HTML report showing EVERY puzzle's original vs updated clues.
 * Includes review notes, quality ratings, and issue details.
 *
 * Usage:
 *   node complete-comparison-report.js              → generates data/complete-comparison-report.html
 *   node complete-comparison-report.js --open       → also opens in browser
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REVIEWS_FILE  = path.join(__dirname, 'data', 'reviews.json');
const ORIG_FILE     = path.join(__dirname, 'data', 'puzzles.json');
const UPDATED_FILE  = path.join(__dirname, 'data', 'puzzles.updated.json');
const REPORT_FILE   = path.join(__dirname, 'data', 'complete-comparison-report.html');

// Load data
console.log('📖 Loading data...');
const reviews       = JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));
const origData      = JSON.parse(fs.readFileSync(ORIG_FILE, 'utf8'));
const updatedData   = JSON.parse(fs.readFileSync(UPDATED_FILE, 'utf8'));

const origPuzzles   = origData.puzzles;
const updatedPuzzles = updatedData.puzzles;

// Get reviewed puzzles sorted by index
const reviewed = Object.values(reviews)
  .filter(r => !r.error && r.clues)
  .sort((a, b) => a.index - b.index);

console.log(`✓ Loaded ${reviewed.length} reviewed puzzles`);

// ─── Helper functions ──────────────────────────────────────────────────────────

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function qualityBadge(q) {
  const map = {
    good:       { color: '#166534', bg: '#dcfce7', label: 'GOOD' },
    needs_work: { color: '#92400e', bg: '#fef3c7', label: 'NEEDS WORK' },
    poor:       { color: '#991b1b', bg: '#fee2e2', label: 'POOR' },
  };
  const s = map[q] || { color: '#333', bg: '#eee', label: q };
  return `<span style="background:${s.bg};color:${s.color};padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;letter-spacing:.5px">${s.label}</span>`;
}

function severityColor(severity) {
  return severity === 'ok' ? '#166534' : severity === 'minor' ? '#92400e' : '#991b1b';
}

function issueTag(issue) {
  return `<span style="background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:8px;font-size:11px;margin-right:3px;display:inline-block">${issue}</span>`;
}

function clueComparison(clueReview, originalText, updatedText) {
  const isOk      = clueReview.severity === 'ok';
  const hasUpdate = originalText !== updatedText;
  const color     = severityColor(clueReview.severity);

  const issues = clueReview.issues && clueReview.issues.length
    ? `<div style="margin:6px 0 8px">${clueReview.issues.map(issueTag).join('')}</div>`
    : '';

  const origCell = `
    <div style="padding:8px;background:#f9fafb;border-radius:4px;margin-bottom:8px">
      <div style="font-size:11px;font-weight:600;color:#6b7280;margin-bottom:4px">ORIGINAL</div>
      <div style="font-size:13px;color:#374151;line-height:1.5">${escHtml(originalText)}</div>
    </div>`;

  const updCell = hasUpdate ? `
    <div style="padding:8px;background:#f0fdf4;border-radius:4px;margin-bottom:8px">
      <div style="font-size:11px;font-weight:600;color:#166534;margin-bottom:4px">UPDATED</div>
      <div style="font-size:13px;color:#14532d;line-height:1.5">${escHtml(updatedText)}</div>
    </div>` : `
    <div style="padding:8px;background:#f9fafb;border-radius:4px;margin-bottom:8px;font-style:italic;color:#6b7280;font-size:13px">
      ✓ No changes
    </div>`;

  const rowBg = isOk ? '#fff' : clueReview.severity === 'minor' ? '#fffbeb' : '#fff5f5';

  return `
    <div style="margin-bottom:16px;padding:12px;background:${rowBg};border:1px solid ${isOk ? '#e5e7eb' : clueReview.severity === 'minor' ? '#fcd34d' : '#fca5a5'};border-radius:6px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
        <span style="font-weight:700;font-size:14px;color:${color}">Clue ${clueReview.index + 1}</span>
        <span style="font-size:12px;color:#6b7280">${clueReview.label}</span>
        <span style="font-weight:600;font-size:11px;color:${color}">${isOk ? '✓ OK' : clueReview.severity === 'minor' ? '⚠ MINOR' : '✗ MAJOR'}</span>
      </div>
      ${issues}
      ${origCell}
      ${updCell}
      ${clueReview.new_info ? `<div style="font-size:12px;color:#6b7280;font-style:italic;margin-top:8px;padding:6px;background:#f3f4f6;border-radius:4px">💡 ${escHtml(clueReview.new_info)}</div>` : ''}
    </div>`;
}

// ─── Generate HTML ────────────────────────────────────────────────────────────

console.log('📝 Generating HTML...');

const puzzleCards = reviewed.map((r, pageIdx) => {
  const orig = origPuzzles[r.index];
  const upd = updatedPuzzles[r.index];
  if (!orig || !upd) return '';

  const cluesHtml = r.clues.map(cr => {
    const origText = orig.clues[cr.index]?.text || '';
    const updText = upd.clues[cr.index]?.text || '';
    return clueComparison(cr, origText, updText);
  }).join('');

  const anyIssues = r.clues.some(c => c.severity !== 'ok');

  return `
    <div id="puzzle-${r.index}" style="page-break-inside:avoid;margin-bottom:40px;border:1px solid ${anyIssues ? '#fca5a5' : '#d1fae5'};border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.07)">
      <!-- Header -->
      <div style="padding:16px;background:${anyIssues ? '#fff5f5' : '#f0fdf4'};border-bottom:1px solid ${anyIssues ? '#fca5a5' : '#d1fae5'};display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:18px;font-weight:700;color:#111;margin-bottom:4px">${r.index + 1}. ${escHtml(r.answer)}</div>
          <div style="font-size:13px;color:#6b7280">${escHtml(r.category)}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          ${qualityBadge(r.overall_quality)}
        </div>
      </div>

      <!-- Notes -->
      ${r.notes ? `
      <div style="padding:12px 16px;background:#f9fafb;border-bottom:1px solid #e5e7eb;font-size:12px;color:#374151;border-left:3px solid #6b7280">
        <strong>Review Notes:</strong> ${escHtml(r.notes)}
      </div>` : ''}

      <!-- Clues -->
      <div style="padding:16px">
        ${cluesHtml}
      </div>
    </div>`;
}).join('');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Physiodle — Complete Comparison Report</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    margin: 0;
    background: #f3f4f6;
    color: #1f2937;
    line-height: 1.6;
  }
  .header {
    background: linear-gradient(135deg, #0d9488, #134e4a);
    color: white;
    padding: 32px;
    position: sticky;
    top: 0;
    z-index: 100;
    box-shadow: 0 2px 8px rgba(0,0,0,.1);
  }
  .header h1 { margin: 0 0 8px; font-size: 28px; }
  .header p { margin: 0; opacity: .9; font-size: 15px; }
  .nav {
    padding: 16px 32px;
    background: white;
    border-bottom: 1px solid #e5e7eb;
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    align-items: center;
  }
  .nav input {
    flex: 1;
    min-width: 200px;
    padding: 8px 12px;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    font-size: 13px;
  }
  .nav button {
    padding: 8px 16px;
    background: #0d9488;
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .nav button:hover { background: #059669; }
  .container { max-width: 1100px; margin: 0 auto; padding: 32px 24px; }
  .stats {
    background: white;
    padding: 16px;
    border-radius: 6px;
    margin-bottom: 24px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 12px;
    border: 1px solid #e5e7eb;
  }
  .stat { text-align: center; }
  .stat-num { font-size: 20px; font-weight: 800; color: #0d9488; }
  .stat-label { font-size: 11px; color: #6b7280; text-transform: uppercase; margin-top: 4px; }
  .toc {
    background: white;
    padding: 16px;
    border-radius: 6px;
    margin-bottom: 24px;
    border: 1px solid #e5e7eb;
    max-height: 400px;
    overflow-y: auto;
  }
  .toc h3 { margin: 0 0 12px; font-size: 14px; }
  .toc ul { margin: 0; padding-left: 20px; }
  .toc li { margin-bottom: 4px; }
  .toc a { color: #0d9488; text-decoration: none; font-size: 13px; }
  .toc a:hover { text-decoration: underline; }
  .toc .poor a { color: #dc2626; font-weight: 600; }
  .toc .needs-work a { color: #d97706; }
  @media print {
    .header, .nav, .toc { display: none; }
    .container { padding: 0; }
  }
</style>
</head>
<body>

<div class="header">
  <h1>🦴 Physiodle — Complete Comparison Report</h1>
  <p>Original vs Updated Clues for All ${reviewed.length} Reviewed Puzzles</p>
</div>

<div class="nav">
  <input type="text" id="searchBox" placeholder="Search by puzzle name or category..." style="flex:1">
  <button onclick="filterPuzzles()">Search</button>
  <button onclick="window.print()">Print / PDF</button>
</div>

<div class="container">
  <div class="stats">
    <div class="stat">
      <div class="stat-num">${reviewed.length}</div>
      <div class="stat-label">Total Reviewed</div>
    </div>
    <div class="stat">
      <div class="stat-num" style="color:#059669">${reviewed.filter(r => r.overall_quality === 'good').length}</div>
      <div class="stat-label">Good</div>
    </div>
    <div class="stat">
      <div class="stat-num" style="color:#d97706">${reviewed.filter(r => r.overall_quality === 'needs_work').length}</div>
      <div class="stat-label">Needs Work</div>
    </div>
    <div class="stat">
      <div class="stat-num" style="color:#dc2626">${reviewed.filter(r => r.overall_quality === 'poor').length}</div>
      <div class="stat-label">Poor</div>
    </div>
  </div>

  <div class="toc">
    <h3>📑 Quick Navigation</h3>
    <ul>
      ${reviewed.map(r => {
        const qualityClass = r.overall_quality === 'poor' ? 'poor' : r.overall_quality === 'needs_work' ? 'needs-work' : '';
        return `<li class="${qualityClass}"><a href="#puzzle-${r.index}">${r.index + 1}. ${escHtml(r.answer)} (${escHtml(r.category)})</a></li>`;
      }).join('')}
    </ul>
  </div>

  ${puzzleCards}

  <div style="text-align:center;padding:40px 0;color:#6b7280;border-top:2px solid #e5e7eb">
    <p style="margin:0;font-size:14px"><strong>End of Report</strong></p>
    <p style="margin:8px 0 0;font-size:12px">Generated ${new Date().toLocaleString()}</p>
  </div>
</div>

<script>
function filterPuzzles() {
  const query = document.getElementById('searchBox').value.toLowerCase();
  const cards = document.querySelectorAll('[id^="puzzle-"]');

  if (!query) {
    cards.forEach(c => c.style.display = '');
    return;
  }

  cards.forEach(card => {
    const text = card.textContent.toLowerCase();
    card.style.display = text.includes(query) ? '' : 'none';
  });
}

document.getElementById('searchBox').addEventListener('keyup', filterPuzzles);
</script>

</body>
</html>`;

fs.writeFileSync(REPORT_FILE, html);
console.log(`✅ Complete comparison report generated!`);
console.log(`   Puzzles: ${reviewed.length} / 775`);
console.log(`   File: data/complete-comparison-report.html`);
console.log('');
console.log('📊 Quality breakdown:');
console.log(`   Good:        ${reviewed.filter(r => r.overall_quality === 'good').length}`);
console.log(`   Needs work:  ${reviewed.filter(r => r.overall_quality === 'needs_work').length}`);
console.log(`   Poor:        ${reviewed.filter(r => r.overall_quality === 'poor').length}`);
console.log('');

const args = process.argv.slice(2);
if (args.includes('--open')) {
  try { execSync(`open "${REPORT_FILE}"`); } catch (e) {}
}
