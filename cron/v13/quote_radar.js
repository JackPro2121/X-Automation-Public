/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   APIFY QUOTE RADAR — Autonomous High-Authority Quote-Tweet Engine ║
 * ║   cron/v13/quote_radar.js                                        ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Monitors top AI engineering leaders on X via Apify,            ║
 * ║   generates senior counter-perspective with Ollama Gemma 31B,    ║
 * ║   and automatically publishes Quote Tweets via Buffer.           ║
 * ║   Algorithm Multiplier: Quote Tweet = 5.0 (10x of Like)          ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

import { postSingleToBuffer } from '../lib/bufferClient.js';
import { isOllamaConfigured, callOllama } from '../lib/ollamaClient.js';
import { callOpenRouter } from '../lib/openrouterClient.js';
import { callGemini, isGeminiConfigured } from '../lib/geminiClient.js';
import { createKeyManager } from '../lib/keyManager.js';
import { sendSlack, buildSuccessMessage } from '../lib/slackClient.js';
import { startRun } from '../lib/logger.js';
import {
  validateEnv,
  generateId,
  isDuplicate,
  insertGeneratedPost,
  getLastAccountPostAgeMinutes,
  stripMarkdown,
  stripMentions,
  stripReasoning,
  isGenericAIText,
} from '../lib/utils.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const APIFY_TOKEN = process.env.APIFY_API_TOKEN || process.env.APIFY_API_KEY;

// Curated breaking AI leaks, benchmarks, and model drop curators
const TARGET_HANDLES = [
  '0x0SojalSec',
  'RoundtableSpace',
];

const V13_DAILY_MAX = parseInt(process.env.V13_DAILY_MAX || '6', 10);

let supabase = null;
function getSupabase() {
  if (!supabase) {
    validateEnv(['VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
    supabase = createClient(
      process.env.VITE_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return supabase;
}

/**
 * Fetch latest high-impact posts from targeted leaders using Apify.
 * Uses apidojo~tweet-scraper ($0.0004/item, pay-per-event, ultra-low cost).
 */
async function fetchTargetPosts() {
  if (!APIFY_TOKEN) {
    console.warn('  ⚠ No APIFY_API_TOKEN found for Quote Radar.');
    return [];
  }

  // Pick one of the target handles to scan
  const shuffledHandles = [...TARGET_HANDLES].sort(() => Math.random() - 0.5);
  const handle = shuffledHandles[0];
  console.log(`  🔍 Scanning radar target: @${handle} on X...`);

  try {
    const actorId = 'apidojo~tweet-scraper';
    const runRes = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        twitterHandles: [handle],
        maxItems: 4,
        sort: 'Latest',
        onlyOriginalPosts: true,
      }),
      signal: AbortSignal.timeout(35000),
    });

    if (!runRes.ok) {
      console.warn(`  ⚠ Apify actor launch failed: HTTP ${runRes.status}`);
      return [];
    }

    const runData = await runRes.json();
    const runId = runData.data?.id;
    const datasetId = runData.data?.defaultDatasetId;
    if (!runId || !datasetId) return [];

    console.log(`  ⏳ Polling Apify run (${runId})...`);
    // Poll for completion (up to 70 seconds)
    let isSucceeded = false;
    for (let i = 0; i < 14; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const sRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
      if (sRes.ok) {
        const sData = await sRes.json();
        const status = sData.data?.status;
        if (status === 'SUCCEEDED') {
          isSucceeded = true;
          break;
        }
        if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
          console.warn(`  ⚠ Apify run ended with status: ${status}`);
          break;
        }
      }
    }

    if (!isSucceeded) {
      console.warn('  ⚠ Apify run timed out before completion.');
      return [];
    }

    const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=5`);
    if (!itemsRes.ok) return [];

    const items = await itemsRes.json();
    return items.map((it) => ({
      author: it.author?.userName || handle,
      text: it.text || it.full_text || '',
      url: it.url || `https://x.com/${handle}/status/${it.id}`,
      likes: it.likeCount || 0,
      retweets: it.retweetCount || 0,
    })).filter((p) => p.text && p.text.length > 30 && p.url);
  } catch (err) {
    console.warn(`  ⚠ Quote Radar scrape failed: ${err.message}`);
    return [];
  }
}

/**
 * Clean dashes and ensure clean paragraph spacing
 */
function cleanHumanCommentary(text) {
  if (!text) return '';
  return text
    .replace(/[—–]/g, ', ')       // Strict ban: replace em-dash and en-dash with comma
    .replace(/\s+-\s+/g, ', ')      // Replace isolated hyphens with comma
    .replace(/^[•\-\*]\s+/gm, '')   // Strip bullet list prefixes
    .replace(/\n{3,}/g, '\n\n')     // Normalize multiple blank lines to double newline
    .trim();
}

/**
 * Synthesize a natural human quote commentary using Gemma 31B.
 */
async function generateQuoteCommentary(targetPost) {
  const prompt = `You are Jawad (@M_jawad_yasin), a tech founder and senior AI systems engineer on X.
You are writing a Quote Tweet on this post from @${targetPost.author}:
"${targetPost.text}"

Write a 100% natural, human Quote Tweet commentary (180 - 320 characters).
Follow the exact style of top Silicon Valley founders and engineers on X:

FORMAT & SPACING RULES (MANDATORY):
- Write exactly 2 to 3 short micro-paragraphs separated by a blank line (double newline).
- Each paragraph must be only 1 to 2 short, punchy sentences.
- NEVER write a single solid block or wall of text.

LANGUAGE & VOICE:
- Casual, authentic American engineering voice. Speak like a real person writing from their desk.
- STRICTLY NO em-dashes (—), NO en-dashes (–), and NO hyphen dashes (-). Use periods or line breaks instead.
- ZERO emojis.
- ZERO generic AI fluff (ban: "delve", "testament", "pivotal", "crucial", "landscape", "furthermore", "it's worth noting", "game-changer", "let's dive in", "dive deep").
- Paragraph 1: The blunt hook or raw observation.
- Paragraph 2: The actual technical bottleneck, hardware reality, or engineering trade-off.
- Paragraph 3: A sharp human conclusion or reality check.

Output ONLY the final commentary text:`;

  if (isOllamaConfigured()) {
    try {
      const raw = await callOllama(prompt, { temperature: 0.75 });
      if (raw) {
        let t = cleanHumanCommentary(stripMarkdown(stripMentions(stripReasoning(raw))));
        if (t && t.length > 40 && !isGenericAIText(t)) {
          return { text: t, model: 'ollama:gemma4:31b' };
        }
      }
    } catch (e) {
      console.warn(`  ⚠ Ollama quote commentary failed: ${e.message}`);
    }
  }

  if (isGeminiConfigured()) {
    try {
      const raw = await callGemini(prompt, { temperature: 0.75 });
      if (raw) {
        let t = cleanHumanCommentary(stripMarkdown(stripMentions(stripReasoning(raw))));
        if (t && t.length > 40 && !isGenericAIText(t)) return { text: t, model: 'gemini' };
      }
    } catch (e) {}
  }

  return null;
}

export async function runQuoteRadar() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  🎯  X-AUTOMATION v13 — AUTONOMOUS QUOTE RADAR               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const run = startRun('v13_quote_radar');
  const db = getSupabase();

  try {
    // 0. Global account cooldown gate: prevents clumping across pipelines
    const GLOBAL_MIN_GAP_MINUTES = parseInt(process.env.GLOBAL_MIN_GAP_MINUTES || '60', 10);
    const lastAccountAge = await getLastAccountPostAgeMinutes(db);
    const lastAccountAgeLabel = Number.isFinite(lastAccountAge) ? `${lastAccountAge.toFixed(1)}m` : 'never';
    console.log(`  ⏱ Minutes since last account post: ${lastAccountAgeLabel} (min gap: ${GLOBAL_MIN_GAP_MINUTES}m)`);
    if (lastAccountAge < GLOBAL_MIN_GAP_MINUTES) {
      console.log(`  🛑 Global cooldown active: Last post on account was ${lastAccountAgeLabel} ago (< ${GLOBAL_MIN_GAP_MINUTES}m). Skipping to maintain feed spacing.`);
      await run.noPosts(0);
      return;
    }

    // Check daily posting ceiling
    const today = new Date().toISOString().split('T')[0];
    const { count, error: countErr } = await db
      .from('generated_posts')
      .select('id', { count: 'exact', head: true })
      .like('creator_handle', 'quote/%')
      .in('status', ['published', 'approved', 'posting'])
      .gte('db_created_at', `${today}T00:00:00Z`);

    if (!countErr && (count || 0) >= V13_DAILY_MAX) {
      console.log(`  ⏹ Daily ceiling reached for v13 (${count}/${V13_DAILY_MAX} posts today). Exiting gracefully.`);
      await run.noPosts(0);
      return;
    }

    const candidates = await fetchTargetPosts();
    if (candidates.length === 0) {
      console.log('  ⚠ No fresh target posts found from leaders. Exiting.');
      await run.noPosts(0);
      return;
    }

    for (const post of candidates) {
      if (await isDuplicate(db, post.url)) {
        console.log(`  … already quoted: ${post.url}`);
        continue;
      }

      console.log(`\n  ▶ Generating Quote Commentary for @${post.author}...`);
      const generated = await generateQuoteCommentary(post);
      if (!generated?.text) continue;

      // In Buffer, Quote Tweet is created by appending the target tweet URL to the commentary
      const finalTweetText = `${generated.text}\n\n${post.url}`;
      console.log(`  ✓ Quoting [${generated.model}]:\n${finalTweetText}`);

      const bufferResult = await postSingleToBuffer(finalTweetText);
      if (bufferResult.success) {
        console.log(`  ✅ Quote Tweet Published! (Buffer ID: ${bufferResult.postId})`);

        const postId = generateId('v13');
        await insertGeneratedPost(db, {
          id: postId,
          original_post_id: post.url,
          creator_handle: `quote/${post.author}`,
          creator_name: post.author,
          generated_text: finalTweetText,
          character_count: finalTweetText.length,
          status: 'published',
          buffer_post_id: bufferResult.postId,
          source_url: post.url,
        }, { model: generated.model, shape: 'quote_tweet' });

        await sendSlack(buildSuccessMessage({
          pipeline: 'v13 (Quote Radar)',
          text: finalTweetText,
          subreddit: 'x.com',
          upvotes: post.likes,
          redditUrl: post.url,
          bufferId: bufferResult.postId,
          elapsed: '8.2',
          redditTitle: `Quote on @${post.author}`,
          charCount: finalTweetText.length,
        }));

        await run.success(1);
        return;
      }
    }

    await run.noPosts(0);
  } catch (err) {
    console.error('  ❌ Quote Radar failed:', err.message);
    await run.failure(err.message);
  }
}

// CLI direct run
if (process.argv[1]?.endsWith('quote_radar.js')) {
  runQuoteRadar().catch(console.error);
}
