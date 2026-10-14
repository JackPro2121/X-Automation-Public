import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.X_PREMIUM = 'true';

const {
  X_MAX_CHARS, X_SAFE_MAX_CHARS, TWEET_TARGET_CHARS, THREAD_TWEET_TARGET_CHARS, MIN_TWEET_CHARS,
} = await import('../tweetLimits.js');
const { POST_SHAPES } = await import('./groqClient.js');

// ═══════════════════════════════════════════════════════════════════════════════
// 1. THE CONFIG INVARIANT — every shape's target range must be REACHABLE.
//
// A shape whose targetLen floor sits below MIN_TWEET_CHARS can never produce a
// post that passes the finalizer: it aims short, the floor rejects short. The
// shape is then a guaranteed-failure slot in the rotation, wasting a share of
// every generation budget and silently reducing output volume.
//
// This is not hypothetical. It is exactly what shipped on Sep 15, 2026: the
// `one_liner` shape targeted [80, 200] while the floor was 160, and when the
// floor was raised to 280 it would have targeted [80, 200] against a 280 floor —
// a shape that could not win. Same class as the 450-char silent truncation.
// ═══════════════════════════════════════════════════════════════════════════════

for (const s of POST_SHAPES) {
  const [lo, hi] = s.targetLen;
  assert.ok(Array.isArray(s.targetLen) && s.targetLen.length === 2, `${s.id}: targetLen must be [min, max]`);
  assert.ok(lo < hi, `${s.id}: targetLen min (${lo}) must be below max (${hi})`);
  assert.ok(
    lo >= MIN_TWEET_CHARS,
    `${s.id} targets from ${lo} but MIN_TWEET_CHARS is ${MIN_TWEET_CHARS} — this shape can never pass the finalizer`
  );
  assert.ok(
    hi <= X_SAFE_MAX_CHARS,
    `${s.id} targets up to ${hi} but X_SAFE_MAX_CHARS is ${X_SAFE_MAX_CHARS} — this shape would be trimmed below its own target`
  );
}

// 2. The shape spread must actually cover the intended 300–1200 range, not
//    cluster at one end. Length variety is deliberate; a feed where every post is
//    the same size is its own automated tell.
const floors = POST_SHAPES.map((s) => s.targetLen[0]);
const ceilings = POST_SHAPES.map((s) => s.targetLen[1]);
assert.ok(Math.min(...floors) <= 320, `some shape must target the bottom of the range (lowest floor: ${Math.min(...floors)})`);
assert.ok(Math.max(...ceilings) >= 1100, `some shape must target the top of the range (highest ceiling: ${Math.max(...ceilings)})`);
assert.ok(
  new Set(floors).size >= 3,
  `shapes should offer at least 3 distinct length tiers (got ${[...new Set(floors)].join(', ')})`
);

// 3. Ordering invariants between the limits themselves.
assert.ok(MIN_TWEET_CHARS < TWEET_TARGET_CHARS, 'the minimum must be below the target');
assert.ok(TWEET_TARGET_CHARS <= X_SAFE_MAX_CHARS, `TWEET_TARGET_CHARS (${TWEET_TARGET_CHARS}) must not exceed the safe cap (${X_SAFE_MAX_CHARS})`);
assert.ok(THREAD_TWEET_TARGET_CHARS < TWEET_TARGET_CHARS, 'thread tweets must stay shorter than single posts');
assert.ok(X_SAFE_MAX_CHARS < X_MAX_CHARS, 'the generator cap must sit below the platform limit');

// 4. X Premium really does allow 25,000 — the cap above it is a policy choice,
//    not a platform limit, and the distinction matters when tuning.
assert.equal(X_MAX_CHARS, 25000, 'X Premium platform limit is 25,000 characters');

// ═══════════════════════════════════════════════════════════════════════════════
// 5. THE MIRROR DRIFT CHECK.
//
// `src/utils/tweetLimits.ts` is a hand-maintained mirror of `cron/tweetLimits.js`
// (the frontend cannot import from cron/). These two files drifted once before —
// X_SAFE_MAX_CHARS was 1200 in one and 24000 in the other — and the consequence
// was every post being silently re-cut to 450 chars at publish time. A duplicated
// source of truth needs a test, or it is not a source of truth.
// ═══════════════════════════════════════════════════════════════════════════════

const tsSource = fs.readFileSync('src/utils/tweetLimits.ts', 'utf8');
const tsConst = (name) => {
  const m = tsSource.match(new RegExp(`export const ${name}\\s*=\\s*[^;]+;`));
  assert.ok(m, `${name} not found in src/utils/tweetLimits.ts`);
  return m[0].replace(/\s+/g, ' ').trim();
};

const pairs = [
  ['X_MAX_CHARS', X_MAX_CHARS],
  ['X_SAFE_MAX_CHARS', X_SAFE_MAX_CHARS],
  ['TWEET_TARGET_CHARS', TWEET_TARGET_CHARS],
  ['THREAD_TWEET_TARGET_CHARS', THREAD_TWEET_TARGET_CHARS],
  ['MIN_TWEET_CHARS', MIN_TWEET_CHARS],
];

for (const [name, jsValue] of pairs) {
  const declaration = tsConst(name);
  assert.ok(
    declaration.includes(String(jsValue)),
    `MIRROR DRIFT: ${name} is ${jsValue} in cron/tweetLimits.js but the .ts mirror says "${declaration}"`
  );
}

console.log('limit invariants and mirror-drift checks passed');
