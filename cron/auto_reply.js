/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║   X-AUTOMATION — AUTO QUOTE-TWEET PIPELINE                  ║
 * ║   auto_reply.js                                              ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║   Scrapes X accounts → picks best post → Groq generates     ║
 * ║   a contextual comment → Buffer posts as Quote Tweet        ║
 * ║                                                              ║
 * ║   Schedule: 5x/day (testing phase)                          ║
 * ║   Target: 1 quote tweet per run                             ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fetchXPosts } from './lib/xscraper.js';
import { postQuoteTweet } from './lib/bufferClient.js';
import { isDuplicate, generateId, validateEnv, stripMarkdown, stripMentions, fixStaleModelNames, isLikelyEnglish, isMetaTextCaption } from './lib/utils.js';
import { createKeyManager } from './lib/keyManager.js';
import { sendSlack, buildSuccessMessage, buildFailureMessage, buildNoPostsMessage } from './lib/slackClient.js';
import { startRun } from './lib/logger.js';
import { smartTrimToTarget, TWEET_TARGET_CHARS } from './tweetLimits.js';
import { callOpenRouter } from './lib/openrouterClient.js';
import { initGroqKeys, getGroqKeyStatus } from './lib/groqClient.js';

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

// Initialize Groq keys (for Groq fallback if OpenRouter fully fails)
const groqKeys = initGroqKeys();

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
]);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

const DAILY_TARGET = 5; // Testing phase: 5 quote tweets per day
const QUOTE_TWEETS_PER_RUN = 1;
const MIN_ENGAGEMENT = 40; // Minimum likes + RT×2 + replies (calibrated to 40 for high reliability & early trend catching)

// ─── Generate Quote Tweet Comment with OpenRouter ─────────────────────────────

// Detects comments cut off mid-sentence (LLM sometimes stops early — real
// cases: "This isn't just a Go win, it's an", "...same tools for free. It",
// "Higgsfield just made their most")
function isTruncated(text) {
  const t = text.trim();
  if (t.length < 40) return true; // too short to be a real comment
  if (/\b(a|an|the|and|but|or|of|to|it|is|in|on|for|with|as|at|by|this|that|most|more|just|their|your|our)\s*$/.test(t)) return true; // dangling word
  if (/[a-z0-9]-$/.test(t)) return true; // ends mid-hyphen
  if (/\b(looks|looked|seems|seemed|feels|felt|appears|appeared|sounds|sounded|turns|turned|becomes|became|makes|made|gets|got|gives|gave|shows|showed|wants|wanted|needs|needed|tries|tried|starts|started|continues|continued)\s*[.!?]$/i.test(t)) return true; // dangling verb + punctuation = cut
  if (!/[.!?…"')]$/.test(t)) return true; // no terminal punctuation — likely cut mid-sentence
  return false;
}

// Generates a comment, retrying up to 3 times when the output is too short or
// looks cut off mid-sentence.
async function generateComment(originalPost) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const text = await generateCommentOnce(originalPost);
    if (text && !isTruncated(text)) return text;
    console.warn(`  ⚠ Comment attempt ${attempt} rejected (${text ? `${text.length} chars, truncated` : 'generation failed'}) — ${attempt < 3 ? 'retrying' : 'giving up'}...`);
  }
  return null;
}

async function generateCommentOnce(originalPost) {
  const today = new Date().toISOString().split('T')[0];
  const prompt = `You are @M_jawad_yasin, an AI Engineering expert on X (Twitter) with 50K+ followers.

CURRENT DATE: ${today}

TASK: Write a SHORT insightful comment to QUOTE TWEET this post. This will appear as a quote tweet with the original embedded.

ORIGINAL TWEET:
"${originalPost.title}"
From: @${originalPost.author}
Engagement: ${originalPost.likes} likes, ${originalPost.retweets} retweets

COMMENT RULES:
- MAX 240 characters (hard limit — MUST fit within X's 280-character free plan)
- IMPORTANT: If the original tweet is NOT in English, first TRANSLATE its meaning into English, then write your comment. Output must be 100% English.
- Structure: HOOK (a sharp, opinionated opening take, 60-100 chars) → BODY (add your unique value/analysis/prediction) → CTA or punchy close (nudge to agree/reply, 10-40 chars)
- Add your UNIQUE PERSPECTIVE — don't just repeat what they said
- Be CONVERSATIONAL, like talking to a smart friend
- Make it DEBATABLE — people should want to reply to YOUR take
- Reference the original content naturally
- If it's a tool, share your experience or opinion
- If it's news, add analysis or a prediction
- If it's a debate, take a clear side
- NO hashtags, NO emojis, NO markdown
- NO "Thread:" or "1/" prefixes
- NO "Great post!" or generic praise — add value
- Just the comment text, nothing else

YOUR COMMENT:`;

  const validator = (raw) => {
    if (!raw) return null;
    let text = raw.replace(/^["']|["']$/g, '');
    text = text.replace(/#[\w]+/g, '');
    text = stripMarkdown(text);
    text = stripMentions(text);
    text = fixStaleModelNames(text);
    text = text.trim();

    if (isMetaTextCaption(text)) {
      console.warn('  ⚠ Meta-text leak detected in quote comment — rejecting');
      return null;
    }

    // Enforce 240-char target — smart-trim, never reject (scraped content not wasted)
    if (text.length > TWEET_TARGET_CHARS) {
      const before = text.length;
      text = smartTrimToTarget(text);
      console.log(`  ✂ Trimmed comment ${before} → ${text.length} chars`);
    }

    if (text.length < 10) return null;
    if (!isLikelyEnglish(text)) {
      console.warn('  ⚠ Non-English comment detected — skipping');
      return null;
    }

    return text;
  };

  try {
    const text = await callOpenRouter(llmKeys, {
      prompt,
      temperature: 0.85,
      maxTokens: 300,
      validator,
    });
    return text || null;
  } catch (err) {
    console.warn(`  ⚠ Comment generation failed: ${err.message}`);
    return null;
  }
}

// ─── Daily Counter ────────────────────────────────────────────────────────────

async function getTodayQuoteCount() {
  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const { count, error } = await supabase
      .from('generated_posts')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'published')
      .gte('db_created_at', todayStart.toISOString())
      .like('creator_handle', 'quote/%');
    if (error) throw error;
    return count || 0;
  } catch (err) {
    console.warn(`  ⚠ Could not get count: ${err.message}`);
    return -1;
  }
}

// ─── Save Quote Tweet to Supabase ─────────────────────────────────────────────

async function saveQuoteTweet(post, comment, status = 'posting') {
  try {
    const { error } = await supabase.from('generated_posts').insert({
      id: generateId('qt'),
      original_post_id: post.tweetUrl,
      creator_handle: `quote/${post.author}`,
      creator_name: `quote/${post.author}`,
      generated_text: comment,
      character_count: comment?.length || 0,
      status,
      source_url: post.tweetUrl,
      buffer_post_id: null,
    });
    if (error) throw error;
    console.log('  ✓ Saved to Supabase');
  } catch (err) {
    console.warn(`  ⚠ Save failed: ${err.message}`);
    throw err;
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  💬  X-AUTOMATION — AUTO QUOTE-TWEET PIPELINE               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Started : ${new Date().toISOString()}`);
  console.log(`  Buffer  : ${process.env.BUFFER_API_KEY ? '✓' : '✗ (dry run)'}`);
  console.log(`  LLM     : ${llmKeys.totalKeys} OpenRouter key(s) loaded (${llmKeys.availableKeys} available)`);
  console.log(`  Groq    : ${groqKeys.totalKeys} key(s) loaded (fallback only)`);
  console.log(`  Apify   : ${apifyKeys.totalKeys} key(s) loaded`);
  console.log(`  Target  : ${QUOTE_TWEETS_PER_RUN} quote tweet(s) this run`);
  console.log('');
  const pipeline = 'quote_tweet';
  const run = startRun(pipeline);

  try {
    // Check daily count
    const todayCount = await getTodayQuoteCount();
    console.log(`  📊 Today's quote tweets: ${todayCount}/${DAILY_TARGET}`);
    if (todayCount >= DAILY_TARGET) {
      console.log(`  ✅ Daily target reached! Skipping.`);
      await run.noPosts(0);
      return;
    }

    // Pre-flight key check
    console.log('\n  💰 Checking Apify balances...');
    await apifyKeys.checkBalances();

    // Step 1: Scrape X accounts
    console.log('\n▶ STEP 1: Scraping X accounts for quote tweet targets...');
    const xPosts = await fetchXPosts(apifyKeys, undefined, 10, 4); // 4 accounts with credit-saving early stop at qualifying media

    if (xPosts.length === 0) {
      console.log('  ⚠ No X posts found. Exiting.');
      run.setApifyKeyStatus(apifyKeys.getStatus());
      await run.noPosts(5);
      await sendSlack(buildNoPostsMessage({ pipeline, subredditsScanned: 5, keyStatus: apifyKeys.getStatus(), llmKeyStatus: llmKeys.getStatus() }));
      return;
    }

    // Step 2: Filter for high engagement posts
    console.log('\n▶ STEP 2: Filtering for high engagement...');
    const highEngagement = xPosts.filter(p => p.engagement >= MIN_ENGAGEMENT);
    console.log(`  ✓ ${highEngagement.length} posts with engagement >= ${MIN_ENGAGEMENT}`);

    if (highEngagement.length === 0) {
      console.log('  ⚠ No high engagement posts. Exiting.');
      run.setApifyKeyStatus(apifyKeys.getStatus());
      await run.noPosts(5);
      return;
    }

    // Step 3: Dedup check — pick best non-duplicate
    console.log('\n▶ STEP 3: Selecting quote tweet target (dedup check)...');
    let targetPost = null;
    for (const post of highEngagement) {
      if (!await isDuplicate(supabase, post.tweetUrl)) {
        targetPost = post;
        break;
      }
    }

    if (!targetPost) {
      console.log('  ⚠ All high engagement posts already quote-tweeted. Exiting.');
      run.setApifyKeyStatus(apifyKeys.getStatus());
      await run.noPosts(5);
      return;
    }

    console.log(`  ✓ Selected: @${targetPost.author} — ${targetPost.title.substring(0, 50)}...`);
    console.log(`    ❤️ ${targetPost.likes} | 🔄 ${targetPost.retweets} | 💬 ${targetPost.replies}`);
    run.setApifyKeyStatus(apifyKeys.getStatus());
    run.setMimoKeyStatus(llmKeys.getStatus());
    run.setGroqKeyStatus(getGroqKeyStatus());

    // Step 4: Generate comment
    console.log('\n▶ STEP 4: Generating quote tweet comment...');
    const comment = await generateComment(targetPost);

    if (!comment || comment.length < 40) {
      console.log('  ⚠ Comment generation failed or too short. Exiting.');
      return;
    }

    console.log(`  ✓ Comment (${comment.length} chars): "${comment.substring(0, 80)}..."`);

    // Step 5: Save + Post
    console.log('\n▶ STEP 5: Posting quote tweet...');
    // Extract tweet ID from URL for quote tweet
    const tweetIdMatch = targetPost.tweetUrl?.match(/\/status\/(\d+)/);
    const tweetId = tweetIdMatch ? tweetIdMatch[1] : null;

    if (!tweetId) {
      console.log('  ⚠ Could not extract tweet ID. Skipping without creating a DB record.');
      return;
    }

    await saveQuoteTweet(targetPost, comment, 'posting');

    const bufferResult = await postQuoteTweet(comment, tweetId);

    if (bufferResult.success) {
      console.log(`  ✅ QUOTE TWEETED! (Buffer ID: ${bufferResult.postId})`);

      // Update Supabase status
      await supabase.from('generated_posts')
        .update({ status: 'published', buffer_post_id: bufferResult.postId })
        .eq('source_url', targetPost.tweetUrl)
        .eq('status', 'posting');

      // Slack notification
      const slackResult = await sendSlack(buildSuccessMessage({
        pipeline,
        text: comment,
        subreddit: targetPost.author,
        upvotes: targetPost.likes,
        imageUrl: targetPost.imageUrl,
        redditUrl: targetPost.tweetUrl,
        bufferId: bufferResult.postId,
        elapsed: ((Date.now() - startTime) / 1000).toFixed(1),
        keyStatus: apifyKeys.getStatus(),
        redditTitle: targetPost.title,
        comments: targetPost.replies,
        charCount: comment.length,
        llmKeyStatus: llmKeys.getStatus(),
        modelUsed: 'openrouter',
        todayCount: await getTodayQuoteCount(),
      }));
      run.setSlackSent(slackResult.ok);
    } else {
      console.log(`  ❌ Buffer failed: ${bufferResult.reason}`);
      const failPayload = { status: 'failed' };
      if (bufferResult.reason) failPayload.error_message = String(bufferResult.reason).substring(0, 500);
      let { error } = await supabase.from('generated_posts')
        .update(failPayload)
        .eq('source_url', targetPost.tweetUrl)
        .eq('status', 'posting');
      // Best-effort: if error_message column isn't migrated yet, retry without it
      if (error && failPayload.error_message && /column.*does not exist|could not find the .* column/.test(error.message)) {
        delete failPayload.error_message;
        ({ error } = await supabase.from('generated_posts')
          .update(failPayload)
          .eq('source_url', targetPost.tweetUrl)
          .eq('status', 'posting'));
      }
      if (error) console.warn(`  ⚠ Status update failed: ${error.message}`);
    }

    // Summary
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  📊  QUOTE-TWEET PIPELINE COMPLETE                          ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Status : ${String(bufferResult.success ? '✅ Success' : '❌ Failed').padEnd(49)}║`);
    console.log(`║  Target : ${String(`@${targetPost.author}`).padEnd(49)}║`);
    console.log(`║  Time   : ${String(`${elapsed}s`).padEnd(49)}║`);
    console.log('╚══════════════════════════════════════════════════════════════╝');

    run.setPost({
      title: targetPost.title,
      url: targetPost.tweetUrl,
      upvotes: targetPost.likes,
      subreddit: targetPost.author,
      generatedText: comment,
      imageUrl: targetPost.imageUrl,
    });

    await run.success();

  } catch (err) {
    console.error('\n❌ QUOTE-TWEET FATAL:', err.message);
    const slackResult = await sendSlack(buildFailureMessage({ pipeline, step: 'pipeline', error: err.message, keyStatus: apifyKeys.getStatus(), llmKeyStatus: llmKeys.getStatus() }));
    run.setSlackSent(slackResult.ok);
    await run.fail(err);
    process.exitCode = 1;
  }
}

process.on('unhandledRejection', (reason) => { console.error('❌ Unhandled:', reason); process.exitCode = 1; });
main().catch((err) => { console.error('❌ main() failed:', err); process.exitCode = 1; });
