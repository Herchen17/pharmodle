const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, optionalAuth } = require('../auth');
const pm = require('../puzzle-manager');

// GET /api/puzzle/today?tz=Australia/Sydney
router.get('/today', optionalAuth, (req, res) => {
  const tz = req.query.tz || 'Australia/Sydney';
  const dayNumber = pm.getDayNumberForTimezone(tz);
  if (dayNumber < 1) {
    return res.status(404).json({ error: 'Game has not launched yet.' });
  }

  const puzzle = pm.getPuzzleForDay(dayNumber);
  if (!puzzle) {
    return res.status(500).json({ error: 'Could not load puzzle.' });
  }

  // Check if user already completed today's puzzle
  let completed = null;
  if (req.user) {
    const result = db.prepare(
      'SELECT won, score, guesses, completed_at FROM game_results WHERE user_id = ? AND day_number = ?'
    ).get(req.user.userId, dayNumber);
    if (result) {
      completed = {
        won: !!result.won,
        score: result.score,
        guesses: JSON.parse(result.guesses),
        completedAt: result.completed_at,
      };
    }
  }

  const puzzleData = completed
    ? pm.fullPuzzle(puzzle)
    : pm.sanitizePuzzle(puzzle);

  res.json({
    dayNumber,
    totalDays: pm.getCurrentDayNumber(), // Server AEST day for reference
    puzzle: puzzleData,
    completed,
  });
});

// GET /api/puzzle/conditions — autocomplete list
router.get('/conditions', (req, res) => {
  res.json({ conditions: pm.getConditionNames() });
});

// GET /api/puzzle/history — user's completed puzzles (MUST be before /:dayNumber)
router.get('/history/list', requireAuth, (req, res) => {
  const all = req.query.all === 'true';
  const limit = all ? 10000 : Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  const total = db.prepare('SELECT COUNT(*) as cnt FROM game_results WHERE user_id = ?').get(req.user.userId);

  const results = db.prepare(`
    SELECT day_number, puzzle_id, won, score, completed_at
    FROM game_results
    WHERE user_id = ?
    ORDER BY day_number DESC
    LIMIT ? OFFSET ?
  `).all(req.user.userId, limit, offset);

  const enriched = results.map(r => {
    const puzzle = pm.getPuzzleForDay(r.day_number);
    return {
      dayNumber: r.day_number,
      won: !!r.won,
      score: r.score,
      answer: puzzle ? puzzle.answer : null,
      category: puzzle ? puzzle.category : null,
      completedAt: r.completed_at,
    };
  });

  res.json({ total: total.cnt, results: enriched });
});

// GET /api/puzzle/:dayNumber — past puzzle
router.get('/:dayNumber', optionalAuth, (req, res) => {
  const dayNumber = parseInt(req.params.dayNumber, 10);
  if (isNaN(dayNumber) || dayNumber < 1) {
    return res.status(400).json({ error: 'Invalid day number.' });
  }

  // Use client timezone to determine "today" for preventing future access
  const tz = req.query.tz || 'Australia/Sydney';
  const currentDay = pm.getDayNumberForTimezone(tz);
  if (dayNumber > currentDay) {
    return res.status(403).json({ error: 'Future puzzles are not available.' });
  }

  const puzzle = pm.getPuzzleForDay(dayNumber);
  if (!puzzle) {
    return res.status(404).json({ error: 'Puzzle not found.' });
  }

  let completed = null;
  if (req.user) {
    const result = db.prepare(
      'SELECT won, score, guesses, completed_at FROM game_results WHERE user_id = ? AND day_number = ?'
    ).get(req.user.userId, dayNumber);
    if (result) {
      completed = {
        won: !!result.won,
        score: result.score,
        guesses: JSON.parse(result.guesses),
        completedAt: result.completed_at,
      };
    }
  }

  const puzzleData = completed
    ? pm.fullPuzzle(puzzle)
    : pm.sanitizePuzzle(puzzle);

  res.json({
    dayNumber,
    puzzle: puzzleData,
    completed,
  });
});

// POST /api/puzzle/submit — record game result
router.post('/submit', requireAuth, (req, res) => {
  const { dayNumber, won, score, guesses } = req.body;

  if (!dayNumber || typeof won !== 'boolean') {
    return res.status(400).json({ error: 'dayNumber and won are required.' });
  }

  // Use server AEST as the authority for valid day range
  const currentDay = pm.getCurrentDayNumber();
  if (dayNumber > currentDay || dayNumber < 1) {
    return res.status(403).json({ error: 'Invalid day number.' });
  }

  if (won && (score < 1 || score > 5)) {
    return res.status(400).json({ error: 'Score must be 1-5 for a win.' });
  }

  const puzzle = pm.getPuzzleForDay(dayNumber);
  if (!puzzle) {
    return res.status(404).json({ error: 'Puzzle not found.' });
  }

  const existing = db.prepare(
    'SELECT id FROM game_results WHERE user_id = ? AND day_number = ?'
  ).get(req.user.userId, dayNumber);
  if (existing) {
    return res.status(409).json({ error: 'You have already submitted a result for this puzzle.' });
  }

  db.prepare(`
    INSERT INTO game_results (user_id, puzzle_id, day_number, won, score, guesses)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    req.user.userId,
    puzzle.id,
    dayNumber,
    won ? 1 : 0,
    won ? score : null,
    JSON.stringify(guesses || [])
  );

  const fullData = pm.fullPuzzle(puzzle);

  const statsRow = db.prepare(`
    SELECT
      COUNT(*) as played,
      SUM(CASE WHEN won = 1 THEN 1 ELSE 0 END) as wonCount,
      SUM(CASE WHEN won = 1 THEN (6 - score) ELSE 0 END) as totalPoints
    FROM game_results WHERE user_id = ?
  `).get(req.user.userId);

  const results = db.prepare(
    'SELECT day_number, won FROM game_results WHERE user_id = ? ORDER BY day_number ASC'
  ).all(req.user.userId);

  let maxStreak = 0, streak = 0, currentStreak = 0;
  for (const r of results) {
    if (r.won) { streak++; maxStreak = Math.max(maxStreak, streak); }
    else { streak = 0; }
  }
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i].won) currentStreak++;
    else break;
  }

  const gamePoints = won ? (6 - score) : 0;

  res.json({
    answer: fullData.answer,
    aliases: fullData.aliases,
    explanation: fullData.explanation,
    gamePoints,
    stats: {
      played: statsRow.played,
      won: statsRow.wonCount,
      winRate: statsRow.played > 0 ? Math.round((statsRow.wonCount / statsRow.played) * 100) : 0,
      totalPoints: statsRow.totalPoints || 0,
      avgPoints: statsRow.played > 0 ? parseFloat((statsRow.totalPoints / statsRow.played).toFixed(1)) : 0,
      currentStreak,
      maxStreak,
    }
  });
});

module.exports = router;
