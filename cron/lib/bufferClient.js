/**
 * Consolidated Buffer API client.
 * Replaces 3 duplicate implementations across seed_and_post.js, v4/seed_and_post.js, and auto_poster.js.
 *
 * Fixes:
 *  - M4: validates non-empty text before posting
 *  - M5: handles HTTP 429 with Retry-After header parsing + one retry
 *  - F1: GIF size check (reject > 15MB)
 *  - F1b: image size pre-check (reject > 5MB via HEAD content-length)
 *  - F2: Video fallback to image if video fails
 */

import {
  BUFFER_API_URL,
  BUFFER_TIMEOUT_MS,
  BUFFER_SINGLE_MUTATION,
  X_MAX_CHARS,
} from './constants.js';
import { smartTrimToTarget } from '../tweetLimits.js';
import { isMetaTextCaption } from './utils.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_GIF_SIZE_BYTES = 15 * 1024 * 1024; // 15MB Buffer limit
const LARGE_GIF_PATTERNS = [
  /gfycat\.com/i,
  /imgur\.com\/.*\.gif/i,
  /i\.redd\.it\/.*\.gif/i,
];

// Buffer rejects images > 5.0MB (saw a 7.7MB i.redd.it fail live).
// Keep a safety margin below Buffer's limit for content-length variance.
const MAX_IMAGE_SIZE_BYTES = 4.5 * 1024 * 1024;
const IMAGE_CHECK_TIMEOUT_MS = 8000;
const imageSizeCache = new Map();

/**
 * Pre-validate image size via HEAD request before sending to Buffer.
 * Skips images that would exceed Buffer's 5MB limit — Chocodata returns
 * full-size i.redd.it URLs with no thumbnail option, and those can be
 * several MB over the limit (observed 7.7MB).
 * Passes through when the size cannot be determined — Buffer's own
 * rejection then handles it, same as before.
 * @param {string|null} imageUrl
 * @returns {Promise<boolean>} true when safe to post (or unknown)
 */
async function isImageWithinLimit(imageUrl) {
  if (!imageUrl) return true;
  if (imageSizeCache.has(imageUrl)) return imageSizeCache.get(imageUrl);

  let within = true;
  try {
    const res = await fetch(imageUrl, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(IMAGE_CHECK_TIMEOUT_MS),
    });
    const length = parseInt(res.headers.get('content-length') || '0', 10);
    if (length > MAX_IMAGE_SIZE_BYTES) within = false;
  } catch (err) {
    // Unknown size — let Buffer decide.
    within = true;
  }
  imageSizeCache.set(imageUrl, within);
  return within;
}

// ─── Internal: Check if URL is likely a large GIF ─────────────────────────────

function isLikelyLargeGif(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  // Check for known large GIF sources
  for (const pattern of LARGE_GIF_PATTERNS) {
    if (pattern.test(lower)) return true;
  }
  // Check for explicit .gif extension (often large)
  if (lower.endsWith('.gif')) return true;
  return false;
}

/**
 * Public pre-validation: check whether a media URL is within Buffer's limits
 * (Images <= 4.5MB, GIFs <= 15MB).
 * Used during candidate selection so the pipeline skips oversized media
 * and selects the next high-quality candidate instead of failing at Buffer.
 * @param {string|null} mediaUrl
 * @returns {Promise<boolean>}
 */
export async function isMediaWithinLimits(mediaUrl) {
  if (!mediaUrl) return true;
  if (isLikelyLargeGif(mediaUrl)) return false;
  return isImageWithinLimit(mediaUrl);
}

// ─── Internal: Execute Buffer GraphQL request ─────────────────────────────────

/**
 * @param {string} mutation - GraphQL mutation string
 * @param {object} variables - GraphQL variables
 * @param {number} [retryCount=0] - internal retry counter for 429s
 * @returns {Promise<{success: boolean, postId?: string, status?: string, reason?: string}>}
 */
async function executeBufferRequest(mutation, variables, retryCount = 0) {
  const BUFFER_API_KEY = process.env.BUFFER_API_KEY;
  const BUFFER_CHANNEL_ID = process.env.BUFFER_CHANNEL_ID;

  if (!BUFFER_API_KEY || !BUFFER_CHANNEL_ID) {
    console.warn('  ⚠ Buffer credentials missing — DRY RUN');
    return { success: false, reason: 'Missing Buffer credentials' };
  }

  try {
    const res = await fetch(BUFFER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BUFFER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(BUFFER_TIMEOUT_MS),
      body: JSON.stringify({ query: mutation, variables }),
    });

    // Handle rate limiting (M5)
    if (res.status === 429 && retryCount < 1) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '10', 10);
      console.warn(`  ⚠ Buffer rate limited — retrying in ${retryAfter}s...`);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      return executeBufferRequest(mutation, variables, retryCount + 1);
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Buffer HTTP ${res.status}: ${errText.substring(0, 200)}`);
    }

    const data = await res.json();

    if (data?.errors?.length > 0) {
      throw new Error(`Buffer GraphQL: ${data.errors.map(e => e.message).join('; ')}`);
    }

    const result = data?.data?.createPost;

    if (result?.post?.id) {
      console.log(`  ✅ Posted to X! ID: ${result.post.id}`);
      return { success: true, postId: result.post.id, status: result.post.status };
    }

    if (result?.message) {
      throw new Error(`Buffer: ${result.message}`);
    }

    throw new Error('Unexpected Buffer response: ' + JSON.stringify(data).substring(0, 200));
  } catch (err) {
    // Don't log "Buffer credentials missing" as an error
    if (err.message?.includes('Missing Buffer credentials')) {
      return { success: false, reason: err.message };
    }
    console.error(`  ❌ Buffer error: ${err.message}`);
    return { success: false, reason: err.message };
  }
}

// ─── Public: Post a single tweet ──────────────────────────────────────────────

/**
 * Post a single tweet to X via Buffer.
 * Validates non-empty text (M4) and enforces 280 char limit.
 *
 * @param {string} text - tweet text
 * @param {string|null} [imageUrl=null] - optional image URL
 * @returns {Promise<{success: boolean, postId?: string, status?: string, reason?: string}>}
 */
export async function postSingleToBuffer(text, imageUrl = null) {
  // M4: Validate non-empty text
  if (!text || text.trim().length === 0 || text.trim() === '.') {
    console.warn('  ⚠ Skipping Buffer post — empty or garbage text');
    return { success: false, reason: 'Empty or invalid text' };
  }

  // F1c (final defense): reject leaked meta-text captions before they go live
  if (isMetaTextCaption(text)) {
    console.warn('  ⚠ Blocking Buffer post — caption is meta-text (leak)');
    return { success: false, reason: 'Caption is meta-text (leak)' };
  }

  // F1: Check if image is a large GIF (>15MB)
  if (imageUrl && isLikelyLargeGif(imageUrl)) {
    console.warn(`  ⚠ Image URL looks like a large GIF — skipping to avoid 15MB limit`);
    return { success: false, reason: 'GIF likely exceeds 15MB limit' };
  }


  // F1b: Check image byte size (Buffer rejects images > 5MB)
  if (imageUrl && !(await isImageWithinLimit(imageUrl))) {
    console.warn(`  ⚠ Image exceeds Buffer 5MB limit — skipping post`);
    return { success: false, reason: 'Image exceeds 5MB limit' };
  }
  // Enforce 240-char target (smart trim) + 280 hard cap
  let safeText = smartTrimToTarget(text);
  if (safeText.length > X_MAX_CHARS) safeText = safeText.substring(0, X_MAX_CHARS - 1).trim() + '…';

  console.log(`📡 Posting single tweet [${safeText.length} chars]...`);

  const input = {
    text: safeText,
    channelId: process.env.BUFFER_CHANNEL_ID,
    schedulingType: 'automatic',
    mode: 'shareNow',
  };

  if (imageUrl) {
    input.assets = [{ image: { url: imageUrl } }];
  }

  return executeBufferRequest(BUFFER_SINGLE_MUTATION, { input });
}

// ─── Public: Post a multi-tweet thread ────────────────────────────────────────

/**
 * Post a multi-tweet thread to X via Buffer.
 * Validates non-empty tweets (M4) and enforces 280 char limit per tweet.
 *
 * @param {string[]} tweets - array of tweet texts
 * @param {string|null} [imageUrl=null] - optional image URL (attached to first tweet)
 * @returns {Promise<{success: boolean, postId?: string, status?: string, reason?: string}>}
 */
export async function postThreadToBuffer(tweets, imageUrl = null) {
  // M4: Validate non-empty tweets
  const validTweets = tweets.filter(t => t && t.trim().length > 0 && t.trim() !== '.');

  if (validTweets.length === 0) {
    console.warn('  ⚠ Skipping Buffer thread post — no valid tweets');
    return { success: false, reason: 'No valid tweets in thread' };
  }

  if (validTweets.length === 1) {
    return postSingleToBuffer(validTweets[0], imageUrl);
  }

  // F1: Check if image is a large GIF
  if (imageUrl && isLikelyLargeGif(imageUrl)) {
    console.warn(`  ⚠ Image URL looks like a large GIF — skipping to avoid 15MB limit`);
    return { success: false, reason: 'GIF likely exceeds 15MB limit' };
  }


  // F1b: Check image byte size (Buffer rejects images > 5MB)
  if (imageUrl && !(await isImageWithinLimit(imageUrl))) {
    console.warn(`  ⚠ Image exceeds Buffer 5MB limit — skipping post`);
    return { success: false, reason: 'Image exceeds 5MB limit' };
  }
  // Enforce 240-char target (smart trim) + 280 hard cap per tweet
  const safeTweets = validTweets.map(t => {
    let s = smartTrimToTarget(t);
    if (s.length > X_MAX_CHARS) s = s.substring(0, X_MAX_CHARS - 1).trim() + '…';
    return s;
  });

  console.log(`📡 Posting ${safeTweets.length}-tweet thread...`);
  safeTweets.forEach((t, i) => {
    console.log(`  Tweet ${i + 1} [${t.length} chars]: ${t.substring(0, 80)}…`);
  });

  const threadArray = safeTweets.map(t => ({ text: t }));

  const threadMutation = `
    mutation CreateThreadPost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess {
          post { id text status }
        }
        ... on MutationError {
          message
        }
      }
    }
  `;

  const input = {
    text: safeTweets[0],
    channelId: process.env.BUFFER_CHANNEL_ID,
    schedulingType: 'automatic',
    mode: 'shareNow',
    metadata: {
      twitter: { thread: threadArray },
    },
  };

  if (imageUrl) {
    input.assets = [{ image: { url: imageUrl } }];
  }

  return executeBufferRequest(threadMutation, { input });
}

// ─── Public: Post a video tweet ───────────────────────────────────────────────

/**
 * Post a video tweet to X via Buffer.
 * Supports Reddit videos (v.redd.it), YouTube, and direct video URLs.
 * F2: Falls back to image if video fails.
 *
 * @param {string} text - tweet text
 * @param {string} videoUrl - video URL (v.redd.it, YouTube, mp4, etc.)
 * @param {string|null} [imageUrl=null] - optional thumbnail/fallback image
 * @returns {Promise<{success: boolean, postId?: string, status?: string, reason?: string}>}
 */
export async function postVideoToBuffer(text, videoUrl, imageUrl = null) {
  // Validate text
  if (!text || text.trim().length === 0 || text.trim() === '.') {
    console.warn('  ⚠ Skipping Buffer video post — empty text');
    return { success: false, reason: 'Empty or invalid text' };
  }

  // F1c (final defense): reject leaked meta-text captions before they go live
  if (isMetaTextCaption(text)) {
    console.warn('  ⚠ Blocking Buffer video post — caption is meta-text (leak)');
    return { success: false, reason: 'Caption is meta-text (leak)' };
  }

  // Validate video URL
  if (!videoUrl || !videoUrl.startsWith('http')) {
    console.warn('  ⚠ Skipping Buffer video post — invalid video URL');
    return { success: false, reason: 'Invalid video URL' };
  }

  // F1: Check if video is a large GIF
  if (isLikelyLargeGif(videoUrl)) {
    console.warn(`  ⚠ Video URL looks like a large GIF — trying image fallback`);
    if (imageUrl) {
      return postSingleToBuffer(text, imageUrl);
    }
    return { success: false, reason: 'GIF likely exceeds 15MB limit, no fallback image' };
  }

  // Enforce 240-char target (smart trim) + 280 hard cap
  let safeText = smartTrimToTarget(text);
  if (safeText.length > X_MAX_CHARS) safeText = safeText.substring(0, X_MAX_CHARS - 1).trim() + '…';

  console.log(`📡 Posting video tweet [${safeText.length} chars]...`);
  console.log(`  🎬 Video: ${videoUrl.substring(0, 80)}...`);

  const input = {
    text: safeText,
    channelId: process.env.BUFFER_CHANNEL_ID,
    schedulingType: 'automatic',
    mode: 'shareNow',
    assets: [{ video: { url: videoUrl } }],
  };

  // X video thumbnail handling
  // Buffer rejects thumbnailUrl for X videos. X selects the thumbnail itself;
  // keep imageUrl only for the image-post fallback below.

  const result = await executeBufferRequest(BUFFER_SINGLE_MUTATION, { input });

  // F2: If video fails and we have an image, fallback to image post
  if (!result.success && imageUrl) {
    console.log(`  ⚠ Video failed — falling back to image post...`);
    return postSingleToBuffer(text, imageUrl);
  }

  return result;
}

// ─── Public: Post to Buffer Queue (excess posts) ─────────────────────────────

/**
 * Post a tweet to Buffer's internal queue (not immediate).
 * Buffer will auto-publish according to the channel's posting schedule.
 * Used for excess quality posts that don't need immediate publishing.
 *
 * @param {string} text - tweet text
 * @param {string|null} [imageUrl=null] - optional image URL
 * @returns {Promise<{success: boolean, postId?: string, status?: string, reason?: string}>}
 */
export async function postToQueue(text, imageUrl = null) {
  if (!text || text.trim().length === 0 || text.trim() === '.') {
    return { success: false, reason: 'Empty or invalid text' };
  }
  // F1c: Reject leaked meta-text captions (shared detector — see utils.js)
  if (isMetaTextCaption(text)) {
    return { success: false, reason: 'Caption is meta-text (leak)' };
  }

  if (imageUrl && isLikelyLargeGif(imageUrl)) {
    return { success: false, reason: 'GIF likely exceeds 15MB limit' };
  }

  // F1b: Check image byte size (Buffer rejects images > 5MB)
  if (imageUrl && !(await isImageWithinLimit(imageUrl))) {
    console.warn(`  ⚠ Image exceeds Buffer 5MB limit — skipping post`);
    return { success: false, reason: 'Image exceeds 5MB limit' };
  }

  let safeText = smartTrimToTarget(text);
  if (safeText.length > X_MAX_CHARS) safeText = safeText.substring(0, X_MAX_CHARS - 1).trim() + '…';

  console.log(`📡 Queuing tweet [${safeText.length} chars]...`);

  const input = {
    text: safeText,
    channelId: process.env.BUFFER_CHANNEL_ID,
    schedulingType: 'automatic',
    mode: 'addToQueue',  // Buffer queue — auto-publishes on schedule
  };

  if (imageUrl) {
    input.assets = [{ image: { url: imageUrl } }];
  }

  return executeBufferRequest(BUFFER_SINGLE_MUTATION, { input });
}

// ─── Public: Quote Tweet (retweet with comment) ─────────────────────────────

/**
 * Post a quote tweet to X via Buffer.
 * Uses Buffer's retweet metadata to embed the original tweet with our comment.
 *
 * @param {string} comment - our take/comment on the tweet (max 200 chars)
 * @param {string} tweetId - original tweet ID to quote
 * @returns {Promise<{success: boolean, postId?: string, status?: string, reason?: string}>}
 */
export async function postQuoteTweet(comment, tweetId) {
  if (!comment || comment.trim().length === 0) {
    return { success: false, reason: 'Empty comment' };
  }

  if (!tweetId) {
    return { success: false, reason: 'Missing tweet ID' };
  }

  let safeComment = smartTrimToTarget(comment);
  if (safeComment.length > X_MAX_CHARS) safeComment = safeComment.substring(0, X_MAX_CHARS - 1).trim() + '…';

  console.log(`📡 Quote tweeting [${safeComment.length} chars]...`);
  console.log(`  🔗 Original tweet: ${tweetId}`);

  const input = {
    text: safeComment,
    channelId: process.env.BUFFER_CHANNEL_ID,
    schedulingType: 'automatic',
    mode: 'shareNow',
    metadata: {
      twitter: {
        retweet: {
          id: tweetId,
          comment: safeComment,
        },
      },
    },
  };

  return executeBufferRequest(BUFFER_SINGLE_MUTATION, { input });
}
