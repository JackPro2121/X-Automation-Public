/**
 * Calibrate the paraphrase gate against REAL shipped posts.
 *
 * Every pair here is a (source title -> post that actually published) from
 * pipeline_runs. Tuning a threshold without looking at what it rejects is how you
 * ship a gate that either does nothing or destroys output volume.
 *
 * Usage: node scratch/calibrate_paraphrase.mjs
 */

import fs from 'node:fs';

process.env.X_PREMIUM = 'true';
const { isParaphraseOfSource } = await import('../cron/lib/utils.js');

const pairs = JSON.parse(fs.readFileSync('scratch/pairs.json', 'utf8'));

// Only pipelines where a REAL scraped source exists. v8 magnets are generated
// from nothing (the "source" is just an archetype id) and quote tweets reply to
// a tweet, so neither is a restatement risk in the same way.
const REAL_SOURCE_PIPELINES = new Set(['v3', 'v4', 'catchup', 'v6']);
const rows = pairs.filter((p) => REAL_SOURCE_PIPELINES.has(p.pipeline) && p.source.length >= 20);

console.log(`Calibrating on ${rows.length} real (source -> published post) pairs`);
console.log(`Pipelines: ${[...new Set(rows.map((r) => r.pipeline))].join(', ')}\n`);

// ─── Score every pair ────────────────────────────────────────────────────────
const scored = rows.map((r) => {
  const v = isParaphraseOfSource(r.generated, r.source, { explain: true });
  return { ...r, ...v };
});

// ─── Distribution ────────────────────────────────────────────────────────────
function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return {
    min: q(0), p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.9), max: q(1),
    mean: values.reduce((a, b) => a + b, 0) / values.length,
  };
}

const so = stats(scored.map((r) => r.sentenceOverlap));
const vb = stats(scored.map((r) => r.vocabularyBorrowed));

console.log('sentenceOverlap   (median best-match per sentence):');
console.log(`   min ${so.min.toFixed(2)}  p25 ${so.p25.toFixed(2)}  MEDIAN ${so.median.toFixed(2)}  p75 ${so.p75.toFixed(2)}  p90 ${so.p90.toFixed(2)}  max ${so.max.toFixed(2)}`);
console.log('vocabularyBorrowed (share of post vocabulary found in source):');
console.log(`   min ${vb.min.toFixed(2)}  p25 ${vb.p25.toFixed(2)}  MEDIAN ${vb.median.toFixed(2)}  p75 ${vb.p75.toFixed(2)}  p90 ${vb.p90.toFixed(2)}  max ${vb.max.toFixed(2)}`);

// ─── Rejection rate at candidate thresholds ──────────────────────────────────
console.log('\nRejection rate at candidate thresholds (current prompt, before the rewrite):');
console.log('  sentMax  vocabMax   rejected   %');
for (const [s, v] of [[0.75, 0.95], [0.70, 0.92], [0.65, 0.90], [0.60, 0.88], [0.55, 0.85], [0.50, 0.82], [0.45, 0.80]]) {
  const n = scored.filter((r) =>
    isParaphraseOfSource(r.generated, r.source, { sentenceOverlap: s, vocabularyBorrowed: v })
  ).length;
  const pct = ((n / scored.length) * 100).toFixed(0);
  console.log(`  ${s.toFixed(2)}     ${v.toFixed(2)}     ${String(n).padStart(4)}/${scored.length}   ${pct.padStart(3)}%`);
}

// ─── What actually gets rejected at a sensible setting ───────────────────────
const CHOSEN = { sentenceOverlap: 0.60, vocabularyBorrowed: 0.88 };
const rejected = scored.filter((r) => isParaphraseOfSource(r.generated, r.source, CHOSEN));

console.log(`\n══ At sentMax=${CHOSEN.sentenceOverlap} vocabMax=${CHOSEN.vocabularyBorrowed}: ${rejected.length}/${scored.length} rejected ══\n`);
for (const r of rejected.slice(0, 8)) {
  console.log(`[${r.pipeline}] sent=${r.sentenceOverlap.toFixed(2)} vocab=${r.vocabularyBorrowed.toFixed(2)}  ${r.reason}`);
  console.log(`   SRC : ${r.source.slice(0, 130)}`);
  console.log(`   POST: ${r.generated.replace(/\n/g, ' | ').slice(0, 170)}`);
  console.log('');
}

// ─── A few that PASSED, to confirm the gate is not just letting everything through
console.log(`══ Sample of ACCEPTED posts (should read as analysis, not restatement) ══\n`);
const accepted = scored.filter((r) => !isParaphraseOfSource(r.generated, r.source, CHOSEN));
for (const r of accepted.slice(0, 4)) {
  console.log(`[${r.pipeline}] sent=${r.sentenceOverlap.toFixed(2)} vocab=${r.vocabularyBorrowed.toFixed(2)}`);
  console.log(`   SRC : ${r.source.slice(0, 130)}`);
  console.log(`   POST: ${r.generated.replace(/\n/g, ' | ').slice(0, 170)}`);
  console.log('');
}
