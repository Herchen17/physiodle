const fs = require('fs');
const path = require('path');

// Launch date: March 4, 2026 UTC
const LAUNCH_DATE = new Date(Date.UTC(2026, 2, 4)); // months are 0-indexed

let puzzles = [];
let conditionNames = [];

function loadPuzzles() {
  const filePath = path.join(__dirname, 'data', 'puzzles.json');
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  puzzles = raw.puzzles || raw;

  // Build autocomplete condition names from puzzles
  const nameSet = new Set();
  puzzles.forEach(p => {
    nameSet.add(p.answer);
    if (p.aliases) p.aliases.forEach(a => nameSet.add(a));
  });
  conditionNames = Array.from(nameSet).sort();

  console.log(`Loaded ${puzzles.length} puzzles, ${conditionNames.length} autocomplete conditions`);
}

function getCurrentDayNumber() {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  const launch = new Date(LAUNCH_DATE);
  launch.setUTCHours(0, 0, 0, 0);
  const diff = Math.floor((now - launch) / 86400000);
  if (diff < 0) return -1; // Before launch
  return diff + 1; // Day 1 = launch day
}

function getPuzzleForDay(dayNumber) {
  if (dayNumber < 1 || puzzles.length === 0) return null;
  const idx = (dayNumber - 1) % puzzles.length;
  return puzzles[idx];
}

function getTodaysPuzzle() {
  const dayNum = getCurrentDayNumber();
  if (dayNum < 1) return null;
  return getPuzzleForDay(dayNum);
}

// Puzzle for client delivery (includes answer/aliases for client-side matching engine)
// Note: This is a casual game — client-side matching is by design.
// Security is enforced at the day level (can't access future puzzles), not answer level.
function sanitizePuzzle(puzzle) {
  if (!puzzle) return null;
  return {
    id: puzzle.id,
    answer: puzzle.answer,
    aliases: puzzle.aliases || [],
    category: puzzle.category,
    clues: puzzle.clues,
    // explanation intentionally omitted until completion
  };
}

// Full puzzle with answer (for after completion / past puzzles user completed)
function fullPuzzle(puzzle) {
  if (!puzzle) return null;
  return {
    id: puzzle.id,
    answer: puzzle.answer,
    aliases: puzzle.aliases || [],
    category: puzzle.category,
    clues: puzzle.clues,
    explanation: puzzle.explanation,
  };
}

function getTotalPuzzles() {
  return puzzles.length;
}

function getConditionNames() {
  return conditionNames;
}

function getRawPuzzle(dayNumber) {
  return getPuzzleForDay(dayNumber);
}

module.exports = {
  loadPuzzles,
  getCurrentDayNumber,
  getPuzzleForDay,
  getTodaysPuzzle,
  sanitizePuzzle,
  fullPuzzle,
  getTotalPuzzles,
  getConditionNames,
  getRawPuzzle,
};
