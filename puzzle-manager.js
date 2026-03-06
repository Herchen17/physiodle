const fs = require('fs');
const path = require('path');

// Timezone offset: AEST = UTC+10. Puzzles roll over at midnight AEST.
const TZ_OFFSET_HOURS = 10;

// Launch AEST calendar date: March 4, 2026 (day 1)
// Expressed as days-since-epoch for clean arithmetic
const LAUNCH_AEST_DAY = Math.floor(Date.UTC(2026, 2, 4) / 86400000);

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
  // Server-authoritative: the server decides what day it is, based on AEST.
  // No client timezone input. Tamper-proof.
  const now = new Date();
  // Current AEST calendar day as days-since-epoch
  const nowAESTDay = Math.floor((now.getTime() + TZ_OFFSET_HOURS * 3600000) / 86400000);
  const diff = nowAESTDay - LAUNCH_AEST_DAY;
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
    explanation: puzzle.explanation || '',
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
