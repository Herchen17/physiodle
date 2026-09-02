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

router.get('/vapid-public-key', (req, res) => res.json({ key: VAPID_PUBLIC }));

// POST /api/push/subscribe { subscription, hour, tz, platform }
router.post('/subscribe', optionalAuth, (req, res) => {
  const { subscription, hour, tz, platform } = req.body || {};
  if (!subscription || !subscription.endpoint || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  if (String(subscription.endpoint).length > 2000) return res.status(400).json({ error: 'Endpoint too long' });
  const h = Math.min(Math.max(parseInt(hour, 10) || 8, 0), 23);
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
  res.json({ subscribed: !!row, hour: row ? row.hour_local : null, tz: row ? row.tz : null });
});

// POST /api/push/test — sends a notification to this endpoint now (sandbox/QA aid).
router.post('/test', async (req, res) => {
  const { endpoint } = req.body || {};
  const row = endpoint ? db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint) : null;
  if (!row) return res.status(404).json({ error: 'Not subscribed' });
  try {
    await sendTo(row, { title: 'Physiodle', body: 'Test notification. Reminders are on.', tag: 'physiodle-test' });
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
function localHourAndDay(tz) {
  const hour = parseInt(new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date()), 10) % 24;
  return { hour, day: pm.getDayNumberForTimezone(tz) };
}

async function runReminderSweep() {
  const rows = db.prepare('SELECT * FROM push_subscriptions').all();
  let sent = 0;
  for (const row of rows) {
    let lh;
    try { lh = localHourAndDay(row.tz); } catch (e) { continue; }
    if (lh.hour !== row.hour_local || lh.day < 1 || row.last_sent_day === lh.day) continue;
    if (row.user_id) {
      const played = db.prepare('SELECT 1 FROM game_results WHERE user_id = ? AND day_number = ?').get(row.user_id, lh.day);
      if (played) { db.prepare('UPDATE push_subscriptions SET last_sent_day = ? WHERE id = ?').run(lh.day, row.id); continue; }
    }
    db.prepare('UPDATE push_subscriptions SET last_sent_day = ? WHERE id = ?').run(lh.day, row.id);
    try {
      await sendTo(row, {
        title: `Physiodle #${lh.day} is ready`,
        body: 'Five clues, five guesses, one diagnosis. Keep the streak alive.',
        tag: `physiodle-day-${lh.day}`,
      });
      sent++;
    } catch (e) { /* logged via failures column */ }
  }
  if (sent) console.log(`[push] reminder sweep sent ${sent}`);
  return sent;
}

let sweepTimer = null;
function startScheduler() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => runReminderSweep().catch(() => {}), 10 * 60 * 1000);
  if (sweepTimer.unref) sweepTimer.unref();
}

module.exports = { router, startScheduler, runReminderSweep };
