import dotenv from 'dotenv';
import path from 'path';

// Ensure .env.local is loaded
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Model chain: config-driven or defaults
const DEFAULT_GEMINI_MODELS = (process.env.GEMINI_MODELS && process.env.GEMINI_MODELS.trim())
  ? process.env.GEMINI_MODELS.split(',').map(s => s.trim()).filter(Boolean)
  : [
      'gemini-3.8-flash',       // Newest, fastest, best quality (Sep 2026)
      'gemini-3.5-flash',       // Stable, well-tested fallback
      'gemini-3.1-flash-lite',  // Lightweight last resort
    ];

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
 * Call the Gemini generateContent API with key rotation + model chain fallback.
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
    for (let ki = 0; ki < keys.length; ki++) {
      if (exhausted.has(ki)) continue;
      const apiKey = keys[ki];

      try {
        const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
              temperature,
              maxOutputTokens: maxTokens,
              thinkingConfig: {
                thinkingBudget: 0,
              },
              stopSequences: ['<think>', '</think>'],
            },
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
          if (isExhausted(res.status, body)) {
            console.warn(`  ⚠ [Gemini] Key #${ki + 1} exhausted (HTTP ${res.status}) — rotating`);
            exhausted.add(ki);
            continue;
          }
          throw new Error(`Gemini HTTP ${res.status} [${model}]: ${body.substring(0, 120)}`);
        }

        const data = JSON.parse(body);
        const finishReason = data?.candidates?.[0]?.finishReason;
        if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
          console.warn(`  ⚠ [Gemini] ${model} blocked (${finishReason}) — trying next model`);
          break;
        }

        const text = (data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
        if (!text) {
          throw new Error(`Empty content from Gemini [${model}]`);
        }

        if (typeof validator === 'function') {
          const validated = validator(text);
          if (!validated) {
            throw new Error(`Validation failed for Gemini [${model}]`);
          }
          console.log(`  ✓ Gemini [${model}] responded and passed validation`);
          return typeof validated === 'string' ? validated : text;
        }

        console.log(`  ✓ Gemini [${model}] responded`);
        return text;

      } catch (err) {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
          console.warn(`  ⚠ [Gemini] ${model} timed out — trying next model`);
          break;
        }
        console.warn(`  ⚠ [Gemini] ${model} key #${ki + 1}: ${err.message}`);
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
