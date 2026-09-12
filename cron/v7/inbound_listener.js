/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║   v7 INBOUND COMMENT LISTENER                                ║
 * ║   cron/v7/inbound_listener.js                                ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║   1. Checks last 4 posts of @M_jawad_yasin                   ║
 * ║   2. If reply_count === 0 on all posts -> $0 cost, early exit║
 * ║   3. If replies exist -> fetch comments, dedup, prioritize   ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const APIFY_MEDIA_SCRAPER = 'maximedupre~twitter-media-scraper';
const APIFY_TWEET_SCRAPER = 'apidojo~tweet-scraper';
const TARGET_USER = 'M_jawad_yasin';

/**
 * Fetch last 4 posts of @M_jawad_yasin to check reply counts
 */
export async function checkInboundComments(apifyKeys, supabase) {
  console.log(`\n▶ [v7 Inbound Listener] Checking last 4 posts of @${TARGET_USER}...`);

  if (!apifyKeys || apifyKeys.totalKeys === 0) {
    console.warn('  ⚠ No Apify keys available for inbound check');
    return { hasComments: false, candidates: [] };
  }

  let posts = [];
  try {
    posts = await apifyKeys.execute(async (apiKey) => {
      const runRes = await fetch(`https://api.apify.com/v2/acts/${APIFY_MEDIA_SCRAPER}/runs?token=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'profiles',
          profiles: [TARGET_USER],
          mediaTypes: ['image', 'video', 'gif'],
          maxItems: 4
        }),
        signal: AbortSignal.timeout(30000)
      });

      if (!runRes.ok) throw new Error(`Apify HTTP ${runRes.status}`);
      const runData = await runRes.json();
      const runId = runData.data?.id;
      if (!runId) throw new Error('No run ID returned');

      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const sRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${apiKey}`, {
          signal: AbortSignal.timeout(10000)
        });
        const sData = await sRes.json();
        if (sData.data?.status === 'SUCCEEDED') {
          const dId = sData.data?.defaultDatasetId;
          if (dId) {
            const iRes = await fetch(`https://api.apify.com/v2/datasets/${dId}/items?token=${apiKey}&format=json&limit=4`, {
              signal: AbortSignal.timeout(15000)
            });
            return await iRes.json();
          }
        }
        if (sData.data?.status === 'FAILED') throw new Error('Actor run failed');
      }
      throw new Error('Timeout waiting for scraper');
    });
  } catch (err) {
    console.warn(`  ⚠ Failed to check @${TARGET_USER} posts: ${err.message}`);
    return { hasComments: false, candidates: [] };
  }

  if (!posts || posts.length === 0) {
    console.log(`  ✓ No posts found for @${TARGET_USER} or no media posts.`);
    return { hasComments: false, candidates: [] };
  }

  // Deduplicate items by tweetId
  const uniqueTweets = new Map();
  for (const item of posts) {
    const tweetId = item.tweetId || item.tweetUrl;
    if (tweetId && !uniqueTweets.has(tweetId)) {
      uniqueTweets.set(tweetId, {
        tweetId: item.tweetId,
        text: item.text || '',
        replies: item.engagement?.replies || 0,
        likes: item.engagement?.likes || 0,
        url: item.tweetUrl
      });
    }
  }

  const tweetList = Array.from(uniqueTweets.values()).slice(0, 4);
  console.log(`  Inspecting ${tweetList.length} recent posts:`);
  let totalReplies = 0;
  for (const p of tweetList) {
    console.log(`  • ID: ${p.tweetId || 'unknown'} | Replies: ${p.replies} | Likes: ${p.likes}`);
    totalReplies += (p.replies || 0);
  }

  // Cost-saving condition: If zero replies across all 4 posts, zero extra calls!
  if (totalReplies === 0) {
    console.log(`  💡 Smart Cost Saver: All last ${tweetList.length} posts have 0 comments ($0 Apify cost). Exiting inbound.`);
    return { hasComments: false, candidates: [] };
  }

  console.log(`  🔥 Found ${totalReplies} potential replies! Fetching comments via Apify search...`);

  // Fetch comments to @M_jawad_yasin
  let rawComments = [];
  try {
    rawComments = await apifyKeys.execute(async (apiKey) => {
      const runRes = await fetch(`https://api.apify.com/v2/acts/${APIFY_TWEET_SCRAPER}/runs?token=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchTerms: [`to:${TARGET_USER}`],
          sort: 'Latest',
          maxItems: 10
        }),
        signal: AbortSignal.timeout(30000)
      });

      if (!runRes.ok) throw new Error(`Apify tweet-scraper HTTP ${runRes.status}`);
      const runData = await runRes.json();
      const runId = runData.data?.id;
      if (!runId) throw new Error('No run ID returned');

      for (let i = 0; i < 35; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const sRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${apiKey}`, {
          signal: AbortSignal.timeout(10000)
        });
        const sData = await sRes.json();
        if (sData.data?.status === 'SUCCEEDED') {
          const dId = sData.data?.defaultDatasetId;
          if (dId) {
            const iRes = await fetch(`https://api.apify.com/v2/datasets/${dId}/items?token=${apiKey}&format=json&limit=10`, {
              signal: AbortSignal.timeout(15000)
            });
            return await iRes.json();
          }
        }
        if (sData.data?.status === 'FAILED') throw new Error('Comment fetch failed');
      }
      throw new Error('Timeout waiting for comment scraper');
    });
  } catch (err) {
    console.warn(`  ⚠ Could not fetch comments: ${err.message}`);
    return { hasComments: false, candidates: [] };
  }

  // Get already replied comments from Supabase
  let existingRepliedIds = new Set();
  if (supabase) {
    try {
      const { data } = await supabase
        .from('comment_replies')
        .select('comment_id')
        .limit(200);
      if (data) {
        existingRepliedIds = new Set(data.map(d => d.comment_id));
      }
    } catch (e) {
      // Ignore if table not yet created
    }
  }

  const candidates = [];
  for (const c of (rawComments || [])) {
    const author = (c.author?.userName || c.authorUsername || '').replace('@', '');
    const commentId = c.id || c.tweetId;
    const commentText = c.text || c.full_text || '';

    // Filter out own comments, already replied comments, or short spam
    if (!commentId || !author || author.toLowerCase() === TARGET_USER.toLowerCase()) continue;
    if (existingRepliedIds.has(commentId)) continue;
    if (commentText.length < 5) continue;

    const isVerified = !!(c.author?.isBlueVerified || c.author?.verified || c.isVerified);
    candidates.push({
      commentId,
      parentTweetId: c.inReplyToStatusId || c.conversationId,
      author,
      text: commentText,
      isVerified,
      createdAt: c.createdAt || new Date().toISOString()
    });
  }

  // Prioritize verified accounts first
  candidates.sort((a, b) => (b.isVerified ? 1 : 0) - (a.isVerified ? 1 : 0));
  console.log(`  ✓ Found ${candidates.length} new eligible inbound comments to reply to.`);

  return {
    hasComments: candidates.length > 0,
    candidates
  };
}
