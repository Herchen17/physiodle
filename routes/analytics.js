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

// ============================================================================
// ADMIN DASHBOARD UI — serves a live HTML dashboard
// Access: /api/analytics/admin?key=YOUR_ADMIN_KEY
// ============================================================================
router.get('/admin', (req, res) => {
  const key = req.query.key;
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).send('<h1>Unauthorized</h1><p>Append ?key=YOUR_ADMIN_KEY to the URL.</p>');
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Physiodle Admin Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; padding: 1.5rem; }
  h1 { font-size: 1.8rem; margin-bottom: 0.25rem; color: #fff; }
  .subtitle { color: #94a3b8; margin-bottom: 1.5rem; font-size: 0.9rem; }
  .refresh-info { color: #64748b; font-size: 0.8rem; margin-bottom: 1rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
  .card { background: #1e293b; border-radius: 12px; padding: 1.25rem; border: 1px solid #334155; }
  .card-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; margin-bottom: 0.5rem; }
  .card-value { font-size: 2rem; font-weight: 700; color: #fff; }
  .card-sub { font-size: 0.8rem; color: #64748b; margin-top: 0.25rem; }
  .section-title { font-size: 1.1rem; font-weight: 600; margin: 1.5rem 0 0.75rem; color: #cbd5e1; }
  table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; border: 1px solid #334155; }
  th { background: #334155; padding: 0.75rem 1rem; text-align: left; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; }
  td { padding: 0.6rem 1rem; border-top: 1px solid #334155; font-size: 0.9rem; }
  tr:hover td { background: #263148; }
  .bar-container { display: flex; align-items: center; gap: 0.5rem; }
  .bar { height: 20px; background: linear-gradient(90deg, #3b82f6, #60a5fa); border-radius: 4px; min-width: 2px; transition: width 0.5s ease; }
  .bar.green { background: linear-gradient(90deg, #22c55e, #4ade80); }
  .bar.orange { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
  .bar.purple { background: linear-gradient(90deg, #8b5cf6, #a78bfa); }
  .device-row { display: flex; gap: 1rem; margin-top: 0.5rem; }
  .device-item { flex: 1; background: #1e293b; border-radius: 12px; padding: 1rem; border: 1px solid #334155; text-align: center; }
  .device-icon { font-size: 2rem; margin-bottom: 0.5rem; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 99px; font-size: 0.7rem; font-weight: 600; }
  .badge-green { background: #166534; color: #4ade80; }
  .badge-blue { background: #1e3a5f; color: #60a5fa; }
  .live-dot { display: inline-block; width: 8px; height: 8px; background: #22c55e; border-radius: 50%; margin-right: 0.5rem; animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  .btn-refresh { background: #3b82f6; color: #fff; border: none; padding: 0.5rem 1rem; border-radius: 8px; cursor: pointer; font-size: 0.85rem; margin-bottom: 1rem; }
  .btn-refresh:hover { background: #2563eb; }
  .header-row { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem; margin-bottom: 1rem; }
  @media (max-width: 600px) { .grid { grid-template-columns: 1fr 1fr; } h1 { font-size: 1.4rem; } }
</style>
</head>
<body>

<div class="header-row">
  <div>
    <h1>Physiodle Analytics</h1>
    <p class="subtitle"><span class="live-dot"></span>Live Dashboard</p>
  </div>
  <button class="btn-refresh" onclick="loadData()">Refresh</button>
</div>
<p class="refresh-info" id="lastRefresh">Loading...</p>

<div class="grid" id="topCards"></div>

<h3 class="section-title">Devices</h3>
<div class="device-row" id="devices"></div>

<h3 class="section-title">Daily Breakdown (Last 14 Days)</h3>
<table id="dailyTable"><thead><tr><th>Date</th><th>Views</th><th>Unique Visitors</th><th></th></tr></thead><tbody></tbody></table>

<h3 class="section-title">Leaderboard Popularity</h3>
<div id="lbPop" style="margin-top:0.5rem;"></div>

<script>
const ADMIN_KEY = new URLSearchParams(window.location.search).get('key');

async function loadData() {
  try {
    const r = await fetch('/api/analytics/dashboard', { headers: { 'x-admin-key': ADMIN_KEY } });
    const d = await r.json();
    renderCards(d);
    renderDevices(d.devices);
    renderDaily(d.dailyBreakdown);
    renderLbPop(d.leaderboardPopularity);
    document.getElementById('lastRefresh').textContent = 'Last refreshed: ' + new Date().toLocaleTimeString();
  } catch (e) {
    document.getElementById('lastRefresh').textContent = 'Error loading data: ' + e.message;
  }
}

function renderCards(d) {
  const cards = [
    { label: 'Page Views Today', value: d.pageViews.today, sub: 'Yesterday: ' + d.pageViews.yesterday },
    { label: 'Unique Visitors Today', value: d.uniqueVisitors.today, sub: 'This week: ' + d.uniqueVisitors.thisWeek },
    { label: 'Total Page Views', value: d.pageViews.total, sub: 'This month: ' + d.pageViews.thisMonth },
    { label: 'Total Unique Visitors', value: d.uniqueVisitors.total, sub: 'This month: ' + d.uniqueVisitors.thisMonth },
    { label: 'Sign-ups Today', value: d.signups.today, sub: 'Total: ' + d.signups.total },
    { label: 'Games Played Today', value: d.gamesPlayed.today, sub: 'Total: ' + d.gamesPlayed.total },
    { label: 'Games This Week', value: d.gamesPlayed.thisWeek, sub: '' },
    { label: 'Sign-ups This Week', value: d.signups.thisWeek, sub: 'This month: ' + d.signups.thisMonth },
  ];
  document.getElementById('topCards').innerHTML = cards.map(c =>
    '<div class="card"><div class="card-label">' + c.label + '</div><div class="card-value">' + c.value + '</div>' + (c.sub ? '<div class="card-sub">' + c.sub + '</div>' : '') + '</div>'
  ).join('');
}

function renderDevices(dev) {
  const total = dev.mobile + dev.desktop || 1;
  document.getElementById('devices').innerHTML =
    '<div class="device-item"><div class="device-icon">&#128241;</div><div class="card-value">' + dev.mobile + '</div><div class="card-label">Mobile</div><div class="card-sub">' + Math.round(dev.mobile/total*100) + '%</div></div>' +
    '<div class="device-item"><div class="device-icon">&#128187;</div><div class="card-value">' + dev.desktop + '</div><div class="card-label">Desktop</div><div class="card-sub">' + Math.round(dev.desktop/total*100) + '%</div></div>';
}

function renderDaily(rows) {
  const tbody = document.querySelector('#dailyTable tbody');
  if (!rows || rows.length === 0) { tbody.innerHTML = '<tr><td colspan="4">No data yet</td></tr>'; return; }
  const maxViews = Math.max(...rows.map(r => r.views), 1);
  tbody.innerHTML = rows.map(r =>
    '<tr><td>' + r.day + '</td><td>' + r.views + '</td><td>' + r.unique_visitors + '</td><td><div class="bar-container"><div class="bar" style="width:' + (r.views/maxViews*200) + 'px"></div></div></td></tr>'
  ).join('');
}

function renderLbPop(rows) {
  const el = document.getElementById('lbPop');
  if (!rows || rows.length === 0) { el.innerHTML = '<p style="color:#64748b">No leaderboard views yet</p>'; return; }
  const maxCount = Math.max(...rows.map(r => r.count), 1);
  const colors = ['green', '', 'orange', 'purple'];
  el.innerHTML = '<div class="grid">' + rows.map((r, i) => {
    const name = (r.event_data || '').replace(/"/g, '');
    return '<div class="card"><div class="card-label">' + name + '</div><div class="card-value">' + r.count + ' <span style="font-size:0.8rem;color:#64748b">views</span></div><div style="margin-top:0.5rem"><div class="bar ' + (colors[i % 4]) + '" style="width:' + (r.count/maxCount*100) + '%"></div></div></div>';
  }).join('') + '</div>';
}

loadData();
setInterval(loadData, 30000); // auto-refresh every 30s
</script>
</body>
</html>`);
});

module.exports = router;
