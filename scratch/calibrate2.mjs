/**
 * Second-pass calibration.
 *
 * The first pass showed sentenceOverlap is almost always 0 and only 1/82 posts
 * would be rejected — i.e. the posts are NOT paraphrases in the technical sense.
 * That contradicts the "Axis B = derivative text" hypothesis, so before building
 * a gate around it, find out what the posts ACTUALLY do with their source.
 *
 * Hypothesis to test: the real "minimally modified" tell is the OPENING LINE —
 * posts that begin by restating the source title, then bolt generic commentary
 * onto it.
 *
 * Usage: node scratch/calibrate2.mjs
 */

import fs from 'node:fs';

process.env.X_PREMIUM = 'true';
const { isTooSimilarToSource } = await import('../cron/lib/utils.js');

const pairs = JSON.parse(fs.readFileSync('scratch/pairs.json', 'utf8'));
const REAL = new Set(['v3', 'v4', 'catchup', 'v6']);
const rows = pairs.filter((p) => REAL.has(p.pipeline) && p.source.length >= 20);

function norm(t) {
  return String(t || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function tri(w) {
  const s = new Set();
  for (let i = 0; i + 2 < w.length; i++) s.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return s;
}
function overlap(aWords, bWords) {
  const a = tri(aWords);
  if (!a.size) return 0;
  const b = tri(bWords);
  let n = 0;
  for (const g of a) if (b.has(g)) n++;
  return n / a.size;
}
/** Strip a leading emoji + whitespace so it doesn't skew the first sentence. */
function firstSentence(text) {
  const t = String(text || '')
    .replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  const m = t.match(/^(.{10,300}?[.!?])(\s|$)/);
  return (m ? m[1] : t.slice(0, 200)).trim();
}

const scored = rows.map((r) => {
  const srcWords = norm(r.source).split(' ').filter(Boolean);
  const first = firstSentence(r.generated);
  const firstWords = norm(first).split(' ').filter(Boolean);
  return {
    ...r,
    first,
    firstOverlap: firstWords.length >= 4 ? overlap(firstWords, srcWords) : 0,
    wholeFlagged: isTooSimilarToSource(r.generated, r.source),
  };
});

// ─── Distribution of first-sentence overlap ──────────────────────────────────
const vals = scored.map((r) => r.firstOverlap).sort((a, b) => a - b);
const q = (p) => vals[Math.min(vals.length - 1, Math.floor(vals.length * p))];
console.log(`First-sentence vs source-title overlap, ${vals.length} posts:`);
console.log(`   min ${q(0).toFixed(2)}  p25 ${q(0.25).toFixed(2)}  MEDIAN ${q(0.5).toFixed(2)}  p75 ${q(0.75).toFixed(2)}  p90 ${q(0.9).toFixed(2)}  max ${q(1).toFixed(2)}`);

for (const t of [0.3, 0.4, 0.5, 0.6, 0.7]) {
  const n = scored.filter((r) => r.firstOverlap >= t).length;
  console.log(`   >= ${t.toFixed(2)}: ${String(n).padStart(3)}/${scored.length}  (${((n / scored.length) * 100).toFixed(0)}%)`);
}

// ─── The worst offenders — openings that copy the source ─────────────────────
console.log('\n══ Posts whose OPENING LINE restates the source (overlap >= 0.50) ══\n');
const copiers = scored.filter((r) => r.firstOverlap >= 0.5).sort((a, b) => b.firstOverlap - a.firstOverlap);
for (const r of copiers.slice(0, 10)) {
  console.log(`[${r.pipeline}] firstOverlap=${r.firstOverlap.toFixed(2)}`);
  console.log(`   SRC  : ${r.source.slice(0, 120)}`);
  console.log(`   OPEN : ${r.first.slice(0, 120)}`);
  console.log('');
}
console.log(`Total openings that copy the source: ${copiers.length}/${scored.length} (${((copiers.length / scored.length) * 100).toFixed(0)}%)`);

// ─── How many posts add nothing at all beyond the source? ────────────────────
console.log('\n══ Posts flagged as verbatim overall ══');
for (const r of scored.filter((r) => r.wholeFlagged)) {
  console.log(`[${r.pipeline}] SRC : ${r.source.slice(0, 110)}`);
  console.log(`            POST: ${r.generated.replace(/\n/g, ' | ').slice(0, 130)}\n`);
}
