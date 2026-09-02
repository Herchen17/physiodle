const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { hashPassword, verifyPassword, generateToken, requireAuth } = require('../auth');

const USERNAME_REGEX = /^[a-zA-Z0-9._-]{2,20}$/;
// Pragmatic email regex — not RFC-strict, but catches 99% of real-world emails.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- Cross-registration with sibling apps ----
// Supports a comma-separated list of sibling URLs (SIBLING_APP_URLS) so signup
// fan-out and login fall-back can hit every -dle in the family. Falls back to
// the singular SIBLING_APP_URL for backward compatibility.
const SIBLING_URLS = (process.env.SIBLING_APP_URLS || process.env.SIBLING_APP_URL || '')
  .split(',')
  .map(s => s.trim().replace(/\/$/, ''))
  .filter(Boolean);
const SIBLING_SECRET = process.env.SIBLING_SECRET || '';

// Fire-and-forget: broadcast signup to every sibling in parallel.
async function crossRegister({ username, email, passwordHash }) {
  if (SIBLING_URLS.length === 0 || !SIBLING_SECRET) return;
  await Promise.allSettled(SIBLING_URLS.map(async (url) => {
    try {
      const resp = await fetch(`${url}/api/auth/cross-register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sibling-secret': SIBLING_SECRET },
        body: JSON.stringify({ username, email, password_hash: passwordHash }),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        const body = await resp.text();
        console.log(`Cross-register to ${url} (${username}): ${resp.status} ${body.slice(0,120)}`);
      }
    } catch (err) {
      console.log(`Cross-register to ${url} failed:`, err.message);
    }
  }));
}

// Ask each sibling in parallel; return the first one that knows this user.
// identifier can be email or username.
async function verifySibling(identifier) {
  if (SIBLING_URLS.length === 0 || !SIBLING_SECRET) return null;
  const attempts = SIBLING_URLS.map(async (url) => {
    try {
      const resp = await fetch(`${url}/api/auth/cross-verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sibling-secret': SIBLING_SECRET },
        body: JSON.stringify({ identifier }),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (err) {
      return null;
    }
  });
  const results = await Promise.all(attempts);
  return results.find(r => r && r.username && r.password_hash) || null;
}

function looksLikeEmail(s) {
  return typeof s === 'string' && s.includes('@');
}

// Look up a user by identifier — tries email first if it looks like one,
// otherwise falls back to username. Used by both login and cross-verify.
function findUserByIdentifier(identifier) {
  if (!identifier) return null;
  if (looksLikeEmail(identifier)) {
    const byEmail = db.prepare('SELECT id, username, email, password_hash FROM users WHERE email = ?').get(identifier);
    if (byEmail) return byEmail;
  }
  return db.prepare('SELECT id, username, email, password_hash FROM users WHERE username = ?').get(identifier);
}

// Rate limiters
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created from this IP. Please try again later.' },
});

// /cross-verify runs app-to-app (not user-facing); still rate-limit as
// defence-in-depth against leaked secrets.
const crossVerifyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many cross-verify requests.' },
});

const TERMS_VERSION = '2026-09-02';
const crypto = require('crypto');
const mailer = require('../mailer');

// ---- Tokens for reset / confirm links ----
function issueToken(userId, purpose, minutes) {
  const raw = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  // One live token per purpose per user: invalidate earlier unused ones.
  db.prepare('UPDATE auth_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND purpose = ? AND used_at IS NULL').run(userId, purpose);
  db.prepare(`INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES (?, ?, ?, DATETIME('now', '+${minutes} minutes'))`).run(userId, purpose, hash);
  return raw;
}
function consumeToken(raw, purpose) {
  if (typeof raw !== 'string' || raw.length < 20 || raw.length > 200) return null;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const row = db.prepare(`SELECT id, user_id FROM auth_tokens WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > DATETIME('now')`).get(hash, purpose);
  if (!row) return null;
  db.prepare('UPDATE auth_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
  return row.user_id;
}
function sendConfirmation(user) {
  if (!user.email) return;
  const token = issueToken(user.id, 'confirm', 60 * 24 * 7);
  mailer.sendEmailConfirmation({ to: user.email, username: user.username, token }).catch(e => console.error('[mail] confirm failed:', e.message));
}

// POST /api/auth/signup
// email is required for new accounts. username stays required for display
// and as a backup identifier.
router.post('/signup', signupLimiter, async (req, res) => {
  try {
    const { username, email, password, marketingConsent, ref } = req.body;
    const consent = marketingConsent ? 1 : 0;
    // Referral attribution: ?ref=<code> stored by the client at first visit.
    let referredBy = null;
    if (typeof ref === 'string' && ref.length <= 24) {
      const referrer = db.prepare('SELECT id, username FROM users WHERE referral_code = ?').get(ref.toLowerCase());
      if (referrer && referrer.username.toLowerCase() !== String(username).toLowerCase()) referredBy = referrer.id;
    }

    if (!username || !USERNAME_REGEX.test(username)) {
      return res.status(400).json({ error: 'Username must be 2-20 characters (letters, numbers, dots, hyphens, underscores).' });
    }
    if (!email || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const passwordHash = await hashPassword(password);

    const result = db.prepare(
      'INSERT INTO users (username, email, password_hash, marketing_consent, consent_updated_at, terms_version, referral_code, referred_by) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?)'
    ).run(username, email, passwordHash, consent, TERMS_VERSION, String(username).toLowerCase(), referredBy);
    const token = generateToken(result.lastInsertRowid, username);

    crossRegister({ username, email, passwordHash });
    sendConfirmation({ id: result.lastInsertRowid, username, email });

    res.status(201).json({
      userId: result.lastInsertRowid,
      username,
      email,
      token,
    });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || (err.message && err.message.includes('UNIQUE'))) {
      const field = err.message && err.message.includes('email') ? 'Email' : 'Username';
      return res.status(409).json({ error: `${field} already taken.` });
    }
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/login
// Accepts `identifier` (email OR username) + password. For backwards
// compatibility also accepts `email` or `username` as the identifier field.
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { identifier, username, email, password } = req.body;
    const id = identifier || email || username;

    if (!id || !password) {
      return res.status(400).json({ error: 'Email (or username) and password required.' });
    }

    let user = findUserByIdentifier(id);

    if (!user) {
      // Not found locally — check sibling app
      const sibling = await verifySibling(id);
      if (sibling) {
        try {
          const result = db.prepare(
            'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)'
          ).run(sibling.username, sibling.email || null, sibling.password_hash);
          user = {
            id: result.lastInsertRowid,
            username: sibling.username,
            email: sibling.email || null,
            password_hash: sibling.password_hash,
          };
        } catch (insertErr) {
          // Race with another simultaneous login; re-query.
          user = findUserByIdentifier(id);
        }
      }
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      // Local hash mismatch — try re-import from sibling in case their
      // password was updated there, or a bcrypt encoding mismatch.
      const sibling = await verifySibling(id);
      if (sibling) {
        const newHash = await hashPassword(password);
        // Also back-fill email if sibling has one and we don't.
        if (sibling.email && !user.email) {
          try {
            db.prepare('UPDATE users SET password_hash = ?, email = ? WHERE id = ?')
              .run(newHash, sibling.email, user.id);
            user.email = sibling.email;
          } catch (e) {
            // Email may already belong to another user locally — just update hash.
            db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);
          }
        } else {
          db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);
        }
        console.log(`[cross-login] re-hashed password for user_id ${user.id}`);
      } else {
        return res.status(401).json({ error: 'Invalid credentials.' });
      }
    }

    const token = generateToken(user.id, user.username);
    res.json({
      userId: user.id,
      username: user.username,
      email: user.email || null,
      token,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/add-email — existing users without email can add one.
// Idempotent: succeeds if already set to same address.
router.post('/add-email', requireAuth, (req, res) => {
  const { email } = req.body;
  if (!email || !EMAIL_REGEX.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  try {
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, req.user.userId);
    // Best-effort: propagate email to sibling (they may or may not have the user).
    try {
      const user = db.prepare('SELECT username, password_hash FROM users WHERE id = ?').get(req.user.userId);
      if (user) crossRegister({ username: user.username, email, passwordHash: user.password_hash });
    } catch (_) { /* ignore */ }
    res.json({ email });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || (err.message && err.message.includes('UNIQUE'))) {
      return res.status(409).json({ error: 'Email already in use.' });
    }
    console.error('add-email error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Sibling app endpoints (called by Physiodle, not by users) ----

// POST /api/auth/cross-register — sibling creates an account here
router.post('/cross-register', async (req, res) => {
  const secret = req.headers['x-sibling-secret'];
  if (!SIBLING_SECRET || secret !== SIBLING_SECRET) {
    return res.status(403).json({ error: 'Invalid sibling secret' });
  }
  const { username, email, password_hash } = req.body;
  if (!username || !password_hash) {
    return res.status(400).json({ error: 'username and password_hash required' });
  }
  try {
    // If we already have this user (by email or username), update rather than insert.
    const existing = email
      ? db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username)
      : db.prepare('SELECT id FROM users WHERE username = ?').get(username);

    if (existing) {
      // Only back-fill email if currently null; never overwrite a local hash
      // (that would let a compromised sibling rewrite local passwords).
      db.prepare(
        'UPDATE users SET email = COALESCE(email, ?) WHERE id = ?'
      ).run(email || null, existing.id);
      return res.json({ success: true, note: 'already exists' });
    }
    db.prepare(
      'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)'
    ).run(username, email || null, password_hash);
    res.status(201).json({ success: true });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || (err.message && err.message.includes('UNIQUE'))) {
      return res.json({ success: true, note: 'already exists' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/cross-verify — sibling looks up user by email/username
// Password verification happens on the calling side.
router.post('/cross-verify', crossVerifyLimiter, async (req, res) => {
  const secret = req.headers['x-sibling-secret'];
  if (!SIBLING_SECRET || secret !== SIBLING_SECRET) {
    return res.status(403).json({ error: 'Invalid sibling secret' });
  }
  // Accept both the new `identifier` and the legacy `username` field.
  const identifier = req.body.identifier || req.body.username;
  if (!identifier) {
    return res.status(400).json({ error: 'identifier required' });
  }
  const user = findUserByIdentifier(identifier);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({
    username: user.username,
    email: user.email || null,
    password_hash: user.password_hash,
  });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, username, email, created_at, profession_level, marketing_consent, referral_code, email_confirmed_at FROM users WHERE id = ?').get(req.user.userId);
  const referrals = db.prepare('SELECT COUNT(*) AS c FROM users WHERE referred_by = ?').get(user.id).c;
  // "Still playing" = referred players with at least one game in the last 14 days.
  const referralsActive = db.prepare(`
    SELECT COUNT(DISTINCT u.id) AS c FROM users u JOIN game_results gr ON gr.user_id = u.id
    WHERE u.referred_by = ? AND gr.completed_at >= DATETIME('now', '-14 days')
  `).get(user.id).c;
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Get stats
  const statsRow = db.prepare(`
    SELECT
      COUNT(*) as played,
      SUM(CASE WHEN won = 1 THEN 1 ELSE 0 END) as won,
      AVG(CASE WHEN won = 1 THEN score ELSE NULL END) as avgScore,
      MIN(CASE WHEN won = 1 THEN score ELSE NULL END) as bestScore,
      SUM(CASE WHEN won = 1 THEN (6 - score) ELSE 0 END) as totalPoints,
      MIN(completed_at) as firstGame,
      MAX(completed_at) as lastGame
    FROM game_results WHERE user_id = ?
  `).get(user.id);

  // Streaks. Same definition as the leaderboard (routes/leaderboard.js):
  // consecutive day numbers with an ON-DAY win, counted back from today.
  // Today doesn't break the streak until it's actually lost or missed.
  // (Previously this counted any consecutive wins including archive play,
  // which disagreed with the number shown on the leaderboard.)
  const pm = require('../puzzle-manager');
  const todayDay = pm.getCurrentDayNumber();
  const onDayWhere = `(
    completed_at >= DATETIME(DATE('2026-03-04', '+' || (day_number - 1) || ' days'), '-14 hours')
    AND completed_at < DATETIME(DATE('2026-03-04', '+' || (day_number - 1) || ' days'), '+36 hours')
  )`;
  const results = db.prepare(`
    SELECT day_number, won, score, completed_at, ${onDayWhere} AS on_day
    FROM game_results WHERE user_id = ? ORDER BY day_number ASC
  `).all(user.id);

  const onDayWins = new Set(results.filter(r => r.won && r.on_day).map(r => r.day_number));
  const onDayPlayed = new Set(results.filter(r => r.on_day).map(r => r.day_number));
  let currentStreak = 0;
  {
    // If today isn't played yet, start counting from yesterday.
    let d = onDayPlayed.has(todayDay) ? todayDay : todayDay - 1;
    while (d >= 1 && onDayWins.has(d)) { currentStreak++; d--; }
  }
  let maxStreak = 0;
  {
    let run = 0, prev = null;
    [...onDayWins].sort((a, b) => a - b).forEach(d => {
      run = (prev !== null && d === prev + 1) ? run + 1 : 1;
      prev = d; maxStreak = Math.max(maxStreak, run);
    });
  }

  // Extra personal stats (chronological, all plays)
  let firstGuessSolves = 0, bestFirstGuessRun = 0, worstRun = 0;
  {
    let fgRun = 0, lossRun = 0;
    results.forEach(r => {
      if (r.won && r.score === 1) { firstGuessSolves++; fgRun++; bestFirstGuessRun = Math.max(bestFirstGuessRun, fgRun); } else fgRun = 0;
      if (!r.won) { lossRun++; worstRun = Math.max(worstRun, lossRun); } else lossRun = 0;
    });
  }
  // Trend: average points (6 - score, 0 for a loss) over the last 30 games vs the 30 before.
  const pts = results.map(r => (r.won ? 6 - r.score : 0));
  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const recentAvg = avg(pts.slice(-30));
  const priorAvg = pts.length > 30 ? avg(pts.slice(-60, -30)) : null;
  const avgGuesses = statsRow.won ? avg(results.filter(r => r.won).map(r => r.score)) : null;

  // Distribution
  const distRows = db.prepare(`
    SELECT score, COUNT(*) as cnt FROM game_results
    WHERE user_id = ? AND won = 1 GROUP BY score
  `).all(user.id);
  const lossCount = db.prepare(
    'SELECT COUNT(*) as cnt FROM game_results WHERE user_id = ? AND won = 0'
  ).get(user.id);

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, X: 0 };
  distRows.forEach(r => { if (r.score >= 1 && r.score <= 5) distribution[r.score] = r.cnt; });
  distribution.X = lossCount.cnt;

  const perfectGames = distribution[1] || 0;

  const friendCount = db.prepare(
    'SELECT COUNT(*) as cnt FROM friendships WHERE user_id = ?'
  ).get(user.id);

  // Leaderboard rank (all-time)
  const onDayCase = `CASE WHEN gr.won = 1 AND (
    gr.completed_at >= DATETIME(DATE('2026-03-04', '+' || (gr.day_number - 1) || ' days'), '-14 hours')
    AND gr.completed_at < DATETIME(DATE('2026-03-04', '+' || (gr.day_number - 1) || ' days'), '+36 hours')
  ) THEN (6 - gr.score) ELSE 0 END`;

  const myPoints = db.prepare(`
    SELECT COALESCE(SUM(${onDayCase}), 0) as pts FROM game_results gr WHERE gr.user_id = ?
  `).get(user.id);

  const rankRow = db.prepare(`
    SELECT COUNT(*) + 1 as rank FROM (
      SELECT gr.user_id, SUM(${onDayCase}) as pts
      FROM game_results gr GROUP BY gr.user_id
      HAVING pts > ?
    )
  `).get(myPoints.pts);

  const totalPlayers = db.prepare('SELECT COUNT(*) as cnt FROM users').get();

  res.json({
    userId: user.id,
    username: user.username,
    email: user.email || null,
    professionLevel: user.profession_level || null,
    marketingConsent: !!user.marketing_consent,
    emailConfirmed: !!user.email_confirmed_at,
    mailEnabled: mailer.MODE !== 'log',
    referralCode: user.referral_code || user.username.toLowerCase(),
    referrals,
    referralsActive,
    createdAt: user.created_at,
    stats: {
      played: statsRow.played,
      won: statsRow.won,
      winRate: statsRow.played > 0 ? Math.round((statsRow.won / statsRow.played) * 100) : 0,
      avgScore: statsRow.avgScore ? parseFloat(statsRow.avgScore.toFixed(1)) : null,
      bestScore: statsRow.bestScore,
      totalPoints: statsRow.totalPoints || 0,
      avgPoints: statsRow.played > 0 ? parseFloat(((statsRow.totalPoints || 0) / statsRow.played).toFixed(1)) : 0,
      currentStreak,
      maxStreak,
      perfectGames,
      firstGuessSolves,
      bestFirstGuessRun,
      worstRun,
      onDayPlayed: onDayPlayed.size,
      avgGuesses: avgGuesses != null ? parseFloat(avgGuesses.toFixed(2)) : null,
      recentAvgPoints: recentAvg != null ? parseFloat(recentAvg.toFixed(2)) : null,
      priorAvgPoints: priorAvg != null ? parseFloat(priorAvg.toFixed(2)) : null,
      distribution,
      firstGame: statsRow.firstGame,
      lastGame: statsRow.lastGame,
      friendCount: friendCount.cnt,
      leaderboardRank: rankRow.rank,
      totalPlayers: totalPlayers.cnt,
    }
  });
});

// ---- Password reset ----
// POST /api/auth/forgot { identifier } — always 200 so it can't be used to probe accounts.
router.post('/forgot', async (req, res) => {
  const { identifier } = req.body || {};
  if (!identifier || typeof identifier !== 'string') return res.status(400).json({ error: 'identifier required' });
  const user = findUserByIdentifier(identifier.trim());
  if (user && user.email) {
    const token = issueToken(user.id, 'reset', 30);
    // Send in the background: the response must not wait on SMTP.
    mailer.sendPasswordReset({ to: user.email, username: user.username, token })
      .catch(e => console.error('[mail] reset failed:', e.message));
  }
  res.json({ success: true, message: 'If that account has an email address, a reset link is on its way.' });
});

// POST /api/auth/reset { token, password }
router.post('/reset', async (req, res) => {
  const { token, password } = req.body || {};
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const userId = consumeToken(token, 'reset');
  if (!userId) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
  const passwordHash = await hashPassword(password);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
  const user = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(userId);
  // A reset link proves control of the inbox, so treat the email as confirmed.
  if (user.email && !db.prepare('SELECT email_confirmed_at FROM users WHERE id = ?').get(userId).email_confirmed_at) {
    db.prepare('UPDATE users SET email_confirmed_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
  }
  const jwt = generateToken(user.id, user.username);
  res.json({ success: true, userId: user.id, username: user.username, email: user.email, token: jwt });
});

// ---- Email confirmation (soft: nothing is gated, it just enables reset) ----
router.post('/send-confirmation', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, username, email, email_confirmed_at FROM users WHERE id = ?').get(req.user.userId);
  if (!user || !user.email) return res.status(400).json({ error: 'No email address on this account.' });
  if (user.email_confirmed_at) return res.json({ success: true, alreadyConfirmed: true });
  // Throttle: one confirmation email per 10 minutes per user.
  const recent = db.prepare(`SELECT 1 FROM auth_tokens WHERE user_id = ? AND purpose = 'confirm' AND created_at > DATETIME('now', '-10 minutes')`).get(user.id);
  if (recent) return res.status(429).json({ error: 'A confirmation email was sent recently. Check your inbox and spam folder.' });
  sendConfirmation(user);
  res.json({ success: true });
});

// GET /api/auth/confirm?token=... — link target from the email; lands back on the game.
router.get('/confirm', (req, res) => {
  const userId = consumeToken(req.query.token, 'confirm');
  if (!userId) return res.redirect('/?confirmed=0');
  db.prepare('UPDATE users SET email_confirmed_at = COALESCE(email_confirmed_at, CURRENT_TIMESTAMP) WHERE id = ?').run(userId);
  res.redirect('/?confirmed=1');
});

// PATCH /api/auth/profile { level } — profession level for profile completion.
const PROFESSION_LEVELS = ['student', 'new_grad', 'physiotherapist', 'educator', 'other_health', 'other'];
router.patch('/profile', requireAuth, (req, res) => {
  const body = req.body || {};
  const out = { success: true };
  if ('level' in body) {
    const { level } = body;
    if (level !== null && level !== undefined && !PROFESSION_LEVELS.includes(level)) {
      return res.status(400).json({ error: 'Invalid level' });
    }
    db.prepare('UPDATE users SET profession_level = ? WHERE id = ?').run(level || null, req.user.userId);
    out.professionLevel = level || null;
  }
  if ('email' in body) {
    const email = String(body.email || '').trim().toLowerCase();
    if (!EMAIL_REGEX.test(email)) return res.status(400).json({ error: 'A valid email address is required.' });
    const taken = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.user.userId);
    if (taken) return res.status(409).json({ error: 'That email is already on another account.' });
    const me = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(req.user.userId);
    if (me.email !== email) {
      // New address: unconfirmed until the link in the email is clicked.
      db.prepare('UPDATE users SET email = ?, email_confirmed_at = NULL WHERE id = ?').run(email, me.id);
      sendConfirmation({ id: me.id, username: me.username, email });
      const hashRow = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(me.id);
      crossRegister({ username: me.username, email, passwordHash: hashRow.password_hash });
    }
    out.email = email;
  }
  if ('marketingConsent' in body) {
    const c = body.marketingConsent ? 1 : 0;
    db.prepare('UPDATE users SET marketing_consent = ?, consent_updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(c, req.user.userId);
    out.marketingConsent = !!c;
  }
  res.json(out);
});

// POST /api/auth/change-password { currentPassword, newPassword }
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  const user = db.prepare('SELECT id, username, email, password_hash FROM users WHERE id = ?').get(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const ok = await verifyPassword(currentPassword || '', user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });
  const passwordHash = await hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
  res.json({ success: true });
});

module.exports = router;
