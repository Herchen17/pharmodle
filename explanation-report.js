/**
 * Explanation Preview Report
 *
 * Generates an HTML report showing all generated explanations so far,
 * alongside the puzzle's clues, for easy review before committing to
 * the full batch.
 *
 * Usage:
 *   node explanation-report.js
 *   → opens data/explanation-report.html
 */

const fs = require('fs');
const path = require('path');

const PUZZLES_FILE     = path.join(__dirname, 'data', 'puzzles.json');
const EXPLANATIONS_FILE = path.join(__dirname, 'data', 'explanations.json');
const OUTPUT_FILE      = path.join(__dirname, 'data', 'explanation-report.html');

const puzzleData     = JSON.parse(fs.readFileSync(PUZZLES_FILE, 'utf8'));
const explanations   = JSON.parse(fs.readFileSync(EXPLANATIONS_FILE, 'utf8'));

const entries = Object.values(explanations).filter(e => e.explanation).sort((a, b) => a.index - b.index);

const rows = entries.map(e => {
  const puzzle = puzzleData.puzzles[e.index];
  const clueRows = puzzle.clues.map((c, i) => `
    <tr>
      <td class="label">Clue ${i+1} <span class="tag">${c.label}</span></td>
      <td>${c.text}</td>
    </tr>`).join('');

  return `
  <div class="card">
    <div class="card-header">
      <span class="num">#${e.index + 1}</span>
      <span class="answer">${e.answer}</span>
      <span class="category">${puzzle.category}</span>
    </div>
    <table class="clues">${clueRows}</table>
    <div class="explanation">
      <div class="exp-label">Explanation</div>
      <p>${e.explanation}</p>
    </div>
  </div>`;
}).join('\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Physiodle — Explanation Preview</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #222; padding: 24px; }
  h1 { font-size: 1.4rem; margin-bottom: 4px; }
  .meta { color: #666; font-size: 0.9rem; margin-bottom: 24px; }

  .card {
    background: white;
    border-radius: 10px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    margin-bottom: 20px;
    overflow: hidden;
  }
  .card-header {
    background: #1a1a2e;
    color: white;
    padding: 12px 16px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .num { font-size: 0.8rem; opacity: 0.6; }
  .answer { font-weight: 600; font-size: 1.05rem; flex: 1; }
  .category {
    background: rgba(255,255,255,0.15);
    border-radius: 4px;
    padding: 2px 8px;
    font-size: 0.75rem;
  }

  .clues { width: 100%; border-collapse: collapse; }
  .clues td { padding: 8px 14px; vertical-align: top; border-bottom: 1px solid #f0f0f0; font-size: 0.88rem; }
  .clues tr:last-child td { border-bottom: none; }
  .label { width: 160px; color: #555; font-weight: 500; white-space: nowrap; }
  .tag {
    display: inline-block;
    background: #eef;
    color: #449;
    border-radius: 3px;
    padding: 0 5px;
    font-size: 0.72rem;
    font-weight: 400;
    margin-left: 4px;
  }

  .explanation {
    background: #fffbea;
    border-top: 2px solid #f0d060;
    padding: 12px 16px;
  }
  .exp-label {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #996;
    margin-bottom: 6px;
  }
  .explanation p { font-size: 0.92rem; line-height: 1.6; color: #333; }
</style>
</head>
<body>
<h1>Physiodle — Explanation Preview</h1>
<p class="meta">${entries.length} explanations generated &nbsp;·&nbsp; ${new Date().toLocaleString()}</p>
${rows}
</body>
</html>`;

fs.writeFileSync(OUTPUT_FILE, html);
console.log(`\nReport generated: data/explanation-report.html (${entries.length} puzzles)\n`);
