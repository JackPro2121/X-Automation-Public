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

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

export function getOpenRouterModelChain() {
  return [
    // ── Tier 1: Proven high-quality tweet writers (Dumb/micro models permanently removed) ──
    process.env.OPENROUTER_MODEL || 'minimax/minimax-m3:free', // #1 best HOOK/BODY/CTA (live-tested)
    'google/gemma-4-31b-it:free',                             // 31B parameters — smart & clean
    'z-ai/glm-5.2:free',                                      // Fast & concise value delivery
    'minimax/minimax-m2.7:free',                              // High-speed fallback
  ];
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
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`OpenRouter HTTP ${res.status} [${model}] ${body.substring(0, 100)}`);
        }
        return res.json();
      });

      const text = result?.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error(`Empty content [${model}]`);

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
