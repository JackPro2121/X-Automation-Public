/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   v7 SMART COMMENT & AUTO-REPLY MASTER PIPELINE                  ║
 * ║   cron/v7/auto_reply_comments.js                                 ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   - 60% Outbound: High-value replies on top AI creators' posts   ║
 * ║   - 40% Inbound: Direct replies to comments on @M_jawad_yasin     ║
 * ║   - Safety Governor: Max 35/day, hard stop at 1,400/month        ║
 * ║   - Direct X API v2 Publishing ($0 Free Tier, 1500/mo cap)       ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

import { createKeyManager } from '../lib/keyManager.js';
import { isXApiConfigured, verifyXApiAuth, postXReply, DAILY_MAX_REPLIES, MONTHLY_MAX_REPLIES } from '../lib/xApiClient.js';
import { checkInboundComments } from './inbound_listener.js';
import { findOutboundCandidates } from './outbound_listener.js';
import { generateInboundReply, generateOutboundComment } from './reply_generator.js';
import { initGroqKeys, getGroqKeyStatus } from '../lib/groqClient.js';
import { sendSlack } from '../lib/slackClient.js';
import { startRun } from '../lib/logger.js';
import { validateEnv } from '../lib/utils.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

// ─── Environment & Clients ──────────────────────────────────────────────────
validateEnv(['VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// OpenRouter Key Manager (Primary Writer)
const openRouterKeys = createKeyManager('OPENROUTER', [
  process.env.OPENROUTER_API_KEY,
  process.env.OPENROUTER_API_KEY_2,
  process.env.OPENROUTER_API_KEY_3,
]);

// Groq Key Manager (Fallback)
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

// Run configuration
const RUN_TARGET_MAX = 7; // Max replies per run (5 runs/day * 7 = max 35/day)
const INBOUND_RATIO = 0.40;  // 40% inbound
const OUTBOUND_RATIO = 0.60; // 60% outbound

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
 * Save a published reply to Supabase
 */
async function recordReply({ commentId, parentTweetId, targetAuthor, targetText, isVerified, replyType, aiReplyText, xReplyId }) {
  try {
    const { error } = await supabase.from('comment_replies').insert({
      comment_id: commentId,
      parent_tweet_id: parentTweetId || null,
      target_author: targetAuthor,
      target_text: (targetText || '').substring(0, 1000),
      is_verified: !!isVerified,
      reply_type: replyType,
      ai_reply_text: aiReplyText,
      x_reply_id: xReplyId || null,
      status: 'published'
    });
    if (error) {
      console.warn(`  ⚠ Could not insert into comment_replies: ${error.message}`);
    } else {
      console.log(`  ✓ Logged reply to Supabase (Type: ${replyType}, Target: @${targetAuthor})`);
    }
  } catch (err) {
    console.warn(`  ⚠ Supabase insert error: ${err.message}`);
  }
}

/**
 * Main Pipeline Orchestrator
 */
async function main() {
  const startTime = Date.now();
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   🤖 v7 SMART COMMENT & AUTO-REPLY PIPELINE                 ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║   Target Allocation: 60% Outbound / 40% Inbound              ║`);
  console.log(`║   Daily Limit: ${DAILY_MAX_REPLIES} replies | Monthly Cap: ${MONTHLY_MAX_REPLIES}        ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const run = startRun('v7_comment_reply');

  // Pause Guard (Can be reactivated anytime by setting V7_ENABLED=true)
  if (process.env.V7_ENABLED !== 'true') {
    console.log('⏸ [PAUSED] v7 Auto Comment & Reply pipeline is currently paused.');
    console.log('💡 To activate in the future, set environment variable V7_ENABLED=true in GitHub Secrets / .env.local.\n');
    await run.success({ paused: true, reason: 'v7 currently paused' });
    return;
  }

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
    console.log(`🛑 MONTHLY SAFETY GOVERNOR REACHED (${monthCount}/${MONTHLY_MAX_REPLIES}). Halting pipeline until next month.`);
    await run.success({ reason: 'Monthly quota reached' });
    return;
  }

  if (todayCount >= DAILY_MAX_REPLIES) {
    console.log(`🛑 DAILY SAFETY GOVERNOR REACHED (${todayCount}/${DAILY_MAX_REPLIES}). Halting pipeline for today.`);
    await run.success({ reason: 'Daily limit reached' });
    return;
  }

  const remainingDaily = DAILY_MAX_REPLIES - todayCount;
  const thisRunTarget = Math.min(RUN_TARGET_MAX, remainingDaily);
  console.log(`🎯 Target replies for this run: ${thisRunTarget}\n`);

  let targetInboundCount = Math.round(thisRunTarget * INBOUND_RATIO);
  let targetOutboundCount = thisRunTarget - targetInboundCount;

  const publishedReplies = [];

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 1: INBOUND REPLIES (Comments on @M_jawad_yasin posts)
  // ═══════════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  PHASE 1: INBOUND REPLIES (Target: up to ' + targetInboundCount + ')');
  console.log('═══════════════════════════════════════════════════════════════');

  const inboundResult = await checkInboundComments(apifyKeys, supabase);
  const eligibleInbound = inboundResult.candidates || [];

  let inboundPublished = 0;
  for (const item of eligibleInbound) {
    if (inboundPublished >= targetInboundCount) break;

    console.log(`\n  💬 Generating reply to @${item.author}: "${item.text.substring(0, 60)}..."`);
    const aiReply = await generateInboundReply(
      {
        postTitle: 'AI & Engineering updates',
        commentAuthor: item.author,
        commentText: item.text,
        isVerified: item.isVerified
      },
      openRouterKeys,
      groqKeys
    );

    if (!aiReply) {
      console.warn(`  ⚠ Could not generate valid reply for @${item.author}. Skipping.`);
      continue;
    }

    console.log(`  Generated Reply (${aiReply.length} chars): "${aiReply}"`);
    console.log(`  🚀 Posting reply via X API to tweet ${item.commentId}...`);

    const postResult = await postXReply(item.commentId, aiReply);
    if (postResult.success) {
      console.log(`  ✅ Successfully replied! New X Tweet ID: ${postResult.tweetId}`);
      await recordReply({
        commentId: item.commentId,
        parentTweetId: item.parentTweetId,
        targetAuthor: item.author,
        targetText: item.text,
        isVerified: item.isVerified,
        replyType: 'inbound',
        aiReplyText: aiReply,
        xReplyId: postResult.tweetId
      });

      publishedReplies.push({
        type: 'Inbound',
        target: `@${item.author}`,
        text: aiReply,
        xReplyId: postResult.tweetId
      });
      inboundPublished++;

      // Non-spam delay
      const delayMs = getRandomDelay(45, 90);
      console.log(`  ⏳ Waiting ${(delayMs / 1000).toFixed(0)}s human delay before next reply...`);
      await sleep(delayMs);
    } else {
      console.warn(`  ❌ Failed to post reply to @${item.author}: ${postResult.error}`);
    }
  }

  // If inbound had fewer comments than allocated, reassign remaining slots to outbound!
  const leftoverSlots = targetInboundCount - inboundPublished;
  if (leftoverSlots > 0) {
    console.log(`\n  💡 Inbound had 0 or few comments. Reallocating ${leftoverSlots} slots to Outbound growth!`);
    targetOutboundCount += leftoverSlots;
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 2: OUTBOUND COMMENTS (High-Value replies on Top Creators)
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  PHASE 2: OUTBOUND COMMENTS (Target: up to ' + targetOutboundCount + ')');
  console.log('═══════════════════════════════════════════════════════════════');

  if (targetOutboundCount > 0) {
    const outboundCandidates = await findOutboundCandidates(apifyKeys, supabase, targetOutboundCount);
    let outboundPublished = 0;

    for (const post of outboundCandidates) {
      if (outboundPublished >= targetOutboundCount) break;

      console.log(`\n  🌟 Generating value comment for @${post.author}: "${post.text.substring(0, 60)}..."`);
      const aiComment = await generateOutboundComment(
        {
          tweetAuthor: post.author,
          tweetText: post.text,
          isVerified: post.isVerified
        },
        openRouterKeys,
        groqKeys
      );

      if (!aiComment) {
        console.warn(`  ⚠ Could not generate valid comment for @${post.author}. Skipping.`);
        continue;
      }

      console.log(`  Generated Comment (${aiComment.length} chars): "${aiComment}"`);
      console.log(`  🚀 Posting comment via X API to tweet ${post.tweetId}...`);

      const postResult = await postXReply(post.tweetId, aiComment);
      if (postResult.success) {
        console.log(`  ✅ Successfully commented! New X Tweet ID: ${postResult.tweetId}`);
        await recordReply({
          commentId: post.tweetId,
          parentTweetId: post.tweetId,
          targetAuthor: post.author,
          targetText: post.text,
          isVerified: true,
          replyType: 'outbound',
          aiReplyText: aiComment,
          xReplyId: postResult.tweetId
        });

        publishedReplies.push({
          type: 'Outbound',
          target: `@${post.author}`,
          text: aiComment,
          xReplyId: postResult.tweetId
        });
        outboundPublished++;

        // Non-spam delay (45 - 90s)
        const delayMs = getRandomDelay(45, 90);
        console.log(`  ⏳ Waiting ${(delayMs / 1000).toFixed(0)}s human delay before next comment...`);
        await sleep(delayMs);
      } else {
        console.warn(`  ❌ Failed to post outbound comment to @${post.author}: ${postResult.error}`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // SUMMARY & SLACK NOTIFICATION
  // ═══════════════════════════════════════════════════════════════════
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalPostedThisRun = publishedReplies.length;
  const newTodayTotal = todayCount + totalPostedThisRun;
  const newMonthTotal = monthCount + totalPostedThisRun;

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║   📊 v7 AUTO-REPLY PIPELINE COMPLETED                       ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║   Published This Run : ${String(totalPostedThisRun).padEnd(41)}║`);
  console.log(`║   Today Total        : ${String(`${newTodayTotal} / ${DAILY_MAX_REPLIES}`).padEnd(41)}║`);
  console.log(`║   Month Total        : ${String(`${newMonthTotal} / ${MONTHLY_MAX_REPLIES}`).padEnd(41)}║`);
  console.log(`║   Elapsed Time       : ${String(`${elapsed}s`).padEnd(41)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // Send Slack notification
  try {
    const blocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '💬 v7 Smart Comment & Auto-Reply Pipeline',
          emoji: true
        }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Run Output:*\n${totalPostedThisRun} replies sent` },
          { type: 'mrkdwn', text: `*Today Progress:*\n${newTodayTotal} / ${DAILY_MAX_REPLIES} replies` },
          { type: 'mrkdwn', text: `*Monthly Budget:*\n${newMonthTotal} / ${MONTHLY_MAX_REPLIES}` },
          { type: 'mrkdwn', text: `*Run Time:*\n${elapsed}s` }
        ]
      }
    ];

    if (publishedReplies.length > 0) {
      const summaryText = publishedReplies
        .map(r => `• *${r.type}* on ${r.target}: "${r.text}" (<https://x.com/i/status/${r.xReplyId}|View>)`)
        .join('\n');
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Activity Summary:*\n${summaryText}`
        }
      });
    } else {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '_No new replies sent this run (0 inbound comments & cooldowns preserved)._'
        }
      });
    }

    await sendSlack({
      text: `[v7 Auto-Reply] ${totalPostedThisRun} replies sent | Today: ${newTodayTotal}/${DAILY_MAX_REPLIES}`,
      blocks
    });
  } catch (err) {
    console.warn(`  ⚠ Slack reporting error: ${err.message}`);
  }

  await run.success({ totalPostedThisRun, newTodayTotal, newMonthTotal });
}

main().catch(async (err) => {
  console.error('Fatal v7 error:', err);
  process.exit(1);
});
