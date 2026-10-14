/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   X-AUTOMATION v14 — CONVERSATIONAL PULSE & REPLY MAGNETS         ║
 * ║   cron/v14/conversational_pulse.js                               ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   High-frequency, ultra-short developer conversation drops        ║
 * ║   reverse-engineered from Dan Ellison's (@danellisona) formula.  ║
 * ║   Optimized for X Heavy Ranker: Reply Multiplier (13.5x-27x)     ║
 * ║   and Bookmark Multiplier (30x-50x) with zero external links.    ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

import { postSingleToBuffer } from '../lib/bufferClient.js';
import { isOllamaConfigured, callOllama } from '../lib/ollamaClient.js';
import { callGemini, isGeminiConfigured } from '../lib/geminiClient.js';
import { callOpenRouter } from '../lib/openrouterClient.js';
import { initGroqKeys, GROQ_TEXT_MODELS } from '../lib/groqClient.js';
import { createKeyManager } from '../lib/keyManager.js';
import { sendSlack, buildSuccessMessage } from '../lib/slackClient.js';
import { startRun } from '../lib/logger.js';
import {
  validateEnv,
  generateId,
  insertGeneratedPost,
  getLastAccountPostAgeMinutes,
  stripMarkdown,
  stripMentions,
  stripReasoning,
  formatPostWhitespace,
  isGenericAIText,
} from '../lib/utils.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

export const V14_DAILY_MAX = parseInt(process.env.V14_DAILY_MAX || '12', 10);
export const PIPELINE_NAME = 'v14_conversational_pulse';

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

// Key Managers for Fallbacks
const openRouterKeys = createKeyManager('OPENROUTER', [
  process.env.OPENROUTER_API_KEY,
  process.env.OPENROUTER_API_KEY_2,
  process.env.OPENROUTER_API_KEY_3,
]);
const groqKeys = initGroqKeys();

// ─── 6 Proven Content Archetypes (Reverse-Engineered from Dan Ellison) ───────

export const ARCHETYPES = [
  {
    id: 'reply_trap',
    name: 'Frictionless Reply Trap',
    goal: 'Zero-friction question that triggers instant opinion replies (Heavy Ranker 13.5x-27x)',
    fewShots: [
      'If you had an 8x B200 cluster for 30 days, what model are you fine-tuning?',
      'If you could only use ONE programming language for the rest of your career, what are you picking?',
      'If you had to launch your next startup without using any cloud APIs, what would you build?',
    ],
    topicAngles: [
      'unlimited B200 or H200 GPU compute usage',
      'building a startup with only one database engine',
      'hypothetical developer fantasy or engineering challenge',
      'coding without internet or AI assistants for a week',
    ],
  },
  {
    id: 'founder_truth',
    name: 'Visceral Founder / Engineering Truth',
    goal: 'Unspoken emotional truth that triggers bookmarks (Heavy Ranker 30x-50x)',
    fewShots: [
      'Nothing hurts an engineering team more than an architect who stopped writing code 3 years ago.',
      'The hardest part of building AI agents is not the model.\n\nIt is debugging silent failures in edge-case glue code.',
      'Nothing kills developer velocity faster than sprint planning meetings disguised as engineering progress.',
    ],
    topicAngles: [
      'architects vs hands-on engineers',
      'the hidden pain of technical debt and premature abstraction',
      'the emotional reality of solo building vs having a co-founder',
      'why silent failures in production hurt more than compile errors',
    ],
  },
  {
    id: 'tribal_contrast',
    name: 'Unpopular Opinion / Tribal Debate',
    goal: 'Polarizing contrast that ignites comments and quote tweets',
    fewShots: [
      'Unpopular opinion:\n\n90% of AI agent startups are just prompt wrappers over a local model loop.',
      'Unpopular opinion:\n\nDeepSeek V4.1 Flash at 185 tokens/sec beats 99% of cloud reasoning APIs for developer velocity.',
      'Unpopular opinion:\n\nGPT-6.1 Sol at $0.72 per task makes almost every closed reasoning API obsolete for 90% of SaaS apps.',
    ],
    topicAngles: [
      'AI wrappers vs real infra',
      'DeepSeek V4.1 Flash vs closed frontier reasoning APIs',
      'vibe coders vs engineers who write tests',
      'microservices vs boring monoliths in 2026',
    ],
  },
  {
    id: 'trend_jacking',
    name: 'Trend Jacking & Developer Reality',
    goal: 'Adopt viral tech meme (vibe coding, Cursor, Claude Code, local models) with a sharp developer spin',
    fewShots: [
      'What advice would you give a junior dev whose first coding language was Cursor?',
      'Vibe coding without understanding distributed state is an incident waiting to happen.',
      'Everyone wants extended reasoning models until they see the token bill and 20-second latency.',
    ],
    topicAngles: [
      'vibe coding vs real production software',
      'Claude Code and Cursor changing junior developer hiring',
      'reasoning models vs fast Flash models in production',
      'local inference on RTX 5090 vs cloud APIs',
    ],
  },
  {
    id: 'micro_dilemma',
    name: 'Micro-Dilemma & Real Hardware Scenarios',
    goal: 'Specific numbers or hardware choices that invite mentorship and advice',
    fewShots: [
      'I have an RTX 5090 with 32GB VRAM sitting idle.\n\nWhat local model are you spinning up tonight?',
      'You have a $500 monthly API budget.\n\nAre you paying for Claude Opus 5.5 tokens or self-hosting DeepSeek V4.1 on rented B200s?',
      'You get 48 hours to launch an MVP before demo day.\n\nAre you writing Python or TypeScript?',
    ],
    topicAngles: [
      'idle RTX 5090 GPU hardware decision',
      'tight cloud budget allocation (Claude Opus 5.5 tokens vs self-hosting DeepSeek V4.1)',
      '48-hour MVP tech stack choice',
      'choosing between open-source weights or proprietary reasoning endpoints',
    ],
  },
  {
    id: 'pick_one',
    name: 'Frictionless Pick ONE Choice',
    goal: 'List 3-4 competing tech choices requiring zero cognitive effort to answer',
    fewShots: [
      'Claude Opus 5.5. GPT-6 Astra. Gemini 4 Argon. Muse Wonder.\n\nPick ONE for production.',
      'GPT-6.1 Sol. DeepSeek V4.1 Flash. MiMo-V2.6-Pro. Grok 4.7.\n\nPick ONE for speed.',
      'Next.js. Vite. SvelteKit. Astro.\n\nPick ONE.',
      'PostgreSQL. SQLite. Redis. DynamoDB.\n\nPick ONE.',
    ],
    topicAngles: [
      'top 4 current frontier LLMs (Claude Opus 5.5, GPT-6 Astra, Gemini 4 Argon, Muse Wonder)',
      'top 4 fast & cost-efficient models (GPT-6.1 Sol, DeepSeek V4.1 Flash, MiMo-V2.6-Pro, Grok 4.7)',
      'top 4 frontend frameworks',
      'top 4 databases',
    ],
  },
];

/**
 * Pick an archetype with rotation to avoid back-to-back repetition.
 */
export function pickArchetype(recentIds = []) {
  const available = ARCHETYPES.filter((a) => !recentIds.slice(-2).includes(a.id));
  const pool = available.length > 0 ? available : ARCHETYPES;
  const index = Math.floor(Math.random() * pool.length);
  return pool[index];
}

/**
 * Build the prompt for Gemma 31B / Fallback LLMs.
 */
export function buildPulsePrompt(archetype) {
  const chosenAngle = archetype.topicAngles[Math.floor(Math.random() * archetype.topicAngles.length)];
  const examples = archetype.fewShots.map((ex) => `"${ex}"`).join('\n');

  return `You are Jawad (@M_jawad_yasin), a tech founder and senior AI systems engineer on X.
You are writing a single ultra-short, high-engagement conversation starter post on X.

ARCHETYPE: ${archetype.name}
GOAL: ${archetype.goal}
TOPIC FOCUS: ${chosenAngle}

STYLE EXAMPLES (STUDY THESE EXACT FORMATS):
${examples}

CURRENT 2026 FRONTIER AI ROSTER (USE ONLY CONTEMPORARY 2026 FRONTIER TECH):
- Flagship Frontier Reasoning Models:
  * Claude Opus 5.5 (Anthropic - #1 Artificial Analysis Intelligence Index score 58)
  * GPT-6 Astra (OpenAI - Flagship autonomous agentic and multi-step reasoning model)
  * Gemini 4 Argon (Google DeepMind - 1M+ context frontier multimodal reasoning)
  * Muse Wonder (Meta Superintelligence Labs - 131 tokens/sec high-intelligence frontier model)
  * Claude Fable 5.1 (Anthropic - Agentic creative and deep synthesis engine)
- High-Speed & Ultra-Low-Cost Frontier Models:
  * GPT-6.1 Sol (OpenAI - High-efficiency frontier intelligence at $0.72/task)
  * DeepSeek V4.1 Flash (DeepSeek - #1 Fastest inference at 185 tokens/sec, $0.27/task)
  * Grok 4.7 (xAI - Uncensored frontier reasoning, 82 tokens/sec)
  * MiMo-V2.6-Pro (Xiaomi/MiMo - Best price-to-performance in the world at $0.13/task)
  * GLM-5.3 (Zhipu AI - Top-tier bilingual coding and reasoning)
- Frontier Hardware & Dev Infrastructure:
  * Nvidia B200, H200, RTX 5090 (32GB VRAM), Mac M4 Max (128GB)
  * Developer tools: Claude Code, Cursor, Windsurf, local vLLM / Ollama

STRICTLY BANNED OUTDATED TECH (ZERO TOLERANCE - NEVER MENTION):
- NEVER mention obsolete models from past years (2023-2025):
  * OpenAI: GPT-4o, GPT-4, GPT-3.5, ChatGPT-4, o1, o3-mini (Use GPT-6 Astra or GPT-6.1 Sol)
  * Anthropic: Claude 3.7, Claude 3.5, Claude 3, Claude 2 (Use Claude Opus 5.5 or Claude Fable 5.1)
  * Google: Gemini 2.5, Gemini 2.0, Gemini 1.5, Gemini 1.0 (Use Gemini 4 Argon)
  * Meta: Llama 3.3, Llama 3, Llama 2 (Use Muse Wonder)
  * DeepSeek: DeepSeek-R1, DeepSeek-V3 (Use DeepSeek V4.1 Flash)
  * xAI: Grok 2, Grok 3 (Use Grok 4.7)
- NEVER mention obsolete hardware: H100, A100, RTX 4090. Use B200, H200, or RTX 5090 instead.

STRICT CONSTRAINTS (MANDATORY):
1. LENGTH: Between 40 and 140 characters. Maximum 1 to 3 short lines.
2. SPACING: If you use more than 1 line, separate them with a blank line (double newline).
3. VOICE: 100% natural American tech founder/engineer writing from an iPhone. Casual, punchy, real.
4. NO DASHES: STRICTLY ZERO em-dashes (—), ZERO en-dashes (–), and ZERO hyphens (-). Use commas, periods, or line breaks instead.
5. NO LINKS: Zero external URLs.
6. NO HASHTAGS: Zero hashtags (#).
7. EMOJIS: Max 0 or 1 emoji, or none.
8. BANNED WORDS: delve, tapestry, game-changer, revolutionize, unleash, crucial, pivotal, elevate, foster, mastering, in today's fast-paced world, it's not just about, at the end of the day, remember to.
9. OUTPUT ONLY the final post text. No explanations, no quotes, no labels.`;
}

/**
 * Automatically maps obsolete/stale model or hardware names to modern 2026 frontier equivalents.
 */
export function upgradeModelNames(text) {
  if (!text) return text;
  let result = text;

  const UPGRADES = [
    // OpenAI old -> 2026 Frontier
    [/\bGPT[- ]?4o\b/gi, 'GPT-6 Astra'],
    [/\bGPT[- ]?4[- ]?Turbo\b/gi, 'GPT-6 Astra'],
    [/\bGPT[- ]?4\b(?!\.\d)/gi, 'GPT-6 Astra'],
    [/\bGPT[- ]?3(?:\.5)?\b/gi, 'GPT-6 Astra'],
    [/\bChatGPT[- ]?4\b/gi, 'GPT-6 Astra'],
    [/\bo3[- ]?mini\b/gi, 'GPT-6.1 Sol'],
    [/\bo1\b(?!\w)/gi, 'GPT-6 Astra'],

    // Anthropic old -> 2026 Frontier
    [/\bClaude[- ]?3\.7(?:[- ]?Sonnet)?\b/gi, 'Claude Opus 5.5'],
    [/\bClaude[- ]?3\.5(?:[- ]?Sonnet)?\b/gi, 'Claude Opus 5.5'],
    [/\bClaude[- ]?3\b(?!\.[57])/gi, 'Claude Opus 5.5'],
    [/\bClaude[- ]?2\b/gi, 'Claude Opus 5.5'],

    // Google old -> 2026 Frontier
    [/\bGemini[- ]?2\.5(?:[- ]?Pro)?\b/gi, 'Gemini 4 Argon'],
    [/\bGemini[- ]?2\.0(?:[- ]?Flash)?\b/gi, 'Gemini 4 Argon'],
    [/\bGemini[- ]?1(?:\.[05])?(?:[- ]?Pro|[- ]?Flash)?\b/gi, 'Gemini 4 Argon'],

    // Meta old -> 2026 Frontier
    [/\bLlama[- ]?3\.3(?:[- ]?70B)?\b/gi, 'Muse Wonder'],
    [/\bLlama[- ]?3\b(?!\.[123])/gi, 'Muse Wonder'],
    [/\bLlama[- ]?2\b/gi, 'Muse Wonder'],

    // DeepSeek old -> 2026 Frontier
    [/\bDeepSeek[- ]?R1\b/gi, 'DeepSeek V4.1 Flash'],
    [/\bDeepSeek[- ]?V3\b/gi, 'DeepSeek V4.1 Flash'],

    // xAI old -> 2026 Frontier
    [/\bGrok[- ]?[23]\b/gi, 'Grok 4.7'],

    // Hardware
    [/\bH100\b/g, 'B200'],
    [/\bA100\b/g, 'H200'],
    [/\bRTX[- ]?4090\b/gi, 'RTX 5090'],
    [/\bRTX[- ]?3090\b/gi, 'RTX 5090'],
  ];

  for (const [pattern, replacement] of UPGRADES) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

/**
 * Strict post-processing cleaner for conversational pulse posts.
 */
export function cleanPulseText(rawText) {
  if (!rawText) return '';

  let text = stripReasoning(rawText);
  text = stripMarkdown(text);
  text = stripMentions(text);

  // Strip wrapping quotes
  text = text.replace(/^["'“”]+|["'“”]+$/g, '').trim();

  // Strict dash elimination (the hallmark of AI slop)
  text = text
    .replace(/[\u2014\u2013]/g, ', ')    // em-dash and en-dash to comma
    .replace(/\s+-\s+/g, ', ')           // isolated hyphens to comma
    .replace(/\s*--\s*/g, ', ')          // double hyphens to comma
    .replace(/^[•\-\*]\s+/gm, '')        // bullet markers to clean text
    .replace(/,\s*,/g, ', ')             // collapse double commas
    .replace(/[^\S\r\n]+,/g, ',');       // remove space before comma

  // Upgrade stale model or hardware names to modern 2026 frontier tech
  text = upgradeModelNames(text);

  // Clean spacing
  text = formatPostWhitespace(text);

  return text;
}

/**
 * Hard rejection regex for obsolete models and hardware from past years.
 */
export const OUTDATED_MODEL_REGEX = /\b(?:GPT[- ]?[345](?:\.\d+)?|GPT[- ]?4o|ChatGPT[- ]?4|o1|o3[- ]?mini|Claude[- ]?[1234](?:\.\d+)?|Claude[- ]?3\.[57]|Gemini[- ]?[123](?:\.\d+)?|Llama[- ]?[1234](?:\.\d+)?|DeepSeek[- ]?[RV][123]|Grok[- ]?[123]|[HA]100|RTX[- ]?[34]090)\b/i;

/**
 * Validates quality and constraints of pulse post.
 */
export function isPulseValid(text) {
  if (!text) return false;
  if (text.length < 35 || text.length > 175) return false;
  if (isGenericAIText(text)) return false;

  // Reject em-dashes or en-dashes
  if (/[—–]/.test(text)) return false;

  // Reject URLs or hashtags
  if (/https?:\/\/|#/i.test(text)) return false;

  // Reject empty lines or meta labels
  if (/^(tweet|post|here is|option|archetype):/i.test(text)) return false;

  // Hard reject any outdated models or obsolete hardware
  if (OUTDATED_MODEL_REGEX.test(text)) return false;

  return true;
}

/**
 * Generate post using Ollama Cloud (Tier 1) with fallbacks.
 */
export async function generatePulsePost(archetype) {
  const prompt = buildPulsePrompt(archetype);

  // ── Tier 1: Ollama Cloud (Gemma 31B) ──
  if (isOllamaConfigured()) {
    try {
      const raw = await callOllama(prompt, { temperature: 0.85 });
      if (raw) {
        const text = cleanPulseText(raw);
        if (isPulseValid(text)) {
          return { text, model: 'ollama:gemma4:31b', archetypeId: archetype.id };
        }
      }
    } catch (err) {
      console.warn(`  ⚠ Tier-1 Ollama failed: ${err.message}`);
    }
  }

  // ── Tier 2: Gemini 2.5 / Flash ──
  if (isGeminiConfigured()) {
    try {
      const raw = await callGemini(prompt, { temperature: 0.85 });
      if (raw) {
        const text = cleanPulseText(raw);
        if (isPulseValid(text)) {
          return { text, model: 'gemini', archetypeId: archetype.id };
        }
      }
    } catch (err) {
      console.warn(`  ⚠ Tier-2 Gemini failed: ${err.message}`);
    }
  }

  // ── Tier 3: OpenRouter ──
  if (openRouterKeys && openRouterKeys.totalKeys > 0) {
    try {
      const raw = await callOpenRouter(prompt, openRouterKeys, { temperature: 0.85 });
      if (raw) {
        const text = cleanPulseText(raw);
        if (isPulseValid(text)) {
          return { text, model: 'openrouter', archetypeId: archetype.id };
        }
      }
    } catch (err) {
      console.warn(`  ⚠ Tier-3 OpenRouter failed: ${err.message}`);
    }
  }

  // ── Tier 4: Groq ──
  if (groqKeys && groqKeys.totalKeys > 0) {
    for (const model of GROQ_TEXT_MODELS) {
      try {
        const raw = await groqKeys.execute(async (key) => {
          const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: prompt }],
              temperature: 0.85,
              max_tokens: 150,
            }),
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
          const json = await res.json();
          return json.choices?.[0]?.message?.content?.trim();
        });
        if (raw) {
          const text = cleanPulseText(raw);
          if (isPulseValid(text)) {
            return { text, model: `groq:${model}`, archetypeId: archetype.id };
          }
        }
      } catch (err) {
        console.warn(`  ⚠ Tier-4 Groq (${model}) failed: ${err.message}`);
      }
    }
  }

  return null;
}

/**
 * Main execution runner for v14 Conversational Pulse.
 */
export async function runConversationalPulse() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  ⚡  X-AUTOMATION v14 — CONVERSATIONAL PULSE ENGINE           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const run = startRun(PIPELINE_NAME);
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

    // 1. Check daily posting ceiling
    const today = new Date().toISOString().split('T')[0];
    const { count, error: countErr } = await db
      .from('generated_posts')
      .select('id', { count: 'exact', head: true })
      .like('source_url', 'v14://%')
      .in('status', ['published', 'approved', 'posting'])
      .gte('db_created_at', `${today}T00:00:00Z`);

    if (!countErr && (count || 0) >= V14_DAILY_MAX) {
      console.log(`  ⏹ Daily ceiling reached for v14 (${count}/${V14_DAILY_MAX} posts today). Exiting gracefully.`);
      await run.noPosts(0);
      return;
    }

    // 2. Fetch recent archetype history to enforce rotation
    const { data: recentPosts } = await db
      .from('generated_posts')
      .select('creator_handle')
      .like('source_url', 'v14://%')
      .order('db_created_at', { ascending: false })
      .limit(6);

    const recentArchetypes = (recentPosts || [])
      .map((p) => p.creator_handle?.replace('danellison_style/', ''))
      .filter(Boolean);

    const archetype = pickArchetype(recentArchetypes);
    console.log(`  🎯 Selected Archetype: [${archetype.id}] ${archetype.name}`);

    // 3. Generate candidate post via LLM tiers
    let candidate = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`  ⏳ Generating pulse candidate (Attempt ${attempt}/3)...`);
      candidate = await generatePulsePost(archetype);
      if (candidate?.text) {
        // Check for duplicate against existing posts in DB
        const { data: existing } = await db
          .from('generated_posts')
          .select('id')
          .eq('generated_text', candidate.text)
          .limit(1);

        if (!existing || existing.length === 0) {
          break;
        }
        console.warn(`  ⚠ Generated text is duplicate in DB. Retrying...`);
        candidate = null;
      }
    }

    if (!candidate?.text) {
      console.warn('  ⚠ Failed to generate valid pulse post across all attempts and tiers.');
      await run.failed('Generation failed across all LLM tiers');
      return;
    }

    console.log(`\n  📝 Output [${candidate.model}] (${candidate.text.length} chars):`);
    console.log(`  ────────────────────────────────────────────────────────────`);
    console.log(`  ${candidate.text.replace(/\n/g, '\n  ')}`);
    console.log(`  ────────────────────────────────────────────────────────────\n`);

    const sourceUrl = `v14://${candidate.archetypeId}/${Date.now()}`;
    const postId = generateId('v14');

    // 4. Publish to Buffer via shareNow (pure text, zero external links)
    const bufferResult = await postSingleToBuffer(candidate.text);
    if (!bufferResult.success) {
      console.error(`  ❌ Buffer post failed: ${bufferResult.reason || 'Unknown error'}`);
      await insertGeneratedPost(db, {
        id: postId,
        original_post_id: sourceUrl,
        creator_handle: `danellison_style/${candidate.archetypeId}`,
        creator_name: 'Conversational Pulse',
        generated_text: candidate.text,
        character_count: candidate.text.length,
        status: 'failed',
        error_message: bufferResult.reason || 'Buffer publication failed',
        source_url: sourceUrl,
      }, { model: candidate.model, shape: candidate.archetypeId });
      await run.failed(bufferResult.reason || 'Buffer failed');
      return;
    }

    console.log(`  ✅ Published via Buffer! (Buffer ID: ${bufferResult.postId})`);

    // 5. Insert successful post into Supabase
    await insertGeneratedPost(db, {
      id: postId,
      original_post_id: sourceUrl,
      creator_handle: `danellison_style/${candidate.archetypeId}`,
      creator_name: 'Conversational Pulse',
      generated_text: candidate.text,
      character_count: candidate.text.length,
      status: 'published',
      buffer_post_id: bufferResult.postId,
      source_url: sourceUrl,
    }, { model: candidate.model, shape: candidate.archetypeId });

    // 6. Slack Notification (non-blocking)
    try {
      await sendSlack(buildSuccessMessage('v14_conversational_pulse', {
        text: candidate.text,
        model: candidate.model,
        archetype: candidate.archetypeId,
        bufferPostId: bufferResult.postId,
      }));
    } catch (e) {}

    await run.success(1);
  } catch (err) {
    console.error(`  💥 Fatal error in v14 runner: ${err.message}`);
    await run.failed(err.message);
    process.exit(1);
  }
}

// Allow direct CLI execution: node cron/v14/conversational_pulse.js
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'))) {
  runConversationalPulse().catch((err) => {
    console.error('Fatal execution failure:', err);
    process.exit(1);
  });
}
