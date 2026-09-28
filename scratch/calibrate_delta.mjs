/**
 * Calibrate the INFORMATION-DELTA metric against REAL shipped posts.
 *
 * This is the axis that decides monetization eligibility, and the two previous
 * calibration passes proved it is invisible to text-similarity metrics:
 *   sentenceOverlap   median 0.00
 *   first-sentence    median 0.00  (3/82 copy the source opening)
 *   vocabularyBorrowed median 0.15
 * Different words, same information.
 *
 * So: score the OLD posts with the NEW metric. If the metric is any good, the
 * old posts should mostly FAIL it — because they were written under the old
 * prompt that capped them at "facts that appear in the POST below". That gives
 * a before/after benchmark for the prompt rewrite.
 *
 * Usage: node scratch/calibrate_delta.mjs
 */

import fs from 'node:fs';

process.env.X_PREMIUM = 'true';
const { hasInformationDelta } = await import('../cron/lib/utils.js');

const pairs = JSON.parse(fs.readFileSync('scratch/pairs.json', 'utf8'));

const REAL_SOURCE_PIPELINES = new Set(['v3', 'v4', 'catchup', 'v6']);
const rows = pairs.filter((p) => REAL_SOURCE_PIPELINES.has(p.pipeline) && p.source.length >= 20);

console.log(`Scoring ${rows.length} real (source -> published post) pairs from the OLD prompt\n`);

const scored = rows.map((r) => ({ ...r, ...hasInformationDelta(r.generated, r.source, { explain: true }) }));

const withDelta = scored.filter((r) => r.hasDelta);
const computed = scored.filter((r) => r.novelFigure);
const reasoned = scored.filter((r) => r.reasoned);
const neither = scored.filter((r) => !r.hasDelta);

const pct = (n) => `${((n / scored.length) * 100).toFixed(0)}%`;

console.log('══ RESULT — how many OLD posts carry information their source does not ══\n');
console.log(`  total scored            ${scored.length}`);
console.log(`  HAS delta               ${String(withDelta.length).padStart(4)}  ${pct(withDelta.length)}`);
console.log(`    ├ novel figure only  ${String(computed.length).padStart(4)}  ${pct(computed.length)}`);
console.log(`    └ reasoned (markers)  ${String(reasoned.length).padStart(4)}  ${pct(reasoned.length)}`);
console.log(`  NO delta (restatement)  ${String(neither.length).padStart(4)}  ${pct(neither.length)}`);

// ─── Per-pipeline breakdown ──────────────────────────────────────────────────
console.log('\n══ By pipeline ══\n');
const byPipe = {};
for (const r of scored) {
  byPipe[r.pipeline] ??= { n: 0, delta: 0 };
  byPipe[r.pipeline].n++;
  if (r.hasDelta) byPipe[r.pipeline].delta++;
}
for (const [p, v] of Object.entries(byPipe).sort((a, b) => b[1].n - a[1].n)) {
  const rate = ((v.delta / v.n) * 100).toFixed(0);
  const bar = '█'.repeat(Math.round((v.delta / v.n) * 20)).padEnd(20, '·');
  console.log(`  ${p.padEnd(10)} ${bar} ${String(v.delta).padStart(3)}/${String(v.n).padStart(3)}  ${rate.padStart(3)}%`);
}

// ─── What the metric flags as restatement ────────────────────────────────────
console.log(`\n══ Sample of posts with NO information delta (${neither.length} total) ══\n`);
for (const r of neither.slice(0, 6)) {
  console.log(`[${r.pipeline}] vocabBorrowed=${r.vocabularyBorrowed.toFixed(2)}  ${r.reason}`);
  console.log(`   SRC : ${r.source.replace(/\n/g, ' ').slice(0, 150)}`);
  console.log(`   POST: ${r.generated.replace(/\n/g, ' | ').slice(0, 190)}`);
  console.log('');
}

// ─── What it credits as genuine analysis ─────────────────────────────────────
console.log(`\n══ Sample of posts WITH a delta (should read as analysis, not restatement) ══\n`);
for (const r of withDelta.slice(0, 5)) {
  const tag = r.reasoned ? (r.novelFigure ? "reasoned+figure" : "reasoned") : "figure-only (ambiguous)";
  console.log(`[${r.pipeline}] ${tag}  numbers=[${r.novelNumbers.join(', ')}] markers=[${r.markers.slice(0, 3).join(', ')}]`);
  console.log(`   SRC : ${r.source.replace(/\n/g, ' ').slice(0, 150)}`);
  console.log(`   POST: ${r.generated.replace(/\n/g, ' | ').slice(0, 190)}`);
  console.log('');
}

// ─── Marker hit distribution — which markers are doing the work ──────────────
console.log('══ Marker frequency (top 12) ══\n');
const freq = {};
for (const r of scored) for (const mk of r.markers) freq[mk] = (freq[mk] || 0) + 1;
for (const [mk, n] of Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(n).padStart(3)}  "${mk}"`);
}
