/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   X-AUTOMATION v9 — GITHUB REPO SPOTLIGHT PIPELINE               ║
 * ║   cron/v9/repo_spotlight.js                                      ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   GitHub Search → curator-style caption → repo screenshot        ║
 * ║   Output: 1 post per run, 3 runs/day                             ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Built for X's Original Content Rewards: the attached image is a screenshot
 * WE captured of the repo page (never a borrowed image), and the caption is a
 * curated take routed through the full finalizePostText() guard chain.
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
import { fetchTrendingRepos, fetchReadmeExcerpt, topicIndexForPostCount } from '../lib/githubClient.js';
import { captureRepoScreenshot, closeRepoScreenshotter } from '../lib/repoScreenshot.js';
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

const V9_DAILY_MAX = 3;
const MAX_CANDIDATES = 3; // try up to 3 repos per run if generation rejects one

// ─── Daily counter (this pipeline only) ──────────────────────────────────────

async function getTodayV9Count() {
  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const { count, error } = await supabase
      .from('generated_posts')
      .select('*', { count: 'exact', head: true })
      .like('source_url', 'https://github.com/%')
      .in('status', ['published', 'approved', 'posting'])
      .gte('db_created_at', todayStart.toISOString());
    if (error) throw error;
    return count || 0;
  } catch (err) {
    console.warn(`  ⚠ Could not get today's v9 count: ${err.message}`);
    console.warn('  🛑 Refusing to publish on an unknown daily count (fail-closed).');
    return V9_DAILY_MAX;
  }
}

// ─── Supabase save / status ──────────────────────────────────────────────────

async function savePost(post, text, status = 'posting', bufferPostId = null, gen = {}) {
  const res = await insertGeneratedPost(supabase, {
    id: generateId('v9'),
    original_post_id: post.redditUrl,
    creator_handle: post.repo?.fullName || 'github',
    creator_name: 'GitHub',
    generated_text: text,
    character_count: text?.length || 0,
    status,
    source_url: post.redditUrl,
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

// ─── Image: our screenshot first, our rendered card as fallback ──────────────

async function resolveRepoImage(post, generatedText) {
  const shot = await captureRepoScreenshot(post.repo.url, {
    filename: `v9-${post.repo.fullName.replace('/', '-')}-${Date.now()}.png`,
  });
  if (shot.ok) {
    console.log('  📸 Repo screenshot captured and hosted');
    return shot.url;
  }

  console.warn(`  ⚠ Screenshot unavailable (${shot.reason}) — rendering our own card instead`);
  const card = await resolvePublishImage({
    sourceTitle: post.title,
    sourceText: post.selftext,
    generatedText,
    eyebrow: 'OPEN SOURCE',
    sourceLabel: 'github.com',
    filenamePrefix: 'v9',
    fallback: 'none',
    enabled: true,
  });
  return card.url; // may be null → text-only post, still fully original
}

async function getLastV9PostAgeMinutes() {
  try {
    const { data, error } = await supabase
      .from('generated_posts')
      .select('db_created_at')
      .like('source_url', 'https://github.com/%')
      .in('status', ['published', 'approved', 'posting'])
      .order('db_created_at', { ascending: false })
      .limit(1);
    if (error || !data || data.length === 0) {
      console.warn('  🛑 Cooldown state unknown (no prior post found or query failed) — refusing to publish (fail-closed).');
      return 0;
    }
    const lastTime = new Date(data[0].db_created_at).getTime();
    return (Date.now() - lastTime) / (60 * 1000);
  } catch (err) {
    console.warn(`  ⚠ Cooldown query threw: ${err.message} — refusing to publish (fail-closed).`);
    return 0;
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  🐙  X-AUTOMATION v9 — GITHUB REPO SPOTLIGHT                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Started : ${new Date().toISOString()}`);
  console.log(`  Buffer  : ${process.env.BUFFER_API_KEY ? '✓' : '✗ (dry run)'}`);
  console.log(`  Groq    : ${groqKeys.totalKeys} key(s) loaded (${groqKeys.availableKeys} available)`);
  console.log(`  LLM     : ${llmKeys.totalKeys} OpenRouter key(s) loaded (${llmKeys.availableKeys} available)`);
  const pipeline = 'v9';
  const run = startRun(pipeline);

  try {
    // 0. Per-pipeline daily budget
    const todayCount = await getTodayV9Count();
    console.log(`  📊 v9 posts today: ${todayCount}/${V9_DAILY_MAX}`);
    if (todayCount >= V9_DAILY_MAX) {
      console.log('  ✅ v9 daily target reached — skipping this run.');
      await run.noPosts(0);
      return;
    }

    // 0b. Minimum spacing / cooldown check (prevents double posting if two runners trigger simultaneously)
    const V9_MIN_GAP_MINUTES = parseInt(process.env.V9_MIN_GAP_MINUTES || '45', 10);
    const lastPostAge = await getLastV9PostAgeMinutes();
    console.log(`  ⏱ Minutes since last v9 post: ${lastPostAge.toFixed(1)}m (min gap: ${V9_MIN_GAP_MINUTES}m)`);
    if (lastPostAge < V9_MIN_GAP_MINUTES) {
      console.log(`  🛡 Cooldown active: Last v9 post was ${lastPostAge.toFixed(1)}m ago (< ${V9_MIN_GAP_MINUTES}m). Skipping to prevent double-posting.`);
      await run.noPosts(0);
      return;
    }

    // 1. Fetch trending repos for the rotating topic
    console.log('\n▶ STEP 1: Fetching trending GitHub repos...');
    // Pin the topic to today's post count so the 3 daily runs each get a
    // different topic. A time-based slot would collapse: cron drift of up to
    // ~3h puts 14/18/21 UTC in the same bucket.
    const topicIndex = topicIndexForPostCount(todayCount);
    const { posts, topic } = await fetchTrendingRepos({ count: 10, topicIndex });
    console.log(`  Topic this slot: ${topic.label}`);

    if (posts.length === 0) {
      console.log('  ⚠ No postable repos found. Exiting.');
      await run.noPosts(1);
      await sendSlack(buildNoPostsMessage({ pipeline, subredditsScanned: 1, llmKeyStatus: llmKeys.getStatus(), groqKeyStatus: getGroqKeyStatus() }));
      return;
    }

    // 2. Dedup — collect up to MAX_CANDIDATES fresh repos
    console.log('\n▶ STEP 2: Dedup check...');
    const candidates = [];
    for (const post of posts) {
      if (candidates.length >= MAX_CANDIDATES) break;
      if (await isDuplicate(supabase, post.redditUrl)) {
        console.log(`  … already posted: ${post.repo.fullName}`);
        continue;
      }
      candidates.push(post);
      console.log(`  ✓ Candidate: ${post.repo.fullName} (★ ${post.repo.starsLabel})`);
    }

    if (candidates.length === 0) {
      console.log('  ⚠ All candidates were already posted. Exiting.');
      await run.noPosts(1);
      await sendSlack(buildNoPostsMessage({ pipeline, subredditsScanned: 1, llmKeyStatus: llmKeys.getStatus(), groqKeyStatus: getGroqKeyStatus() }));
      return;
    }

    run.setMimoKeyStatus(llmKeys.getStatus());
    run.setGroqKeyStatus(getGroqKeyStatus());

    // 3. Generate + finalize + publish, trying candidates in order
    let published = false;
    let lastError = null;

    for (const post of candidates) {
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`  REPO: ${post.repo.fullName} (★ ${post.repo.starsLabel})`);
      console.log(`  ${post.repo.description}`);
      console.log(`${'═'.repeat(60)}`);

      try {
        // README excerpt gives the writer real material beyond the one-line description
        const readme = await fetchReadmeExcerpt(post.repo.fullName);
        if (readme) {
          post.selftext = `${post.selftext}\n\nREADME excerpt: ${readme}`;
          console.log(`  ✓ README excerpt: ${readme.length} chars`);
        }

        console.log('\n  ▶ Generating curator caption...');
        const result = await generateTweetWithFallback(post, llmKeys, false);
        if (!result?.text) {
          console.warn('  ⚠ Generation failed for this repo — trying next candidate');
          lastError = 'all LLM tiers returned nothing';
          continue;
        }

        const fullPostText = result.text.trim();
        const finalized = finalizePostText(fullPostText, {
          sourceText: [post.title, post.selftext].filter(Boolean).join(' '),
          label: 'v9',
        });
        if (!finalized.ok) {
          console.warn(`  ⚠ Finalize rejected: ${finalized.reason} — trying next candidate`);
          lastError = finalized.reason;
          continue;
        }
        const postText = finalized.text;
        console.log(`  ✓ Finalized (${result.model}): ${postText.substring(0, 80)}...`);

        // Image: our screenshot, else our rendered card, else text-only
        const imageUrl = await resolveRepoImage(post, postText);

        // Save → publish → status
        await savePost(post, postText, 'posting', null, {
          model: result.model,
          shape: result.shape,
          derivation: result.derivation,
        });

        console.log('  ▶ Posting to X via Buffer...');
        const bufferResult = await postSingleToBuffer(postText, imageUrl);
        await updatePostStatus(
          post.redditUrl,
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
          subreddit: 'github',
          upvotes: post.repo.stars,
          imageUrl,
          redditUrl: post.repo.url,
          bufferId: bufferResult.postId,
          elapsed: ((Date.now() - startTime) / 1000).toFixed(1),
          redditTitle: post.title,
          comments: 0,
          charCount: postText.length,
          llmKeyStatus: llmKeys.getStatus(),
          groqKeyStatus: getGroqKeyStatus(),
          modelUsed: result.model,
          todayCount: await getTodayV9Count(),
        }));
        run.setSlackSent(slackResult.ok);

        run.setPost({
          title: post.title,
          url: post.redditUrl,
          upvotes: post.repo.stars,
          subreddit: 'github',
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
    console.log(`  📊 v9 run complete — ${published ? '1 published' : 'nothing published'} · ${elapsed}s`);

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
    await closeRepoScreenshotter();
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
