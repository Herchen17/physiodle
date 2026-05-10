#!/usr/bin/env node
/**
 * Physiodle answer-matcher test harness.
 *
 * Loads the live matcher (extracted from public/index.html) and the live puzzles.json,
 * then runs a battery of positive AND negative test cases. Negative cases guard against
 * over-net matching (e.g. "Cervical Radiculopathy" matching a Lumbar Radiculopathy puzzle).
 *
 * Usage:   node test-matcher.js
 * Exit:    0 if all tests pass, 1 otherwise.
 *
 * Test categories:
 *   - baseline-positive : exact / alias / equivalence / abbreviation / qualifier matches
 *                         that should always pass
 *   - baseline-negative : guesses that should NEVER match (over-net guards)
 *   - feedback-regress  : cases from real user feedback we are trying to fix
 *
 * Each feedback-regress case is tagged with the Sprint 2 phase that should fix it,
 * so when Phase A lands we expect those cases to flip from FAIL -> PASS.
 */

const fs = require('fs');
const path = require('path');

const REPO = __dirname;
const HTML_PATH = path.join(REPO, 'public', 'index.html');
const PUZZLES_PATH = path.join(REPO, 'data', 'puzzles.json');

// --- Extract the matcher block from index.html and evaluate it in a sandbox ---
// We mimic the production setup by stubbing `gameState` and calling `_buildAbbrMap()`
// AFTER seeding `gameState.allConditions` with every puzzle's answer + aliases — that's
// what the live game does at startup, and the abbreviation map only contains derivations
// for terms reachable via that path.
function loadMatcher(allConditions) {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const startMarker = 'const EQUIVALENCE_GROUPS = [';
  const startIdx = html.indexOf(startMarker);
  if (startIdx === -1) throw new Error('cannot find EQUIVALENCE_GROUPS in index.html');
  const endMarker = "      return 'incorrect';\n    }";
  const endIdx = html.indexOf(endMarker, startIdx);
  if (endIdx === -1) throw new Error('cannot find end of checkGuess in index.html');
  const block = html.slice(startIdx, endIdx + endMarker.length);
  const wrapped = `
    const gameState = { allConditions: ${JSON.stringify(allConditions)} };
    ${block}
    _buildAbbrMap();
    return { checkGuess, normalise, EQUIVALENCE_GROUPS };
  `;
  return new Function(wrapped)();
}

// --- Load real puzzles for "real puzzle" tests ---
function loadPuzzles() {
  const data = JSON.parse(fs.readFileSync(PUZZLES_PATH, 'utf8'));
  const arr = Array.isArray(data) ? data : data.puzzles;
  if (!Array.isArray(arr)) throw new Error('puzzles.json has unexpected shape');
  return arr;
}

// --- Helpers for building puzzle stubs (for synthetic tests not tied to a real day) ---
function stubPuzzle(answer, aliases = [], extras = {}) {
  return { answer, aliases, ...extras };
}

const puzzles = loadPuzzles();
// Build the same condition list the live game seeds: every puzzle's answer + aliases.
// This lets _buildAbbrMap derive abbreviations for every diagnosis, matching production.
const allConditions = [];
puzzles.forEach(p => {
  if (p.answer) allConditions.push(p.answer);
  if (Array.isArray(p.aliases)) p.aliases.forEach(a => allConditions.push(a));
});
const matcher = loadMatcher(allConditions);
const { checkGuess } = matcher;

// === TEST CASES ============================================================

const CORRECT = ['correct'];
const ACCEPTABLE = ['acceptable'];
const INCORRECT = ['incorrect'];
const NOT_INCORRECT = ['correct', 'acceptable']; // either is fine for "this should be accepted"

const tests = [];

function t(category, label, puzzle, guess, allowed, phase = null) {
  tests.push({ category, label, puzzle, guess, allowed, phase });
}

// --- baseline-positive: things the matcher should currently get RIGHT ---

t('baseline-positive', 'exact match (case-insensitive)',
  stubPuzzle('Anterior Cruciate Ligament Tear'), 'anterior cruciate ligament tear', CORRECT);

t('baseline-positive', 'alias match',
  stubPuzzle('Lymphoedema', ['Lymphedema']), 'Lymphedema', CORRECT);

t('baseline-positive', 'equivalence group: ACL Tear ↔ ACL Rupture',
  stubPuzzle('Anterior Cruciate Ligament Tear'), 'ACL Rupture', CORRECT);

t('baseline-positive', 'equivalence group: Carpal Tunnel Syndrome ↔ CTS',
  stubPuzzle('Carpal Tunnel Syndrome'), 'CTS', CORRECT);

// Auto-abbreviation only fires for multi-word terms (line 2467 in matcher).
// "ACL Tear" is in EQUIVALENCE_GROUPS as 2 words; abbr-derivation produces
// both "AT" (initials) and "ACLT" (acronym-preserving). The ACL family group means
// any member resolves to any other, so guessing "ACLT" should match a puzzle whose
// answer is "Anterior Cruciate Ligament Tear" (a sibling in the same group).
t('baseline-positive', 'auto-abbreviation: ACLT ↦ Anterior Cruciate Ligament Tear (via ACL Tear sibling)',
  stubPuzzle('Anterior Cruciate Ligament Tear'), 'ACLT', CORRECT);

t('baseline-positive', 'qualifier strip: "Acute Plantar Fasciitis" ↦ Plantar Fasciitis',
  stubPuzzle('Plantar Fasciitis'), 'Acute Plantar Fasciitis', CORRECT);

t('baseline-positive', 'qualifier strip: "Bilateral Carpal Tunnel Syndrome" ↦ CTS',
  stubPuzzle('Carpal Tunnel Syndrome'), 'Bilateral Carpal Tunnel Syndrome', CORRECT);

t('baseline-positive', 'substring: more-specific guess matches general answer',
  stubPuzzle('Lymphoedema'), 'Breast Cancer Lymphoedema', CORRECT);

// --- baseline-negative: things the matcher should NEVER accept (over-net guards) ---

t('baseline-negative', 'different anatomical region: Cervical ≠ Lumbar Radiculopathy',
  stubPuzzle('Cervical Radiculopathy'), 'Lumbar Radiculopathy', INCORRECT);

t('baseline-negative', 'different anatomical region: Lumbar ≠ Cervical Stenosis',
  stubPuzzle('Lumbar Stenosis'), 'Cervical Stenosis', INCORRECT);

t('baseline-negative', 'different ligament: ACL ≠ MCL',
  stubPuzzle('ACL Tear'), 'MCL Tear', INCORRECT);

t('baseline-negative', 'different bone: Calcaneal ≠ Talus Fracture',
  stubPuzzle('Calcaneal Fracture'), 'Talus Fracture', INCORRECT);

// KNOWN OVER-NET (out of Sprint 2 scope, kept as a documented baseline failure):
// the substring rule in checkGuess accepts "fasciitis" as matching "Plantar Fasciitis"
// because g.length (9) > answer.length * 0.5 (8.5). Adding "fasciitis" to GENERIC_TERMS
// is a small, safe future fix — flagged here so it's not forgotten.
t('baseline-negative', 'generic term alone should not match a specific diagnosis',
  stubPuzzle('Plantar Fasciitis'), 'fasciitis', INCORRECT);

// Crucial guard for revised Phase B: per-puzzle alias for Lumbar DDD on Day 47,
// must NOT make Cervical DDD also match.
t('baseline-negative', 'Cervical DDD must NOT match Day 47 (Degenerative Disc Disease) puzzle',
  stubPuzzle('Degenerative Disc Disease', ['Disc Degeneration', 'DDD']), 'Cervical DDD', INCORRECT);

// --- feedback-regress: real complaints we're trying to fix ---

// Phase A — hyphen normalization
t('feedback-regress', '[Phase A] "Post ACL Reconstruction" (no hyphen) should match Day 1',
  puzzles[0], 'Post ACL Reconstruction', CORRECT, 'A');

t('feedback-regress', '[Phase A] "post-acl reconstruction" should match Day 1 (already works)',
  puzzles[0], 'post-acl reconstruction', CORRECT, 'A');

t('feedback-regress', '[Phase A] "Post ACLR" (no hyphen) should match Day 1',
  puzzles[0], 'Post ACLR', CORRECT, 'A');

t('feedback-regress', '[Phase A] hyphenated qualifier still strips: "Post Surgical Knee" ≡ "Post-Surgical Knee"',
  stubPuzzle('Post-Surgical Knee Stiffness'), 'Post Surgical Knee Stiffness', CORRECT, 'A');

// Phase B — Day 47 per-puzzle alias for Lumbar DDD
t('feedback-regress', '[Phase B] "Lumbar DDD" should match Day 47 (Degenerative Disc Disease)',
  puzzles[46], 'Lumbar DDD', CORRECT, 'B');

t('feedback-regress', '[Phase B] "Lumbar Degenerative Disc Disease" should match Day 47',
  puzzles[46], 'Lumbar Degenerative Disc Disease', CORRECT, 'B');

// Phase C — Day 5 Female Athlete Triad aliases
t('feedback-regress', '[Phase C] "Female Athlete Triad" should match Day 5 (Overtraining Syndrome)',
  puzzles[4], 'Female Athlete Triad', CORRECT, 'C');

t('feedback-regress', '[Phase C] "Female Athletic Triad" should match Day 5',
  puzzles[4], 'Female Athletic Triad', CORRECT, 'C');

// Phase C — Day 57 (WRULD) accepts Carpal Tunnel as acceptable
t('feedback-regress', '[Phase C] "Carpal Tunnel Syndrome" should be ACCEPTABLE for Day 57 (WRULD)',
  puzzles[56], 'Carpal Tunnel Syndrome', NOT_INCORRECT, 'C');

// Negative regression: Female Athlete Triad must NOT match a different puzzle just because we added the alias
t('feedback-regress', '[Phase C guard] "Female Athlete Triad" should NOT match a Plantar Fasciitis puzzle',
  stubPuzzle('Plantar Fasciitis'), 'Female Athlete Triad', INCORRECT, 'C');

// === RUNNER ================================================================

const ANSI = process.stdout.isTTY
  ? { green: '\x1b[32m', red: '\x1b[31m', dim: '\x1b[2m', yellow: '\x1b[33m', reset: '\x1b[0m' }
  : { green: '', red: '', dim: '', yellow: '', reset: '' };

let pass = 0, fail = 0;
const failures = [];
const grouped = {};

for (const test of tests) {
  const got = checkGuess(test.guess, test.puzzle);
  const ok = test.allowed.includes(got);
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push({ ...test, got });
  }
  grouped[test.category] = grouped[test.category] || { pass: 0, fail: 0 };
  grouped[test.category][ok ? 'pass' : 'fail']++;
}

console.log('\n=== Physiodle matcher test results ===\n');

for (const [cat, counts] of Object.entries(grouped)) {
  const total = counts.pass + counts.fail;
  const colour = counts.fail === 0 ? ANSI.green : ANSI.red;
  console.log(`${colour}${cat}: ${counts.pass}/${total}${ANSI.reset}`);
}

if (failures.length > 0) {
  console.log(`\n${ANSI.red}--- failures ---${ANSI.reset}`);
  for (const f of failures) {
    console.log(`${ANSI.red}FAIL${ANSI.reset} [${f.category}${f.phase ? ' / Phase ' + f.phase : ''}] ${f.label}`);
    console.log(`     guess: ${JSON.stringify(f.guess)}`);
    console.log(`     puzzle.answer: ${JSON.stringify(f.puzzle.answer)}`);
    console.log(`     puzzle.aliases: ${JSON.stringify(f.puzzle.aliases || [])}`);
    console.log(`     expected one of: ${f.allowed.join(', ')}`);
    console.log(`     got: ${ANSI.yellow}${f.got}${ANSI.reset}`);
  }
}

console.log(`\n${fail === 0 ? ANSI.green : ANSI.red}TOTAL: ${pass} pass / ${fail} fail${ANSI.reset}`);
process.exit(fail === 0 ? 0 : 1);
