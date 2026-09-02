const express = require('express');
const router = express.Router();
const webpush = require('web-push');
const db = require('../db');
const { optionalAuth } = require('../auth');
const pm = require('../puzzle-manager');

// ---- VAPID keys: env first, else generate once and persist in app_settings so
// a Railway redeploy keeps the same keys (existing subscriptions stay valid).
function loadVapid() {
  let pub = process.env.VAPID_PUBLIC_KEY;
  let priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'vapid'").get();
    if (row) {
      ({ publicKey: pub, privateKey: priv } = JSON.parse(row.value));
    } else {
      const k = webpush.generateVAPIDKeys();
      pub = k.publicKey; priv = k.privateKey;
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('vapid', ?)").run(JSON.stringify(k));
      console.log('[push] generated VAPID keys (stored in app_settings)');
    }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:Physiodle@gmail.com', pub, priv);
  return pub;
}
const VAPID_PUBLIC = loadVapid();

const VALID_TZ = (tz) => { try { Intl.DateTimeFormat('en-AU', { timeZone: tz }); return true; } catch (e) { return false; } };

// "Surprise me": stored as -1, delivered at a different hour each day between
// SURPRISE_FROM and SURPRISE_TO (local time).
const SURPRISE = -1;
const SURPRISE_FROM_MIN = 7 * 60;        // 7:00am
const SURPRISE_TO_MIN = 21 * 60 + 30;    // 9:30pm
// How late a reminder may still be sent, so a restart or a slow sweep catches up
// instead of skipping the day entirely.
const GRACE_MIN = 45;

// Seeded by the DAY ONLY, so every "surprise me" player shares the same moment:
// same local wall-clock time for everyone, a different time each day.
function surpriseMinutes(day) {
  // Math.imul keeps the multiply in 32 bits, and the final >>> 0 makes it
  // unsigned: plain ^ returns a SIGNED int32 and would give negative values.
  let x = Math.imul(day + 1, 2654435761);
  x = Math.imul(x ^ (x >>> 15), 2246822507);
  x = (x ^ (x >>> 13)) >>> 0;
  return SURPRISE_FROM_MIN + (x % (SURPRISE_TO_MIN - SURPRISE_FROM_MIN + 1));
}
function fmtMinutes(m) {
  const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, '0');
  const ampm = h < 12 ? 'am' : 'pm';
  return `${((h + 11) % 12) + 1}:${mm}${ampm}`;
}

// Rotating copy so the daily nudge doesn't read like the same robot every morning.
// Picked by day number, so everyone gets the same one on a given day.
const DAILY_MESSAGES = [
  ['Can you solve today\'s Physiodle?', 'Five clues, five guesses, one diagnosis.'],
  ['A new patient is waiting', 'Can you work out what\'s going on?'],
  ['Today\'s case is ready', 'How early can you call it?'],
  ['What\'s the diagnosis?', 'Today\'s case just went live.'],
  ['Think you can get it first go?', 'Today\'s Physiodle is out.'],
  ['A new case just landed', 'Five clues stand between you and the answer.'],
  ['Your daily case has arrived', 'Read the clues, make the call.'],
  ['Ready to diagnose?', 'Today\'s Physiodle takes about two minutes.'],
  ['One case, five clues', 'See how few you need today.'],
  ['Today\'s patient is in the waiting room', 'Can you work out what\'s wrong?'],
];

// Someone with a streak gets a reason to protect it instead of a generic nudge.
const STREAK_MESSAGES = [
  (n) => [`Your ${n}-day streak is waiting`, 'Today\'s case is ready. Keep it alive.'],
  (n) => [`Don\'t let a ${n}-day streak go`, 'Two minutes and today\'s case is done.'],
  (n) => [`${n} days in a row`, 'Today\'s Physiodle is out. Make it ${n + 1}.'.replace('${n + 1}', String(n + 1))],
];

// Current on-day win streak, same rule as the leaderboard.
function currentStreak(userId) {
  try {
    const today = pm.getCurrentDayNumber();
    const rows = db.prepare(`
      SELECT day_number FROM game_results
      WHERE user_id = ? AND won = 1 AND day_number > ?
        AND completed_at >= DATETIME(DATE('2026-03-04', '+' || (day_number - 1) || ' days'), '-14 hours')
        AND completed_at < DATETIME(DATE('2026-03-04', '+' || (day_number - 1) || ' days'), '+36 hours')
      ORDER BY day_number DESC
    `).all(userId, today - 400);
    const wins = new Set(rows.map(r => r.day_number));
    let d = wins.has(today) ? today : today - 1, n = 0;
    while (d >= 1 && wins.has(d)) { n++; d--; }
    return n;
  } catch (e) { return 0; }
}

function messageFor(day, streak) {
  if (streak >= 3) {
    const pick = STREAK_MESSAGES[day % STREAK_MESSAGES.length];
    const [title, body] = pick(streak);
    return { title, body };
  }
  const [title, body] = DAILY_MESSAGES[day % DAILY_MESSAGES.length];
  return { title, body };
}

router.get('/vapid-public-key', (req, res) => res.json({ key: VAPID_PUBLIC }));

// POST /api/push/subscribe { subscription, hour, tz, platform }
router.post('/subscribe', optionalAuth, (req, res) => {
  const { subscription, hour, tz, platform } = req.body || {};
  if (!subscription || !subscription.endpoint || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  if (String(subscription.endpoint).length > 2000) return res.status(400).json({ error: 'Endpoint too long' });
  // -1 means "surprise me": the sweep picks a different hour each day.
  const raw = parseInt(hour, 10);
  const h = raw === SURPRISE ? SURPRISE : Math.min(Math.max(Number.isFinite(raw) ? raw : 8, 0), 23);
  const zone = (typeof tz === 'string' && tz.length < 64 && VALID_TZ(tz)) ? tz : 'Australia/Sydney';
  const userId = req.user ? req.user.userId : null;
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, hour_local, tz, platform)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id = COALESCE(excluded.user_id, push_subscriptions.user_id),
      p256dh = excluded.p256dh, auth = excluded.auth,
      hour_local = excluded.hour_local, tz = excluded.tz, platform = excluded.platform, failures = 0
  `).run(userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, h, zone, (platform || '').slice(0, 16) || null);
  res.json({ success: true, hour: h, tz: zone });
});

// POST /api/push/unsubscribe { endpoint }
router.post('/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  res.json({ success: true });
});

// GET /api/push/status?endpoint=...  -> is this browser subscribed, and at what hour
router.get('/status', (req, res) => {
  const row = req.query.endpoint
    ? db.prepare('SELECT hour_local, tz FROM push_subscriptions WHERE endpoint = ?').get(req.query.endpoint)
    : null;
  const day = pm.getCurrentDayNumber();
  res.json({
    subscribed: !!row,
    hour: row ? row.hour_local : null,
    tz: row ? row.tz : null,
    surpriseToday: fmtMinutes(surpriseMinutes(day)),
  });
});

// POST /api/push/test — sends a notification to this endpoint now (sandbox/QA aid).
router.post('/test', async (req, res) => {
  const { endpoint } = req.body || {};
  const row = endpoint ? db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint) : null;
  if (!row) return res.status(404).json({ error: 'Not subscribed' });
  try {
    const day = pm.getCurrentDayNumber();
    const msg = messageFor(day, row.user_id ? currentStreak(row.user_id) : 0);
    await sendTo(row, { title: msg.title, body: msg.body + ' (This is a test of your daily reminder.)', tag: 'physiodle-test' });
    res.json({ success: true });
  } catch (e) {
    res.status(502).json({ error: 'Push failed', detail: e.statusCode || e.message });
  }
});

async function sendTo(row, payload) {
  const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
  try {
    await webpush.sendNotification(sub, JSON.stringify({ url: '/?source=push', ...payload }), { TTL: 6 * 3600 });
    if (row.failures) db.prepare('UPDATE push_subscriptions SET failures = 0 WHERE id = ?').run(row.id);
  } catch (e) {
    // 404/410 = subscription gone (user revoked, browser reinstalled). Drop it.
    if (e.statusCode === 404 || e.statusCode === 410) {
      db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
    } else {
      db.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?').run(row.id);
      if (row.failures + 1 >= 10) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
    }
    throw e;
  }
}

// ---- Scheduler: every 10 minutes, find subscriptions whose local hour is now
// and who haven't been reminded for today's puzzle (in their timezone), and
// who haven't already played it. One notification per puzzle per device.
function localMinutesAndDay(tz) {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date());
  const get = (t) => parseInt(parts.find(p => p.type === t).value, 10);
  return { minutes: (get('hour') % 24) * 60 + get('minute'), day: pm.getDayNumberForTimezone(tz) };
}

async function runReminderSweep() {
  const rows = db.prepare('SELECT * FROM push_subscriptions').all();
  let sent = 0;
  for (const row of rows) {
    let lh;
    try { lh = localMinutesAndDay(row.tz); } catch (e) { continue; }
    if (lh.day < 1 || row.last_sent_day === lh.day) continue;
    const target = row.hour_local === SURPRISE ? surpriseMinutes(lh.day) : row.hour_local * 60;
    // Fire from the target moment until the grace window closes, rather than on an
    // exact match: an exact match would be missed whenever the sweep or the server
    // hiccups at that minute.
    if (lh.minutes < target || lh.minutes >= target + GRACE_MIN) continue;
    if (row.user_id) {
      const played = db.prepare('SELECT 1 FROM game_results WHERE user_id = ? AND day_number = ?').get(row.user_id, lh.day);
      if (played) { db.prepare('UPDATE push_subscriptions SET last_sent_day = ? WHERE id = ?').run(lh.day, row.id); continue; }
    }
    db.prepare('UPDATE push_subscriptions SET last_sent_day = ? WHERE id = ?').run(lh.day, row.id);
    try {
      const msg = messageFor(lh.day, row.user_id ? currentStreak(row.user_id) : 0);
      await sendTo(row, { title: msg.title, body: msg.body, tag: `physiodle-day-${lh.day}` });
      sent++;
    } catch (e) { /* logged via failures column */ }
  }
  if (sent) console.log(`[push] reminder sweep sent ${sent}`);
  return sent;
}

let sweepTimer = null;
function startScheduler() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => runReminderSweep().catch(() => {}), 60 * 1000);
  if (sweepTimer.unref) sweepTimer.unref();
}

module.exports = { router, startScheduler, runReminderSweep };
