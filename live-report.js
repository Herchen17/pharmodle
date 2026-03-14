/**
 * Live Progress Report for Physiodle Review Pipeline
 *
 * Generates an HTML report of all puzzles reviewed SO FAR (while Run 1 is still running).
 * Shows before/after clues for each puzzle that's been completed.
 *
 * Usage:
 *   node live-report.js              → generates data/live-report.html
 *   node live-report.js --open       → opens in browser on Mac
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REVIEWS_FILE  = path.join(__dirname, 'data', 'reviews.json');
const PUZZLES_FILE  = path.join(__dirname, 'data', 'puzzles.json');
const UPDATED_FILE  = path.join(__dirname, 'data', 'puzzles.updated.json');
const REPORT_FILE   = path.join(__dirname, 'data', 'live-report.html');

// Load data
const reviews       = JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));
const origPuzzles   = JSON.parse(fs.readFileSync(PUZZLES_FILE, 'utf8')).puzzles;
const updatedData   = JSON.parse(fs.readFileSync(UPDATED_FILE, 'utf8'));
const updatedPuzzles= updatedData.puzzles;

// Only show reviewed puzzles (sorted by index)
const reviewed = Object.values(reviews)
  .filter(r => !r.error && r.clues)
  .sort((a, b) => a.index - b.index);

// ─── Build HTML ────────────────────────────────────────────────────────────────

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
  return `<span style="background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:8px;font-size:11px;margin-right:3px">${issue}</span>`;
}

function clueRow(clueReview, originalText, rewriteText) {
  const isOk      = clueReview.severity === 'ok';
  const hasRewrite = !!rewriteText;
  const color     = severityColor(clueReview.severity);

  const issues = clueReview.issues && clueReview.issues.length
    ? `<div style="margin:4px 0 6px">${clueReview.issues.map(issueTag).join('')}</div>`
    : '';

  const beforeCell = `
    <td style="padding:8px 10px;vertical-align:top;width:50%;border-right:1px solid #e5e7eb">
      <div style="font-size:12px;font-weight:600;color:#6b7280;margin-bottom:3px">CLUE ${clueReview.index + 1} — ${clueReview.label}</div>
      <div style="font-size:13px;color:#111;line-height:1.5">${escHtml(originalText)}</div>
      ${issues}
    </td>`;

  const afterCell = hasRewrite
    ? `<td style="padding:8px 10px;vertical-align:top;background:#f0fdf4">
        <div style="font-size:12px;font-weight:600;color:#166534;margin-bottom:3px">REWRITTEN</div>
        <div style="font-size:13px;color:#14532d;line-height:1.5">${escHtml(rewriteText)}</div>
      </td>`
    : `<td style="padding:8px 10px;vertical-align:top;color:#6b7280;font-size:13px;font-style:italic">
        ${isOk ? '✓ No changes needed' : 'Flagged but no rewrite suggested'}
      </td>`;

  const rowBg = isOk ? '#fff' : clueReview.severity === 'minor' ? '#fffbeb' : '#fff5f5';

  return `
    <tr style="border-bottom:1px solid #e5e7eb;background:${rowBg}">
      <td colspan="2" style="padding:0">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:4px 10px;background:${isOk ? '#f9fafb' : rowBg}">
              <span style="font-weight:700;font-size:12px;color:${color}">
                ${isOk ? '✓' : clueReview.severity === 'minor' ? '⚠' : '✗'} ${clueReview.severity.toUpperCase()}
              </span>
            </td>
          </tr>
          <tr>
            ${beforeCell}
            ${afterCell}
          </tr>
        </table>
      </td>
    </tr>`;
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Stats
const total    = reviewed.length;
const good     = reviewed.filter(r => r.overall_quality === 'good').length;
const needsWork= reviewed.filter(r => r.overall_quality === 'needs_work').length;
const poor     = reviewed.filter(r => r.overall_quality === 'poor').length;
const rewritten= reviewed.filter(r => r.clues && r.clues.some(c => c.rewrite)).length;

const puzzleCards = reviewed.map((r, i) => {
  const orig = origPuzzles[r.index];
  const upd = updatedPuzzles[r.index];
  if (!orig || !upd) return '';

  const clueRows = r.clues.map(cr => {
    const origText = orig.clues[cr.index]?.text || '';
    const updText = upd.clues[cr.index]?.text || '';
    return clueRow(cr, origText, updText);
  }).join('');

  const anyIssues = r.clues.some(c => c.severity !== 'ok');

  return `
    <div style="margin-bottom:32px;border:1px solid ${anyIssues ? '#fca5a5' : '#d1fae5'};border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.07)">
      <div style="padding:12px 16px;background:${anyIssues ? '#fff5f5' : '#f0fdf4'};border-bottom:1px solid ${anyIssues ? '#fca5a5' : '#d1fae5'};display:flex;justify-content:space-between;align-items:center">
        <div>
          <span style="font-size:16px;font-weight:700;color:#111">${r.index + 1}. ${escHtml(r.answer)}</span>
          <span style="margin-left:10px;font-size:12px;color:#6b7280">${escHtml(r.category)}</span>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          ${qualityBadge(r.overall_quality)}
        </div>
      </div>
      ${r.notes ? `<div style="padding:8px 16px;background:#f9fafb;font-size:12px;color:#374151;border-bottom:1px solid #e5e7eb">📝 ${escHtml(r.notes)}</div>` : ''}
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr style="background:#f3f4f6">
          <th style="padding:6px 10px;font-size:11px;font-weight:600;color:#6b7280;text-align:left;width:50%;border-right:1px solid #e5e7eb">BEFORE (ORIGINAL)</th>
          <th style="padding:6px 10px;font-size:11px;font-weight:600;color:#6b7280;text-align:left">AFTER (REWRITTEN)</th>
        </tr>
        ${clueRows}
      </table>
    </div>`;
}).join('');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Physiodle Live Review — ${total} Puzzles So Far</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; background: #f3f4f6; color: #111; }
  .header { background: linear-gradient(135deg, #0d9488, #134e4a); color: white; padding: 24px 32px; }
  .header h1 { margin: 0 0 4px; font-size: 22px; }
  .header p  { margin: 0; opacity: .8; font-size: 14px; }
  .stats { display: flex; gap: 16px; padding: 20px 32px; background: white; border-bottom: 1px solid #e5e7eb; flex-wrap: wrap; }
  .stat { text-align: center; }
  .stat-num { font-size: 28px; font-weight: 800; color: #0d9488; }
  .stat-label { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: .5px; }
  .content { max-width: 1100px; margin: 32px auto; padding: 0 24px; }
  .legend { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 16px; margin-bottom: 24px; font-size: 12px; color: #6b7280; display: flex; gap: 24px; flex-wrap: wrap; }
  .refresh-note { text-align: center; padding: 16px; background: #fef3c7; border-bottom: 1px solid #fcd34d; color: #92400e; font-size: 13px; }
</style>
</head>
<body>

<div class="refresh-note">
  ⏳ <strong>Live Report</strong> — Auto-refreshes every 30 seconds. Review is still running!
</div>

<div class="header">
  <h1>🦴 Physiodle — Live Review Report</h1>
  <p>Last updated ${new Date().toLocaleString()} · ${total} puzzles reviewed so far</p>
</div>

<div class="stats">
  <div class="stat"><div class="stat-num">${total}</div><div class="stat-label">Reviewed</div></div>
  <div class="stat"><div class="stat-num" style="color:#166534">${good}</div><div class="stat-label">Good</div></div>
  <div class="stat"><div class="stat-num" style="color:#d97706">${needsWork}</div><div class="stat-label">Needs Work</div></div>
  <div class="stat"><div class="stat-num" style="color:#dc2626">${poor}</div><div class="stat-label">Poor</div></div>
  <div class="stat"><div class="stat-num" style="color:#0d9488">${rewritten}</div><div class="stat-label">Rewritten</div></div>
  <div class="stat"><div class="stat-num" style="color:#6b7280">${775 - total}</div><div class="stat-label">Remaining</div></div>
</div>

<div class="content">
  <div class="legend">
    <span>✓ <strong>OK</strong> — clue is well-calibrated</span>
    <span>⚠ <strong>MINOR</strong> — could be improved, rewrite applied</span>
    <span>✗ <strong>MAJOR</strong> — significant problem, rewrite applied</span>
    <span style="background:#dcfce7;padding:1px 6px;border-radius:4px">Green background</span> = rewritten clue
  </div>

  ${puzzleCards}

  <div style="text-align:center;padding:32px;color:#6b7280;font-size:13px">
    <p><strong>Review running in background.</strong> This page will auto-refresh every 30 seconds.</p>
  </div>
</div>
</body>
</html>`;

fs.writeFileSync(REPORT_FILE, html);
console.log(`✅ Live report generated: data/live-report.html`);
console.log(`   ${total} / 775 puzzles reviewed`);
console.log(`   ${good} good | ${needsWork} needs work | ${poor} poor`);
console.log(`   ${rewritten} had clues rewritten`);
console.log('');

const args = process.argv.slice(2);
if (args.includes('--open')) {
  try { execSync(`open "${REPORT_FILE}"`); } catch (e) {}
}
