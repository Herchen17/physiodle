const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Use DATABASE_PATH env var for persistent storage (e.g. Railway volumes)
// Falls back to local file for development
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'physiodle.db');

// Ensure parent directory exists (for volume mounts like /data/)
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

console.log(`Database path: ${dbPath}`);
const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance (may fail on some filesystems)
try { db.pragma('journal_mode = WAL'); } catch (e) { console.log('WAL mode not available, using default journal mode'); }
db.pragma('foreign_keys = ON');

// ==================== SCHEMA ====================
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    email TEXT COLLATE NOCASE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS friend_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id INTEGER NOT NULL,
    to_user_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(from_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(to_user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(from_user_id, to_user_id)
  );

  CREATE TABLE IF NOT EXISTS friendships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    friend_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(friend_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, friend_id)
  );

  CREATE TABLE IF NOT EXISTS game_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    puzzle_id INTEGER NOT NULL,
    day_number INTEGER NOT NULL,
    won INTEGER NOT NULL DEFAULT 0,
    score INTEGER,
    guesses TEXT NOT NULL DEFAULT '[]',
    completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, day_number)
  );

  CREATE INDEX IF NOT EXISTS idx_game_results_user ON game_results(user_id);
  CREATE INDEX IF NOT EXISTS idx_game_results_day ON game_results(day_number);
  CREATE INDEX IF NOT EXISTS idx_game_results_completed ON game_results(completed_at);
  CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships(user_id);
  CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships(friend_id);
  CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_user_id, status);
  CREATE INDEX IF NOT EXISTS idx_friend_requests_from ON friend_requests(from_user_id, status);

  CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor_id TEXT NOT NULL,
    user_id INTEGER,
    path TEXT NOT NULL DEFAULT '/',
    user_agent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_page_views_date ON page_views(created_at);
  CREATE INDEX IF NOT EXISTS idx_page_views_visitor ON page_views(visitor_id);

  CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    event_data TEXT,
    user_id INTEGER,
    visitor_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_analytics_events_type ON analytics_events(event_type);
  CREATE INDEX IF NOT EXISTS idx_analytics_events_date ON analytics_events(created_at);

  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    day_number INTEGER NOT NULL,
    rating TEXT NOT NULL,
    comment TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
  );
`);

// ==================== MIGRATIONS ====================
// CREATE TABLE IF NOT EXISTS skips existing tables, so schema changes to
// pre-existing tables need explicit ALTER TABLE calls. Each migration must
// be idempotent (check before altering).

function columnExists(table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some(r => r.name === column);
}

// 2026-04-29: add email column to users (parity with Pharmodle's
// email-as-identity branch). Existing users keep username-only login;
// new signups capture email; cross-app login works by either.
if (!columnExists('users', 'email')) {
  console.log('[migration] adding users.email column');
  db.exec('ALTER TABLE users ADD COLUMN email TEXT COLLATE NOCASE');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL');

// 2026-09-02: structured feedback. Free-text comments were the only signal;
// players now also tag WHAT the feedback is about (category), WHERE in the
// puzzle (scope), WHAT KIND of problem (issue_type) and, for answer-matching
// complaints, WHICH guess should have been accepted (guess).
// 2026-09-02: profession level (Student / Physiotherapist / Educator ...) for
// profile completion and, later, curriculum-filtered practice.
if (!columnExists('users', 'profession_level')) {
  console.log('[migration] adding users.profession_level column');
  db.exec('ALTER TABLE users ADD COLUMN profession_level TEXT');
}

// 2026-09-02: consent + terms acceptance captured at signup.
for (const [col, type] of [['marketing_consent', 'INTEGER NOT NULL DEFAULT 0'], ['consent_updated_at', 'DATETIME'], ['terms_version', 'TEXT']]) {
  if (!columnExists('users', col)) {
    console.log(`[migration] adding users.${col} column`);
    db.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`);
  }
}

// 2026-09-02: referrals. Every user gets a share code (their username, lower
// case). Sign-ups that arrive via ?ref=<code> record who brought them in.
if (!columnExists('users', 'referral_code')) {
  console.log('[migration] adding users.referral_code / referred_by columns');
  db.exec('ALTER TABLE users ADD COLUMN referral_code TEXT');
  db.exec('ALTER TABLE users ADD COLUMN referred_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
}
db.exec("UPDATE users SET referral_code = LOWER(username) WHERE referral_code IS NULL");
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)');
db.exec('CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by)');

// 2026-09-03: password reset + email confirmation tokens. Only a SHA-256 of
// the token is stored; the raw token lives in the email link only.
db.exec(`
  CREATE TABLE IF NOT EXISTS auth_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    purpose TEXT NOT NULL CHECK(purpose IN ('reset','confirm')),
    token_hash TEXT UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    used_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id, purpose);
`);
if (!columnExists('users', 'email_confirmed_at')) {
  console.log('[migration] adding users.email_confirmed_at column');
  db.exec('ALTER TABLE users ADD COLUMN email_confirmed_at DATETIME');
}

// 2026-09-02: Web Push daily reminders. One row per browser subscription.
// hour_local + tz let the scheduler fire at the player's wall-clock hour.
db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    hour_local INTEGER NOT NULL DEFAULT 8,
    tz TEXT NOT NULL DEFAULT 'Australia/Sydney',
    platform TEXT,
    last_sent_day INTEGER,
    failures INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// 2026-09-03: star rating (1-5) from the feedback form and the Love Physiodle card.
if (!columnExists('feedback', 'stars')) {
  console.log('[migration] adding feedback.stars column');
  db.exec('ALTER TABLE feedback ADD COLUMN stars INTEGER');
}

for (const col of ['category', 'scope', 'issue_type', 'guess', 'platform']) {
  if (!columnExists('feedback', col)) {
    console.log(`[migration] adding feedback.${col} column`);
    db.exec(`ALTER TABLE feedback ADD COLUMN ${col} TEXT`);
  }
}

module.exports = db;
