const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db');
const { optionalAuth } = require('../auth');

// ============================================================================
// TRACKING ENDPOINTS (called by frontend)
// ============================================================================

// POST /api/analytics/pageview — log a page view
router.post('/pageview', optionalAuth, (req, res) => {
  const { visitorId, path } = req.body;
  if (!visitorId) return res.status(400).json({ error: 'visitorId required' });

  const userId = req.user ? req.user.userId : null;
  const userAgent = (req.headers['user-agent'] || '').slice(0, 500);

  try {
    db.prepare(
      'INSERT INTO page_views (visitor_id, user_id, path, user_agent, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)'
    ).run(visitorId, userId, path || '/', userAgent);
  } catch (e) { /* don't fail the request */ }

  res.json({ ok: true });
});

// POST /api/analytics/event — log a custom event
router.post('/event', optionalAuth, (req, res) => {
  const { visitorId, eventType, eventData } = req.body;
  if (!eventType) return res.status(400).json({ error: 'eventType required' });

  const userId = req.user ? req.user.userId : null;

  try {
    db.prepare(
      'INSERT INTO analytics_events (event_type, event_data, user_id, visitor_id, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)'
    ).run(eventType, eventData ? JSON.stringify(eventData) : null, userId, visitorId || null);
  } catch (e) { /* don't fail */ }

  res.json({ ok: true });
});

// ============================================================================
// ADMIN DASHBOARD (requires admin key)
// ============================================================================

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Invalid admin key' });
  }
  next();
}

// GET /api/analytics/dashboard — full analytics overview
router.get('/dashboard', requireAdmin, (req, res) => {
  const TZ_OFFSET = 10; // AEST

  // Helper: AEST date string for N days ago
  function aestDaysAgo(n) {
    const now = new Date();
    const aest = new Date(now.getTime() + TZ_OFFSET * 3600000);
    aest.setUTCDate(aest.getUTCDate() - n);
    aest.setUTCHours(0, 0, 0, 0);
    const utc = new Date(aest.getTime() - TZ_OFFSET * 3600000);
    return utc.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  }

  const today = aestDaysAgo(0);
  const yesterday = aestDaysAgo(1);
  const weekAgo = aestDaysAgo(7);
  const monthAgo = aestDaysAgo(30);

  // --- Page Views ---
  const pageViewsToday = db.prepare(
    'SELECT COUNT(*) as count FROM page_views WHERE created_at >= ?'
  ).get(today).count;

  const pageViewsYesterday = db.prepare(
    'SELECT COUNT(*) as count FROM page_views WHERE created_at >= ? AND created_at < ?'
  ).get(yesterday, today).count;

  const pageViewsWeek = db.prepare(
    'SELECT COUNT(*) as count FROM page_views WHERE created_at >= ?'
  ).get(weekAgo).count;

  const pageViewsMonth = db.prepare(
    'SELECT COUNT(*) as count FROM page_views WHERE created_at >= ?'
  ).get(monthAgo).count;

  const pageViewsTotal = db.prepare(
    'SELECT COUNT(*) as count FROM page_views'
  ).get().count;

  // --- Unique Visitors ---
  const uniqueToday = db.prepare(
    'SELECT COUNT(DISTINCT visitor_id) as count FROM page_views WHERE created_at >= ?'
  ).get(today).count;

  const uniqueYesterday = db.prepare(
    'SELECT COUNT(DISTINCT visitor_id) as count FROM page_views WHERE created_at >= ? AND created_at < ?'
  ).get(yesterday, today).count;

  const uniqueWeek = db.prepare(
    'SELECT COUNT(DISTINCT visitor_id) as count FROM page_views WHERE created_at >= ?'
  ).get(weekAgo).count;

  const uniqueMonth = db.prepare(
    'SELECT COUNT(DISTINCT visitor_id) as count FROM page_views WHERE created_at >= ?'
  ).get(monthAgo).count;

  const uniqueTotal = db.prepare(
    'SELECT COUNT(DISTINCT visitor_id) as count FROM page_views'
  ).get().count;

  // --- Daily breakdown (last 14 days) ---
  const dailyViews = db.prepare(`
    SELECT DATE(created_at, '+10 hours') as day,
           COUNT(*) as views,
           COUNT(DISTINCT visitor_id) as unique_visitors
    FROM page_views
    WHERE created_at >= ?
    GROUP BY day
    ORDER BY day DESC
  `).all(aestDaysAgo(14));

  // --- Sign-ups vs Anonymous Plays ---
  const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;

  const signupsToday = db.prepare(
    'SELECT COUNT(*) as count FROM users WHERE created_at >= ?'
  ).get(today).count;

  const signupsWeek = db.prepare(
    'SELECT COUNT(*) as count FROM users WHERE created_at >= ?'
  ).get(weekAgo).count;

  const signupsMonth = db.prepare(
    'SELECT COUNT(*) as count FROM users WHERE created_at >= ?'
  ).get(monthAgo).count;

  // Games played by logged-in users vs total page views (proxy for anonymous)
  const gamesPlayedToday = db.prepare(
    'SELECT COUNT(*) as count FROM game_results WHERE completed_at >= ?'
  ).get(today).count;

  const gamesPlayedWeek = db.prepare(
    'SELECT COUNT(*) as count FROM game_results WHERE completed_at >= ?'
  ).get(weekAgo).count;

  const gamesPlayedTotal = db.prepare(
    'SELECT COUNT(*) as count FROM game_results'
  ).get().count;

  // --- Leaderboard Popularity ---
  const leaderboardEvents = db.prepare(`
    SELECT event_data, COUNT(*) as count
    FROM analytics_events
    WHERE event_type = 'leaderboard_view'
    GROUP BY event_data
    ORDER BY count DESC
  `).all();

  // --- Device breakdown (from user agents) ---
  const mobileViews = db.prepare(
    "SELECT COUNT(*) as count FROM page_views WHERE user_agent LIKE '%Mobile%' OR user_agent LIKE '%Android%' OR user_agent LIKE '%iPhone%'"
  ).get().count;

  const desktopViews = pageViewsTotal - mobileViews;

  res.json({
    pageViews: {
      today: pageViewsToday,
      yesterday: pageViewsYesterday,
      thisWeek: pageViewsWeek,
      thisMonth: pageViewsMonth,
      total: pageViewsTotal,
    },
    uniqueVisitors: {
      today: uniqueToday,
      yesterday: uniqueYesterday,
      thisWeek: uniqueWeek,
      thisMonth: uniqueMonth,
      total: uniqueTotal,
    },
    dailyBreakdown: dailyViews,
    signups: {
      today: signupsToday,
      thisWeek: signupsWeek,
      thisMonth: signupsMonth,
      total: totalUsers,
    },
    gamesPlayed: {
      today: gamesPlayedToday,
      thisWeek: gamesPlayedWeek,
      total: gamesPlayedTotal,
    },
    devices: {
      mobile: mobileViews,
      desktop: desktopViews,
    },
    leaderboardPopularity: leaderboardEvents,
  });
});

module.exports = router;
