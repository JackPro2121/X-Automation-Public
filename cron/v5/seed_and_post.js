/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   X-AUTOMATION v5 — VIDEO PIPELINE                              ║
 * ║   seed_and_post.js                                               ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Fetches AI-related video posts from Reddit                     ║
 * ║   Generates original takes with MiMo LLM                        ║
 * ║   Posts video tweets to X via Buffer                             ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fetchVideoPosts, generateVideoPost, getApifyKeyStatus, checkApifyBalances } from './video_scraper.js';
import { postVideoToBuffer } from '../lib/bufferClient.js';
import { generateId, validateEnv, stripMarkdown, stripMentions, fixStaleModelNames } from '../lib/utils.js';
import { sendSlack, buildSuccessMessage, buildFailureMessage, buildNoPostsMessage, buildPartialFailureMessage } from '../lib/slackClient.js';
import { startRun } from '../lib/logger.js';
import { createKeyManager } from '../lib/keyManager.js';
import { initGroqKeys, getGroqKeyStatus, generateTweetWithFallback } from '../lib/groqClient.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

validateEnv(['VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const mimoKeys = createKeyManager('MIMO', [
  process.env.MIMO_API_KEY,
  process.env.MIMO_API_KEY_2,
  process.env.MIMO_API_KEY_3,
  process.env.MIMO_API_KEY_4,
]);
const MIMO_MODEL = process.env.MIMO_MODEL || 'mimo-v2.5-pro';
const MIMO_API_URL = process.env.MIMO_API_URL || 'https://api.xiaomimimo.com/v1/chat/completions';
const BUFFER_API_KEY = process.env.BUFFER_API_KEY;

// Initialize Groq Vision keys (primary LLM)
const groqKeys = initGroqKeys();

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

const DAILY_TARGET = 10;
const POSTS_PER_RUN = 2;

async function getTodayVideoPostCount() {
  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const { count, error } = await supabase
      .from('generated_posts')
      .select('*', { count: 'exact', head: true })
      .in('status', ['published', 'posting']) // Count both published and in-progress
      .gte('db_created_at', todayStart.toISOString())
      .like('creator_handle', 'video/%'); // Only count video posts (v5)
    if (error) throw error;
    return count || 0;
  } catch (err) {
    console.warn(`  ⚠ Could not get count: ${err.message}`);
    return -1;
  }
}

async function generateVideoTake(redditPost, depth = 0) {
  if (mimoKeys.totalKeys === 0) {
    return redditPost.title.length > 275 ? redditPost.title.substring(0, 272) + '...' : redditPost.title;
  }

  const today = new Date().toISOString().split('T')[0];
  const prompt = `You are @M_jawad_yasin, an AI Engineering expert on X.

CURRENT DATE: ${today}
LATEST AI MODELS (use ONLY these names):
- OpenAI: GPT-5.6 Sol (Jul 2026)
- Anthropic: Claude Opus 5 (Jul 2026)
- Google: Gemini 3.6 Flash (Jul 2026)
- Meta: Llama 4
- Xiaomi: MiMo v2.5-pro
- Mistral: Mistral Large 3

RULES:
- Write EXACTLY 1 tweet, max 200 characters
- Your tweet MUST be SPECIFICALLY about this video/demo
- Reference the ACTUAL content shown in the video
- Do NOT write generic AI commentary
- Do NOT use old model names
- Mention it's a video/demo in your tweet
- Start with a BOLD, specific claim
- NO hashtags, NO emojis, NO markdown

VIDEO/DEMO POST:
Title: ${redditPost.title}
Subreddit: r/${redditPost.subreddit}
Upvotes: ${redditPost.upvotes}

OUTPUT: Just the tweet text about THIS specific video. Max 200 chars.`;

  try {
    const result = await mimoKeys.execute(async (apiKey) => {
      const res = await fetch(MIMO_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: MIMO_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.78, max_completion_tokens: 300 }),
        signal: AbortSignal.timeout(30000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    });

    let text = result?.choices?.[0]?.message?.content?.trim();
    if (!text) text = redditPost.title;

    text = text.replace(/^["']|["']$/g, '').replace(/#[\w]+/g, '');
    text = stripMarkdown(text);
    text = stripMentions(text);
    text = fixStaleModelNames(text);
    text = text.trim();

    if (text.length > 275) text = text.substring(0, 272) + '...';
    return text;

  } catch (err) {
    console.warn(`  ⚠ MiMo failed: ${err.message}`);
    return redditPost.title.length > 275 ? redditPost.title.substring(0, 272) + '...' : redditPost.title;
  }
}

async function saveVideoPost(post, text, status = 'posting') {
  const { error } = await supabase.from('generated_posts').insert({
    id: generateId('v5'),
    original_post_id: post.sourceUrl,
    creator_handle: `video/r/${post.subreddit}`,
    creator_name: `video/r/${post.subreddit}`,
    generated_text: text,
    status,
    source_url: post.sourceUrl || `https://reddit.com/r/${post.subreddit}`,
    buffer_post_id: null
  });
  if (error) throw error;
  console.log('  ✓ Saved to Supabase');
}

async function updatePostStatus(sourceUrl, status, bufferPostId = null) {
  try {
    const { error } = await supabase.from('generated_posts')
      .update({ status, buffer_post_id: bufferPostId })
      .eq('source_url', sourceUrl)
      .eq('status', 'posting');
    if (error) throw error;
  } catch (err) {
    console.warn(`  ⚠ Status update failed: ${err.message}`);
  }
}

async function main() {
  const startTime = Date.now();

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  🎬  X-AUTOMATION v5 — VIDEO PIPELINE                       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Started : ${new Date().toISOString()}`);
  console.log(`  Buffer  : ${BUFFER_API_KEY ? '✓' : '✗ (dry run)'}`);
  console.log(`  Groq    : ${groqKeys.totalKeys} key(s) loaded`);
  console.log(`  MiMo    : ${mimoKeys.totalKeys} key(s) loaded`);
  console.log(`  Target  : ${POSTS_PER_RUN} video posts this run`);
  console.log('');
  const pipeline = 'v5';
  const run = startRun(pipeline);

  try {
    const todayCount = await getTodayVideoPostCount();
    console.log(`  📊 Today's posts: ${todayCount}/${DAILY_TARGET}`);
    if (todayCount >= DAILY_TARGET) {
      console.log(`  ✅ Daily target reached! Skipping.`);
      await run.noPosts(0);
      return;
    }
    const remaining = DAILY_TARGET - todayCount;
    const postsToMake = Math.min(POSTS_PER_RUN, remaining);
    console.log(`  📈 Need ${remaining} more, will post ${postsToMake}`);

    console.log('\n  💰 Checking Apify balances...');
    await checkApifyBalances();

    console.log('\n▶ STEP 1: Fetching video posts...');
    const videoPosts = await fetchVideoPosts(postsToMake + 2);

    if (videoPosts.length === 0) {
      console.log('  ⚠ No video posts found. Exiting.');
      run.setApifyKeyStatus(getApifyKeyStatus());
      await run.noPosts(2);
      await sendSlack(buildNoPostsMessage({ pipeline, subredditsScanned: 2, keyStatus: getApifyKeyStatus() }));
      return;
    }

    console.log(`\n▶ STEP 2: Processing ${Math.min(postsToMake, videoPosts.length)} video posts...`);
    run.setApifyKeyStatus(getApifyKeyStatus());

    let successCount = 0;
    let failCount = 0;
    const postsToProcess = videoPosts.slice(0, postsToMake);

    for (let i = 0; i < postsToProcess.length; i++) {
      const post = postsToProcess[i];
      const xPost = generateVideoPost(post);

      console.log(`\n${'═'.repeat(60)}`);
      console.log(`  VIDEO ${i + 1}/${postsToProcess.length}: ${post.title.substring(0, 80)}...`);
      console.log(`  r/${post.subreddit} | ⬆ ${post.upvotes} | 🎬 ${xPost.videoUrl ? 'Video' : 'GIF'}`);
      console.log(`${'═'.repeat(60)}`);

      try {
        console.log(`\n  ▶ Generating with Groq Vision...`);
        const { text: postText, model } = await generateTweetWithFallback(post, mimoKeys, true);
        console.log(`  ✓ Generated (${model}): ${postText.substring(0, 80)}...`);

        if (!postText || postText.trim().length === 0) { failCount++; continue; }

        // Record this post in the logger
        run.setPost({
          title: post.title,
          url: xPost.sourceUrl,
          upvotes: post.upvotes,
          subreddit: post.subreddit,
          generatedText: postText,
          imageUrl: xPost.imageUrl,
        });

        console.log(`  ▶ Saving to Supabase...`);
        await saveVideoPost({ ...xPost, text: postText }, 'posting');

        console.log(`  ▶ Posting video to X...`);
        const videoUrl = xPost.videoUrl || xPost.imageUrl;
        const bufferResult = await postVideoToBuffer(postText, videoUrl, xPost.imageUrl);

        await updatePostStatus(xPost.sourceUrl, bufferResult.success ? 'published' : 'failed', bufferResult.postId || null);

        if (bufferResult.success) {
          successCount++;
          console.log(`  ✅ VIDEO POSTED! (${bufferResult.postId})`);

          const slackResult = await sendSlack(buildSuccessMessage({
            pipeline, text: postText, subreddit: post.subreddit, upvotes: post.upvotes,
            imageUrl: xPost.imageUrl, redditUrl: xPost.sourceUrl, bufferId: bufferResult.postId,
            elapsed: ((Date.now() - startTime) / 1000).toFixed(1),
            keyStatus: getApifyKeyStatus(), redditTitle: post.title, comments: post.comments,
            charCount: postText.length, mimoKeyStatus: mimoKeys.getStatus(),
            groqKeyStatus: getGroqKeyStatus(), modelUsed: model,
            todayCount: await getTodayVideoPostCount(),
          }));
          run.setSlackSent(slackResult.ok);
        } else {
          failCount++;
          console.log(`  ❌ Failed: ${bufferResult.reason}`);
        }

        if (i < postsToProcess.length - 1) {
          const delay = Math.floor(Math.random() * 60) + 30;
          console.log(`  ⏳ Waiting ${delay}s...`);
          await new Promise(r => setTimeout(r, delay * 1000));
        }
      } catch (err) {
        failCount++;
        console.error(`  ❌ Failed: ${err.message}`);
      }
    }

    // Alert on partial per-post failures (N2)
    if (failCount > 0) {
      const partialResult = await sendSlack(buildPartialFailureMessage({
        pipeline,
        successCount,
        failCount,
        keyStatus: getApifyKeyStatus(),
        mimoKeyStatus: mimoKeys.getStatus(),
        groqKeyStatus: getGroqKeyStatus(),
      }));
      if (partialResult.ok) console.log('  ✓ Partial-failure alert sent to Slack');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  📊  VIDEO PIPELINE COMPLETE                                 ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Videos : ${String(`${successCount} success, ${failCount} failed`).padEnd(49)}║`);
    console.log(`║  Daily  : ${String(`${await getTodayVideoPostCount()}/${DAILY_TARGET}`).padEnd(49)}║`);
    console.log(`║  Time   : ${String(`${elapsed}s`).padEnd(49)}║`);
    console.log('╚══════════════════════════════════════════════════════════════╝');

    await run.success();

  } catch (err) {
    console.error('\n❌ VIDEO PIPELINE FATAL:', err.message);
    const slackResult = await sendSlack(buildFailureMessage({ pipeline, step: 'pipeline', error: err.message, keyStatus: getApifyKeyStatus(), mimoKeyStatus: mimoKeys.getStatus(), groqKeyStatus: getGroqKeyStatus() }));
    run.setSlackSent(slackResult.ok);
    await run.fail(err);
    process.exitCode = 1;
  }
}

process.on('unhandledRejection', (reason) => { console.error('❌ Unhandled:', reason); process.exitCode = 1; });
main().catch((err) => { console.error('❌ main() failed:', err); process.exitCode = 1; });
