import dotenv from 'dotenv';
import path from 'path';

// Ensure .env.local is loaded
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Model chain: config-driven or defaults
//
// ── ORDER IS EVIDENCE-BASED, NOT NEWEST-FIRST ────────────────────────────────
// Repeat-probed 4x each on Sep 15, 2026 (see `node cron/verify_models.js`):
//
//   gemini-3.5-flash       4/4 OK, ~850 ms   ← most reliable AND fastest
//   gemini-3.1-flash-lite  4/4 OK, ~1.5 s
//   gemini-3.8-flash       1/4 OK, 7.6 s when it works; HTTP 429 the other 3
//
// The newest model was first in this list purely because it was newest. It was
// actually failing 75% of the time, and burning 7.6 s on the occasions it did
// answer — while the whole time gemini-3.5-flash answered in under a second.
// Being newest is not the same as being available. It stays in the chain as an
// opportunistic last resort rather than the primary.
//
// ── RE-PROBED AT PRODUCTION SIZE (Sep 16, 2026) ──────────────────────────────
// The numbers above came from a small probe prompt ("Reply with exactly: OK").
// A tiny prompt succeeds against a degraded free tier; a real post does not.
// Re-probing at production load (~1.8k chars in, 900 tokens out) gave a very
// different picture, so the ordering and the comments are now evidence-based at
// the size that actually matters:
//
//   gemini-3.5-flash       HTTP 429 on EVERY attempt — quota exhausted
//   gemini-3.1-flash-lite  OK, ~1.2-1.7 s, correct length   ← only reliable model
//   gemini-3.8-flash       TIMEOUT at 30 s on EVERY attempt
//
// The practical consequence of the old order: every generation paid a 30-second
// stall on gemini-3.8-flash before reaching a model that works. The order below
// puts the only reliable model first and moves the dead weight last, where it
// costs nothing when the primary answers. Re-run `scratch/gemini_health.mjs
// --twice` after any model change — it probes at this size and prints raw HTTP.
const DEFAULT_GEMINI_MODELS = (process.env.GEMINI_MODELS && process.env.GEMINI_MODELS.trim())
  ? process.env.GEMINI_MODELS.split(',').map(s => s.trim()).filter(Boolean)
  : [
      'gemini-3.1-flash-lite',  // verified at production size, ~1.2-1.7 s — primary
      'gemini-3.5-flash',       // 429 as of Sep 16 — usable again when quota returns
      'gemini-3.8-flash',       // timeout-prone at production size — opportunistic only
    ];

/**
 * The model chain, in the order it will actually be tried.
 *
 * Exported so nothing has to keep a second copy. `cron/verify_models.js` used to
 * restate this list and had already drifted out of order — a probe that lies
 * about which model runs first is worse than no probe.
 *
 * @returns {string[]}
 */
export function getGeminiModelChain() {
  return [...DEFAULT_GEMINI_MODELS];
}

// Key pool: GEMINI_API_KEY through GEMINI_API_KEY_5
export function getGeminiKeys() {
  return [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY_5,
  ].filter(Boolean);
}

// Transient vs. exhausted error detection
function isExhausted(statusCode, body) {
  if (statusCode === 429) return true;  // rate limit
  if (statusCode === 403) return true;  // invalid key
  if (statusCode === 401) return true;  // bad credentials
  if (statusCode === 402) return true;  // billing issue
  const b = (body || '').toLowerCase();
  if (b.includes('quota')) return true;
  if (b.includes('invalid api key')) return true;
  if (b.includes('api_key_invalid')) return true;
  return false;
}

/**
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * A 5xx from Gemini is a *server-side* condition (the model is overloaded or
 * temporarily down). It is NOT key-specific. The old code threw on 5xx, which
 * meant the loop rotated through all 5 keys against the SAME broken model —
 * 5 wasted round-trips before it ever tried the next model, each potentially
 * burning its full 18s timeout. On a cron pipeline that is how a run dies.
 *
 * A 5xx should therefore: retry once with a short backoff (most 503s clear in
 * under a second), then BREAK to the next model rather than rotating keys.
 */
const TRANSIENT_STATUS = new Set([500, 502, 503, 504]);

/**
 * Minimum output budget per model. `gemini-3.8-flash` spends part of its budget
 * on internal reasoning and returns `finishReason: MAX_TOKENS` with EMPTY
 * content when the caller asks for something small (observed live: 300-token
 * request → HTTP 200, `"content": {}`, zero text). Callers asking for a short
 * post would therefore get a silent, total failure on the primary model.
 */
const MODEL_MIN_TOKENS = {
  'gemini-3.8-flash': 1024,
};

/** The model that produced the most recent successful response (observability). */
let lastUsedModel = null;

/** @returns {?string} model id of the last successful callGemini() response */
export function getLastGeminiModel() {
  return lastUsedModel;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Call the Gemini generateContent API with key rotation + model chain fallback.
 *
 * Failure handling contract:
 *   - 429/401/403/402 or quota errors → mark that KEY exhausted, rotate to next key
 *   - 500/502/503/504                  → retry once with backoff, then next MODEL
 *   - 404                              → model retired, next MODEL immediately
 *   - finishReason MAX_TOKENS w/o text → next MODEL (budget/capability problem)
 *   - finishReason SAFETY/RECITATION   → next MODEL
 *   - validator returns null           → next KEY, then next MODEL
 */
export async function callGemini(prompt, {
  temperature = 0.9,
  maxTokens = 600,
  timeoutMs = 18000,
  validator = null,
} = {}) {
  const keys = getGeminiKeys();
  if (keys.length === 0) {
    return null; // No Gemini keys configured — fallback to OpenRouter
  }

  const exhausted = new Set();

  for (const model of DEFAULT_GEMINI_MODELS) {
    // Never under-budget a model that needs headroom to emit any text at all.
    const budget = Math.max(maxTokens, MODEL_MIN_TOKENS[model] || 0);
    // Some models reject `thinkingConfig`; we only drop it after a 400 tells us so.
    let sendThinkingConfig = true;

    for (let ki = 0; ki < keys.length; ki++) {
      if (exhausted.has(ki)) continue;
      const apiKey = keys[ki];

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;
          const generationConfig = {
            temperature,
            maxOutputTokens: budget,
            stopSequences: ['<think>', '</think>'],
          };
          if (sendThinkingConfig) generationConfig.thinkingConfig = { thinkingBudget: 0 };

          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig,
              safetySettings: [
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
              ],
            }),
            signal: AbortSignal.timeout(timeoutMs),
          });

          const body = await res.text();

          if (!res.ok) {
            // A key-scoped problem — rotate the key.
            if (isExhausted(res.status, body)) {
              console.warn(`  ⚠ [Gemini] Key #${ki + 1} exhausted (HTTP ${res.status}) — rotating`);
              exhausted.add(ki);
              break; // next key
            }

            // A model-scoped problem — stop burning keys on it.
            if (res.status === 404) {
              console.warn(`  ⚠ [Gemini] ${model} not found (404) — retired or unavailable`);
              ki = keys.length; // break the key loop too
              break;
            }

            // Model does not accept thinkingConfig — retry this key without it.
            if (res.status === 400 && sendThinkingConfig && /thinking/i.test(body)) {
              console.warn(`  ⚠ [Gemini] ${model} rejected thinkingConfig — retrying without it`);
              sendThinkingConfig = false;
              attempt = 0; // re-run this attempt
              continue;
            }

            // Transient server-side condition — back off, then try the next model.
            if (TRANSIENT_STATUS.has(res.status)) {
              if (attempt === 1) {
                const backoff = 400 + Math.floor(Math.random() * 600);
                console.warn(`  ⚠ [Gemini] ${model} HTTP ${res.status} (transient) — retrying in ${backoff}ms`);
                await sleep(backoff);
                continue; // retry same key/model once
              }
              console.warn(`  ⚠ [Gemini] ${model} still HTTP ${res.status} — moving to next model`);
              ki = keys.length; // break the key loop too
              break;
            }

            throw new Error(`Gemini HTTP ${res.status} [${model}]: ${body.substring(0, 120)}`);
          }

          const data = JSON.parse(body);
          const finishReason = data?.candidates?.[0]?.finishReason;

          if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
            console.warn(`  ⚠ [Gemini] ${model} blocked (${finishReason}) — trying next model`);
            ki = keys.length;
            break;
          }

          const text = (data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();

          if (!text) {
            if (finishReason === 'MAX_TOKENS') {
              // Empty output caused by the token budget — a model-level problem.
              console.warn(`  ⚠ [Gemini] ${model} hit MAX_TOKENS (budget ${budget}) with no text — next model`);
              ki = keys.length;
              break;
            }
            throw new Error(`Empty content from Gemini [${model}]`);
          }

          if (typeof validator === 'function') {
            const validated = validator(text);
            if (!validated) {
              console.warn(`  ⚠ [Gemini] ${model} key #${ki + 1} failed validation — rotating key`);
              break; // next key
            }
            lastUsedModel = model;
            console.log(`  ✓ Gemini [${model}] responded and passed validation`);
            return typeof validated === 'string' ? validated : text;
          }

          lastUsedModel = model;
          console.log(`  ✓ Gemini [${model}] responded`);
          return text;

        } catch (err) {
          if (err.name === 'TimeoutError' || err.name === 'AbortError') {
            console.warn(`  ⚠ [Gemini] ${model} timed out — trying next model`);
            ki = keys.length;
            break;
          }
          console.warn(`  ⚠ [Gemini] ${model} key #${ki + 1}: ${err.message}`);
          break; // next key
        }
      }
    }
  }

  return null;
}

/**
 * Returns true if at least one GEMINI_API_KEY is configured.
 */
export function isGeminiConfigured() {
  return getGeminiKeys().length > 0;
}
