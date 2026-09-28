/**
 * Gemini A/B — the production model, with quota-aware checkpointing.
 *
 * WHY THIS IS A SEPARATE SCRIPT FROM scratch/ab_prompt.mjs
 *
 * ab_prompt.mjs was written for Groq (two working keys, fast, generous quota). It
 * runs sources strictly sequentially and keeps everything in memory, writing the
 * results file ONCE at the very end. Measured against Gemini that design fails in
 * two ways, both observed live:
 *
 *   1. It re-runs the OLD arm even when the OLD arm already succeeded. Gemini's
 *      single key 429s after roughly 4-6 realistic generations, so a 14-source run
 *      spends its whole remaining quota regenerating output it already has. The
 *      first Gemini run produced 3 old / 4 new scores out of 14 possible — and the
 *      reason was quota burn, not a bad model.
 *   2. Nothing is on disk until the loop finishes. A Ctrl-C, a 429 storm, or a
 *      crash loses every completed row.
 *
 * This script fixes both:
 *   - It reads scratch/ab_prompt_results.gemini.json if present and TOP-UPS it:
 *     any row whose arm already has text is never regenerated.
 *   - It writes the file after EVERY arm, so a run can be stopped and resumed.
 *   - It paces calls and detects exhaustion, rather than hammering the 429.
 *
 * Scoring is identical to ab_prompt.mjs (same two functions, same metric) so the
 * two result files are directly comparable.
 *
 * Usage:
 *   node scratch/ab_gemini.mjs                 # top up to 14 scored rows
 *   node scratch/ab_gemini.mjs --n 14
 *   node scratch/ab_gemini.mjs --target 8      # stop once 8 rows have BOTH arms
 *   node scratch/ab_gemini.mjs --show
 */

import fs from 'node:fs';

process.env.X_PREMIUM = 'true';
process.env.GENERATION_MAX_TOKENS = '900';

const env = fs.readFileSync('.env.local', 'utf8');
const geminiKey = env.match(/^GEMINI_API_KEY\s*=\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
if (geminiKey) process.env.GEMINI_API_KEY = geminiKey;

const args = process.argv.slice(2);
const N = Number(args[args.indexOf('--n') + 1]) || 14;
const SHOW = args.includes('--show');
const TARGET = Number(args[args.indexOf('--target') + 1]) || 12;

const RESULTS = 'scratch/ab_prompt_results.gemini.json';

const { buildTweetPrompt, cleanTweetText } = await import('../cron/lib/groqClient.js');
const { hasInformationDelta, hasBorrowedAuthority } = await import('../cron/lib/utils.js');
const { callGemini, getLastGeminiModel } = await import('../cron/lib/geminiClient.js');

// ─── Source selection: identical to ab_prompt.mjs ────────────────────────────
const pairs = JSON.parse(fs.readFileSync('scratch/pairs.json', 'utf8'));
const REAL = new Set(['v3', 'v4', 'catchup', 'v6']);
const pool = pairs.filter((p) => REAL.has(p.pipeline) && p.source.length >= 25);

const byPipe = {};
for (const p of pool) (byPipe[p.pipeline] ??= []).push(p);
const sources = [];
let i = 0;
while (sources.length < N) {
  let added = false;
  for (const list of Object.values(byPipe)) {
    if (sources.length >= N) break;
    if (list[i]) { sources.push(list[i]); added = true; }
  }
  if (!added) break;
  i++;
}

// ─── The OLD prompt — byte-identical to ab_prompt.mjs so the arms stay fair ───
function oldPrompt(source) {
  return `You are @M_jawad_yasin, a working AI engineer and tech commentator on X.

CURRENT DATE: ${new Date().toISOString().split('T')[0]}

TASK: The post below is a SOURCE SIGNAL — it tells you what is happening right now. Write ONE ORIGINAL post that adds YOUR OWN angle on it: your opinion, the implication nobody is mentioning, a contrarian take, a real tradeoff, or how it connects to a bigger trend. Do NOT summarize or reword the source. Output ONLY the post text.

POST SHAPE FOR THIS ONE: "Single sharp take"
Write ONE opinionated take, stated plainly and confidently, in 2 to 3 sentences.
Do NOT use bullet points, headings, or line breaks. Do NOT end with a question.

LENGTH: aim for 180 to 420 characters.
Line breaks: do NOT use them. This is flowing prose in one block.
Do NOT end with a question.

FACTUAL GROUNDING (critical — this account is monetized and audited):
- Use ONLY facts, names, numbers, benchmarks, and version numbers that appear in the POST below. Do NOT invent or estimate statistics, model names, dates, or specs.
- If the source lacks a hard number, keep the claim qualitative ("much faster", not "3.2x faster").
- Never fabricate quotes or attribute claims to people/labs not named in the source.
- If you are unsure a detail is real, leave it out. A sharp, honest take beats an impressive-sounding fake one.

ORIGINALITY (X only monetizes ORIGINAL content — a reworded source earns $0 and gets flagged):
- Ground every FACT in the source, but the TAKE must be YOURS: the opinion, the "why this matters", the implication, the tradeoff, the contrarian angle, or the connection to a broader trend — none of which appear in the source.
- Do NOT paraphrase the source sentence-by-sentence. Add a layer of thinking on top of it.

TWEET RULES:
- Sound like a specific engineer with an opinion, not a press release.
- NO hashtags, NO markdown headers (#), NO bold (**).

POST TO WRITE ABOUT:
Title: ${source}
Source: r/unknown
Upvotes: 0

POST:`;
}

// ─── Checkpointed state ──────────────────────────────────────────────────────
// Row shape matches ab_prompt_results.json exactly (pipeline, source, oldText,
// newText, o, n, oFab, nFab) so downstream comparison needs no special-casing.
let state = [];
if (fs.existsSync(RESULTS)) {
  state = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
  console.log(`Resuming — ${state.length} row(s) already on disk at ${RESULTS}`);
}

const rowFor = (s) => state.find((r) => r.source === s.source) || null;
const save = () => fs.writeFileSync(RESULTS, JSON.stringify(state, null, 2));

const isOk = (t) => typeof t === 'string' && t.length > 0 && !t.startsWith('__ERR__');

/** Generate one arm with the production call path (its own key rotation + retries). */
async function gen(prompt) {
  for (let a = 1; a <= 2; a++) {
    const raw = await callGemini(prompt, { temperature: 0.9, maxTokens: 900, timeoutMs: 25000 });
    if (raw) {
      const cleaned = cleanTweetText(raw);
      if (cleaned && cleaned.length >= 160) return { text: cleaned, model: getLastGeminiModel() };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { text: '__ERR__ quota-or-timeout', model: null };
}

function score(t, source) {
  if (!isOk(t)) return { o: null, fab: false };
  return { o: hasInformationDelta(t, source, { explain: true }), fab: hasBorrowedAuthority(t) };
}

// ─── Run ─────────────────────────────────────────────────────────────────────
const scorable = () => state.filter((r) => isOk(r.oldText) && isOk(r.newText)).length;
console.log(`\nA/B on GEMINI (production primary writer)`);
console.log(`target: ${TARGET} rows with BOTH arms scored · currently ${scorable()}\n`);

let consecutiveFailures = 0;

for (const [idx, s] of sources.entries()) {
  if (scorable() >= TARGET) break;

  let row = rowFor(s);
  if (!row) {
    row = { pipeline: s.pipeline, source: s.source, oldText: null, newText: null, o: null, n: null, oFab: false, nFab: false, model: null, oModel: null };
    state.push(row);
  }

  const post = { title: s.source, selftext: '', subreddit: 'unknown', upvotes: 0 };
  const needsOld = !isOk(row.oldText);
  const needsNew = !isOk(row.newText);

  if (!needsOld && !needsNew) {
    console.log(`[${idx + 1}/${sources.length}] ${s.pipeline} — already complete, skipping`);
    continue;
  }

  process.stdout.write(`[${idx + 1}/${sources.length}] ${s.pipeline} — ${needsOld && needsNew ? 'both arms' : needsOld ? 'old arm only' : 'new arm only'}... `);

  if (needsOld) {
    const r = await gen(oldPrompt(s.source));
    row.oldText = r.text;
    if (isOk(r.text)) row.oModel = r.model;
    save();
    if (isOk(r.text)) { const c = score(r.text, s.source); row.o = c.o; row.oFab = c.fab; }
    else consecutiveFailures++;
    save();
    await new Promise((r2) => setTimeout(r2, 1500));
  }

  if (needsNew) {
    const r = await gen(buildTweetPrompt(post));
    row.newText = r.text;
    if (isOk(r.text)) row.model = r.model;
    save();
    if (isOk(r.text)) { const c = score(r.text, s.source); row.n = c.o; row.nFab = c.fab; }
    else consecutiveFailures++;
    save();
    await new Promise((r2) => setTimeout(r2, 1500));
  }

  if (isOk(row.oldText) || isOk(row.newText)) consecutiveFailures = 0;

  const tag = (v) => (v === null ? 'fail' : v.reasoned ? 'reasoned' : v.ambiguous ? 'ambig' : 'none');
  console.log(`done  OLD:${tag(row.o)}${row.oFab ? '+FAB' : ''}  NEW:${tag(row.n)}${row.nFab ? '+FAB' : ''}  [scored ${scorable()}/${TARGET}]`);

  // Exhaustion guard: if Gemini has stopped answering entirely, keep looping is
  // just burning wall-clock. Stop and say so, leaving the checkpoint intact.
  if (consecutiveFailures >= 4) {
    console.log(`\n⚠ 4 consecutive empty responses — Gemini quota appears exhausted for now.`);
    console.log(`   Checkpoint saved. Re-run this script later; it will resume from here.`);
    break;
  }
}

// ─── Report ──────────────────────────────────────────────────────────────────
save();

const rate = (rows, pred) => `${rows.filter(pred).length}/${rows.length} (${rows.length ? Math.round((rows.filter(pred).length / rows.length) * 100) : 0}%)`;
const vO = state.filter((r) => r.o !== null);
const vN = state.filter((r) => r.n !== null);
const both = state.filter((r) => r.o !== null && r.n !== null);

console.log('\n' + '═'.repeat(66));
console.log('  SCORE — GEMINI — same sources, same model, only the contract changed');
console.log('═'.repeat(66));
console.log(`  rows with both arms              ${both.length}/${state.length}`);
console.log(`  reasoned (trustworthy)   OLD ${rate(vO, (r) => r.o.reasoned).padEnd(12)} NEW ${rate(vN, (r) => r.n.reasoned)}`);
console.log(`  ambiguous figure         OLD ${rate(vO, (r) => r.o.ambiguous).padEnd(12)} NEW ${rate(vN, (r) => r.n.ambiguous)}`);
console.log(`  NO delta (reads as summ) OLD ${rate(vO, (r) => !r.o.hasDelta).padEnd(12)} NEW ${rate(vN, (r) => !r.n.hasDelta)}`);
console.log(`  fabricated authority     OLD ${rate(vO, (r) => r.oFab).padEnd(12)} NEW ${rate(vN, (r) => r.nFab)}`);

// Paired view — the honest comparison, since arms succeeded at different rates.
if (both.length) {
  const oR = both.filter((r) => r.o.reasoned).length;
  const nR = both.filter((r) => r.n.reasoned).length;
  console.log(`\n  paired (only rows where BOTH scored): reasoned ${oR}→${nR} of ${both.length}`);
}

console.log('\n' + '═'.repeat(66));
console.log('  SIDE BY SIDE');
console.log('═'.repeat(66));
for (const r of state) {
  const tag = (v) => (v === null ? '✗' : v.reasoned ? '✓' : v.ambiguous ? '~' : '✗');
  console.log(`\n[${r.pipeline}] SRC: ${String(r.source).replace(/\s+/g, ' ').slice(0, 110)}`);
  console.log(`  OLD ${tag(r.o)} ${r.o ? r.o.reason.slice(0, 84) : (r.oldText ? 'generation failed' : 'not run')}  ${r.oModel || ''}`);
  console.log(`  NEW ${tag(r.n)} ${r.n ? r.n.reason.slice(0, 84) : (r.newText ? 'generation failed' : 'not run')}  ${r.model || ''}`);
  if (SHOW) {
    console.log('  ── OLD ──');
    console.log((isOk(r.oldText) ? r.oldText : '(failed)').split('\n').map((l) => '    ' + l).join('\n'));
    console.log('  ── NEW ──');
    console.log((isOk(r.newText) ? r.newText : '(failed)').split('\n').map((l) => '    ' + l).join('\n'));
  }
}

console.log(`\nCheckpoint → ${RESULTS}`);
