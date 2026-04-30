/**
 * Admin-keyed per-user stats endpoint. Read-only, admin-only.
 *
 * GET /api/admin/user-stats?identifier=alice@example.com
 *   Header: x-admin-key: <SLUG>_ADMIN_KEY
 *   (or query param: ?key=...)
 *
 * The identifier can be an email or a username. Email is tried first; if no
 * row matches, username is tried. Mirrors findUserByIdentifier in
 * Physiodle/routes/auth.js:60.
 *
 * Returns the user's summary for THIS game. The dle-hub fans out to every
 * live game's copy of this endpoint and merges responses into a unified
 * cross-game stats page.
 *
 * Response shape (stable contract — hub aggregator depends on field names):
 *   {
 *     slug:          "<game slug>",       // from process.env.GAME_SLUG, falls back to dirname
 *     identifier:    "alice@example.com", // echoed from the query
 *     matchedBy:     "email"|"username"|null,
 *     username:      "alice",              // canonical username from DB
 *     email:         "alice@example.com",  // null if not set on this game
 *     found:         true,                 // false if neither email nor username matches
 *     streak:        12,                   // current on-day win streak
 *     played:        42,                   // on-day games played (any outcome)
 *     won:           38,                   // on-day wins
 *     winRate:       90,                   // integer percent
 *     totalPoints:   178,                  // sum of (6 - score) on on-day wins
 *     lastPlayed:    "2026-04-29",         // YYYY-MM-DD AEST of most recent completed_at
 *     dayNumber:     58,                   // current day_number for this game today
 *     playedToday:   true                  // user has an on-day result for dayNumber
 *   }
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const pm = require('../puzzle-manager');

// Game slug — defaults to the directory name. Override with GAME_SLUG env
// var in production (Railway). The factory stamper sets this automatically.
const GAME_SLUG = (process.env.GAME_SLUG ||
  require('path').basename(require('path').resolve(__dirname, '..'))).toLowerCase();

// Admin key env var name: <SLUG>_ADMIN_KEY (e.g. PHYSIODLE_ADMIN_KEY).
// Same convention used by routes/analytics.js admin endpoints.
const ADMIN_KEY_ENV = GAME_SLUG.toUpperCase().replace(/-/g, '_') + '_ADMIN_KEY';
const ADMIN_KEY = process.env[ADMIN_KEY_ENV] || process.env.ADMIN_KEY;

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) {
    return res.status(500).json({ error: `${ADMIN_KEY_ENV} not configured` });
  }
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) {
    return res.status(403).json({ error: 'invalid admin key' });
  }
  next();
}

function looksLikeEmail(s) {
  return typeof s === 'string' && s.includes('@');
}

function findUser(identifier) {
  if (!identifier) return null;
  if (looksLikeEmail(identifier)) {
    const byEmail = db.prepare(
      'SELECT id, username, email FROM users WHERE email = ? COLLATE NOCASE'
    ).get(identifier);
    if (byEmail) return { user: byEmail, matchedBy: 'email' };
  }
  const byUsername = db.prepare(
    'SELECT id, username, email FROM users WHERE username = ? COLLATE NOCASE'
  ).get(identifier);
  if (byUsername) return { user: byUsername, matchedBy: 'username' };
  return null;
}

// Determine launch-date ISO string. Each game's puzzle-manager.js defines
// LAUNCH_YEAR/MONTH/DATE constants at the top of the file but doesn't
// export them. Re-derive by reading the file (small, cached at startup).
function launchDateISO() {
  const fs = require('fs');
  const src = fs.readFileSync(
    require('path').resolve(__dirname, '../puzzle-manager.js'), 'utf8'
  );
  const y = src.match(/LAUNCH_YEAR\s*=\s*(\d+)/);
  const m = src.match(/LAUNCH_MONTH\s*=\s*(\d+)/);
  const d = src.match(/LAUNCH_DATE\s*=\s*(\d+)/);
  if (!y || !m || !d) {
    throw new Error('Could not determine launch date from puzzle-manager.js');
  }
  return `${y[1]}-${String(parseInt(m[1]) + 1).padStart(2, '0')}-${String(d[1]).padStart(2, '0')}`;
}
const LAUNCH_ISO = launchDateISO();

router.get('/user-stats', requireAdmin, (req, res) => {
  const identifier = (req.query.identifier || '').trim();
  if (!identifier) {
    return res.status(400).json({ error: 'identifier query param required' });
  }

  const match = findUser(identifier);
  const currentDay = pm.getCurrentDayNumber();

  if (!match) {
    return res.json({
      slug: GAME_SLUG,
      identifier,
      matchedBy: null,
      username: null,
      email: null,
      found: false,
      streak: 0, played: 0, won: 0, winRate: 0, totalPoints: 0,
      lastPlayed: null, dayNumber: currentDay, playedToday: false,
    });
  }

  const { user, matchedBy } = match;

  // Mirror the on-day window math from routes/leaderboard.js so streak/points
  // stay consistent with the existing leaderboard. Window: 14h before release
  // to 36h after, covering all real-world timezones.
  const onDayExpr = `(
    gr.completed_at >= DATETIME(DATE('${LAUNCH_ISO}', '+' || (gr.day_number - 1) || ' days'), '-14 hours')
    AND gr.completed_at < DATETIME(DATE('${LAUNCH_ISO}', '+' || (gr.day_number - 1) || ' days'), '+36 hours')
  )`;

  const agg = db.prepare(`
    SELECT
      SUM(CASE WHEN ${onDayExpr} THEN 1 ELSE 0 END) AS played,
      SUM(CASE WHEN gr.won = 1 AND ${onDayExpr} THEN 1 ELSE 0 END) AS won,
      SUM(CASE WHEN gr.won = 1 AND ${onDayExpr} THEN (6 - gr.score) ELSE 0 END) AS totalPoints,
      MAX(gr.completed_at) AS lastPlayed
    FROM game_results gr
    WHERE gr.user_id = ?
  `).get(user.id);

  const played = agg.played || 0;
  const won = agg.won || 0;
  const totalPoints = agg.totalPoints || 0;
  const winRate = played > 0 ? Math.round((won / played) * 100) : 0;
  const lastPlayed = agg.lastPlayed
    ? new Date(new Date(agg.lastPlayed + 'Z').getTime() + 10 * 3600 * 1000)
        .toISOString().slice(0, 10)
    : null;

  // Streak: consecutive on-day wins counting back from currentDay.
  // Same algorithm as computeStreaks() in routes/leaderboard.js, scoped to one user.
  const winRows = db.prepare(`
    SELECT gr.day_number
    FROM game_results gr
    WHERE gr.user_id = ? AND gr.won = 1 AND ${onDayExpr}
    ORDER BY gr.day_number DESC
  `).all(user.id);

  let streak = 0;
  let expectedDay = currentDay;
  for (const r of winRows) {
    if (r.day_number === expectedDay) {
      streak++;
      expectedDay--;
    } else if (r.day_number < expectedDay) {
      break;
    }
  }

  const todayRow = db.prepare(`
    SELECT 1 FROM game_results gr
    WHERE gr.user_id = ? AND gr.day_number = ? AND ${onDayExpr}
    LIMIT 1
  `).get(user.id, currentDay);

  res.json({
    slug: GAME_SLUG,
    identifier,
    matchedBy,
    username: user.username,
    email: user.email || null,
    found: true,
    streak,
    played,
    won,
    winRate,
    totalPoints,
    lastPlayed,
    dayNumber: currentDay,
    playedToday: !!todayRow,
  });
});

module.exports = router;
