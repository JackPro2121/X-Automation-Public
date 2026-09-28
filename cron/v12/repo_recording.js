/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   X-AUTOMATION v12 — GITHUB SCREEN-RECORDING POSTS              ║
 * ║   cron/v12/repo_recording.js                                      ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Films a real GitHub repository page in headless Chromium and    ║
 * ║   publishes the recording, instead of a static screenshot card.    ║
 * ║   Output: 1 post per run, caption written by the proven v9 chain. ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * WHY THIS IS A SEPARATE PIPELINE AND NOT A v9 FLAG
 *
 * v9 is the account's only healthy, revenue-generating path: 3 posts/day,
 * every run green for two weeks, complete telemetry. A screen-recording
 * format is a different bet on the same inventory — it costs ~40s more per
 * run, depends on a binary the runner does not ship, and produces a
 * fundamentally different asset. Coupling it to v9 would mean a video
 * regression could take down the pipeline that is currently earning.
 *
 * Separate pipeline means: separate run log, separate failure, separate
 * metrics bucket, and a schedule that can stay off until the format is proven.
 *
 * ORIGINALITY POSITION
 *
 * The asset is a capture of the real repository page, produced by our own
 * renderer on our own infrastructure. Nothing is borrowed. This is the
 * strongest available position for X's Original Content Rewards, and it is
 * strictly better than v9's rendered card, which depicts the repo rather
 * than being it.
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'node:fs';

import { postVideoToBuffer } from '../lib/bufferClient.js';
import { uploadVisual } from '../lib/visualFactory.js';
import { isDuplicate, generateId, validateEnv, finalizePostText, insertGeneratedPost } from '../lib/utils.js';
import { createKeyManager } from '../lib/keyManager.js';
import { sendSlack, buildSuccessMessage, buildFailureMessage, buildNoPostsMessage } from '../lib/slackClient.js';
import { startRun } from '../lib/logger.js';
import { initGroqKeys, getGroqKeyStatus, generateTweetWithFallback } from '../lib/groqClient.js';
import { fetchTrendingRepos, fetchReadmeExcerpt, topicIndexForPostCount } from '../lib/githubClient.js';
import { recordRepoWalkthrough, closeRepoRecorder, cleanupWorkDir, CSS_VIEWPORT } from '../lib/repoRecorder.js';
import { transcodeToMp4, assertFfmpegAvailable, VIDEO_MIME, frameGeometry } from '../lib/videoEncoder.js';
import { renderFrameOverlay, pickBackdrop } from '../lib/frameRenderer.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

validateEnv(['VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const llmKeys = createKeyManager('OPENROUTER', [
  process.env.OPENROUTER_API_KEY,
  process.env.OPENROUTER_API_KEY_2,
  process.env.OPENROUTER_API_KEY_3,
]);
const groqKeys = initGroqKeys();

const V12_DAILY_MAX = parseInt(process.env.V12_DAILY_MAX || '1', 10);
const MAX_CANDIDATES = 2;
const V12_MIN_GAP_MINUTES = parseInt(process.env.V12_MIN_GAP_MINUTES || '90', 10);

/**
 * Storage key. Deliberately NOT the bare github.com URL that v9 uses.
 *
 * `buffer_metrics_collector.pipelineForPost()` classifies a post by its
 * source_url prefix: `https://github.com/` maps to v9. Reusing that prefix
 * here would file every screen recording under v9 in the metrics report and
 * make the two formats impossible to compare — which is the entire reason for
 * building v12. The prefix is also what makes `isDuplicate` treat v12 rows as
 * its own history.
 */
const V12_SOURCE_PREFIX = 'v12://github/';

function sourceKeyFor(post) {
  return `${V12_SOURCE_PREFIX}${post.repo.fullName}`;
}

// ─── Supabase helpers ────────────────────────────────────────────────────────

async function getTodayV12Count() {
  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const { count, error } = await supabase
      .from('generated_posts')
      .select('*', { count: 'exact', head: true })
      .like('source_url', `${V12_SOURCE_PREFIX}%`)
      .in('status', ['published', 'approved', 'posting'])
      .gte('db_created_at', todayStart.toISOString());
    if (error) throw error;
    return count || 0;
  } catch (err) {
    // Fail CLOSED. An unknown daily count must not become permission to post.
    console.warn(`  ⚠ Could not get today's v12 count: ${err.message}`);
    console.warn('  🛑 Refusing to publish on an unknown daily count (fail-closed).');
    return V12_DAILY_MAX;
  }
}

async function getLastV12PostAgeMinutes() {
  try {
    const { data, error } = await supabase
      .from('generated_posts')
      .select('db_created_at')
      .like('source_url', `${V12_SOURCE_PREFIX}%`)
      .in('status', ['published', 'approved', 'posting'])
      .order('db_created_at', { ascending: false })
      .limit(1);

    if (!error && data && data.length === 0) {
      // Nothing published yet is not a failure — the cooldown has not started.
      // Returning 0 here would make the first-ever post permanently
      // unpublishable, because 0 is always below the minimum gap.
      return Number.POSITIVE_INFINITY;
    }
    if (error) {
      console.warn('  🛑 Cooldown state unknown (query failed) — refusing to publish (fail-closed).');
      return 0;
    }
    return (Date.now() - new Date(data[0].db_created_at).getTime()) / (60 * 1000);
  } catch (err) {
    console.warn(`  ⚠ Cooldown query threw: ${err.message} — refusing to publish (fail-closed).`);
    return 0;
  }
}

async function savePost(post, text, bufferPostId, gen = {}) {
  const res = await insertGeneratedPost(supabase, {
    id: generateId('v12'),
    original_post_id: post.redditUrl,
    creator_handle: 'M_jawad_yasin',
    creator_name: 'Repo Recording',
    generated_text: text,
    character_count: text?.length || 0,
    status: 'posting',
    source_url: sourceKeyFor(post),
    buffer_post_id: bufferPostId,
  }, gen);
  if (!res.ok) throw new Error(res.error);
  console.log('  ✓ Saved to Supabase');
}

async function updatePostStatus(post, status, bufferPostId = null, errorMessage = null) {
  const payload = { status, buffer_post_id: bufferPostId };
  if (errorMessage) payload.error_message = String(errorMessage).substring(0, 500);
  try {
    let { error } = await supabase
      .from('generated_posts')
      .update(payload)
      .eq('source_url', sourceKeyFor(post))
      .eq('status', 'posting');
    if (error && payload.error_message && /column.*does not exist|could not find the .* column/.test(error.message)) {
      delete payload.error_message;
      ({ error } = await supabase
        .from('generated_posts')
        .update(payload)
        .eq('source_url', sourceKeyFor(post))
        .eq('status', 'posting'));
    }
    if (error) throw error;
    console.log(`  ✓ Updated status to '${status}'`);
  } catch (err) {
    console.warn(`  ⚠ Status update failed: ${err.message}`);
  }
}

/**
 * Film → encode → validate → host. Returns a public URL or a reason.
 * Never throws; every stage has an explicit failure message.
 */
async function produceVideo(post) {
  const ffmpeg = await assertFfmpegAvailable();
  if (!ffmpeg.ok) return { ok: false, reason: ffmpeg.reason };
  console.log(`  🎞 ffmpeg: ${ffmpeg.version}`);

  console.log('\n  ▶ STEP A: Recording the repo page...');
  const rec = await recordRepoWalkthrough(post.redditUrl);
  if (!rec.ok) return { ok: false, reason: rec.reason };
  console.log(`    ✓ filmed ${rec.contentSec}s of content (page load ${(rec.loadMs / 1000).toFixed(1)}s trimmed)`);
  console.log(`    beats: ${(rec.beats || []).join(' → ') || 'none'}`);
  if (rec.selectionSkipped) {
    console.log('    ⚠ text-selection beat skipped (no About block found) — shipping without it');
  } else {
    console.log(`    ✓ selection sweep: ${rec.selectedChars} chars via ${rec.selectionSource}`);
  }

  try {
    // The macOS-style frame. The recorder measured the on-screen content width
    // at every beat, so the capture is CROPPED to the content — a pure
    // integer-pixel cut — and the crop is composited 1:1 into the window. No
    // resampling kernel touches a glyph at any point.
    const crop = rec.cropBox || { x: 0, y: 0, w: CSS_VIEWPORT.width, h: CSS_VIEWPORT.height };
    const geometry = frameGeometry({
      sourceWidth: CSS_VIEWPORT.width,
      sourceHeight: CSS_VIEWPORT.height,
      cropX: crop.x,
      cropW: crop.w,
      cropH: crop.h,
    });
    const backdrop = pickBackdrop();
    let overlayPath = null;
    let overlayA = null;
    let overlayB = null;
    const frameOn = process.env.V12_FRAME !== 'off';

    // Two segments means the video genuinely contains two layouts, so each gets
    // its own window and its own crop. One segment means a single window, which
    // is every repo that does not have the landing/README split.
    const segs = rec.segments;
    if (frameOn && segs && segs.length === 2) {
      const geoms = segs.map((s) => frameGeometry({
        sourceWidth: CSS_VIEWPORT.width,
        sourceHeight: CSS_VIEWPORT.height,
        cropX: s.crop.x, cropW: s.crop.w, cropH: s.crop.h,
      }));
      const rendered = [];
      for (let i = 0; i < segs.length; i++) {
        const r = await renderFrameOverlay(path.join(rec.workDir, `frame_${i}.png`), {
          title: post.repo.fullName, geometry: geoms[i], backdrop,
        });
        if (!r.ok) {
          console.warn(`    ⚠ segment ${segs[i].name} frame failed (${r.reason}) — using one window for the whole clip`);
          break;
        }
        rendered.push(r.path);
      }
      if (rendered.length === 2) {
        overlayA = rendered[0];
        overlayB = rendered[1];
        console.log(
          `    ✓ frame (2 segments): ${backdrop.label} backdrop\n` +
          `      1. ${segs[0].name.padEnd(7)} 0-${segs[0].endSec.toFixed(1)}s  ` +
          `window ${geoms[0].winW}x${geoms[0].winH}  crop ${segs[0].crop.w}px at x=${segs[0].crop.x}` +
          (segs[0].crop.cropped ? '' : ' (full width)') + '\n' +
          `      2. ${segs[1].name.padEnd(7)} ${segs[1].endSec ? `${segs[1].startSec.toFixed(1)}-${segs[1].endSec.toFixed(1)}s` : 'to end'}  ` +
          `window ${geoms[1].winW}x${geoms[1].winH}  crop ${segs[1].crop.w}px at x=${segs[1].crop.x}` +
          (segs[1].crop.cropped
            ? ` — ${Math.round((segs[1].crop.w / CSS_VIEWPORT.width) * 100)}% kept, void removed`
            : ' (full width)')
        );
      }
    }

    if (frameOn && !overlayA) {
      const framed = await renderFrameOverlay(path.join(rec.workDir, 'frame.png'), {
        title: post.repo.fullName, geometry, backdrop,
      });
      if (framed.ok) {
        overlayPath = framed.path;
        console.log(
          `    ✓ frame: ${backdrop.label} backdrop, window ${geometry.winW}x${geometry.winH}, ` +
          `page ${geometry.pageW}x${geometry.pageH} at ${(geometry.pageScale * 100).toFixed(0)}%` +
          (geometry.native ? ' — native 1:1, no resample' : ' — downscale only')
        );
        console.log(
          crop.cropped
            ? `    ✓ content crop: ${crop.w}x${crop.h} at x=${crop.x} of ${CSS_VIEWPORT.width} ` +
              `(${Math.round((crop.w / CSS_VIEWPORT.width) * 100)}% of the capture kept)`
            : `    ✓ content crop: none — content spans the full ${CSS_VIEWPORT.width}px capture`
        );
      } else {
        console.warn(`    ⚠ frame unavailable (${framed.reason}) — falling back to a bare page recording`);
      }
    }

    console.log('\n  ▶ STEP B: Transcoding to H.264...');
    const mp4Path = `${rec.webmPath.replace(/\.webm$/i, '')}.mp4`;
    // CRF 20 rather than 24 for the framed path: the page is now a smaller
    // region of a larger frame, so re-encoding artefacts are proportionally
    // more visible on the text that matters.
    const enc = await transcodeToMp4({
      input: rec.webmPath,
      output: mp4Path,
      overlay: overlayPath,
      trimStartSec: rec.trimStartSec,
      maxDurationSec: 120,
      crf: (overlayPath || overlayA) ? 20 : 24,
      zoom: false,
      cropX: crop.x,
      cropW: crop.w,
      cropH: crop.h,
      // The two-segment switch is expressed in the OUTPUT timeline, so it must
      // be shifted by the same trim the page gets. Without this the switch fires
      // `trimStartSec` too late and the landing window is still on screen for
      // several seconds after the walkthrough has begun — the exact artefact
      // this work exists to remove.
      segments: (overlayA && rec.segments)
        ? rec.segments.map((s) => ({
            startSec: Math.max(0, s.startSec - rec.trimStartSec),
            endSec: Number.isFinite(s.endSec) ? s.endSec - rec.trimStartSec : Infinity,
            crop: s.crop,
          }))
        : null,
      overlayA,
      overlayB,
    });
    if (!enc.ok) return { ok: false, reason: enc.reason };
    const s = enc.specs;
    console.log(`    ✓ ${s.width}x${s.height} ${s.codec}/${s.profile} ${s.duration.toFixed(1)}s ${s.mb.toFixed(2)}MB @${s.fps}fps`);

    console.log('\n  ▶ STEP C: Hosting...');
    const uploaded = await uploadVisual(
      fs.readFileSync(mp4Path),
      `v12-${post.repo.fullName.replace('/', '-')}-${Date.now()}.mp4`,
      { contentType: VIDEO_MIME, folder: 'videos', timeoutMs: 120000 }
    );
    if (!uploaded.ok) return { ok: false, reason: uploaded.reason };

    return { ok: true, url: uploaded.url, specs: s, beats: rec.beats, loadMs: rec.loadMs };
  } finally {
    cleanupWorkDir(rec.workDir);
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  🎬  X-AUTOMATION v12 — GITHUB SCREEN RECORDING               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Started : ${new Date().toISOString()}`);
  console.log(`  Buffer  : ${process.env.BUFFER_API_KEY ? '✓' : '✗ (dry run)'}`);
  console.log(`  Groq    : ${groqKeys.totalKeys} key(s) loaded (${groqKeys.availableKeys} available)`);
  console.log(`  LLM     : ${llmKeys.totalKeys} OpenRouter key(s) loaded (${llmKeys.availableKeys} available)`);
  const pipeline = 'v12';
  const run = startRun(pipeline);

  try {
    // 0. Budget + spacing
    const todayCount = await getTodayV12Count();
    console.log(`  📊 v12 posts today: ${todayCount}/${V12_DAILY_MAX}`);
    if (todayCount >= V12_DAILY_MAX) {
      console.log('  ✅ v12 daily target reached — skipping this run.');
      await run.noPosts(0);
      return;
    }

    const lastPostAge = await getLastV12PostAgeMinutes();
    const ageLabel = Number.isFinite(lastPostAge) ? `${lastPostAge.toFixed(1)}m` : 'never';
    console.log(`  ⏱ Minutes since last v12 post: ${ageLabel} (min gap: ${V12_MIN_GAP_MINUTES}m)`);
    if (lastPostAge < V12_MIN_GAP_MINUTES) {
      console.log(`  🛡 Cooldown active: last v12 post was ${ageLabel} ago (< ${V12_MIN_GAP_MINUTES}m). Skipping.`);
      await run.noPosts(0);
      return;
    }

    // 1. Repos
    console.log('\n▶ STEP 1: Fetching trending GitHub repos...');
    const topicIndex = topicIndexForPostCount(todayCount);
    const { posts, topic } = await fetchTrendingRepos({ count: 10, topicIndex });
    console.log(`  Topic this slot: ${topic?.label}`);
    if (!posts.length) {
      await run.noPosts(1);
      await sendSlack(buildNoPostsMessage({ pipeline, subredditsScanned: 1, llmKeyStatus: llmKeys.getStatus(), groqKeyStatus: getGroqKeyStatus() }));
      return;
    }

    // 2. Dedup against BOTH v12's own history and v9's. Showing the same repo
    //    twice on one account in a day is a quality problem regardless of which
    //    pipeline produced it.
    console.log('\n▶ STEP 2: Dedup check...');
    const candidates = [];
    for (const post of posts) {
      if (candidates.length >= MAX_CANDIDATES) break;
      if (await isDuplicate(supabase, sourceKeyFor(post))) {
        console.log(`  … already posted by v12: ${post.repo.fullName}`);
        continue;
      }
      if (await isDuplicate(supabase, post.redditUrl)) {
        console.log(`  … already posted by v9: ${post.repo.fullName}`);
        continue;
      }
      candidates.push(post);
      console.log(`  ✓ Candidate: ${post.repo.fullName} (★ ${post.repo.starsLabel})`);
    }
    if (!candidates.length) {
      console.log('  ⚠ All candidates already posted. Exiting.');
      await run.noPosts(1);
      await sendSlack(buildNoPostsMessage({ pipeline, subredditsScanned: 1, llmKeyStatus: llmKeys.getStatus(), groqKeyStatus: getGroqKeyStatus() }));
      return;
    }

    run.setMimoKeyStatus(llmKeys.getStatus());
    run.setGroqKeyStatus(getGroqKeyStatus());

    // 3. Per candidate: caption → film → publish
    let published = false;
    let lastError = null;

    for (const post of candidates) {
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`  REPO: ${post.repo.fullName} (★ ${post.repo.starsLabel})`);
      console.log(`  ${post.repo.description}`);
      console.log(`${'═'.repeat(60)}`);

      let video = null;
      try {
        // Caption first: it is the cheap step, and a repo whose caption is
        // rejected should never cost a 40-second recording.
        console.log('\n  ▶ Generating curator caption...');
        const readme = await fetchReadmeExcerpt(post.repo.fullName);
        if (readme) {
          post.readmeExcerpt = readme;
          console.log(`  ✓ README excerpt: ${readme.length} chars`);
        }

        const result = await generateTweetWithFallback(post, llmKeys, false);
        if (!result?.text) {
          lastError = 'all LLM tiers returned nothing';
          console.warn(`  ⚠ Generation failed — trying next candidate`);
          continue;
        }
        const finalized = finalizePostText(result.text, {
          sourceText: [post.title, post.selftext].filter(Boolean).join(' '),
          label: 'v12',
        });
        if (!finalized.ok) {
          lastError = finalized.reason;
          console.warn(`  ⚠ Finalize rejected: ${finalized.reason} — trying next candidate`);
          continue;
        }
        const postText = finalized.text;
        console.log(`  ✓ Finalized (${result.model}): ${postText.substring(0, 80)}...`);

        // Media. A failure here is fatal to this candidate, NOT to the run:
        // publishing the caption as a text-only post from a pipeline named
        // "recording" would silently corrupt the very comparison this
        // pipeline exists to produce.
        video = await produceVideo(post);
        if (!video.ok) {
          lastError = video.reason;
          console.error(`  ❌ Video production failed: ${video.reason}`);
          continue;
        }
        console.log(`  ✓ Video ready: ${video.url}`);

        await savePost(post, postText, null, {
          model: result.model,
          shape: result.shape,
          derivation: result.derivation,
        });

        console.log('\n  ▶ Posting to X via Buffer...');
        // QUEUE, NOT PUBLISH. A screen recording is a new format on a live
        // monetised account, so the first runs go into Buffer's own queue where
        // a human can watch the video, check the caption and the first frame,
        // and only then let Buffer's scheduler release it. Set
        // V12_PUBLISH_MODE=shareNow only once the format is trusted.
        const publishMode = process.env.V12_PUBLISH_MODE === 'shareNow' ? 'shareNow' : 'addToQueue';
        const bufferResult = await postVideoToBuffer(postText, video.url, null, { mode: publishMode });
        console.log(`  ℹ Buffer mode: ${publishMode}${publishMode === 'addToQueue' ? ' (review in the Buffer web UI before it publishes)' : ' (publishing immediately)'}`);

        // Record the state honestly. Buffer ACCEPTED the post either way, but in
        // queue mode nothing has gone to X yet, and "published" in the database
        // would tell an operator the recording is live when it is still awaiting
        // review. `approved` is the codebase's existing "Buffer has it, not yet
        // public" state, and both the daily counter and the metrics collector
        // already treat it as in-flight rather than live.
        const finalStatus = publishMode === 'addToQueue' ? 'approved' : 'published';
        await updatePostStatus(
          post,
          bufferResult.success ? finalStatus : 'failed',
          bufferResult.postId || null,
          bufferResult.success ? null : bufferResult.reason
        );
        if (!bufferResult.success) {
          lastError = bufferResult.reason;
          console.error(`  ❌ Buffer failed: ${bufferResult.reason}`);
          continue;
        }

        console.log(
          publishMode === 'addToQueue'
            ? `  ✅ QUEUED in Buffer (ID: ${bufferResult.postId}) — awaiting review, not yet on X`
            : `  ✅ PUBLISHED! (Buffer ID: ${bufferResult.postId})`
        );
        run.setBufferResult(bufferResult.postId);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const slackResult = await sendSlack(buildSuccessMessage({
          pipeline,
          text: postText,
          subreddit: 'github',
          upvotes: 0,
          imageUrl: null,
          redditUrl: post.redditUrl,
          bufferId: bufferResult.postId,
          elapsed,
          redditTitle: post.repo.fullName,
          comments: 0,
          charCount: postText.length,
          llmKeyStatus: llmKeys.getStatus(),
          groqKeyStatus: getGroqKeyStatus(),
          modelUsed: result.model,
          todayCount: await getTodayV12Count(),
        }));
        run.setSlackSent(slackResult.ok);
        run.setPost({
          title: post.repo.fullName,
          url: post.redditUrl,
          upvotes: 0,
          subreddit: 'github-video',
          imageUrl: video.url,
          generatedText: postText,
        });
        published = true;
        break;
      } catch (err) {
        lastError = err.message;
        console.error(`  ❌ Candidate failed: ${err.message}`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    // Report the real outcome. `published` here means "handed to Buffer", which
    // in the default queue mode is not the same thing as being live on X — the
    // summary line must not say otherwise, or an operator reading the log is
    // told the recording went out when it is still awaiting review.
    const queueMode = process.env.V12_PUBLISH_MODE !== 'shareNow';
    const outcome = !published
      ? 'nothing produced'
      : queueMode
        ? '1 queued in Buffer (not yet on X)'
        : '1 published';
    console.log(`\n  📊 v12 run complete — ${outcome} · ${elapsed}s`);

    if (published) {
      await run.success();
    } else {
      const err = new Error(`No candidate produced a published recording. Last: ${lastError || 'unknown'}`);
      const slackResult = await sendSlack(buildFailureMessage({ pipeline, step: 'publish', error: err.message, llmKeyStatus: llmKeys.getStatus(), groqKeyStatus: getGroqKeyStatus() }));
      run.setSlackSent(slackResult.ok);
      await run.fail(err);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('\n❌ v12 PIPELINE FATAL:', err.message);
    const slackResult = await sendSlack(buildFailureMessage({ pipeline, step: 'pipeline', error: err.message, llmKeyStatus: llmKeys.getStatus(), groqKeyStatus: getGroqKeyStatus() }));
    run.setSlackSent(slackResult.ok);
    await run.fail(err);
    process.exitCode = 1;
  } finally {
    await closeRepoRecorder();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('❌ main() failed:', err);
    process.exitCode = 1;
  });
}
