/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   X-AUTOMATION DEDICATED INBOUND AUTO-REPLY PIPELINE             ║
 * ║   cron/inbound_auto_reply.js                                     ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   - Monitors comments and replies on @M_jawad_yasin posts        ║
 * ║   - Claude-Blog Human Voice & Answer-First peer persona          ║
 * ║   - Anti-slop & Anti-bot cliché defense                          ║
 * ║   - Direct X API v2 Publishing ($0 Free Tier, 1500/mo cap)       ║
 * ║   - Strict Supabase deduplication (never reply twice)            ║
 * ║   - Safety Governor: Max 35/day, hard stop at 1,400/month        ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

import { createKeyManager } from './lib/keyManager.js';
import {
  isXApiConfigured,
  verifyXApiAuth,
  postXReply,
  DAILY_MAX_REPLIES,
  MONTHLY_MAX_REPLIES,
} from './lib/xApiClient.js';
import { generateInboundReply } from './v7/reply_generator.js';
import { initGroqKeys } from './lib/groqClient.js';
import { sendSlack } from './lib/slackClient.js';
import { startRun } from './lib/logger.js';
import { validateEnv } from './lib/utils.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

// ─── Environment & Clients ──────────────────────────────────────────────────
validateEnv(['VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// OpenRouter Key Manager (Primary/Fallback Writer)
const openRouterKeys = createKeyManager('OPENROUTER', [
  process.env.OPENROUTER_API_KEY,
  process.env.OPENROUTER_API_KEY_2,
  process.env.OPENROUTER_API_KEY_3,
]);

// Groq Key Manager (Fast fallback)
const groqKeys = initGroqKeys();

// Apify Key Manager (Scraper)
const apifyKeys = createKeyManager('APIFY', [
  process.env.APIFY_API_KEY,
  process.env.APIFY_API_KEY_2,
  process.env.APIFY_API_KEY_3,
  process.env.APIFY_API_KEY_4,
  process.env.APIFY_API_KEY_5,
  process.env.APIFY_API_KEY_6,
  process.env.APIFY_API_KEY_7,
  process.env.APIFY_API_KEY_8,
  process.env.APIFY_API_KEY_9,
  process.env.APIFY_API_KEY_10,
  process.env.APIFY_API_KEY_11,
  process.env.APIFY_API_KEY_12,
  process.env.APIFY_API_KEY_13,
  process.env.APIFY_API_KEY_14,
  process.env.APIFY_API_KEY_15,
  process.env.APIFY_API_KEY_16,
  process.env.APIFY_API_KEY_17,
  process.env.APIFY_API_KEY_18,
  process.env.APIFY_API_KEY_19,
  process.env.APIFY_API_KEY_20,
  process.env.APIFY_API_KEY_21,
  process.env.APIFY_API_KEY_22,
  process.env.APIFY_API_KEY_23,
  process.env.APIFY_API_KEY_24,
  process.env.APIFY_API_KEY_25,
  process.env.APIFY_API_KEY_26,
  process.env.APIFY_API_KEY_27,
  process.env.APIFY_API_KEY_28,
]);

const TARGET_USER = process.env.X_TARGET_USERNAME || 'M_jawad_yasin';
const APIFY_TWEET_SCRAPER = 'apidojo~tweet-scraper';
const RUN_TARGET_MAX = 5; // Max replies per run

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRandomDelay(minSec = 45, maxSec = 90) {
  const seconds = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;
  return seconds * 1000;
}

/**
 * Get count of replies published today and this calendar month from Supabase
 */
async function getReplyCounts() {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const startOfMonth = new Date(Date.UTC(startOfDay.getUTCFullYear(), startOfDay.getUTCMonth(), 1));

  let todayCount = 0;
  let monthCount = 0;

  try {
    const { count: today } = await supabase
      .from('comment_replies')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', startOfDay.toISOString());
    todayCount = today || 0;

    const { count: month } = await supabase
      .from('comment_replies')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', startOfMonth.toISOString());
    monthCount = month || 0;
  } catch (err) {
    console.warn(`  ⚠ Supabase count query notice: ${err.message}`);
  }

  return { todayCount, monthCount };
}

/**
 * Fetch recent inbound comments directed to @TARGET_USER
 */
async function fetchInboundComments() {
  console.log(`\n▶ [Inbound Listener] Searching recent comments to @${TARGET_USER}...`);

  if (!apifyKeys || apifyKeys.totalKeys === 0) {
    console.warn('  ⚠ No Apify keys available for inbound check');
    return [];
  }

  let rawComments = [];
  try {
    rawComments = await apifyKeys.execute(async (apiKey) => {
      const runRes = await fetch(
        `https://api.apify.com/v2/acts/${APIFY_TWEET_SCRAPER}/runs?token=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            searchTerms: [`to:${TARGET_USER}`],
            sort: 'Latest',
            maxItems: 15,
          }),
          signal: AbortSignal.timeout(30000),
        }
      );

      if (!runRes.ok) throw new Error(`Apify tweet-scraper HTTP ${runRes.status}`);
      const runData = await runRes.json();
      const runId = runData.data?.id;
      if (!runId) throw new Error('No run ID returned');

      for (let i = 0; i < 35; i++) {
        await sleep(3000);
        const sRes = await fetch(
          `https://api.apify.com/v2/actor-runs/${runId}?token=${apiKey}`,
          { signal: AbortSignal.timeout(10000) }
        );
        const sData = await sRes.json();
        if (sData.data?.status === 'SUCCEEDED') {
          const dId = sData.data?.defaultDatasetId;
          if (dId) {
            const iRes = await fetch(
              `https://api.apify.com/v2/datasets/${dId}/items?token=${apiKey}&format=json&limit=15`,
              { signal: AbortSignal.timeout(15000) }
            );
            return await iRes.json();
          }
        }
        if (sData.data?.status === 'FAILED') throw new Error('Actor run failed');
      }
      throw new Error('Timeout waiting for comment scraper');
    });
  } catch (err) {
    console.warn(`  ⚠ Could not fetch inbound comments: ${err.message}`);
    return [];
  }

  return rawComments || [];
}

/**
 * Filter out already replied comments, self-replies, and spam
 */
async function filterEligibleComments(rawComments) {
  if (!rawComments || rawComments.length === 0) return [];

  // Query already replied IDs from Supabase
  let existingRepliedIds = new Set();
  try {
    const { data } = await supabase
      .from('comment_replies')
      .select('comment_id')
      .limit(500);
    if (data) {
      existingRepliedIds = new Set(data.map((d) => d.comment_id));
    }
  } catch (e) {
    console.warn(`  ⚠ Supabase check notice: ${e.message}`);
  }

  const candidates = [];
  for (const c of rawComments) {
    const author = (c.author?.userName || c.authorUsername || '').replace('@', '');
    const commentId = c.id || c.tweetId;
    const commentText = c.text || c.full_text || '';

    // Filter out own comments, already replied comments, or short spam
    if (!commentId || !author) continue;
    if (author.toLowerCase() === TARGET_USER.toLowerCase()) continue;
    if (existingRepliedIds.has(commentId)) continue;
    if (commentText.trim().length < 5) continue;

    // Filter out bot link spam
    if (/https?:\/\/\S+/i.test(commentText) && commentText.split(' ').length < 4) continue;

    const isVerified = !!(c.author?.isBlueVerified || c.author?.verified || c.isVerified);
    candidates.push({
      commentId,
      parentTweetId: c.inReplyToStatusId || c.conversationId,
      author,
      text: commentText,
      isVerified,
      createdAt: c.createdAt || new Date().toISOString(),
    });
  }

  // Prioritize verified accounts first, then substantive length
  candidates.sort((a, b) => {
    if (a.isVerified !== b.isVerified) return b.isVerified ? 1 : -1;
    return b.text.length - a.text.length;
  });

  return candidates;
}

/**
 * Record successfully published reply in Supabase
 */
async function recordReply({
  commentId,
  parentTweetId,
  targetAuthor,
  targetText,
  isVerified,
  aiReplyText,
  xReplyId,
}) {
  try {
    const { error } = await supabase.from('comment_replies').insert({
      comment_id: commentId,
      parent_tweet_id: parentTweetId || null,
      target_author: targetAuthor,
      target_text: (targetText || '').substring(0, 1000),
      is_verified: !!isVerified,
      reply_type: 'inbound',
      ai_reply_text: aiReplyText,
      x_reply_id: xReplyId || null,
      status: 'published',
    });
    if (error) {
      console.warn(`  ⚠ Could not insert into comment_replies: ${error.message}`);
    } else {
      console.log(`  ✓ Logged reply to Supabase (Target: @${targetAuthor}, ID: ${commentId})`);
    }
  } catch (err) {
    console.warn(`  ⚠ Supabase insert error: ${err.message}`);
  }
}

/**
 * Main Inbound Pipeline Runner
 */
async function main() {
  const startTime = Date.now();
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   💬  X-AUTOMATION — DEDICATED INBOUND AUTO-REPLY            ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║   Account: @${TARGET_USER.padEnd(46)}║`);
  console.log(`║   Daily Limit: ${String(DAILY_MAX_REPLIES).padEnd(2)} replies | Monthly Cap: ${String(MONTHLY_MAX_REPLIES).padEnd(5)} replies       ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const run = startRun('inbound_auto_reply');

  // Step 0: Check Official X API Authentication
  if (!isXApiConfigured()) {
    console.error('❌ X API credentials missing in environment!');
    await run.failed('Missing X API credentials');
    return;
  }

  console.log('▶ Verifying X API OAuth 1.0a connection...');
  const authCheck = await verifyXApiAuth();
  if (!authCheck.ok) {
    console.error(`❌ X API Auth verification failed: ${authCheck.error || authCheck.status}`);
    await run.failed(`X API Auth failed: ${authCheck.error}`);
    return;
  }
  console.log(`  ✓ Authenticated with X API as @${authCheck.user?.username} (ID: ${authCheck.user?.id})\n`);

  // Step 1: Enforce Safety Governors
  const { todayCount, monthCount } = await getReplyCounts();
  console.log(`📊 Current Quota Status:`);
  console.log(`  • Today: ${todayCount} / ${DAILY_MAX_REPLIES} replies`);
  console.log(`  • This Month: ${monthCount} / ${MONTHLY_MAX_REPLIES} replies\n`);

  if (monthCount >= MONTHLY_MAX_REPLIES) {
    console.log(`🛑 MONTHLY SAFETY GOVERNOR REACHED (${monthCount}/${MONTHLY_MAX_REPLIES}). Halting until next month.`);
    await run.success({ reason: 'Monthly quota reached' });
    return;
  }

  if (todayCount >= DAILY_MAX_REPLIES) {
    console.log(`🛑 DAILY SAFETY GOVERNOR REACHED (${todayCount}/${DAILY_MAX_REPLIES}). Halting for today.`);
    await run.success({ reason: 'Daily limit reached' });
    return;
  }

  const remainingDaily = DAILY_MAX_REPLIES - todayCount;
  const thisRunTarget = Math.min(RUN_TARGET_MAX, remainingDaily);
  console.log(`🎯 Target replies for this run: up to ${thisRunTarget}\n`);

  // Step 2: Fetch and filter inbound comments
  const rawComments = await fetchInboundComments();
  if (!rawComments.length) {
    console.log(`  ✓ No recent comments found to @${TARGET_USER}. ($0 cost, clean exit).`);
    await run.success({ publishedCount: 0, reason: 'No new comments found' });
    return;
  }

  const eligibleComments = await filterEligibleComments(rawComments);
  console.log(`  ✓ Found ${eligibleComments.length} eligible unreplied comment(s).`);

  if (!eligibleComments.length) {
    console.log(`  ✓ All recent comments have already been answered or filtered out.`);
    await run.success({ publishedCount: 0, reason: 'All comments already answered' });
    return;
  }

  let publishedCount = 0;
  const publishedList = [];

  for (const item of eligibleComments) {
    if (publishedCount >= thisRunTarget) break;

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  💬 Inbound from @${item.author}${item.isVerified ? ' [Verified]' : ''}:`);
    console.log(`     "${item.text}"`);

    const aiReply = await generateInboundReply(
      {
        postTitle: 'AI Architecture & Engineering Breakthroughs',
        commentAuthor: item.author,
        commentText: item.text,
        isVerified: item.isVerified,
      },
      openRouterKeys,
      groqKeys
    );

    if (!aiReply) {
      console.warn(`  ⚠ Could not generate valid reply for @${item.author}. Skipping.`);
      continue;
    }

    console.log(`  🤖 Generated Reply (${aiReply.length} chars): "${aiReply}"`);
    console.log(`  🚀 Posting reply via official X API to tweet ${item.commentId}...`);

    const postResult = await postXReply(item.commentId, aiReply);
    if (postResult.success) {
      publishedCount++;
      publishedList.push({
        author: item.author,
        commentId: item.commentId,
        replyId: postResult.tweetId,
        text: aiReply,
      });

      console.log(`  ✅ Successfully published reply (X Tweet ID: ${postResult.tweetId || 'unknown'})`);

      await recordReply({
        commentId: item.commentId,
        parentTweetId: item.parentTweetId,
        targetAuthor: item.author,
        targetText: item.text,
        isVerified: item.isVerified,
        aiReplyText: aiReply,
        xReplyId: postResult.tweetId,
      });

      // Humanized jitter delay before next reply
      if (publishedCount < thisRunTarget && publishedCount < eligibleComments.length) {
        const delayMs = getRandomDelay(45, 90);
        console.log(`  ⏳ Sleeping ${(delayMs / 1000).toFixed(0)}s to mimic human response cadence...`);
        await sleep(delayMs);
      }
    } else {
      console.error(`  ❌ Failed to post reply to tweet ${item.commentId}: ${postResult.error}`);
    }
  }

  const durationSec = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  Run Complete: Published ${publishedCount} reply(ies) in ${durationSec}s.`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);

  if (publishedCount > 0) {
    await sendSlack({
      text: `💬 *Inbound Auto-Reply Success*\n• Published: ${publishedCount} direct replies\n• Target: @${TARGET_USER}\n• Duration: ${durationSec}s`,
    });
  }

  await run.success({ publishedCount, durationSec });
}

// Execute when run directly
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  main().catch((err) => {
    console.error('Fatal Inbound Pipeline Error:', err);
    process.exit(1);
  });
}
