/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║   v7 OUTBOUND COMMENT LISTENER                               ║
 * ║   cron/v7/outbound_listener.js                               ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║   1. Selects verified top AI creators from curated list      ║
 * ║   2. Enforces 24-hour creator cooldown (max 1/creator/day)   ║
 * ║   3. Finds high-engagement posts to reply to for viral reach  ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

import { fetchXPosts } from '../lib/xscraper.js';

/**
 * Find high-value candidate posts from top creators for Outbound commenting.
 *
 * @param {object} apifyKeys - Apify key manager
 * @param {object} supabase - Supabase client
 * @param {number} targetCount - How many candidate posts to return (e.g. 2-5)
 * @returns {Promise<Array>} List of candidate posts
 */
export async function findOutboundCandidates(apifyKeys, supabase, targetCount = 3) {
  console.log(`\n▶ [v7 Outbound Listener] Finding top creator posts (target: ${targetCount})...`);

  // 1. Fetch creators replied to in the last 24 hours to enforce 24h per-creator cooldown
  const recentAuthors = new Set();
  const repliedPostIds = new Set();

  if (supabase) {
    try {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data } = await supabase
        .from('comment_replies')
        .select('target_author, comment_id')
        .gte('created_at', oneDayAgo);

      if (data && data.length > 0) {
        for (const row of data) {
          if (row.target_author) recentAuthors.add(row.target_author.toLowerCase());
          if (row.comment_id) repliedPostIds.add(row.comment_id);
        }
        console.log(`  Found ${recentAuthors.size} creators on 24h cooldown:`, Array.from(recentAuthors).slice(0, 5).join(', '));
      }
    } catch (err) {
      console.warn(`  ⚠ Could not fetch cooldown creators from Supabase: ${err.message}`);
    }
  }

  // 2. Scrape recent posts from curated creators (scraping 2-3 accounts per run to conserve Apify credits)
  // fetchXPosts already handles account picking and media/text extraction
  let posts = [];
  try {
    // maxPosts = 4, maxAccounts = 3
    posts = await fetchXPosts(apifyKeys, undefined, 6, 3);
  } catch (err) {
    console.warn(`  ⚠ Failed to fetch outbound posts: ${err.message}`);
    return [];
  }

  if (!posts || posts.length === 0) {
    console.log('  No posts retrieved from curated accounts.');
    return [];
  }

  // 3. Filter candidates:
  // - Author not on 24h cooldown
  // - Tweet not already replied to
  // - Minimum text length (> 30 chars)
  // - Engagement threshold (> 30 likes)
  const candidates = [];
  for (const post of posts) {
    const authorLower = (post.author || '').toLowerCase();
    const tweetId = post.tweetId || (post.tweetUrl?.match(/status\/(\d+)/)?.[1]);

    if (!tweetId) continue;
    if (recentAuthors.has(authorLower)) {
      console.log(`  ⏭ Skipping @${post.author} (already engaged within last 24 hours)`);
      continue;
    }
    if (repliedPostIds.has(tweetId)) {
      console.log(`  ⏭ Skipping tweet ${tweetId} (already replied to)`);
      continue;
    }
    if (!post.title || post.title.trim().length < 30) continue;

    candidates.push({
      tweetId,
      author: post.author,
      text: post.title,
      likes: post.likes || 0,
      retweets: post.retweets || 0,
      replies: post.replies || 0,
      tweetUrl: post.tweetUrl,
      isVerified: true
    });

    // Enforce 1 post per author within this candidate batch
    recentAuthors.add(authorLower);

    if (candidates.length >= targetCount) break;
  }

  console.log(`  ✓ Selected ${candidates.length} high-signal outbound candidates.`);
  return candidates;
}
