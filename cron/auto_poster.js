/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   X-AUTOMATION — AUTO POSTER (Queue Consumer)                    ║
 * ║   auto_poster.js                                                  ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Reads approved/draft posts from Supabase queue                 ║
 * ║   Detects thread format (===TWEET_BREAK=== separator)            ║
 * ║   Posts single posts OR multi-tweet threads via Buffer API       ║
 * ║   Marks posts 'published' in DB after successful post            ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { enforceThreadCharLimits, threadWithinLimits } from './tweetLimits.js';
import { TWEET_BREAK, MAX_RETRIES } from './lib/constants.js';
import { postSingleToBuffer, postThreadToBuffer } from './lib/bufferClient.js';
import { validateEnv } from './lib/utils.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

// ─── Environment ──────────────────────────────────────────────────────────────
validateEnv(['VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

const SUPABASE_URL          = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUFFER_API_KEY        = process.env.BUFFER_API_KEY;
const BUFFER_CHANNEL_ID     = process.env.BUFFER_CHANNEL_ID;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// ─── DB: Claim next post from queue (atomic claim to prevent race condition) ──

async function claimNextPost(maxRetries = 3, delayMs = 8000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`📡 DB connect (attempt ${attempt}/${maxRetries})...`);
    try {
      // Step 1: Find the oldest approved post
      const { data: candidates, error: findErr } = await supabase
        .from('generated_posts')
        .select('id')
      .eq('status', 'approved')
      .is('buffer_post_id', null)
        .order('db_created_at', { ascending: true })
        .limit(1);

      if (findErr) throw new Error(findErr.message);
      if (!candidates || candidates.length === 0) {
        console.log('ℹ No queued posts found');
        return null;
      }

      const postId = candidates[0].id;

      // Step 2: Atomically claim it by updating status to 'posting'
      const { data: claimed, error: claimErr } = await supabase
        .from('generated_posts')
        .update({ status: 'posting', claimed_at: new Date().toISOString() })
        .eq('id', postId)
        .eq('status', 'approved')  // Only claim if still 'approved' (prevents race)
        .select('id, status, generated_text, infographic, retry_count')
        .single();

      // H1 fix: PGRST116 = 0 rows from .single() = another process claimed it.
      // This is a benign race condition, NOT a DB error — retry immediately.
      if (claimErr) {
        if (claimErr.code === 'PGRST116' || claimErr.message?.includes('0 rows')) {
          console.log(`⚠ Post [${postId}] already claimed by another process, retrying...`);
          continue; // No delay — try next post immediately
        }
        throw new Error(claimErr.message); // Real DB error — propagate
      }

      if (!claimed) {
        console.log(`⚠ Post [${postId}] already claimed by another process, retrying...`);
        continue;
      }

      console.log(`✓ Claimed post [ID: ${claimed.id}]`);
      return claimed;

    } catch (err) {
      console.warn(`⚠ Attempt ${attempt} failed: ${err.message}`);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw new Error('DB connection timed out after cold-start retries');
}

// ─── Thread detection & parsing ───────────────────────────────────────────────

function detectAndParseThread(generatedText) {
  if (!generatedText) return { isThread: false, tweets: [] };

  if (generatedText.includes(TWEET_BREAK)) {
    const tweets = generatedText
      .split(TWEET_BREAK)
      .map(t => t.trim())
      .filter(t => t.length > 0); // H5 fix: was > 15, dropping punchy short tweets

    // Guard: if all tweets were empty after split, return raw text as single post
    if (tweets.length === 0) {
      return { isThread: false, tweets: [generatedText] };
    }

    return { isThread: true, tweets };
  }

  return { isThread: false, tweets: [generatedText] };
}

// ─── Buffer posting (delegated to shared module) ──────────────────────────────
// postSingleViaBuffer and postThreadViaBuffer replaced by bufferClient.js
// Import: postSingleToBuffer, postThreadToBuffer from './lib/bufferClient.js'

// ─── DB: Mark post as published ───────────────────────────────────────────────

async function markPublished(postId) {
  const { error } = await supabase
    .from('generated_posts')
    .update({ status: 'published', claimed_at: null })
    .eq('id', postId);

  if (error) throw new Error(`Failed to mark published: ${error.message}`);
  console.log(`✓ Post [${postId}] marked as 'published' in DB`);
}

// ─── DB: Handle failure with retry logic ──────────────────────────────────────

async function handleFailure(post, error) {
  if (!post || !post.id) return;

  const retryCount = (post.retry_count || 0) + 1;

  if (retryCount < MAX_RETRIES) {
    // Retry: increment count, reset to approved with backoff
    console.log(`⚠ Post [${post.id}] failed (attempt ${retryCount}/${MAX_RETRIES}) — will retry`);
    const { error: updateErr } = await supabase
      .from('generated_posts')
      .update({
        status: 'approved',
        retry_count: retryCount,
        claimed_at: null
      })
      .eq('id', post.id);

    if (updateErr) console.error(`  ✗ Failed to update retry count: ${updateErr.message}`);
  } else {
    // Permanent failure
    console.log(`\n⚠️ Marking post [${post.id}] as 'failed' after ${MAX_RETRIES} attempts`);

    // H2/L5 fix: Merge error into existing infographic instead of overwriting.
    // Previous code destroyed infographic data with { last_error: ... }.
    const existingInfographic = post.infographic && typeof post.infographic === 'object'
      ? post.infographic
      : {};
    const safeErrorMessage = (error.message || 'Unknown error')
      .replace(/[^\w\s.,!?:\-()[\]]/g, '') // Strip potentially unsafe chars
      .substring(0, 200);

    const { error: updateErr } = await supabase
      .from('generated_posts')
      .update({
        status: 'failed',
        retry_count: retryCount,
        claimed_at: null,
        infographic: { ...existingInfographic, last_error: safeErrorMessage }
      })
      .eq('id', post.id);

    if (updateErr) console.error(`  ✗ Failed to mark as failed: ${updateErr.message}`);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function runAutoPoster() {
  const startTime = Date.now();

  console.log('');
  console.log(`[${new Date().toISOString()}] 🤖 AUTO POSTER STARTING`);
  console.log(`  Buffer : ${BUFFER_API_KEY ? '✓ Key loaded' : '✗ Missing'}`);

  let post = null;
  try {
    // 1. Claim next post from queue (atomic to prevent race conditions)
    post = await claimNextPost();

    if (!post) {
      console.log('💤 Queue empty — nothing to post. Exiting cleanly.');
      return;
    }

    console.log(`\n📝 Post content preview:`);
    console.log(`  ID     : ${post.id}`);
    console.log(`  Status : ${post.status}`);
    console.log(`  Text   : "${post.generated_text?.substring(0, 150)}…"`);
    console.log(`  Retries: ${post.retry_count || 0}/${MAX_RETRIES}`);

    if (!BUFFER_API_KEY || !BUFFER_CHANNEL_ID) {
      console.warn('\n⚠ Buffer credentials missing — DRY RUN only (not posting to X, queue unchanged)');
      console.log(`[DRY RUN] Would post:\n${post.generated_text}`);

      // Release the claim back to approved for dry run
      await supabase
        .from('generated_posts')
        .update({ status: 'approved', claimed_at: null })
        .eq('id', post.id);
      return;
    }

    // 2. Detect thread vs single post
    let { isThread, tweets } = detectAndParseThread(post.generated_text);
    if (isThread && tweets.length > 1) {
      tweets = enforceThreadCharLimits(tweets);
    } else if (tweets[0]) {
      tweets = enforceThreadCharLimits([tweets[0]]);
    }

    let bufferPostId, bufferStatus;

    if (isThread && tweets.length > 1) {
      // ── Thread post ──────────────────────────────────────────────────────────
      console.log(`\n🧵 Thread detected — ${tweets.length} tweets`);
      tweets.forEach((t, i) => {
        console.log(`  Tweet ${i + 1} [${t.length} chars]: ${t.substring(0, 80)}…`);
      });

      // H5 fix: enforce char limits before posting
      const limitedTweets = enforceThreadCharLimits(tweets);
      const result = await postThreadToBuffer(limitedTweets);
      if (!result.success) throw new Error(result.reason || 'Thread post failed');
      bufferPostId = result.postId;
      bufferStatus = result.status;

    } else {
      // ── Single post ──────────────────────────────────────────────────────────
      console.log('\n📄 Single post detected');
      const singleText = enforceThreadCharLimits([tweets[0] || post.generated_text])[0];
      const result = await postSingleToBuffer(singleText);
      if (!result.success) throw new Error(result.reason || 'Single post failed');
      bufferPostId = result.postId;
      bufferStatus = result.status;
    }

    console.log(`\n🎉 POSTED TO X VIA BUFFER!`);
    console.log(`   Buffer Post ID : ${bufferPostId}`);
    console.log(`   Type           : ${isThread ? `Thread (${tweets.length} tweets)` : 'Single post'}`);
    console.log(`   Buffer Status  : ${bufferStatus}`);

    // C1 fix: Zombie post protection.
    // If markPublished fails after a successful Buffer post, the tweet IS live on X.
    // We must NOT call handleFailure (which would reset to 'approved' and cause a duplicate).
    // Instead: retry markPublished once, then log a critical warning.
    try {
      await markPublished(post.id);
    } catch (pubErr) {
      console.warn(`⚠ First markPublished attempt failed: ${pubErr.message}, retrying...`);
      try {
        await markPublished(post.id);
      } catch (pubErr2) {
        console.error(`\n🚨 CRITICAL: Tweet is LIVE on X (Buffer ID: ${bufferPostId}) but failed to mark as published in DB.`);
        console.error(`   Post [${post.id}] is stuck in 'posting' status. Manual intervention needed.`);
        console.error(`   Error: ${pubErr2.message}`);
        // Do NOT call handleFailure — the tweet is already live!
        // Calling handleFailure would reset to 'approved' and auto_poster would post it AGAIN.
      }
    }

  } catch (err) {
    console.error(`\n❌ AUTO POSTER ERROR: ${err.message}`);
    console.error(err.stack);

    // Handle failure with retry logic (only for pre-Buffer errors)
    await handleFailure(post, err);

    process.exitCode = 1;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n[${new Date().toISOString()}] 💤 AUTO POSTER COMPLETE (${elapsed}s)`);
}

runAutoPoster();
