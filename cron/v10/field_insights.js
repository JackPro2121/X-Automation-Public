/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   X-AUTOMATION v10 — FIELD INSIGHTS PIPELINE                     ║
 * ║   cron/v10/field_insights.js                                     ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Editorial topic bank → original take → our own rendered card   ║
 * ║   Output: 1 post per run, 2 runs/day                             ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * The strongest possible originality position for X's Original Content
 * Rewards: no scraped source at all. The text is generated from our own
 * editorial topic (insightTopics.js) and the image is always a card rendered
 * by our own visual factory — never a borrowed asset.
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { postSingleToBuffer } from '../lib/bufferClient.js';
import { isDuplicate, generateId, validateEnv, finalizePostText, insertGeneratedPost } from '../lib/utils.js';
import { createKeyManager } from '../lib/keyManager.js';
import { sendSlack, buildSuccessMessage, buildFailureMessage, buildNoPostsMessage } from '../lib/slackClient.js';
import { startRun } from '../lib/logger.js';
import { initGroqKeys, getGroqKeyStatus, generateTweetWithFallback } from '../lib/groqClient.js';
import { pickTopics, topicDedupUrl } from '../lib/insightTopics.js';
import { resolvePublishImage, closeVisualFactory } from '../lib/visualFactory.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

validateEnv(['VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const llmKeys = createKeyManager('OPENROUTER', [
  process.env.OPENROUTER_API_KEY,
  process.env.OPENROUTER_API_KEY_2,
  process.env.OPENROUTER_API_KEY_3,
]);
const groqKeys = initGroqKeys();

const V10_DAILY_MAX = 2; // 2 runs/day × 1 post
const MAX_CANDIDATES = 3;
const TOPIC_DEDUP_HOURS = 720; // a topic cannot repeat for 30 days

// ─── Daily counter (this pipeline only) ──────────────────────────────────────

async function getTodayV10Count() {
  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const { count, error } = await supabase
      .from('generated_posts')
      .select('*', { count: 'exact', head: true })
      .like('source_url', 'insight://%')
      .in('status', ['published', 'approved', 'posting'])
      .gte('db_created_at', todayStart.toISOString());
    if (error) throw error;
    return count || 0;
  } catch (err) {
    console.warn(`  ⚠ Could not get today's v10 count: ${err.message}`);
    return -1;
  }
}

// ─── Supabase save / status ──────────────────────────────────────────────────

async function savePost(topic, text, status = 'posting', bufferPostId = null, gen = {}) {
  const res = await insertGeneratedPost(supabase, {
    id: generateId('v10'),
    original_post_id: topicDedupUrl(topic),
    creator_handle: 'editorial',
    creator_name: 'Field Insights',
    generated_text: text,
    character_count: text?.length || 0,
    status,
    source_url: topicDedupUrl(topic),
    buffer_post_id: bufferPostId,
  }, gen);
  if (!res.ok) throw new Error(res.error);
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

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  💡  X-AUTOMATION v10 — FIELD INSIGHTS                      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Started : ${new Date().toISOString()}`);
  console.log(`  Buffer  : ${process.env.BUFFER_API_KEY ? '✓' : '✗ (dry run)'}`);
  console.log(`  Groq    : ${groqKeys.totalKeys} key(s) loaded (${groqKeys.availableKeys} available)`);
  console.log(`  LLM     : ${llmKeys.totalKeys} OpenRouter key(s) loaded (${llmKeys.availableKeys} available)`);
  const pipeline = 'v10';
  const run = startRun(pipeline);

  try {
    // 0. Per-pipeline daily budget
    const todayCount = await getTodayV10Count();
    console.log(`  📊 v10 posts today: ${todayCount}/${V10_DAILY_MAX}`);
    if (todayCount >= V10_DAILY_MAX) {
      console.log('  ✅ v10 daily target reached — skipping this run.');
      await run.noPosts(0);
      return;
    }

    // 1. Rotate the topic bank and skip anything posted in the last 30 days
    console.log('\n▶ STEP 1: Picking an editorial topic...');
    const candidates = [];
    for (const topic of pickTopics()) {
      if (candidates.length >= MAX_CANDIDATES) break;
      if (await isDuplicate(supabase, topicDedupUrl(topic), TOPIC_DEDUP_HOURS)) continue;
      candidates.push(topic);
    }

    if (candidates.length === 0) {
      console.log('  ⚠ Every topic in the bank is inside its 30-day cooldown. Exiting.');
      await run.noPosts(1);
      await sendSlack(buildNoPostsMessage({ pipeline, subredditsScanned: 1, llmKeyStatus: llmKeys.getStatus(), groqKeyStatus: getGroqKeyStatus() }));
      return;
    }
    console.log(`  ✓ ${candidates.length} fresh topic(s) available`);

    run.setMimoKeyStatus(llmKeys.getStatus());
    run.setGroqKeyStatus(getGroqKeyStatus());

    // 2. Generate + finalize + publish, trying candidates in order
    let published = false;
    let lastError = null;

    for (const topic of candidates) {
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`  TOPIC [${topic.category}]: ${topic.title}`);
      console.log(`${'═'.repeat(60)}`);

      // Synthesize the post shape generateTweetWithFallback expects. There is no
      // external source — the topic itself is the seed, and the prompt's
      // 'insight' branch tells the writer the post must stand on its own.
      const post = {
        title: topic.title,
        selftext: `Angle: ${topic.angle}`,
        redditUrl: topicDedupUrl(topic),
        imageUrl: null,
        subreddit: 'insights',
        upvotes: 0,
        comments: 0,
        source: 'insight',
      };

      try {
        console.log('\n  ▶ Generating original insight...');
        const result = await generateTweetWithFallback(post, llmKeys, false);
        if (!result?.text) {
          console.warn('  ⚠ Generation failed for this topic — trying next candidate');
          lastError = 'all LLM tiers returned nothing';
          continue;
        }

        // No sourceText: this post IS the original source. The full guard chain
        // (slop, fabricated claims, off-topic, truncation) still runs.
        const finalized = finalizePostText(result.text, { label: 'v10' });
        if (!finalized.ok) {
          console.warn(`  ⚠ Finalize rejected: ${finalized.reason} — trying next candidate`);
          lastError = finalized.reason;
          continue;
        }
        const postText = finalized.text;
        console.log(`  ✓ Finalized (${result.model}): ${postText.substring(0, 80)}...`);

        // Always our own rendered card — fallback 'none' means a failed render
        // degrades to a text-only post, never to a borrowed image.
        const card = await resolvePublishImage({
          sourceTitle: topic.title,
          generatedText: postText,
          eyebrow: topic.category,
          filenamePrefix: 'v10',
          fallback: 'none',
          enabled: true,
        });
        const imageUrl = card.url;

        await savePost(topic, postText, 'posting', null, {
          model: result.model,
          shape: result.shape,
          derivation: result.derivation,
        });

        console.log('  ▶ Posting to X via Buffer...');
        const bufferResult = await postSingleToBuffer(postText, imageUrl);
        await updatePostStatus(
          topicDedupUrl(topic),
          bufferResult.success ? 'published' : 'failed',
          bufferResult.postId || null,
          bufferResult.success ? null : bufferResult.reason
        );

        if (!bufferResult.success) {
          console.error(`  ❌ Buffer failed: ${bufferResult.reason}`);
          lastError = bufferResult.reason;
          continue;
        }

        console.log(`  ✅ PUBLISHED! (Buffer ID: ${bufferResult.postId})`);
        run.setBufferResult(bufferResult.postId);

        const slackResult = await sendSlack(buildSuccessMessage({
          pipeline,
          text: postText,
          subreddit: 'insights',
          upvotes: 0,
          imageUrl,
          redditUrl: topicDedupUrl(topic),
          bufferId: bufferResult.postId,
          elapsed: ((Date.now() - startTime) / 1000).toFixed(1),
          redditTitle: topic.title,
          comments: 0,
          charCount: postText.length,
          llmKeyStatus: llmKeys.getStatus(),
          groqKeyStatus: getGroqKeyStatus(),
          modelUsed: result.model,
          todayCount: await getTodayV10Count(),
        }));
        run.setSlackSent(slackResult.ok);

        run.setPost({
          title: topic.title,
          url: topicDedupUrl(topic),
          upvotes: 0,
          subreddit: topic.category,
          imageUrl,
          generatedText: postText,
        });
        published = true;
        break;
      } catch (err) {
        console.error(`  ❌ Candidate failed: ${err.message}`);
        lastError = err.message;
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('');
    console.log(`  📊 v10 run complete — ${published ? '1 published' : 'nothing published'} · ${elapsed}s`);

    if (published) {
      await run.success();
    } else {
      const err = new Error(`No candidate survived generation/publish. Last: ${lastError || 'unknown'}`);
      const slackResult = await sendSlack(buildFailureMessage({ pipeline, step: 'publish', error: err.message, llmKeyStatus: llmKeys.getStatus(), groqKeyStatus: getGroqKeyStatus() }));
      run.setSlackSent(slackResult.ok);
      await run.fail(err);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('\n❌ PIPELINE FATAL:', err.message);
    const slackResult = await sendSlack(buildFailureMessage({ pipeline, step: 'pipeline', error: err.message, llmKeyStatus: llmKeys.getStatus(), groqKeyStatus: getGroqKeyStatus() }));
    run.setSlackSent(slackResult.ok);
    await run.fail(err);
    process.exitCode = 1;
  } finally {
    await closeVisualFactory();
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
