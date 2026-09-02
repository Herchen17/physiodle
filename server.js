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
  'https://physiodle.up.railway.app',
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
app.use('/api/analytics/v2', require('./routes/analytics-v2'));
app.use('/api/admin', require('./routes/admin-user-stats'));
const push = require('./routes/push');
app.use('/api/push', push.router);
push.startScheduler();

// Feedback endpoint (simple, inline)
const { optionalAuth } = require('./auth');
const db = require('./db');
const FEEDBACK_CATEGORIES = ['puzzle_error', 'answer_matching', 'suggestion', 'site_bug', 'praise', 'other'];
const FEEDBACK_ISSUE_TYPES = ['inaccurate', 'ambiguous', 'spoiler', 'too_easy', 'too_hard', 'not_a_diagnosis', 'other'];
const FEEDBACK_PLATFORMS = ['ios', 'android', 'desktop', 'other'];
const FEEDBACK_SCOPE_RE = /^(whole|answer|explanation|clue:[0-4])$/;

app.post('/api/feedback', optionalAuth, (req, res) => {
  const { dayNumber, rating, comment, category, scope, issueType, guess, platform } = req.body;
  if (!dayNumber || !rating) return res.status(400).json({ error: 'dayNumber and rating required' });
  const validRatings = ['love', 'good', 'ok', 'hard', 'easy', 'comment'];
  if (!validRatings.includes(rating)) return res.status(400).json({ error: 'Invalid rating' });

  const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '') || null;
  const cat = clean(category, 32);
  const sc = clean(scope, 16);
  const it = clean(issueType, 32);
  const pl = clean(platform, 16);
  if (cat && !FEEDBACK_CATEGORIES.includes(cat)) return res.status(400).json({ error: 'Invalid category' });
  if (sc && !FEEDBACK_SCOPE_RE.test(sc)) return res.status(400).json({ error: 'Invalid scope' });
  if (it && !FEEDBACK_ISSUE_TYPES.includes(it)) return res.status(400).json({ error: 'Invalid issueType' });
  if (pl && !FEEDBACK_PLATFORMS.includes(pl)) return res.status(400).json({ error: 'Invalid platform' });
  const text = clean(comment, 500);
  const g = clean(guess, 120);
  // A tagged report is useful even without prose; an untagged one is not.
  if (!text && !cat) return res.status(400).json({ error: 'comment or category required' });

  const userId = req.user ? req.user.userId : null;

  // Double-tap guard: identical submission for the same day within 2 minutes
  // (seen in production — two identical comments 1 second apart).
  const dup = db.prepare(`
    SELECT id FROM feedback
    WHERE day_number = ? AND IFNULL(user_id, -1) = IFNULL(?, -1)
      AND IFNULL(comment, '') = IFNULL(?, '') AND IFNULL(category, '') = IFNULL(?, '')
      AND created_at >= DATETIME('now', '-2 minutes')
    LIMIT 1
  `).get(dayNumber, userId, text, cat);
  if (dup) return res.json({ success: true, deduped: true });

  db.prepare(`
    INSERT INTO feedback (user_id, day_number, rating, comment, category, scope, issue_type, guess, platform)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, dayNumber, rating, text, cat, sc, it, g, pl);
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
  console.log(`Physiodle server running on port ${PORT}`);
  console.log(`Day number: ${pm.getCurrentDayNumber()}`);
  console.log(`Total puzzles: ${pm.getTotalPuzzles()}`);
});
