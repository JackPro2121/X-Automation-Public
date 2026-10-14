/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   OLLAMA CLOUD CLIENT — Primary LLM Tier                         ║
 * ║   cron/lib/ollamaClient.js                                       ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Direct integration with Ollama Cloud API (https://ollama.com)  ║
 * ║   Primary Model: gemma4:31b                                      ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const OLLAMA_API_URL = process.env.OLLAMA_API_URL || 'https://ollama.com/api/chat';
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'gemma4:31b';
const TIMEOUT_MS = 35000;

let lastModelUsed = null;

export function isOllamaConfigured() {
  const key = process.env.OLLAMA_API_KEY;
  return Boolean(key && key.trim());
}

export function getLastOllamaModel() {
  return lastModelUsed || DEFAULT_MODEL;
}

/**
 * Call Ollama Cloud API to generate text.
 * @param {string} prompt - User instruction/prompt
 * @param {object} [opts]
 * @param {string} [opts.model] - override model
 * @param {number} [opts.temperature=0.7]
 * @returns {Promise<string|null>}
 */
export async function callOllama(prompt, opts = {}) {
  const apiKey = process.env.OLLAMA_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    return null;
  }

  const model = opts.model || DEFAULT_MODEL;
  lastModelUsed = model;

  const payload = {
    model,
    messages: [
      { role: 'user', content: prompt },
    ],
    stream: false,
    options: {
      temperature: opts.temperature ?? 0.7,
    },
  };

  try {
    const res = await fetch(OLLAMA_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`  ⚠ Ollama Cloud API HTTP ${res.status}: ${errText.slice(0, 160)}`);
      return null;
    }

    const data = await res.json();
    const content = data?.message?.content;
    if (!content || typeof content !== 'string' || !content.trim()) {
      console.warn('  ⚠ Ollama returned empty content');
      return null;
    }

    return content.trim();
  } catch (err) {
    console.warn(`  ⚠ Ollama call failed: ${err.message}`);
    return null;
  }
}
