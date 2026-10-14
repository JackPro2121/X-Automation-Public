import assert from 'node:assert/strict';

// `tweetLimits.js` reads X_PREMIUM at module-evaluation time and ESM hoists
// static imports above statements, so the env var is set first and the modules
// are pulled in dynamically. Without this the suite silently exercised the
// free-tier limits (277-char cap) while production runs premium (1200-char cap)
// — i.e. it would have tested the wrong configuration.
process.env.X_PREMIUM = 'true';

const { cleanTweetText } = await import('./groqClient.js');
const {
  TWEET_TARGET_CHARS,
  THREAD_TWEET_TARGET_CHARS,
  X_SAFE_MAX_CHARS,
  enforceThreadCharLimits,
  smartTrimToTarget,
} = await import('../tweetLimits.js');

assert.equal(cleanTweetText('No hashtags, emojis, or markdown.'), null);
assert.equal(cleanTweetText('Remember, no emojis and no hashtags.'), null);
assert.equal(
  cleanTweetText('Open-source tools are quietly becoming the fastest path from idea to production.'),
  'Open-source tools are quietly becoming the fastest path from idea to production.'
);

// ─── smartTrimToTarget ───────────────────────────────────────────────────────
// NOTE: this used to assert against the DEFAULT target while feeding it a string
// shorter than that target, which made the assertion vacuously true and hid the
// real bug (the default target was silently 450 while the generator cap was
// 1200). Test an explicit target so the behaviour is actually exercised.
const longCaption = `${'A practical insight for builders. '.repeat(12)}Try it.`;
assert.ok(longCaption.length > 300, 'fixture must exceed the trim target under test');

const trimmed = smartTrimToTarget(longCaption, 300);
assert.ok(trimmed.length <= 300, `smartTrimToTarget must respect an explicit target (got ${trimmed.length})`);
assert.match(trimmed, /[.!?…]$/, 'trim must land on a clean sentence boundary');

// Text already within the target must pass through byte-for-byte.
const shortCaption = 'A short insight worth keeping.';
assert.equal(smartTrimToTarget(shortCaption, 300), shortCaption);

// ─── Length invariants ───────────────────────────────────────────────────────
// The ordering here IS the fix for the silent-truncation bug: if the single-post
// target ever exceeds the generator's hard cap, the publish layer will cut text
// that already passed every quality guard.
assert.ok(
  TWEET_TARGET_CHARS <= X_SAFE_MAX_CHARS,
  `TWEET_TARGET_CHARS (${TWEET_TARGET_CHARS}) must not exceed X_SAFE_MAX_CHARS (${X_SAFE_MAX_CHARS})`
);
assert.ok(
  THREAD_TWEET_TARGET_CHARS <= TWEET_TARGET_CHARS,
  'a tweet inside a thread must be capped tighter than a standalone post'
);

// ─── Threads ─────────────────────────────────────────────────────────────────
// Thread tweets are trimmed to THREAD_TWEET_TARGET_CHARS, not TWEET_TARGET_CHARS.
const thread = enforceThreadCharLimits([longCaption, longCaption]);
assert.ok(
  thread.every((tweet) => tweet.length <= THREAD_TWEET_TARGET_CHARS),
  `thread tweets must respect THREAD_TWEET_TARGET_CHARS (${THREAD_TWEET_TARGET_CHARS})`
);
assert.ok(
  thread.every((tweet) => tweet.length <= X_SAFE_MAX_CHARS),
  'thread tweets must also respect the hard cap'
);

// cleanTweetText enforces the SAFE hard cap (X_SAFE_MAX_CHARS); the tighter
// per-context target trim is applied later at the Buffer posting layer.
const cleanedLongCaption = cleanTweetText(longCaption);
assert.ok(cleanedLongCaption.length <= X_SAFE_MAX_CHARS);

// False-attribution detection: LLM must not claim ownership of community tools
assert.equal(cleanTweetText('I built a tool to repair broken Lottie files in production.'), null);
assert.equal(cleanTweetText('I created a new library to benchmark local models.'), null);
assert.equal(cleanTweetText('My tool simplifies Docker setups for inference.'), null);
assert.ok(cleanTweetText('A developer built a tool to repair broken Lottie files in production.'));

console.log('tweet text and target-length regression checks passed');
