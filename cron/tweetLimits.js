/** X Free / standard post text limit (characters). */
export const X_MAX_CHARS = 280;

/** Safe max for generated content (room for trim ellipsis). */
export const X_SAFE_MAX_CHARS = 277;

/** Target length for generated tweets (room for line breaks, emoji, URL). */
export const TWEET_TARGET_CHARS = 240;

/**
 * Smart-trim text to a target length at a sentence/line/word boundary.
 * Never rejects — over-length content is trimmed so scraped posts aren't wasted.
 * @param {string} text
 * @param {number} [target=TWEET_TARGET_CHARS]
 * @returns {string}
 */
export function smartTrimToTarget(text, target = TWEET_TARGET_CHARS) {
  if (!text) return '';
  if (text.length <= target) return text;
  const minimumUsefulLength = target * 0.6;
  // Prefer a complete sentence, then a line. A plain word boundary gets an
  // ellipsis so a truncated thought never looks like a finished caption.
  const sentenceEnd = Math.max(
    text.lastIndexOf('.', target),
    text.lastIndexOf('!', target),
    text.lastIndexOf('?', target)
  );
  if (sentenceEnd >= minimumUsefulLength) return text.substring(0, sentenceEnd + 1).trim();

  const lineEnd = text.lastIndexOf('\n', target);
  if (lineEnd >= minimumUsefulLength) return text.substring(0, lineEnd).trim();

  const wordEnd = text.lastIndexOf(' ', target - 1);
  if (wordEnd >= minimumUsefulLength) return text.substring(0, wordEnd).trim() + '…';
  return text.substring(0, target - 1).trim() + '…';
}

export function smartTrimTweet(text) {
  if (!text) return '';
  if (text.length <= X_SAFE_MAX_CHARS) return text;
  const cuts = [
    text.lastIndexOf('.', X_SAFE_MAX_CHARS),
    text.lastIndexOf('\n', X_SAFE_MAX_CHARS),
    text.lastIndexOf('—', X_SAFE_MAX_CHARS),
    text.lastIndexOf(' ', X_SAFE_MAX_CHARS)
  ];
  const best = Math.max(...cuts.filter((c) => c >= 80));
  if (best >= 80) return text.substring(0, best + 1).trim();
  return text.substring(0, X_SAFE_MAX_CHARS - 1).trim() + '…';
}

/** Enforce the 240-char target (smart trim) + 280-char hard cap on every tweet in a thread. */
export function enforceThreadCharLimits(tweets) {
  return tweets.map((t) => {
    const trimmed = smartTrimToTarget(smartTrimTweet(t.trim()));
    if (trimmed.length > X_MAX_CHARS) {
      return trimmed.substring(0, X_MAX_CHARS - 1) + '…';
    }
    return trimmed;
  });
}

export function threadWithinLimits(tweets) {
  return tweets.every((t) => t.length > 0 && t.length <= X_MAX_CHARS);
}
