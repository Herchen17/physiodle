// Admin v2 data: one endpoint, one time range, every number comparable to the
// previous equal period. Served to /admin-v2.html. The v1 dashboard
// (/api/analytics/dashboard, /admin.html) is untouched.
const express = require('express');
const router = express.Router();
const db = require('../db');
const pm = require('../puzzle-manager');

const ADMIN_KEY = process.env.ADMIN_KEY || 'physiodle-admin-2026';
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Invalid admin key' });
  next();
}
const safe = (fn, fallback) => { try { return fn(); } catch (e) { console.error('[analytics-v2]', e.message); return fallback; } };

// AEST day boundaries as UTC 'YYYY-MM-DD HH:MM:SS' strings (matches how
// created_at / completed_at are stored: CURRENT_TIMESTAMP in UTC).
const TZ_OFFSET_H = 10;
function aestMidnightUtc(daysAgo) {
  const now = new Date();
  const aest = new Date(now.getTime() + TZ_OFFSET_H * 3600000);
  aest.setUTCDate(aest.getUTCDate() - daysAgo);
  aest.setUTCHours(0, 0, 0, 0);
  return new Date(aest.getTime() - TZ_OFFSET_H * 3600000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}
const DAY_EXPR = (col) => `DATE(${col}, '+${TZ_OFFSET_H} hours')`;
const WEEK_EXPR = (col) => `DATE(${col}, '+${TZ_OFFSET_H} hours', 'weekday 1', '-7 days')`; // Monday of that week

// On-day window, same rule as routes/leaderboard.js
const ON_DAY = `(
  completed_at >= DATETIME(DATE('2026-03-04', '+' || (day_number - 1) || ' days'), '-14 hours')
  AND completed_at < DATETIME(DATE('2026-03-04', '+' || (day_number - 1) || ' days'), '+36 hours')
)`;

const RANGES = { '1': 1, '7': 7, '30': 30, '90': 90, '365': 365 };

router.get('/', requireAdmin, (req, res) => {
  const rangeKey = String(req.query.range || '30');
  const all = rangeKey === 'all';
  let days = RANGES[rangeKey] || 30;
  const launch = '2026-03-04 00:00:00';
  if (all) {
    const first = safe(() => db.prepare('SELECT MIN(created_at) AS m FROM page_views').get().m, null) || launch;
    days = Math.max(1, Math.ceil((Date.now() - new Date(first.replace(' ', 'T') + 'Z').getTime()) / 86400000) + 1);
  }
  const from = aestMidnightUtc(days - 1);           // start of range (inclusive)
  const to = aestMidnightUtc(-1);                    // start of tomorrow (exclusive)
  const prevFrom = aestMidnightUtc(2 * days - 1);
  const prevTo = from;

  const count = (sql, ...params) => safe(() => db.prepare(sql).get(...params).c, 0);
  const pair = (sqlRange) => ({
    current: count(sqlRange, from, to),
    previous: all ? null : count(sqlRange, prevFrom, prevTo),
  });

  // ---- Headline KPIs ----
  const kpis = {
    visitors: pair('SELECT COUNT(DISTINCT visitor_id) AS c FROM page_views WHERE created_at >= ? AND created_at < ?'),
    pageviews: pair('SELECT COUNT(*) AS c FROM page_views WHERE created_at >= ? AND created_at < ?'),
    signups: pair('SELECT COUNT(*) AS c FROM users WHERE created_at >= ? AND created_at < ?'),
    games: pair('SELECT COUNT(*) AS c FROM game_results WHERE completed_at >= ? AND completed_at < ?'),
    activePlayers: pair('SELECT COUNT(DISTINCT user_id) AS c FROM game_results WHERE completed_at >= ? AND completed_at < ?'),
    wins: pair('SELECT COUNT(*) AS c FROM game_results WHERE won = 1 AND completed_at >= ? AND completed_at < ?'),
  };

  // ---- Daily series (weekly buckets when the range is long) ----
  const weekly = days > 120;
  const bucket = weekly ? WEEK_EXPR : DAY_EXPR;
  const seriesMap = {};
  const put = (rows, key) => rows.forEach(r => { seriesMap[r.b] = seriesMap[r.b] || { bucket: r.b }; seriesMap[r.b][key] = r.c; });
  put(safe(() => db.prepare(`SELECT ${bucket('created_at')} AS b, COUNT(DISTINCT visitor_id) AS c FROM page_views WHERE created_at >= ? AND created_at < ? GROUP BY b`).all(from, to), []), 'visitors');
  put(safe(() => db.prepare(`SELECT ${bucket('created_at')} AS b, COUNT(*) AS c FROM page_views WHERE created_at >= ? AND created_at < ? GROUP BY b`).all(from, to), []), 'pageviews');
  put(safe(() => db.prepare(`SELECT ${bucket('created_at')} AS b, COUNT(*) AS c FROM users WHERE created_at >= ? AND created_at < ? GROUP BY b`).all(from, to), []), 'signups');
  put(safe(() => db.prepare(`SELECT ${bucket('completed_at')} AS b, COUNT(*) AS c FROM game_results WHERE completed_at >= ? AND completed_at < ? GROUP BY b`).all(from, to), []), 'games');
  put(safe(() => db.prepare(`SELECT ${bucket('completed_at')} AS b, COUNT(DISTINCT user_id) AS c FROM game_results WHERE completed_at >= ? AND completed_at < ? GROUP BY b`).all(from, to), []), 'activePlayers');
  const series = Object.values(seriesMap).sort((a, b) => a.bucket.localeCompare(b.bucket))
    .map(r => ({ bucket: r.bucket, visitors: r.visitors || 0, pageviews: r.pageviews || 0, signups: r.signups || 0, games: r.games || 0, activePlayers: r.activePlayers || 0 }));

  // ---- Funnel for people who arrived in the range ----
  const funnel = {
    visitors: kpis.visitors.current,
    signups: kpis.signups.current,
    firstGame: count(`SELECT COUNT(*) AS c FROM users u WHERE u.created_at >= ? AND u.created_at < ? AND EXISTS (SELECT 1 FROM game_results g WHERE g.user_id = u.id)`, from, to),
    returned: count(`SELECT COUNT(*) AS c FROM users u WHERE u.created_at >= ? AND u.created_at < ? AND EXISTS (SELECT 1 FROM game_results g WHERE g.user_id = u.id AND julianday(g.completed_at) - julianday(u.created_at) >= 1)`, from, to),
  };

  // ---- Weekly signup cohorts, last 12 weeks ----
  const cohorts = safe(() => db.prepare(`
    SELECT ${WEEK_EXPR('u.created_at')} AS week,
           COUNT(*) AS size,
           SUM(CASE WHEN EXISTS (SELECT 1 FROM game_results g WHERE g.user_id = u.id AND julianday(g.completed_at) - julianday(u.created_at) >= 1) THEN 1 ELSE 0 END) AS d1,
           SUM(CASE WHEN EXISTS (SELECT 1 FROM game_results g WHERE g.user_id = u.id AND julianday(g.completed_at) - julianday(u.created_at) >= 7) THEN 1 ELSE 0 END) AS d7,
           SUM(CASE WHEN EXISTS (SELECT 1 FROM game_results g WHERE g.user_id = u.id AND julianday(g.completed_at) - julianday(u.created_at) >= 30) THEN 1 ELSE 0 END) AS d30
    FROM users u WHERE u.created_at >= ?
    GROUP BY week ORDER BY week ASC
  `).all(aestMidnightUtc(12 * 7)), []).map(r => ({
    week: r.week, size: r.size,
    d1: r.size ? Math.round(100 * r.d1 / r.size) : 0,
    d7: r.size ? Math.round(100 * r.d7 / r.size) : 0,
    d30: r.size ? Math.round(100 * r.d30 / r.size) : 0,
    // A cohort younger than N days can't have reached day N yet.
    ageDays: Math.floor((Date.now() - new Date(r.week + 'T00:00:00Z').getTime()) / 86400000),
  }));

  // ---- Streak distribution (current on-day streaks) ----
  const today = pm.getCurrentDayNumber();
  const streakRows = safe(() => db.prepare(`
    SELECT user_id, day_number, won FROM game_results
    WHERE day_number >= ? AND ${ON_DAY}
    ORDER BY user_id, day_number DESC
  `).all(Math.max(1, today - 400)), []);
  const byUser = {};
  streakRows.forEach(r => { (byUser[r.user_id] = byUser[r.user_id] || {})[r.day_number] = r.won; });
  const buckets = { '0': 0, '1-2': 0, '3-6': 0, '7-13': 0, '14-29': 0, '30-99': 0, '100+': 0 };
  let brokeYesterday = 0, activeStreaks = 0;
  Object.values(byUser).forEach(daysMap => {
    let d = daysMap[today] !== undefined ? today : today - 1;
    let streak = 0;
    while (d >= 1 && daysMap[d] === 1) { streak++; d--; }
    if (streak > 0) activeStreaks++;
    const b = streak === 0 ? '0' : streak <= 2 ? '1-2' : streak <= 6 ? '3-6' : streak <= 13 ? '7-13' : streak <= 29 ? '14-29' : streak <= 99 ? '30-99' : '100+';
    buckets[b]++;
    // Broke yesterday: had an on-day win the day before yesterday, then a loss or no play yesterday.
    if (daysMap[today - 2] === 1 && daysMap[today - 1] !== 1) brokeYesterday++;
  });

  // ---- All-time ----
  const allTime = {
    users: count('SELECT COUNT(*) AS c FROM users'),
    games: count('SELECT COUNT(*) AS c FROM game_results'),
    pageviews: count('SELECT COUNT(*) AS c FROM page_views'),
    visitors: count('SELECT COUNT(DISTINCT visitor_id) AS c FROM page_views'),
    firstView: safe(() => db.prepare('SELECT MIN(created_at) AS m FROM page_views').get().m, null),
    dayNumber: today,
    puzzles: pm.getTotalPuzzles(),
    playersWithStreak: activeStreaks,
  };

  // ---- Puzzle quality, last 60 released days ----
  const puzzles = safe(() => db.prepare(`
    SELECT day_number,
           COUNT(*) AS plays,
           SUM(won) AS wins,
           SUM(CASE WHEN won = 1 AND score = 1 THEN 1 ELSE 0 END) AS first_guess,
           AVG(CASE WHEN won = 1 THEN score END) AS avg_guesses
    FROM game_results WHERE day_number > ? AND day_number <= ? AND ${ON_DAY}
    GROUP BY day_number ORDER BY day_number DESC
  `).all(today - 60, today), []).map(r => {
    const p = pm.getPuzzleForDay(r.day_number) || {};
    const reports = safe(() => db.prepare("SELECT category, issue_type, COUNT(*) AS c FROM feedback WHERE day_number = ? GROUP BY category, issue_type").all(r.day_number), []);
    return {
      day: r.day_number, answer: p.answer || '?', category: p.category || '', answerType: p.answer_type || 'diagnosis',
      plays: r.plays, solveRate: r.plays ? Math.round(100 * r.wins / r.plays) : 0,
      firstGuessRate: r.plays ? Math.round(100 * r.first_guess / r.plays) : 0,
      avgGuesses: r.avg_guesses ? Number(r.avg_guesses.toFixed(2)) : null,
      reports: reports.reduce((a, x) => a + x.c, 0),
      reportTags: reports.filter(x => x.category || x.issue_type).map(x => `${x.issue_type || x.category}${x.c > 1 ? ' ×' + x.c : ''}`),
    };
  });

  // ---- Events, feedback, referrals, devices, levels, consent (range) ----
  const events = safe(() => db.prepare('SELECT event_type, COUNT(*) AS c FROM analytics_events WHERE created_at >= ? AND created_at < ? GROUP BY event_type ORDER BY c DESC').all(from, to), []);
  const feedbackByCategory = safe(() => db.prepare("SELECT COALESCE(category, rating) AS k, COUNT(*) AS c FROM feedback WHERE created_at >= ? AND created_at < ? GROUP BY k ORDER BY c DESC").all(from, to), []);
  const topReferrers = safe(() => db.prepare(`
    SELECT r.username, COUNT(*) AS c FROM users u JOIN users r ON u.referred_by = r.id
    WHERE u.created_at >= ? AND u.created_at < ? GROUP BY r.id ORDER BY c DESC LIMIT 10
  `).all(from, to), []);
  const referredSignups = count('SELECT COUNT(*) AS c FROM users WHERE referred_by IS NOT NULL AND created_at >= ? AND created_at < ?', from, to);
  const devices = {
    mobile: count(`SELECT COUNT(DISTINCT visitor_id) AS c FROM page_views WHERE created_at >= ? AND created_at < ? AND (user_agent LIKE '%Mobile%' OR user_agent LIKE '%Android%' OR user_agent LIKE '%iPhone%')`, from, to),
    total: kpis.visitors.current,
  };
  const levels = safe(() => db.prepare('SELECT COALESCE(profession_level, "unset") AS k, COUNT(*) AS c FROM users GROUP BY k ORDER BY c DESC').all(), []);
  const consent = {
    ticked: count('SELECT COUNT(*) AS c FROM users WHERE marketing_consent = 1'),
    withEmail: count('SELECT COUNT(*) AS c FROM users WHERE email IS NOT NULL'),
    confirmed: count('SELECT COUNT(*) AS c FROM users WHERE email_confirmed_at IS NOT NULL'),
    activeSixMonths: count(`SELECT COUNT(DISTINCT user_id) AS c FROM game_results WHERE completed_at >= DATETIME('now', '-180 days')`),
  };
  const pushSubs = count('SELECT COUNT(*) AS c FROM push_subscriptions');

  res.json({
    range: { key: rangeKey, days, from, to, prevFrom: all ? null : prevFrom, prevTo: all ? null : prevTo, weekly },
    generatedAt: new Date().toISOString(),
    kpis, series, funnel, cohorts,
    streaks: { buckets, brokeYesterday, activeStreaks },
    allTime, puzzles, events, feedbackByCategory,
    referrals: { top: topReferrers, referredSignups },
    devices, levels, consent, pushSubs,
  });
});

module.exports = router;
