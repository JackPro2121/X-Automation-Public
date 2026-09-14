import assert from 'node:assert/strict';
import { cleanTweetText } from './groqClient.js';
import { TWEET_TARGET_CHARS, X_SAFE_MAX_CHARS, enforceThreadCharLimits, smartTrimToTarget } from '../tweetLimits.js';

assert.equal(cleanTweetText('No hashtags, emojis, or markdown.'), null);
assert.equal(cleanTweetText('Remember, no emojis and no hashtags.'), null);
assert.equal(
  cleanTweetText('Open-source tools are quietly becoming the fastest path from idea to production.'),
  'Open-source tools are quietly becoming the fastest path from idea to production.'
);

const longCaption = `${'A practical insight for builders. '.repeat(12)}Try it.`;
const trimmed = smartTrimToTarget(longCaption);
assert.ok(trimmed.length <= TWEET_TARGET_CHARS);
assert.match(trimmed, /[.!?…]$/);

const thread = enforceThreadCharLimits([longCaption, longCaption]);
assert.ok(thread.every((tweet) => tweet.length <= TWEET_TARGET_CHARS));

// cleanTweetText enforces the SAFE hard cap (X_SAFE_MAX_CHARS); the tighter
// TWEET_TARGET_CHARS trim is applied later at the Buffer posting layer.
const cleanedLongCaption = cleanTweetText(longCaption);
assert.ok(cleanedLongCaption.length <= X_SAFE_MAX_CHARS);

// False-attribution detection: LLM must not claim ownership of community tools
assert.equal(cleanTweetText('I built a tool to repair broken Lottie files in production.'), null);
assert.equal(cleanTweetText('I created a new library to benchmark local models.'), null);
assert.equal(cleanTweetText('My tool simplifies Docker setups for inference.'), null);
assert.ok(cleanTweetText('A developer built a tool to repair broken Lottie files in production.'));

console.log('tweet text and target-length regression checks passed');
