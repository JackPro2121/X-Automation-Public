/**
 * Config admissibility check for the A/B result.
 *
 * ── ORDERING IS LOAD-BEARING (this file got it wrong once) ───────────────────
 * `cron/tweetLimits.js` computes its constants at MODULE LOAD:
 *
 *     export const IS_X_PREMIUM  = process.env.X_PREMIUM === 'true';
 *     export const X_SAFE_MAX_CHARS = IS_X_PREMIUM ? 1200 : 277;
 *
 * so it MUST be imported AFTER the environment is populated. An earlier version
 * of this script set `process.env.X_PREMIUM` at the top and then used a STATIC
 * `import`, which hoists above the assignment — the module loaded with no env,
 * X_SAFE_MAX_CHARS silently became 277 (the free-tier cap), and `cleanTweetText`
 * dutifully trimmed all 13 posts to ~277 chars. The script then reported that
 * production would mangle every post. It would not. The bug was in the harness.
 *
 * Every pipeline avoids this by calling `dotenv.config()` in its entry point
 * before importing anything that reads config; this script reproduces that order
 * with a dynamic import after dotenv. Keep it that way.
 *
 * Answers two questions:
 *   1. Does the pipeline MUTATE these posts again on the way out? (idempotence)
 *   2. Do they satisfy the config invariants (MIN..SAFE_MAX, style rules)?
 *
 * Usage: node scratch/check_publishable.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

// Dynamic — must come after dotenv, or the limits are computed wrong.
const { cleanTweetText } = await import('../cron/lib/groqClient.js');
const L = await import('../cron/tweetLimits.js');

const MIN = L.MIN_TWEET_CHARS;
const SAFE_MAX = L.X_SAFE_MAX_CHARS;

// Sanity-check the harness itself before trusting anything it prints.
if (process.env.X_PREMIUM === 'true' && SAFE_MAX < 1000) {
  console.error('FATAL: X_PREMIUM=true but X_SAFE_MAX_CHARS=' + SAFE_MAX + '. Env was loaded after the limits module.');
  process.exit(1);
}

console.log(`config: X_PREMIUM=${process.env.X_PREMIUM}  X_MAX_CHARS=${L.X_MAX_CHARS}  X_SAFE_MAX_CHARS=${SAFE_MAX}  MIN_TWEET_CHARS=${MIN}  TWEET_TARGET_CHARS=${L.TWEET_TARGET_CHARS}\n`);

const r = JSON.parse(fs.readFileSync('scratch/ab_prompt_results.gemini.json', 'utf8'));
const ok = (t) => typeof t === 'string' && t.length > 0 && !t.startsWith('__ERR__');
const rows = r.filter((x) => ok(x.newText));
console.log(`NEW-arm posts scored: ${rows.length}\n`);

// ─── 1. Idempotence: would the publish path change the text again? ────────────
let mutated = 0;
const examples = [];
for (const x of rows) {
  const once = cleanTweetText(x.newText);
  const twice = cleanTweetText(once);
  if (once !== x.newText || twice !== once) {
    mutated++;
    if (examples.length < 3) examples.push({ src: x.source, from: x.newText, to: twice });
  }
}
console.log(`[1] cleanTweetText re-mutates ${mutated}/${rows.length} posts`);
for (const e of examples) {
  console.log(`    · ${String(e.src).slice(0, 50)}`);
  console.log(`      before: ${e.from.replace(/\n/g, ' ⏎ ').slice(0, 100)} (${e.from.length})`);
  console.log(`      after : ${e.to.replace(/\n/g, ' ⏎ ').slice(0, 100)} (${e.to.length})`);
}
if (mutated === 0) console.log('    → idempotent: the A/B form is the publishable form');

// ─── 2. Length admissibility ─────────────────────────────────────────────────
const lens = rows.map((x) => x.newText.length).sort((a, b) => a - b);
console.log(`\n[2] length: min=${lens[0]} p50=${lens[Math.floor(lens.length / 2)]} max=${lens[lens.length - 1]}`);
console.log(`    below MIN (${MIN}): ${rows.filter((x) => x.newText.length < MIN).length}   above SAFE_MAX (${SAFE_MAX}): ${rows.filter((x) => x.newText.length > SAFE_MAX).length}`);
const band = (lo, hi) => rows.filter((x) => x.newText.length >= lo && x.newText.length <= hi).length;
console.log(`    distribution — 280-500: ${band(280, 500)}   500-800: ${band(500, 800)}   800-1200: ${band(800, 1200)}   1200+: ${rows.filter((x) => x.newText.length > 1200).length}`);

// ─── 3. Style rules the pipeline polices downstream ──────────────────────────
const emoji = rows.filter((x) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(x.newText));
const bullets = rows.filter((x) => /^\s*[•\-\*]\s/m.test(x.newText));
const hashtag = rows.filter((x) => /#\w/.test(x.newText));
const mentions = rows.filter((x) => /@\w/.test(x.newText));
console.log(`\n[3] style: emoji=${emoji.length}/${rows.length}  bullets=${bullets.length}/${rows.length}  hashtags=${hashtag.length}/${rows.length}  @mentions=${mentions.length}/${rows.length}`);

// Emoji and bullets are worth seeing, not just counting: the prompt forbids both.
for (const x of emoji) console.log(`    emoji in: ${x.newText.replace(/\n/g, ' ⏎ ').slice(0, 90)}`);
for (const x of bullets) console.log(`    bullet in: ${x.newText.replace(/\n/g, ' ⏎ ').slice(0, 90)}`);

console.log('\nDone.');
