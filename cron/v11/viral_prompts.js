/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   X-AUTOMATION v11 — AI SYSTEMS NOTES                           ║
 * ║   cron/v11/viral_prompts.js                                      ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Generates concise AI engineering field notes and technical      ║
 * ║   discussion posts in a Claude-blog-style human voice.             ║
 * ║   Output: Original text posts with no generic engagement bait.    ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

import { createKeyManager } from '../lib/keyManager.js';
import { postSingleToBuffer } from '../lib/bufferClient.js';
import { MIN_TWEET_CHARS, X_SAFE_MAX_CHARS } from '../tweetLimits.js';
import { callOpenRouter } from '../lib/openrouterClient.js';
import { callGemini, isGeminiConfigured } from '../lib/geminiClient.js';
import { initGroqKeys, GROQ_TEXT_MODELS, GENERATION_MAX_TOKENS } from '../lib/groqClient.js';
import { sendSlack } from '../lib/slackClient.js';
import { startRun } from '../lib/logger.js';
import {
  validateEnv,
  generateId,
  finalizePostText,
  insertGeneratedPost,
  stripMarkdown,
  stripMentions,
  stripReasoning,
  hasFalseAttribution,
  isMetaTextCaption,
  isPlaceholderText,
} from '../lib/utils.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

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

// Key Managers
const llmKeys = createKeyManager('OPENROUTER', [
  process.env.OPENROUTER_API_KEY,
  process.env.OPENROUTER_API_KEY_2,
  process.env.OPENROUTER_API_KEY_3,
]);
const groqKeys = initGroqKeys();

// ─── Simple Groq text call ────────────────────────────────────────────────────
// Uses groqKeys.execute() so the call ROTATES across GROQ_API_KEY / _2 / _3.
// The previous `groqKeys.getCurrentKey?.()` was calling a method KeyManager does
// not have, so the optional chain silently fell through to GROQ_API_KEY alone —
// keys 2 and 3 were configured, reported in the banner as "3 key(s) loaded", and
// then never used.
async function callGroqText(promptText, { temperature = 0.85, maxTokens = GENERATION_MAX_TOKENS } = {}) {
  if (!groqKeys || groqKeys.totalKeys === 0) return null;
  for (const model of GROQ_TEXT_MODELS) {
    try {
      const text = await groqKeys.execute(async (key) => {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: promptText }],
            temperature,
            max_tokens: maxTokens,
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
        const json = await res.json();
        const content = json.choices?.[0]?.message?.content?.trim();
        if (!content) throw new Error('Groq returned empty content');
        return content;
      });
      if (text) return { text, modelUsed: model };
    } catch (err) {
      console.warn(`  ⚠ Groq model ${model} failed: ${err.message}`);
    }
  }
  return null;
}

export const V11_DAILY_MAX = parseInt(process.env.V11_DAILY_MAX || '1', 10);

// Bounds come from the shared limit source so they track X Premium instead of a
// hardcoded free-tier 280. The old literals (40/280) let 41-char posts ship and
// capped this Premium pipeline at free-tier length.
export const V11_MIN_CHARS = MIN_TWEET_CHARS;
export const V11_MAX_CHARS = X_SAFE_MAX_CHARS;

// ─── AI Systems Archetypes & Seeds ───────────────────────────────────────────

export const ARCHETYPES = [
  {
    id: 'founder_dilemma',
    name: 'Agent Reliability / Architecture Tradeoff',
    description: 'A practical AI-agent reliability or infrastructure tradeoff for builders.',
    seeds: [
      { scenario: 'An agent completes the task but the result is semantically wrong', question: 'Where do you add verification?' },
      { scenario: 'A tool call succeeds but the returned data is stale', question: 'What belongs in the agent state?' },
      { scenario: 'Context growth improves recall but destroys latency', question: 'Which tradeoff matters most in production?' },
      { scenario: 'A model is strong but the workflow has no failure boundary', question: 'What would you fix first?' },
    ],
  },
  {
    id: 'vibe_coding_debate',
    name: 'Agent Design & Developer Workflow',
    description: 'A technical observation about AI coding workflows, agent design, and developer productivity.',
    seeds: [
      { hook: 'AI coding speed is not the same as delivery speed', prompt: 'Explain where review, tests, and deployment still dominate.' },
      { hook: 'A generated feature is not a reliable feature', prompt: 'Describe the production checks that make generated code dependable.' },
      { hook: 'The most important agent capability is knowing when to stop', prompt: 'Discuss boundaries, retries, and escalation.' },
      { hook: 'Developer productivity improves only when feedback loops get shorter', prompt: 'Explain the architecture behind faster iteration.' },
    ],
  },
  {
    id: 'long_game_mindset',
    name: 'Production Field Notes',
    description: 'A grounded lesson from building or operating AI systems in production.',
    seeds: [
      { hook: 'The easiest AI feature to demo is often the hardest one to operate', prompt: 'Explain the hidden reliability cost.' },
      { hook: 'A smaller model with better context can outperform a larger model with worse context', prompt: 'Make the tradeoff concrete.' },
      { hook: 'Production AI is mostly observability, retries, and permission design', prompt: 'Explain what teams usually miss.' },
      { hook: 'The model is rarely the only bottleneck in an agent workflow', prompt: 'Identify the real constraint.' },
    ],
  },
  {
    id: 'single_question_magnet',
    name: 'Technical Question',
    description: 'A precise technical question that invites experienced builders to share implementation detail.',
    seeds: [
      { question: 'How do you validate tool output before an agent takes irreversible action?' },
      { question: 'What memory should a production agent keep between runs?' },
      { question: 'Which failure is harder to debug: a bad model answer or a bad tool result?' },
      { question: 'How do you detect when an agent is looping without wasting the rate limit?' },
      { question: 'What is your fallback path when the primary model provider is unavailable?' },
    ],
  },
  {
    id: 'contrarian_take',
    name: 'Systems Reality Check',
    description: 'A sharp, evidence-based challenge to a common assumption in AI engineering.',
    seeds: [
      { claim: 'More context does not automatically make an agent smarter', prompt: 'Explain the retrieval and noise tradeoff.' },
      { claim: 'A successful tool call is not evidence of a successful task', prompt: 'Describe the validation layer.' },
      { claim: 'The cheapest agent architecture is not always the best production architecture', prompt: 'Compare cost, latency, and failure recovery.' },
    ],
  },
  {
    id: 'algorithm_reality_check',
    name: 'AI Systems Reality Check',
    description: 'A practical observation about how AI systems behave under real production constraints.',
    seeds: [
      { thought: 'An agent that never fails in a demo is usually not finished.', prompt: 'Explain which production boundary is missing.' },
      { thought: 'The model is fast; the surrounding workflow is slow.', prompt: 'Show where the latency actually comes from.' },
      { thought: 'A good fallback is part of the product, not an error path.', prompt: 'Give a concrete AI-system example.' },
    ],
  },
];

// ─── Prompt Builder ──────────────────────────────────────────────────────────

export function buildPrompt(archetype, seed) {
  return `You are @M_jawad_yasin, an AI engineer and builder focused on production AI agents, local LLMs, and open-source infrastructure.

Write one useful, original X post in a direct peer-to-peer technical voice.

ASSIGNED THEME: ${archetype.name}
SEED CONCEPT: ${JSON.stringify(seed)}
Translate the seed into a production AI engineering, agent reliability, local LLM, or open-source infrastructure lesson. If the seed is off-topic, use only its underlying tension and do not write the seed literally.

VOICE:
- Answer first in the opening sentence.
- Add one specific technical insight, tradeoff, or practical lesson.
- Use natural short paragraphs and varied sentence rhythm.
- Speak to AI engineers, agent builders, founders, and indie developers.
- Do not repeat generic motivational or engagement-bait language.

ABSOLUTE RULES:
- Output only the finished post text.
- No markdown, labels, preamble, hashtags, or meta commentary.
- Write 300-700 characters. That is the working range for this account; the
  platform allows up to ${V11_MAX_CHARS} but that is a hard ceiling, never a target.
- Never pad, never restate the seed, and always finish your last sentence — a
  post cut off mid-thought is discarded, not published.
- Never claim you built, tested, or benchmarked a third-party product.
- Do not invent numbers, dates, prices, quotes, or authority.
- Do not ask users to drop URLs, like, bookmark, repost, follow, or engage.
- Do not end with generic phrases such as "Thoughts?" or "What do you think?"
- A question is allowed only when it is a precise technical question.
- Preserve the assigned theme, but add your own useful angle.`;
}

// ─── Generator with Fallback ──────────────────────────────────────────────────

/**
 * Normalize an LLM client's return value to the completion text.
 *
 * WHY THIS EXISTS
 * `callOpenRouter()` and `callGemini()` both return the completion as a plain
 * STRING. v11's Gemini tier read `if (res && res.text)` — `res.text` is
 * therefore always `undefined` and the tier was unreachable dead code. That is
 * the same signature mistake already fixed once for callOpenRouter (90cbfe7);
 * it was never applied to Gemini, so v11 silently ran on a single writer while
 * the startup banner advertised three.
 *
 * `groqClient`'s internal helpers DO return `{ text }`, so this accepts both
 * shapes rather than assuming one. Empty/whitespace becomes null so the caller
 * treats "no output" the same way regardless of which client produced it.
 *
 * @param {unknown} res
 * @returns {string|null}
 */
export function unwrapCompletion(res) {
  if (typeof res === 'string') return res.trim() || null;
  if (res && typeof res === 'object' && typeof res.text === 'string') {
    return res.text.trim() || null;
  }
  return null;
}

export async function generateViralPrompt(recentTexts = []) {
  const archetype = ARCHETYPES[Math.floor(Math.random() * ARCHETYPES.length)];
  const seed = archetype.seeds[Math.floor(Math.random() * archetype.seeds.length)];
  const prompt = buildPrompt(archetype, seed);

  console.log(`\n▶ Generating v11 post [Archetype: ${archetype.name}]...`);

  // 1. Try OpenRouter
  if (llmKeys && llmKeys.availableKeys > 0) {
    try {
      console.log('  ▶ Trying OpenRouter...');
      const text = unwrapCompletion(await callOpenRouter(llmKeys, {
        prompt,
        temperature: 0.85,
        maxTokens: GENERATION_MAX_TOKENS,
      }));
      if (text) {
        const cleaned = cleanOutput(text);
        if (isValidCandidate(cleaned, recentTexts)) {
          return { text: cleaned, archetype: archetype.id, model: 'openrouter' };
        }
      }
    } catch (err) {
      console.warn(`  ⚠ OpenRouter error: ${err.message}`);
    }
  }

  // 2. Try Gemini
  if (isGeminiConfigured()) {
    try {
      console.log('  ▶ Trying Gemini fallback...');
      const res = await callGemini(prompt, {
        temperature: 0.85,
        maxTokens: GENERATION_MAX_TOKENS,
      });
      // callGemini() returns the completion as a plain STRING, not {text}.
      // Reading `res.text` was always undefined, so this entire tier was
      // unreachable — the same signature mistake fixed for callOpenRouter in
      // 90cbfe7 and never applied here. Measured: v11 scored 0/5 publishable
      // before this fix and 8/8 after, with Gemini writing every post.
      const gemText = unwrapCompletion(res);
      if (gemText) {
        const cleaned = cleanOutput(gemText);
        if (isValidCandidate(cleaned, recentTexts)) {
          return { text: cleaned, archetype: archetype.id, model: 'gemini' };
        }
      }
    } catch (err) {
      console.warn(`  ⚠ Gemini error: ${err.message}`);
    }
  }

  // 3. Try Groq
  if (groqKeys.totalKeys > 0) {
    try {
      console.log('  ▶ Trying Groq fallback...');
      const res = await callGroqText(prompt, { temperature: 0.85, maxTokens: 150 });
      if (res && res.text) {
        const cleaned = cleanOutput(res.text);
        if (isValidCandidate(cleaned, recentTexts)) {
          return { text: cleaned, archetype: archetype.id, model: res.modelUsed || 'groq' };
        }
      }
    } catch (err) {
      console.warn(`  ⚠ Groq error: ${err.message}`);
    }
  }

  const fallbackCandidates = archetype.seeds
    .map((candidate) => formatCuratedSeed(archetype, candidate))
    .filter((candidate) => isValidCandidate(candidate, recentTexts));
  const directText = fallbackCandidates[0] || '';
  return { text: directText, archetype: archetype.id, model: 'curated_seed' };
}

function cleanOutput(text) {
  if (!text) return '';
  let t = stripMarkdown(text);
  t = stripMentions(t);
  t = stripReasoning(t);
  t = t.replace(/^["'`]|["'`]$/g, '').trim();
  return t;
}

function normalizeForDedup(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function dedupTokens(text) {
  return normalizeForDedup(text).split(' ').filter((token) => token.length > 2);
}

export function isSemanticDuplicate(text, recentTexts = []) {
  const currentTokens = new Set(dedupTokens(text));
  if (currentTokens.size === 0) return true;

  return recentTexts.some((previous) => {
    const previousTokens = new Set(dedupTokens(previous));
    if (previousTokens.size === 0) return false;
    let overlap = 0;
    for (const token of currentTokens) {
      if (previousTokens.has(token)) overlap += 1;
    }
    const union = new Set([...currentTokens, ...previousTokens]).size;
    return overlap / union >= 0.78;
  });
}

/**
 * Candidate gate for a single LLM tier.
 *
 * WHY THIS RUNS THE "MUST NEVER SHIP" GUARDS AND NOT JUST LENGTH
 *
 * This function decides whether a tier "won". If it accepts output that
 * `finalizePostText()` later rejects, the whole fallback chain is dead: the
 * caller returns this text as a valid candidate and never tries the next tier.
 *
 * Measured against the live free tier, that was exactly what happened. The
 * primary model (nvidia/nemotron-3.5-lightning:free) ignores
 * `reasoning: { exclude: true }` and emits its scratchpad as untagged prose
 * ("Here's a thinking process:\n\n1. Analyze the Request: ..." or "We need to
 * output a post, 280-24000 chars..."). A 5-run probe scored 0/5 publishable —
 * every output was 595-694 chars, over the 280 floor, with no false
 * attribution, so the old length+attribution-only check waved all of them
 * through as "valid". The caller then retried the same broken tier three times
 * and threw, never reaching Gemini (which returns a clean 757-char post on the
 * same prompt) or Groq.
 *
 * So the leak detectors belong HERE, not only in the finalizer. `finalizePostText`
 * stays the authority on the final string; this gate just refuses to hand the
 * chain a candidate the authority is guaranteed to throw away.
 */
export function isValidCandidate(text, recentTexts = []) {
  if (!text || text.length < V11_MIN_CHARS || text.length > V11_MAX_CHARS) return false;
  if (isMetaTextCaption(text)) return false;
  if (isPlaceholderText(text)) return false;
  if (hasFalseAttribution(text)) return false;
  return !isSemanticDuplicate(text, recentTexts);
}

function formatCuratedSeed(archetype, seed) {
  if (seed.question && seed.scenario) return `${seed.scenario}\n\n${seed.question}`;
  if (seed.hook && seed.detail) return `${seed.hook}\n\n${seed.detail}`;
  if (seed.claim) return seed.claim;
  if (seed.thought) return seed.thought;
  if (seed.question) return seed.question;
  return 'X is full of founders.\n\nSo... where are the customers?';
}

// ─── Supabase Helpers ────────────────────────────────────────────────────────

async function getTodayV11Count() {
  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const { count, error } = await getSupabase()
      .from('generated_posts')
      .select('*', { count: 'exact', head: true })
      .like('source_url', 'v11://%')
      .in('status', ['published', 'approved', 'posting'])
      .gte('db_created_at', todayStart.toISOString());
    if (error) throw error;
    return count || 0;
  } catch (err) {
    console.warn(`  ⚠ Could not get today's v11 count: ${err.message}`);
    console.warn('  🛑 Refusing to publish on an unknown daily count (fail-closed).');
    return V11_DAILY_MAX;
  }
}

async function loadRecentV11Texts(limit = 20) {
  try {
    const { data, error } = await getSupabase()
      .from('generated_posts')
      .select('generated_text')
      .like('source_url', 'v11://%')
      .order('db_created_at', { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data.map((d) => d.generated_text).filter(Boolean);
  } catch (err) {
    return [];
  }
}

async function getLastV11PostAgeMinutes() {
  try {
    const { data, error } = await getSupabase()
      .from('generated_posts')
      .select('db_created_at')
      .like('source_url', 'v11://%')
      .in('status', ['published', 'approved', 'posting'])
      .order('db_created_at', { ascending: false })
      .limit(1);
    if (!error && data && data.length === 0) {
      // No prior v11 post is not a failure state — the cooldown simply has not
      // started. Returning 0 here made the FIRST-EVER v11 post permanently
      // unpublishable on a clean database (0 minutes is always < the 35 minute
      // gap, so it could never recover). Fail-closed is for an UNKNOWN cooldown,
      // not for an absent one.
      return Number.POSITIVE_INFINITY;
    }
    if (error) {
      console.warn('  🛑 Cooldown state unknown (query failed) — refusing to publish (fail-closed).');
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

export async function main() {
  const startTime = Date.now();

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  ⚡  X-AUTOMATION v11 — VIRAL CONVERSATION MAGNETS           ║');
  console.log('║      Claude-blog Human Voice: AI Systems Notes               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Started : ${new Date().toISOString()}`);
  console.log(`  Buffer  : ${process.env.BUFFER_API_KEY ? '✓' : '✗ (dry run)'}`);
  console.log(`  LLM     : ${llmKeys.totalKeys} OpenRouter key(s) loaded`);
  console.log(`  Groq    : ${groqKeys.totalKeys} key(s) loaded`);

  const pipeline = 'v11';
  const run = startRun(pipeline);

  try {
    // 0. Daily budget check
    const todayCount = await getTodayV11Count();
    console.log(`  📊 v11 posts today: ${todayCount}/${V11_DAILY_MAX}`);
    if (todayCount >= V11_DAILY_MAX) {
      console.log('  ✅ v11 daily target reached — skipping this run.');
      await run.noPosts(0);
      return;
    }

    // 0b. Minimum spacing / cooldown gate (prevents double posting if two runners trigger simultaneously)
    const V11_MIN_GAP_MINUTES = parseInt(process.env.V11_MIN_GAP_MINUTES || '35', 10);
    const lastPostAge = await getLastV11PostAgeMinutes();
    const lastPostAgeLabel = Number.isFinite(lastPostAge) ? `${lastPostAge.toFixed(1)}m` : 'never';
    console.log(`  ⏱ Minutes since last v11 post: ${lastPostAgeLabel} (min gap: ${V11_MIN_GAP_MINUTES}m)`);
    if (lastPostAge < V11_MIN_GAP_MINUTES) {
      console.log(`  🛡 Cooldown active: Last v11 post was ${lastPostAgeLabel} ago (< ${V11_MIN_GAP_MINUTES}m). Skipping to prevent double-posting.`);
      await run.noPosts(0);
      return;
    }

    // 1. Load recent texts for dedup
    const recentTexts = await loadRecentV11Texts(30);

    // 2. Generate candidate
    let result = null;
    let finalized = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      result = await generateViralPrompt(recentTexts);
      finalized = finalizePostText(result.text, {
        minChars: V11_MIN_CHARS,
        label: 'v11',
      });
      if (finalized.ok) {
        break;
      }
      console.warn(`  ⚠ Attempt ${attempt} failed quality guard: ${finalized.reason}. Retrying...`);
    }

    if (!finalized || !finalized.ok) {
      throw new Error(`Failed to generate a valid post after 3 attempts: ${finalized?.reason}`);
    }

    const postText = finalized.text;
    console.log('\n--- FINAL POST PREVIEW ---');
    console.log(postText);
    console.log(`Length: ${postText.length} chars | Archetype: ${result.archetype} | Model: ${result.model}\n`);

    // 3. Save to Supabase (status: posting)
    const postId = generateId('v11');
    const sourceUrl = `v11://${result.archetype}/${Date.now()}`;
    const saved = await insertGeneratedPost(getSupabase(), {
      id: postId,
      original_post_id: sourceUrl,
      creator_handle: 'M_jawad_yasin',
      creator_name: 'AI Systems Notes',
      generated_text: postText,
      character_count: postText.length,
      status: 'posting',
      source_url: sourceUrl,
    }, {
      // insertGeneratedPost() reads `model` / `shape` / `derivation`. This
      // object was passing `modelUsed` / `archetype` / `pipeline` instead, so all
      // three telemetry columns were silently dropped on every v11 row and no v11
      // post could ever be attributed to the writer that produced it.
      model: result.model,
      shape: result.archetype,
    });
    if (!saved.ok) {
      throw new Error(`Supabase insert failed: ${saved.error}`);
    }
    console.log('  ✓ Saved to Supabase');

    // 4. Post to X via Buffer
    console.log('  ▶ Posting to X via Buffer...');
    const bufferResult = await postSingleToBuffer(postText, null);

    if (!bufferResult.success) {
      await getSupabase()
        .from('generated_posts')
        .update({ status: 'failed', error_message: bufferResult.reason })
        .eq('id', postId);
      throw new Error(`Buffer publishing failed: ${bufferResult.reason}`);
    }

    // 5. Update status to published
    await getSupabase()
      .from('generated_posts')
      .update({
        status: 'published',
        buffer_post_id: bufferResult.postId,
      })
      .eq('id', postId);
    console.log(`  ✅ PUBLISHED! (Buffer ID: ${bufferResult.postId})`);

    // 6. Slack Notification
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    await sendSlack({
      text: `🚀 *[v11] New Viral Conversation Magnet Published!* (Buffer ID: \`${bufferResult.postId}\`)\n\n>>>${postText}`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: '⚡ v11 Viral Conversation Magnet Published' }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Tweet:* \n>${postText.replace(/\n/g, '\n>')}\n\n*Archetype:* \`${result.archetype}\` | *Model:* \`${result.model}\` | *Length:* ${postText.length} chars | *Time:* ${elapsed}s`
          }
        }
      ]
    });
    run.setBufferResult(bufferResult.postId);
    await run.success();
    console.log(`\n  📊 v11 run complete — 1 published · ${elapsed}s`);

  } catch (err) {
    console.error(`\n❌ v11 Pipeline Error: ${err.message}`);
    await run.fail(err);
    await sendSlack({
      text: `❌ *[v11] Pipeline Failure:* ${err.message}`,
    });
    process.exit(1);
  }
}

// Direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
