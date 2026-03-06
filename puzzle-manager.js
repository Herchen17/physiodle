const fs = require('fs');
const path = require('path');

// Launch date: March 4, 2026 in AEST (Australia/Sydney)
// Stored as UTC equivalent: March 3, 2026 14:00 UTC (midnight AEST = UTC-10h)
const LAUNCH_DATE = new Date(Date.UTC(2026, 2, 3, 14, 0, 0)); // months are 0-indexed

// Timezone offset: AEST = UTC+10. Puzzles roll over at midnight AEST.
const TZ_OFFSET_HOURS = 10;

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
  // Get current time in AEST by adding the timezone offset
  const now = new Date();
  const nowAEST = new Date(now.getTime() + TZ_OFFSET_HOURS * 3600000);
  // Zero out the time portion to get start of AEST day
  nowAEST.setUTCHours(0, 0, 0, 0);

  const launch = new Date(LAUNCH_DATE);
  launch.setUTCHours(0, 0, 0, 0);

  const diff = Math.floor((nowAEST - launch) / 86400000);
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
