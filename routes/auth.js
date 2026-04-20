const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { hashPassword, verifyPassword, generateToken, requireAuth } = require('../auth');

const USERNAME_REGEX = /^[a-zA-Z0-9._-]{2,20}$/;
// Pragmatic email regex — not RFC-strict, but catches 99% of real-world emails.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- Cross-registration with sibling app (Physiodle) ----
const SIBLING_URL = process.env.SIBLING_APP_URL || '';
const SIBLING_SECRET = process.env.SIBLING_SECRET || '';

// Fire-and-forget: create account on sibling app
async function crossRegister({ username, email, passwordHash }) {
  if (!SIBLING_URL || !SIBLING_SECRET) return;
  try {
    const resp = await fetch(`${SIBLING_URL}/api/auth/cross-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sibling-secret': SIBLING_SECRET },
      body: JSON.stringify({ username, email, password_hash: passwordHash }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.log(`Cross-register to sibling (${username}): ${resp.status} ${body}`);
    }
  } catch (err) {
    console.log(`Cross-register failed:`, err.message);
  }
}

// Verify credentials against sibling app — identifier can be email or username.
async function verifySibling(identifier) {
  if (!SIBLING_URL || !SIBLING_SECRET) return null;
  try {
    const resp = await fetch(`${SIBLING_URL}/api/auth/cross-verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sibling-secret': SIBLING_SECRET },
      body: JSON.stringify({ identifier }),
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const data = await resp.json();
      return data; // { username, email, password_hash }
    }
  } catch (err) {
    console.log(`Cross-verify failed:`, err.message);
  }
  return null;
}

function looksLikeEmail(s) {
  return typeof s === 'string' && s.includes('@');
}

// Look up a user by identifier — tries email first if it looks like one,
// otherwise falls back to username. Used by both login and cross-verify.
function findUserByIdentifier(identifier) {
  if (!identifier) return null;
  if (looksLikeEmail(identifier)) {
    const byEmail = db.prepare('SELECT id, username, email, password_hash FROM users WHERE email = ?').get(identifier);
    if (byEmail) return byEmail;
  }
  return db.prepare('SELECT id, username, email, password_hash FROM users WHERE username = ?').get(identifier);
}

// Rate limiters
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created from this IP. Please try again later.' },
});

// /cross-verify runs app-to-app (not user-facing); still rate-limit as
// defence-in-depth against leaked secrets.
const crossVerifyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many cross-verify requests.' },
});

// POST /api/auth/signup
// email is required for new accounts. username stays required for display
// and as a backup identifier.
router.post('/signup', signupLimiter, async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !USERNAME_REGEX.test(username)) {
      return res.status(400).json({ error: 'Username must be 2-20 characters (letters, numbers, dots, hyphens, underscores).' });
    }
    if (!email || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const passwordHash = await hashPassword(password);

    const result = db.prepare(
      'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)'
    ).run(username, email, passwordHash);
    const token = generateToken(result.lastInsertRowid, username);

    crossRegister({ username, email, passwordHash });

    res.status(201).json({
      userId: result.lastInsertRowid,
      username,
      email,
      token,
    });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || (err.message && err.message.includes('UNIQUE'))) {
      const field = err.message && err.message.includes('email') ? 'Email' : 'Username';
      return res.status(409).json({ error: `${field} already taken.` });
    }
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/login
// Accepts `identifier` (email OR username) + password. For backwards
// compatibility also accepts `email` or `username` as the identifier field.
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { identifier, username, email, password } = req.body;
    const id = identifier || email || username;

    if (!id || !password) {
      return res.status(400).json({ error: 'Email (or username) and password required.' });
    }

    let user = findUserByIdentifier(id);

    if (!user) {
      // Not found locally — check sibling app
      const sibling = await verifySibling(id);
      if (sibling) {
        try {
          const result = db.prepare(
            'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)'
          ).run(sibling.username, sibling.email || null, sibling.password_hash);
          user = {
            id: result.lastInsertRowid,
            username: sibling.username,
            email: sibling.email || null,
            password_hash: sibling.password_hash,
          };
        } catch (insertErr) {
          // Race with another simultaneous login; re-query.
          user = findUserByIdentifier(id);
        }
      }
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      // Local hash mismatch — try re-import from sibling in case their
      // password was updated there, or a bcrypt encoding mismatch.
      const sibling = await verifySibling(id);
      if (sibling) {
        const newHash = await hashPassword(password);
        // Also back-fill email if sibling has one and we don't.
        if (sibling.email && !user.email) {
          try {
            db.prepare('UPDATE users SET password_hash = ?, email = ? WHERE id = ?')
              .run(newHash, sibling.email, user.id);
            user.email = sibling.email;
          } catch (e) {
            // Email may already belong to another user locally — just update hash.
            db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);
          }
        } else {
          db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);
        }
        console.log(`[cross-login] re-hashed password for user_id ${user.id}`);
      } else {
        return res.status(401).json({ error: 'Invalid credentials.' });
      }
    }

    const token = generateToken(user.id, user.username);
    res.json({
      userId: user.id,
      username: user.username,
      email: user.email || null,
      token,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/add-email — existing users without email can add one.
// Idempotent: succeeds if already set to same address.
router.post('/add-email', requireAuth, (req, res) => {
  const { email } = req.body;
  if (!email || !EMAIL_REGEX.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  try {
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, req.user.userId);
    // Best-effort: propagate email to sibling (they may or may not have the user).
    try {
      const user = db.prepare('SELECT username, password_hash FROM users WHERE id = ?').get(req.user.userId);
      if (user) crossRegister({ username: user.username, email, passwordHash: user.password_hash });
    } catch (_) { /* ignore */ }
    res.json({ email });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || (err.message && err.message.includes('UNIQUE'))) {
      return res.status(409).json({ error: 'Email already in use.' });
    }
    console.error('add-email error:', err);
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
  const { username, email, password_hash } = req.body;
  if (!username || !password_hash) {
    return res.status(400).json({ error: 'username and password_hash required' });
  }
  try {
    // If we already have this user (by email or username), update rather than insert.
    const existing = email
      ? db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username)
      : db.prepare('SELECT id FROM users WHERE username = ?').get(username);

    if (existing) {
      // Only back-fill email if currently null; never overwrite a local hash
      // (that would let a compromised sibling rewrite local passwords).
      db.prepare(
        'UPDATE users SET email = COALESCE(email, ?) WHERE id = ?'
      ).run(email || null, existing.id);
      return res.json({ success: true, note: 'already exists' });
    }
    db.prepare(
      'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)'
    ).run(username, email || null, password_hash);
    res.status(201).json({ success: true });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || (err.message && err.message.includes('UNIQUE'))) {
      return res.json({ success: true, note: 'already exists' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/cross-verify — sibling looks up user by email/username
// Password verification happens on the calling side.
router.post('/cross-verify', crossVerifyLimiter, async (req, res) => {
  const secret = req.headers['x-sibling-secret'];
  if (!SIBLING_SECRET || secret !== SIBLING_SECRET) {
    return res.status(403).json({ error: 'Invalid sibling secret' });
  }
  // Accept both the new `identifier` and the legacy `username` field.
  const identifier = req.body.identifier || req.body.username;
  if (!identifier) {
    return res.status(400).json({ error: 'identifier required' });
  }
  const user = findUserByIdentifier(identifier);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({
    username: user.username,
    email: user.email || null,
    password_hash: user.password_hash,
  });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, username, email, created_at FROM users WHERE id = ?').get(req.user.userId);
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

  const perfectGames = distribution[1] || 0;

  const friendCount = db.prepare(
    'SELECT COUNT(*) as cnt FROM friendships WHERE user_id = ?'
  ).get(user.id);

  // Leaderboard rank (all-time)
  const onDayCase = `CASE WHEN gr.won = 1 AND (
    gr.completed_at >= DATETIME(DATE('2026-03-04', '+' || (gr.day_number - 1) || ' days'), '-14 hours')
    AND gr.completed_at < DATETIME(DATE('2026-03-04', '+' || (gr.day_number - 1) || ' days'), '+36 hours')
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
    email: user.email || null,
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
