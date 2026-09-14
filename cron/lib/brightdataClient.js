/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   X-AUTOMATION — BRIGHT DATA REDDIT CLIENT                       ║
 * ║   brightdataClient.js                                             ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Replaces Apify for Reddit scraping (v3 + v4 pipelines).        ║
 * ║   Uses the Web Scraper API "Discover posts by subreddit URL"     ║
 * ║   dataset (gd_lvz8ah06191smkebj4) with num_of_posts limit to     ║
 * ║   keep cost at exactly 5 posts per subreddit (matches old        ║
 * ║   Apify limit:5, cost-optimized).                                ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const API_BASE = 'https://api.brightdata.com';
const REDDIT_DATASET_ID = 'gd_lvz8ah06191smkebj4';
const POSTS_PER_SUBREDDIT = 5;
const MAX_WAIT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 15000;

function getApiKey() {
  return process.env.BRIGHTDATA_API_KEY;
}

/**
 * Status report for Slack notifications (provider-aware label).
 * @returns {{ provider: string, total: number, available: number, keys: object[] }}
 */
export function getBrightDataStatus() {
  const key = getApiKey();
  return {
    provider: 'BRIGHTDATA',
    total: key ? 1 : 0,
    available: key ? 1 : 0,
    keys: [{
      index: 1,
      exhausted: false,
      lastError: null,
      successes: 0,
      failures: 0,
      planId: 'PAYG',
      monthlyCredits: null,
    }],
  };
}

/**
 * Cheap health check — validates the API key via the FREE dataset
 * metadata endpoint (no scraping, no credits consumed).
 * @returns {Promise<void>}
 */
export async function checkBrightDataBalances() {
  const key = getApiKey();
  if (!key) {
    console.warn('  ⚠ [BRIGHTDATA] No BRIGHTDATA_API_KEY set');
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/datasets/${REDDIT_DATASET_ID}/metadata`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      console.log('  💰 [BRIGHTDATA] Key OK (PAYG, $1.5/1K records)');
    } else {
      console.log(`  🔴 [BRIGHTDATA] Key check failed (${res.status})`);
    }
  } catch (err) {
    console.warn(`  ⚠ [BRIGHTDATA] Check failed: ${err.message}`);
  }
}

/**
 * Trigger an async Reddit discovery for MULTIPLE subreddits in ONE
 * request (single snapshot, single poll/download). Each subreddit is
 * limited to POSTS_PER_SUBREDDIT records to control cost.
 * @param {string[]} subredditNames
 * @returns {Promise<string>} snapshot_id
 */
async function triggerRedditDiscovery(subredditNames) {
  const key = getApiKey();
  if (!key) throw new Error('BRIGHTDATA_API_KEY not set');

  const input = subredditNames.map(name => ({
    url: `https://www.reddit.com/r/${name}/`,
    num_of_posts: POSTS_PER_SUBREDDIT,
  }));

  const url = `${API_BASE}/datasets/v3/trigger?dataset_id=${REDDIT_DATASET_ID}` +
    `&type=discover_new&discover_by=subreddit_url&include_errors=true`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const body = (await res.text()).substring(0, 200);
    throw new Error(`BrightData trigger HTTP ${res.status}: ${body}`);
  }
  const data = await res.json();
  if (!data.snapshot_id) throw new Error('BrightData trigger: no snapshot_id returned');
  return data.snapshot_id;
}

/**
 * Poll the snapshot progress endpoint until ready or failed.
 * Progress polls are FREE (no credits consumed).
 * @param {string} snapshotId
 * @returns {Promise<void>}
 */
async function waitForSnapshot(snapshotId) {
  const key = getApiKey();
  const start = Date.now();

  while (Date.now() - start < MAX_WAIT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const res = await fetch(`${API_BASE}/datasets/v3/progress/${snapshotId}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) continue;

    const data = await res.json();
    if (data.status === 'ready') return;
    if (data.status === 'failed') {
      throw new Error(`BrightData snapshot failed: ${JSON.stringify(data).substring(0, 200)}`);
    }
  }

  throw new Error('BrightData snapshot timed out');
}

/**
 * Download the completed snapshot as JSON.
 * @param {string} snapshotId
 * @returns {Promise<object[]>}
 */
async function downloadSnapshot(snapshotId) {
  const key = getApiKey();
  const res = await fetch(`${API_BASE}/datasets/v3/snapshot/${snapshotId}?format=json`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`BrightData download HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Map Bright Data post objects into the pipeline's post format.
 * @param {object[]} items
 * @returns {Array<{title: string, subreddit: string, upvotes: number, comments: number, imageUrl: ?string, videoUrl: ?string, redditUrl: string, selftext: string}>}
 */
export function parseBrightDataPosts(items) {
  const posts = [];

  for (const item of items) {
    if (!item || item.error) continue;
    if (!item.title || !item.url) continue;

    posts.push({
      title: item.title,
      subreddit: item.community_name || 'unknown',
      upvotes: item.num_upvotes || 0,
      comments: item.num_comments || 0,
      imageUrl: (item.photos && item.photos.length) ? item.photos[0] : null,
      videoUrl: (item.videos && item.videos.length) ? item.videos[0] : null,
      redditUrl: item.url,
      selftext: item.description || '',
    });
  }

  return posts;
}

/**
 * Fetch top posts from multiple subreddits in ONE trigger.
 * @param {string[]} subredditNames
 * @returns {Promise<object[]>} parsed posts (empty array on failure)
 */
export async function fetchSubredditPosts(subredditNames) {
  if (!getApiKey()) {
    console.warn('  ⚠ No BRIGHTDATA_API_KEY — skipping Reddit');
    return [];
  }

  try {
    const snapshotId = await triggerRedditDiscovery(subredditNames);
    console.log(`  📦 BrightData snapshot: ${snapshotId} (${subredditNames.join(', ')})`);
    await waitForSnapshot(snapshotId);
    const data = await downloadSnapshot(snapshotId);
    return parseBrightDataPosts(data);
  } catch (err) {
    console.warn(`  ⚠ BrightData failed: ${err.message}`);
    return [];
  }
}