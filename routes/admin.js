const express = require('express');
const router = express.Router();
const db = require('../db');

// Simple admin key auth — set ADMIN_KEY env var on Railway
const ADMIN_KEY = process.env.ADMIN_KEY || 'physiodle-admin-2026';

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid admin key' });
  }
  next();
}

// GET /api/admin/users — list all users with stats
router.get('/users', requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT
      u.id,
      u.username,
      u.created_at,
      COUNT(gr.id) as gamesPlayed,
      SUM(CASE WHEN gr.won = 1 THEN 1 ELSE 0 END) as gamesWon,
      SUM(CASE WHEN gr.won = 1 THEN (6 - gr.score) ELSE 0 END) as totalPoints
    FROM users u
    LEFT JOIN game_results gr ON gr.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `).all();

  res.json({
    total: users.length,
    users: users.map(u => ({
      id: u.id,
      username: u.username,
      createdAt: u.created_at,
      gamesPlayed: u.gamesPlayed || 0,
      gamesWon: u.gamesWon || 0,
      totalPoints: u.totalPoints || 0,
      winRate: u.gamesPlayed > 0 ? Math.round((u.gamesWon / u.gamesPlayed) * 100) : 0,
    })),
  });
});

// GET /api/admin/users/:id — single user details
router.get('/users/:id', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id);
  const user = db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const results = db.prepare(`
    SELECT day_number, won, score, completed_at
    FROM game_results WHERE user_id = ?
    ORDER BY day_number DESC
  `).all(userId);

  const friends = db.prepare(`
    SELECT u.id, u.username
    FROM friendships f
    JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = ?
  `).all(userId);

  res.json({
    user: { id: user.id, username: user.username, createdAt: user.created_at },
    gamesPlayed: results.length,
    results: results.map(r => ({
      dayNumber: r.day_number,
      won: !!r.won,
      score: r.score,
      points: r.won ? (6 - r.score) : 0,
      completedAt: r.completed_at,
    })),
    friends,
  });
});

// DELETE /api/admin/users/:id — delete a user and all their data
router.delete('/users/:id', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id);
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // CASCADE handles game_results, friendships, friend_requests
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);

  res.json({ message: `User "${user.username}" (id: ${userId}) deleted successfully` });
});

// GET /api/admin/stats — overall platform stats
router.get('/stats', requireAdmin, (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  const gameCount = db.prepare('SELECT COUNT(*) as cnt FROM game_results').get().cnt;
  const todayGames = db.prepare(`
    SELECT COUNT(*) as cnt FROM game_results
    WHERE date(completed_at) = date('now')
  `).get().cnt;

  res.json({
    totalUsers: userCount,
    totalGamesPlayed: gameCount,
    gamesToday: todayGames,
  });
});

module.exports = router;
