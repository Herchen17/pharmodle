const express = require('express');
const router = express.Router();
const db = require('../db');
const { hashPassword, verifyPassword, generateToken, requireAuth } = require('../auth');

const USERNAME_REGEX = /^[a-zA-Z0-9._-]{2,20}$/;

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !USERNAME_REGEX.test(username)) {
      return res.status(400).json({ error: 'Username must be 2-20 characters (letters, numbers, dots, hyphens, underscores).' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const passwordHash = await hashPassword(password);

    const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, passwordHash);
    const token = generateToken(result.lastInsertRowid, username);

    res.status(201).json({
      userId: result.lastInsertRowid,
      username,
      token,
    });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || (err.message && err.message.includes('UNIQUE'))) {
      return res.status(409).json({ error: 'Username already taken.' });
    }
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required.' });
    }

    const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const token = generateToken(user.id, user.username);
    res.json({
      userId: user.id,
      username: user.username,
      token,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(req.user.userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Get stats
  const statsRow = db.prepare(`
    SELECT
      COUNT(*) as played,
      SUM(CASE WHEN won = 1 THEN 1 ELSE 0 END) as won,
      AVG(CASE WHEN won = 1 THEN score ELSE NULL END) as avgScore
    FROM game_results WHERE user_id = ?
  `).get(user.id);

  // Compute streaks
  const results = db.prepare(
    'SELECT day_number, won FROM game_results WHERE user_id = ? ORDER BY day_number ASC'
  ).all(user.id);

  let currentStreak = 0;
  let maxStreak = 0;
  let streak = 0;
  for (const r of results) {
    if (r.won) {
      streak++;
      maxStreak = Math.max(maxStreak, streak);
    } else {
      streak = 0;
    }
  }
  // currentStreak = streak from the end
  currentStreak = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i].won) currentStreak++;
    else break;
  }

  // Distribution
  const distRows = db.prepare(`
    SELECT score, COUNT(*) as cnt FROM game_results
    WHERE user_id = ? AND won = 1 GROUP BY score
  `).all(user.id);
  const lossCount = db.prepare(
    'SELECT COUNT(*) as cnt FROM game_results WHERE user_id = ? AND won = 0'
  ).get(user.id);

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, X: 0 };
  distRows.forEach(r => { if (r.score >= 1 && r.score <= 5) distribution[r.score] = r.cnt; });
  distribution.X = lossCount.cnt;

  res.json({
    userId: user.id,
    username: user.username,
    createdAt: user.created_at,
    stats: {
      played: statsRow.played,
      won: statsRow.won,
      winRate: statsRow.played > 0 ? Math.round((statsRow.won / statsRow.played) * 100) : 0,
      avgScore: statsRow.avgScore ? parseFloat(statsRow.avgScore.toFixed(1)) : null,
      currentStreak,
      maxStreak,
      distribution,
    }
  });
});

module.exports = router;
