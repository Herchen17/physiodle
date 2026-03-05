/**
 * Physiodle Puzzle Review Pipeline
 *
 * Reviews all puzzles one-by-one using a cheap AI model (Claude Haiku).
 * Saves progress after every puzzle so it can be safely interrupted and resumed.
 *
 * Outputs:
 *   - data/reviews.json       → detailed per-puzzle feedback
 *   - data/puzzles.updated.json → updated puzzles with AI-suggested rewrites applied
 *
 * Usage:
 *   node review-puzzles.js              → review all 775 puzzles
 *   node review-puzzles.js --count=20   → trial: review first 20 only
 *   node review-puzzles.js --start=100  → resume from puzzle index 100
 *   node review-puzzles.js --dry-run    → test with first 3 puzzles only
 *   ANTHROPIC_API_KEY=your_key node review-puzzles.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ─── Config ────────────────────────────────────────────────────────────────────

const PUZZLES_FILE    = path.join(__dirname, 'data', 'puzzles.json');
const REVIEWS_FILE    = path.join(__dirname, 'data', 'reviews.json');
const UPDATED_FILE    = path.join(__dirname, 'data', 'puzzles.updated.json');
const PROGRESS_FILE   = path.join(__dirname, 'data', '.review_progress.json');

const API_KEY         = process.env.ANTHROPIC_API_KEY;
const MODEL           = 'claude-haiku-4-5-20251001'; // cheapest, fast
const DELAY_MS        = 300;   // ms between requests (avoid rate limits)
const MAX_RETRIES     = 3;

// ─── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are reviewing clues for Physiodle, a Wordle-style daily game where players guess physiotherapy diagnoses.

GAME RULES:
- Players see clues one at a time, starting with Clue 1 (Complaint), then 2, 3, 4, 5
- Each wrong guess reveals the next clue
- Players get a maximum of 5 guesses
- Clues must get progressively more specific, with the final clue (Imaging) being near-definitive

IDEAL CLUE QUALITIES:
- Clue 1 (Complaint): Could plausibly be 10+ different conditions. Never names the body part explicitly in a way that gives it away immediately. Age/gender/mechanism is fine.
- Clue 2 (Activity): Narrows it to a functional category but still not specific
- Clue 3 (History): Mechanism, onset, relevant background — starts to narrow significantly
- Clue 4 (Examination): Specific clinical findings (ROM, special tests, palpation) — now getting diagnostic
- Clue 5 (Imaging): Should be near-definitive. A competent clinician should be very confident after this clue.

PROBLEMS TO FLAG:
- TOO EASY: Clue 1 or 2 essentially gives away the answer (e.g., "patient has carpal tunnel-like symptoms in the wrist")
- TOO HARD: Even Clue 5 is vague — a clinician still couldn't be confident
- WRONG ORDER: A clue is more specific than the one after it (breaks the progressive reveal)
- GENERIC: A clue could apply to almost any musculoskeletal condition (e.g., "patient has pain and reduced ROM")
- INCONSISTENT: Clues don't tell a coherent clinical story about one patient
- NAMING THE ANSWER: A clue literally says the diagnosis name

You must respond with ONLY valid JSON, no markdown, no explanation outside the JSON.`;

// ─── Per-puzzle prompt ─────────────────────────────────────────────────────────

function buildUserPrompt(puzzle) {
  const clueLines = puzzle.clues
    .map((c, i) => `Clue ${i + 1} (${c.label}): "${c.text}"`)
    .join('\n');

  return `Review this Physiodle puzzle:

ANSWER: ${puzzle.answer}
CATEGORY: ${puzzle.category}

${clueLines}

Respond with this exact JSON structure:
{
  "overall_quality": "good" | "needs_work" | "poor",
  "clues": [
    {
      "index": 0,
      "label": "Complaint",
      "issues": [],
      "severity": "ok" | "minor" | "major",
      "rewrite": null | "suggested rewrite text if needed"
    }
  ],
  "notes": "brief overall notes or null"
}

For "issues" use strings like: "too_easy", "too_hard", "too_generic", "names_answer", "wrong_order", "incoherent"
Only provide a "rewrite" if severity is "minor" or "major". Keep rewrites concise and clinically accurate.
Keep the same clinical style — third person, terse, clinical language.`;
}

// ─── Anthropic API call ────────────────────────────────────────────────────────

function callAPI(prompt, retries = 0) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 429 || res.statusCode >= 500) {
          // Rate limit or server error — retry with backoff
          if (retries < MAX_RETRIES) {
            const wait = Math.pow(2, retries) * 2000;
            console.log(`    ⏳ Rate limited or server error (${res.statusCode}), retrying in ${wait/1000}s...`);
            setTimeout(() => callAPI(prompt, retries + 1).then(resolve).catch(reject), wait);
          } else {
            reject(new Error(`API error ${res.statusCode}: ${data}`));
          }
          return;
        }
        try {
          const response = JSON.parse(data);
          if (response.error) return reject(new Error(response.error.message));
          const text = response.content[0].text.trim();
          // Strip markdown code fences if model added them
          const cleaned = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
          const parsed = JSON.parse(cleaned);
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Failed to parse response: ${e.message}\nRaw: ${data.slice(0, 300)}`));
        }
      });
    });

    req.on('error', (e) => {
      if (retries < MAX_RETRIES) {
        setTimeout(() => callAPI(prompt, retries + 1).then(resolve).catch(reject), 2000);
      } else {
        reject(e);
      }
    });

    req.write(body);
    req.end();
  });
}

// ─── Apply rewrites to a puzzle ────────────────────────────────────────────────

function applyRewrites(puzzle, review) {
  const updated = JSON.parse(JSON.stringify(puzzle)); // deep clone
  if (!review.clues) return updated;

  for (const clueReview of review.clues) {
    if (clueReview.rewrite && (clueReview.severity === 'minor' || clueReview.severity === 'major')) {
      if (updated.clues[clueReview.index]) {
        updated.clues[clueReview.index].text = clueReview.rewrite;
        updated.clues[clueReview.index]._rewritten = true; // mark for tracking
      }
    }
  }
  return updated;
}

// ─── Progress helpers ──────────────────────────────────────────────────────────

function loadProgress() {
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch {
    return { completedIndices: [], lastIndex: -1 };
  }
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function loadReviews() {
  try {
    return JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveReviews(reviews) {
  fs.writeFileSync(REVIEWS_FILE, JSON.stringify(reviews, null, 2));
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) {
    console.error('❌ Missing ANTHROPIC_API_KEY environment variable.');
    console.error('   Run: ANTHROPIC_API_KEY=your_key node review-puzzles.js');
    process.exit(1);
  }

  // Parse args
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const startArg = args.find(a => a.startsWith('--start='));
  const countArg = args.find(a => a.startsWith('--count='));
  const forceStart = startArg ? parseInt(startArg.split('=')[1]) : null;
  const countLimit = countArg ? parseInt(countArg.split('=')[1]) : null;

  // Load data
  const puzzleData = JSON.parse(fs.readFileSync(PUZZLES_FILE, 'utf8'));
  const puzzles = puzzleData.puzzles;
  const reviews = loadReviews();
  const progress = loadProgress();

  // Load or create updated puzzles file
  let updatedData;
  try {
    updatedData = JSON.parse(fs.readFileSync(UPDATED_FILE, 'utf8'));
  } catch {
    updatedData = JSON.parse(JSON.stringify(puzzleData)); // deep clone original
  }

  const startIndex = forceStart !== null ? forceStart : progress.lastIndex + 1;
  const endIndex = dryRun       ? Math.min(startIndex + 3, puzzles.length)
                 : countLimit   ? Math.min(startIndex + countLimit, puzzles.length)
                 : puzzles.length;

  console.log(`\n🦴 Physiodle Puzzle Review Pipeline`);
  console.log(`   Model: ${MODEL}`);
  console.log(`   Puzzles: ${startIndex} → ${endIndex - 1} (${endIndex - startIndex} to process)`);
  if (dryRun)    console.log(`   DRY RUN mode (first 3 only)`);
  if (countLimit) console.log(`   TRIAL mode (--count=${countLimit})`);
  if (countLimit) console.log(`   After this, run: node trial-report.js`);
  console.log('');

  let reviewed = 0, flagged = 0, rewritten = 0, errors = 0;

  for (let i = startIndex; i < endIndex; i++) {
    const puzzle = puzzles[i];
    const key = puzzle.answer;

    process.stdout.write(`[${i + 1}/${endIndex}] ${puzzle.answer.padEnd(40)}`);

    try {
      const prompt = buildUserPrompt(puzzle);
      const review = await callAPI(prompt);

      // Store review
      reviews[key] = {
        index: i,
        answer: puzzle.answer,
        category: puzzle.category,
        overall_quality: review.overall_quality,
        clues: review.clues,
        notes: review.notes,
        reviewed_at: new Date().toISOString()
      };

      // Apply rewrites to updated puzzle data
      const updatedPuzzle = applyRewrites(puzzle, review);
      updatedData.puzzles[i] = updatedPuzzle;

      // Stats
      const hasIssues = review.clues && review.clues.some(c => c.severity !== 'ok');
      const hasMajor = review.clues && review.clues.some(c => c.severity === 'major');
      const hasRewrites = review.clues && review.clues.some(c => c.rewrite);

      if (hasIssues) flagged++;
      if (hasRewrites) rewritten++;

      const quality = review.overall_quality === 'good' ? '✓' :
                      review.overall_quality === 'needs_work' ? '~' : '✗';
      const issues = review.clues
        ? review.clues.filter(c => c.severity !== 'ok').map(c => `C${c.index + 1}:${c.severity}`).join(' ')
        : '';

      console.log(`${quality} ${issues || 'clean'}`);

      // Save progress every puzzle
      progress.lastIndex = i;
      if (!progress.completedIndices.includes(i)) progress.completedIndices.push(i);
      saveProgress(progress);
      saveReviews(reviews);
      fs.writeFileSync(UPDATED_FILE, JSON.stringify(updatedData, null, 2));

      reviewed++;

    } catch (err) {
      console.log(`ERROR: ${err.message.slice(0, 60)}`);
      errors++;
      // Log error to reviews
      reviews[key] = { index: i, answer: puzzle.answer, error: err.message, reviewed_at: new Date().toISOString() };
      saveReviews(reviews);
    }

    // Delay between requests
    if (i < endIndex - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  // ─── Summary ────────────────────────────────────────────────────────────────

  console.log('\n' + '─'.repeat(50));
  console.log(`✅ Done! Reviewed ${reviewed} puzzles.`);
  console.log(`   ${flagged} flagged with issues`);
  console.log(`   ${rewritten} had clues rewritten`);
  if (errors > 0) console.log(`   ${errors} errors (check reviews.json for details)`);
  console.log('');
  console.log(`📄 Reviews saved to: data/reviews.json`);
  console.log(`📦 Updated puzzles:  data/puzzles.updated.json`);
  console.log('');

  // Show summary of worst offenders
  const allReviews = Object.values(reviews).filter(r => !r.error);
  const poor = allReviews.filter(r => r.overall_quality === 'poor');
  const needsWork = allReviews.filter(r => r.overall_quality === 'needs_work');

  if (poor.length > 0) {
    console.log(`⚠️  ${poor.length} puzzles rated POOR:`);
    poor.slice(0, 10).forEach(r => console.log(`   - ${r.answer} (${r.category}): ${r.notes || ''}`));
    if (poor.length > 10) console.log(`   ... and ${poor.length - 10} more (see reviews.json)`);
  }

  console.log('');
  console.log(`When happy with puzzles.updated.json, replace puzzles.json:`);
  console.log(`   cp data/puzzles.updated.json data/puzzles.json`);
  console.log(`   # Then push to GitHub to deploy`);
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
