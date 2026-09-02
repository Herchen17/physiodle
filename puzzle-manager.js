const fs = require('fs');
const path = require('path');

// Launch date: March 4, 2026 (day 1) — this is a calendar date, timezone-independent.
// Day N was released on calendar date 2026-03-04 + (N-1) days.
const LAUNCH_YEAR = 2026;
const LAUNCH_MONTH = 2; // 0-indexed: March
const LAUNCH_DATE = 4;

let puzzles = [];
let conditionNames = [];
// Distractor vocabulary: real conditions that are NOT answers to any puzzle.
// Shown in the autocomplete so the dropdown no longer leaks the answer set
// (feedback: "the search should include as many options as possible, not
// just the correct answers"). Built from a Wikipedia category crawl and
// de-duplicated against the live matcher; see data/distractors.json.
let distractors = [];

function loadPuzzles() {
  const filePath = path.join(__dirname, 'data', 'puzzles.json');
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  puzzles = raw.puzzles || raw;

  const nameSet = new Set();
  puzzles.forEach(p => {
    nameSet.add(p.answer);
    if (p.aliases) p.aliases.forEach(a => nameSet.add(a));
  });
  conditionNames = Array.from(nameSet).sort();

  try {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'distractors.json'), 'utf8'));
    const lower = new Set(conditionNames.map(n => n.toLowerCase()));
    // Match the answers' Title Case exactly. A casing difference between
    // answers and distractors would tell players which rows are real.
    distractors = (d.terms || []).map(titleCase).filter(t => !lower.has(t.toLowerCase()));
  } catch (e) { distractors = []; }

  console.log(`Loaded ${puzzles.length} puzzles, ${conditionNames.length} autocomplete conditions, ${distractors.length} distractors`);
}

/**
 * Get the current day number for a given IANA timezone.
 * Uses the SERVER's UTC clock (tamper-proof) + the requested timezone
 * to determine what calendar date it is right now in that timezone.
 *
 * @param {string} [tz] - IANA timezone (e.g. 'Australia/Sydney', 'America/New_York').
 *                         Defaults to 'Australia/Sydney' (AEST/AEDT) if not provided or invalid.
 * @returns {number} Day number (1 = launch day). -1 if before launch.
 */
const SMALL_WORDS = new Set(['of', 'and', 'the', 'in', 'on', 'with', 'to', 'for', 'at', 'by', 'or', 'a', 'an', 'du', 'de', 'von', 'van']);
function titleCase(str) {
  return str.split(' ').map((w, i) => {
    if (i > 0 && SMALL_WORDS.has(w.toLowerCase())) return w.toLowerCase();
    if (/^[A-Z0-9]{2,}$/.test(w) || /[A-Z].*[A-Z]/.test(w)) return w; // keep acronyms like ACL, COPD, MCL
    // Capitalise the first letter of each hyphenated / apostrophe part start
    return w.replace(/(^|[-–/])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
  }).join(' ');
}

function getDayNumberForTimezone(tz) {
  const now = new Date(); // Server UTC clock — cannot be manipulated by client

  let dateStr;
  try {
    // Use Intl to get the calendar date in the user's timezone from the SERVER's clock
    // This is the key: server time + user timezone = tamper-proof local date
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'Australia/Sydney',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateStr = formatter.format(now); // Returns 'YYYY-MM-DD' in en-CA locale
  } catch (e) {
    // Invalid timezone — fall back to AEST
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Australia/Sydney',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateStr = formatter.format(now);
  }

  // Parse the date string
  const [y, m, d] = dateStr.split('-').map(Number);

  // Calculate days since launch
  // Both dates as days-since-epoch for clean arithmetic
  const userDay = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  const launchDay = Math.floor(Date.UTC(LAUNCH_YEAR, LAUNCH_MONTH, LAUNCH_DATE) / 86400000);
  const diff = userDay - launchDay;

  if (diff < 0) return -1;
  return diff + 1; // Day 1 = launch day
}

/**
 * Backwards-compatible: get day number using the default timezone (AEST).
 * Used by leaderboard calculations and admin features.
 */
function getCurrentDayNumber() {
  return getDayNumberForTimezone('Australia/Sydney');
}

function getPuzzleForDay(dayNumber) {
  if (dayNumber < 1 || puzzles.length === 0) return null;
  const idx = (dayNumber - 1) % puzzles.length;
  return puzzles[idx];
}

function getTodaysPuzzle(tz) {
  const dayNum = getDayNumberForTimezone(tz);
  if (dayNum < 1) return null;
  return getPuzzleForDay(dayNum);
}

// answer_type tells the client what kind of answer to ask for, so the prompt
// is honest: 'diagnosis' (default), 'procedure' (post-surgical rehab puzzles),
// 'scenario' (management categories such as cardiac rehab, falls) or
// 'pattern' (observed postural patterns such as upper crossed syndrome).
// Added after 12 players complained that "the answer isn't a diagnosis".
function sanitizePuzzle(puzzle) {
  if (!puzzle) return null;
  return {
    id: puzzle.id,
    answer: puzzle.answer,
    aliases: puzzle.aliases || [],
    category: puzzle.category,
    answerType: puzzle.answer_type || 'diagnosis',
    clues: puzzle.clues,
    explanation: puzzle.explanation || '',
  };
}

function fullPuzzle(puzzle) {
  if (!puzzle) return null;
  return {
    id: puzzle.id,
    answer: puzzle.answer,
    aliases: puzzle.aliases || [],
    category: puzzle.category,
    answerType: puzzle.answer_type || 'diagnosis',
    clues: puzzle.clues,
    explanation: puzzle.explanation,
  };
}

function getTotalPuzzles() {
  return puzzles.length;
}

function getConditionNames() {
  return conditionNames.concat(distractors).sort();
}

// Returns one row per puzzle for the autocomplete dropdown. `display` is the
// canonical name shown in the UI; `search` is the full list of strings that
// should match this row when the user types (so spelling variants and aliases
// still find their concept, but only one row per concept is displayed).
function getConditionRows() {
  const rows = [];
  const seen = new Set();
  puzzles.forEach(p => {
    if (!p.answer) return;
    const key = p.answer.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const search = [p.answer];
    if (Array.isArray(p.aliases)) search.push(...p.aliases);
    if (Array.isArray(p.acceptable_alternatives)) search.push(...p.acceptable_alternatives);
    rows.push({ display: p.answer, search });
  });
  distractors.forEach(t => rows.push({ display: t, search: [t] }));
  rows.sort((a, b) => a.display.localeCompare(b.display));
  return rows;
}

function getRawPuzzle(dayNumber) {
  return getPuzzleForDay(dayNumber);
}

module.exports = {
  loadPuzzles,
  getCurrentDayNumber,
  getDayNumberForTimezone,
  getPuzzleForDay,
  getTodaysPuzzle,
  sanitizePuzzle,
  fullPuzzle,
  getTotalPuzzles,
  getConditionNames,
  getConditionRows,
  getRawPuzzle,
};
