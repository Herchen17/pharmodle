const fs = require('fs');
const path = require('path');

// Launch date: March 4, 2026 (day 1) — this is a calendar date, timezone-independent.
// Day N was released on calendar date 2026-03-04 + (N-1) days.
const LAUNCH_YEAR = 2026;
const LAUNCH_MONTH = 2; // 0-indexed: March
const LAUNCH_DATE = 4;

let puzzles = [];
let conditionNames = [];

function loadPuzzles() {
  const filePath = path.join(__dirname, 'data', 'puzzles.json');
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  puzzles = raw.puzzles || raw;

  const nameSet = new Set();
  puzzles.forEach(p => {
    nameSet.add(p.answer);
    if (p.aliases) p.aliases.forEach(a => nameSet.add(a));
  });
  conditionNames = Array.from(nameSet).sort();

  console.log(`Loaded ${puzzles.length} puzzles, ${conditionNames.length} autocomplete conditions`);
}

/**
 * Get the current day number for a given IANA timezone.
 * Uses the SERVER's UTC clock (tamper-proof) + the requested timezone
 * to determine what calendar date it is right now in that timezone.
 *
 * @param {string} [tz] - IANA timezone (e.g. 'Australia/Sydney', 'America/New_York').
 *                         Defaults to 'Australia/Sydney' (AEST/AEDT) if not provided or invalid.
 * @returns {number} Day number (1 = launch day). -1 if before launch.
 */
function getDayNumberForTimezone(tz) {
  const now = new Date(); // Server UTC clock — cannot be manipulated by client

  let dateStr;
  try {
    // Use Intl to get the calendar date in the user's timezone from the SERVER's clock
    // This is the key: server time + user timezone = tamper-proof local date
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'Australia/Sydney',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateStr = formatter.format(now); // Returns 'YYYY-MM-DD' in en-CA locale
  } catch (e) {
    // Invalid timezone — fall back to AEST
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Australia/Sydney',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateStr = formatter.format(now);
  }

  // Parse the date string
  const [y, m, d] = dateStr.split('-').map(Number);

  // Calculate days since launch
  // Both dates as days-since-epoch for clean arithmetic
  const userDay = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  const launchDay = Math.floor(Date.UTC(LAUNCH_YEAR, LAUNCH_MONTH, LAUNCH_DATE) / 86400000);
  const diff = userDay - launchDay;

  if (diff < 0) return -1;
  return diff + 1; // Day 1 = launch day
}

/**
 * Backwards-compatible: get day number using the default timezone (AEST).
 * Used by leaderboard calculations and admin features.
 */
function getCurrentDayNumber() {
  return getDayNumberForTimezone('Australia/Sydney');
}

function getPuzzleForDay(dayNumber) {
  if (dayNumber < 1 || puzzles.length === 0) return null;
  const idx = (dayNumber - 1) % puzzles.length;
  return puzzles[idx];
}

function getTodaysPuzzle(tz) {
  const dayNum = getDayNumberForTimezone(tz);
  if (dayNum < 1) return null;
  return getPuzzleForDay(dayNum);
}

function sanitizePuzzle(puzzle) {
  if (!puzzle) return null;
  return {
    id: puzzle.id,
    answer: puzzle.answer,
    aliases: puzzle.aliases || [],
    acceptable_alternatives: puzzle.acceptable_alternatives || [],
    near_misses: puzzle.near_misses || null,
    category: puzzle.category,
    domain: puzzle.domain || '',
    type: puzzle.type || 'mixed_profile',
    clues: puzzle.clues,
    explanation: puzzle.explanation || '',
    prompt: puzzle.prompt || '',
    walkthrough: puzzle.walkthrough || '',
    unit_values: puzzle.unit_values || [],
  };
}

function fullPuzzle(puzzle) {
  if (!puzzle) return null;
  return {
    id: puzzle.id,
    answer: puzzle.answer,
    aliases: puzzle.aliases || [],
    acceptable_alternatives: puzzle.acceptable_alternatives || [],
    near_misses: puzzle.near_misses || null,
    category: puzzle.category,
    domain: puzzle.domain || '',
    type: puzzle.type || 'mixed_profile',
    clues: puzzle.clues,
    explanation: puzzle.explanation,
    prompt: puzzle.prompt || '',
    walkthrough: puzzle.walkthrough || '',
    unit_values: puzzle.unit_values || [],
  };
}

function getTotalPuzzles() {
  return puzzles.length;
}

function getConditionNames() {
  return conditionNames;
}

function getRawPuzzle(dayNumber) {
  return getPuzzleForDay(dayNumber);
}

module.exports = {
  loadPuzzles,
  getCurrentDayNumber,
  getDayNumberForTimezone,
  getPuzzleForDay,
  getTodaysPuzzle,
  sanitizePuzzle,
  fullPuzzle,
  getTotalPuzzles,
  getConditionNames,
  getRawPuzzle,
};
