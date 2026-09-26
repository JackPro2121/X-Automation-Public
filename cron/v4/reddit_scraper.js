/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   X-AUTOMATION v4 — REDDIT AI NEWS SCRAPER                      ║
 * ║   reddit_scraper.js                                              ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Fetches AI news from Reddit subreddits via Apify              ║
 * ║   Extracts images and videos attached to posts                   ║
 * ║   Returns structured data for X posting                          ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { isDuplicate, shuffleArray, validateEnv } from '../lib/utils.js';
import { fetchSubredditPosts as fetchBrightDataPosts } from '../lib/brightdataClient.js';
import { fetchSubredditPosts as fetchChocodataPosts, getChocodataStatus, checkChocodataBalances } from '../lib/chocodataClient.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

validateEnv(['VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// Export for Slack key status reporting (Chocodata provider)
export function getApifyKeyStatus() { return getChocodataStatus(); }
export async function checkApifyBalances() { await checkChocodataBalances(); }

// ─── Reddit Subreddits (v4) ──────────────────────────────────────────────────
// Split into TWO categories to guarantee free tools content daily:
// - AI_NEWS: AI-specific subreddits (high upvotes, model releases)
// - FREE_TOOLS: Open source, self-hosted, free tools (viral on X)
// Each run picks 1 FREE_TOOLS + 2 AI_NEWS = minimum 9 free tools posts/day

// ─── v4 SUBREDDITS — NO OVERLAP with v3 ─────────────────────────────────────
// v3 focuses on: LocalLLaMA, ChatGPT, singularity, artificial, futurology, technology, deeplearning
//                + selfhosted, opensource, InternetIsBeautiful, homelab, commandline, linux
// v4 focuses on: OpenAI, Anthropic, Stable Diffusion, ML, Bard, Midjourney, ChatGPTCoding
//                + github, SideProject, webdev, devops, programming

// ─── v4 FREE TOOLS SUBREDDITS — Verified by live Apify scrape (Jul 2026) ─────
// All subs verified: active, image posts available
// Categories: Free tools, AI models, API keys, open source, software, cloud, engineering
// v4 picks 3 per run (1 guaranteed free tools + 2 random)

const FREE_TOOLS_SUBS = [
  // Free Tools & Open Source
  { name: 'webdev', label: 'Web Dev Tools' },                         // Top: 1599⬆ Avg: 182⬆ Images: 20%
  { name: 'selfhosted', label: 'Free Self-Hosted Tools' },             // Top: 899⬆  Avg: 110⬆ Images: 13%
  { name: 'homelab', label: 'Home Server Setups' },                    // Top: 958⬆  Avg: 192⬆ Images: 42%
  { name: 'linux', label: 'Linux Tools & Software' },                  // Top: 7723⬆ Avg: 471⬆ Images: 13%
  { name: 'commandline', label: 'CLI Tools & Scripts' },               // Top: 343⬆  Avg: 32⬆  Images: 17%
  { name: 'coolgithubprojects', label: 'Cool GitHub Projects' },       // Top: 170⬆  Avg: 13⬆  Images: 42%
  { name: 'software', label: 'Free Software & Utilities' },            // Top: 97⬆   Avg: 9⬆   Images: 22%
  // AI Models, API Keys & Data Tech
  { name: 'LocalLLaMA', label: 'Local LLMs' },                        // Top: 1807⬆ Avg: 366⬆ Images: 27%
  { name: 'dataisbeautiful', label: 'Data & Tech Visualizations' },    // Top: 11644⬆ Avg: 1073⬆ Images: 71%
  // Software & Engineering
  { name: 'devops', label: 'DevOps Tools' },                           // Top: 120⬆  Avg: 28⬆  Images: 0%
];

// ─── Reddit Scraper: Chocodata (FREE) → Bright Data (PAYG fallback) ──────────
// Chocodata is the free primary provider (5 credits/request, 25 posts/sub).
// Bright Data remains as fallback for when Chocodata returns nothing.

// ─── Score Post Quality ───────────────────────────────────────────────────────

function scorePost(post) {
  // Minimum quality filters
  if (!post.title || post.title.length < 20) return -1; // Minimum 20 chars
  if (!post.imageUrl) return -1; // Image REQUIRED
  if (post.upvotes < 0) return -1; // Allow all posts including 0 upvotes

  let score = 0;

  // Upvotes are the PRIMARY signal (most weight)
  score += Math.min(post.upvotes / 10, 100); // Up to 100 points for upvotes

  // Comments indicate engagement
  score += Math.min(post.comments / 5, 30);  // Up to 30 points for comments

  // Short titles are punchier for X
  const titleLen = post.title?.length || 0;
  if (titleLen <= 80) score += 15;
  else if (titleLen <= 120) score += 10;

  // Skip video posts (harder to repost)
  if (post.videoUrl && !post.imageUrl) return -1;

  return Math.round(score);
}

// ─── Dedup Check (delegated to shared utils) ──────────────────────────────────
// H3/M3 fix: isDuplicate is null-safe and fail-safe (returns true on error)
// DEDUP_WINDOW_HOURS extended to 72h in constants.js

// ─── Main: Fetch Top Reddit AI Posts ──────────────────────────────────────────

export async function fetchRedditAINews(maxPosts = 5) {
  console.log('\n▶ REDDIT AI NEWS SCRAPER (Chocodata → Bright Data fallback)');

  if (!process.env.CHOCODATA_API_KEY && !process.env.BRIGHTDATA_API_KEY) {
    console.warn('  ⚠ No CHOCODATA/BrightData key — skipping Reddit');
    return [];
  }

  const allPosts = [];

  // GUARANTEED: Up to 3 candidate subs per run, scraped lazily to save credits
  const selected = shuffleArray(FREE_TOOLS_SUBS, 3);
  console.log(`  🎯 Priority subs: ${selected.map(s => 'r/' + s.name).join(', ')}`);

  let scannedCount = 0;
  for (const sub of selected) {
    scannedCount++;
    console.log(`  → Scanning r/${sub.name}...`);

    let posts = await fetchChocodataPosts([sub.name]);
    if (posts.length === 0 && process.env.BRIGHTDATA_API_KEY) {
      console.warn(`  ⚠ Chocodata r/${sub.name} returned nothing — checking Bright Data`);
      posts = await fetchBrightDataPosts([sub.name]);
    }

    for (const post of posts) {
      const postScore = scorePost(post);
      if (postScore < 1) continue; // Skip invalid posts (video-only, empty title)
      if (post.redditUrl && await isDuplicate(supabase, post.redditUrl)) continue;

      allPosts.push({
        ...post,
        score: postScore
      });
    }

    // Early stop: If we already have enough quality non-duplicate posts (maxPosts, e.g. 4-5 for post + queue), stop!
    if (allPosts.length >= maxPosts) {
      console.log(`  💡 Credit Saver: Found ${allPosts.length} qualifying posts — skipping remaining ${selected.length - scannedCount} subreddits.`);
      break;
    }
  }

  // Sort and return top posts
  allPosts.sort((a, b) => b.score - a.score);
  const topPosts = allPosts.slice(0, maxPosts);

  console.log(`\n  ✓ Selected ${topPosts.length} qualifying posts from ${scannedCount} scanned subreddits`);
  topPosts.forEach((p, i) => {
    console.log(`  ${i + 1}. [${p.subreddit}] ${p.title.substring(0, 60)}...`);
    console.log(`     Score: ${p.score} | ⬆ ${p.upvotes} | 💬 ${p.comments} | ${p.videoUrl ? '🎬 Video' : p.imageUrl ? '🖼️ Image' : '📝 Text'}`);
  });

  return topPosts;
}

// ─── Generate X Post from Reddit Content ──────────────────────────────────────

export function generateXPost(redditPost) {
  let title = redditPost.title
    .replace(/\[.*?\]/g, '')
    .replace(/^[A-Z\s]+:/, '')
    .trim();

  if (title.length > 240) {
    title = title.substring(0, 237) + '...';
  }

  // Fix URL - ensure it's a valid Reddit URL
  let sourceUrl = redditPost.redditUrl;
  if (sourceUrl && !sourceUrl.startsWith('http')) {
    sourceUrl = `https://reddit.com${sourceUrl}`;
  }

  return {
    text: title,
    imageUrl: redditPost.imageUrl,
    videoUrl: redditPost.videoUrl,
    isVideo: !!redditPost.videoUrl,
    sourceUrl: sourceUrl || `https://reddit.com/r/${redditPost.subreddit}`,
    sourceType: 'reddit',
    subreddit: redditPost.subreddit,
    upvotes: redditPost.upvotes,
    comments: redditPost.comments
  };
}

// ─── CLI Runner ───────────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].includes('reddit_scraper.js')) {
  console.log('Testing Reddit scraper...\n');
  fetchRedditAINews(5).then(posts => {
    console.log('\n--- Generated X Posts ---');
    posts.forEach((p, i) => {
      const xPost = generateXPost(p);
      console.log(`\n${i + 1}. ${xPost.text}`);
      console.log(`   Image: ${xPost.imageUrl || 'None'}`);
      console.log(`   Video: ${xPost.videoUrl || 'None'}`);
      console.log(`   Source: ${xPost.sourceUrl}`);
    });
  });
}
