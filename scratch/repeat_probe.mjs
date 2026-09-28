/**
 * Repeat-probe the models that failed, to separate PERSISTENT failures from
 * transient ones. A 429 from OpenRouter's shared free pool is usually transient;
 * a timeout on every attempt is not.
 *
 * Usage: node scratch/repeat_probe.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const envText = fs.readFileSync('.env.local', 'utf8');
const groqKey = envText.match(/^GROQ_API_KEY\s*=\s*(.+)$/m)[1].trim().replace(/^["']|["']$/g, '');
const orKeys = [...envText.matchAll(/^OPENROUTER_API_KEY(?:_\d+)?\s*=\s*(.+)$/gm)]
  .map((m) => m[1].trim().replace(/^["']|["']$/g, ''));
const gemKeys = [...envText.matchAll(/^GEMINI_API_KEY(?:_\d+)?\s*=\s*(.+)$/gm)]
  .map((m) => m[1].trim().replace(/^["']|["']$/g, ''));

const N = 4;

async function repeat(label, fn) {
  const out = [];
  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    let tag;
    try {
      const r = await fn();
      tag = r;
    } catch (err) {
      tag = err.name === 'TimeoutError' ? 'TIMEOUT' : 'ERR:' + err.message.slice(0, 40);
    }
    out.push(`${tag}(${Date.now() - t0}ms)`);
    await new Promise((r) => setTimeout(r, 700));
  }
  console.log(`  ${label.padEnd(42)} ${out.join('  ')}`);
}

async function gemini(model) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${gemKeys[0]}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: OK' }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
      }),
      signal: AbortSignal.timeout(30000),
    }
  );
  if (!r.ok) return `HTTP${r.status}`;
  const d = await r.json();
  const txt = String(d.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
  return txt ? 'ok' : `EMPTY:${d.candidates?.[0]?.finishReason}`;
}

async function openrouter(model) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${orKeys[0]}`,
      'HTTP-Referer': 'https://x.com/M_jawad_yasin',
      'X-Title': 'X-Automation',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      max_tokens: 256,
      temperature: 0,
      reasoning: { exclude: true },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) return `HTTP${r.status}`;
  const d = await r.json();
  const txt = String(d.choices?.[0]?.message?.content || '').trim();
  return txt ? 'ok' : `EMPTY:${d.choices?.[0]?.finish_reason}`;
}

async function groq(model) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      max_tokens: 256,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) return `HTTP${r.status}`;
  const d = await r.json();
  const txt = String(d.choices?.[0]?.message?.content || '').trim();
  return txt ? 'ok' : `EMPTY:${d.choices?.[0]?.finish_reason}`;
}

console.log(`Repeat probe, ${N} attempts each (700ms gap)\n`);

console.log('GEMINI (current primary chain):');
await repeat('gemini-3.8-flash', () => gemini('gemini-3.8-flash'));
await repeat('gemini-3.5-flash', () => gemini('gemini-3.5-flash'));
await repeat('gemini-3.1-flash-lite', () => gemini('gemini-3.1-flash-lite'));

console.log('\nOPENROUTER (current chain order):');
await repeat('google/gemma-4-31b-it:free', () => openrouter('google/gemma-4-31b-it:free'));
await repeat('google/gemma-4-26b-a4b-it:free', () => openrouter('google/gemma-4-26b-a4b-it:free'));
await repeat('nvidia/nemotron-3.5-lightning:free', () => openrouter('nvidia/nemotron-3.5-lightning:free'));
await repeat('nvidia/nemotron-3-super-120b-a12b:free', () => openrouter('nvidia/nemotron-3-super-120b-a12b:free'));
await repeat('nvidia/nemotron-3-ultra-550b-a55b:free', () => openrouter('nvidia/nemotron-3-ultra-550b-a55b:free'));

console.log('\nGROQ (new chain):');
await repeat('qwen/qwen3.8-27b', () => groq('qwen/qwen3.8-27b'));
await repeat('openai/gpt-oss-20b', () => groq('openai/gpt-oss-20b'));
await repeat('groq/compound-mini', () => groq('groq/compound-mini'));
