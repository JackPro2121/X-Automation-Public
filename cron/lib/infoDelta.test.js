import assert from 'node:assert/strict';
import { hasInformationDelta, isInfoDeltaEnforced } from './utils.js';

// The metric that measures whether a post REASONS about its source or just
// RESTATES it. This is the axis that decides monetization eligibility, and two
// calibration passes proved it is invisible to text-similarity metrics.
//
// Fixtures are real (source → post) pairs from production, including the ones
// that exposed the precision bug in the first implementation.

const source =
  'New open source model released today that runs entirely on a single consumer GPU ' +
  'and beats the previous generation on coding benchmarks while using half the memory.';

// 1. A pure restatement → NO delta. This is the failure mode the whole exercise
//    is about, so it is the first thing that must hold.
const restatement =
  'A new open source model released today runs entirely on a single consumer GPU. ' +
  'It beats the previous generation on coding benchmarks while using half the memory.';
const r1 = hasInformationDelta(restatement, source, { explain: true });
assert.equal(r1.hasDelta, false, 'restatement must report no delta');
assert.equal(r1.reasoned, false, 'restatement must not report reasoning');
assert.equal(r1.ambiguous, false, 'restatement must not report an ambiguous figure');

// 2. Reasoning language → delta, and it must be the TRUSTWORTHY signal.
const reasoned =
  'Everyone is celebrating the memory halving, but my read is that it matters far more for ' +
  'batch throughput than for hobbyists. The bottleneck moves to the memory bus once you ' +
  'batch, and the real cost shows up in serving, not in training.';
const r2 = hasInformationDelta(reasoned, source, { explain: true });
assert.equal(r2.reasoned, true, 'analysis language must register as reasoning');
assert.equal(r2.hasDelta, true, 'reasoning implies delta');
assert.ok(r2.markers.length > 0, 'the matched marker must be reported for debuggability');

// 3. A unit-bearing figure absent from the source → delta, but flagged AMBIGUOUS,
//    because nothing lexical distinguishes a derivation from an invention.
//    NOTE: this fixture must contain NO reasoning marker and NO visible working —
//    an earlier version of it said "at 12GB per replica you fit 3x the batch",
//    which the marker list correctly reclassified as reasoning. This is the bare
//    invented-statistic shape that has no derivation attached at all.
const novelFigure =
  'Adoption is the real signal here: 36% of users picked the smaller model, which is why ' +
  'the release matters so much for anyone running inference on their own hardware.';
const r3 = hasInformationDelta(novelFigure, source, { explain: true });
assert.equal(r3.novelFigure, true, 'a unit-bearing novel figure must be detected');
assert.equal(r3.reasoned, false, 'a bare statistic carries no reasoning');
assert.equal(r3.ambiguous, true, 'a novel figure without reasoning must be flagged ambiguous');
assert.ok(r3.reason.includes('AMBIGUOUS'), 'the ambiguity must be stated in the reason');

// 4. REGRESSION — the current year and historical years must NOT count as novel
//    figures. The first implementation flagged a verbatim restatement as
//    "computed" on novelNumbers=[3, 2026, 13, 2002, 2013]: the prompt injects
//    CURRENT DATE, and posts reference years as dates, not as figures.
const yearPost =
  'For the first time since 1950, the Atlantic has made it past September 11 without a ' +
  'hurricane. The 2026 season is now the latest on record, and it lines up with what ' +
  'people have been saying since 2002 about the pattern changing.';
const r4 = hasInformationDelta(yearPost, 'For the first time since 1950, the Atlantic has made it past September 11 without a hurricane', { explain: true });
assert.equal(r4.novelFigure, false, 'years must never be treated as novel figures');

// 5. Bare integers without units are not figures either (list markers, counts).
const bareInts =
  'Three things stand out here. 1. It is cheap. 2. It is fast. 3. It is small. ' +
  'That is the entire pitch, and it is a good one for anyone shipping this week.';
const r5 = hasInformationDelta(bareInts, source, { explain: true });
assert.equal(r5.novelFigure, false, 'bare integers without units must not count as figures');

// 6. Percentages and currency DO count — that is the arithmetic the prompt asks for.
const realMath =
  'The source says half the memory, so at $2 per GPU-hour that is a 50% cut in cost per ' +
  'replica, and it works out to roughly half the serving bill at the same throughput.';
const r6 = hasInformationDelta(realMath, source, { explain: true });
assert.equal(r6.novelFigure, true, 'a currency figure must be detected as a novel figure');
assert.equal(r6.reasoned, true, 'arithmetic phrasing must also register as reasoning');

// 7. Short-circuit contract: default return is a boolean, explain returns the object.
assert.equal(typeof hasInformationDelta(reasoned, source), 'boolean', 'default return must be a boolean');
assert.equal(typeof hasInformationDelta(reasoned, source, { explain: true }), 'object', 'explain must return an object');

// 8. Thin inputs must not crash or produce a bogus positive.
for (const [g, s] of [['', source], [reasoned, ''], ['', ''], ['hi', 'ok']]) {
  const v = hasInformationDelta(g, s, { explain: true });
  assert.equal(typeof v.hasDelta, 'boolean', 'thin input must still return a verdict');
}

// 9. The metric must be SHADOW MODE by default. Enforcing an unmeasured gate is
//    how the paraphrase gate ended up rejecting ~1% of posts and doing nothing —
//    so the default here is log-only, and this test locks that in.
delete process.env.REQUIRE_INFO_DELTA;
assert.equal(isInfoDeltaEnforced(), false, 'information-delta must be shadow mode by default');
process.env.REQUIRE_INFO_DELTA = 'true';
assert.equal(isInfoDeltaEnforced(), true, 'REQUIRE_INFO_DELTA=true must enable enforcement');
delete process.env.REQUIRE_INFO_DELTA;

// 10. A derived figure that carries reasoning is NOT ambiguous — the strong case.
const both = hasInformationDelta(realMath, source, { explain: true });
assert.equal(both.ambiguous, false, 'reasoned + figure is the strong case, not ambiguous');

console.log('information-delta regression checks passed');

// ─── finalizeThread: the unguarded production path ───────────────────────────
// v3 and v4 both publish multi-tweet threads, and both called finalizePostText
// per tweet with `checkOriginality: false` under a comment claiming "the thread
// generator already de-dupes vs source". That comment was false — parseThread()
// had no similarity check. These assertions lock the hole shut.
const { finalizeThread } = await import('./utils.js');

const articleSource =
  'New open source model released today that runs entirely on a single consumer GPU ' +
  'and beats the previous generation on coding benchmarks while using half the memory.';

// A thread that just walks through the article = the exact failure mode.
const derivativeThread = [
  'A new open source model was released today.',
  'It runs entirely on a single consumer GPU and beats the previous generation on coding benchmarks.',
  'It also uses half the memory of the previous generation.',
];
const t1 = finalizeThread(derivativeThread, { sourceText: articleSource, label: 'test derivative thread' });
assert.equal(t1.ok, false, 'a thread that restates its source must be rejected');
assert.match(t1.reason, /too similar/i);

// A thread that computes rather than restates must pass.
const analysisThread = [
  'Half the memory is the whole story here, and the arithmetic is what makes it interesting.',
  'If you were memory-bound at 24GB per replica, halving it means 12GB, so the same card fits two replicas instead of one.',
  'That doubles throughput per GPU-hour, which matters far more for serving than for the hobbyist single-card case.',
];
const t2 = finalizeThread(analysisThread, { sourceText: articleSource, label: 'test analysis thread' });
assert.equal(t2.ok, true, `an analysis thread must pass (reason: ${t2.reason})`);
assert.equal(t2.tweets.length, 3, 'passing threads must be returned intact');

// Threads are the unit — a single short fragment must NOT be judged alone.
assert.equal(t2.delta !== null, true, 'the delta signal must be produced for threads too');

// Arithmetic written in WORDS must count as reasoning. The thread above says
// "halving it means 12GB ... that doubles throughput per GPU-hour" — a real
// derivation with no digit-bearing operator, which the marker list missed.
assert.equal(
  hasInformationDelta('If you were memory-bound at 24GB per replica, halving it means 12GB, so the same card fits two replicas instead of one.', articleSource),
  true,
  'word-form arithmetic ("halving", "fits two") must register as reasoning'
);

// Degenerate input must fail cleanly rather than throw.
assert.equal(finalizeThread([], { sourceText: articleSource }).ok, false, 'empty thread must be rejected');
assert.equal(finalizeThread(['only one tweet here'], { sourceText: articleSource }).ok, false, 'a 1-tweet thread must be rejected');
assert.equal(finalizeThread(analysisThread, {}).ok, true, 'a thread with no source must still pass');

console.log('thread-level originality checks passed');
