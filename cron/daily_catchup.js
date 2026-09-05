/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   X-AUTOMATION — DAILY CATCH-UP                                ║
 * ║   daily_catchup.js                                              ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Runs once daily at 23:00 UTC                                  ║
 * ║   Checks how many posts were published today                    ║
 * ║   If below target, runs additional posts to fill the gap        ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { createKeyManager } from './lib/keyManager.js';
import { sendSlack, buildSuccessMessage, buildFailureMessage, buildNoPostsMessage, buildCatchupSummary, buildPartialFailureMessage } from './lib/slackClient.js';
import { validateEnv, generateId, shuffleArray, isDuplicate } from './lib/utils.js';
import { postSingleToBuffer, isMediaWithinLimits } from './lib/bufferClient.js';
import { startRun } from './lib/logger.js';
import { initGroqKeys, getGroqKeyStatus, generateTweetWithFallback } from './lib/groqClient.js';
import { fetchSubredditPosts as fetchBrightDataPosts } from './lib/brightdataClient.js';
import { fetchSubredditPosts as fetchChocodataPosts, getChocodataStatus } from './lib/chocodataClient.js';
import { sendAnalyticsDigest } from './analytics_tracker.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

validateEnv(['VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DAILY_TARGET = 50;
const MAX_CATCHUP_POSTS_PER_RUN = 10; // Owner updated: allow up to 10 catch-up posts to guarantee daily 40-50 posts target

const llmKeys = createKeyManager('OPENROUTER', [
  process.env.OPENROUTER_API_KEY,
  process.env.OPENROUTER_API_KEY_2,
  process.env.OPENROUTER_API_KEY_3,
]);

// Initialize Groq Vision keys (primary LLM)
const groqKeys = initGroqKeys();

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// Combined subreddit list (all subs from v3 + v4 — matches current pipeline code)
const ALL_SUBREDDITS = [
  // v3 AI News
  { name: 'ClaudeAI', type: 'ai' },
  { name: 'singularity', type: 'ai' },
  { name: 'LocalLLaMA', type: 'ai' },
  { name: 'ChatGPT', type: 'ai' },
  { name: 'OpenAI', type: 'ai' },
  { name: 'artificial', type: 'ai' },
  { name: 'midjourney', type: 'ai' },
  // v4 Free Tools & Tech
  { name: 'webdev', type: 'tools' },
  { name: 'selfhosted', type: 'tools' },
  { name: 'homelab', type: 'tools' },
  { name: 'linux', type: 'tools' },
  { name: 'commandline', type: 'tools' },
  { name: 'coolgithubprojects', type: 'tools' },
  { name: 'software', type: 'tools' },
  { name: 'dataisbeautiful', type: 'tools' },
  { name: 'devops', type: 'tools' },
];

// ─── Get Today's Published Count ─────────────────────────────────────────────

async function getTodayPostCount() {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const { count: publishedCount, error: publishedError } = await supabase
    .from('generated_posts')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'published')
    .gte('db_created_at', todayStart.toISOString());
  if (publishedError) throw publishedError;

  const { count: queuedCount, error: queuedError } = await supabase
    .from('generated_posts')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'approved')
    .not('buffer_post_id', 'is', null)
    .gte('db_created_at', todayStart.toISOString());
  if (queuedError) throw queuedError;
  return (publishedCount || 0) + (queuedCount || 0);
}

// ─── Fetch Posts from One Subreddit ──────────────────────────────────────────

async function fetchSubredditPosts(subredditName) {
  // Provider order: Chocodata (FREE) → Bright Data (PAYG fallback)
  let posts = await fetchChocodataPosts([subredditName]);
  if (posts.length === 0) {
    console.warn(`  ⚠ Chocodata empty for r/${subredditName} — falling back to Bright Data`);
    posts = await fetchBrightDataPosts([subredditName]);
  }
  return (posts || []).filter(p => p.title && p.imageUrl && p.title.length > 20);
}

// ─── Save + Post ─────────────────────────────────────────────────────────────

async function saveAndPost(post, text) {
  await supabase.from('generated_posts').insert({
    id: generateId('catch'),
    original_post_id: post.redditUrl,
    creator_handle: `r/${post.subreddit}`,
    creator_name: `r/${post.subreddit}`,
    generated_text: text,
    character_count: text?.length || 0,
    status: 'posting',
    source_url: post.redditUrl || `https://reddit.com/r/${post.subreddit}`,
    buffer_post_id: null
  });

  const result = await postSingleToBuffer(text, post.imageUrl);

  const payload = { status: result.success ? 'published' : 'failed', buffer_post_id: result.postId || null };
  if (!result.success && result.reason) payload.error_message = String(result.reason).substring(0, 500);
  let { error } = await supabase.from('generated_posts')
    .update(payload)
    .eq('source_url', post.redditUrl)
    .eq('status', 'posting');
  // Best-effort: if error_message column isn't migrated yet, retry without it
  if (error && payload.error_message && /column.*does not exist|could not find the .* column/.test(error.message)) {
    delete payload.error_message;
    ({ error } = await supabase.from('generated_posts')
      .update(payload)
      .eq('source_url', post.redditUrl)
      .eq('status', 'posting'));
  }
  if (error) console.warn(`  ⚠ Status update failed: ${error.message}`);

  return result;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  🔄  DAILY CATCH-UP — Ensure 50 Posts/Day                  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const run = startRun('catchup');
  run.setApifyKeyStatus(getChocodataStatus());
  run.setMimoKeyStatus(llmKeys.getStatus());
  run.setGroqKeyStatus(getGroqKeyStatus());

  try {
    const todayCount = await getTodayPostCount();
    const gap = DAILY_TARGET - todayCount;

    console.log(`  📊 Today's published posts: ${todayCount}/${DAILY_TARGET}`);

    if (gap <= 0) {
      console.log('  ✅ Daily target already reached! No catch-up needed.');
      await run.noPosts(0);
      return;
    }

    console.log(`  📈 Need to fill gap: ${gap} posts`);
    console.log(`  🔑 Reddit: Bright Data | OpenRouter keys: ${llmKeys.totalKeys}`);

    let posted = 0;
    let failed = 0;
    const shuffled = shuffleArray(ALL_SUBREDDITS, ALL_SUBREDDITS.length);

    for (const sub of shuffled) {
      if (posted >= gap || posted >= MAX_CATCHUP_POSTS_PER_RUN) break;

      console.log(`\n  → Scanning r/${sub.name} (${sub.type})...`);
      const posts = await fetchSubredditPosts(sub.name);

      if (posts.length === 0) {
        console.log(`    No qualifying posts found`);
        continue;
      }

      // Sort by upvotes, pick best non-duplicate
      posts.sort((a, b) => b.upvotes - a.upvotes);

      let bestPost = null;
      for (const p of posts) {
        if (p.redditUrl && !await isDuplicate(supabase, p.redditUrl)) {
          if (p.imageUrl && !(await isMediaWithinLimits(p.imageUrl))) {
            console.log(`    ⚠ Skipping "${p.title.substring(0, 40)}..." (media exceeds Buffer limits)`);
            continue;
          }
          bestPost = p;
          break;
        }
      }

      if (!bestPost) {
        console.log(`    All posts already posted (dedup)`);
        continue;
      }

      console.log(`    Selected: ${bestPost.title.substring(0, 60)}... (${bestPost.upvotes}⬆)`);

      // Generate with OpenRouter (falls back to Groq if needed)
      console.log(`    Generating with Groq Vision...`);
      const generated = await generateTweetWithFallback(bestPost, llmKeys, false);
      // Guard: fallback returns null when all LLMs fail AND the raw title fails quality checks
      if (!generated?.text || generated.text.trim().length === 0) {
        console.log(`    ⚠ No usable tweet generated — skipping post`);
        continue;
      }
      const { text, model } = generated;
      console.log(`    ✓ Generated (${model}): ${text.substring(0, 80)}...`);

      // Record this post in the logger
      run.setPost({
        title: bestPost.title,
        url: bestPost.redditUrl,
        upvotes: bestPost.upvotes,
        subreddit: bestPost.subreddit,
        generatedText: text,
        imageUrl: bestPost.imageUrl,
      });

      const result = await saveAndPost(bestPost, text);

      if (result.success) {
        posted++;
        console.log(`    ✅ Posted to X! (${posted}/${gap} catch-up posts)`);

        const slackResult = await sendSlack(buildSuccessMessage({
          pipeline: 'catchup',
          text,
          subreddit: bestPost.subreddit,
          upvotes: bestPost.upvotes,
          imageUrl: bestPost.imageUrl,
          redditUrl: bestPost.redditUrl,
          bufferId: result.postId,
          elapsed: '0',
          keyStatus: getChocodataStatus(),
          redditTitle: bestPost.title,
          comments: bestPost.comments,
          charCount: text.length,
          llmKeyStatus: llmKeys.getStatus(),
          groqKeyStatus: getGroqKeyStatus(),
          modelUsed: model,
          todayCount: await getTodayPostCount(),
        }));
        run.setSlackSent(slackResult.ok);
      } else {
        failed++;
        console.log(`    ❌ Failed: ${result.reason}`);
      }

      // Random delay between posts (30-90s to avoid X bot detection)
      // Only wait when another post may still happen — skip the trailing sleep after the final post
      if (posted < Math.min(gap, MAX_CATCHUP_POSTS_PER_RUN)) {
        const delay = Math.floor(Math.random() * 60) + 30;
        console.log(`  ⏳ Waiting ${delay}s before next post...`);
        await new Promise(r => setTimeout(r, delay * 1000));
      }
    }

    const finalCount = await getTodayPostCount();
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  📊  CATCH-UP COMPLETE                                       ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Posts added: ${String(posted).padEnd(46)}║`);

    // Alert on partial per-post failures (N2)
    if (failed > 0) {
      const partialResult = await sendSlack(buildPartialFailureMessage({
        pipeline: 'catchup',
        successCount: posted,
        failCount: failed,
        keyStatus: getChocodataStatus(),
        llmKeyStatus: llmKeys.getStatus(),
        groqKeyStatus: getGroqKeyStatus(),
      }));
      if (partialResult.ok) console.log('  ✓ Partial-failure alert sent to Slack');
    }
    console.log(`║  Today total: ${String(finalCount + '/' + DAILY_TARGET).padEnd(46)}║`);
    console.log('╚══════════════════════════════════════════════════════════════╝');

    // End-of-run summary notification (gap filled / today's total)
    const slackResult = await sendSlack(buildCatchupSummary({
      posted,
      todayTotal: finalCount,
      gap,
      keyStatus: getChocodataStatus(),
    }));
    run.setSlackSent(slackResult.ok);

    // Send daily analytics digest
    try {
      await sendAnalyticsDigest();
    } catch (e) {
      console.warn(`  ⚠ Analytics digest failed: ${e.message}`);
    }

    await run.success();

  } catch (err) {
    console.error('\n❌ CATCH-UP FATAL:', err.message);
    const slackResult = await sendSlack(buildFailureMessage({ pipeline: 'catchup', step: 'pipeline', error: err.message, keyStatus: getChocodataStatus(), llmKeyStatus: llmKeys.getStatus(), groqKeyStatus: getGroqKeyStatus() }));
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
