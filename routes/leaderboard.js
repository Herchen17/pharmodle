const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, optionalAuth } = require('../auth');

// Helper: get array of friend IDs + self
function getFriendIds(userId) {
  const friends = db.prepare('SELECT friend_id FROM friendships WHERE user_id = ?').all(userId);
  return [userId, ...friends.map(f => f.friend_id)];
}

// Helper: compute current on-day win streak for given users
// Streak = consecutive day_numbers with on-day wins, counting back from today
function computeStreaks(userIds) {
  const pm = require('../puzzle-manager');
  const currentDay = pm.getCurrentDayNumber();
  // Same timezone-aware on-day window as computeLeaderboard
  const releaseDateExpr = `DATE('2026-03-14', '+' || (gr.day_number - 1) || ' days')`;
  const onDayExpr = `(
    gr.completed_at >= DATETIME(${releaseDateExpr}, '-14 hours')
    AND gr.completed_at < DATETIME(${releaseDateExpr}, '+36 hours')
  )`;

  const whereUser = userIds
    ? `AND gr.user_id IN (${userIds.map(() => '?').join(',')})`
    : '';
  const params = userIds ? [...userIds] : [];

  // Get all on-day wins, ordered by day descending, for each user
  const rows = db.prepare(`
    SELECT gr.user_id, gr.day_number
    FROM game_results gr
    WHERE gr.won = 1 AND ${onDayExpr} ${whereUser}
    ORDER BY gr.user_id, gr.day_number DESC
  `).all(...params);

  // Group by user
  const byUser = {};
  rows.forEach(r => {
    if (!byUser[r.user_id]) byUser[r.user_id] = [];
    byUser[r.user_id].push(r.day_number);
  });

  // Compute streak: count consecutive days from currentDay backwards
  const streaks = {};
  Object.entries(byUser).forEach(([userId, days]) => {
    let streak = 0;
    let expectedDay = currentDay;
    for (const day of days) {
      if (day === expectedDay) {
        streak++;
        expectedDay--;
      } else if (day < expectedDay) {
        break; // gap found
      }
    }
    streaks[parseInt(userId)] = streak;
  });

  return streaks;
}

// Helper: compute point-based leaderboard
// If userIds is null → global (all users)
// Points: 6 - guessCount for wins, 0 for losses
function computeLeaderboard(userIds, dateFilter, currentUserId) {
  let whereClause = userIds
    ? `WHERE gr.user_id IN (${userIds.map(() => '?').join(',')})`
    : 'WHERE 1=1';

  let params = userIds ? [...userIds] : [];

  if (dateFilter) {
    whereClause += ' AND gr.completed_at >= ? AND gr.completed_at < ?';
    params.push(dateFilter.from, dateFilter.to);
  }

  const limitClause = userIds ? '' : 'LIMIT 200';

  // Only on-day completions count towards leaderboard points/ranking.
  // Day N's release date = 2026-03-14 + (N-1) days (calendar date).
  //
  // Because we serve timezone-aware puzzles, a user in e.g. UTC-5 may get day N
  // while AEST has already moved to day N+1. Their completed_at (UTC) converted
  // to AEST would show the wrong date, failing the old strict AEST-only check.
  //
  // Fix: allow a window from 14h before release-date midnight UTC to 36h after.
  // This covers UTC+14 (earliest timezone to enter day N) through UTC-12
  // (latest timezone to finish day N). In practice: ~50h window centered on
  // the release date, which prevents playing old archive puzzles for points
  // while accepting any real-world timezone.
  const releaseDateExpr = `DATE('2026-03-14', '+' || (gr.day_number - 1) || ' days')`;
  const onDayExpr = `(
    gr.completed_at >= DATETIME(${releaseDateExpr}, '-14 hours')
    AND gr.completed_at < DATETIME(${releaseDateExpr}, '+36 hours')
  )`;

  const rows = db.prepare(`
    SELECT
      gr.user_id,
      u.username,
      COUNT(*) as played,
      SUM(CASE WHEN gr.won = 1 AND ${onDayExpr} THEN 1 ELSE 0 END) as won,
      SUM(CASE WHEN gr.won = 1 AND ${onDayExpr} THEN (6 - gr.score) ELSE 0 END) as totalPoints,
      SUM(CASE WHEN ${onDayExpr} THEN 1 ELSE 0 END) as onDayPlayed
    FROM game_results gr
    JOIN users u ON u.id = gr.user_id
    ${whereClause}
    GROUP BY gr.user_id
    HAVING onDayPlayed > 0
    ORDER BY
      SUM(CASE WHEN gr.won = 1 AND ${onDayExpr} THEN (6 - gr.score) ELSE 0 END) DESC,
      CAST(SUM(CASE WHEN gr.won = 1 AND ${onDayExpr} THEN 1 ELSE 0 END) AS REAL) /
        NULLIF(SUM(CASE WHEN ${onDayExpr} THEN 1 ELSE 0 END), 0) DESC,
      SUM(CASE WHEN ${onDayExpr} THEN 1 ELSE 0 END) DESC
    ${limitClause}
  `).all(...params);

  // Compute streaks for all users in results
  const resultUserIds = rows.map(r => r.user_id);
  const streaks = resultUserIds.length > 0 ? computeStreaks(resultUserIds) : {};

  return rows.map((r, i) => ({
    rank: i + 1,
    userId: r.user_id,
    username: r.username,
    played: r.onDayPlayed,
    won: r.won,
    winRate: r.onDayPlayed > 0 ? Math.round((r.won / r.onDayPlayed) * 100) : 0,
    totalPoints: r.totalPoints || 0,
    avgPoints: r.onDayPlayed > 0 ? parseFloat(((r.totalPoints || 0) / r.onDayPlayed).toFixed(1)) : 0,
    streak: streaks[r.user_id] || 0,
    isYou: r.user_id === currentUserId,
  }));
}

// Helper: get current AEST date components
// All date boundaries should be in AEST since the game is AEST-based
const TZ_OFFSET = 10; // AEST = UTC+10
function nowAEST() {
  const now = new Date();
  return new Date(now.getTime() + TZ_OFFSET * 3600000);
}
// Format as SQLite-compatible datetime string (YYYY-MM-DD HH:MM:SS)
function sqlDate(d) {
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

// GET /api/leaderboard/weekly — this week Mon-Sun (AEST)
// ?global=true → all users; otherwise friends only (requires auth)
router.get('/weekly', optionalAuth, (req, res) => {
  const isGlobal = req.query.global === 'true';
  if (!isGlobal && !req.user) return res.status(401).json({ error: 'Authentication required' });

  const aest = nowAEST();
  const dayOfWeek = aest.getUTCDay(); // 0=Sun .. 6=Sat
  const monday = new Date(aest);
  monday.setUTCDate(aest.getUTCDate() - ((dayOfWeek + 6) % 7));
  monday.setUTCHours(0, 0, 0, 0);
  const nextMonday = new Date(monday);
  nextMonday.setUTCDate(monday.getUTCDate() + 7);

  // Convert AEST boundaries back to UTC for comparison with completed_at (stored UTC)
  const fromUTC = new Date(monday.getTime() - TZ_OFFSET * 3600000);
  const toUTC = new Date(nextMonday.getTime() - TZ_OFFSET * 3600000);

  const userIds = isGlobal ? null : getFriendIds(req.user.userId);
  const currentUserId = req.user ? req.user.userId : null;
  const entries = computeLeaderboard(userIds, { from: sqlDate(fromUTC), to: sqlDate(toUTC) }, currentUserId);

  const sundayLabel = new Date(nextMonday - 86400000);
  res.json({
    period: `${monday.toISOString().split('T')[0]} to ${sundayLabel.toISOString().split('T')[0]}`,
    entries,
  });
});

// GET /api/leaderboard/monthly — current calendar month (AEST)
// ?global=true → all users; otherwise friends only (requires auth)
router.get('/monthly', optionalAuth, (req, res) => {
  const isGlobal = req.query.global === 'true';
  if (!isGlobal && !req.user) return res.status(401).json({ error: 'Authentication required' });

  const aest = nowAEST();
  const year = aest.getUTCFullYear();
  const month = aest.getUTCMonth();
  // AEST midnight boundaries, then convert to UTC
  const firstAEST = new Date(Date.UTC(year, month, 1));
  const lastAEST = new Date(Date.UTC(year, month + 1, 1));
  const fromUTC = new Date(firstAEST.getTime() - TZ_OFFSET * 3600000);
  const toUTC = new Date(lastAEST.getTime() - TZ_OFFSET * 3600000);

  const userIds = isGlobal ? null : getFriendIds(req.user.userId);
  const currentUserId = req.user ? req.user.userId : null;
  const entries = computeLeaderboard(userIds, { from: sqlDate(fromUTC), to: sqlDate(toUTC) }, currentUserId);

  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  res.json({ period: `${monthNames[month]} ${year}`, entries });
});

// GET /api/leaderboard/yearly — current calendar year (AEST)
// ?global=true → all users; otherwise friends only (requires auth)
router.get('/yearly', optionalAuth, (req, res) => {
  const isGlobal = req.query.global === 'true';
  if (!isGlobal && !req.user) return res.status(401).json({ error: 'Authentication required' });

  const aest = nowAEST();
  const year = aest.getUTCFullYear();
  const firstAEST = new Date(Date.UTC(year, 0, 1));
  const lastAEST = new Date(Date.UTC(year + 1, 0, 1));
  const fromUTC = new Date(firstAEST.getTime() - TZ_OFFSET * 3600000);
  const toUTC = new Date(lastAEST.getTime() - TZ_OFFSET * 3600000);

  const userIds = isGlobal ? null : getFriendIds(req.user.userId);
  const currentUserId = req.user ? req.user.userId : null;
  const entries = computeLeaderboard(userIds, { from: sqlDate(fromUTC), to: sqlDate(toUTC) }, currentUserId);

  res.json({ period: `${year}`, entries });
});

// GET /api/leaderboard/alltime — all time
// ?global=true → all users; otherwise friends only (requires auth)
router.get('/alltime', optionalAuth, (req, res) => {
  const isGlobal = req.query.global === 'true';
  if (!isGlobal && !req.user) return res.status(401).json({ error: 'Authentication required' });

  const userIds = isGlobal ? null : getFriendIds(req.user.userId);
  const currentUserId = req.user ? req.user.userId : null;
  const entries = computeLeaderboard(userIds, null, currentUserId);

  res.json({ period: 'All Time', entries });
});

module.exports = router;
