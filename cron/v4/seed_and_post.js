/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   X-AUTOMATION v4 — MAIN PIPELINE                               ║
 * ║   seed_and_post.js                                               ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Fetches AI news from Reddit + RSS feeds                        ║
 * ║   Generates X-optimized posts                                    ║
 * ║   Posts to X via Buffer with images                              ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fetchRedditAINews, generateXPost, getApifyKeyStatus, checkApifyBalances } from './reddit_scraper.js';
import { enrichPostSelftext } from '../lib/chocodataClient.js';
import { postSingleToBuffer, postThreadToBuffer, postToQueue, isMediaWithinLimits } from '../lib/bufferClient.js';
import { generateId, validateEnv, isDuplicate, finalizePostText, finalizeThread, insertGeneratedPost } from '../lib/utils.js';
import { sendSlack, buildSuccessMessage, buildFailureMessage, buildNoPostsMessage, buildPartialFailureMessage } from '../lib/slackClient.js';
import { startRun } from '../lib/logger.js';
import { createKeyManager } from '../lib/keyManager.js';
import { initGroqKeys, getGroqKeyStatus, generateTweetWithFallback, generateThreadFromArticle } from '../lib/groqClient.js';
import { fetchHNStories } from '../lib/hackernews.js';
import { fetchDevToArticles } from '../lib/devto.js';
import { resolvePublishImage, closeVisualFactory } from '../lib/visualFactory.js';

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

// ─── Buffer: Post with Image (delegated to shared module) ─────────────────────
// postToBuffer replaced by bufferClient.postSingleToBuffer

// ─── Supabase: Save Post ──────────────────────────────────────────────────────

async function savePost(post, status = 'posting', bufferPostId = null, gen = {}) {
  const res = await insertGeneratedPost(supabase, {
    id: generateId('v4'), // M8 fix: collision-safe ID
    original_post_id: post.sourceUrl,
    creator_handle: `r/${post.subreddit}`,
    creator_name: `r/${post.subreddit}`,
    generated_text: post.text,
    character_count: post.text?.length || 0,
    status,
    source_url: post.sourceUrl || `https://reddit.com/r/${post.subreddit}`, // C2 fix: never null
    buffer_post_id: bufferPostId
  }, gen);

  if (!res.ok) {
    console.warn(`  ⚠ Supabase save failed: ${res.error}`);
    throw new Error(res.error);
  }
  console.log('  ✓ Saved to Supabase');
}

async function updatePostStatus(sourceUrl, status, bufferPostId = null, errorMessage = null) {
  const payload = { status, buffer_post_id: bufferPostId };
  if (errorMessage) payload.error_message = String(errorMessage).substring(0, 500);
  try {
    let { error } = await supabase.from('generated_posts')
      .update(payload)
      .eq('source_url', sourceUrl)
      .eq('status', 'posting');
    // Best-effort: if error_message column isn't migrated yet, retry without it
    if (error && payload.error_message && /column.*does not exist|could not find the .* column/.test(error.message)) {
      delete payload.error_message;
      ({ error } = await supabase.from('generated_posts')
        .update(payload)
        .eq('source_url', sourceUrl)
        .eq('status', 'posting'));
    }
    if (error) throw error;
    console.log(`  ✓ Updated status to '${status}'`);
  } catch (err) {
    console.warn(`  ⚠ Status update failed: ${err.message}`);
  }
}

// ─── Daily Counter ────────────────────────────────────────────────────────────

const DAILY_TARGET = 16; // Optimized: quality over volume (OCR strategy)
const POSTS_PER_RUN = 2; // v4: 2 runs/day × 2 posts = 4 posts/day

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
    return -1;
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  🤖  X-AUTOMATION v4 — REDDIT AI NEWS PIPELINE              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Started : ${new Date().toISOString()}`);
  console.log(`  Buffer  : ${BUFFER_API_KEY ? '✓' : '✗ (dry run)'}`);
  console.log(`  Groq    : ${groqKeys.totalKeys} key(s) loaded (${groqKeys.availableKeys} available)`);
  console.log(`  OpenRouter    : ${llmKeys.totalKeys} key(s) loaded (${llmKeys.availableKeys} available)`);
  console.log(`  Target  : ${POSTS_PER_RUN} posts this run`);
  console.log('');
  const pipeline = 'v4';
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

    // 0.5 Check Apify key balances (FREE API call)
    console.log('\n  💰 Checking Apify key balances...');
    await checkApifyBalances();

    // 1. Fetch Reddit AI news with images
    console.log('▶ STEP 1: Fetching Reddit AI news...');
    const redditPosts = await fetchRedditAINews(postsToMake + 2); // Fetch extra for dedup buffer

    if (redditPosts.length === 0) {
      console.log('  ⚠ No Reddit posts found. Trying fallback sources...');
      
      // Try Hacker News (FREE)
      const hnPosts = await fetchHNStories(postsToMake + 2);
      if (hnPosts.length > 0) {
        console.log(`  ✓ Fallback: Found ${hnPosts.length} Hacker News posts`);
        redditPosts.push(...hnPosts);
      }
      
      // Try Dev.to (FREE)
      const devtoPosts = await fetchDevToArticles(postsToMake + 2);
      if (devtoPosts.length > 0) {
        console.log(`  ✓ Fallback: Found ${devtoPosts.length} Dev.to articles`);
        redditPosts.push(...devtoPosts);
      }
      
      if (redditPosts.length === 0) {
        console.log('  ⚠ No posts from any source. Exiting.');
        run.setApifyKeyStatus(getApifyKeyStatus());
        await run.noPosts(3);
        await sendSlack(buildNoPostsMessage({ pipeline, subredditsScanned: 3, keyStatus: getApifyKeyStatus(), llmKeyStatus: llmKeys.getStatus(), groqKeyStatus: getGroqKeyStatus() }));
        return;
      }
    }

    // 2. Select multiple posts and process each one
    console.log(`\n▶ STEP 2: Processing ${Math.min(postsToMake, redditPosts.length)} posts...`);
    run.setApifyKeyStatus(getApifyKeyStatus());
    run.setMimoKeyStatus(llmKeys.getStatus()); // column name legacy — now stores OPENROUTER status
    run.setGroqKeyStatus(getGroqKeyStatus());

    let successCount = 0;
    let failCount = 0;

    // Dedup against DB — Reddit posts are deduped inside fetchRedditAINews, but
    // HN/Dev.to fallback posts are not, so filter the combined list here.
    const dedupedPosts = [];
    for (const post of redditPosts) {
      if (!await isDuplicate(supabase, post.redditUrl || post.sourceUrl)) {
        if (post.imageUrl && !(await isMediaWithinLimits(post.imageUrl))) {
          console.log(`  ⚠ Skipping post "${post.title?.substring(0, 40)}..." (media exceeds Buffer limits)`);
          continue;
        }
        dedupedPosts.push(post);
      }
    }
    const postsToProcess = dedupedPosts.slice(0, postsToMake);

    for (let i = 0; i < postsToProcess.length; i++) {
      const bestPost = postsToProcess[i];
      const xPost = generateXPost(bestPost);
      const postNum = `[${i + 1}/${postsToProcess.length}]`;

      console.log(`\n${'═'.repeat(60)}`);
      console.log(`  POST ${postNum}: ${bestPost.title.substring(0, 80)}...`);
      console.log(`  Source: r/${bestPost.subreddit} | ⬆ ${bestPost.upvotes} | Image: ${xPost.imageUrl ? 'Yes' : 'No'}`);
      console.log(`${'═'.repeat(60)}`);

      try {
        // Enrich Reddit post with its selftext body (Chocodata reddit/post, +5 credits).
        // Slim strategy: only posts selected for immediate posting — NOT the excess/queue pool.
        if (bestPost.postId && !bestPost.selftext) {
          await enrichPostSelftext(bestPost);
        }

        // Check if this is a fallback post with full article content (HN/Dev.to)
        const hasFullArticle = (bestPost.source === 'hackernews' || bestPost.source === 'devto') 
                               && bestPost.selftext && bestPost.selftext.length > 200;

        let postText = '';
        let model = '';
        // Shape + derivation mode are sampled inside buildTweetPrompt(); read them
        // off the client rather than threading them through every tier.
        let shape = null;
        let derivation = null;
        let isThread = false;
        let threadTweets = [];

        if (hasFullArticle) {
          // Try to generate thread from full article content
          console.log(`\n  ▶ Generating thread from article...`);
          const threadResult = await generateThreadFromArticle(bestPost, llmKeys);
          
          if (threadResult && threadResult.tweets.length >= 2) {
            isThread = true;
            threadTweets = threadResult.tweets;
            postText = threadTweets[0];
            model = threadResult.model;
            console.log(`  ✓ Generated ${threadTweets.length}-tweet thread (${model})`);
          } else {
            console.log(`  ⚠ Thread failed, using single tweet...`);
            const result = await generateTweetWithFallback(bestPost, llmKeys, false);
            postText = result?.text || null;
            model = result?.model || 'none';
            shape = result?.shape || null;
            derivation = result?.derivation || null;
          }
        } else {
          // Single tweet (Reddit posts)
          console.log(`\n  ▶ Generating with Groq Vision...`);
          const result = await generateTweetWithFallback(bestPost, llmKeys, false);
          postText = result?.text || null;
          model = result?.model || 'none';
          shape = result?.shape || null;
          derivation = result?.derivation || null;
        }

        console.log(`  ✓ Generated (${model}): ${(postText || '').substring(0, 80)}...`);

        // Validate
        if (!postText || postText.trim().length === 0 || postText.trim() === '.') {
          console.log('  ⚠ Empty text or non-English — skipping');
          failCount++;
          continue;
        }

        // ── Finalize ─────────────────────────────────────────────────────────
        // Trim to the safe cap, then re-run the full guard chain on the EXACT
        // string that will be published, so the DB row matches the live post.
        // See AUDIT_2026-09-15.md §1.
        const sourceText = [bestPost.title, bestPost.selftext].filter(Boolean).join(' ');
        if (isThread && threadTweets.length >= 2) {
          const finalizedTweets = [];
          let threadOk = true;
          for (const tweet of threadTweets) {
            // Per-tweet: structural/quality guards only. Originality is judged on
            // the JOINED thread below. This path previously had no
            // source-similarity guard at all — see finalizeThread() in utils.js.
            const res = finalizePostText(tweet, {
              label: 'v4 thread tweet',
              minChars: 60,
              checkOriginality: false,
            });
            if (!res.ok) {
              console.warn(`  ⚠ Thread rejected — tweet ${finalizedTweets.length + 1}: ${res.reason}`);
              threadOk = false;
              break;
            }
            finalizedTweets.push(res.text);
          }
          if (threadOk) {
            const threadRes = finalizeThread(finalizedTweets, { sourceText, label: 'v4 thread' });
            if (!threadRes.ok) {
              console.warn(`  ⚠ Thread rejected: ${threadRes.reason}`);
              threadOk = false;
            }
          }
          if (!threadOk) {
            failCount++;
            continue;
          }
          threadTweets = finalizedTweets;
          postText = threadTweets[0];
        } else {
          const res = finalizePostText(postText, { sourceText, label: 'v4 single' });
          if (!res.ok) {
            console.log(`  ⚠ Finalize rejected: ${res.reason} — skipping`);
            failCount++;
            continue;
          }
          postText = res.text;
        }

        // Save to Supabase
        console.log(`  ▶ Saving to Supabase...`);
        const textToSave = isThread ? threadTweets.join('\n\n') : postText;
        bestPost._generatedText = textToSave;
        await savePost({ ...xPost, text: textToSave }, 'posting', null, { model, shape, derivation });

        // ── Original visual (Path 1 — own the media) ─────────────────────────
        // Render our own card instead of attaching the source author's image.
        // See lib/visualFactory.js `resolvePublishImage` — one shared policy for
        // v3/v4/v6, rather than each pipeline re-implementing it.
        //
        // SOURCE TITLE, NOT THE GENERATED TEXT. `generateXPost()` returns the
        // cleaned Reddit title as `text` (there is no `title` field on xPost).
        // Passing the *generated* text here would make the card a re-typeset copy
        // of the caption — headline and first point identical — instead of a card
        // that adds the source framing the caption left out. Verified against the
        // real return shape, not assumed.
        const publishImageUrl = (await resolvePublishImage({
          sourceTitle: xPost.text || bestPost.title || '',
          sourceText: bestPost.selftext || '',
          generatedText: textToSave,
          sourceImageUrl: xPost.imageUrl,
          eyebrow: 'AI ENGINEERING',
          sourceLabel: xPost.subreddit ? `r/${xPost.subreddit}` : undefined,
          filenamePrefix: 'v4',
        })).url;

        // Post to Buffer
        console.log(`  ▶ Posting to X via Buffer...`);
        let bufferResult;
        if (isThread && threadTweets.length >= 2) {
          bufferResult = await postThreadToBuffer(threadTweets, publishImageUrl);
        } else {
          bufferResult = await postSingleToBuffer(postText, publishImageUrl);
        }

        // Update status
        await updatePostStatus(
          xPost.sourceUrl,
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
            subreddit: bestPost.subreddit,
            upvotes: bestPost.upvotes,
            imageUrl: xPost.imageUrl,
            redditUrl: xPost.sourceUrl,
            bufferId: bufferResult.postId,
            elapsed: ((Date.now() - startTime) / 1000).toFixed(1),
            keyStatus: getApifyKeyStatus(),
            redditTitle: bestPost.title,
            comments: bestPost.comments,
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
        if (i < postsToProcess.length - 1) {
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
    let queuedCount = 0;
    const currentTotal = await getTodayPostCount();
    const maxExcess = Math.min(2, Math.max(0, DAILY_TARGET - currentTotal)); // Reduced from 3 to 2 (Buffer limit: 10 scheduled,4 slots/day)
    console.log(`\n▶ QUEUING excess quality posts to Buffer...`);

    for (const post of redditPosts) {
      if (queuedCount >= maxExcess) break;
      // Skip posts already processed
      if (postsToProcess.some(sp => sp.sourceUrl === post.sourceUrl || sp.redditUrl === post.redditUrl)) continue;
      // Skip posts already published/queued in earlier runs
      if (await isDuplicate(supabase, post.redditUrl || post.sourceUrl)) continue;
      if (post.imageUrl && !(await isMediaWithinLimits(post.imageUrl))) continue;

      try {
        const xPost = { sourceUrl: post.sourceUrl || post.redditUrl, subreddit: post.subreddit, imageUrl: post.imageUrl };
        const result = await generateTweetWithFallback(post, llmKeys, false);
        const minLen = process.env.X_PREMIUM === 'true' ? 160 : 100;
        // Finalize before queueing so the queued text and the DB row match.
        const finalized = result?.text
          ? finalizePostText(result.text, {
              sourceText: [post.title, post.selftext].filter(Boolean).join(' '),
              label: 'v4 queued',
              minChars: minLen,
            })
          : { ok: false, text: null, reason: 'no text generated' };

        if (finalized.ok) {
          // Same original-visual treatment as the live path above. `post` here is
          // the raw scraped record, so `post.title` is the source title.
          const queueImageUrl = (await resolvePublishImage({
            sourceTitle: post.title || '',
            sourceText: post.selftext || '',
            generatedText: finalized.text,
            sourceImageUrl: xPost.imageUrl,
            eyebrow: 'AI ENGINEERING',
            sourceLabel: post.subreddit ? `r/${post.subreddit}` : undefined,
            filenamePrefix: 'v4q',
          })).url;

          const queueResult = await postToQueue(finalized.text, queueImageUrl);
          if (queueResult.success) {
            await savePost({ ...xPost, text: finalized.text }, 'approved', queueResult.postId, {
              model: result?.model,
              shape: result?.shape,
              derivation: result?.derivation,
            });
            queuedCount++;
            console.log(`  ✅ Queued: ${post.title.substring(0, 50)}...`);
          }
        } else {
          console.log(`  ⚠ Queue skipped — ${finalized.reason}`);
        }
      } catch (err) {
        console.warn(`  ⚠ Queue failed: ${err.message}`);
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
        keyStatus: getApifyKeyStatus(),
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
    console.log(`║  Subreddits     : ${String([...new Set(postsToProcess.map(p => 'r/' + p.subreddit))].join(', ')).padEnd(41)}║`);
    console.log(`║  Elapsed        : ${String(elapsed + 's').padEnd(41)}║`);
    console.log('╚══════════════════════════════════════════════════════════════╝');

    // Log last post details
    const lastPost = postsToProcess[postsToProcess.length - 1];
    const lastXPost = generateXPost(lastPost);
    run.setPost({
      title: lastPost.title,
      url: lastXPost.sourceUrl,
      upvotes: lastPost.upvotes,
      subreddit: lastPost.subreddit,
      imageUrl: lastXPost.imageUrl,
      generatedText: lastPost._generatedText || null,
    });

    // Complete logging
    await run.success();

  } catch (err) {
    console.error('\n❌ PIPELINE FATAL:', err.message);
    console.error(err.stack);
    const slackResult = await sendSlack(buildFailureMessage({ pipeline, step: 'pipeline', error: err.message, keyStatus: getApifyKeyStatus(), llmKeyStatus: llmKeys.getStatus(), groqKeyStatus: getGroqKeyStatus() }));
    run.setSlackSent(slackResult.ok);
    await run.fail(err);
    process.exitCode = 1;
  } finally {
    // resolvePublishImage() uses a shared Playwright browser. Leaving it open
    // keeps Node alive until GitHub Actions kills the job at its timeout.
    await closeVisualFactory();
  }
}

// Global error handler
process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Promise Rejection:', reason);
  process.exitCode = 1;
});

main().catch((err) => {
  console.error('❌ main() failed:', err);
  process.exitCode = 1;
});
