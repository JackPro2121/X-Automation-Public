/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║   v7 TOP CREATOR REPLY SNIPER                                        ║
 * ║   cron/v7/sniper_reply.js                                            ║
 * ╠══════════════════════════════════════════════════════════════════════╣
 * ║   Strategy:                                                           ║
 * ║   1. Fetch recent tweets via X Bearer Token (free read)              ║
 * ║   2. Freshness gate: only tweets posted within last 30 minutes       ║
 * ║   3. Generate high-IQ engineering reply with Gemini 3.8 Flash        ║
 * ║   4. Post reply via headless Playwright (Chromium) — $0 cost         ║
 * ║   5. 60–150 second random delay between replies (anti-spam)          ║
 * ║   6. Max 3 replies per run, 24-hour cooldown per creator             ║
 * ║   7. Supabase dedup — never reply to the same tweet twice            ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * GitHub Secrets required (set on BOTH repos):
 *   X_USERNAME         — your @handle or email for X login
 *   X_PASSWORD         — your X account password
 *   X_BEARER_TOKEN     — X API v2 Bearer Token (free, read-only)
 *   GEMINI_API_KEY     — Primary LLM for reply generation
 *   VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — Dedup storage
 *   SLACK_BOT_TOKEN, SLACK_CHANNEL_ID — Notifications
 */

import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { callGemini, isGeminiConfigured } from '../lib/geminiClient.js';
import { callOpenRouter } from '../lib/openrouterClient.js';
import { createKeyManager } from '../lib/keyManager.js';
import { sendSlack } from '../lib/slackClient.js';
import { startRun } from '../lib/logger.js';
import {
  stripMarkdown, stripMentions, fixStaleModelNames,
  stripReasoning, isLikelyEnglish, isTooSimilarToSource, isMetaTextCaption,
} from '../lib/utils.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

// ─── Configuration ─────────────────────────────────────────────────────────

const MAX_REPLIES_PER_RUN  = 2;      // Safe cap per run (avoids rapid consecutive replies)
const MAX_CREATORS_PER_RUN = 8;      // Safe creator check cap per run (prevents rapid profile visits)
const FRESHNESS_MINUTES    = 60;     // Reply to tweets newer than 60 minutes
const COOLDOWN_HOURS       = 24;     // One reply per creator per 24 hours
const DELAY_MIN_MS         = 75_000; // 1.25 minute minimum delay between replies
const DELAY_MAX_MS         = 160_000;// 2.6 minute maximum delay between replies
const MAX_REPLY_CHARS      = 270;    // Hard cap under 280 X limit

// Verified top AI creators, founders, and frontier labs (ordered by tier)
const TARGET_CREATORS = [
  // Tier 1: AI Founders & CEOs
  'sama',         // Sam Altman — OpenAI CEO
  'karpathy',     // Andrej Karpathy — Eureka Labs / AI Pioneer
  'AravSrinivas', // Aravind Srinivas — Perplexity CEO
  'levelsio',     // Pieter Levels — NomadList / PhotoAI (Top indie builder)
  'amasad',       // Amjad Masad — Replit CEO
  'bindureddy',   // Bindu Reddy — Abacus.AI CEO
  'emostaque',    // Emad Mostaque — Schelling AI / Stability founder
  'gdb',          // Greg Brockman — OpenAI President

  // Tier 2: AI Leaders, Chief Scientists & Researchers
  'ylecun',       // Yann LeCun — Meta Chief AI Scientist
  'DrJimFan',     // Jim Fan — NVIDIA AI Research Lead
  'AndrewYNg',    // Andrew Ng — DeepLearning.AI / AI Pioneer
  'alexalbert__', // Alex Albert — Anthropic DevRel
  'swyx',         // Swyx — Latent Space & AI Engineer Foundation
  'nearcyan',     // Nearcyan — AI Researcher & Analyst

  // Tier 3: Elite AI Engineers, Builders & Educators
  'svpino',       // Santiago Valdarrama — ML Educator & Builder
  'rowancheung',  // Rowan Cheung — The Rundown AI founder
  'altryne',      // Altryne — AI Systems & Automation
  'bilawalsidhu', // Bilawal Sidhu — Spatial AI & 3D GenAI
  'rohanpaul_ai', // Rohan Paul — AI Engineer & LLM researcher
  'mreflow',      // Matt Wolfe — FutureTools / AI Curator

  // Tier 4: Frontier Labs (high-visibility announcement threads)
  'OpenAI',
  'AnthropicAI',
  'GoogleDeepMind',
  'Perplexity_AI',
];

// Cliche patterns — instant disqualify
const BANNED_CLICHES = [
  'great post', 'thanks for sharing', 'thank you for sharing',
  'interesting take', 'agree with this', 'well said', 'nice post',
  'awesome post', 'love this post', "couldn't agree more",
  'as an ai', 'i hope this helps', 'fascinating read',
  "couldn't have said it better", 'spot on',
];

// ─── Clients ───────────────────────────────────────────────────────────────

const supabase = (process.env.VITE_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const openRouterKeys = createKeyManager('OPENROUTER', [
  process.env.OPENROUTER_API_KEY,
  process.env.OPENROUTER_API_KEY_2,
  process.env.OPENROUTER_API_KEY_3,
].filter(Boolean));

// ─── Utility ───────────────────────────────────────────────────────────────

function shuffleArray(arr) {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function randomDelay(minMs = DELAY_MIN_MS, maxMs = DELAY_MAX_MS) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  const secs = Math.round(ms / 1000);
  console.log(`  Waiting ${secs}s before next reply...`);
  return new Promise(r => setTimeout(r, ms));
}

function randomShortDelay(minMs = 500, maxMs = 2500) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(r => setTimeout(r, ms));
}

// ─── X Tweet Fetcher (Bearer Token + Playwright DOM Fallback) ─────────────

async function fetchRecentTweets(username) {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) return { status: 'NO_TOKEN', tweets: [] };
  try {
    // Resolve username to user ID
    const userRes = await fetch(
      `https://api.twitter.com/2/users/by/username/${username}?user.fields=id`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }
    );
    if (userRes.status === 402 || userRes.status === 401) {
      return { status: 'CREDITS_DEPLETED', tweets: [] };
    }
    if (!userRes.ok) {
      console.warn(`  Could not resolve @${username}: HTTP ${userRes.status}`);
      return { status: 'ERROR', tweets: [] };
    }
    const userId = (await userRes.json())?.data?.id;
    if (!userId) return { status: 'NO_USER', tweets: [] };

    // Fetch last 5 tweets posted in the freshness window
    const cutoff = new Date(Date.now() - FRESHNESS_MINUTES * 60 * 1000).toISOString();
    const tRes = await fetch(
      `https://api.twitter.com/2/users/${userId}/tweets` +
      `?max_results=5&tweet.fields=id,text,created_at,public_metrics` +
      `&start_time=${cutoff}&exclude=retweets,replies`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }
    );
    if (tRes.status === 402 || tRes.status === 401) {
      return { status: 'CREDITS_DEPLETED', tweets: [] };
    }
    if (!tRes.ok) {
      console.warn(`  Timeline fetch failed for @${username}: HTTP ${tRes.status}`);
      return { status: 'ERROR', tweets: [] };
    }
    const tweets = (await tRes.json())?.data || [];
    return {
      status: 'OK',
      tweets: tweets.map(t => ({
        tweetId:   t.id,
        tweetUrl:  `https://x.com/${username}/status/${t.id}`,
        author:    username,
        text:      t.text,
        likes:     t.public_metrics?.like_count    || 0,
        replies:   t.public_metrics?.reply_count   || 0,
        retweets:  t.public_metrics?.retweet_count || 0,
      }))
    };
  } catch (err) {
    console.warn(`  Error fetching @${username}: ${err.message}`);
    return { status: 'ERROR', tweets: [] };
  }
}

async function fetchRecentTweetsViaBrowser(page, username) {
  try {
    await page.goto(`https://x.com/${username}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Natural human dwell time
    await randomShortDelay(2500, 4500);

    // Human-like scroll down to trigger dynamic loading of latest tweets
    await page.mouse.wheel(0, 400);
    await randomShortDelay(800, 1800);

    const tweets = await page.evaluate((author) => {
      const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]')).slice(0, 5);
      const results = [];
      for (const article of articles) {
        const textEl = article.querySelector('div[data-testid="tweetText"]');
        const text = textEl ? textEl.innerText.trim() : '';
        const linkEl = article.querySelector('a[href*="/status/"]');
        if (!linkEl) continue;
        const href = linkEl.getAttribute('href');
        const match = href.match(/\/status\/(\d+)/);
        if (!match) continue;
        const tweetId = match[1];
        const tweetUrl = `https://x.com/${author}/status/${tweetId}`;

        const timeEl = article.querySelector('time');
        const datetime = timeEl ? timeEl.getAttribute('datetime') : null;

        // Parse engagement counts if available in DOM
        let likes = 1;
        const likeBtn = article.querySelector('[data-testid="like"], [data-testid="unlike"]');
        if (likeBtn) {
          const rawNum = likeBtn.innerText.replace(/[^0-9]/g, '');
          if (rawNum) likes = parseInt(rawNum, 10);
        }

        results.push({
          tweetId,
          tweetUrl,
          author,
          text,
          createdAt: datetime,
          likes,
          replies: 0,
          retweets: 0,
        });
      }
      return results;
    }, username);

    const cutoff = Date.now() - FRESHNESS_MINUTES * 60 * 1000;
    return tweets.filter(t => {
      if (!t.createdAt) return true;
      return new Date(t.createdAt).getTime() >= cutoff;
    });
  } catch (err) {
    console.warn(`  Browser tweet scrape fallback failed for @${username}: ${err.message}`);
    return [];
  }
}

// ─── Supabase: Cooldown & Dedup ────────────────────────────────────────────

async function getCooldownState() {
  if (!supabase) return { recentAuthors: new Set(), repliedTweetIds: new Set() };
  try {
    const cutoff = new Date(Date.now() - COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from('comment_replies')
      .select('target_author, comment_id')
      .gte('created_at', cutoff);
    const recentAuthors   = new Set((data || []).map(r => r.target_author?.toLowerCase()).filter(Boolean));
    const repliedTweetIds = new Set((data || []).map(r => r.comment_id).filter(Boolean));
    console.log(`  Cooldown: ${recentAuthors.size} creators, ${repliedTweetIds.size} tweets already replied`);
    return { recentAuthors, repliedTweetIds };
  } catch (err) {
    console.warn(`  Supabase cooldown check failed: ${err.message}`);
    return { recentAuthors: new Set(), repliedTweetIds: new Set() };
  }
}

async function saveReplyToSupabase(tweetId, author, replyText, tweetUrl) {
  if (!supabase) return;
  try {
    await supabase.from('comment_replies').insert({
      comment_id:    tweetId,
      target_author: author.toLowerCase(),
      target_text:   '',            // tweet text not stored for privacy
      ai_reply_text: replyText,
      reply_type:    'outbound',
      status:        'published',
      created_at:    new Date().toISOString(),
    });
    console.log(`  Saved to Supabase (dedup)`);
  } catch (err) {
    console.warn(`  Supabase save failed: ${err.message}`);
  }
}

// ─── AI Reply Generation ───────────────────────────────────────────────────

function cleanReplyText(raw, sourceText = '') {
  if (!raw) return null;
  let text = stripReasoning(raw);
  if (!text) return null;
  text = stripMarkdown(text);
  text = stripMentions(text);
  text = fixStaleModelNames(text);
  text = text.replace(/^["']|["']$/g, '');
  text = text.replace(/#[\w]+/g, '');

  // Strip all forms of AI dashes, em-dashes, en-dashes, and double underscores
  text = text.replace(/[—–]/g, ', ');
  text = text.replace(/--+/g, ' ');
  text = text.replace(/__+/g, ' ');
  text = text.replace(/\s*-\s+/g, ', ');
  text = text.replace(/\s+/g, ' ').trim();

  const lower = text.toLowerCase();
  if (BANNED_CLICHES.some(c => lower.includes(c))) return null;

  if (text.length > MAX_REPLY_CHARS) {
    text = text.substring(0, MAX_REPLY_CHARS).replace(/\s+\S*$/, '');
  }
  if (text.length < 20 || !isLikelyEnglish(text)) return null;
  if (isMetaTextCaption(text)) return null;
  if (sourceText && isTooSimilarToSource(text, sourceText)) return null;
  if (!/[.!?"]$/.test(text.trim())) return null;

  return text;
}

async function generateSniperReply(author, tweetText) {
  const prompt = `You are @M_jawad_yasin — an elite AI systems engineer and builder on X.
A top tech creator just posted a tweet. Read their post carefully and write one punchy, high-signal reply that:
1. Directly addresses the specific technical detail, metric, or trade-off they mentioned.
2. Adds a sharp engineering nuance, real-world deployment reality, production latency/cost trap, or edge case they omitted (frame it from hands-on builder experience).
3. Compels the author and other verified engineers reading it to stop, think, and want to check your profile or reply.

TWEET BY @${author}:
"${tweetText}"

RULES (MANDATORY):
- NEVER say "Great post!", "Agree!", "Spot on!", "Thanks for sharing", or any praise/cheerleading.
- NEVER use generic AI buzzwords or filler ("In today's fast-moving landscape", "It is worth noting", "Kudos").
- NEVER use dashes, em-dashes (—), en-dashes (–), or double hyphens (--). Write natural, clean sentences separated by periods or commas.
- Do NOT paraphrase what they said. Add original insight only.
- 1 to 2 punchy, conversational sentences. Maximum ${MAX_REPLY_CHARS} characters.
- NO hashtags. NO @mentions. NO bullet points. NO markdown.
- Sound 100% like an authentic, articulate human builder typing a thoughtful comment from their desk.
- Must end with a period, exclamation mark, or question mark.

Write ONLY the reply text:`;

  if (isGeminiConfigured()) {
    try {
      const reply = await callGemini(prompt, {
        temperature: 0.82,
        maxTokens: 200,
        validator: (raw) => cleanReplyText(raw, tweetText) || null,
      });
      if (reply) { console.log(`  Reply generated via Gemini`); return reply; }
    } catch (err) {
      console.warn(`  Gemini failed: ${err.message}`);
    }
  }

  if (openRouterKeys) {
    try {
      const reply = await callOpenRouter(openRouterKeys, {
        prompt,
        temperature: 0.82,
        maxTokens: 180,
        validator: (raw) => cleanReplyText(raw, tweetText) || null,
      });
      if (reply) { console.log(`  Reply generated via OpenRouter`); return reply; }
    } catch (err) {
      console.warn(`  OpenRouter failed: ${err.message}`);
    }
  }

  return null;
}

// ─── Playwright: Session & Login ──────────────────────────────────────────

function parseCookies(raw) {
  if (!raw) return [];
  raw = raw.trim();
  let cookies = [];

  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        cookies = parsed.map(c => {
          let sameSite = 'Lax';
          if (c.sameSite) {
            const ss = String(c.sameSite).toLowerCase();
            if (ss === 'strict') sameSite = 'Strict';
            else if (ss === 'none') sameSite = 'None';
          }
          let domain = c.domain || '.x.com';
          if (!domain.startsWith('.')) domain = `.${domain}`;
          return {
            name: c.name,
            value: String(c.value),
            domain,
            path: c.path || '/',
            secure: c.secure ?? true,
            httpOnly: c.httpOnly ?? false,
            sameSite,
          };
        });
      } else if (typeof parsed === 'object') {
        cookies = Object.entries(parsed).map(([k, v]) => ({
          name: k,
          value: String(v),
          domain: '.x.com',
          path: '/',
          secure: true,
          sameSite: 'Lax',
        }));
      }
    } catch { /* fallback to semicolon delimited */ }
  }

  if (cookies.length === 0) {
    cookies = raw.split(';').map(pair => {
      const [name, ...val] = pair.trim().split('=');
      if (!name) return null;
      return {
        name: name.trim(),
        value: val.join('=').trim(),
        domain: '.x.com',
        path: '/',
        secure: true,
        sameSite: 'Lax',
      };
    }).filter(Boolean);
  }

  const hasAuthToken = cookies.some(c => c.name === 'auth_token');
  const hasCt0 = cookies.some(c => c.name === 'ct0');
  if (hasAuthToken && hasCt0) {
    console.log(`  ✓ Both auth_token and ct0 session cookies detected.`);
  } else if (hasAuthToken) {
    console.log(`  ✓ auth_token detected in cookies.`);
  }

  return cookies;
}

async function loginToX(page) {
  const username = process.env.X_USERNAME;
  const password = process.env.X_PASSWORD;
  const email    = process.env.X_EMAIL;
  if (!username || !password) throw new Error('X_USERNAME or X_PASSWORD not set');

  console.log(`  Navigating to X login...`);
  await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await randomShortDelay(2000, 3500);

  // Username field
  const userInput = page.locator('input[autocomplete="username"], input[name="text"]').first();
  await userInput.waitFor({ state: 'visible', timeout: 20000 });
  await userInput.fill(username);
  await randomShortDelay(500, 1000);

  // Next button
  await page.locator('div[role="button"]:has-text("Next"), button:has-text("Next")').first().click();
  await randomShortDelay(2000, 3500);

  // Handle extra verification step (X asks for phone, email, or handle if unusual IP detected)
  const verifyInput = page.locator('input[data-testid="ocfEnterTextTextInput"]');
  if (await verifyInput.isVisible({ timeout: 4000 }).catch(() => false)) {
    console.log(`  X extra verification challenge detected — answering`);
    const challengeVal = email || username.replace('@', '');
    await verifyInput.fill(challengeVal);
    await randomShortDelay(500, 900);
    await page.locator('div[role="button"]:has-text("Next"), button:has-text("Next")').first().click();
    await randomShortDelay(2000, 3500);
  }

  // Password field
  const passInput = page.locator('input[type="password"]').first();
  await passInput.waitFor({ state: 'visible', timeout: 15000 });
  await passInput.fill(password);
  await randomShortDelay(600, 1200);

  // Log in button
  await page.locator('div[role="button"]:has-text("Log in"), button:has-text("Log in")').first().click();
  await randomShortDelay(3500, 5000);

  const url = page.url();
  if (url.includes('/login') || url.includes('/flow')) {
    throw new Error(`Login failed — still on login page: ${url}`);
  }
  console.log(`  Successfully logged in to X`);
}

async function initXSession(browser) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Ch-Ua': '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
    },
  });

  // Mask automated browser indicators
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const cookies = parseCookies(process.env.X_COOKIES);
  if (cookies.length > 0) {
    console.log(`  Injecting ${cookies.length} session cookies into browser context...`);
    await context.addCookies(cookies);
    const page = await context.newPage();
    try {
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await randomShortDelay(2500, 4000);
      const url = page.url();
      if (!url.includes('/login') && !url.includes('/flow')) {
        console.log(`  ✓ Successfully authenticated via cookies (url: ${url})`);
        return { context, page };
      }
      console.warn(`  Cookie session redirected to ${url}. Attempting credential fallback...`);
      await sendSlack({ text: `⚠️ *v7 Sniper*: X_COOKIES session redirected to login page (${url}). Session cookies may be expired.` }).catch(() => {});
    } catch (e) {
      console.warn(`  Cookie verification failed: ${e.message}. Attempting credential fallback...`);
    }
  }

  // Fallback or default: login via username/password
  if (process.env.X_USERNAME && process.env.X_PASSWORD) {
    const page = await context.newPage();
    await loginToX(page);
    return { context, page };
  }

  throw new Error('X authentication failed: No valid session cookies or login credentials provided.');
}

async function postReplyViaPlaywright(page, tweetUrl, replyText) {
  try {
    console.log(`  Opening tweet: ${tweetUrl}`);
    await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await randomShortDelay(2500, 4500);

    // Natural human micro-scroll
    await page.mouse.wheel(0, 200);
    await randomShortDelay(500, 1000);

    // Look for existing inline reply box or click reply button to open modal
    let replyBox = page.locator('[data-testid="tweetTextarea_0"]').first();
    let isBoxVisible = await replyBox.isVisible().catch(() => false);

    if (!isBoxVisible) {
      // Click reply button to bring up compose modal
      const replyBtn = page.locator('[data-testid="reply"]').first();
      await replyBtn.waitFor({ state: 'visible', timeout: 15000 });
      await replyBtn.hover();
      await randomShortDelay(300, 700);
      await replyBtn.click();
      await randomShortDelay(1500, 2500);

      // Now wait for textarea in the modal or inline
      await replyBox.waitFor({ state: 'visible', timeout: 15000 });
    }

    await replyBox.click();
    await randomShortDelay(500, 1000);

    for (let i = 0; i < replyText.length; i++) {
      const char = replyText[i];
      await replyBox.type(char, { delay: Math.floor(Math.random() * 40 + 25) });
      if (char === ' ' && Math.random() < 0.15) {
        await randomShortDelay(150, 350);
      }
    }
    await randomShortDelay(1200, 2500);

    // Submit: Try tweetButton or tweetButtonInline
    const submitBtn = page.locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]').last();
    await submitBtn.waitFor({ state: 'visible', timeout: 10000 });
    await submitBtn.hover();
    await randomShortDelay(600, 1200);
    await submitBtn.click();
    await page.waitForTimeout(5000);

    // If modal close button is present or compose box still open, check if text was cleared
    const stillVisible = await replyBox.isVisible().catch(() => false);
    if (stillVisible) {
      const remainingText = await replyBox.innerText().catch(() => '');
      if (remainingText.trim().length > 0) {
        throw new Error('Compose box still open with text after submit — reply may have failed');
      }
    }

    console.log(`  ✓ Reply posted successfully via Playwright`);
    return { success: true };
  } catch (err) {
    console.error(`  Playwright reply failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ─── Slack Summary ─────────────────────────────────────────────────────────

async function notifySlack(posted, skipped, errors) {
  const lines = [
    `*🎯 v7 Sniper Reply — Run Complete*`,
    `✅ Replies posted: *${posted.length}*  |  ⏭ Skipped: ${skipped}  |  ❌ Errors: ${errors}`,
  ];
  if (posted.length > 0) {
    lines.push('');
    for (const r of posted) {
      lines.push(`• *@${r.author}*: _"${r.replyText.substring(0, 80)}…"_`);
      lines.push(`  <${r.tweetUrl}|View tweet>`);
    }
  }
  await sendSlack({ text: lines.join('\n') }).catch(() => {});
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== v7 TOP CREATOR REPLY SNIPER ===\n');
  const run = startRun('v7_comment_reply');

  if (!process.env.X_COOKIES && (!process.env.X_USERNAME || !process.env.X_PASSWORD)) {
    console.error('Either X_COOKIES or (X_USERNAME and X_PASSWORD) must be set');
    await run.fail('Missing X login credentials');
    process.exit(1);
  }

  // Step 1: Load cooldown state
  const { recentAuthors, repliedTweetIds } = await getCooldownState();

  // Step 2: Launch shared browser & session
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  let session = null;
  const posted = [];
  let skipped = 0;
  let errors  = 0;

  try {
    session = await initXSession(browser);

    // Step 3: Fetch fresh tweets from target creators (safe batching)
    const eligibleCreators = TARGET_CREATORS.filter(handle => !recentAuthors.has(handle.toLowerCase()));
    console.log(`  ${eligibleCreators.length}/${TARGET_CREATORS.length} creators eligible (not on 24h cooldown)`);

    // Shuffle and pick a safe randomized subset per run (protects account from rapid sequential profile visits)
    const scanBatch = shuffleArray(eligibleCreators).slice(0, MAX_CREATORS_PER_RUN);
    console.log(`\nChecking fresh tweets from ${scanBatch.length} creators: ${scanBatch.map(c => '@' + c).join(', ')}...`);

    const candidates = [];
    let apiCreditsDepleted = false;

    for (const handle of scanBatch) {
      let tweets = [];
      if (!apiCreditsDepleted && process.env.X_BEARER_TOKEN) {
        const apiRes = await fetchRecentTweets(handle);
        if (apiRes.status === 'CREDITS_DEPLETED') {
          console.warn(`  ⚠️ X API Bearer Token credits depleted (HTTP 402/401) — activating Playwright DOM fallback scraper!`);
          apiCreditsDepleted = true;
        } else if (apiRes.status === 'OK') {
          tweets = apiRes.tweets;
        }
      }

      if (tweets.length === 0 && (apiCreditsDepleted || !process.env.X_BEARER_TOKEN)) {
        console.log(`  Scanning @${handle} timeline via browser...`);
        tweets = await fetchRecentTweetsViaBrowser(session.page, handle);
      }

      if (tweets.length === 0) {
        console.log(`  @${handle}: no fresh tweets in last ${FRESHNESS_MINUTES}min`);
      } else {
        const best = tweets
          .filter(t => !repliedTweetIds.has(t.tweetId) && t.text && t.text.length > 30)
          .sort((a, b) => (b.likes + b.retweets * 2 + b.replies * 3) - (a.likes + a.retweets * 2 + a.replies * 3))[0];
        if (best) {
          console.log(`  @${handle}: "${best.text.substring(0, 60)}..." (likes:${best.likes})`);
          candidates.push(best);
        }
      }

      // Early stop: If we already have enough candidates to fulfill MAX_REPLIES_PER_RUN, stop scanning to preserve session safety
      if (candidates.length >= MAX_REPLIES_PER_RUN) {
        console.log(`  ✓ Found ${candidates.length} candidates — stopping scan early to protect session.`);
        break;
      }

      await randomShortDelay(2000, 4500);
    }

    if (candidates.length === 0) {
      console.log('\nNo fresh candidates found. Exiting.');
      await run.noPosts(scanBatch.length);
      await sendSlack({ text: '🎯 v7 Sniper: No fresh creator tweets this run.' }).catch(() => {});
      return;
    }

    console.log(`\nFound ${candidates.length} candidates — processing up to ${MAX_REPLIES_PER_RUN}`);

    for (let i = 0; i < Math.min(candidates.length, MAX_REPLIES_PER_RUN); i++) {
      const tweet = candidates[i];
      console.log(`\n[${i + 1}/${Math.min(candidates.length, MAX_REPLIES_PER_RUN)}] Sniping @${tweet.author}...`);

      // Generate reply
      const replyText = await generateSniperReply(tweet.author, tweet.text);
      if (!replyText) {
        console.warn(`  No quality reply generated — skipping`);
        skipped++;
        continue;
      }
      console.log(`  Reply: "${replyText}"`);

      // Post reply on shared session
      const result = await postReplyViaPlaywright(session.page, tweet.tweetUrl, replyText);
      if (result.success) {
        await saveReplyToSupabase(tweet.tweetId, tweet.author, replyText, tweet.tweetUrl);
        posted.push({ author: tweet.author, replyText, tweetUrl: tweet.tweetUrl });
      } else {
        errors++;
      }

      // Delay between replies (skip after last one)
      if (i < Math.min(candidates.length, MAX_REPLIES_PER_RUN) - 1) {
        await randomDelay();
      }
    }
  } finally {
    if (session?.context) await session.context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  await notifySlack(posted, skipped, errors);

  if (posted.length > 0) {
    const lastPosted = posted[posted.length - 1];
    run.setPost({
      title: `Reply to @${lastPosted.author}`,
      url: lastPosted.tweetUrl,
      generatedText: lastPosted.replyText,
    });
    await run.success();
  } else if (errors > 0) {
    await run.fail(`Encountered ${errors} reply errors via Playwright`);
  } else {
    await run.noPosts(MAX_CREATORS_PER_RUN);
  }

  console.log(`\n=== Done: ${posted.length} posted, ${skipped} skipped, ${errors} errors ===`);
}

main().catch(async err => {
  console.error('Fatal error:', err.message);
  await sendSlack({ text: `🚨 *v7 Sniper Fatal Error*: ${err.message}` }).catch(() => {});
  process.exit(1);
});

