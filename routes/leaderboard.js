const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, optionalAuth } = require('../auth');

// Helper: get array of friend IDs + self
function getFriendIds(userId) {
  const friends = db.prepare('SELECT friend_id FROM friendships WHERE user_id = ?').all(userId);
  return [userId, ...friends.map(f => f.friend_id)];
}

// Helper: compute current on-day win streak for given users
// Streak = consecutive day_numbers with on-day wins, counting back from today
function computeStreaks(userIds) {
  const pm = require('../puzzle-manager');
  const currentDay = pm.getCurrentDayNumber();
  const onDayExpr = `DATE(gr.completed_at, '+10 hours') = DATE('2026-03-04', '+' || (gr.day_number - 1) || ' days')`;

  const whereUser = userIds
    ? `AND gr.user_id IN (${userIds.map(() => '?').join(',')})`
    : '';
  const params = userIds ? [...userIds] : [];

  // Get all on-day wins, ordered by day descending, for each user
  const rows = db.prepare(`
    SELECT gr.user_id, gr.day_number
    FROM game_results gr
    WHERE gr.won = 1 AND ${onDayExpr} ${whereUser}
    ORDER BY gr.user_id, gr.day_number DESC
  `).all(...params);

  // Group by user
  const byUser = {};
  rows.forEach(r => {
    if (!byUser[r.user_id]) byUser[r.user_id] = [];
    byUser[r.user_id].push(r.day_number);
  });

  // Compute streak: count consecutive days from currentDay backwards
  const streaks = {};
  Object.entries(byUser).forEach(([userId, days]) => {
    let streak = 0;
    let expectedDay = currentDay;
    for (const day of days) {
      if (day === expectedDay) {
        streak++;
        expectedDay--;
      } else if (day < expectedDay) {
        break; // gap found
      }
    }
    streaks[parseInt(userId)] = streak;
  });

  return streaks;
}

// Helper: compute point-based leaderboard
// If userIds is null → global (all users)
// Points: 6 - guessCount for wins, 0 for losses
function computeLeaderboard(userIds, dateFilter, currentUserId) {
  let whereClause = userIds
    ? `WHERE gr.user_id IN (${userIds.map(() => '?').join(',')})`
    : 'WHERE 1=1';

  let params = userIds ? [...userIds] : [];

  if (dateFilter) {
    whereClause += ' AND gr.completed_at >= ? AND gr.completed_at < ?';
    params.push(dateFilter.from, dateFilter.to);
  }

  const limitClause = userIds ? '' : 'LIMIT 200';

  // Only on-day completions count towards ALL leaderboard metrics
  // Puzzle day N was released on 2026-03-04 AEST (= 2026-03-03 14:00 UTC)
  // Convert completed_at (stored in UTC) to AEST by adding 10 hours before comparing
  const onDayExpr = `DATE(gr.completed_at, '+10 hours') = DATE('2026-03-04', '+' || (gr.day_number - 1) || ' days')`;

  const rows = db.prepare(`
    SELECT
      gr.user_id,
      u.username,
      SUM(CASE WHEN ${onDayExpr} THEN 1 ELSE 0 END) as played,
      SUM(CASE WHEN gr.won = 1 AND ${onDayExpr} THEN 1 ELSE 0 END) as won,
      SUM(CASE WHEN gr.won = 1 AND ${onDayExpr} THEN (6 - gr.score) ELSE 0 END) as totalPoints
    FROM game_results gr
    JOIN users u ON u.id = gr.user_id
    ${whereClause}
    GROUP BY gr.user_id
    HAVING played > 0
    ORDER BY
      SUM(CASE WHEN gr.won = 1 AND ${onDayExpr} THEN (6 - gr.score) ELSE 0 END) DESC,
      CAST(SUM(CASE WHEN gr.won = 1 AND ${onDayExpr} THEN 1 ELSE 0 END) AS REAL) /
        NULLIF(SUM(CASE WHEN ${onDayExpr} THEN 1 ELSE 0 END), 0) DESC,
      SUM(CASE WHEN ${onDayExpr} THEN 1 ELSE 0 END) DESC
    ${limitClause}
  `).all(...params);

  // Compute streaks for all users in results
  const resultUserIds = rows.map(r => r.user_id);
  const streaks = resultUserIds.length > 0 ? computeStreaks(resultUserIds) : {};

  return rows.map((r, i) => ({
    rank: i + 1,
    userId: r.user_id,
    username: r.username,
    played: r.played,
    won: r.won,
    winRate: r.played > 0 ? Math.round((r.won / r.played) * 100) : 0,
    totalPoints: r.totalPoints || 0,
    avgPoints: r.played > 0 ? parseFloat(((r.totalPoints || 0) / r.played).toFixed(1)) : 0,
    streak: streaks[r.user_id] || 0,
    isYou: r.user_id === currentUserId,
  }));
}

// GET /api/leaderboard/weekly — this week Mon-Sun
// ?global=true → all users; otherwise friends only (requires auth)
router.get('/weekly', optionalAuth, (req, res) => {
  const isGlobal = req.query.global === 'true';
  if (!isGlobal && !req.user) return res.status(401).json({ error: 'Authentication required' });

  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - ((dayOfWeek + 6) % 7));
  monday.setUTCHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 7);

  const userIds = isGlobal ? null : getFriendIds(req.user.userId);
  const currentUserId = req.user ? req.user.userId : null;
  const entries = computeLeaderboard(userIds, { from: monday.toISOString(), to: sunday.toISOString() }, currentUserId);

  res.json({
    period: `${monday.toISOString().split('T')[0]} to ${new Date(sunday - 86400000).toISOString().split('T')[0]}`,
    entries,
  });
});

// GET /api/leaderboard/monthly — current calendar month
// ?global=true → all users; otherwise friends only (requires auth)
router.get('/monthly', optionalAuth, (req, res) => {
  const isGlobal = req.query.global === 'true';
  if (!isGlobal && !req.user) return res.status(401).json({ error: 'Authentication required' });

  const now = new Date();
  const firstDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const userIds = isGlobal ? null : getFriendIds(req.user.userId);
  const currentUserId = req.user ? req.user.userId : null;
  const entries = computeLeaderboard(userIds, { from: firstDay.toISOString(), to: lastDay.toISOString() }, currentUserId);

  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  res.json({ period: `${monthNames[now.getUTCMonth()]} ${now.getUTCFullYear()}`, entries });
});

// GET /api/leaderboard/yearly — current calendar year
// ?global=true → all users; otherwise friends only (requires auth)
router.get('/yearly', optionalAuth, (req, res) => {
  const isGlobal = req.query.global === 'true';
  if (!isGlobal && !req.user) return res.status(401).json({ error: 'Authentication required' });

  const now = new Date();
  const firstDay = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const lastDay = new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1));

  const userIds = isGlobal ? null : getFriendIds(req.user.userId);
  const currentUserId = req.user ? req.user.userId : null;
  const entries = computeLeaderboard(userIds, { from: firstDay.toISOString(), to: lastDay.toISOString() }, currentUserId);

  res.json({ period: `${now.getUTCFullYear()}`, entries });
});

// GET /api/leaderboard/alltime — all time
// ?global=true → all users; otherwise friends only (requires auth)
router.get('/alltime', optionalAuth, (req, res) => {
  const isGlobal = req.query.global === 'true';
  if (!isGlobal && !req.user) return res.status(401).json({ error: 'Authentication required' });

  const userIds = isGlobal ? null : getFriendIds(req.user.userId);
  const currentUserId = req.user ? req.user.userId : null;
  const entries = computeLeaderboard(userIds, null, currentUserId);

  res.json({ period: 'All Time', entries });
});

module.exports = router;
