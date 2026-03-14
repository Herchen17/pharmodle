/**
 * Physiodle Batch Review Pipeline
 *
 * Reviews updated puzzles 10 at a time (77 API calls for 775 puzzles).
 * Categorises each into: READY / MINOR_FIX / REWORK
 *
 * Outputs:
 *   data/batch-reviews.json      → per-puzzle verdicts
 *   data/batch-review-report.html → visual HTML report
 *
 * Usage:
 *   ANTHROPIC_API_KEY=key node batch-review.js
 *   ANTHROPIC_API_KEY=key node batch-review.js --count=30  (test first 30)
 *   ANTHROPIC_API_KEY=key node batch-review.js --start=410 --count=30  (redo errored range)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ─── Config ────────────────────────────────────────────────────────────────────

const UPDATED_FILE   = path.join(__dirname, 'data', 'puzzles.updated.json');
const BATCH_FILE     = path.join(__dirname, 'data', 'batch-reviews.json');
const PROGRESS_FILE  = path.join(__dirname, 'data', '.batch_progress.json');
const REPORT_FILE    = path.join(__dirname, 'data', 'batch-review-report.html');

const API_KEY        = process.env.ANTHROPIC_API_KEY;
const MODEL          = 'claude-haiku-4-5-20251001';
const BATCH_SIZE     = 10;
const DELAY_MS       = 500;
const MAX_RETRIES    = 3;

// ─── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior physiotherapy educator reviewing puzzles for Physiodle, a Wordle-style daily diagnosis game.

GAME RULES:
- 5 clues revealed one at a time: Complaint → Activity → History → Examination → Imaging
- Each wrong guess reveals the next clue. Max 5 guesses.
- Clue 1 should fit 10+ conditions. Clue 5 should be near-definitive.

YOUR JOB: Review a batch of 10 puzzles and quickly categorise each one.

CATEGORIES:
- "READY": The puzzle works. Clue 1 is broad enough, each subsequent clue adds genuinely new information, and a physio student would find it fair and engaging. It doesn't need to be perfect — just playable and educational.

- "MINOR_FIX": The puzzle is mostly fine but has 1-2 small issues. Examples: one clue is slightly redundant, a clue could be more specific, the progression stumbles in one spot. Still playable but could be better.

- "REWORK": The puzzle has a serious structural problem. Examples:
  * Clue 1 essentially names the diagnosis or is so specific only 1-2 conditions fit
  * Multiple clues repeat the same information (no progression)
  * The clinical story is incoherent or contradictory
  * A clue contains information that belongs in a completely different position
  * The condition is too obscure or too broad for a guessing game

BE REALISTIC — not everything needs to be perfect. A puzzle where Clue 1 is reasonably broad, each clue adds something new (even if not perfectly distinct), and Clue 5 clinches it = READY. Only flag REWORK for genuinely broken puzzles.

Respond with ONLY valid JSON array, no markdown, no explanation outside the JSON.`;

// ─── Build batch prompt ────────────────────────────────────────────────────────

function buildBatchPrompt(puzzleBatch) {
  const puzzleTexts = puzzleBatch.map((p, batchIdx) => {
    const clueLines = p.puzzle.clues
      .map((c, i) => `  C${i + 1} (${c.label}): "${c.text}"`)
      .join('\n');

    return `PUZZLE ${batchIdx + 1}: "${p.puzzle.answer}" [${p.puzzle.category}] (Index: ${p.globalIndex})
${clueLines}`;
  }).join('\n\n');

  return `Review these ${puzzleBatch.length} Physiodle puzzles. For each, give a verdict and a brief reason (1 sentence max).

${puzzleTexts}

Respond with a JSON array:
[
  {
    "index": 0,
    "answer": "Condition Name",
    "verdict": "READY" | "MINOR_FIX" | "REWORK",
    "reason": "Brief 1-sentence reason"
  }
]

Be pragmatic — READY means playable, not perfect. REWORK means genuinely broken.`;
}

// ─── API call ──────────────────────────────────────────────────────────────────

function callAPI(userPrompt, retries = 0) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 429 || res.statusCode >= 500) {
          if (retries < MAX_RETRIES) {
            const wait = Math.pow(2, retries) * 2000;
            console.log(`    ⏳ Retrying in ${wait / 1000}s (${res.statusCode})...`);
            setTimeout(() => callAPI(userPrompt, retries + 1).then(resolve).catch(reject), wait);
          } else {
            reject(new Error(`API error ${res.statusCode}`));
          }
          return;
        }
        try {
          const response = JSON.parse(data);
          if (response.error) return reject(new Error(response.error.message));
          const text = response.content[0].text.trim();
          const cleaned = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
          resolve(JSON.parse(cleaned));
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });

    req.on('error', (e) => {
      if (retries < MAX_RETRIES) {
        setTimeout(() => callAPI(userPrompt, retries + 1).then(resolve).catch(reject), 2000);
      } else {
        reject(e);
      }
    });

    req.write(body);
    req.end();
  });
}

// ─── HTML Report Generator ─────────────────────────────────────────────────────

function generateReport(reviews, puzzles) {
  function escHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  const ready = reviews.filter(r => r.verdict === 'READY');
  const minorFix = reviews.filter(r => r.verdict === 'MINOR_FIX');
  const rework = reviews.filter(r => r.verdict === 'REWORK');
  const errors = reviews.filter(r => r.verdict === 'ERROR');

  function verdictBadge(v) {
    const map = {
      READY:     { bg: '#dcfce7', color: '#166534', label: '✓ READY' },
      MINOR_FIX: { bg: '#fef3c7', color: '#92400e', label: '~ MINOR FIX' },
      REWORK:    { bg: '#fee2e2', color: '#991b1b', label: '✗ REWORK' },
      ERROR:     { bg: '#e5e7eb', color: '#374151', label: '? ERROR' },
    };
    const s = map[v] || map.ERROR;
    return `<span style="background:${s.bg};color:${s.color};padding:3px 10px;border-radius:12px;font-size:12px;font-weight:700">${s.label}</span>`;
  }

  function puzzleRow(r) {
    const p = puzzles[r.globalIndex];
    if (!p) return '';
    const borderColor = r.verdict === 'READY' ? '#d1fae5' : r.verdict === 'MINOR_FIX' ? '#fcd34d' : '#fca5a5';
    const bg = r.verdict === 'READY' ? '#f0fdf4' : r.verdict === 'MINOR_FIX' ? '#fffbeb' : '#fff5f5';

    const clueHtml = p.clues.map((c, i) => `
      <div style="margin:4px 0;padding:6px 10px;background:#f9fafb;border-radius:4px;font-size:12px;line-height:1.5">
        <span style="font-weight:600;color:#6b7280;display:inline-block;width:90px">C${i+1} ${c.label}:</span>
        <span style="color:#374151">${escHtml(c.text)}</span>
      </div>
    `).join('');

    return `
      <div id="p-${r.globalIndex}" style="margin-bottom:20px;border:1px solid ${borderColor};border-radius:8px;overflow:hidden">
        <div style="padding:10px 14px;background:${bg};display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid ${borderColor}">
          <div>
            <span style="font-weight:700;font-size:15px;color:#111">#${r.globalIndex + 1} ${escHtml(r.answer)}</span>
            <span style="color:#6b7280;font-size:12px;margin-left:8px">${escHtml(p.category)}</span>
          </div>
          ${verdictBadge(r.verdict)}
        </div>
        <div style="padding:8px 14px;font-size:12px;color:#374151;border-bottom:1px solid #e5e7eb;background:#fff">
          <strong>Verdict:</strong> ${escHtml(r.reason)}
        </div>
        <details style="padding:0">
          <summary style="padding:8px 14px;cursor:pointer;font-size:12px;font-weight:600;color:#6b7280;background:#fafafa">Show clues</summary>
          <div style="padding:8px 14px">${clueHtml}</div>
        </details>
      </div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Physiodle Batch Review Report</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; background: #f3f4f6; }
  .header { background: linear-gradient(135deg, #0d9488, #134e4a); color: white; padding: 24px 32px; }
  .header h1 { margin: 0; font-size: 24px; }
  .header p { margin: 6px 0 0; opacity: .85; font-size: 14px; }
  .stats { display: flex; gap: 16px; padding: 20px 32px; background: white; border-bottom: 1px solid #e5e7eb; flex-wrap: wrap; }
  .stat { text-align: center; min-width: 100px; }
  .stat-num { font-size: 28px; font-weight: 800; }
  .stat-label { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: .5px; }
  .container { max-width: 1100px; margin: 24px auto; padding: 0 24px; }
  .section-title { font-size: 18px; font-weight: 700; margin: 32px 0 16px; padding-bottom: 8px; border-bottom: 2px solid #e5e7eb; }
  .filter-bar { margin-bottom: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
  .filter-bar button { padding: 6px 14px; border: 1px solid #d1d5db; border-radius: 6px; background: white; cursor: pointer; font-size: 12px; font-weight: 600; }
  .filter-bar button.active { background: #0d9488; color: white; border-color: #0d9488; }
  .filter-bar input { flex: 1; min-width: 200px; padding: 6px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; }
</style>
</head>
<body>

<div class="header">
  <h1>🦴 Physiodle — Batch Review Report</h1>
  <p>Updated puzzles reviewed ${new Date().toLocaleDateString()} · ${reviews.length} puzzles</p>
</div>

<div class="stats">
  <div class="stat"><div class="stat-num" style="color:#059669">${ready.length}</div><div class="stat-label">Ready (${(ready.length*100/reviews.length).toFixed(0)}%)</div></div>
  <div class="stat"><div class="stat-num" style="color:#d97706">${minorFix.length}</div><div class="stat-label">Minor Fix (${(minorFix.length*100/reviews.length).toFixed(0)}%)</div></div>
  <div class="stat"><div class="stat-num" style="color:#dc2626">${rework.length}</div><div class="stat-label">Rework (${(rework.length*100/reviews.length).toFixed(0)}%)</div></div>
  ${errors.length > 0 ? `<div class="stat"><div class="stat-num" style="color:#6b7280">${errors.length}</div><div class="stat-label">Errors</div></div>` : ''}
</div>

<div class="container">
  <div class="filter-bar">
    <button class="active" onclick="filterAll(this)">All (${reviews.length})</button>
    <button onclick="filterBy('READY',this)">✓ Ready (${ready.length})</button>
    <button onclick="filterBy('MINOR_FIX',this)">~ Minor Fix (${minorFix.length})</button>
    <button onclick="filterBy('REWORK',this)">✗ Rework (${rework.length})</button>
    <input type="text" id="search" placeholder="Search by name or category..." oninput="searchFilter()">
  </div>

  <div id="puzzleList">
    ${reviews.map(r => puzzleRow(r)).join('')}
  </div>
</div>

<script>
const allCards = document.querySelectorAll('[id^="p-"]');
let currentFilter = null;

function filterAll(btn) {
  currentFilter = null;
  allCards.forEach(c => c.style.display = '');
  document.querySelectorAll('.filter-bar button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function filterBy(verdict, btn) {
  currentFilter = verdict;
  const verdictMap = { READY: '✓ READY', MINOR_FIX: '~ MINOR FIX', REWORK: '✗ REWORK' };
  allCards.forEach(c => {
    const badge = c.querySelector('span[style*="border-radius:12px"]');
    c.style.display = badge && badge.textContent.trim() === verdictMap[verdict] ? '' : 'none';
  });
  document.querySelectorAll('.filter-bar button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function searchFilter() {
  const q = document.getElementById('search').value.toLowerCase();
  allCards.forEach(c => {
    const text = c.textContent.toLowerCase();
    c.style.display = text.includes(q) ? '' : 'none';
  });
}
</script>

</body>
</html>`;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) {
    console.error('❌ Missing ANTHROPIC_API_KEY');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const startArg = args.find(a => a.startsWith('--start='));
  const countArg = args.find(a => a.startsWith('--count='));
  const forceStart = startArg ? parseInt(startArg.split('=')[1]) : null;
  const countLimit = countArg ? parseInt(countArg.split('=')[1]) : null;

  // Load data
  const puzzleData = JSON.parse(fs.readFileSync(UPDATED_FILE, 'utf8'));
  const puzzles = puzzleData.puzzles;

  let batchReviews = {};
  try { batchReviews = JSON.parse(fs.readFileSync(BATCH_FILE, 'utf8')); } catch {}

  let progress = {};
  try { progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch { progress = { lastBatch: -1 }; }

  const startIndex = forceStart !== null ? forceStart : (progress.lastBatch + 1) * BATCH_SIZE;
  const totalToProcess = countLimit ? Math.min(countLimit, puzzles.length - startIndex) : puzzles.length - startIndex;
  const endIndex = startIndex + totalToProcess;

  const totalBatches = Math.ceil(totalToProcess / BATCH_SIZE);

  console.log(`\n🦴 Physiodle Batch Review Pipeline`);
  console.log(`   Model: ${MODEL}`);
  console.log(`   Batch size: ${BATCH_SIZE}`);
  console.log(`   Puzzles: ${startIndex} → ${endIndex - 1} (${totalToProcess} puzzles, ${totalBatches} batches)`);
  console.log('');

  let batchNum = 0;
  let reviewed = 0, errors = 0;

  for (let i = startIndex; i < endIndex; i += BATCH_SIZE) {
    batchNum++;
    const batchEnd = Math.min(i + BATCH_SIZE, endIndex);
    const batch = [];

    for (let j = i; j < batchEnd; j++) {
      batch.push({ globalIndex: j, puzzle: puzzles[j] });
    }

    process.stdout.write(`[Batch ${batchNum}/${totalBatches}] #${i + 1}-${batchEnd} `);

    try {
      const prompt = buildBatchPrompt(batch);
      const results = await callAPI(prompt);

      // Map results back to global indices
      results.forEach((r, idx) => {
        const globalIdx = batch[idx]?.globalIndex ?? i + idx;
        const key = `${puzzles[globalIdx]?.answer}_${globalIdx}`;
        batchReviews[key] = {
          globalIndex: globalIdx,
          answer: puzzles[globalIdx]?.answer || r.answer,
          category: puzzles[globalIdx]?.category || '',
          verdict: r.verdict,
          reason: r.reason,
          reviewed_at: new Date().toISOString()
        };
      });

      const verdicts = results.map(r => r.verdict === 'READY' ? '✓' : r.verdict === 'MINOR_FIX' ? '~' : '✗').join('');
      console.log(verdicts);
      reviewed += batch.length;

    } catch (err) {
      console.log(`ERROR: ${err.message.slice(0, 50)}`);
      errors++;
      // Mark all in batch as ERROR
      batch.forEach(b => {
        const key = `${b.puzzle.answer}_${b.globalIndex}`;
        batchReviews[key] = {
          globalIndex: b.globalIndex,
          answer: b.puzzle.answer,
          category: b.puzzle.category,
          verdict: 'ERROR',
          reason: err.message.slice(0, 80),
          reviewed_at: new Date().toISOString()
        };
      });
    }

    // Save progress
    progress.lastBatch = Math.floor((i - startIndex) / BATCH_SIZE) + (forceStart ? Math.floor(startIndex / BATCH_SIZE) : 0);
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
    fs.writeFileSync(BATCH_FILE, JSON.stringify(batchReviews, null, 2));

    if (i + BATCH_SIZE < endIndex) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  // ─── Generate Report ──────────────────────────────────────────────────────

  const allReviews = Object.values(batchReviews).sort((a, b) => a.globalIndex - b.globalIndex);
  const ready = allReviews.filter(r => r.verdict === 'READY').length;
  const minorFix = allReviews.filter(r => r.verdict === 'MINOR_FIX').length;
  const rework = allReviews.filter(r => r.verdict === 'REWORK').length;

  const html = generateReport(allReviews, puzzles);
  fs.writeFileSync(REPORT_FILE, html);

  // ─── Summary ──────────────────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(60));
  console.log(`✅ Batch review complete! ${reviewed} puzzles in ${batchNum} batches.`);
  console.log('═'.repeat(60));
  console.log(`   ✓ Ready:      ${ready} (${(ready * 100 / allReviews.length).toFixed(1)}%)`);
  console.log(`   ~ Minor Fix:  ${minorFix} (${(minorFix * 100 / allReviews.length).toFixed(1)}%)`);
  console.log(`   ✗ Rework:     ${rework} (${(rework * 100 / allReviews.length).toFixed(1)}%)`);
  if (errors > 0) console.log(`   Errors:       ${errors} batches`);
  console.log('');
  console.log(`📄 Report: data/batch-review-report.html`);
  console.log(`📦 Data:   data/batch-reviews.json`);
  console.log('');

  // Show rework puzzles
  const reworkList = allReviews.filter(r => r.verdict === 'REWORK');
  if (reworkList.length > 0) {
    console.log(`⚠️  REWORK needed (${reworkList.length}):`);
    reworkList.slice(0, 15).forEach(r => {
      console.log(`   #${r.globalIndex + 1} ${r.answer.padEnd(35)} ${r.reason.slice(0, 80)}`);
    });
    if (reworkList.length > 15) console.log(`   ... and ${reworkList.length - 15} more (see report)`);
  }

  console.log('');
  console.log(`To view: open data/batch-review-report.html`);
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
