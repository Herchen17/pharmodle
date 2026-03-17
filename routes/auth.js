const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { hashPassword, verifyPassword, generateToken, requireAuth } = require('../auth');

const USERNAME_REGEX = /^[a-zA-Z0-9._-]{2,20}$/;

// ---- Cross-registration with sibling app (Physiodle) ----
// When a user signs up here, we also create their account on the sibling app.
// When a user tries to log in here but doesn't have a local account,
// we check the sibling app and auto-create the account if valid.
const SIBLING_URL = process.env.SIBLING_APP_URL || ''; // e.g. 'https://physiodle.up.railway.app'
const SIBLING_SECRET = process.env.SIBLING_SECRET || '';

// Fire-and-forget: create account on sibling app
async function crossRegister(username, passwordHash) {
  if (!SIBLING_URL || !SIBLING_SECRET) return;
  try {
    const resp = await fetch(`${SIBLING_URL}/api/auth/cross-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sibling-secret': SIBLING_SECRET },
      body: JSON.stringify({ username, password_hash: passwordHash }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.log(`Cross-register to sibling (${username}): ${resp.status} ${body}`);
    }
  } catch (err) {
    console.log(`Cross-register failed (${username}):`, err.message);
  }
}

// Verify credentials against sibling app
async function verifySibling(username, password) {
  if (!SIBLING_URL || !SIBLING_SECRET) {
    console.log(`[cross-verify] Skipping — SIBLING_URL="${SIBLING_URL}" SIBLING_SECRET="${SIBLING_SECRET ? 'set' : 'empty'}"`);
    return null;
  }
  console.log(`[cross-verify] Calling ${SIBLING_URL}/api/auth/cross-verify for "${username}"`);
  try {
    const resp = await fetch(`${SIBLING_URL}/api/auth/cross-verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sibling-secret': SIBLING_SECRET },
      body: JSON.stringify({ username, password }),
    });
    console.log(`[cross-verify] Response status: ${resp.status} for "${username}"`);
    if (resp.ok) {
      const data = await resp.json();
      return data; // { username, password_hash }
    }
    const body = await resp.text();
    console.log(`[cross-verify] Non-ok body: ${body}`);
  } catch (err) {
    console.log(`[cross-verify] Network error (${username}):`, err.message);
  }
  return null;
}

// Rate limiter: max 10 login attempts per IP per 15 minutes
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
});

// Rate limiter: max 5 signups per IP per hour
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created from this IP. Please try again later.' },
});

// POST /api/auth/signup
router.post('/signup', signupLimiter, async (req, res) => {
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

    // Cross-register on sibling app (fire-and-forget)
    crossRegister(username, passwordHash);

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
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required.' });
    }

    let user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);

    if (!user) {
      // User doesn't exist locally — check sibling app (Physiodle)
      const sibling = await verifySibling(username, password);
      if (sibling) {
        try {
          const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(sibling.username, sibling.password_hash);
          user = { id: result.lastInsertRowid, username: sibling.username, password_hash: sibling.password_hash };
        } catch (insertErr) {
          user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
        }
      }
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      // Password didn't match local hash — check if sibling has this account
      // and re-hash locally. Handles imported accounts and bcrypt compat issues.
      const sibling = await verifySibling(username, password);
      if (sibling) {
        const newHash = await hashPassword(password);
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);
        console.log(`[cross-login] Re-hashed password for user "${username}"`);
      } else {
        return res.status(401).json({ error: 'Invalid username or password.' });
      }
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

// ---- Sibling app endpoints (called by Physiodle, not by users) ----

// POST /api/auth/cross-register — sibling creates an account here
router.post('/cross-register', async (req, res) => {
  const secret = req.headers['x-sibling-secret'];
  if (!SIBLING_SECRET || secret !== SIBLING_SECRET) {
    return res.status(403).json({ error: 'Invalid sibling secret' });
  }
  const { username, password_hash } = req.body;
  if (!username || !password_hash) {
    return res.status(400).json({ error: 'username and password_hash required' });
  }
  try {
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, password_hash);
    res.status(201).json({ success: true });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || (err.message && err.message.includes('UNIQUE'))) {
      return res.json({ success: true, note: 'already exists' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/cross-verify — sibling looks up user hash here
// Password verification is done on the calling side (Physiodle).
// This endpoint is protected by the shared SIBLING_SECRET.
router.post('/cross-verify', async (req, res) => {
  const secret = req.headers['x-sibling-secret'];
  if (!SIBLING_SECRET || secret !== SIBLING_SECRET) {
    return res.status(403).json({ error: 'Invalid sibling secret' });
  }
  const { username } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'username required' });
  }
  const user = db.prepare('SELECT username, password_hash FROM users WHERE username = ?').get(username);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({ username: user.username, password_hash: user.password_hash });
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
      AVG(CASE WHEN won = 1 THEN score ELSE NULL END) as avgScore,
      MIN(CASE WHEN won = 1 THEN score ELSE NULL END) as bestScore,
      SUM(CASE WHEN won = 1 THEN (6 - score) ELSE 0 END) as totalPoints,
      MIN(completed_at) as firstGame,
      MAX(completed_at) as lastGame
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

  // Perfect games (score of 1) and first-guess percentage
  const perfectGames = distribution[1] || 0;

  // Friend count
  const friendCount = db.prepare(
    'SELECT COUNT(*) as cnt FROM friendships WHERE user_id = ?'
  ).get(user.id);

  // Leaderboard rank (all-time) — compute user's points then count how many have more
  const onDayCase = `CASE WHEN gr.won = 1 AND (
    gr.completed_at >= DATETIME(DATE('2026-03-14', '+' || (gr.day_number - 1) || ' days'), '-14 hours')
    AND gr.completed_at < DATETIME(DATE('2026-03-14', '+' || (gr.day_number - 1) || ' days'), '+36 hours')
  ) THEN (6 - gr.score) ELSE 0 END`;

  const myPoints = db.prepare(`
    SELECT COALESCE(SUM(${onDayCase}), 0) as pts FROM game_results gr WHERE gr.user_id = ?
  `).get(user.id);

  const rankRow = db.prepare(`
    SELECT COUNT(*) + 1 as rank FROM (
      SELECT gr.user_id, SUM(${onDayCase}) as pts
      FROM game_results gr GROUP BY gr.user_id
      HAVING pts > ?
    )
  `).get(myPoints.pts);

  const totalPlayers = db.prepare('SELECT COUNT(*) as cnt FROM users').get();

  res.json({
    userId: user.id,
    username: user.username,
    createdAt: user.created_at,
    stats: {
      played: statsRow.played,
      won: statsRow.won,
      winRate: statsRow.played > 0 ? Math.round((statsRow.won / statsRow.played) * 100) : 0,
      avgScore: statsRow.avgScore ? parseFloat(statsRow.avgScore.toFixed(1)) : null,
      bestScore: statsRow.bestScore,
      totalPoints: statsRow.totalPoints || 0,
      avgPoints: statsRow.played > 0 ? parseFloat(((statsRow.totalPoints || 0) / statsRow.played).toFixed(1)) : 0,
      currentStreak,
      maxStreak,
      perfectGames,
      distribution,
      firstGame: statsRow.firstGame,
      lastGame: statsRow.lastGame,
      friendCount: friendCount.cnt,
      leaderboardRank: rankRow.rank,
      totalPlayers: totalPlayers.cnt,
    }
  });
});

module.exports = router;
