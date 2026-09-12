import assert from 'node:assert/strict';
import { isTooSimilarToSource } from './utils.js';

// A scraped source post (Reddit/X) that we must NOT just reword.
const source =
  'New open source model released today that runs entirely on a single consumer GPU ' +
  'and beats the previous generation on coding benchmarks while using half the memory.';

// 1. Verbatim copy of the source → must be rejected (hard plagiarism tell).
assert.equal(isTooSimilarToSource(source, source), true, 'verbatim copy must be flagged');

// 2. Minimal reword (a few words swapped) → must be rejected (X "minimally modified").
const reword =
  'A new open source model launched today that runs completely on a single consumer GPU ' +
  'and beats the last generation on coding benchmarks while using half the memory.';
assert.equal(isTooSimilarToSource(reword, source), true, 'minimal reword must be flagged');

// 3. Genuinely original take that shares only topic keywords → must PASS.
const originalTake =
  "Everyone's hyped about single-GPU models, but the real story nobody mentions is what " +
  'this does to inference cost curves. I ran the numbers and the memory halving matters ' +
  'more for batch throughput than for hobbyists. Which side are you on?';
assert.equal(isTooSimilarToSource(originalTake, source), false, 'original analysis must pass');

// 4. Short/empty inputs → never block (avoid false positives on thin data).
assert.equal(isTooSimilarToSource('too short', source), false, 'very short output must pass');
assert.equal(isTooSimilarToSource(originalTake, ''), false, 'empty source must pass');
assert.equal(isTooSimilarToSource('', source), false, 'empty output must pass');

// 5. Env-tunable thresholds are honored (stricter verbatim cap flags more).
process.env.ORIGINALITY_VERBATIM_MAX = '4';
assert.equal(
  isTooSimilarToSource('runs entirely on a single consumer GPU today', source),
  true,
  'stricter verbatim cap must flag a 5-word copied run'
);
delete process.env.ORIGINALITY_VERBATIM_MAX;

console.log('originality gate regression checks passed');
