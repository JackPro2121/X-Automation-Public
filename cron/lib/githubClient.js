/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   GITHUB CLIENT — v9 Repo Spotlight                              ║
 * ║   cron/lib/githubClient.js                                       ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Finds trending open-source tools via the GitHub Search API and ║
 * ║   normalizes them into the post shape the shared machinery       ║
 * ║   (dedup, prompts, savePost) already understands.                ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * No paid scraper involved: unauthenticated search allows 10 req/min, ample
 * for 2 runs/day. When GH_TOKEN is set (Actions injects GITHUB_TOKEN), the
 * authenticated search limit applies instead.
 */

import dotenv from 'dotenv';
import path from 'path';
import { shuffleArray, isLikelyEnglish } from './utils.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const GITHUB_SEARCH_URL = 'https://api.github.com/search/repositories';
const GITHUB_README_URL = (fullName) => `https://api.github.com/repos/${fullName}/readme`;
const REQUEST_TIMEOUT_MS = 15000;
const MIN_STARS = 300;
const PUSHED_WITHIN_DAYS = 30;

// Rotating query pool. v9 pins the topic per run from its own daily post count
// (see topicIndexForPostCount) so the three daily runs always differ. Do NOT
// reintroduce a clock-derived default for the scheduled path: GitHub cron drifts
// by up to ~3h, which collapses every run into one bucket.
const TOPIC_QUERIES = [
  { topic: 'llm', label: 'LLM tooling' },
  { topic: 'ai-agents', label: 'AI agents' },
  { topic: 'mcp', label: 'MCP servers' },
  { topic: 'rag', label: 'RAG' },
  { topic: 'automation', label: 'automation' },
  { topic: 'devtools', label: 'dev tools' },
  { topic: 'cli', label: 'CLI tools' },
  { topic: 'self-hosted', label: 'self-hosted' },
  { topic: 'prompt-engineering', label: 'prompt engineering' },
  { topic: 'open-source', label: 'open source' },
];

function requestHeaders() {
  const h = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'x-automation-v9',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/**
 * Topic index for a scheduled run, derived from how many v9 posts already
 * shipped today. Drift-immune: unlike a clock bucket it does not collapse when
 * GitHub starts a run hours late. Falls back to slot 0 when the count is
 * unknown (e.g. the Supabase count query failed and returned -1).
 */
export function topicIndexForPostCount(postsToday) {
  if (!Number.isFinite(postsToday) || postsToday < 0) return 0;
  return Math.floor(postsToday) % TOPIC_QUERIES.length;
}

/** The topic for a 6-hour wall-clock slot. Fallback only — v9 pins explicitly. */
export function currentTopic(slot = Math.floor(Date.now() / (6 * 60 * 60 * 1000))) {
  return TOPIC_QUERIES[slot % TOPIC_QUERIES.length];
}

/** True when a repo is worth posting: described, alive, English, not a fork. */
export function isPostableRepo(repo) {
  if (!repo) return false;
  if (!repo.description || repo.description.trim().length < 20) return false;
  if (repo.fork || repo.archived || repo.disabled) return false;
  if ((repo.stargazers_count || 0) < MIN_STARS) return false;
  if (!isLikelyEnglish(repo.description)) return false;
  return true;
}

/**
 * Normalize a GitHub repo into the shape the rest of the pipeline understands.
 * `redditUrl` carries the canonical repo URL — isDuplicate() keys on it, so a
 * repo can never be reposted inside the dedup window. `imageUrl` stays null:
 * v9 attaches its own screenshot, never a borrowed image.
 */
export function repoToPost(repo) {
  const stars = repo.stargazers_count || 0;
  const topics = Array.isArray(repo.topics) ? repo.topics.slice(0, 5) : [];
  return {
    title: `${repo.full_name} — ${(repo.description || '').trim()}`,
    selftext: [
      `GitHub repo: ${repo.full_name}`,
      `Stars: ${stars} | Language: ${repo.language || 'n/a'} | Topics: ${topics.join(', ') || 'n/a'}`,
      (repo.description || '').trim(),
    ].join('\n'),
    redditUrl: repo.html_url,
    imageUrl: null,
    subreddit: 'github',
    upvotes: stars,
    comments: 0,
    source: 'github',
    repo: {
      fullName: repo.full_name,
      url: repo.html_url,
      description: (repo.description || '').trim(),
      stars,
      starsLabel: stars >= 1000 ? `${(stars / 1000).toFixed(1)}k` : String(stars),
      language: repo.language || null,
      topics,
      pushedAt: repo.pushed_at || null,
    },
  };
}

/**
 * Fetch trending repos for the current rotating topic.
 * @param {object} [opts]
 * @param {number} [opts.count=10] - how many postable repos to return (shuffled)
 * @param {number} [opts.topicIndex] - pin a topic (tests); default rotates by slot
 * @returns {Promise<{posts: object[], topic: {topic: string, label: string}}>}
 */
export async function fetchTrendingRepos(opts = {}) {
  const count = opts.count ?? 10;
  const topic = opts.topicIndex !== undefined
    ? TOPIC_QUERIES[opts.topicIndex % TOPIC_QUERIES.length]
    : currentTopic();

  const since = new Date(Date.now() - PUSHED_WITHIN_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const q = `topic:${topic.topic} stars:>${MIN_STARS} pushed:>${since}`;
  const url = `${GITHUB_SEARCH_URL}?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=25`;

  console.log(`  → GitHub search: ${q}`);
  try {
    const res = await fetch(url, {
      headers: requestHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`  ⚠ GitHub search HTTP ${res.status}: ${body.slice(0, 160)}`);
      return { posts: [], topic };
    }
    const data = await res.json();
    const postable = (data.items || []).filter(isPostableRepo);
    const posts = shuffleArray(postable, Math.min(count, postable.length)).map(repoToPost);
    console.log(`  ✓ ${postable.length} postable repos on "${topic.label}" (picked ${posts.length})`);
    return { posts, topic };
  } catch (err) {
    console.warn(`  ⚠ GitHub search failed: ${err.message}`);
    return { posts: [], topic };
  }
}

/**
 * Fetch a short plain-text README excerpt for richer caption context.
 * Best-effort: returns '' on any failure — the caption still works without it.
 * @param {string} fullName - e.g. 'owner/repo'
 * @param {number} [maxChars=1200]
 * @returns {Promise<string>}
 */
export async function fetchReadmeExcerpt(fullName, maxChars = 1200) {
  try {
    const res = await fetch(GITHUB_README_URL(fullName), {
      headers: { ...requestHeaders(), Accept: 'application/vnd.github.raw' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return '';
    const text = await res.text();
    return text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')   // images / badges
      .replace(/<[^>]+>/g, ' ')                 // html tags
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // links → anchor text
      .replace(/^#{1,6}\s+/gm, '')             // markdown headings
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxChars);
  } catch {
    return '';
  }
}
