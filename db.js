const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Use DATABASE_PATH env var for persistent storage (e.g. Railway volumes)
// Falls back to local file for development
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'pharmodle.db');

// Ensure parent directory exists (for volume mounts like /data/)
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

console.log(`Database path: ${dbPath}`);
const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance (may fail on some filesystems)
try { db.pragma('journal_mode = WAL'); } catch (e) { console.log('WAL mode not available, using default journal mode'); }
db.pragma('foreign_keys = ON');

// ==================== SCHEMA ====================
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS friend_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id INTEGER NOT NULL,
    to_user_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(from_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(to_user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(from_user_id, to_user_id)
  );

  CREATE TABLE IF NOT EXISTS friendships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    friend_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(friend_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, friend_id)
  );

  CREATE TABLE IF NOT EXISTS game_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    puzzle_id INTEGER NOT NULL,
    day_number INTEGER NOT NULL,
    won INTEGER NOT NULL DEFAULT 0,
    score INTEGER,
    guesses TEXT NOT NULL DEFAULT '[]',
    completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, day_number)
  );

  CREATE INDEX IF NOT EXISTS idx_game_results_user ON game_results(user_id);
  CREATE INDEX IF NOT EXISTS idx_game_results_day ON game_results(day_number);
  CREATE INDEX IF NOT EXISTS idx_game_results_completed ON game_results(completed_at);
  CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships(user_id);
  CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships(friend_id);
  CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_user_id, status);
  CREATE INDEX IF NOT EXISTS idx_friend_requests_from ON friend_requests(from_user_id, status);

  CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor_id TEXT NOT NULL,
    user_id INTEGER,
    path TEXT NOT NULL DEFAULT '/',
    user_agent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_page_views_date ON page_views(created_at);
  CREATE INDEX IF NOT EXISTS idx_page_views_visitor ON page_views(visitor_id);

  CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    event_data TEXT,
    user_id INTEGER,
    visitor_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_analytics_events_type ON analytics_events(event_type);
  CREATE INDEX IF NOT EXISTS idx_analytics_events_date ON analytics_events(created_at);

  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    day_number INTEGER NOT NULL,
    rating TEXT NOT NULL,
    comment TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
  );
`);

module.exports = db;
