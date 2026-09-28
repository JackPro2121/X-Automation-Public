/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   OpenRouter LLM client — PRIMARY tweet/post generator           ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Replaces MiMo (removed Aug 25, 2026 — all 4 keys 402'd).       ║
 * ║   Groq Vision stays for image briefs + last-resort fallback.     ║
 * ║                                                                  ║
 * ║   CLEAN MODEL CHAIN (pruned Aug 27, 2026 — live-tested):         ║
 * ║   Removed dumb/micro models that leaked prompt instructions:     ║
 * ║   - liquid/lfm-2.5-2.6b:free  → 2.6B tiny, echoes prompt text   ║
 * ║   - dots-studio/dots-3-note   → note model, not a tweet writer   ║
 * ║   - poolside/laguna-s-2.1     → code model, garbage tweets       ║
 * ║   - nvidia/nemotron-*:free    → thinking leaks, 403 storms       ║
 * ║                                                                  ║
 * ║   Remaining chain (all high-parameter, no thinking leaks):       ║
 * ║   1. minimax/minimax-m3:free  → #1 best (188c tweet, live-test) ║
 * ║   2. google/gemma-4-31b-it    → 31B params, clean output         ║
 * ║   3. z-ai/glm-5.2:free        → concise, value-focused           ║
 * ║   4. minimax/minimax-m2.7     → high-speed last resort           ║
 * ║                                                                  ║
 * ║   Excluded (permanently unusable):                               ║
 * ║   - thinkingmachines/inkling*:free   → 403 agentic-handler only  ║
 * ║   - nemotron-nano-omni-reasoning     → reasoning-by-design leak  ║
 * ║   - nemotron-3.5-content-safety      → classifier, not a writer  ║
 * ║                                                                  ║
 * ║   NOTE: OpenRouter free tier ≈ 50 requests/day per account.      ║
 * ║   Add OPENROUTER_API_KEY_2/_3 (more accounts) to raise quota —   ║
 * ║   keyManager rotates them automatically.                         ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import { stripReasoning } from './utils.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// ── Model selection is CONFIG-DRIVEN ──────────────────────────────────────────
// OpenRouter's free catalog churns constantly (models 404 every few weeks), so
// the active list lives in an env var, NOT hard-coded. Set OPENROUTER_MODELS to a
// comma-separated list (first = primary) and update it — no code change — whenever
// a model dies. Example:
//   OPENROUTER_MODELS="google/gemma-4-31b-it:free,meta-llama/llama-4-maverick:free"
//
// ⚠️ PREFER INSTRUCT (non-reasoning) MODELS. Reasoning models (nvidia/nemotron-*,
// *-thinking, deepseek-r1) emit chain-of-thought that leaks into posts. We still
// send reasoning:{exclude:true} and strip <think> as defense-in-depth, but an
// instruct model is the reliable choice.
//
// ── ORDER IS EVIDENCE-BASED, NOT PREFERENCE-BASED (Sep 15, 2026) ─────────────
// Repeat-probed 4x each against the live free tier:
//
//   google/gemma-4-31b-it:free            0/4 — HTTP 429 every attempt
//   google/gemma-4-26b-a4b-it:free        0/4 — HTTP 429 every attempt
//   nvidia/nemotron-3.5-lightning:free    4/4 — reliable, 2.0-6.8 s
//   nvidia/nemotron-3-super-120b-a12b:free 2/4 — flaky (empty content on failure)
//   nvidia/nemotron-3-ultra-550b-a55b:free 0/4 — timeout on every attempt
//
// The two instruct models were positions 1 and 2 in the chain and were BOTH
// completely dead, so every OpenRouter call burned two guaranteed 429s before
// reaching a working model. The reliable reasoning model now leads. The Gemma
// models are kept at the END rather than deleted — free-tier 429s are often
// shared-pool congestion that clears, and they produce the cleanest output when
// available, so they are worth an opportunistic attempt only after everything
// else has failed.
//
// The ultra-550b model was REMOVED: 0/4 with a 30 s timeout each time means it
// contributed nothing but a guaranteed half-minute stall per call.
//
// Re-verify with: node cron/verify_models.js
const DEFAULT_OPENROUTER_MODELS = [
  // Verified working — leads the chain.
  'nvidia/nemotron-3.5-lightning:free',    // 4/4, 2.0-6.8 s
  'nvidia/nemotron-3-super-120b-a12b:free',// 2/4 — flaky but capable
  // Instruct models, cleanest output when the free pool is not congested.
  'google/gemma-4-31b-it:free',            // 0/4 at probe time (429)
  'google/gemma-4-26b-a4b-it:free',        // 0/4 at probe time (429)
];

export function getOpenRouterModelChain() {
  // Single override (legacy) still honored as the primary.
  const primary = process.env.OPENROUTER_MODEL;
  const listEnv = process.env.OPENROUTER_MODELS;
  let chain;
  if (listEnv && listEnv.trim()) {
    chain = listEnv.split(',').map(s => s.trim()).filter(Boolean);
  } else {
    chain = [...DEFAULT_OPENROUTER_MODELS];
  }
  if (primary && !chain.includes(primary)) chain.unshift(primary);
  return chain;
}

/**
 * Call OpenRouter with multi-key rotation + model-chain fallback.
 *
 * @param {object} keys - keyManager instance ('OPENROUTER')
 * @param {object} opts
 * @param {string} opts.prompt - fully built prompt
 * @param {number} [opts.temperature=0.85]
 * @param {number} [opts.maxTokens=300]
 * @param {number} [opts.timeoutMs=20000] — kept low: an 11-model chain must not stall
 * @param {Function} [opts.validator] — optional function (rawText) => string | boolean | null to validate/clean
 * @returns {Promise<string|null>} raw completion text or null if all models fail
 */
export async function callOpenRouter(keys, { prompt, temperature = 0.85, maxTokens = 300, timeoutMs = 20000, validator = null }) {
  if (!keys || keys.totalKeys === 0) {
    console.warn('  ⚠ No OpenRouter keys configured');
    return null;
  }

  for (const model of getOpenRouterModelChain()) {
    try {
      const result = await keys.execute(async (apiKey) => {
        const res = await fetch(OPENROUTER_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            // OpenRouter attribution headers (recommended; enables free-tier analytics)
            'HTTP-Referer': 'https://x.com/M_jawad_yasin',
            'X-Title': 'X-Automation',
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature,
            max_tokens: maxTokens,
            // Tell OpenRouter to run the model WITHOUT emitting reasoning into the
            // content (works for reasoning-capable models; ignored by plain ones).
            // This is the primary defense against chain-of-thought leaking into posts.
            reasoning: { exclude: true },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`OpenRouter HTTP ${res.status} [${model}] ${body.substring(0, 100)}`);
        }
        return res.json();
      });

      // Defense-in-depth: strip any <think>…</think> / unclosed reasoning that a
      // model emitted into content despite reasoning:{exclude:true}.
      const text = stripReasoning(result?.choices?.[0]?.message?.content || '').trim();
      if (!text) throw new Error(`Empty content after reasoning-strip [${model}]`);

      if (typeof validator === 'function') {
        const validated = validator(text);
        if (!validated) {
          throw new Error(`Unusable output / failed validation [${model}]`);
        }
        console.log(`  ✓ OpenRouter [${model}] responded and passed validation`);
        return typeof validated === 'string' ? validated : text;
      }

      console.log(`  ✓ OpenRouter [${model}] responded`);
      return text;
    } catch (err) {
      console.warn(`  ⚠ OpenRouter model ${model} failed: ${err.message}`);
      // try next model in chain
    }
  }

  return null;
}
