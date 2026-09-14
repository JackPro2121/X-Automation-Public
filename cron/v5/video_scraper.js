/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   X-AUTOMATION v5 — VIDEO SCRAPER                               ║
 * ║   video_scraper.js                                               ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Fetches AI-related video posts from Reddit via Apify           ║
 * ║   Extracts video URLs (v.redd.it, imgur, etc.)                   ║
 * ║   Returns structured data for video posting on X                 ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { isDuplicate, shuffleArray, validateEnv } from '../lib/utils.js';
import { createKeyManager } from '../lib/keyManager.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

validateEnv(['VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// ─── Multi-Key Apify Manager ─────────────────────────────────────────────────
const apifyKeys = createKeyManager('APIFY', [
  process.env.APIFY_API_KEY,
  process.env.APIFY_API_KEY_2,
  process.env.APIFY_API_KEY_3,
  process.env.APIFY_API_KEY_4,
  process.env.APIFY_API_KEY_5,
  process.env.APIFY_API_KEY_6,
  process.env.APIFY_API_KEY_7,
  process.env.APIFY_API_KEY_8,
  process.env.APIFY_API_KEY_9,
  process.env.APIFY_API_KEY_10,
  process.env.APIFY_API_KEY_11,
  process.env.APIFY_API_KEY_12,
  process.env.APIFY_API_KEY_13,
  process.env.APIFY_API_KEY_14,
  process.env.APIFY_API_KEY_15,
  process.env.APIFY_API_KEY_16,
  process.env.APIFY_API_KEY_17,
]);

// Export for Slack key status reporting
export function getApifyKeyStatus() { return apifyKeys.getStatus(); }
export async function checkApifyBalances() { await apifyKeys.checkBalances(); }

// ─── Video Subreddits (v5) ───────────────────────────────────────────────────
// Focused on AI/tech content with video posts
// High engagement, video-heavy communities

// ─── Video Subreddits (v5) ───────────────────────────────────────────────────
// Focused on AI/tech content with video and GIF posts
// Verified by live Apify scrape

// ─── Video Subreddits (v5) ───────────────────────────────────────────────────
// ALL subreddits from v3 + v4 + v5 — but only VIDEO/GIF posts are picked
// v5's main focus: Video and GIF content for X posting
// Picks 3 random subreddits per run

const VIDEO_SUBREDDITS = [
  // v3 AI News subs (also scrape for video/GIF content)
  { name: 'ClaudeAI', label: 'Anthropic Claude' },
  { name: 'singularity', label: 'AI Future' },
  { name: 'LocalLLaMA', label: 'Local LLMs' },
  { name: 'ChatGPT', label: 'ChatGPT' },
  { name: 'midjourney', label: 'AI Art' },
  // v4 Free Tools subs (also scrape for video/GIF content)
  { name: 'webdev', label: 'Web Dev' },
  { name: 'selfhosted', label: 'Self-Hosted' },
  { name: 'homelab', label: 'Home Lab' },
  { name: 'linux', label: 'Linux' },
  { name: 'coolgithubprojects', label: 'GitHub Projects' },
  // v5 Video-focused subs
  { name: 'StableDiffusion', label: 'AI Art Demos' },
  { name: 'robotics', label: 'Robotics' },
  { name: 'tech', label: 'Technology' },
];

// ─── Apify Reddit Scraper ─────────────────────────────────────────────────────

const REDDIT_ACTOR = 'automation-lab~reddit-scraper';

/**
 * Fetch posts from a single subreddit via Apify
 */
async function fetchSubredditVideoPosts(subredditName) {
  if (apifyKeys.totalKeys === 0) {
    console.warn(`  ⚠ No Apify keys — skipping r/${subredditName}`);
    return [];
  }

  try {
    const items = await apifyKeys.execute(async (apiKey) => {
      const runRes = await fetch(`https://api.apify.com/v2/acts/${REDDIT_ACTOR}/runs?token=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subreddits: [subredditName], sort: 'hot', limit: 10 }),
        signal: AbortSignal.timeout(30000)
      });

      if (!runRes.ok) throw new Error(`Apify run HTTP ${runRes.status}`);

      const runData = await runRes.json();
      const runId = runData.data?.id;
      if (!runId) throw new Error('No run ID returned');

      return await waitForRun(runId, apiKey);
    });

    return items || [];
  } catch (err) {
    console.warn(`  ⚠ Apify failed for r/${subredditName}: ${err.message}`);
    return [];
  }
}

/**
 * Wait for Apify run to complete
 */
async function waitForRun(runId, apiKey, maxWait = 90000) {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    try {
      const statusRes = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}?token=${apiKey}`,
        { signal: AbortSignal.timeout(10000) }
      );

      if (!statusRes.ok) break;

      const statusData = await statusRes.json();
      const status = statusData.data?.status;

      if (status === 'SUCCEEDED') {
        const datasetId = statusData.data?.defaultDatasetId;
        if (datasetId) {
          return await fetchDatasetItems(datasetId, apiKey);
        }
      }

      if (status === 'FAILED' || status === 'ABORTED') break;

      await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      break;
    }
  }

  return [];
}

/**
 * Fetch items from Apify dataset
 */
async function fetchDatasetItems(datasetId, apiKey) {
  try {
    const res = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apiKey}&format=json&limit=10`,
      { signal: AbortSignal.timeout(15000) }
    );

    if (!res.ok) return [];

    const items = await res.json();
    return parseVideoResults(items);
  } catch (err) {
    return [];
  }
}

/**
 * Parse results for video and GIF content
 */
function parseVideoResults(items) {
  const posts = [];

  for (const item of items) {
    if (!item.title || item.type !== 'post') continue;

    let videoUrl = null;
    let imageUrl = null;
    let isVideo = false;
    let isGif = false;

    // Check for Reddit video (v.redd.it)
    if (item.media && item.media.reddit_video) {
      videoUrl = item.media.reddit_video.fallback_url || item.media.reddit_video.dash_url;
      isVideo = true;
    }

    // Check for external video links
    if (!videoUrl && item.url) {
      const url = item.url.toLowerCase();
      if (url.includes('youtube.com') || url.includes('youtu.be') || 
          url.includes('vimeo.com') || url.includes('streamable.com') ||
          url.includes('v.redd.it')) {
        videoUrl = item.url;
        isVideo = true;
      }
    }

    // Check imageUrls for GIF content (Reddit GIFs are common!)
    if (!videoUrl && item.imageUrls && item.imageUrls.length > 0) {
      const imgUrl = item.imageUrls[0].toLowerCase();
      if (imgUrl.endsWith('.gif') || imgUrl.match(/\.gif[#?]/i) || imgUrl.includes('/gif') || imgUrl.includes('animated_gif')) {
        imageUrl = item.imageUrls[0];
        isGif = true;
        isVideo = true; // Treat GIFs as video content for X
      } else {
        imageUrl = item.imageUrls[0];
      }
    }

    // Check link field for video/GIF
    if (!videoUrl && item.link) {
      const link = item.link.toLowerCase();
      if (link.includes('v.redd.it') || link.includes('youtube.com') || 
          link.includes('youtu.be') || link.endsWith('.mp4') || 
          link.endsWith('.webm') || link.endsWith('.gif') ||
          link.includes('gfycat.com') || link.includes('imgur.com/a/')) {
        videoUrl = item.link;
        isVideo = true;
      }
    }

    // Check thumbnail for GIF indicators
    if (!imageUrl && !videoUrl && item.thumbnail) {
      const thumb = item.thumbnail.toLowerCase();
      if (thumb.includes('gif') || thumb.includes('nsfw') || thumb.includes('spoiler')) {
        // Skip NSFW/spoiler thumbnails
        continue;
      }
    }

    // Build Reddit URL
    let redditUrl = item.permalink || item.url;
    if (redditUrl && !redditUrl.startsWith('http')) {
      redditUrl = `https://reddit.com${redditUrl}`;
    }

    // Only include if we have video or GIF content
    if (isVideo && (videoUrl || imageUrl)) {
      posts.push({
        title: item.title,
        subreddit: item.subreddit || 'unknown',
        upvotes: item.score || 0,
        comments: item.numComments || 0,
        videoUrl,
        imageUrl,
        isVideo: true,
        isGif,
        redditUrl,
        externalUrl: item.link || item.url || null
      });
    }
  }

  return posts;
}

// ─── Score Video Post ─────────────────────────────────────────────────────────

function scoreVideoPost(post) {
  if (!post.title || post.title.length < 15) return -1;
  if (!post.videoUrl && !post.imageUrl) return -1;

  let score = 0;
  score += Math.min(post.upvotes / 10, 100);
  score += Math.min(post.comments / 5, 30);
  if (post.videoUrl) score += 20;

  const titleLen = post.title?.length || 0;
  if (titleLen <= 80) score += 15;
  else if (titleLen <= 120) score += 10;

  return Math.round(score);
}

// ─── Main: Fetch Top Video Posts ──────────────────────────────────────────────

export async function fetchVideoPosts(maxPosts = 3) {
  console.log('\n▶ VIDEO SCRAPER (v5 via Apify)');

  if (apifyKeys.totalKeys === 0) {
    console.warn('  ⚠ No Apify keys — skipping');
    return [];
  }

  const allPosts = [];
  const selected = shuffleArray(VIDEO_SUBREDDITS, 3);

  for (const sub of selected) {
    console.log(`  → Scanning r/${sub.name} (video)...`);

    const posts = await fetchSubredditVideoPosts(sub.name);

    for (const post of posts) {
      const postScore = scoreVideoPost(post);
      if (postScore < 1) continue;
      if (post.redditUrl && await isDuplicate(supabase, post.redditUrl)) continue;

      allPosts.push({ ...post, score: postScore });
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  allPosts.sort((a, b) => b.score - a.score);
  const topPosts = allPosts.slice(0, maxPosts);

  console.log(`\n  ✓ Found ${topPosts.length} video posts from ${selected.length} subreddits`);
  topPosts.forEach((p, i) => {
    console.log(`  ${i + 1}. [${p.subreddit}] ${p.title.substring(0, 60)}...`);
    console.log(`     Score: ${p.score} | ⬆ ${p.upvotes} | 💬 ${p.comments} | 🎬 ${p.videoUrl ? 'Video' : 'GIF'}`);
  });

  return topPosts;
}

// ─── Generate Video Post ──────────────────────────────────────────────────────

export function generateVideoPost(redditPost) {
  let title = redditPost.title
    .replace(/\[.*?\]/g, '')
    .replace(/^[A-Z\s]+:/, '')
    .trim();

  if (title.length > 240) title = title.substring(0, 237) + '...';

  let sourceUrl = redditPost.redditUrl;
  if (sourceUrl && !sourceUrl.startsWith('http')) {
    sourceUrl = `https://reddit.com${sourceUrl}`;
  }

  return {
    text: title,
    videoUrl: redditPost.videoUrl,
    imageUrl: redditPost.imageUrl,
    isVideo: true,
    sourceUrl: sourceUrl || `https://reddit.com/r/${redditPost.subreddit}`,
    sourceType: 'reddit',
    subreddit: redditPost.subreddit,
    upvotes: redditPost.upvotes,
    comments: redditPost.comments
  };
}
