const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../auth');

// ---- Cross-app friend sync (sibling-to-sibling) ----
const SIBLING_URL = process.env.SIBLING_APP_URL || '';
const SIBLING_SECRET = process.env.SIBLING_SECRET || '';

async function crossSyncFriendship(usernameA, usernameB) {
  if (!SIBLING_URL || !SIBLING_SECRET) return;
  try {
    await fetch(`${SIBLING_URL}/api/friends/cross-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sibling-secret': SIBLING_SECRET },
      body: JSON.stringify({ user_a: usernameA, user_b: usernameB }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.log(`[friend-sync] failed for ${usernameA} <-> ${usernameB}:`, err.message);
  }
}

// POST /api/friends/cross-sync — sibling app pushes a friendship to us.
// Idempotent (INSERT OR IGNORE) and silently skips if either user is
// not present locally yet (sibling will retry on the next mutual event).
// NOT user-facing — protected by the shared SIBLING_SECRET, defined
// before the requireAuth middleware so it skips JWT auth.
router.post('/cross-sync', express.json(), (req, res) => {
  const secret = req.headers['x-sibling-secret'];
  if (!SIBLING_SECRET || secret !== SIBLING_SECRET) {
    return res.status(403).json({ error: 'Invalid sibling secret' });
  }
  const { user_a, user_b } = req.body;
  if (!user_a || !user_b) return res.status(400).json({ error: 'user_a and user_b required' });

  const a = db.prepare('SELECT id FROM users WHERE username = ?').get(user_a);
  const b = db.prepare('SELECT id FROM users WHERE username = ?').get(user_b);
  if (!a || !b) return res.json({ success: true, note: 'one or both users not present locally' });

  db.prepare('INSERT OR IGNORE INTO friendships (user_id, friend_id) VALUES (?, ?)').run(a.id, b.id);
  db.prepare('INSERT OR IGNORE INTO friendships (user_id, friend_id) VALUES (?, ?)').run(b.id, a.id);
  res.json({ success: true });
});

// All routes below require auth
router.use(requireAuth);

// GET /api/friends — list friends with stats
router.get('/', (req, res) => {
  const friends = db.prepare(`
    SELECT u.id, u.username, u.created_at,
      (SELECT COUNT(*) FROM game_results WHERE user_id = u.id) as played,
      (SELECT SUM(CASE WHEN won=1 THEN 1 ELSE 0 END) FROM game_results WHERE user_id = u.id) as won,
      (SELECT AVG(CASE WHEN won=1 THEN score ELSE NULL END) FROM game_results WHERE user_id = u.id) as avgScore
    FROM friendships f
    JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = ?
    ORDER BY u.username COLLATE NOCASE
  `).all(req.user.userId);

  res.json({
    friends: friends.map(f => ({
      userId: f.id,
      username: f.username,
      stats: {
        played: f.played || 0,
        won: f.won || 0,
        winRate: f.played > 0 ? Math.round((f.won / f.played) * 100) : 0,
        avgScore: f.avgScore ? parseFloat(f.avgScore.toFixed(1)) : null,
      }
    }))
  });
});

// POST /api/friends/request — send friend request
router.post('/request', (req, res) => {
  const { username } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'Username is required.' });
  }

  // Find target user
  const target = db.prepare('SELECT id, username FROM users WHERE username = ?').get(username);
  if (!target) {
    return res.status(404).json({ error: 'User not found.' });
  }
  if (target.id === req.user.userId) {
    return res.status(400).json({ error: 'You cannot add yourself as a friend.' });
  }

  // Check if already friends
  const existing = db.prepare(
    'SELECT id FROM friendships WHERE user_id = ? AND friend_id = ?'
  ).get(req.user.userId, target.id);
  if (existing) {
    return res.status(409).json({ error: 'You are already friends with this user.' });
  }

  // Check for existing request (in either direction)
  const existingRequest = db.prepare(
    `SELECT id, status, from_user_id FROM friend_requests
     WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)`
  ).get(req.user.userId, target.id, target.id, req.user.userId);

  if (existingRequest) {
    if (existingRequest.status === 'pending') {
      // If THEY already sent us a request, auto-accept it
      if (existingRequest.from_user_id === target.id) {
        acceptRequest(existingRequest.id, target.id, req.user.userId);
        return res.json({ message: 'Friend request accepted! You are now friends.', status: 'accepted' });
      }
      return res.status(409).json({ error: 'Friend request already pending.' });
    }
    if (existingRequest.status === 'accepted') {
      return res.status(409).json({ error: 'You are already friends with this user.' });
    }
    // If rejected, allow re-sending by deleting old request
    if (existingRequest.status === 'rejected') {
      db.prepare('DELETE FROM friend_requests WHERE id = ?').run(existingRequest.id);
    }
  }

  // Create new request
  const result = db.prepare(
    'INSERT INTO friend_requests (from_user_id, to_user_id, status) VALUES (?, ?, ?)'
  ).run(req.user.userId, target.id, 'pending');

  res.status(201).json({
    requestId: result.lastInsertRowid,
    toUsername: target.username,
    status: 'pending',
  });
});

// GET /api/friends/requests — incoming and outgoing
router.get('/requests', (req, res) => {
  const incoming = db.prepare(`
    SELECT fr.id, fr.from_user_id, u.username as fromUsername, fr.status, fr.created_at
    FROM friend_requests fr
    JOIN users u ON u.id = fr.from_user_id
    WHERE fr.to_user_id = ? AND fr.status = 'pending'
    ORDER BY fr.created_at DESC
  `).all(req.user.userId);

  const outgoing = db.prepare(`
    SELECT fr.id, fr.to_user_id, u.username as toUsername, fr.status, fr.created_at
    FROM friend_requests fr
    JOIN users u ON u.id = fr.to_user_id
    WHERE fr.from_user_id = ? AND fr.status = 'pending'
    ORDER BY fr.created_at DESC
  `).all(req.user.userId);

  res.json({ incoming, outgoing });
});

// POST /api/friends/accept/:id
router.post('/accept/:id', (req, res) => {
  const requestId = parseInt(req.params.id, 10);
  const request = db.prepare(
    'SELECT id, from_user_id, to_user_id, status FROM friend_requests WHERE id = ?'
  ).get(requestId);

  if (!request) {
    return res.status(404).json({ error: 'Friend request not found.' });
  }
  if (request.to_user_id !== req.user.userId) {
    return res.status(403).json({ error: 'You can only accept requests sent to you.' });
  }
  if (request.status !== 'pending') {
    return res.status(400).json({ error: 'This request has already been handled.' });
  }

  acceptRequest(requestId, request.from_user_id, request.to_user_id);

  const friend = db.prepare('SELECT username FROM users WHERE id = ?').get(request.from_user_id);
  res.json({ message: 'Friend request accepted!', friendUsername: friend.username });
});

// POST /api/friends/reject/:id
router.post('/reject/:id', (req, res) => {
  const requestId = parseInt(req.params.id, 10);
  const request = db.prepare(
    'SELECT id, to_user_id, status FROM friend_requests WHERE id = ?'
  ).get(requestId);

  if (!request) {
    return res.status(404).json({ error: 'Friend request not found.' });
  }
  if (request.to_user_id !== req.user.userId) {
    return res.status(403).json({ error: 'You can only reject requests sent to you.' });
  }
  if (request.status !== 'pending') {
    return res.status(400).json({ error: 'This request has already been handled.' });
  }

  db.prepare('UPDATE friend_requests SET status = ? WHERE id = ?').run('rejected', requestId);
  res.json({ message: 'Friend request rejected.' });
});

// DELETE /api/friends/:userId — remove friend
router.delete('/:userId', (req, res) => {
  const friendId = parseInt(req.params.userId, 10);

  // Delete both directions of the friendship
  const deleted = db.prepare(`
    DELETE FROM friendships
    WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
  `).run(req.user.userId, friendId, friendId, req.user.userId);

  if (deleted.changes === 0) {
    return res.status(404).json({ error: 'Friendship not found.' });
  }

  // Also clean up friend request
  db.prepare(`
    DELETE FROM friend_requests
    WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)
  `).run(req.user.userId, friendId, friendId, req.user.userId);

  res.json({ message: 'Friend removed.' });
});

// Helper: accept friend request and create bidirectional friendship
function acceptRequest(requestId, fromUserId, toUserId) {
  db.prepare('UPDATE friend_requests SET status = ? WHERE id = ?').run('accepted', requestId);

  // Insert bidirectional friendship (ignore if already exists)
  db.prepare('INSERT OR IGNORE INTO friendships (user_id, friend_id) VALUES (?, ?)').run(fromUserId, toUserId);
  db.prepare('INSERT OR IGNORE INTO friendships (user_id, friend_id) VALUES (?, ?)').run(toUserId, fromUserId);

  // Cross-sync to sibling app (fire-and-forget). Both users may also
  // exist on the sibling; if so, the friendship gets mirrored there.
  try {
    const a = db.prepare('SELECT username FROM users WHERE id = ?').get(fromUserId);
    const b = db.prepare('SELECT username FROM users WHERE id = ?').get(toUserId);
    if (a && b) crossSyncFriendship(a.username, b.username);
  } catch (_) { /* never let sync errors break local accept */ }
}

module.exports = router;
