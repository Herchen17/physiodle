require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const pm = require('./puzzle-manager');

// Load puzzles before starting
pm.loadPuzzles();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/puzzle', require('./routes/puzzles'));
app.use('/api/friends', require('./routes/friends'));
app.use('/api/leaderboard', require('./routes/leaderboard'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    dayNumber: pm.getCurrentDayNumber(),
    totalPuzzles: pm.getTotalPuzzles(),
  });
});

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Physiodle server running on port ${PORT}`);
  console.log(`Day number: ${pm.getCurrentDayNumber()}`);
  console.log(`Total puzzles: ${pm.getTotalPuzzles()}`);
});
