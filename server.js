require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const pm = require('./puzzle-manager');

// Load puzzles before starting
pm.loadPuzzles();

const app = express();

// Trust Railway's proxy so rate-limiter can read X-Forwarded-For correctly
app.set('trust proxy', 1);

// ---- Security headers ----
app.use(helmet({
  contentSecurityPolicy: false,   // SPA serves inline scripts; CSP would break it
  crossOriginEmbedderPolicy: false,
}));

// ---- CORS — restrict to our own origin ----
const ALLOWED_ORIGINS = [
  'https://pharmodle.up.railway.app',
  'http://localhost:3000',
];
if (process.env.CORS_ORIGIN) ALLOWED_ORIGINS.push(process.env.CORS_ORIGIN);
app.use(cors({
  origin(origin, cb) {
    // Allow requests with no origin (mobile apps, curl, same-origin)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(null, false);
  },
  credentials: true,
}));

// ---- Body parser with size limit ----
app.use(express.json({ limit: '16kb' }));

// ---- Rate limiters ----
// General API: 100 requests per minute per IP
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

// Auth endpoints (login/signup): 10 per minute per IP
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts. Try again in a minute.' },
});

// Analytics tracking: 30 per minute per IP (page views / events)
const analyticsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limited.' },
});

// Puzzle submit: 20 per minute per IP
const submitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions, please slow down.' },
});

// Apply general limiter to all API routes
app.use('/api/', generalLimiter);
// Tighter limits on sensitive routes
app.use('/api/auth', authLimiter);
app.use('/api/analytics/pageview', analyticsLimiter);
app.use('/api/analytics/event', analyticsLimiter);
app.use('/api/puzzle/submit', submitLimiter);

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/puzzle', require('./routes/puzzles'));
app.use('/api/friends', require('./routes/friends'));
app.use('/api/leaderboard', require('./routes/leaderboard'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/analytics', require('./routes/analytics'));

// Feedback endpoint (simple, inline)
const { optionalAuth } = require('./auth');
const db = require('./db');
app.post('/api/feedback', optionalAuth, (req, res) => {
  const { dayNumber, rating, comment } = req.body;
  if (!dayNumber || !rating) return res.status(400).json({ error: 'dayNumber and rating required' });
  const validRatings = ['love', 'good', 'ok', 'hard', 'easy', 'comment'];
  if (!validRatings.includes(rating)) return res.status(400).json({ error: 'Invalid rating' });
  const userId = req.user ? req.user.userId : null;
  db.prepare('INSERT INTO feedback (user_id, day_number, rating, comment) VALUES (?, ?, ?, ?)').run(userId, dayNumber, rating, (comment || '').slice(0, 500) || null);
  res.json({ success: true });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    dayNumber: pm.getCurrentDayNumber(),
    totalPuzzles: pm.getTotalPuzzles(),
  });
});

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Pharmodle server running on port ${PORT}`);
  console.log(`Day number: ${pm.getCurrentDayNumber()}`);
  console.log(`Total puzzles: ${pm.getTotalPuzzles()}`);
});
