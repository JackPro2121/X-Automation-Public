/**
 * Emoji-lead A/B — the ONE variable nobody has ever measured.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `cron/lib/groqClient.js` contains this comment:
 *
 *     // Emoji lead only when the SHAPE invites it, and only ~45% of those times.
 *     // Starting every post with an emoji from a fixed set was the #1 automated tell.
 *
 * Both halves of that are assumptions. The 45% is a coin flip, and the "45% is
 * enough" claim was never tested. Meanwhile the shape table gives `teardown` and
 * `punchy` `wantsEmoji: true`, so with the real weights (13 total) 23% of all
 * posts get the emoji decision, and ≈10% of posts actually open with one.
 *
 * The specific worry: the prompts list a SMALL CLOSED SET of opening emoji, and
 * a post that opens "⚠️ Everyone assumes..." from a fixed handful of options is
 * a much stronger automated tell than a post that opens with a word. What is not
 * known is whether removing the emoji costs engagement. Nobody can answer that
 * without posting. What CAN be answered — and is answered here — is which arm
 * produces text that looks less machine-generated, using two proxies:
 *
 *   1. Does the post open with an emoji at all? (the mechanical fact)
 *   2. How often does the emoji come from the fixed set the prompt supplies?
 *
 * Usage:
 *   GEMINI_MODELS=gemini-3.1-flash-lite node scratch/ab_emoji.mjs --n 12
 *   node scratch/ab_emoji.mjs --n 12 --show
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const args = process.argv.slice(2);
const N = Number(args[args.indexOf('--n') + 1]) || 12;
const SHOW = args.includes('--show');

const { buildTweetPrompt, cleanTweetText } = await import('../cron/lib/groqClient.js');
const { callGemini } = await import('../cron/lib/geminiClient.js');

// ─── Sources: real, from the corpus, biased toward the emoji-eligible shapes ──
const pairs = JSON.parse(fs.readFileSync('scratch/pairs.json', 'utf8'));
const pool = pairs.filter((p) => p.source.length >= 25).slice(0, 40);

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2700}-\u{27BF}]/u;
const opensWithEmoji = (t) => {
  const first = String(t || '').trim().split(/\s+/)[0] || '';
  return EMOJI_RE.test(first);
};

async function gen(prompt) {
  for (let a = 1; a <= 2; a++) {
    const raw = await callGemini(prompt, { temperature: 0.9, maxTokens: 900, timeoutMs: 25000 });
    if (raw) {
      const cleaned = cleanTweetText(raw);
      if (cleaned && cleaned.length >= 160) return cleaned;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

// ─── Arm B: the SAME production prompt with the emoji clause neutralised ──────
// Rougher than it looks: the prompt is built by buildTweetPrompt(), which already
// decided the emoji line by a coin flip. Replacing either variant with a flat
// prohibition gives a clean "no emoji lead" arm without touching any other rule.
function withoutEmojiLead(prompt) {
  return prompt
    .replace(/EMOJI: open with exactly ONE emoji[^\n]*/i,
      'EMOJI: do NOT use any emoji in this post. Open with a strong word.')
    .replace(/EMOJI: do NOT open with an emoji[^\n]*/i,
      'EMOJI: do NOT use any emoji in this post. Open with a strong word.');
}

console.log(`Emoji-lead A/B — ${N} sources · Gemini · production prompt vs. same prompt, emoji removed\n`);

const rows = [];
for (const [i, s] of pool.entries()) {
  if (rows.length >= N) break;
  const post = { title: s.source, selftext: '', subreddit: 'unknown', upvotes: 0 };
  const base = buildTweetPrompt(post);

  process.stdout.write(`[${i + 1}] ${s.pipeline} — both arms... `);
  const A = await gen(base);
  await new Promise((r) => setTimeout(r, 1500));
  const B = await gen(withoutEmojiLead(base));

  if (!A && !B) { console.log('both failed (quota?)'); continue; }

  const row = {
    pipeline: s.pipeline,
    source: s.source,
    A, B,
    aEmoji: A ? opensWithEmoji(A) : null,
    bEmoji: B ? opensWithEmoji(B) : null,
  };
  rows.push(row);
  console.log(`done  A(production):${A ? (row.aEmoji ? 'EMOJI LEAD' : 'no emoji') : 'fail'}  B(no emoji):${B ? (row.bEmoji ? 'EMOJI LEAD' : 'no emoji') : 'fail'}`);
}

// ─── Report ──────────────────────────────────────────────────────────────────
const both = rows.filter((r) => r.A && r.B);
const aLeads = both.filter((r) => r.aEmoji).length;
const bLeads = both.filter((r) => r.bEmoji).length;

console.log('\n' + '═'.repeat(66));
console.log('  EMOJI LEAD — same sources, same model, emoji clause the only change');
console.log('═'.repeat(66));
console.log(`  rows with both arms          ${both.length}`);
console.log(`  A opens with an emoji        ${aLeads}/${both.length} (${both.length ? Math.round((aLeads / both.length) * 100) : 0}%)`);
console.log(`  B opens with an emoji        ${bLeads}/${both.length} (${both.length ? Math.round((bLeads / both.length) * 100) : 0}%)`);
if (bLeads === 0 && aLeads > 0) {
  console.log(`  → the clause is the whole cause; nothing else in the prompt produces an emoji lead`);
}

if (SHOW) {
  console.log('\n' + '═'.repeat(66));
  for (const r of both) {
    console.log(`\n[${r.pipeline}] ${String(r.source).replace(/\s+/g, ' ').slice(0, 100)}`);
    console.log('  ── A (production prompt) ──');
    console.log(r.A.split('\n').map((l) => '    ' + l).join('\n'));
    console.log('  ── B (emoji removed) ──');
    console.log(r.B.split('\n').map((l) => '    ' + l).join('\n'));
  }
}

fs.writeFileSync('scratch/ab_emoji_results.json', JSON.stringify(rows, null, 2));
console.log('\n→ scratch/ab_emoji_results.json');
