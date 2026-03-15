const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../db');
const pm = require('../puzzle-manager');

// ── Load equivalence data for match testing ──
const equivData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'equivalences.json'), 'utf8'));
const _equivMap = {};
equivData.equivalenceGroups.forEach(group => {
  const lowerGroup = group.map(t => t.toLowerCase());
  lowerGroup.forEach(term => {
    if (!_equivMap[term]) _equivMap[term] = new Set();
    lowerGroup.forEach(t => _equivMap[term].add(t));
  });
});
const _childMap = {};
const _parentMap = {};
Object.entries(equivData.parentTerms).forEach(([parent, children]) => {
  const lp = parent.toLowerCase();
  _childMap[lp] = children.map(c => c.toLowerCase());
  children.forEach(child => {
    const lc = child.toLowerCase();
    if (!_parentMap[lc]) _parentMap[lc] = new Set();
    _parentMap[lc].add(lp);
  });
});
// Build abbreviation map from all known terms
const _abbrMap = {};
function _buildAbbrMap() {
  const allTerms = new Set();
  equivData.equivalenceGroups.forEach(group => group.forEach(t => allTerms.add(t)));
  Object.keys(equivData.parentTerms).forEach(p => {
    allTerms.add(p);
    equivData.parentTerms[p].forEach(c => allTerms.add(c));
  });
  // Also add all puzzle answers/aliases
  const totalPuzzles = pm.getTotalPuzzles();
  for (let d = 1; d <= totalPuzzles; d++) {
    const p = pm.getRawPuzzle(d);
    if (p) {
      allTerms.add(p.answer);
      if (p.aliases) p.aliases.forEach(a => allTerms.add(a));
    }
  }
  allTerms.forEach(term => {
    const words = term.replace(/[''()-]/g, ' ').split(/\s+/).filter(w => w.length > 0);
    if (words.length < 2) return;
    const abbr1 = words.map(w => w[0]).join('').toLowerCase();
    if (abbr1.length >= 2) {
      if (!_abbrMap[abbr1]) _abbrMap[abbr1] = new Set();
      _abbrMap[abbr1].add(term.toLowerCase());
    }
    const hasAcronym = words.some(w => w === w.toUpperCase() && w.length >= 2 && /^[A-Z]+$/.test(w));
    if (hasAcronym) {
      const abbr2 = words.map(w => (w === w.toUpperCase() && w.length >= 2 && /^[A-Z]+$/.test(w)) ? w : w[0]).join('').toLowerCase();
      if (abbr2.length >= 2 && abbr2 !== abbr1) {
        if (!_abbrMap[abbr2]) _abbrMap[abbr2] = new Set();
        _abbrMap[abbr2].add(term.toLowerCase());
      }
    }
  });
}
_buildAbbrMap();

const QUALIFIERS = /^(acute|chronic|bilateral|unilateral|left|right|mild|moderate|severe|primary|secondary|idiopathic|traumatic|non-traumatic|post-surgical|recurrent|degenerative|adolescent|juvenile|paediatric|pediatric|occupational|exercise-induced|sport-specific|congenital|acquired|partial|complete|high|low)\s+/gi;
function _normalise(str) {
  let s = str.toLowerCase().trim();
  let prev = '';
  while (prev !== s) { prev = s; s = s.replace(QUALIFIERS, '').trim(); }
  return s;
}
const GENERIC_TERMS = new Set([
  'pain','tear','strain','sprain','fracture','injury','syndrome','disease','disorder',
  'dysfunction','rupture','lesion','palsy','bursitis','tendinopathy','tendinitis','tendonitis',
  'arthritis','neuropathy','stenosis','prolapse','impingement','instability','contracture',
  'dislocation','subluxation','contusion','ataxia','vertigo','incontinence','scoliosis',
  'neuroma','cyst','osteoarthritis','osteoporosis','rehabilitation','rehab',
]);

// Server-side checkGuess — returns { result, matchLayer, details }
function _checkGuess(guess, answer, aliases) {
  const g = guess.toLowerCase().trim();
  const ans = answer.toLowerCase();
  const als = (aliases || []).map(a => a.toLowerCase());
  const allValid = [ans, ...als];

  // Layer 1: Exact match
  if (allValid.some(a => g === a)) return { result: 'correct', matchLayer: 'exact', details: `Exact match with "${allValid.find(a => g === a)}"` };

  // Layer 2: Equivalence groups
  for (const valid of allValid) {
    const equivSet = _equivMap[valid];
    if (equivSet && equivSet.has(g)) return { result: 'correct', matchLayer: 'equivalence', details: `"${g}" is equivalent to "${valid}" via equivalence group` };
  }

  // Layer 3: Parent-child
  const guessChildren = _childMap[g];
  if (guessChildren) {
    for (const valid of allValid) {
      if (guessChildren.includes(valid)) return { result: 'correct', matchLayer: 'parent-child', details: `"${g}" is a parent term for "${valid}"` };
      const ansEquiv = _equivMap[valid];
      if (ansEquiv) {
        for (const eq of ansEquiv) {
          if (guessChildren.includes(eq)) return { result: 'correct', matchLayer: 'parent-child+equiv', details: `"${g}" is parent, "${eq}" (equiv of "${valid}") is a child` };
        }
      }
    }
  }

  // Layer 4: Abbreviation matching
  const abbrMatches = _abbrMap[g];
  if (abbrMatches) {
    for (const valid of allValid) {
      if (abbrMatches.has(valid)) return { result: 'correct', matchLayer: 'abbreviation', details: `"${g}" is an abbreviation for "${valid}"` };
      const equivSet = _equivMap[valid];
      if (equivSet) {
        for (const eq of equivSet) {
          if (abbrMatches.has(eq)) return { result: 'correct', matchLayer: 'abbreviation+equiv', details: `"${g}" abbreviates "${eq}" (equiv of "${valid}")` };
        }
      }
    }
  }
  for (const valid of allValid) {
    const revAbbrMatches = _abbrMap[valid];
    if (revAbbrMatches && revAbbrMatches.has(g)) return { result: 'correct', matchLayer: 'abbreviation-reverse', details: `"${valid}" abbreviates to something matching "${g}"` };
  }

  // Layer 5: Substring matching (with generic guard)
  if (!GENERIC_TERMS.has(g)) {
    if (g.length > ans.length && g.includes(ans) && ans.length > 5) return { result: 'correct', matchLayer: 'substring', details: `Guess "${g}" contains answer "${ans}"` };
    if (ans.includes(g) && g.length > 5 && g.length > ans.length * 0.5) return { result: 'correct', matchLayer: 'substring', details: `Answer "${ans}" contains guess "${g}" (len ${g.length}/${ans.length})` };
  }

  // Layer 6: Normalized re-check
  const gNorm = _normalise(g);
  const ansNorm = _normalise(ans);
  const aliasNorms = als.map(a => _normalise(a));
  const allNorms = [ansNorm, ...aliasNorms];

  if (allNorms.some(a => gNorm === a)) return { result: 'correct', matchLayer: 'normalized-exact', details: `After removing qualifiers: "${gNorm}" = "${allNorms.find(a => gNorm === a)}"` };

  for (const norm of allNorms) {
    const equivSet = _equivMap[norm];
    if (equivSet && equivSet.has(gNorm)) return { result: 'correct', matchLayer: 'normalized-equiv', details: `After normalizing: "${gNorm}" equiv to "${norm}"` };
  }

  if (!GENERIC_TERMS.has(gNorm)) {
    if (gNorm.length > ansNorm.length && gNorm.includes(ansNorm) && ansNorm.length > 5) return { result: 'correct', matchLayer: 'normalized-substring', details: `Normalized "${gNorm}" contains "${ansNorm}"` };
    if (ansNorm.includes(gNorm) && gNorm.length > 5 && gNorm.length > ansNorm.length * 0.5) return { result: 'correct', matchLayer: 'normalized-substring', details: `Normalized answer "${ansNorm}" contains "${gNorm}"` };
  }

  return { result: 'incorrect', matchLayer: 'none', details: 'No matching layer accepted this guess' };
}

// Simple admin key auth — set ADMIN_KEY env var on Railway
const ADMIN_KEY = process.env.ADMIN_KEY || 'pharmodle-admin-2026';

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid admin key' });
  }
  next();
}

// GET /api/admin/users — list all users with stats (paginated)
router.get('/users', requireAdmin, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  const total = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;

  const users = db.prepare(`
    SELECT
      u.id,
      u.username,
      u.created_at,
      COUNT(gr.id) as gamesPlayed,
      SUM(CASE WHEN gr.won = 1 THEN 1 ELSE 0 END) as gamesWon,
      SUM(CASE WHEN gr.won = 1 THEN (6 - gr.score) ELSE 0 END) as totalPoints
    FROM users u
    LEFT JOIN game_results gr ON gr.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  res.json({
    total,
    page,
    totalPages: Math.ceil(total / limit),
    users: users.map(u => ({
      id: u.id,
      username: u.username,
      createdAt: u.created_at,
      gamesPlayed: u.gamesPlayed || 0,
      gamesWon: u.gamesWon || 0,
      totalPoints: u.totalPoints || 0,
      winRate: u.gamesPlayed > 0 ? Math.round((u.gamesWon / u.gamesPlayed) * 100) : 0,
    })),
  });
});

// GET /api/admin/users/:id — single user details
router.get('/users/:id', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id);
  const user = db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const results = db.prepare(`
    SELECT day_number, won, score, completed_at
    FROM game_results WHERE user_id = ?
    ORDER BY day_number DESC
  `).all(userId);

  const friends = db.prepare(`
    SELECT u.id, u.username
    FROM friendships f
    JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = ?
  `).all(userId);

  res.json({
    user: { id: user.id, username: user.username, createdAt: user.created_at },
    gamesPlayed: results.length,
    results: results.map(r => ({
      dayNumber: r.day_number,
      won: !!r.won,
      score: r.score,
      points: r.won ? (6 - r.score) : 0,
      completedAt: r.completed_at,
    })),
    friends,
  });
});

// DELETE /api/admin/users/:id — delete a user and all their data
router.delete('/users/:id', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id);
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  res.json({ message: `User "${user.username}" (id: ${userId}) deleted successfully` });
});

// GET /api/admin/stats — overall platform stats
router.get('/stats', requireAdmin, (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  const gameCount = db.prepare('SELECT COUNT(*) as cnt FROM game_results').get().cnt;
  const todayGames = db.prepare(`
    SELECT COUNT(*) as cnt FROM game_results
    WHERE date(completed_at) = date('now')
  `).get().cnt;
  const winCount = db.prepare('SELECT COUNT(*) as cnt FROM game_results WHERE won = 1').get().cnt;

  res.json({
    totalUsers: userCount,
    totalGamesPlayed: gameCount,
    gamesToday: todayGames,
    totalWins: winCount,
    winRate: gameCount > 0 ? Math.round((winCount / gameCount) * 100) : 0,
  });
});

// GET /api/admin/games — paginated game results history
router.get('/games', requireAdmin, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  const total = db.prepare('SELECT COUNT(*) as cnt FROM game_results').get().cnt;

  const games = db.prepare(`
    SELECT gr.id, gr.day_number, gr.won, gr.score, gr.guesses, gr.completed_at,
           u.username
    FROM game_results gr
    JOIN users u ON u.id = gr.user_id
    ORDER BY gr.completed_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  res.json({
    total,
    page,
    totalPages: Math.ceil(total / limit),
    games: games.map(g => ({
      id: g.id,
      username: g.username,
      dayNumber: g.day_number,
      won: !!g.won,
      score: g.score,
      guesses: JSON.parse(g.guesses || '[]'),
      completedAt: g.completed_at,
    })),
  });
});

// GET /api/admin/puzzles — browse puzzles with day mapping
router.get('/puzzles', requireAdmin, (req, res) => {
  const currentDay = pm.getCurrentDayNumber();
  const totalPuzzles = pm.getTotalPuzzles();
  const startDay = Math.max(1, parseInt(req.query.startDay) || currentDay);
  const count = Math.min(50, Math.max(1, parseInt(req.query.count) || 20));

  const puzzleList = [];
  for (let d = startDay; d < startDay + count; d++) {
    const puzzle = pm.getRawPuzzle(d);
    if (puzzle) {
      puzzleList.push({
        dayNumber: d,
        date: _dayToDate(d),
        id: puzzle.id,
        answer: puzzle.answer,
        aliases: puzzle.aliases || [],
        category: puzzle.category,
        domain: puzzle.domain,
        difficulty: puzzle.difficulty,
        clues: puzzle.clues,
        explanation: puzzle.explanation,
      });
    }
  }

  res.json({
    currentDay,
    totalPuzzles,
    startDay,
    puzzles: puzzleList,
  });
});

// Helper: convert day number to calendar date string
function _dayToDate(dayNum) {
  const launch = new Date(Date.UTC(2026, 2, 14)); // March 14, 2026
  const target = new Date(launch.getTime() + (dayNum - 1) * 86400000);
  return target.toISOString().split('T')[0];
}

// POST /api/admin/match-test — test the guess matching logic
router.post('/match-test', requireAdmin, (req, res) => {
  const { guess, answer, aliases } = req.body;
  if (!guess || !answer) return res.status(400).json({ error: 'guess and answer required' });

  const result = _checkGuess(guess, answer, aliases || []);
  res.json(result);
});

// GET /api/admin/match-data — return equivalence groups, parent terms, abbreviation map
router.get('/match-data', requireAdmin, (req, res) => {
  // Convert Sets to arrays for JSON
  const abbrMapJson = {};
  Object.entries(_abbrMap).forEach(([abbr, termSet]) => {
    abbrMapJson[abbr] = [...termSet];
  });
  res.json({
    equivalenceGroups: equivData.equivalenceGroups,
    parentTerms: equivData.parentTerms,
    abbreviationMap: abbrMapJson,
    totalAbbreviations: Object.keys(abbrMapJson).length,
    totalEquivGroups: equivData.equivalenceGroups.length,
    totalParentTerms: Object.keys(equivData.parentTerms).length,
  });
});

module.exports = router;
