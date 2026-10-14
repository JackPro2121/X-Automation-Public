/**
 * Dev.to API client for X-Automation pipelines.
 * FREE — no API key needed for public endpoints.
 * Fetches AI/tech articles from last 48 hours with cover images.
 * Fetches full article content for AI summarization.
 */

import { enrichPostWithArticle } from './articleFetcher.js';

const DEVTO_API = 'https://dev.to/api/articles';
const HOURS_48 = 48 * 60 * 60 * 1000; // 48 hours in milliseconds

// Tags to search for (expanded for more content)
const AI_TAGS = [
  'ai', 'machinelearning', 'opensource', 'github', 'devtools', 'productivity',
  'javascript', 'python', 'webdev', 'programming', 'technology', 'computerscience',
  'linux', 'docker', 'api', 'cloud', 'tutorial'
];

/**
 * Fetch articles from Dev.to by tag (last 48 hours)
 */
async function fetchArticlesByTag(tag, limit = 10) {
  try {
    // Fetch recent articles (top=1 means top from last 24 hours, we'll filter for 48h)
    const res = await fetch(`${DEVTO_API}?tag=${tag}&top=7&per_page=${limit}`, {
      headers: { 'Accept': 'application/vnd.forem.api-v1+json' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`  ⚠ Dev.to: Failed to fetch tag '${tag}': ${err.message}`);
    return [];
  }
}

/**
 * Check if article is within 48 hours
 */
function isRecentArticle(article) {
  if (!article.published_at) return false;
  const publishTime = new Date(article.published_at).getTime();
  return Date.now() - publishTime <= HOURS_48;
}

/**
 * Fetch top articles from Dev.to (last 48 hours)
 */
export async function fetchDevToArticles(maxPosts = 10) {
  console.log('\n▶ DEV.TO API (FREE — last 48 hours)');
  
  const allArticles = [];
  
  // Fetch from multiple tags
  for (const tag of AI_TAGS.slice(0, 5)) {
    const articles = await fetchArticlesByTag(tag, 5);
    allArticles.push(...articles);
    await new Promise(r => setTimeout(r, 300)); // Rate limit courtesy
  }

  // Deduplicate by ID
  const seen = new Set();
  const unique = allArticles.filter(a => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });

  // Filter for recent articles (last 48 hours)
  const recent = unique.filter(isRecentArticle);
  console.log(`  ✓ Found ${recent.length} articles from last 48 hours (${unique.length} total)`);

  // Filter for articles with cover images
  const withImages = recent.filter(a => a.cover_image && a.cover_image.startsWith('http'));
  console.log(`  ✓ ${withImages.length} articles with cover images`);

  // Convert to pipeline format and fetch article content
  const topArticles = withImages
    .sort((a, b) => (b.positive_reactions_count || 0) - (a.positive_reactions_count || 0))
    .slice(0, maxPosts);

  const posts = [];
  for (const article of topArticles) {
    const articleUrl = article.url || article.canonical_url;
    
    // Fetch full article content for AI summarization
    let selftext = article.description || '';
    if (articleUrl && (!selftext || selftext.length < 100)) {
      console.log(`  → Fetching article: ${article.title.substring(0, 40)}...`);
      const { content } = await enrichPostWithArticle(articleUrl);
      if (content) {
        selftext = content;
        console.log(`    ✓ Got ${content.length} chars of article content`);
      }
    }

    posts.push({
      title: article.title,
      subreddit: 'Dev.to',
      upvotes: article.positive_reactions_count || 0,
      comments: article.comments_count || 0,
      imageUrl: article.cover_image,
      redditUrl: articleUrl,
      selftext: selftext,
      source: 'devto'
    });
  }

  console.log(`  ✓ ${posts.length} qualifying articles`);
  posts.forEach((p, i) => {
    console.log(`  ${i + 1}. [${p.upvotes}⬆] ${p.title.substring(0, 60)}...`);
  });

  return posts;
}
