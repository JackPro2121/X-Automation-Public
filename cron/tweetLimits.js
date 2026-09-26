import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

export const IS_X_PREMIUM = process.env.X_PREMIUM === 'true';

/**
 * ── SINGLE SOURCE OF TRUTH FOR EVERY LENGTH LIMIT ─────────────────────────────
 *
 * Historically this file and `lib/constants.js` both exported an
 * `X_SAFE_MAX_CHARS` with different values (1200 vs 24000), and
 * `TWEET_TARGET_CHARS` (450) was used as the *default* trim target inside
 * `bufferClient.js`. The result: every post was silently re-cut to 450 chars at
 * publish time, AFTER all quality guards had validated the full text — so ~12%
 * of live posts lost their ending and their CTA, while the DB stored the intact
 * version and nobody noticed. See AUDIT_2026-09-15.md §1.
 *
 * The rule now:
 *   X_MAX_CHARS        = the platform's own limit (last-resort safety only)
 *   X_SAFE_MAX_CHARS   = the GENERATOR's hard cap; pipelines trim to this
 *   TWEET_TARGET_CHARS = the single-post sweet spot (what a post SHOULD be)
 *   THREAD_TWEET_TARGET_CHARS = per-tweet cap INSIDE a thread (much shorter)
 *
 * The publish layer must never trim below X_SAFE_MAX_CHARS. If it has to, that
 * is a bug and it now logs loudly instead of doing it silently.
 */

/** X post text limit (characters): 25,000 for X Premium, 280 for free standard. */
export const X_MAX_CHARS = IS_X_PREMIUM ? 25000 : 280;

/**
 * Hard cap the GENERATOR enforces on a finished post. The account is X Premium
 * with a 25,000-char platform limit, so this is set just below it (24,000) —
 * a long-form post is legitimate, not a violation. The publish layer keeps
 * X_MAX_CHARS as the absolute backstop. Non-Premium stays at 277.
 */
export const X_SAFE_MAX_CHARS = IS_X_PREMIUM ? 24000 : 277;

/**
 * Minimum acceptable length for a finished post.
 *
 * Raised 160 → 280 (Sep 15, 2026). The account is X Premium with a 25,000-char
 * platform limit. A 160-char floor was admitting posts the account never wanted
 * to ship — a queue scan found 77- and 110-char posts passing every gate.
 *
 * 280 sits just under the 300 target floor so a post that lands slightly short of
 * its shape's range is not thrown away, while anything genuinely tiny is rejected.
 *
 * Threads and replies deliberately override this (a thread tweet and a reply are
 * short by design) — see THREAD_TWEET_TARGET_CHARS and replyGuardFloor callers.
 */
export const MIN_TWEET_CHARS = IS_X_PREMIUM ? 280 : 100;

/**
 * Target length for a single generated post. Must be <= X_SAFE_MAX_CHARS so the
 * publish layer's safety trim can never cut below what the generator produced.
 */
export const TWEET_TARGET_CHARS = IS_X_PREMIUM ? 1000 : 240;

/**
 * Target length for ONE tweet inside a multi-tweet thread. Threads stay short on
 * purpose — a 1000-char tweet inside a thread reads badly and defeats the format.
 */
export const THREAD_TWEET_TARGET_CHARS = IS_X_PREMIUM ? 450 : 240;

/**
 * Smart-trim text to a target length at a paragraph/sentence/line/word boundary.
 * Never rejects — over-length content is trimmed so scraped posts aren't wasted.
 * @param {string} text
 * @param {number} [target=TWEET_TARGET_CHARS]
 * @returns {string}
 */
export function smartTrimToTarget(text, target = TWEET_TARGET_CHARS) {
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

/** Enforce target (smart trim) + hard cap on every tweet in a thread. */
export function enforceThreadCharLimits(tweets) {
  return tweets.map((t) => {
    const trimmed = smartTrimToTarget(smartTrimTweet(t.trim()), THREAD_TWEET_TARGET_CHARS);
    if (trimmed.length > X_MAX_CHARS) {
      return trimmed.substring(0, X_MAX_CHARS - 1) + '…';
    }
    return trimmed;
  });
}

export function threadWithinLimits(tweets) {
  return tweets.every((t) => t.length > 0 && t.length <= X_MAX_CHARS);
}
