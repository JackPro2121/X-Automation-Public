/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   X-AUTOMATION v6 — X (TWITTER) CONTENT PIPELINE                ║
 * ║   seed_and_post.js                                               ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Scrapes AI/tech X accounts for best content                    ║
 * ║   Rewrites in our hook/tone style                                ║
 * ║   Posts to X via Buffer with original images/GIFs/videos         ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fetchXPosts } from '../lib/xscraper.js';
import { postSingleToBuffer, postVideoToBuffer, isMediaWithinLimits } from '../lib/bufferClient.js';
import { isDuplicate, generateId, validateEnv, fixStaleModelNames, stripMarkdown, stripMentions, isLikelyEnglish, isAIPromptText, isQualityFallbackTitle, isMetaTextCaption, formatPostWhitespace, isTooSimilarToSource } from '../lib/utils.js';
import { smartTrimToTarget, X_SAFE_MAX_CHARS } from '../tweetLimits.js';
import { createKeyManager } from '../lib/keyManager.js';
import { sendSlack, buildSuccessMessage, buildFailureMessage, buildNoPostsMessage, buildPartialFailureMessage } from '../lib/slackClient.js';
import { startRun } from '../lib/logger.js';
import { initGroqKeys, getGroqKeyStatus, generateImageBrief, generateTweetWithFallback } from '../lib/groqClient.js';
import { callOpenRouter } from '../lib/openrouterClient.js';
import { callGemini, isGeminiConfigured } from '../lib/geminiClient.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

// ─── Environment ──────────────────────────────────────────────────────────────
validateEnv(['VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ─── Key Managers ─────────────────────────────────────────────────────────────
const llmKeys = createKeyManager('OPENROUTER', [
  process.env.OPENROUTER_API_KEY,
  process.env.OPENROUTER_API_KEY_2,
  process.env.OPENROUTER_API_KEY_3,
]);

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

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// Initialize Groq Vision keys (for image analysis before OpenRouter rewrite)
const groqKeys = initGroqKeys();

const DAILY_TARGET = 6;  // v6 cap: 2 runs/day × 1 post = ~2 posts/day (OCR quality strategy)
const GLOBAL_DAILY_MAX = 25; // Hard ceiling across ALL pipelines combined
const POSTS_PER_RUN = 1;

// ─── Daily Counter ────────────────────────────────────────────────────────────

async function getTodayXPostCount() {
  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const { count, error } = await supabase
      .from('generated_posts')
      .select('*', { count: 'exact', head: true })
      // 'published' only — orphaned 'posting' rows (crash between save and status update) must not consume the daily quota
      .eq('status', 'published')
      .gte('db_created_at', todayStart.toISOString())
      .like('creator_handle', 'x/%');
    if (error) throw error;
    return count || 0;
  } catch (err) {
    console.warn(`  ⚠ Could not get count: ${err.message}`);
    return -1;
  }
}

async function getTodayGlobalPostCount() {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const { count, error } = await supabase
    .from('generated_posts')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'published')
    .gte('db_created_at', todayStart.toISOString());
  if (error) throw error;

  const { count: queuedCount, error: queuedError } = await supabase
    .from('generated_posts')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'approved')
    .not('buffer_post_id', 'is', null)
    .gte('db_created_at', todayStart.toISOString());
  if (queuedError) throw queuedError;
  return (count || 0) + (queuedCount || 0);
}

// ─── Rewrite with OpenRouter (with Groq Vision image analysis) ─────────────────────

// Fall back to the shared Groq chain (Groq Vision -> Groq text) when the OpenRouter rewrite fails
async function fallbackWithGroq(originalPost) {
  const result = await generateTweetWithFallback(originalPost, llmKeys, false);
  if (result?.text) return result.text;
  return null; // Under X Original Content Rewards, never post another creator's raw tweet
}

async function rewriteWithOpenRouter(originalPost, visualBrief = null) {
  if (!isGeminiConfigured() && (!llmKeys || llmKeys.totalKeys === 0)) {
    return await fallbackWithGroq(originalPost);
  }

  // Detect if this is a company account
  const companyAccounts = ['OpenAI', 'AnthropicAI', 'GoogleDeepMind', 'MetaAI', 'nvidia', 'StabilityAI', 'CohereForAI'];
  const isCompany = companyAccounts.includes(originalPost.author);
  
  // Company-specific context
  let companyContext = '';
  if (isCompany) {
    companyContext = `\nThis is from @${originalPost.author} (official company account). Mention them naturally: "@${originalPost.author} just released..." or "@${originalPost.author} announced..."`;
  }

  // Media context with Groq Vision breakdown
  let mediaContext = '';
  if (visualBrief) {
    mediaContext = `\nIMAGE ANALYSIS (from vision AI — use these details to write about what you SEE):\n${visualBrief}`;
  } else if (originalPost.imageUrl) {
    mediaContext = '\nThis post has an IMAGE attached. Reference the visual content in your rewrite.';
  } else if (originalPost.videoUrl) {
    mediaContext = '\nThis post has a VIDEO attached. Reference the video/demo in your rewrite.';
  } else if (originalPost.gifUrl) {
    mediaContext = '\nThis post has a GIF attached. Reference the animated content in your rewrite.';
  }

  const today = new Date().toISOString().split('T')[0];
  const isPremium = process.env.X_PREMIUM === 'true';
  const rewriteRules = isPremium
    ? `REWRITE RULES (VIRAL CREATOR FORMAT):
- TARGET LENGTH: 250 to 500 characters. Hard limit: 1,200 characters.
- MANDATORY EMPTY LINES: Every section MUST be separated by an empty line (\\n\\n).
- NO WALLS OF TEXT: Keep each paragraph to 1-2 short sentences.
- STRUCTURE:
  1. Magnetic 1-line hook or reaction to what happened
  2. (empty line)
  3. 1-2 sentences of key context or bullet points (•) describing what is shown in the image/video
  4. (empty line)
  5. 1-line closing takeaway, thought, or question to drive comments
- IMPORTANT: If the original tweet is NOT in English, first TRANSLATE the full meaning into English, then rewrite in your style. Output must be 100% English.
- If it's a company announcement, mention them naturally (e.g., "OpenAI just dropped...")
- If there's an image/video, reference what it visibly demonstrates
- NO hashtags, NO markdown headers (#), NO bold (**).
- Output ONLY the finished rewritten post text with clean empty lines, nothing else.`
    : `REWRITE RULES:
- MAX 240 characters (hard limit — MUST fit within X's 280-character limit)
- IMPORTANT: If the original tweet is NOT in English, first TRANSLATE the full meaning into English, then rewrite in your style. Output must be 100% English.
- Use a STRONG HOOK to open: bold claim, shocking stat, provocative question, or bold prediction (60-100 chars)
- Then a BODY: one clear sentence on WHAT the post is about and WHY it matters (60-100 chars)
- Then a CTA: short closing nudge to engage — "Try it", "This changes everything", "Thoughts?" (10-40 chars)
- Add a NEW layer on top of their message — your reaction, insight, or angle — never just restate it
- If it's a company announcement, mention them naturally (e.g., "@OpenAI just dropped...") then give YOUR read on it
- If it's an influencer, lead with your own perspective, not a paraphrase of theirs
- If there's an image/video, reference what it shows using the IMAGE ANALYSIS
- NO hashtags, NO emojis, NO markdown
- NO "Thread:" or "1/" prefixes
- Just the rewritten tweet, nothing else`;

  const prompt = `You are @M_jawad_yasin, an AI Engineering expert on X (Twitter) with 50K+ followers.

CURRENT DATE: ${today}

TASK: A tech creator posted the tweet below. Do NOT rewrite or reword it — that is not original and earns nothing on X. Instead, react to it with YOUR OWN original commentary: your take, the implication they missed, a tradeoff, a question you'd ask them, or how it fits a bigger trend. The reader should get NEW value from your post, not a restatement of theirs.

TWEET THAT SPARKED YOUR THOUGHT (source signal — reference the facts, but the analysis must be yours):
"${originalPost.title}"
From: @${originalPost.author}
Engagement: ${originalPost.likes} likes, ${originalPost.retweets} retweets${companyContext}${mediaContext}

${rewriteRules}

YOUR ORIGINAL COMMENTARY:`;

  const validator = (raw) => {
    if (!raw) return null;
    let text = raw.replace(/^["']|["']$/g, '');
    text = text.replace(/#[\w]+/g, '');
    text = stripMarkdown(text);
    text = stripMentions(text);
    text = fixStaleModelNames(text);
    text = formatPostWhitespace(text);

    if (isMetaTextCaption(text)) {
      console.warn(`  ⚠ Structured label / meta leak detected in rewrite — rejecting`);
      return null;
    }
    if (!isLikelyEnglish(text)) {
      console.warn(`  ⚠ Non-English text detected in rewrite — rejecting`);
      return null;
    }
    // Originality gate — reject a near-copy of the creator's tweet (X flags
    // "minimally modified" reposts of another creator's work as ineligible).
    if (isTooSimilarToSource(text, originalPost.title)) {
      console.warn(`  ⚠ Output too close to the original tweet (reword) — rejecting for original commentary`);
      return null;
    }

    // Hard cap enforcement: 1,200 for Premium, 277 for Free
    if (text.length > X_SAFE_MAX_CHARS) {
      const before = text.length;
      text = smartTrimToTarget(text, X_SAFE_MAX_CHARS);
      console.log(`  ✂ Trimmed rewrite ${before} → ${text.length} chars (hard cap ${X_SAFE_MAX_CHARS})`);
    }

    if (text.length < 15) return null;
    return text;
  };

  // 1. Try Gemini first (Primary)
  if (isGeminiConfigured()) {
    try {
      const geminiResult = await callGemini(prompt, {
        temperature: 0.85,
        maxTokens: 600,
        validator,
      });
      if (geminiResult) return geminiResult;
    } catch (err) {
      console.warn(`  ⚠ Gemini rewrite failed: ${err.message}`);
    }
  }

  // 2. Try OpenRouter (Secondary)
  try {
    const result = await callOpenRouter(llmKeys, {
      prompt,
      temperature: 0.85,
      maxTokens: 400,
      validator,
    });

    if (!result) return await fallbackWithGroq(originalPost);
    return result;
  } catch (err) {
    console.warn(`  ⚠ OpenRouter failed: ${err.message}`);
    return await fallbackWithGroq(originalPost);
  }
}

// ─── Save + Post ──────────────────────────────────────────────────────────────

async function saveXPost(post, text, status = 'posting') {
  try {
    const { error } = await supabase.from('generated_posts').insert({
      id: generateId('v6'),
      original_post_id: post.tweetUrl,
      creator_handle: `x/${post.author}`,
      creator_name: `x/${post.author}`,
      generated_text: text,
      character_count: text?.length || 0,
      status,
      source_url: post.tweetUrl,
      buffer_post_id: null
    });
    if (error) throw error;
    console.log('  ✓ Saved to Supabase');
  } catch (err) {
    console.warn(`  ⚠ Save failed: ${err.message}`);
    throw err;
  }
}

async function updateXPostStatus(tweetUrl, status, bufferPostId = null, errorMessage = null) {
  const payload = { status, buffer_post_id: bufferPostId };
  if (errorMessage) payload.error_message = String(errorMessage).substring(0, 500);
  try {
    let { error } = await supabase.from('generated_posts')
      .update(payload)
      .eq('source_url', tweetUrl)
      .eq('status', 'posting');
    // Best-effort: if error_message column isn't migrated yet, retry without it
    if (error && payload.error_message && /column.*does not exist|could not find the .* column/.test(error.message)) {
      delete payload.error_message;
      ({ error } = await supabase.from('generated_posts')
        .update(payload)
        .eq('source_url', tweetUrl)
        .eq('status', 'posting'));
    }
    if (error) throw error;
  } catch (err) {
    console.warn(`  ⚠ Status update failed: ${err.message}`);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  🐦  X-AUTOMATION v6 — X (TWITTER) CONTENT PIPELINE         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Started : ${new Date().toISOString()}`);
  console.log(`  Buffer  : ${process.env.BUFFER_API_KEY ? '✓' : '✗ (dry run)'}`);
  console.log(`  LLM     : ${llmKeys.totalKeys} OpenRouter key(s) loaded`);
  console.log(`  Apify   : ${apifyKeys.totalKeys} key(s) loaded`);
  console.log(`  Target  : ${POSTS_PER_RUN} posts this run`);
  console.log('');
  const pipeline = 'v6';
  const run = startRun(pipeline);

  try {
    // Check daily count
    const todayCount = await getTodayXPostCount();
    const globalTodayCount = await getTodayGlobalPostCount();
    console.log(`  📊 Today's X posts: ${todayCount}/${DAILY_TARGET}`);
    if (todayCount >= DAILY_TARGET || globalTodayCount >= GLOBAL_DAILY_MAX) {
      console.log(`  ✅ Daily target reached! Skipping.`);
      await run.noPosts(0);
      return;
    }
    const remaining = DAILY_TARGET - todayCount;
    const globalRemaining = GLOBAL_DAILY_MAX - globalTodayCount;
    const postsToMake = Math.min(POSTS_PER_RUN, remaining, globalRemaining);
    console.log(`  📈 Need ${remaining} X posts and ${globalRemaining} total slots; will post ${postsToMake}`);

    // Check Apify balances
    console.log('\n  💰 Checking Apify balances...');
    await apifyKeys.checkBalances();

    // Fetch X posts
    console.log('\n▶ STEP 1: Scraping X accounts...');
    const xPosts = await fetchXPosts(apifyKeys, undefined, postsToMake + 2);

    if (xPosts.length === 0) {
      console.log('  ⚠ No X posts found. Exiting.');
      run.setApifyKeyStatus(apifyKeys.getStatus());
      await run.noPosts(5);
      await sendSlack(buildNoPostsMessage({ pipeline, subredditsScanned: 5, keyStatus: apifyKeys.getStatus(), llmKeyStatus: llmKeys.getStatus(), groqKeyStatus: getGroqKeyStatus() }));
      return;
    }

    // Select posts (dedup check). Non-English posts are KEPT — OpenRouter will
    // translate them to English during rewrite (avoids wasting scrape cost).
    console.log('\n▶ STEP 2: Selecting posts (dedup check)...');
    const selectedPosts = [];
    for (const post of xPosts) {
      if (selectedPosts.length >= postsToMake) break;
      if (!await isDuplicate(supabase, post.tweetUrl)) {
        if (post.imageUrl && !(await isMediaWithinLimits(post.imageUrl))) {
          console.log(`  ⚠ Skipping @${post.author} post (media exceeds Buffer limits)`);
          continue;
        }
        selectedPosts.push(post);
        console.log(`  ✓ Selected: @${post.author} — ${post.title.substring(0, 50)}...`);
      }
    }

    if (selectedPosts.length === 0) {
      console.log('  ⚠ All posts already posted. Exiting.');
      run.setApifyKeyStatus(apifyKeys.getStatus());
      await run.noPosts(5);
      return;
    }

    console.log(`\n  📝 Will post ${selectedPosts.length} posts this run`);
    run.setApifyKeyStatus(apifyKeys.getStatus());
    run.setMimoKeyStatus(llmKeys.getStatus());
    run.setGroqKeyStatus(getGroqKeyStatus());

    // Process each post
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < selectedPosts.length; i++) {
      const post = selectedPosts[i];
      const postNum = `[${i + 1}/${selectedPosts.length}]`;

      console.log(`\n${'═'.repeat(60)}`);
      console.log(`  POST ${postNum}: @${post.author} — ${post.title.substring(0, 60)}...`);
      console.log(`  ❤️ ${post.likes} | 🔄 ${post.retweets} | 💬 ${post.replies}`);
      console.log(`${'═'.repeat(60)}`);

      try {
        // Analyze image with Groq Vision before OpenRouter rewrite
        let visualBrief = null;
        if (post.imageUrl) {
          console.log(`\n  ▶ Analyzing image with Groq Vision...`);
          visualBrief = await generateImageBrief(post);
          if (visualBrief) {
            console.log(`  ✓ Vision brief: ${visualBrief.substring(0, 100)}...`);
          } else {
            console.log(`  ⚠ Vision brief failed — OpenRouter will rewrite without image context`);
          }
        }

        // Rewrite with OpenRouter (using Groq Vision breakdown if available)
        console.log(`\n  ▶ Rewriting with OpenRouter...`);
        const postText = await rewriteWithOpenRouter(post, visualBrief);

        if (!postText || postText.trim().length === 0) {
          console.log(`  ⚠ Rewrite failed or non-English — skipping post`);
          failCount++;
          continue;
        }
        console.log(`  ✓ Rewritten: ${postText.substring(0, 80)}...`);

        // Save to Supabase
        console.log(`  ▶ Saving to Supabase...`);
        await saveXPost(post, postText, 'posting');

        // Preserve direct video assets; use the image path for images and GIFs.
        console.log(`  ▶ Posting to X via Buffer...`);
        const bufferResult = post.videoUrl
          ? await postVideoToBuffer(postText, post.videoUrl, post.imageUrl || null)
          : await postSingleToBuffer(postText, post.imageUrl || post.gifUrl || null);

        await updateXPostStatus(post.tweetUrl, bufferResult.success ? 'published' : 'failed', bufferResult.postId || null, bufferResult.success ? null : bufferResult.reason);

        if (bufferResult.success) {
          successCount++;
          console.log(`  ✅ PUBLISHED! (${bufferResult.postId})`);

          // Slack notification
          const slackResult = await sendSlack(buildSuccessMessage({
            pipeline,
            text: postText,
            subreddit: post.author,
            upvotes: post.likes,
            imageUrl: post.imageUrl,
            redditUrl: post.tweetUrl,
            bufferId: bufferResult.postId,
            elapsed: ((Date.now() - startTime) / 1000).toFixed(1),
            keyStatus: apifyKeys.getStatus(),
            redditTitle: post.title,
            comments: post.replies,
            charCount: postText.length,
            llmKeyStatus: llmKeys.getStatus(),
            groqKeyStatus: getGroqKeyStatus(),
            modelUsed: visualBrief ? 'groq-vision+openrouter' : 'openrouter',
            todayCount: await getTodayXPostCount(),
          }));
          run.setSlackSent(slackResult.ok);
        } else {
          failCount++;
          console.log(`  ❌ Failed: ${bufferResult.reason}`);
        }

        // Delay between posts
        if (i < selectedPosts.length - 1) {
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
        keyStatus: apifyKeys.getStatus(),
        llmKeyStatus: llmKeys.getStatus(),
        groqKeyStatus: getGroqKeyStatus(),
      }));
      if (partialResult.ok) console.log('  ✓ Partial-failure alert sent to Slack');
    }

    // Summary
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const finalCount = await getTodayXPostCount();
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  📊  v6 PIPELINE COMPLETE                                    ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Posts  : ${String(`${successCount} success, ${failCount} failed`).padEnd(49)}║`);
    console.log(`║  Daily  : ${String(`${finalCount}/${DAILY_TARGET}`).padEnd(49)}║`);
    console.log(`║  Time   : ${String(`${elapsed}s`).padEnd(49)}║`);
    console.log('╚══════════════════════════════════════════════════════════════╝');

    await run.success();

  } catch (err) {
    console.error('\n❌ v6 PIPELINE FATAL:', err.message);
    const slackResult = await sendSlack(buildFailureMessage({ pipeline, step: 'pipeline', error: err.message, keyStatus: apifyKeys.getStatus(), llmKeyStatus: llmKeys.getStatus(), groqKeyStatus: getGroqKeyStatus() }));
    run.setSlackSent(slackResult.ok);
    await run.fail(err);
    process.exitCode = 1;
  }
}

process.on('unhandledRejection', (reason) => { console.error('❌ Unhandled:', reason); process.exitCode = 1; });
main().catch((err) => { console.error('❌ main() failed:', err); process.exitCode = 1; });
