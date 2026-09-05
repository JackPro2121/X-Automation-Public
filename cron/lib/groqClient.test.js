import assert from 'node:assert/strict';
import { cleanTweetText } from './groqClient.js';
import { TWEET_TARGET_CHARS, enforceThreadCharLimits, smartTrimToTarget } from '../tweetLimits.js';

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

const cleanedLongCaption = cleanTweetText(longCaption);
assert.ok(cleanedLongCaption.length <= TWEET_TARGET_CHARS);

console.log('tweet text and target-length regression checks passed');
