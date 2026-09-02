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
  const levels = safe(() => db.prepare("SELECT COALESCE(profession_level, 'unset') AS k, COUNT(*) AS c FROM users GROUP BY k ORDER BY c DESC").all(), []);
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


// ============================================================================
// Chart series with selectable range and bucket (Overview tab)
// ============================================================================
const SERIES_RANGES = { '24h': 1, '7d': 7, '30d': 30, '6m': 183, '1y': 365, 'all': null };
const BUCKET_EXPR = {
  hour: (c) => `strftime('%Y-%m-%d %H:00', ${c}, '+10 hours')`,
  halfday: (c) => `strftime('%Y-%m-%d', ${c}, '+10 hours') || CASE WHEN strftime('%H', ${c}, '+10 hours') < '12' THEN ' 00:00' ELSE ' 12:00' END`,
  day: (c) => `DATE(${c}, '+10 hours')`,
  week: (c) => `DATE(${c}, '+10 hours', 'weekday 1', '-7 days')`,
  month: (c) => `strftime('%Y-%m-01', ${c}, '+10 hours')`,
};
const DEFAULT_BUCKET = { '24h': 'hour', '7d': 'halfday', '30d': 'day', '6m': 'week', '1y': 'week', 'all': 'month' };

router.get('/series', requireAdmin, (req, res) => {
  const rangeKey = SERIES_RANGES.hasOwnProperty(req.query.range) ? req.query.range : '30d';
  let bucketKey = BUCKET_EXPR[req.query.bucket] ? req.query.bucket : DEFAULT_BUCKET[rangeKey];
  if (rangeKey === '24h') bucketKey = 'hour';
  if (rangeKey === '7d' && !['hour', 'halfday', 'day'].includes(bucketKey)) bucketKey = 'halfday';
  const days = SERIES_RANGES[rangeKey];
  const from = rangeKey === '24h'
    ? new Date(Date.now() - 24 * 3600000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
    : days ? aestMidnightUtc(days - 1) : '2026-03-01 00:00:00';
  const b = BUCKET_EXPR[bucketKey];
  const map = {};
  const put = (rows, key) => rows.forEach(r => { map[r.b] = map[r.b] || { bucket: r.b }; map[r.b][key] = r.c; });
  put(safe(() => db.prepare(`SELECT ${b('created_at')} AS b, COUNT(*) AS c FROM page_views WHERE created_at >= ? GROUP BY b`).all(from), []), 'pageviews');
  put(safe(() => db.prepare(`SELECT ${b('created_at')} AS b, COUNT(DISTINCT visitor_id) AS c FROM page_views WHERE created_at >= ? GROUP BY b`).all(from), []), 'visitors');
  put(safe(() => db.prepare(`SELECT ${b('completed_at')} AS b, COUNT(*) AS c FROM game_results WHERE completed_at >= ? GROUP BY b`).all(from), []), 'games');
  put(safe(() => db.prepare(`SELECT ${b('created_at')} AS b, COUNT(*) AS c FROM users WHERE created_at >= ? GROUP BY b`).all(from), []), 'signups');
  const rows = Object.values(map).sort((x, y) => x.bucket.localeCompare(y.bucket))
    .map(r => ({ bucket: r.bucket, pageviews: r.pageviews || 0, visitors: r.visitors || 0, games: r.games || 0, signups: r.signups || 0 }));
  res.json({ range: rangeKey, bucket: bucketKey, from, rows });
});

// ============================================================================
// Feedback list with filters (Feedback tab)
// ============================================================================
router.get('/feedback', requireAdmin, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const where = []; const params = [];
  if (req.query.category) { where.push('f.category = ?'); params.push(String(req.query.category)); }
  if (req.query.day) { where.push('f.day_number = ?'); params.push(parseInt(req.query.day, 10)); }
  if (req.query.q) { where.push('(f.comment LIKE ? OR u.username LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = safe(() => db.prepare(`SELECT COUNT(*) AS c FROM feedback f LEFT JOIN users u ON f.user_id = u.id ${w}`).get(...params).c, 0);
  const rows = safe(() => db.prepare(`
    SELECT f.id, f.day_number, f.rating, f.comment, f.category, f.scope, f.issue_type, f.guess, f.platform, f.created_at, u.username, u.id AS user_id
    FROM feedback f LEFT JOIN users u ON f.user_id = u.id ${w}
    ORDER BY f.created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset), []);
  const puzzle = (d) => { const p = pm.getPuzzleForDay(d); return p ? p.answer : null; };
  res.json({ total, limit, offset, rows: rows.map(r => ({ ...r, answer: puzzle(r.day_number) })) });
});

// ============================================================================
// Players (Players tab): search, detail, actions
// ============================================================================
router.get('/users', requireAdmin, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;
  const q = (req.query.q || '').trim();
  const sortKey = { created: 'u.created_at', games: 'games', points: 'points', username: 'u.username COLLATE NOCASE', last: 'last_game' }[req.query.sort] || 'u.created_at';
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
  const where = q ? 'WHERE u.username LIKE ? OR u.email LIKE ?' : '';
  const params = q ? [`%${q}%`, `%${q}%`] : [];
  const total = safe(() => db.prepare(`SELECT COUNT(*) AS c FROM users u ${where}`).get(...params).c, 0);
  const rows = safe(() => db.prepare(`
    SELECT u.id, u.username, u.email, u.created_at, u.profession_level, u.marketing_consent, u.email_confirmed_at, u.referred_by,
           COUNT(gr.id) AS games, SUM(CASE WHEN gr.won = 1 THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN gr.won = 1 THEN 6 - gr.score ELSE 0 END) AS points, MAX(gr.completed_at) AS last_game
    FROM users u LEFT JOIN game_results gr ON gr.user_id = u.id ${where}
    GROUP BY u.id ORDER BY ${sortKey} ${dir} LIMIT ? OFFSET ?`).all(...params, limit, offset), []);
  res.json({ total, page, totalPages: Math.ceil(total / limit), users: rows.map(u => ({
    id: u.id, username: u.username, email: u.email, createdAt: u.created_at, level: u.profession_level, consent: !!u.marketing_consent,
    emailConfirmed: !!u.email_confirmed_at, referred: !!u.referred_by, games: u.games || 0, wins: u.wins || 0, points: u.points || 0, lastGame: u.last_game,
  })) });
});

router.get('/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = safe(() => db.prepare('SELECT * FROM users WHERE id = ?').get(id), null);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const results = safe(() => db.prepare('SELECT day_number, won, score, completed_at FROM game_results WHERE user_id = ? ORDER BY day_number DESC LIMIT 60').all(id), []);
  const friends = safe(() => db.prepare('SELECT u.id, u.username FROM friendships f JOIN users u ON u.id = f.friend_id WHERE f.user_id = ?').all(id), []);
  const feedback = safe(() => db.prepare('SELECT day_number, comment, category, issue_type, created_at FROM feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(id), []);
  const referrals = safe(() => db.prepare('SELECT id, username, created_at FROM users WHERE referred_by = ? ORDER BY created_at DESC').all(id), []);
  const referrer = u.referred_by ? safe(() => db.prepare('SELECT id, username FROM users WHERE id = ?').get(u.referred_by), null) : null;
  const push = safe(() => db.prepare('SELECT COUNT(*) AS c FROM push_subscriptions WHERE user_id = ?').get(id).c, 0);
  const totals = safe(() => db.prepare('SELECT COUNT(*) AS games, SUM(won) AS wins, SUM(CASE WHEN won = 1 THEN 6 - score ELSE 0 END) AS points FROM game_results WHERE user_id = ?').get(id), {});
  res.json({
    user: { id: u.id, username: u.username, email: u.email, createdAt: u.created_at, level: u.profession_level, consent: !!u.marketing_consent, consentAt: u.consent_updated_at, termsVersion: u.terms_version, emailConfirmed: !!u.email_confirmed_at, emailConfirmedAt: u.email_confirmed_at, referralCode: u.referral_code },
    totals, results: results.map(r => ({ day: r.day_number, won: !!r.won, score: r.score, at: r.completed_at })), friends, feedback, referrals, referrer, pushSubscriptions: push,
  });
});

router.post('/users/:id/resend-confirmation', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = safe(() => db.prepare('SELECT id, username, email, email_confirmed_at FROM users WHERE id = ?').get(id), null);
  if (!u || !u.email) return res.status(400).json({ error: 'No email on this account' });
  if (u.email_confirmed_at) return res.json({ success: true, alreadyConfirmed: true });
  const crypto = require('crypto'); const mailer = require('../mailer');
  const raw = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  db.prepare("UPDATE auth_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND purpose = 'confirm' AND used_at IS NULL").run(id);
  db.prepare("INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES (?, 'confirm', ?, DATETIME('now', '+7 days'))").run(id, hash);
  mailer.sendEmailConfirmation({ to: u.email, username: u.username, token: raw }).then(() => res.json({ success: true })).catch(e => res.status(502).json({ error: e.message }));
});

router.patch('/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  if ('consent' in b) db.prepare('UPDATE users SET marketing_consent = ?, consent_updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(b.consent ? 1 : 0, id);
  if ('emailConfirmed' in b) db.prepare('UPDATE users SET email_confirmed_at = ? WHERE id = ?').run(b.emailConfirmed ? new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') : null, id);
  res.json({ success: true });
});

// CSV of emails for a future newsletter: consented, or inferred-consent (active in N days)
router.get('/emails.csv', requireAdmin, (req, res) => {
  const basis = req.query.basis === 'inferred' ? 'inferred' : 'ticked';
  const activeDays = Math.max(1, parseInt(req.query.activeDays, 10) || 180);
  const rows = basis === 'ticked'
    ? safe(() => db.prepare('SELECT username, email, created_at FROM users WHERE email IS NOT NULL AND marketing_consent = 1 ORDER BY created_at').all(), [])
    : safe(() => db.prepare(`SELECT u.username, u.email, u.created_at FROM users u WHERE u.email IS NOT NULL AND EXISTS (SELECT 1 FROM game_results g WHERE g.user_id = u.id AND g.completed_at >= DATETIME('now', ?)) ORDER BY u.created_at`).all(`-${activeDays} days`), []);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="physiodle-emails-${basis}.csv"`);
  res.send('username,email,joined,basis\n' + rows.map(r => `${JSON.stringify(r.username)},${r.email},${r.created_at},${basis}`).join('\n') + '\n');
});

// ============================================================================
// Health (Health tab)
// ============================================================================
router.get('/health', requireAdmin, (req, res) => {
  const fs = require('fs'); const mailer = require('../mailer');
  const dbPath = process.env.DATABASE_PATH || 'physiodle.db';
  let dbBytes = null; try { dbBytes = fs.statSync(dbPath).size; } catch (e) { /* ignore */ }
  const mem = process.memoryUsage();
  const count = (sql) => safe(() => db.prepare(sql).get().c, null);
  const lastSweep = safe(() => db.prepare('SELECT MAX(last_sent_day) AS d FROM push_subscriptions').get().d, null);
  res.json({
    now: new Date().toISOString(), uptimeSec: Math.round(process.uptime()), node: process.version,
    memoryMb: { rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576) },
    commit: process.env.RAILWAY_GIT_COMMIT_SHA || null, branch: process.env.RAILWAY_GIT_BRANCH || null, deployId: process.env.RAILWAY_DEPLOYMENT_ID || null, region: process.env.RAILWAY_REPLICA_REGION || null,
    db: { path: dbPath, bytes: dbBytes, users: count('SELECT COUNT(*) AS c FROM users'), games: count('SELECT COUNT(*) AS c FROM game_results'), pageViews: count('SELECT COUNT(*) AS c FROM page_views'), events: count('SELECT COUNT(*) AS c FROM analytics_events'), feedback: count('SELECT COUNT(*) AS c FROM feedback'), tokens: count("SELECT COUNT(*) AS c FROM auth_tokens WHERE used_at IS NULL AND expires_at > DATETIME('now')") },
    puzzles: { total: pm.getTotalPuzzles(), day: pm.getCurrentDayNumber(), conditions: pm.getConditionNames().length },
    mail: { mode: mailer.MODE, from: process.env.MAIL_FROM || process.env.MAIL_USER || null, brevoKey: !!process.env.BREVO_API_KEY },
    push: { subscriptions: count('SELECT COUNT(*) AS c FROM push_subscriptions'), lastSentDay: lastSweep, vapid: !!safe(() => db.prepare("SELECT 1 FROM app_settings WHERE key = 'vapid'").get(), null) || !!process.env.VAPID_PUBLIC_KEY, failing: count('SELECT COUNT(*) AS c FROM push_subscriptions WHERE failures > 0') },
    env: { adminKeyCustom: !!process.env.ADMIN_KEY, jwtSecretSet: !!process.env.JWT_SECRET, siblingUrl: process.env.SIBLING_APP_URLS || process.env.SIBLING_APP_URL || null, appUrl: mailer.APP_URL },
  });
});

router.post('/reminder-sweep', requireAdmin, async (req, res) => {
  try { const sent = await require('./push').runReminderSweep(); res.json({ success: true, sent }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
