/**
 * Hacker News API client for X-Automation pipelines.
 * FREE — no API key, no rate limit.
 * Fetches top AI/tech stories from last 48 hours when Reddit has no content.
 * Fetches full article content for AI summarization.
 */

import { enrichPostWithArticle } from './articleFetcher.js';

const HN_API = 'https://hacker-news.firebaseio.com/v0';
const HOURS_48 = 48 * 60 * 60 * 1000; // 48 hours in milliseconds

// AI/tech keywords for filtering
const AI_KEYWORDS = [
  'ai', 'artificial intelligence', 'machine learning', 'ml', 'llm', 'gpt',
  'claude', 'gemini', 'openai', 'anthropic', 'deepmind', 'meta ai',
  'neural', 'transformer', 'diffusion', 'stable diffusion', 'midjourney',
  'chatgpt', 'copilot', 'cursor', 'github copilot', 'llama', 'mistral',
  'grok', 'xai', 'hugging face', 'nvidia', 'gpu', 'tpu', 'training',
  'inference', 'fine-tuning', 'rag', 'agent', 'autonomous', 'robotics',
  'automation', 'open source', 'free tool', 'api', 'developer', 'coding',
  'programming', 'software', 'tech', 'startup', 'launch', 'release',
  'model', 'benchmark', 'open-source', 'github', 'terminal', 'cli',
  'linux', 'docker', 'kubernetes', 'cloud', 'aws', 'google', 'microsoft',
  'apple', 'meta', 'startup', 'yc', 'ycombinator'
];

/**
 * Fetch top story IDs from Hacker News
 */
async function fetchTopStoryIds(limit = 100) {
  try {
    const res = await fetch(`${HN_API}/topstories.json`, {
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ids = await res.json();
    return ids.slice(0, limit);
  } catch (err) {
    console.warn(`  ⚠ HN: Failed to fetch top stories: ${err.message}`);
    return [];
  }
}

/**
 * Fetch a single story by ID
 */
async function fetchStory(id) {
  try {
    const res = await fetch(`${HN_API}/item/${id}.json`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Check if a story is AI/tech related and within 48 hours
 */
function isAITechStory(story) {
  if (!story || !story.title) return false;
  
  // Check if within 48 hours
  const storyTime = story.time * 1000; // Convert Unix timestamp to milliseconds
  const now = Date.now();
  if (now - storyTime > HOURS_48) return false; // Skip stories older than 48 hours
  
  // Check if AI/tech related
  const titleLower = story.title.toLowerCase();
  return AI_KEYWORDS.some(kw => titleLower.includes(kw));
}

/**
 * Fetch top AI/tech stories from Hacker News (last 48 hours)
 * Returns posts in same format as Reddit scraper
 */
export async function fetchHNStories(maxPosts = 10) {
  console.log('\n▶ HACKER NEWS API (FREE — last 48 hours)');
  
  const storyIds = await fetchTopStoryIds(100); // Fetch more to find recent ones
  if (storyIds.length === 0) {
    console.log('  ⚠ No HN stories found');
    return [];
  }

  // Fetch stories in parallel (batch of 10)
  const stories = [];
  for (let i = 0; i < storyIds.length && stories.length < maxPosts * 3; i += 10) {
    const batch = storyIds.slice(i, i + 10);
    const results = await Promise.all(batch.map(id => fetchStory(id)));
    stories.push(...results.filter(Boolean));
  }

  // Filter for AI/tech content within 48 hours
  const aiStories = stories.filter(isAITechStory);
  console.log(`  ✓ Found ${aiStories.length} AI/tech stories from last 48 hours (${stories.length} total checked)`);

  // Convert to pipeline format and fetch article content
  const topStories = aiStories
    .filter(s => s.score > 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPosts);

  const posts = [];
  for (const story of topStories) {
    const articleUrl = story.url || `https://news.ycombinator.com/item?id=${story.id}`;
    
    // Fetch full article content for AI summarization
    let selftext = story.text || '';
    if (articleUrl && !selftext) {
      console.log(`  → Fetching article: ${story.title.substring(0, 40)}...`);
      const { content } = await enrichPostWithArticle(articleUrl);
      if (content) {
        selftext = content;
        console.log(`    ✓ Got ${content.length} chars of article content`);
      }
    }

    posts.push({
      title: story.title,
      subreddit: 'HackerNews',
      upvotes: story.score || 0,
      comments: story.descendants || 0,
      imageUrl: null,
      redditUrl: articleUrl,
      selftext: selftext,
      source: 'hackernews'
    });
  }

  console.log(`  ✓ ${posts.length} qualifying AI/tech posts`);
  posts.forEach((p, i) => {
    console.log(`  ${i + 1}. [${p.upvotes}⬆] ${p.title.substring(0, 60)}...`);
  });

  return posts;
}
