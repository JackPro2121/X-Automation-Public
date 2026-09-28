/**
 * Independent Gemini health check — NOT routed through cron/lib/geminiClient.js.
 *
 * Why a second probe exists when cron/verify_models.js already probes Gemini:
 * verify_models.js filters its own output through its own assumptions, and it
 * probes with a tiny prompt ("Reply with exactly: OK"). A tiny prompt succeeds
 * against a degraded free tier. The production prompt is ~1,800 characters and
 * asks for ~900 output tokens. Those are different loads.
 *
 * This script asks the API the same question production asks, at the same size,
 * and reports the raw HTTP status and the raw response body for anything that
 * is not a clean 200-with-text. No retries, no key rotation, no fallbacks —
 * when the answer is ambiguous, the point is to SEE the ambiguity.
 *
 * Usage:
 *   node scratch/gemini_health.mjs           # probe the configured chain once
 *   node scratch/gemini_health.mjs --twice   # run each model twice (catches 429s)
 */

import fs from 'node:fs';

const TWICE = process.argv.includes('--twice');

// ─── Keys ────────────────────────────────────────────────────────────────────
const env = fs.readFileSync('.env.local', 'utf8');
const keys = [...env.matchAll(/^GEMINI_API_KEY(_\d+)?\s*=\s*(.+)$/gm)]
  .map((m) => m[2].trim().replace(/^["']|["']$/g, ''));

const models = (env.match(/^GEMINI_MODELS\s*=\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const chain = models.length
  ? models
  : ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'];

console.log(`Gemini health — keys=${keys.length} models=${chain.join(', ')}`);
console.log(`${TWICE ? '2 attempts per model' : '1 attempt per model'}, realistic load (~1.8k in / 900 out)\n`);

// A prompt of the same shape and size the pipelines actually send.
const PROMPT = `You are @M_jawad_yasin, a working AI engineer and tech commentator on X.

CURRENT DATE: 2026-09-15

TASK: The post below is a SOURCE SIGNAL — it tells you what is happening right now.
Compute what follows from it. Do not restate it.

POST SHAPE FOR THIS ONE: "Single sharp take"

LENGTH: aim for 180 to 420 characters.

FACTUAL GROUNDING (critical — this account is monetized and audited):
- Use ONLY facts, names, numbers, benchmarks, and version numbers that appear in the POST below.
- If the source lacks a hard number, keep the claim qualitative.
- Never fabricate quotes or attribute claims to people/labs not named in the source.

ORIGINALITY:
- Ground every FACT in the source, but the TAKE must be YOURS.

TWEET RULES:
- Sound like a specific engineer with an opinion, not a press release.
- NO hashtags, NO markdown headers (#), NO bold (**).

POST TO WRITE ABOUT:
Title: Opus 5 High comes close, but Kimi K3 still leads on frontend benchmarks
Source: r/LocalLLaMA
Upvotes: 412

POST:`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const model of chain) {
  const attempts = TWICE ? 2 : 1;
  for (let a = 1; a <= attempts; a++) {
    const key = keys[0];
    const t0 = Date.now();
    let verdict;
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
            generationConfig: {
              temperature: 0.9,
              maxOutputTokens: 900,
              stopSequences: ['<think>', '</think>'],
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
          signal: AbortSignal.timeout(30000),
        },
      );
      const ms = Date.now() - t0;
      const body = await res.text();

      if (!res.ok) {
        let why = body.slice(0, 160);
        try { const e = JSON.parse(body); why = e.error?.message?.slice(0, 160) || why; } catch { /* raw */ }
        verdict = `HTTP ${res.status} in ${ms}ms — ${why}`;
      } else {
        const d = JSON.parse(body);
        const finish = d.candidates?.[0]?.finishReason;
        const txt = String(d.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
        if (!txt) {
          verdict = `HTTP 200 but EMPTY (finishReason=${finish}) in ${ms}ms — usage=${JSON.stringify(d.usageMetadata || {})}`;
        } else {
          verdict = `OK ${ms}ms — ${txt.length} chars · finish=${finish} · "${txt.slice(0, 60).replace(/\n/g, ' ')}"`;
        }
      }
    } catch (err) {
      verdict = `${err.name === 'TimeoutError' ? 'TIMEOUT' : 'ERROR'} after ${Date.now() - t0}ms — ${err.message}`;
    }
    console.log(`  ${model.padEnd(22)} attempt ${a}: ${verdict}`);
    if (a < attempts) await sleep(1500);
  }
}

console.log('\nDone. Exit code is informational only — read the lines above.');
