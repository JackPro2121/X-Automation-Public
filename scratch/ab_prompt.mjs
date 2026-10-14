/**
 * A/B the prompt rewrite: OLD contract vs NEW derivation contract.
 *
 * The two previous calibration passes measured the OLD output and found it is not
 * lexically derivative. The information-delta metric then measured the same 82
 * posts and found 88% of them carry no information their source lacks. So the
 * question this script answers is narrow and testable:
 *
 *     Does asking the model to COMPUTE instead of to REWORD move the delta rate?
 *
 * Method: take real sources from the production corpus, generate one post with
 * each prompt against the same source with the same model, and score both with
 * the same metric. Same source, same model, same metric — only the prompt differs.
 *
 * Usage:
 *   node scratch/ab_prompt.mjs                     # 8 sources, groq, both prompts
 *   node scratch/ab_prompt.mjs --n 15
 *   node scratch/ab_prompt.mjs --model gemini      # production primary writer
 *   node scratch/ab_prompt.mjs --show              # print full post text
 *
 * NOTE ON MODEL CHOICE: production writes with Gemini first. Its single key
 * rate-limits quickly (HTTP 429), so the default here is Groq, which is fast and
 * has two working keys. Both arms always use the SAME model, so the comparison is
 * valid either way — but re-run with --model gemini when quota allows, because
 * that is the model that actually writes the posts.
 */

import fs from 'node:fs';

process.env.X_PREMIUM = 'true';
process.env.GENERATION_MAX_TOKENS = '900';

const env = fs.readFileSync('.env.local', 'utf8');
const pick = (re) => [...env.matchAll(re)].map((m) => m[2].trim().replace(/^["']|["']$/g, ''));
const geminiKey = env.match(/^GEMINI_API_KEY\s*=\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
const groqKeys = pick(/^GROQ_API_KEY(_\d+)?\s*=\s*(.+)$/gm);
if (geminiKey) process.env.GEMINI_API_KEY = geminiKey;

const args = process.argv.slice(2);
const N = Number(args[args.indexOf('--n') + 1]) || 8;
const SHOW = args.includes('--show');
const MODEL = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'groq';

const { buildTweetPrompt, cleanTweetText } = await import('../cron/lib/groqClient.js');
const { hasInformationDelta, hasBorrowedAuthority } = await import('../cron/lib/utils.js');

// ─── Generators ──────────────────────────────────────────────────────────────
// Groq direct: OpenAI-compatible, and the model ID is verified live
// (see cron/verify_models.js). Used because Gemini's single key 429s fast.
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'qwen/qwen3.8-27b';

async function callGroqText(prompt) {
  let lastErr = null;
  for (const key of groqKeys) {
    try {
      const res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.9,
          max_tokens: 900,
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429) { lastErr = new Error('429'); continue; }
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      const j = await res.json();
      const txt = j?.choices?.[0]?.message?.content;
      if (txt) return txt;
      lastErr = new Error('empty content');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all groq keys failed');
}

let callGeminiFn = null;
async function callGeminiText(prompt) {
  callGeminiFn ??= (await import('../cron/lib/geminiClient.js')).callGemini;
  return callGeminiFn(prompt, { temperature: 0.9, maxTokens: 900 });
}

const callModel = (prompt) => (MODEL === 'gemini' ? callGeminiText(prompt) : callGroqText(prompt));

// ─── Sources: real, from the production corpus ────────────────────────────────
const pairs = JSON.parse(fs.readFileSync('scratch/pairs.json', 'utf8'));
const REAL = new Set(['v3', 'v4', 'catchup', 'v6']);
const pool = pairs.filter((p) => REAL.has(p.pipeline) && p.source.length >= 25);

// Spread across pipelines instead of taking the first N, so one pipeline's
// source style does not dominate the sample.
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

// ─── The OLD prompt, reconstructed verbatim for a fair comparison ─────────────
// Rebuilt from git history rather than paraphrased, so the comparison isolates
// the contract change and nothing else.
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

// ─── Run ─────────────────────────────────────────────────────────────────────
console.log(`A/B: OLD contract vs NEW derivation contract`);
console.log(`${sources.length} sources · model=${MODEL} (same for both arms) · metric=hasInformationDelta\n`);

const results = [];
for (const [idx, s] of sources.entries()) {
  const post = { title: s.source, selftext: '', subreddit: 'unknown', upvotes: 0 };

  const gen = async (prompt) => {
    let lastErr = null;
    for (let a = 1; a <= 3; a++) {
      try {
        const raw = await callModel(prompt);
        if (raw) {
          const cleaned = cleanTweetText(raw);
          if (cleaned && cleaned.length >= 160) return cleaned;
          lastErr = new Error(`too short (${cleaned ? cleaned.length : 0})`);
        } else {
          lastErr = new Error('empty');
        }
      } catch (err) { lastErr = err; }
      await new Promise((r) => setTimeout(r, 2500));
    }
    return `__ERR__ ${lastErr?.message}`;
  };

  process.stdout.write(`[${idx + 1}/${sources.length}] ${s.pipeline} — generating both arms... `);

  const oldText = await gen(oldPrompt(s.source));
  await new Promise((r) => setTimeout(r, 1200));
  const newText = await gen(buildTweetPrompt(post));

  const score = (t) => (t && !t.startsWith('__ERR__') ? hasInformationDelta(t, s.source, { explain: true }) : null);
  const o = score(oldText);
  const n = score(newText);
  const oFab = oldText && !oldText.startsWith('__ERR__') && hasBorrowedAuthority(oldText);
  const nFab = newText && !newText.startsWith('__ERR__') && hasBorrowedAuthority(newText);

  results.push({ pipeline: s.pipeline, source: s.source, oldText, newText, o, n, oFab, nFab });
  const tag = (v) => (v === null ? 'fail' : v.reasoned ? 'reasoned' : v.ambiguous ? 'ambig' : 'none');
  console.log(`done  OLD:${tag(o)}${oFab ? '+FAB' : ''}  NEW:${tag(n)}${nFab ? '+FAB' : ''}`);
}

// ─── Report ──────────────────────────────────────────────────────────────────
const ok = (r, k) => r[k] !== null;
const rate = (key, field, invert = false) => {
  const valid = results.filter((r) => ok(r, key));
  const hit = valid.filter((r) => (invert ? !r[key][field] : r[key][field]));
  return `${hit.length}/${valid.length} (${valid.length ? ((hit.length / valid.length) * 100).toFixed(0) : 0}%)`;
};

console.log('\n' + '═'.repeat(66));
console.log('  SCORE — same sources, same model, only the contract changed');
console.log('═'.repeat(66));
console.log(`  reasoned (trustworthy signal)   OLD ${rate('o', 'reasoned').padEnd(12)} NEW ${rate('n', 'reasoned')}`);
console.log(`  ambiguous figure                OLD ${rate('o', 'ambiguous').padEnd(12)} NEW ${rate('n', 'ambiguous')}`);
console.log(`  NO delta (reads as a summary)   OLD ${rate('o', 'hasDelta', true).padEnd(12)} NEW ${rate('n', 'hasDelta', true)}`);

const fab = (key) => {
  const valid = results.filter((r) => r[key === 'oFab' ? 'o' : 'n'] !== null);
  const hit = valid.filter((r) => r[key]);
  return `${hit.length}/${valid.length} (${valid.length ? ((hit.length / valid.length) * 100).toFixed(0) : 0}%)`;
};
console.log(`  fabricated authority (reject)   OLD ${fab('oFab').padEnd(12)} NEW ${fab('nFab')}`);

console.log('\n' + '═'.repeat(66));
console.log('  SIDE BY SIDE');
console.log('═'.repeat(66));
for (const r of results) {
  console.log(`\n[${r.pipeline}] SRC: ${r.source.replace(/\s+/g, ' ').slice(0, 120)}`);
  console.log(`  OLD ${r.o?.reasoned ? '✓' : r.o?.ambiguous ? '~' : '✗'} ${r.o ? r.o.reason.slice(0, 88) : 'generation failed'}`);
  console.log(`  NEW ${r.n?.reasoned ? '✓' : r.n?.ambiguous ? '~' : '✗'} ${r.n ? r.n.reason.slice(0, 88) : 'generation failed'}`);
  if (SHOW) {
    console.log(`  ── OLD ──`);
    console.log((r.oldText || '(failed)').split('\n').map((l) => '    ' + l).join('\n'));
    console.log(`  ── NEW ──`);
    console.log((r.newText || '(failed)').split('\n').map((l) => '    ' + l).join('\n'));
  }
}

fs.writeFileSync('scratch/ab_prompt_results.json', JSON.stringify(results, null, 2));
console.log(`\nFull output (both arms, every post) → scratch/ab_prompt_results.json`);
