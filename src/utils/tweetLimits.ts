export const IS_X_PREMIUM = typeof (globalThis as any).process !== 'undefined' 
  ? (globalThis as any).process?.env?.X_PREMIUM === 'true' 
  : (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_X_PREMIUM === 'true');

export const X_MAX_CHARS = IS_X_PREMIUM ? 25000 : 280;
export const X_SAFE_MAX_CHARS = IS_X_PREMIUM ? 1200 : 277;

/** Target length for generated tweets (450 for Premium sweet-spot 250-500, 240 for Free). */
export const TWEET_TARGET_CHARS = IS_X_PREMIUM ? 450 : 240;

/**
 * Smart-trim text to a target length at a paragraph/sentence/line/word boundary.
 * Never rejects — over-length content is trimmed so scraped posts aren't wasted.
 */
export function smartTrimToTarget(text: string, target: number = TWEET_TARGET_CHARS): string {
  if (!text) return '';
  if (text.length <= target) return text;
  const minimumUsefulLength = target * 0.6;

  // 1. Prefer trimming at a clean paragraph break (\n\n)
  const paragraphEnd = text.lastIndexOf('\n\n', target);
  if (paragraphEnd >= minimumUsefulLength) return text.substring(0, paragraphEnd).trim();

  // 2. Prefer a complete sentence
  const sentenceEnd = Math.max(
    text.lastIndexOf('.', target),
    text.lastIndexOf('!', target),
    text.lastIndexOf('?', target)
  );
  if (sentenceEnd >= minimumUsefulLength) return text.substring(0, sentenceEnd + 1).trim();

  // 3. Prefer a line boundary
  const lineEnd = text.lastIndexOf('\n', target);
  if (lineEnd >= minimumUsefulLength) return text.substring(0, lineEnd).trim();

  // 4. Plain word boundary gets an ellipsis
  const wordEnd = text.lastIndexOf(' ', target - 1);
  if (wordEnd >= minimumUsefulLength) return text.substring(0, wordEnd).trim() + '…';
  return text.substring(0, target - 1).trim() + '…';
}

export function smartTrimTweet(text: string): string {
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

export function enforceThreadCharLimits(tweets: string[]): string[] {
  return tweets.map((t) => {
    const trimmed = smartTrimToTarget(smartTrimTweet(t.trim()));
    if (trimmed.length > X_MAX_CHARS) {
      return trimmed.substring(0, X_MAX_CHARS - 1) + '…';
    }
    return trimmed;
  });
}

export function threadWithinLimits(tweets: string[]): boolean {
  return tweets.every((t) => t.length > 0 && t.length <= X_MAX_CHARS);
}
