const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, optionalAuth } = require('../auth');
const pm = require('../puzzle-manager');

// Helper: get array of friend IDs + self
function getFriendIds(userId) {
  const friends = db.prepare('SELECT friend_id FROM friendships WHERE user_id = ?').all(userId);
  return [userId, ...friends.map(f => f.friend_id)];
}

// Helper: compute user stats from game_results for a set of users within a date range
function computeLeaderboard(userIds, dateFilter, currentUserId) {
  const placeholders = userIds.map(() => '?').join(',');

  let dateClause = '';
  let params = [...userIds];

  if (dateFilter) {
    dateClause = 'AND completed_at >= ? AND completed_at < ?';
    params.push(dateFilter.from, dateFilter.to);
  }

  const rows = db.prepare(`
    SELECT
      gr.user_id,
      u.username,
      COUNT(*) as played,
      SUM(CASE WHEN gr.won = 1 THEN 1 ELSE 0 END) as won,
      AVG(CASE WHEN gr.won = 1 THEN gr.score ELSE NULL END) as avgScore
    FROM game_results gr
    JOIN users u ON u.id = gr.user_id
    WHERE gr.user_id IN (${placeholders}) ${dateClause}
    GROUP BY gr.user_id
    HAVING played > 0
    ORDER BY
      CAST(SUM(CASE WHEN gr.won = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) DESC,
      AVG(CASE WHEN gr.won = 1 THEN gr.score ELSE NULL END) ASC,
      COUNT(*) DESC
  `).all(...params);

  return rows.map((r, i) => ({
    rank: i + 1,
    userId: r.user_id,
    username: r.username,
    played: r.played,
    won: r.won,
    winRate: r.played > 0 ? Math.round((r.won / r.played) * 100) : 0,
    avgScore: r.avgScore ? parseFloat(r.avgScore.toFixed(1)) : null,
    isYou: r.user_id === currentUserId,
  }));
}

// GET /api/leaderboard/today — friends' scores on today's puzzle
router.get('/today', requireAuth, (req, res) => {
  const dayNumber = pm.getCurrentDayNumber();
  if (dayNumber < 1) {
    return res.json({ dayNumber: 0, entries: [] });
  }

  const friendIds = getFriendIds(req.user.userId);
  const placeholders = friendIds.map(() => '?').join(',');

  const rows = db.prepare(`
    SELECT
      gr.user_id,
      u.username,
      gr.won,
      gr.score,
      gr.completed_at
    FROM game_results gr
    JOIN users u ON u.id = gr.user_id
    WHERE gr.day_number = ? AND gr.user_id IN (${placeholders})
    ORDER BY
      gr.won DESC,
      gr.score ASC,
      gr.completed_at ASC
  `).all(dayNumber, ...friendIds);

  const entries = rows.map((r, i) => ({
    rank: i + 1,
    userId: r.user_id,
    username: r.username,
    won: !!r.won,
    score: r.score,
    completedAt: r.completed_at,
    isYou: r.user_id === req.user.userId,
  }));

  res.json({ dayNumber, entries });
});

// GET /api/leaderboard/weekly — this week Mon-Sun
router.get('/weekly', requireAuth, (req, res) => {
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 1=Mon, ...
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - ((dayOfWeek + 6) % 7));
  monday.setUTCHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 7);

  const friendIds = getFriendIds(req.user.userId);
  const entries = computeLeaderboard(friendIds, {
    from: monday.toISOString(),
    to: sunday.toISOString(),
  }, req.user.userId);

  res.json({
    period: `${monday.toISOString().split('T')[0]} to ${new Date(sunday - 86400000).toISOString().split('T')[0]}`,
    entries,
  });
});

// GET /api/leaderboard/monthly — current month
router.get('/monthly', requireAuth, (req, res) => {
  const now = new Date();
  const firstDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const friendIds = getFriendIds(req.user.userId);
  const entries = computeLeaderboard(friendIds, {
    from: firstDay.toISOString(),
    to: lastDay.toISOString(),
  }, req.user.userId);

  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  res.json({
    period: `${monthNames[now.getUTCMonth()]} ${now.getUTCFullYear()}`,
    entries,
  });
});

// GET /api/leaderboard/alltime — lifetime stats among friends
router.get('/alltime', requireAuth, (req, res) => {
  const friendIds = getFriendIds(req.user.userId);
  const entries = computeLeaderboard(friendIds, null, req.user.userId);
  res.json({ entries });
});

// GET /api/leaderboard/global — all users, no friend filter
router.get('/global', optionalAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 200);

  const rows = db.prepare(`
    SELECT
      gr.user_id,
      u.username,
      COUNT(*) as played,
      SUM(CASE WHEN gr.won = 1 THEN 1 ELSE 0 END) as won,
      AVG(CASE WHEN gr.won = 1 THEN gr.score ELSE NULL END) as avgScore
    FROM game_results gr
    JOIN users u ON u.id = gr.user_id
    GROUP BY gr.user_id
    HAVING played > 0
    ORDER BY
      CAST(SUM(CASE WHEN gr.won = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) DESC,
      AVG(CASE WHEN gr.won = 1 THEN gr.score ELSE NULL END) ASC,
      COUNT(*) DESC
    LIMIT ?
  `).all(limit);

  const currentUserId = req.user ? req.user.userId : null;

  const entries = rows.map((r, i) => ({
    rank: i + 1,
    userId: r.user_id,
    username: r.username,
    played: r.played,
    won: r.won,
    winRate: r.played > 0 ? Math.round((r.won / r.played) * 100) : 0,
    avgScore: r.avgScore ? parseFloat(r.avgScore.toFixed(1)) : null,
    isYou: r.user_id === currentUserId,
  }));

  res.json({ entries });
});

module.exports = router;
