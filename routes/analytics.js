const express = require('express');
const router = express.Router();
const db = require('../db');
const { optionalAuth } = require('../auth');

// ============================================================================
// TRACKING ENDPOINTS (called by frontend)
// ============================================================================

router.post('/pageview', optionalAuth, (req, res) => {
  const { visitorId, path } = req.body;
  if (!visitorId) return res.status(400).json({ error: 'visitorId required' });
  const userId = req.user ? req.user.userId : null;
  const userAgent = (req.headers['user-agent'] || '').slice(0, 500);
  try {
    db.prepare(
      'INSERT INTO page_views (visitor_id, user_id, path, user_agent, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)'
    ).run(visitorId, userId, path || '/', userAgent);
  } catch (e) { /* don't fail */ }
  res.json({ ok: true });
});

router.post('/event', optionalAuth, (req, res) => {
  const { visitorId, eventType, eventData } = req.body;
  if (!eventType) return res.status(400).json({ error: 'eventType required' });
  const userId = req.user ? req.user.userId : null;
  try {
    db.prepare(
      'INSERT INTO analytics_events (event_type, event_data, user_id, visitor_id, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)'
    ).run(eventType, eventData ? JSON.stringify(eventData) : null, userId, visitorId || null);
  } catch (e) { /* don't fail */ }
  res.json({ ok: true });
});

// ============================================================================
// HELPERS
// ============================================================================
const TZ_OFFSET = 10; // AEST

function aestDaysAgo(n) {
  const now = new Date();
  const aest = new Date(now.getTime() + TZ_OFFSET * 3600000);
  aest.setUTCDate(aest.getUTCDate() - n);
  aest.setUTCHours(0, 0, 0, 0);
  const utc = new Date(aest.getTime() - TZ_OFFSET * 3600000);
  return utc.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Invalid admin key' });
  }
  next();
}

function safeGet(fn, fallback) {
  try { return fn(); } catch (e) { return fallback; }
}

// ============================================================================
// ADMIN API — /api/analytics/dashboard (JSON)
// ============================================================================
router.get('/dashboard', requireAdmin, (req, res) => {
  const today = aestDaysAgo(0);
  const yesterday = aestDaysAgo(1);
  const weekAgo = aestDaysAgo(7);
  const monthAgo = aestDaysAgo(30);

  // --- Page Views ---
  const pv = {
    today: safeGet(() => db.prepare('SELECT COUNT(*) as c FROM page_views WHERE created_at >= ?').get(today).c, 0),
    yesterday: safeGet(() => db.prepare('SELECT COUNT(*) as c FROM page_views WHERE created_at >= ? AND created_at < ?').get(yesterday, today).c, 0),
    thisWeek: safeGet(() => db.prepare('SELECT COUNT(*) as c FROM page_views WHERE created_at >= ?').get(weekAgo).c, 0),
    thisMonth: safeGet(() => db.prepare('SELECT COUNT(*) as c FROM page_views WHERE created_at >= ?').get(monthAgo).c, 0),
    total: safeGet(() => db.prepare('SELECT COUNT(*) as c FROM page_views').get().c, 0),
  };

  // --- Unique Visitors ---
  const uv = {
    today: safeGet(() => db.prepare('SELECT COUNT(DISTINCT visitor_id) as c FROM page_views WHERE created_at >= ?').get(today).c, 0),
    yesterday: safeGet(() => db.prepare('SELECT COUNT(DISTINCT visitor_id) as c FROM page_views WHERE created_at >= ? AND created_at < ?').get(yesterday, today).c, 0),
    thisWeek: safeGet(() => db.prepare('SELECT COUNT(DISTINCT visitor_id) as c FROM page_views WHERE created_at >= ?').get(weekAgo).c, 0),
    thisMonth: safeGet(() => db.prepare('SELECT COUNT(DISTINCT visitor_id) as c FROM page_views WHERE created_at >= ?').get(monthAgo).c, 0),
    total: safeGet(() => db.prepare('SELECT COUNT(DISTINCT visitor_id) as c FROM page_views').get().c, 0),
  };

  // --- Daily breakdown (last 30 days) ---
  const dailyViews = safeGet(() => db.prepare(`
    SELECT DATE(created_at, '+10 hours') as day,
           COUNT(*) as views,
           COUNT(DISTINCT visitor_id) as unique_visitors
    FROM page_views WHERE created_at >= ?
    GROUP BY day ORDER BY day ASC
  `).all(aestDaysAgo(30)), []);

  // --- Sign-ups ---
  const signups = {
    today: safeGet(() => db.prepare('SELECT COUNT(*) as c FROM users WHERE created_at >= ?').get(today).c, 0),
    thisWeek: safeGet(() => db.prepare('SELECT COUNT(*) as c FROM users WHERE created_at >= ?').get(weekAgo).c, 0),
    thisMonth: safeGet(() => db.prepare('SELECT COUNT(*) as c FROM users WHERE created_at >= ?').get(monthAgo).c, 0),
    total: safeGet(() => db.prepare('SELECT COUNT(*) as c FROM users').get().c, 0),
  };

  // --- Daily signups (last 30 days) ---
  const dailySignups = safeGet(() => db.prepare(`
    SELECT DATE(created_at, '+10 hours') as day, COUNT(*) as count
    FROM users WHERE created_at >= ?
    GROUP BY day ORDER BY day ASC
  `).all(aestDaysAgo(30)), []);

  // --- Games ---
  const games = {
    today: safeGet(() => db.prepare('SELECT COUNT(*) as c FROM game_results WHERE completed_at >= ?').get(today).c, 0),
    thisWeek: safeGet(() => db.prepare('SELECT COUNT(*) as c FROM game_results WHERE completed_at >= ?').get(weekAgo).c, 0),
    thisMonth: safeGet(() => db.prepare('SELECT COUNT(*) as c FROM game_results WHERE completed_at >= ?').get(monthAgo).c, 0),
    total: safeGet(() => db.prepare('SELECT COUNT(*) as c FROM game_results').get().c, 0),
  };

  // --- Win/Loss stats ---
  const winTotal = safeGet(() => db.prepare('SELECT COUNT(*) as c FROM game_results WHERE won = 1').get().c, 0);
  const lossTotal = games.total - winTotal;
  const winRate = games.total > 0 ? Math.round((winTotal / games.total) * 1000) / 10 : 0;

  // --- Score distribution (1-5, only wins) ---
  const scoreDist = safeGet(() => db.prepare(`
    SELECT score, COUNT(*) as count FROM game_results WHERE won = 1 GROUP BY score ORDER BY score ASC
  `).all(), []);

  // --- Average score (winners only) ---
  const avgScore = safeGet(() => db.prepare('SELECT AVG(score) as avg FROM game_results WHERE won = 1').get().avg, 0);

  // --- Daily games (last 30 days) ---
  const dailyGames = safeGet(() => db.prepare(`
    SELECT DATE(completed_at, '+10 hours') as day,
           COUNT(*) as total,
           SUM(CASE WHEN won = 1 THEN 1 ELSE 0 END) as wins
    FROM game_results WHERE completed_at >= ?
    GROUP BY day ORDER BY day ASC
  `).all(aestDaysAgo(30)), []);

  // --- Top 10 players (by total points) ---
  const topPlayers = safeGet(() => db.prepare(`
    SELECT u.username,
           COUNT(g.id) as games_played,
           SUM(CASE WHEN g.won = 1 THEN 1 ELSE 0 END) as wins,
           SUM(CASE WHEN g.won = 1 THEN 6 - g.score ELSE 0 END) as total_points,
           ROUND(AVG(CASE WHEN g.won = 1 THEN g.score END), 1) as avg_score
    FROM game_results g JOIN users u ON g.user_id = u.id
    GROUP BY g.user_id ORDER BY total_points DESC LIMIT 10
  `).all(), []);

  // --- Most active players (by games played) ---
  const mostActive = safeGet(() => db.prepare(`
    SELECT u.username, COUNT(g.id) as games_played,
           SUM(CASE WHEN g.won = 1 THEN 1 ELSE 0 END) as wins
    FROM game_results g JOIN users u ON g.user_id = u.id
    GROUP BY g.user_id ORDER BY games_played DESC LIMIT 10
  `).all(), []);

  // --- Recent signups (last 10) ---
  const recentSignups = safeGet(() => db.prepare(`
    SELECT username, created_at FROM users ORDER BY created_at DESC LIMIT 10
  `).all(), []);

  // --- Friendships ---
  const totalFriendships = safeGet(() => db.prepare('SELECT COUNT(*) as c FROM friendships').get().c, 0);
  const pendingRequests = safeGet(() => db.prepare("SELECT COUNT(*) as c FROM friend_requests WHERE status = 'pending'").get().c, 0);

  // --- Devices ---
  const mobileViews = safeGet(() => db.prepare(
    "SELECT COUNT(*) as c FROM page_views WHERE user_agent LIKE '%Mobile%' OR user_agent LIKE '%Android%' OR user_agent LIKE '%iPhone%'"
  ).get().c, 0);

  // --- Leaderboard Popularity ---
  const lbEvents = safeGet(() => db.prepare(`
    SELECT event_data, COUNT(*) as count FROM analytics_events
    WHERE event_type = 'leaderboard_view' GROUP BY event_data ORDER BY count DESC
  `).all(), []);

  // --- Feedback ---
  const feedback = safeGet(() => db.prepare(`
    SELECT rating, COUNT(*) as count FROM feedback GROUP BY rating ORDER BY count DESC
  `).all(), []);
  const recentFeedback = safeGet(() => db.prepare(`
    SELECT f.rating, f.comment, f.day_number, f.created_at, u.username
    FROM feedback f LEFT JOIN users u ON f.user_id = u.id
    ORDER BY f.created_at DESC LIMIT 10
  `).all(), []);

  // --- Hourly activity (today, AEST) ---
  const hourlyToday = safeGet(() => db.prepare(`
    SELECT CAST(strftime('%H', created_at, '+10 hours') AS INTEGER) as hour, COUNT(*) as count
    FROM page_views WHERE created_at >= ?
    GROUP BY hour ORDER BY hour ASC
  `).all(today), []);

  // --- Hourly unique visitors (today, AEST) ---
  const hourlyVisitors = safeGet(() => db.prepare(`
    SELECT CAST(strftime('%H', created_at, '+10 hours') AS INTEGER) as hour, COUNT(DISTINCT visitor_id) as count
    FROM page_views WHERE created_at >= ?
    GROUP BY hour ORDER BY hour ASC
  `).all(today), []);

  // --- Hourly signups (today, AEST) ---
  const hourlySignups = safeGet(() => db.prepare(`
    SELECT CAST(strftime('%H', created_at, '+10 hours') AS INTEGER) as hour, COUNT(*) as count
    FROM users WHERE created_at >= ?
    GROUP BY hour ORDER BY hour ASC
  `).all(today), []);

  // --- Hourly games (today, AEST) ---
  const hourlyGames = safeGet(() => db.prepare(`
    SELECT CAST(strftime('%H', completed_at, '+10 hours') AS INTEGER) as hour, COUNT(*) as count
    FROM game_results WHERE completed_at >= ?
    GROUP BY hour ORDER BY hour ASC
  `).all(today), []);

  // --- Conversion: visitors who signed up ---
  const conversionRate = uv.total > 0 ? Math.round((signups.total / uv.total) * 1000) / 10 : 0;

  // --- Games per user ---
  const gamesPerUser = signups.total > 0 ? Math.round((games.total / signups.total) * 10) / 10 : 0;

  res.json({
    pageViews: pv,
    uniqueVisitors: uv,
    dailyBreakdown: dailyViews,
    signups,
    dailySignups,
    gamesPlayed: games,
    winLoss: { wins: winTotal, losses: lossTotal, winRate },
    scoreDistribution: scoreDist,
    averageScore: Math.round((avgScore || 0) * 10) / 10,
    dailyGames,
    topPlayers,
    mostActive,
    recentSignups,
    social: { totalFriendships: Math.floor(totalFriendships / 2), pendingRequests },
    devices: { mobile: mobileViews, desktop: pv.total - mobileViews },
    leaderboardPopularity: lbEvents,
    feedback: { distribution: feedback, recent: recentFeedback },
    hourlyToday,
    hourlyVisitors,
    hourlySignups,
    hourlyGames,
    conversionRate,
    gamesPerUser,
  });
});

// ============================================================================
// ADMIN DASHBOARD UI
// Access: /api/analytics/admin (login form, key never in URL)
// ============================================================================
router.get('/admin', (req, res) => {
  // Always serve the page — auth happens via JS fetch, never in URL
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Physiodle Admin</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<style>
:root {
  --bg: #0a0e1a; --surface: #111827; --surface2: #1a2235; --border: #1e293b;
  --text: #e2e8f0; --text2: #94a3b8; --text3: #64748b;
  --blue: #3b82f6; --green: #22c55e; --red: #ef4444; --amber: #f59e0b;
  --purple: #8b5cf6; --cyan: #06b6d4; --pink: #ec4899;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }

/* Nav */
.nav { background: var(--surface); border-bottom: 1px solid var(--border); padding: 0.75rem 1.5rem; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 100; backdrop-filter: blur(12px); }
.nav-left { display: flex; align-items: center; gap: 0.75rem; }
.nav-logo { font-size: 1.5rem; }
.nav-title { font-size: 1.1rem; font-weight: 700; color: #fff; }
.nav-badge { background: var(--green); color: #000; font-size: 0.65rem; padding: 0.15rem 0.5rem; border-radius: 99px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; animation: pulse 2s infinite; }
@keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.6} }
.nav-right { display: flex; align-items: center; gap: 0.75rem; }
.nav-time { color: var(--text3); font-size: 0.8rem; font-variant-numeric: tabular-nums; }
.btn { background: var(--blue); color: #fff; border: none; padding: 0.4rem 0.85rem; border-radius: 6px; cursor: pointer; font-size: 0.8rem; font-weight: 600; transition: all 0.15s; }
.btn:hover { filter: brightness(1.15); transform: translateY(-1px); }
.btn-sm { padding: 0.3rem 0.6rem; font-size: 0.7rem; }

/* Layout */
.container { max-width: 1400px; margin: 0 auto; padding: 1.25rem; }

/* Stat Cards */
.stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0.75rem; margin-bottom: 1.25rem; }
.stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.15rem; position: relative; overflow: hidden; }
.stat-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; }
.stat-card.blue::before { background: var(--blue); }
.stat-card.green::before { background: var(--green); }
.stat-card.amber::before { background: var(--amber); }
.stat-card.purple::before { background: var(--purple); }
.stat-card.cyan::before { background: var(--cyan); }
.stat-card.red::before { background: var(--red); }
.stat-card.pink::before { background: var(--pink); }
.stat-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text3); margin-bottom: 0.35rem; }
.stat-value { font-size: 1.75rem; font-weight: 800; color: #fff; line-height: 1.1; font-variant-numeric: tabular-nums; }
.stat-sub { font-size: 0.75rem; color: var(--text3); margin-top: 0.3rem; }
.stat-delta { font-size: 0.7rem; font-weight: 600; margin-top: 0.2rem; }
.stat-delta.up { color: var(--green); }
.stat-delta.down { color: var(--red); }

/* Sections */
.section { margin-bottom: 1.25rem; }
.section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; }
.section-title { font-size: 0.85rem; font-weight: 700; color: var(--text2); text-transform: uppercase; letter-spacing: 0.06em; }

/* Charts */
.chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-bottom: 1.25rem; }
.chart-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1rem; }
.chart-card.full { grid-column: 1 / -1; }
.chart-title { font-size: 0.75rem; font-weight: 600; color: var(--text2); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.75rem; }
.chart-wrap { position: relative; height: 220px; }
.chart-wrap.tall { height: 280px; }

/* Tables */
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text3); padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); }
td { padding: 0.5rem 0.75rem; font-size: 0.85rem; border-bottom: 1px solid rgba(30,41,59,0.5); }
tr:hover td { background: rgba(59,130,246,0.04); }
.table-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }

/* Rank badges */
.rank { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; font-size: 0.7rem; font-weight: 700; }
.rank-1 { background: #b8860b33; color: #fbbf24; }
.rank-2 { background: #6b728033; color: #d1d5db; }
.rank-3 { background: #a0522d33; color: #d2956a; }
.rank-n { background: var(--surface2); color: var(--text3); }

/* Mini bar */
.mini-bar-bg { width: 100%; height: 6px; background: var(--surface2); border-radius: 3px; overflow: hidden; }
.mini-bar { height: 100%; border-radius: 3px; transition: width 0.6s ease; }

/* Two columns */
.col-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-bottom: 1.25rem; }

/* Feedback */
.feedback-item { padding: 0.6rem 0.75rem; border-bottom: 1px solid rgba(30,41,59,0.5); }
.feedback-item:last-child { border-bottom: none; }
.feedback-meta { font-size: 0.7rem; color: var(--text3); }
.feedback-rating { font-weight: 700; }

/* Responsive */
@media (max-width: 768px) {
  .chart-grid, .col-2 { grid-template-columns: 1fr; }
  .stats-row { grid-template-columns: repeat(2, 1fr); }
  .stat-value { font-size: 1.4rem; }
  .container { padding: 0.75rem; }
}
</style>
</head>
<body>

<!-- Login Screen -->
<div id="loginScreen" style="display:flex;align-items:center;justify-content:center;min-height:100vh;">
  <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:2rem;width:320px;text-align:center;">
    <div style="font-size:2.5rem;margin-bottom:0.5rem;">&#129468;</div>
    <h2 style="color:#fff;margin-bottom:0.25rem;">Physiodle Admin</h2>
    <p style="color:var(--text3);font-size:0.85rem;margin-bottom:1.25rem;">Enter your admin key to continue</p>
    <input type="password" id="adminKeyInput" placeholder="Admin key" style="width:100%;padding:0.6rem 0.75rem;border-radius:8px;border:1px solid var(--border);background:var(--surface2);color:#fff;font-size:0.9rem;margin-bottom:0.75rem;outline:none;" onkeydown="if(event.key==='Enter')doLogin()">
    <button class="btn" style="width:100%;padding:0.6rem;" onclick="doLogin()">Unlock Dashboard</button>
    <p id="loginError" style="color:var(--red);font-size:0.8rem;margin-top:0.75rem;display:none;">Invalid admin key</p>
  </div>
</div>

<nav class="nav" id="mainNav" style="display:none;">
  <div class="nav-left">
    <span class="nav-logo">&#129468;</span>
    <span class="nav-title">Physiodle Admin</span>
    <span class="nav-badge">Live</span>
  </div>
  <div class="nav-right">
    <span class="nav-time" id="clock"></span>
    <button class="btn" onclick="loadData()">Refresh</button>
  </div>
</nav>

<div class="container" id="mainDash" style="display:none;">
  <!-- KPI Row -->
  <div class="stats-row" id="kpiRow"></div>

  <!-- Charts Row 1: Traffic + Games -->
  <div class="chart-grid">
    <div class="chart-card full">
      <div class="chart-title">Daily Traffic &amp; Games (30 Days)</div>
      <div class="chart-wrap tall"><canvas id="trafficChart"></canvas></div>
    </div>
  </div>

  <!-- Charts Row 2: Win Rate + Score Dist + Hourly + Devices -->
  <div class="chart-grid">
    <div class="chart-card">
      <div class="chart-title">Win / Loss</div>
      <div class="chart-wrap"><canvas id="winLossChart"></canvas></div>
    </div>
    <div class="chart-card">
      <div class="chart-title">Score Distribution (Winners)</div>
      <div class="chart-wrap"><canvas id="scoreChart"></canvas></div>
    </div>
    <div class="chart-card">
      <div class="chart-title">Device Split</div>
      <div class="chart-wrap"><canvas id="deviceChart"></canvas></div>
    </div>
  </div>

  <!-- Hourly Breakdown Section -->
  <div class="section-header" style="margin-bottom:0.6rem"><span class="section-title">Hourly Breakdown Today (AEST)</span></div>
  <div class="chart-grid">
    <div class="chart-card">
      <div class="chart-title">Page Views by Hour</div>
      <div class="chart-wrap"><canvas id="hourlyChart"></canvas></div>
    </div>
    <div class="chart-card">
      <div class="chart-title">Unique Visitors by Hour</div>
      <div class="chart-wrap"><canvas id="hourlyVisitorsChart"></canvas></div>
    </div>
    <div class="chart-card">
      <div class="chart-title">Games Played by Hour</div>
      <div class="chart-wrap"><canvas id="hourlyGamesChart"></canvas></div>
    </div>
    <div class="chart-card">
      <div class="chart-title">Sign-ups by Hour</div>
      <div class="chart-wrap"><canvas id="hourlySignupsChart"></canvas></div>
    </div>
  </div>

  <!-- Tables -->
  <div class="col-2">
    <div>
      <div class="section-header"><span class="section-title">Top Players (by points)</span></div>
      <div class="table-card" id="topPlayersTable"></div>
    </div>
    <div>
      <div class="section-header"><span class="section-title">Most Active</span></div>
      <div class="table-card" id="activeTable"></div>
    </div>
  </div>

  <div class="col-2">
    <div>
      <div class="section-header"><span class="section-title">Recent Sign-ups</span></div>
      <div class="table-card" id="signupsTable"></div>
    </div>
    <div>
      <div class="section-header"><span class="section-title">Recent Feedback</span></div>
      <div class="table-card" id="feedbackPanel"></div>
    </div>
  </div>

  <!-- Leaderboard Popularity -->
  <div class="section">
    <div class="section-header"><span class="section-title">Leaderboard Tab Popularity</span></div>
    <div class="stats-row" id="lbPop"></div>
  </div>
</div>

<script>
let K = null; // admin key — stored in memory only, never in URL
let charts = {};

async function doLogin() {
  const input = document.getElementById('adminKeyInput');
  const key = input.value.trim();
  if (!key) return;
  try {
    const r = await fetch('/api/analytics/dashboard', { headers: { 'x-admin-key': key } });
    if (!r.ok) throw new Error('bad key');
    K = key;
    // Strip any key from URL (in case someone bookmarked the old URL)
    if (window.location.search) history.replaceState(null, '', window.location.pathname);
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('mainNav').style.display = '';
    document.getElementById('mainDash').style.display = '';
    const d = await r.json();
    renderAll(d);
    setInterval(loadData, 30000);
  } catch (e) {
    document.getElementById('loginError').style.display = 'block';
    input.value = '';
    input.focus();
  }
}

function updateClock() {
  const now = new Date();
  const aest = new Date(now.getTime() + 10 * 3600000);
  document.getElementById('clock').textContent = aest.toISOString().slice(0,16).replace('T',' ') + ' AEST';
}
setInterval(updateClock, 1000);
updateClock();

function toAEST(d) { return new Date(new Date(d).getTime() + 10 * 3600000); }
function fmtDate(d) { if (!d) return '—'; const a = toAEST(d); return a.getUTCDate() + '/' + (a.getUTCMonth()+1) + '/' + a.getUTCFullYear(); }
function fmtDateTime(d) { if (!d) return '—'; const a = toAEST(d); return a.toISOString().slice(0,16).replace('T',' ') + ' AEST'; }

Chart.defaults.color = '#94a3b8';
Chart.defaults.borderColor = '#1e293b';
Chart.defaults.font.family = "'Inter', sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.plugins.legend.labels.boxWidth = 10;

function destroyChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }

function renderAll(d) {
  renderKPIs(d);
  renderTrafficChart(d);
  renderWinLoss(d);
  renderScoreDist(d);
  renderDevices(d);
  renderHourlyAll(d);
  renderTopPlayers(d.topPlayers);
  renderMostActive(d.mostActive);
  renderRecentSignups(d.recentSignups);
  renderFeedback(d.feedback);
  renderLbPop(d.leaderboardPopularity);
}

async function loadData() {
  if (!K) return;
  try {
    const r = await fetch('/api/analytics/dashboard', { headers: { 'x-admin-key': K } });
    const d = await r.json();
    renderAll(d);
  } catch (e) { console.error('Dashboard refresh failed:', e); }
}

function renderKPIs(d) {
  const delta = (a, b) => { if (!b) return ''; const pct = Math.round(((a-b)/Math.max(b,1))*100); return '<div class="stat-delta ' + (pct>=0?'up':'down') + '">' + (pct>=0?'+':'') + pct + '% vs yesterday</div>'; };
  const cards = [
    { label: 'Visitors Today', value: d.uniqueVisitors.today, sub: 'Total: ' + d.uniqueVisitors.total, color: 'blue', extra: delta(d.uniqueVisitors.today, d.uniqueVisitors.yesterday) },
    { label: 'Page Views Today', value: d.pageViews.today, sub: 'Total: ' + d.pageViews.total, color: 'cyan', extra: delta(d.pageViews.today, d.pageViews.yesterday) },
    { label: 'Sign-ups', value: d.signups.total, sub: 'Today: ' + d.signups.today + ' | Week: ' + d.signups.thisWeek, color: 'green' },
    { label: 'Games Played', value: d.gamesPlayed.total, sub: 'Today: ' + d.gamesPlayed.today + ' | Week: ' + d.gamesPlayed.thisWeek, color: 'purple' },
    { label: 'Win Rate', value: d.winLoss.winRate + '%', sub: d.winLoss.wins + 'W / ' + d.winLoss.losses + 'L', color: 'amber' },
    { label: 'Avg Score', value: d.averageScore, sub: 'Lower is better (1-5)', color: 'pink' },
    { label: 'Conversion', value: d.conversionRate + '%', sub: 'Visitors \\u2192 Sign-ups', color: 'green' },
    { label: 'Games / User', value: d.gamesPerUser, sub: d.social.totalFriendships + ' friendships', color: 'cyan' },
  ];
  document.getElementById('kpiRow').innerHTML = cards.map(c =>
    '<div class="stat-card ' + c.color + '"><div class="stat-label">' + c.label + '</div><div class="stat-value">' + c.value + '</div><div class="stat-sub">' + c.sub + '</div>' + (c.extra||'') + '</div>'
  ).join('');
}

function renderTrafficChart(d) {
  destroyChart('traffic');
  const labels = d.dailyBreakdown.map(r => r.day.slice(5));
  const signupMap = {};
  (d.dailySignups || []).forEach(r => { signupMap[r.day] = r.count; });
  const gameMap = {};
  (d.dailyGames || []).forEach(r => { gameMap[r.day] = r.total; });

  charts.traffic = new Chart(document.getElementById('trafficChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Page Views', data: d.dailyBreakdown.map(r => r.views), backgroundColor: '#3b82f640', borderColor: '#3b82f6', borderWidth: 1, borderRadius: 4, order: 2 },
        { label: 'Unique Visitors', data: d.dailyBreakdown.map(r => r.unique_visitors), type: 'line', borderColor: '#06b6d4', backgroundColor: '#06b6d420', pointRadius: 2, tension: 0.3, fill: true, order: 1 },
        { label: 'Games', data: d.dailyBreakdown.map(r => gameMap[r.day] || 0), type: 'line', borderColor: '#8b5cf6', pointRadius: 2, tension: 0.3, borderDash: [4,2], order: 0 },
        { label: 'Sign-ups', data: d.dailyBreakdown.map(r => signupMap[r.day] || 0), type: 'line', borderColor: '#22c55e', pointRadius: 2, tension: 0.3, borderDash: [2,2], order: 0 },
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      scales: { y: { beginAtZero: true, grid: { color: '#1e293b' } }, x: { grid: { display: false } } } }
  });
}

function renderWinLoss(d) {
  destroyChart('winLoss');
  charts.winLoss = new Chart(document.getElementById('winLossChart'), {
    type: 'doughnut',
    data: {
      labels: ['Wins', 'Losses'],
      datasets: [{ data: [d.winLoss.wins, d.winLoss.losses], backgroundColor: ['#22c55e', '#ef4444'], borderWidth: 0, spacing: 2 }]
    },
    options: { responsive: true, maintainAspectRatio: false, cutout: '65%',
      plugins: { legend: { position: 'bottom' } } }
  });
}

function renderScoreDist(d) {
  destroyChart('score');
  const colors = ['#22c55e', '#4ade80', '#06b6d4', '#f59e0b', '#ef4444'];
  const scoreLabels = ['1 (First try)', '2', '3', '4', '5 (Last chance)'];
  const data = [0,0,0,0,0];
  d.scoreDistribution.forEach(r => { if (r.score >= 1 && r.score <= 5) data[r.score-1] = r.count; });
  charts.score = new Chart(document.getElementById('scoreChart'), {
    type: 'bar',
    data: { labels: scoreLabels, datasets: [{ data, backgroundColor: colors, borderRadius: 6, borderSkipped: false }] },
    options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, grid: { color: '#1e293b' } }, y: { grid: { display: false } } } }
  });
}

function _hourlyBar(canvasId, chartKey, hourlyData, color) {
  destroyChart(chartKey);
  const data = new Array(24).fill(0);
  (hourlyData || []).forEach(r => { data[r.hour] = r.count; });
  const currentHour = new Date(Date.now() + 10*3600000).getUTCHours();
  charts[chartKey] = new Chart(document.getElementById(canvasId), {
    type: 'bar',
    data: { labels: data.map((_,i) => i + ':00'), datasets: [{ data, backgroundColor: data.map((_,i) => i === currentHour ? color : color + '40'), borderRadius: 3 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(15,23,42,0.95)', titleColor: '#e2e8f0', bodyColor: '#94a3b8', borderColor: '#334155', borderWidth: 1, padding: 8 } },
      scales: { y: { beginAtZero: true, grid: { color: '#1e293b' }, ticks: { maxTicksLimit: 5 } }, x: { grid: { display: false }, ticks: { maxTicksLimit: 12 } } } }
  });
}
function renderHourlyAll(d) {
  _hourlyBar('hourlyChart', 'hourly', d.hourlyToday, '#3b82f6');
  _hourlyBar('hourlyVisitorsChart', 'hourlyVisitors', d.hourlyVisitors, '#06b6d4');
  _hourlyBar('hourlyGamesChart', 'hourlyGames', d.hourlyGames, '#8b5cf6');
  _hourlyBar('hourlySignupsChart', 'hourlySignups', d.hourlySignups, '#22c55e');
}

function renderDevices(d) {
  destroyChart('device');
  charts.device = new Chart(document.getElementById('deviceChart'), {
    type: 'doughnut',
    data: {
      labels: ['Mobile', 'Desktop'],
      datasets: [{ data: [d.devices.mobile, d.devices.desktop], backgroundColor: ['#8b5cf6', '#3b82f6'], borderWidth: 0, spacing: 2 }]
    },
    options: { responsive: true, maintainAspectRatio: false, cutout: '65%',
      plugins: { legend: { position: 'bottom' } } }
  });
}

function renderTopPlayers(rows) {
  if (!rows || !rows.length) { document.getElementById('topPlayersTable').innerHTML = '<p style="padding:1rem;color:#64748b">No data yet</p>'; return; }
  const maxPts = Math.max(...rows.map(r => r.total_points), 1);
  document.getElementById('topPlayersTable').innerHTML = '<table><thead><tr><th>#</th><th>Player</th><th>Pts</th><th>W</th><th>Avg</th><th></th></tr></thead><tbody>' +
    rows.map((r, i) => {
      const rc = i<3 ? 'rank-'+(i+1) : 'rank-n';
      return '<tr><td><span class="rank ' + rc + '">' + (i+1) + '</span></td><td style="font-weight:600">' + r.username + '</td><td style="color:#fbbf24;font-weight:700">' + r.total_points + '</td><td>' + r.wins + '/' + r.games_played + '</td><td>' + (r.avg_score||'-') + '</td><td><div class="mini-bar-bg"><div class="mini-bar" style="width:' + (r.total_points/maxPts*100) + '%;background:linear-gradient(90deg,#f59e0b,#fbbf24)"></div></div></td></tr>';
    }).join('') + '</tbody></table>';
}

function renderMostActive(rows) {
  if (!rows || !rows.length) { document.getElementById('activeTable').innerHTML = '<p style="padding:1rem;color:#64748b">No data yet</p>'; return; }
  const maxG = Math.max(...rows.map(r => r.games_played), 1);
  document.getElementById('activeTable').innerHTML = '<table><thead><tr><th>#</th><th>Player</th><th>Games</th><th>Wins</th><th>Win%</th><th></th></tr></thead><tbody>' +
    rows.map((r, i) => {
      const rc = i<3 ? 'rank-'+(i+1) : 'rank-n';
      const wr = r.games_played > 0 ? Math.round(r.wins/r.games_played*100) : 0;
      return '<tr><td><span class="rank ' + rc + '">' + (i+1) + '</span></td><td style="font-weight:600">' + r.username + '</td><td>' + r.games_played + '</td><td>' + r.wins + '</td><td>' + wr + '%</td><td><div class="mini-bar-bg"><div class="mini-bar" style="width:' + (r.games_played/maxG*100) + '%;background:linear-gradient(90deg,#8b5cf6,#a78bfa)"></div></div></td></tr>';
    }).join('') + '</tbody></table>';
}

function renderRecentSignups(rows) {
  if (!rows || !rows.length) { document.getElementById('signupsTable').innerHTML = '<p style="padding:1rem;color:#64748b">No sign-ups yet</p>'; return; }
  document.getElementById('signupsTable').innerHTML = '<table><thead><tr><th>Username</th><th>Joined</th></tr></thead><tbody>' +
    rows.map(r => '<tr><td style="font-weight:600">' + r.username + '</td><td style="color:#64748b">' + fmtDateTime(r.created_at) + '</td></tr>').join('') + '</tbody></table>';
}

function renderFeedback(fb) {
  const el = document.getElementById('feedbackPanel');
  if (!fb || !fb.recent || !fb.recent.length) { el.innerHTML = '<p style="padding:1rem;color:#64748b">No feedback yet</p>'; return; }
  const ratingEmoji = { good: '\\u{1F44D}', ok: '\\u{1F44C}', bad: '\\u{1F44E}' };
  el.innerHTML = fb.recent.map(r =>
    '<div class="feedback-item"><span class="feedback-rating">' + (ratingEmoji[r.rating] || r.rating) + '</span> <strong>' + (r.username || 'Anon') + '</strong> <span class="feedback-meta">Day ' + r.day_number + ' &middot; ' + fmtDate(r.created_at) + '</span>' + (r.comment ? '<div style="color:#94a3b8;font-size:0.8rem;margin-top:0.2rem">' + r.comment + '</div>' : '') + '</div>'
  ).join('');
}

function renderLbPop(rows) {
  const el = document.getElementById('lbPop');
  if (!rows || !rows.length) { el.innerHTML = '<p style="color:#64748b">No data yet</p>'; return; }
  const maxC = Math.max(...rows.map(r => r.count), 1);
  const colors = ['blue','green','amber','purple','cyan','pink'];
  el.innerHTML = rows.map((r, i) => {
    const name = (r.event_data || '').replace(/"/g, '');
    return '<div class="stat-card ' + colors[i%6] + '"><div class="stat-label">' + name + '</div><div class="stat-value">' + r.count + '</div><div style="margin-top:0.4rem"><div class="mini-bar-bg"><div class="mini-bar" style="width:' + (r.count/maxC*100) + '%;background:var(--' + colors[i%6] + ')"></div></div></div></div>';
  }).join('');
}

// Auto-login if key was passed in URL (backwards compat), then strip it
(function() {
  const urlKey = new URLSearchParams(window.location.search).get('key');
  if (urlKey) {
    document.getElementById('adminKeyInput').value = urlKey;
    doLogin();
  } else {
    document.getElementById('adminKeyInput').focus();
  }
})();
</script>
</body>
</html>`);
});

module.exports = router;
