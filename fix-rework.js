/**
 * Fix REWORK Puzzles
 *
 * Reads batch-reviews.json, finds all REWORK puzzles, sends them to the API
 * in batches of 3 for substantial clue rewrites. Heavy touch — rebuild the
 * progressive reveal from scratch while keeping the same answer/category.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=key node fix-rework.js
 *   ANTHROPIC_API_KEY=key node fix-rework.js --count=15  (test first)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const UPDATED_FILE   = path.join(__dirname, 'data', 'puzzles.updated.json');
const BATCH_FILE     = path.join(__dirname, 'data', 'batch-reviews.json');
const OUTPUT_FILE    = path.join(__dirname, 'data', 'puzzles.rework-fixed.json');
const PROGRESS_FILE  = path.join(__dirname, 'data', '.fix_rework_progress.json');

const API_KEY        = process.env.ANTHROPIC_API_KEY;
const MODEL          = 'claude-haiku-4-5-20251001';
const BATCH_SIZE     = 3;  // smaller batches — these need more thought
const DELAY_MS       = 600;
const MAX_RETRIES    = 3;

const SYSTEM_PROMPT = `You are rewriting clues from scratch for Physiodle, a Wordle-style physiotherapy diagnosis game.

GAME RULES:
- 5 clues revealed one at a time: Complaint → Activity → History → Examination → Imaging
- Each wrong guess reveals the next clue. Max 5 guesses.
- The game DEPENDS on each clue adding MEANINGFUL NEW INFORMATION

These puzzles have SERIOUS structural problems and need to be rebuilt from scratch. The answer and category stay the same, but the clues need complete reworking.

WHEN REWRITING ALL 5 CLUES, follow this framework:

CLUE 1 (Complaint): Cast the WIDEST possible net.
- What the patient says in their own words: pain, stiffness, weakness, numbness, swelling
- Include age, gender, occupation if helpful — but NOTHING diagnosis-specific
- NEVER include the diagnosis name, body-part-specific terms that give it away, or pathognomonic features
- Should be plausible for AT LEAST 10 different conditions
- Example: "35-year-old office worker. Gradual onset of dominant hand pain and tingling waking them at night."

CLUE 2 (Activity): Functional limitations — what can't they do?
- NEW info: specific activities affected, aggravating/easing factors
- Should narrow to a body region or movement pattern (not a single diagnosis)
- Example: "Difficulty gripping objects, dropping cups. Symptoms worse with sustained wrist flexion."

CLUE 3 (History): Background, mechanism, timeline, comorbidities
- NEW info: how it started, relevant medical history, prior treatments
- Should eliminate 50-70% of remaining possibilities
- Example: "Symptoms started 6 months ago during pregnancy. No trauma. Bilateral but worse on dominant side."

CLUE 4 (Examination): Specific objective clinical findings
- NEW info: special tests, ROM, palpation, neurological signs
- Should differentiate between the remaining 2-3 possibilities
- Example: "Positive Phalen's and Tinel's at wrist. Reduced two-point discrimination in thumb, index, middle fingers. Thenar wasting noted."

CLUE 5 (Imaging): Near-definitive imaging or diagnostic findings
- NEW info: specific imaging results that confirm the diagnosis
- After this, essentially only one answer fits
- Example: "Nerve conduction studies show prolonged distal motor latency and reduced sensory conduction velocity across the carpal tunnel."

CRITICAL RULES:
1. NEVER name the diagnosis or obvious synonyms in any clue
2. Each clue MUST add information the previous clues did NOT contain
3. The 5 clues must tell a coherent clinical story about ONE patient
4. Use realistic, terse, third-person clinical language
5. Clue 5 should always reference actual imaging or diagnostic test findings

Respond with ONLY valid JSON array, no markdown.`;

function buildBatchPrompt(batch) {
  const puzzleTexts = batch.map((item, idx) => {
    const clueLines = item.puzzle.clues
      .map((c, i) => `  C${i+1} (${c.label}): "${c.text}"`)
      .join('\n');

    return `PUZZLE ${idx+1}: "${item.puzzle.answer}" [${item.puzzle.category}]
PROBLEM: ${item.reason}
CURRENT CLUES (broken — rewrite from scratch):
${clueLines}`;
  }).join('\n\n');

  return `Completely rewrite ALL 5 clues for these ${batch.length} puzzles. Build a proper progressive reveal from scratch.

${puzzleTexts}

Respond with a JSON array:
[
  {
    "index": 0,
    "answer": "Condition Name",
    "clues": [
      {"label": "Complaint", "text": "..."},
      {"label": "Activity", "text": "..."},
      {"label": "History", "text": "..."},
      {"label": "Examination", "text": "..."},
      {"label": "Imaging", "text": "..."}
    ]
  }
]

Remember: Clue 1 = broadest (10+ conditions possible), Clue 5 = near-definitive. Each clue adds NEW distinct information.`;
}

function callAPI(userPrompt, retries = 0) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
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
          if (retries < MAX_RETRIES) {
            const wait = Math.pow(2, retries) * 2000;
            console.log(`    ⏳ Retrying in ${wait/1000}s...`);
            setTimeout(() => callAPI(userPrompt, retries + 1).then(resolve).catch(reject), wait);
          } else {
            reject(new Error(`API error ${res.statusCode}`));
          }
          return;
        }
        try {
          const response = JSON.parse(data);
          if (response.error) return reject(new Error(response.error.message));
          const text = response.content[0].text.trim();
          const cleaned = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
          resolve(JSON.parse(cleaned));
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });

    req.on('error', (e) => {
      if (retries < MAX_RETRIES) {
        setTimeout(() => callAPI(userPrompt, retries + 1).then(resolve).catch(reject), 2000);
      } else { reject(e); }
    });

    req.write(body);
    req.end();
  });
}

async function main() {
  if (!API_KEY) { console.error('❌ Missing ANTHROPIC_API_KEY'); process.exit(1); }

  const args = process.argv.slice(2);
  const countArg = args.find(a => a.startsWith('--count='));
  const countLimit = countArg ? parseInt(countArg.split('=')[1]) : null;

  // Load data
  const puzzleData = JSON.parse(fs.readFileSync(UPDATED_FILE, 'utf8'));
  const batchReviews = JSON.parse(fs.readFileSync(BATCH_FILE, 'utf8'));

  // Get REWORK puzzles
  const reworkList = Object.values(batchReviews)
    .filter(r => r.verdict === 'REWORK')
    .sort((a, b) => a.globalIndex - b.globalIndex);

  // Deduplicate
  const seen = new Set();
  const toFix = reworkList.filter(r => {
    if (seen.has(r.globalIndex)) return false;
    seen.add(r.globalIndex);
    return true;
  });

  // Load or create output
  let outputData;
  try {
    outputData = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
  } catch {
    outputData = JSON.parse(JSON.stringify(puzzleData));
  }

  let progress = {};
  try { progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch { progress = { completed: [] }; }

  const completedSet = new Set(progress.completed || []);
  const remaining = toFix.filter(r => !completedSet.has(r.globalIndex));

  const total = countLimit ? Math.min(countLimit, remaining.length) : remaining.length;
  const totalBatches = Math.ceil(total / BATCH_SIZE);

  console.log(`\n🔨 REWORK Pipeline`);
  console.log(`   Total REWORK puzzles: ${toFix.length}`);
  console.log(`   Already completed: ${completedSet.size}`);
  console.log(`   To process: ${total} (${totalBatches} batches of ${BATCH_SIZE})`);
  console.log('');

  let processed = 0, errors = 0;

  for (let b = 0; b < totalBatches; b++) {
    const batchItems = remaining.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    if (batchItems.length === 0) break;

    const batch = batchItems.map(r => ({
      globalIndex: r.globalIndex,
      puzzle: puzzleData.puzzles[r.globalIndex],
      reason: r.reason || 'Fundamental structural issues — needs complete rewrite'
    }));

    const names = batch.map(b => `#${b.globalIndex+1}`).join(',');
    process.stdout.write(`[Batch ${b+1}/${totalBatches}] ${names} `);

    try {
      const prompt = buildBatchPrompt(batch);
      const results = await callAPI(prompt);

      results.forEach((r, idx) => {
        const gi = batch[idx].globalIndex;
        if (r.clues && r.clues.length === 5) {
          outputData.puzzles[gi].clues = r.clues;
          outputData.puzzles[gi]._reworked = true;
        }
        progress.completed = progress.completed || [];
        progress.completed.push(gi);
      });

      console.log(`✓ (${batch.length} rewritten)`);
      processed += batch.length;

    } catch (err) {
      console.log(`ERROR: ${err.message.slice(0, 50)}`);
      errors++;
    }

    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(outputData, null, 2));

    if (b < totalBatches - 1) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log('\n' + '─'.repeat(50));
  console.log(`✅ Rework done! ${processed} puzzles rewritten.`);
  if (errors > 0) console.log(`   ${errors} batch errors`);
  console.log(`📦 Output: data/puzzles.rework-fixed.json`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
