/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   X-AUTOMATION v3 — ORIGINAL AI NEWS PIPELINE                   ║
 * ║   seed_and_post.js                                               ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Reddit → OpenRouter generates ORIGINAL analysis                     ║
 * ║   Output: 1-2 tweet thread with unique insight + image          ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { postSingleToBuffer, postThreadToBuffer, postToQueue, isMediaWithinLimits } from './lib/bufferClient.js';
import { isDuplicate, generateId, shuffleArray, validateEnv } from './lib/utils.js';
import { createKeyManager } from './lib/keyManager.js';
import { sendSlack, buildSuccessMessage, buildFailureMessage, buildNoPostsMessage, buildPartialFailureMessage, buildDryRunMessage } from './lib/slackClient.js';
import { startRun } from './lib/logger.js';
import { initGroqKeys, getGroqKeyStatus, generateTweetWithFallback, generateThreadFromArticle } from './lib/groqClient.js';
import { fetchHNStories } from './lib/hackernews.js';
import { fetchDevToArticles } from './lib/devto.js';
import { fetchSubredditPosts as fetchBrightDataPosts } from './lib/brightdataClient.js';
import { fetchSubredditPosts as fetchChocodataPosts, getChocodataStatus, checkChocodataBalances, enrichPostSelftext } from './lib/chocodataClient.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

// ─── Environment ──────────────────────────────────────────────────────────────
validateEnv(['VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const llmKeys = createKeyManager('OPENROUTER', [
  process.env.OPENROUTER_API_KEY,
  process.env.OPENROUTER_API_KEY_2,
  process.env.OPENROUTER_API_KEY_3,
]);

// Initialize Groq Vision keys (primary LLM)
const groqKeys = initGroqKeys();
const BUFFER_API_KEY = process.env.BUFFER_API_KEY;
const BUFFER_CHANNEL_ID = process.env.BUFFER_CHANNEL_ID;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// ─── AI-Focused Subreddits (v3) ─────────────────────────────────────────────
// Split into TWO categories to guarantee free tools content daily:
// - AI_NEWS: AI-specific subreddits (high upvotes, model releases)
// - FREE_TOOLS: Open source, self-hosted, free tools (viral on X)
// Each run picks 1 FREE_TOOLS + 1 AI_NEWS = minimum 9 free tools posts/day

// ─── v3 SUBREDDITS — NO OVERLAP with v4 ─────────────────────────────────────
// v3 focuses on: AI News, Claude, ChatGPT, Local LLMs, AI Art
// v4 focuses on: Free Tools, Open Source, Self-Hosted, DevOps

// ─── v3 AI NEWS SUBREDDITS — Verified by live Apify scrape (Jul 2026) ────────
// All subs verified: active, high upvotes, image posts available
// v3 picks 2 per run (1 guaranteed high-engagement + 1 random)

const AI_NEWS_SUBS = [
  { name: 'ClaudeAI', label: 'Anthropic Claude' },                    // Top: 2905⬆ Avg: 299⬆ Images: 50%
  { name: 'singularity', label: 'AI Future & Predictions' },          // Top: 2421⬆ Avg: 316⬆ Images: 32%
  { name: 'LocalLLaMA', label: 'Local LLMs & Open Source' },          // Top: 454⬆  Avg: 115⬆ Images: 8%
  { name: 'ChatGPT', label: 'ChatGPT & OpenAI' },                     // Top: 3232⬆ Avg: 419⬆ Images: 17%
  { name: 'OpenAI', label: 'Official OpenAI Updates' },               // Top: 649⬆  Avg: 93⬆  Images: 8%
  { name: 'artificial', label: 'AI News & General AI' },              // Top: 479⬆  Avg: 44⬆  Images: 17%
  { name: 'midjourney', label: 'AI Art Generation' },                  // Top: 323⬆  Avg: 64⬆  Images: 33%
];

// ─── Big Tech Companies to Monitor ──────────────────────────────────────────
// These keywords trigger the LLM to create company-specific takes

const BIG_TECH_KEYWORDS = {
  'OpenAI': ['openai', 'gpt', 'chatgpt', 'dall-e', 'sora'],
  'Anthropic': ['anthropic', 'claude', 'constitutional ai'],
  'Google DeepMind': ['deepmind', 'gemini', 'bard', 'palm'],
  'Meta AI': ['meta ai', 'llama', 'segment anything'],
  'Mistral AI': ['mistral', 'mixtral'],
  'Hugging Face': ['hugging face', 'huggingface', 'transformers'],
  'xAI': ['xai', 'grok'],
  'Moonshot AI': ['moonshot', 'kimi'],
  'Stability AI': ['stability ai', 'stable diffusion', 'sdxl'],
  'Cohere': ['cohere', 'command r'],
};

// ─── Reddit Scraper: Chocodata (FREE) → Bright Data (PAYG fallback) ──────────
// Chocodata is the free primary provider (5 credits/request, 25 posts/sub).
// Bright Data remains as fallback for when Chocodata returns nothing.

async function fetchRedditPosts(subredditName) {
  // Provider order: Chocodata (FREE) → Bright Data (PAYG fallback)
  const chocoPosts = await fetchChocodataPosts([subredditName]);
  if (chocoPosts.length > 0) return chocoPosts;

  if (!process.env.BRIGHTDATA_API_KEY) return [];

  try {
    const posts = await fetchBrightDataPosts([subredditName]);
    return posts;
  } catch (err) {
    console.warn(`  ⚠ Reddit fetch failed for r/${subredditName}: ${err.message}`);
    return [];
  }
}

// ─── Quality Filter ──────────────────────────────────────────────────────────

function filterQualityPosts(posts) {
  return posts
    .filter(p => p.title && p.title.length > 20) // Minimum 20 chars (filters out "Haiku Users:" etc.)
    .filter(p => p.imageUrl) // Image REQUIRED
    .sort((a, b) => b.upvotes - a.upvotes); // Highest upvotes first
}

// ─── Dedup Check (delegated to shared utils) ──────────────────────────────────
// H3/M3 fix: isDuplicate is null-safe and fail-safe (returns true on error)

// ─── LLM: Generate Original Take (DEPRECATED — now via generateTweetWithFallback) ───
// This function is kept as reference. The actual generation is now done via
// generateTweetWithFallback() from groqClient.js which tries:
// 1. Groq Vision (sees the image)
// 2. Groq Text (text-only fallback)
// 3. Groq text (existing fallback)
// 4. Raw Reddit title (last resort)

// ─── Buffer: Post with Image (delegated to shared module) ─────────────────────
// postToBuffer replaced by bufferClient.postSingleToBuffer
// Import: postSingleToBuffer from './lib/bufferClient.js'

// ─── Supabase: Save Post ─────────────────────────────────────────────────────

async function savePost(post, text, status = 'posting', bufferPostId = null) {
  try {
    const { error } = await supabase.from('generated_posts').insert({
      id: generateId('v3'), // M8 fix: collision-safe ID
      original_post_id: post.redditUrl,
      creator_handle: `r/${post.subreddit}`,
      creator_name: `r/${post.subreddit}`,
      generated_text: text,
      character_count: text?.length || 0,
      status,
      source_url: post.redditUrl || `https://reddit.com/r/${post.subreddit}`, // C2 fix: never null
      buffer_post_id: bufferPostId
    });
    if (error) throw error;
    console.log('  ✓ Saved to Supabase');
  } catch (err) {
    console.warn(`  ⚠ Save failed: ${err.message}`);
    throw err; // Re-throw so caller can handle
  }
}

async function updatePostStatus(postRedditUrl, status, bufferPostId = null, errorMessage = null) {
  const payload = { status, buffer_post_id: bufferPostId };
  if (errorMessage) payload.error_message = String(errorMessage).substring(0, 500);
  try {
    let { error } = await supabase.from('generated_posts')
      .update(payload)
      .eq('source_url', postRedditUrl)
      .eq('status', 'posting');
    // Best-effort: if error_message column isn't migrated yet, retry without it
    if (error && payload.error_message && /column.*does not exist|could not find the .* column/.test(error.message)) {
      delete payload.error_message;
      ({ error } = await supabase.from('generated_posts')
        .update(payload)
        .eq('source_url', postRedditUrl)
        .eq('status', 'posting'));
    }
    if (error) throw error;
    console.log(`  ✓ Updated status to '${status}'`);
  } catch (err) {
    console.warn(`  ⚠ Status update failed: ${err.message}`);
  }
}

// ─── Daily Counter ────────────────────────────────────────────────────────────
// Track how many posts were published today to ensure exactly 40/day

// Includes immediate Buffer shares plus items intentionally added to Buffer's queue.
// Quote tweets are included too, so the account never exceeds this hard daily ceiling.
const DAILY_TARGET = 50;
const POSTS_PER_RUN = 2; // v3 posts 2 per run = 18 posts/day from v3

async function getTodayPostCount() {
  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const { count: publishedCount, error: publishedError } = await supabase
      .from('generated_posts')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'published')
      .gte('db_created_at', todayStart.toISOString());
    if (publishedError) throw publishedError;

    // Buffer queue entries are accepted by Buffer but are not live yet. Count them
    // against the daily ceiling without incorrectly calling them "published".
    const { count: queuedCount, error: queuedError } = await supabase
      .from('generated_posts')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'approved')
      .not('buffer_post_id', 'is', null)
      .gte('db_created_at', todayStart.toISOString());
    if (queuedError) throw queuedError;

    return (publishedCount || 0) + (queuedCount || 0);
  } catch (err) {
    console.warn(`  ⚠ Could not get today's post count: ${err.message}`);
    return -1; // Unknown
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  🤖  X-AUTOMATION v3 — ORIGINAL AI NEWS PIPELINE            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Started : ${new Date().toISOString()}`);
  console.log(`  Buffer  : ${BUFFER_API_KEY ? '✓' : '✗ (dry run)'}`);
  console.log(`  Groq    : ${groqKeys.totalKeys} key(s) loaded (${groqKeys.availableKeys} available)`);
  console.log(`  LLM     : ${llmKeys.totalKeys} OpenRouter key(s) loaded (${llmKeys.availableKeys} available)`);
  console.log(`  Reddit  : Chocodata (FREE, 5 credits/req) → Bright Data fallback`);
  console.log(`  Target  : ${POSTS_PER_RUN} posts this run`);
  const pipeline = 'v3';
  const run = startRun(pipeline); // Start logging

  try {
    // 0. Check daily post count
    const todayCount = await getTodayPostCount();
    console.log(`  📊 Today's posts so far: ${todayCount}/${DAILY_TARGET}`);
    if (todayCount >= DAILY_TARGET) {
      console.log(`  ✅ Daily target (${DAILY_TARGET}) already reached! Skipping this run.`);
      await run.noPosts(0);
      return;
    }
    const remaining = DAILY_TARGET - todayCount;
    const postsToMake = Math.min(POSTS_PER_RUN, remaining);
    console.log(`  📈 Need ${remaining} more posts, will post ${postsToMake} this run`);

    // 0.5 Check Chocodata key (FREE, no credits consumed)
    console.log('\n  💰 Checking Chocodata keys...');
    await checkChocodataBalances();

    // 1. Fetch Reddit posts — AI NEWS ONLY for v3 (Progressive/Lazy to save API credits)
    console.log('\n▶ STEP 1: Fetching Reddit AI news (Credit-Optimized)...');
    const selected = shuffleArray(AI_NEWS_SUBS, 3); // Pick pool of 3 candidates

    console.log(`  🎯 Priority subs: ${selected.map(s => 'r/' + s.name).join(', ')}`);

    let allPosts = [];
    let qualityPosts = [];

    for (const sub of selected) {
      console.log(`  → Scanning r/${sub.name}...`);
      const posts = await fetchRedditPosts(sub.name);
      console.log(`    Found ${posts.length} posts from r/${sub.name}`);
      allPosts.push(...posts);
      qualityPosts = filterQualityPosts(allPosts);

      // Early stop: If we already have 4+ quality candidates (enough for postsToMake + queue), don't waste credits on remaining subs
      if (qualityPosts.length >= (postsToMake + 2)) {
        console.log(`  💡 Credit Saver: Found ${qualityPosts.length} quality candidates — skipping remaining subreddits.`);
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    console.log(`  Total posts collected: ${allPosts.length} (${qualityPosts.length} quality)`);

    // Fallback: If no Reddit posts, try Hacker News and Dev.to
    if (qualityPosts.length === 0) {
      console.log('\n  ⚠ No Reddit posts found. Trying fallback sources...');
      
      // Try Hacker News (FREE)
      const hnPosts = await fetchHNStories(postsToMake + 2);
      if (hnPosts.length > 0) {
        console.log(`  ✓ Fallback: Found ${hnPosts.length} Hacker News posts`);
        allPosts.push(...hnPosts);
      }
      
      // Try Dev.to (FREE)
      const devtoPosts = await fetchDevToArticles(postsToMake + 2);
      if (devtoPosts.length > 0) {
        console.log(`  ✓ Fallback: Found ${devtoPosts.length} Dev.to articles`);
        allPosts.push(...devtoPosts);
      }
      
      // Re-filter after fallback
      const fallbackQuality = allPosts.filter(p => p.title && p.title.length > 15);
      if (fallbackQuality.length === 0) {
        console.log('  ⚠ No posts from any source. Exiting.');
        run.setApifyKeyStatus(getChocodataStatus());
        await run.noPosts(selected.length);
        await sendSlack(buildNoPostsMessage({ pipeline, subredditsScanned: selected.length, keyStatus: getChocodataStatus(), llmKeyStatus: llmKeys.getStatus(), groqKeyStatus: getGroqKeyStatus() }));
        return;
      }
      qualityPosts.length = 0;
      qualityPosts.push(...fallbackQuality);
    }

    // 3. Find non-duplicate posts (up to postsToMake)
    console.log('\n▶ STEP 3: Selecting posts (dedup check)...');
    const selectedPosts = [];
    for (const post of qualityPosts) {
      if (selectedPosts.length >= postsToMake) break;
      if (!await isDuplicate(supabase, post.redditUrl)) {
        if (post.imageUrl && !(await isMediaWithinLimits(post.imageUrl))) {
          console.log(`  ⚠ Skipping r/${post.subreddit} post "${post.title.substring(0, 40)}..." (media exceeds Buffer size limits) — picking next`);
          continue;
        }
        selectedPosts.push(post);
        console.log(`  ✓ Selected: ${post.title.substring(0, 60)}... (${post.upvotes}⬆)`);
      }
    }

    if (selectedPosts.length === 0) {
      console.log('  ⚠ All posts already posted. Exiting.');
      run.setApifyKeyStatus(getChocodataStatus());
      await run.noPosts(selected.length);
      await sendSlack(buildNoPostsMessage({ pipeline, subredditsScanned: selected.length, keyStatus: getChocodataStatus(), llmKeyStatus: llmKeys.getStatus(), groqKeyStatus: getGroqKeyStatus() }));
      return;
    }

    console.log(`\n  📝 Will post ${selectedPosts.length} posts this run`);
    run.setApifyKeyStatus(getChocodataStatus());
    run.setMimoKeyStatus(llmKeys.getStatus()); // column name legacy — now stores OPENROUTER status
    run.setGroqKeyStatus(getGroqKeyStatus());

    // 4-6. Process each post: Generate → Save → Post → Notify
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < selectedPosts.length; i++) {
      const post = selectedPosts[i];
      const postNum = `[${i + 1}/${selectedPosts.length}]`;

      console.log(`\n${'═'.repeat(60)}`);
      console.log(`  POST ${postNum}: ${post.title.substring(0, 80)}...`);
      console.log(`  Source: r/${post.subreddit} | ⬆ ${post.upvotes}`);
      console.log(`${'═'.repeat(60)}`);

      try {
        // Enrich Reddit post with its selftext body (Chocodata reddit/post, +5 credits).
        // Slim strategy: only posts selected for immediate posting — NOT the excess/queue pool.
        if (post.postId && !post.selftext) {
          await enrichPostSelftext(post);
        }

        // Check if this is a fallback post with full article content (HN/Dev.to)
        const hasFullArticle = (post.source === 'hackernews' || post.source === 'devto') 
                               && post.selftext && post.selftext.length > 200;

        let postText = '';
        let model = '';
        let isThread = false;
        let threadTweets = [];

        if (hasFullArticle) {
          // Try to generate thread from full article content
          console.log(`\n  ▶ Generating thread from article...`);
          const threadResult = await generateThreadFromArticle(post, llmKeys);
          
          if (threadResult && threadResult.tweets.length >= 2) {
            isThread = true;
            threadTweets = threadResult.tweets;
            postText = threadTweets[0]; // First tweet for logging
            model = threadResult.model;
            console.log(`  ✓ Generated ${threadTweets.length}-tweet thread (${model})`);
          } else {
            // Fallback to single tweet
            console.log(`  ⚠ Thread failed, using single tweet...`);
            const result = await generateTweetWithFallback(post, llmKeys, false);
            postText = result?.text || null;
            model = result?.model || 'none';
          }
        } else {
          // Single tweet (Reddit posts or posts without full article)
          console.log(`\n  ▶ Generating with Groq Vision...`);
          const result = await generateTweetWithFallback(post, llmKeys, false);
          postText = result?.text || null;
          model = result?.model || 'none';
        }

        console.log(`  ✓ Generated (${model}): ${(postText || '').substring(0, 80)}...`);

        // Validate
        if (!postText || postText.trim().length === 0 || postText.trim() === '.') {
          console.log('  ⚠ Empty text or non-English — skipping');
          failCount++;
          continue;
        }

        // Save to Supabase
        console.log(`  ▶ Saving to Supabase...`);
        const textToSave = isThread ? threadTweets.join('\n\n') : postText;
        await savePost(post, textToSave, 'posting');

        // Post to Buffer
        console.log(`  ▶ Posting to X via Buffer...`);
        let bufferResult;
        if (isThread && threadTweets.length >= 2) {
          bufferResult = await postThreadToBuffer(threadTweets, post.imageUrl);
        } else {
          bufferResult = await postSingleToBuffer(postText, post.imageUrl);
        }

        // Update status
        await updatePostStatus(
          post.redditUrl,
          bufferResult.success ? 'published' : 'failed',
          bufferResult.postId || null,
          bufferResult.success ? null : bufferResult.reason
        );

        if (bufferResult.success) {
          successCount++;
          console.log(`  ✅ PUBLISHED! (Buffer ID: ${bufferResult.postId})`);

          // Slack notification
          const slackResult = await sendSlack(buildSuccessMessage({
            pipeline,
            text: postText,
            subreddit: post.subreddit,
            upvotes: post.upvotes,
            imageUrl: post.imageUrl,
            redditUrl: post.redditUrl,
            bufferId: bufferResult.postId,
            elapsed: ((Date.now() - startTime) / 1000).toFixed(1),
            keyStatus: getChocodataStatus(),
            redditTitle: post.title,
            comments: post.comments,
            charCount: postText.length,
            llmKeyStatus: llmKeys.getStatus(),
            groqKeyStatus: getGroqKeyStatus(),
            modelUsed: model,
            todayCount: await getTodayPostCount(),
          }));
          run.setSlackSent(slackResult.ok);
        } else {
          failCount++;
          console.log(`  ❌ Buffer failed: ${bufferResult.reason}`);
        }

        // Delay between posts (random 30-90s to avoid X bot detection)
        if (i < selectedPosts.length - 1) {
          const delay = Math.floor(Math.random() * 60) + 30; // 30-90 seconds random
          console.log(`  ⏳ Waiting ${delay}s before next post (random delay)...`);
          await new Promise(r => setTimeout(r, delay * 1000));
        }

      } catch (err) {
        failCount++;
        console.error(`  ❌ Post failed: ${err.message}`);
      }
    }

    // ─── Queue excess quality posts to Buffer ─────────────────────────────────
    let queuedCount = 0;    const currentTotal = await getTodayPostCount();
    const maxExcess = Math.min(2, Math.max(0, DAILY_TARGET - currentTotal)); // Reduced from 3 to 2 (Buffer limit: 10 scheduled,4 slots/day)
    console.log(`\n▶ QUEUING excess quality posts to Buffer...`);

    for (const post of qualityPosts) {
      if (queuedCount >= maxExcess) break;
      // Skip posts already selected for immediate posting
      if (selectedPosts.some(sp => sp.redditUrl === post.redditUrl)) continue;

      if (!await isDuplicate(supabase, post.redditUrl)) {
        if (post.imageUrl && !(await isMediaWithinLimits(post.imageUrl))) continue;
        try {
          const result = await generateTweetWithFallback(post, llmKeys, false);
          if (result && result.text && result.text.length > 10) {
            const queueResult = await postToQueue(result.text, post.imageUrl);
            if (queueResult.success) {
              await savePost(post, result.text, 'approved', queueResult.postId);
              queuedCount++;
              console.log(`  ✅ Queued: ${post.title.substring(0, 50)}...`);
            }
          }
        } catch (err) {
          console.warn(`  ⚠ Queue failed: ${err.message}`);
        }
      }
    }
    console.log(`  📊 Queued ${queuedCount} excess posts to Buffer`);

    // Alert on partial per-post failures (N2)
    if (failCount > 0) {
      const partialResult = await sendSlack(buildPartialFailureMessage({
        pipeline,
        successCount,
        failCount,
        queuedCount,
        keyStatus: getChocodataStatus(),
        llmKeyStatus: llmKeys.getStatus(),
        groqKeyStatus: getGroqKeyStatus(),
      }));
      if (partialResult.ok) console.log('  ✓ Partial-failure alert sent to Slack');
    }

    // Summary
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const finalCount = await getTodayPostCount();
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  📊  PIPELINE COMPLETE                                       ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Posts this run : ${String(`${successCount} success, ${failCount} failed, ${queuedCount} queued`).padEnd(41)}║`);
    console.log(`║  Daily total    : ${String(`${finalCount}/${DAILY_TARGET}`).padEnd(41)}║`);
    console.log(`║  Subreddits     : ${String(selected.map(s => 'r/' + s.name).join(', ')).padEnd(41)}║`);
    console.log(`║  Elapsed        : ${String(elapsed + 's').padEnd(41)}║`);
    console.log('╚══════════════════════════════════════════════════════════════╝');

    // Log last post details
    const lastPost = selectedPosts[selectedPosts.length - 1];
    run.setPost({
      title: lastPost.title,
      url: lastPost.redditUrl,
      upvotes: lastPost.upvotes,
      subreddit: lastPost.subreddit,
      imageUrl: lastPost.imageUrl,
    });

    // Complete logging
    await run.success();

  } catch (err) {
    console.error('\n❌ PIPELINE FATAL:', err.message);
    const slackResult = await sendSlack(buildFailureMessage({ pipeline, step: 'pipeline', error: err.message, keyStatus: getChocodataStatus(), llmKeyStatus: llmKeys.getStatus(), groqKeyStatus: getGroqKeyStatus() }));
    run.setSlackSent(slackResult.ok);
    await run.fail(err);
    process.exitCode = 1;
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
  process.exitCode = 1;
});

main().catch((err) => {
  console.error('❌ main() failed:', err);
  process.exitCode = 1;
});
