/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   X-AUTOMATION — CHOCODATA REDDIT CLIENT                         ║
 * ║   chocodataClient.js                                              ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   FREE Reddit scraper — primary provider for v3/v4/catchup.      ║
 * ║   Endpoint: GET /api/v1/reddit/subreddit (sort=hot, limit=25)    ║
 * ║   Cost: 5 credits per request (only 2xx bills — errors are free) ║
 * ║   1,000 free credits ≈ 200 requests/account ≈ ~20 days           ║
 * ║   Multi-key rotation: CHOCODATA_API_KEY, _2 ... _25              ║
 * ║   Timeouts/429 = transient (retry, NOT exhaustion);              ║
 * ║   only 401/403 mark a key exhausted (fires Slack alert).         ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import dotenv from 'dotenv';
import path from 'path';
import { sendSlack } from './slackClient.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const API_BASE = 'https://api.chocodata.com/api/v1/reddit/subreddit';
const POST_API_BASE = 'https://api.chocodata.com/api/v1/reddit/post'; // per-post detail incl. selftext body (+5 credits/call)
const POSTS_PER_SUBREDDIT = 25; // Chocodata returns up to 25 posts per request
const MAX_KEYS = 25;
const REQUEST_TIMEOUT_MS = 20000;
const RATE_LIMIT_RETRIES = 1;
const RATE_LIMIT_SLEEP_MS = 2000;
const SUB_REQUEST_GAP_MS = 250;

// ─── Key-Exhaustion Slack Alert ───────────────────────────────────────────────
// CI runs are ephemeral (in-memory counters reset each run), so alert per
// process: a key that dies mid-run fires one alert immediately. Fresh runs
// alert again until the user adds/rotates keys — that is intentional.

const alertedExhausted = new Set();

/**
 * Fire-and-forget Slack alert when a Chocodata key is marked exhausted.
 * Dedupes per process so one dead key cannot spam the channel mid-run.
 * @param {{index: number, lastError: ?string}} k
 * @param {object[]} keys
 */
export async function alertKeyExhausted(k, keys) {
  if (!k || alertedExhausted.has(k.index)) return;
  alertedExhausted.add(k.index);

  const remaining = keys.filter(x => !x.exhausted).length;
  const text = `:rotating_light: *CHOCODATA Key #${k.index} EXHAUSTED* (${k.lastError || 'auth rejected'})\n${remaining} of ${keys.length} keys still available${remaining <= 1 ? '\n:warning: Only 1 key left — add new accounts NOW or pipeline falls back to Bright Data (paid)!' : ''}`;

  try {
    await sendSlack({ text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] });
  } catch (err) {
    console.warn(`  ⚠ [CHOCODATA] Alert send failed: ${err.message}`);
  }
}

function getKeys() {
  const keys = [];
  for (let i = 1; i <= MAX_KEYS; i++) {
    const envName = i === 1 ? 'CHOCODATA_API_KEY' : `CHOCODATA_API_KEY_${i}`;
    const key = process.env[envName];
    if (key) {
      keys.push({
        index: i,
        key,
        exhausted: false,
        lastError: null,
        successes: 0,
        failures: 0,
      });
    }
  }
  return keys;
}

/**
 * Status report for Slack notifications (provider-aware label).
 * @returns {{ provider: string, total: number, available: number, keys: object[] }}
 */
export function getChocodataStatus() {
  const keys = getKeys();
  return {
    provider: 'CHOCODATA',
    total: keys.length,
    available: keys.filter(k => !k.exhausted).length,
    keys: keys.map(k => ({
      index: k.index,
      exhausted: k.exhausted,
      lastError: k.lastError,
      successes: k.successes,
      failures: k.failures,
      planId: 'FREE (1K credits)',
      monthlyCredits: 1000,
    })),
  };
}

/**
 * Cheap health check — Chocodata has no free balance endpoint, so this
 * only validates key presence/format and logs the per-request cost.
 * @returns {Promise<void>}
 */
export async function checkChocodataBalances() {
  const keys = getKeys();
  if (keys.length === 0) {
    console.warn('  ⚠ [CHOCODATA] No CHOCODATA_API_KEY set');
    return;
  }
  for (const k of keys) {
    const formatOk = /^cd_(live|test)_/.test(k.key);
    console.log(`  💰 [CHOCODATA] Key #${k.index}: ${formatOk ? 'format OK' : 'unrecognized format'} (5 credits/request, ~1K free/account)`);
  }
}

/**
 * Map Chocodata post objects into the pipeline's post format.
 * @param {object[]} items
 * @param {string} subredditFallback
 * @returns {Array<{title: string, subreddit: string, upvotes: number, comments: number, imageUrl: ?string, videoUrl: ?string, redditUrl: string, postId: ?string, selftext: string}>}
 */
export function parseChocodataPosts(items, subredditFallback) {
  const posts = [];

  for (const item of items) {
    if (!item || !item.title) continue;

    const permalink = item.permalink || '';
    const redditUrl = /^https?:\/\//.test(permalink)
      ? permalink
      : `https://www.reddit.com${permalink.startsWith('/') ? permalink : `/${permalink}`}`;

    const external = item.external_url || '';

    let imageUrl = null;
    let videoUrl = null;
    if (external) {
      if (
        /\.(png|jpe?g|gif|webp)(\?|$)/i.test(external) ||
        /i\.redd\.it/.test(external) ||
        /preview\.redd\.it/.test(external)
      ) {
        imageUrl = external;
      } else if (/\.(mp4|gifv)(\?|$)/i.test(external) || /v\.redd\.it/.test(external)) {
        videoUrl = external;
      }
    }

    posts.push({
      title: item.title,
      subreddit: item.subreddit || subredditFallback || 'unknown',
      upvotes: typeof item.score === 'number' ? item.score : 0,
      comments: typeof item.num_comments === 'number' ? item.num_comments : 0,
      imageUrl,
      videoUrl,
      redditUrl,
      postId: item.id ? String(item.id).replace(/^t3_/, '') : null,
      selftext: '',
    });
  }

  return posts;
}

/**
 * Fetch one subreddit, rotating across healthy keys.
 * Returns parsed posts, or [] when every key failed.
 * @param {string} subreddit
 * @param {object[]} keys
 * @returns {Promise<object[]>}
 */
async function fetchSubredditWithRotation(subreddit, keys) {
  let lastError = null;

  for (const k of keys) {
    if (k.exhausted) continue;

    for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
      try {
        const params = new URLSearchParams({
          api_key: k.key,
          subreddit,
          sort: 'hot',
          limit: String(POSTS_PER_SUBREDDIT),
        });

        const res = await fetch(`${API_BASE}?${params}`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        // Auth failures = dead key (preflight-equivalent)
        if (res.status === 401 || res.status === 403) {
          k.exhausted = true;
          k.lastError = `HTTP ${res.status}`;
          k.failures += 1;
          console.warn(`  ⚠ [CHOCODATA] Key #${k.index} rejected (HTTP ${res.status}) — marking exhausted`);
          await alertKeyExhausted(k, keys);
          break; // try next key
        }

        // Rate limit = transient, NOT exhaustion (AGENTS.md rule)
        if (res.status === 429) {
          k.failures += 1;
          if (attempt < RATE_LIMIT_RETRIES) {
            await new Promise(r => setTimeout(r, RATE_LIMIT_SLEEP_MS));
            continue;
          }
          lastError = 'rate-limited';
          break; // try next key
        }

        if (!res.ok) {
          k.failures += 1;
          lastError = `HTTP ${res.status}`;
          break; // 5xx etc — try next key
        }

        const data = await res.json();

        // Chocodata error envelope
        if (data && data.error) {
          k.failures += 1;
          if (['invalid_params', 'subreddit_not_found', 'not_found'].includes(data.error)) {
            console.warn(`  ⚠ [CHOCODATA] r/${subreddit}: ${data.error} — skipping sub`);
            return [];
          }
          lastError = data.error;
          break;
        }

        const rawPosts = data && Array.isArray(data.posts) ? data.posts : [];
        k.successes += 1;
        const parsed = parseChocodataPosts(rawPosts, subreddit);
        console.log(`  ✓ [CHOCODATA] r/${subreddit}: ${parsed.length} posts (key #${k.index})`);
        return parsed;
      } catch (err) {
        // Network/timeout = transient, NOT exhaustion
        k.failures += 1;
        if (attempt < RATE_LIMIT_RETRIES) {
          await new Promise(r => setTimeout(r, RATE_LIMIT_SLEEP_MS));
          continue;
        }
        lastError = err.message;
        break; // try next key
      }
    }
  }

  console.warn(`  ⚠ [CHOCODATA] r/${subreddit} failed (${lastError || 'no healthy keys left'})`);
  return [];
}

/**
 * Enrich ONE Reddit post with its selftext body via the `reddit/post` endpoint.
 * Cost: 5 credits per successful call — ONLY call for posts that will actually
 * be posted (Slim strategy: final 2 posts/run, NOT the excess/queue pool).
 * Best-effort: any failure (network, rate-limit, empty body) returns the post
 * unchanged so the pipeline falls back to existing behavior.
 * @param {object} post parsed Chocodata post (must have postId + subreddit)
 * @returns {Promise<object>} same post with `selftext` populated (or unchanged)
 */
export async function enrichPostSelftext(post) {
  if (!post || !post.postId || !post.subreddit) return post;

  const keys = getKeys();
  let lastError = null;

  for (const k of keys) {
    if (k.exhausted) continue;

    try {
      const params = new URLSearchParams({
        api_key: k.key,
        subreddit: post.subreddit,
        post_id: post.postId,
      });

      const res = await fetch(`${POST_API_BASE}?${params}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      // Auth failures = dead key (same semantics as subreddit fetch)
      if (res.status === 401 || res.status === 403) {
        k.exhausted = true;
        k.lastError = `HTTP ${res.status}`;
        k.failures += 1;
        console.warn(`  ⚠ [CHOCODATA] Key #${k.index} rejected (HTTP ${res.status}) — marking exhausted`);
        await alertKeyExhausted(k, keys);
        break; // try next key
      }

      // Rate limit = transient, NOT exhaustion — try next key
      if (res.status === 429) {
        k.failures += 1;
        lastError = 'rate-limited';
        break;
      }

      if (!res.ok) {
        k.failures += 1;
        lastError = `HTTP ${res.status}`;
        break;
      }

      const data = await res.json();
      if (data && data.error) {
        k.failures += 1;
        lastError = data.error;
        break;
      }

      k.successes += 1;
      const body = data && data.post && data.post.body;
      if (body && typeof body === 'string' && body.trim()) {
        post.selftext = body.trim().substring(0, 2500);
        console.log(`  ✓ [CHOCODATA] selftext (${post.selftext.length} chars): ${post.selftext.substring(0, 60)}...`);
      } else {
        console.log(`  ✓ [CHOCODATA] no selftext body for r/${post.subreddit} (${post.title.substring(0, 40)}...)`);
      }
      return post; // body empty on link posts — not an error
    } catch (err) {
      // Network/timeout = transient, NOT exhaustion
      k.failures += 1;
      lastError = err.message;
      break; // try next key
    }
  }

  console.warn(`  ⚠ [CHOCODATA] selftext fetch failed for r/${post.subreddit} (${lastError || 'no healthy keys left'}) — using post without selftext`);
  return post; // unchanged
}

/**
 * Fetch top posts from multiple subreddits. One request per subreddit
 * (up to POSTS_PER_SUBREDDIT posts each), rotating across keys.
 * @param {string[]} subredditNames
 * @returns {Promise<object[]>} parsed posts (empty array on total failure)
 */
export async function fetchSubredditPosts(subredditNames) {
  const keys = getKeys();
  if (keys.length === 0) {
    console.warn('  ⚠ [CHOCODATA] No CHOCODATA_API_KEY — skipping Reddit');
    return [];
  }

  const healthy = keys.filter(k => !k.exhausted);
  if (healthy.length === 0) {
    console.warn('  ⚠ [CHOCODATA] All keys exhausted — skipping Reddit');
    return [];
  }

  const posts = [];
  let failedSubs = 0;

  for (const name of subredditNames) {
    const subPosts = await fetchSubredditWithRotation(name, keys);
    if (subPosts.length === 0) failedSubs += 1;
    posts.push(...subPosts);
    await new Promise(r => setTimeout(r, SUB_REQUEST_GAP_MS));
  }

  if (failedSubs > 0) {
    console.warn(`  ⚠ [CHOCODATA] ${failedSubs}/${subredditNames.length} subreddits returned nothing`);
  }

  return posts;
}
