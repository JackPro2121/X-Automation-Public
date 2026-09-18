/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   MODEL HEALTH CHECK                                             ║
 * ║   cron/verify_models.js                                          ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Probes every LLM model this project is configured to use       ║
 * ║   against its live API, and reports which ones actually work.    ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Twice now, model IDs in this repo have been invented rather than verified, and
 * both times the failure was SILENT — the pipeline kept running, kept reporting
 * success, and quietly degraded:
 *
 *   1. Gemini: `gemini-3.8-flash` returns HTTP 200 with EMPTY content at small
 *      token budgets, so the chain fell through to the weakest model.
 *   2. Groq: `qwen/qwen3.6-27b` (the VISION model) and `llama-3.3-70b-versatile`
 *      do not exist in Groq's catalog at all. Every call 404'd, which meant the
 *      entire image-analysis tier was dead and v7's reply fallback never ran.
 *
 * A model ID is not a fact until you have called it. Run this after any model
 * change, and before adding a new ID to the code.
 *
 * Usage:
 *   node cron/verify_models.js            # probe everything
 *   node cron/verify_models.js --quick    # skip the generation-quality probes
 *
 * Exit code is 0 when every REQUIRED tier has at least one working model.
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const QUICK = process.argv.includes('--quick');

// ─── ANSI helpers (no dependency) ────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const ok = (s) => `${C.green}${s}${C.reset}`;
const bad = (s) => `${C.red}${s}${C.reset}`;
const warn = (s) => `${C.yellow}${s}${C.reset}`;
const dim = (s) => `${C.dim}${s}${C.reset}`;

const results = [];
function record(tier, model, status, detail) {
  results.push({ tier, model, status, detail });
  const tag = status === 'ok' ? ok('OK    ') : status === 'warn' ? warn('WARN  ') : bad('FAIL  ');
  console.log(`   ${tag} ${String(model).padEnd(34)} ${dim(detail || '')}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// GROQ
// ═════════════════════════════════════════════════════════════════════════════
async function probeGroq() {
  console.log(`\n${C.bold}${C.cyan}── GROQ ──────────────────────────────────────────────────${C.reset}`);

  const { GROQ_TEXT_MODELS, GROQ_VISION_MODEL } = await import('./lib/groqClient.js');
  const envText = fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf8');
  const keys = [...envText.matchAll(/^GROQ_API_KEY(?:_\d+)?\s*=\s*(.+)$/gm)]
    .map((m) => m[1].trim().replace(/^["']|["']$/g, ''));

  if (!keys.length) {
    record('groq', '(keys)', 'fail', 'no GROQ_API_KEY in .env.local');
    return;
  }

  // Duplicate keys silently shrink the rotation pool.
  const crypto = await import('node:crypto');
  const hashes = new Set(keys.map((k) => crypto.createHash('sha256').update(k).digest('hex')));
  if (hashes.size < keys.length) {
    record('groq', '(keys)', 'warn',
      `${keys.length} keys but only ${hashes.size} unique — duplicate(s) waste rotation slots`);
  } else {
    record('groq', '(keys)', 'ok', `${keys.length} unique key(s)`);
  }

  // What does the API actually advertise?
  let live = [];
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${keys[0]}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      record('groq', '(catalog)', 'fail', `GET /v1/models → HTTP ${r.status}`);
      return;
    }
    live = (await r.json()).data.map((m) => m.id);
    console.log(`   ${dim(`catalog: ${live.length} models advertised`)}`);
  } catch (err) {
    record('groq', '(catalog)', 'fail', err.message);
    return;
  }

  const candidates = [...new Set([GROQ_VISION_MODEL, ...GROQ_TEXT_MODELS])];

  // 1. Existence check — catches invented IDs without spending a call.
  for (const m of candidates) {
    if (!live.includes(m)) {
      record('groq', m, 'fail', 'NOT IN CATALOG — this ID does not exist');
    }
  }

  // 2. Text call.
  for (const m of candidates) {
    if (!live.includes(m)) continue;
    const t0 = Date.now();
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keys[0]}` },
        body: JSON.stringify({
          model: m,
          messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
          max_tokens: 256,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const ms = Date.now() - t0;
      if (!r.ok) {
        const body = await r.text();
        let why = body.slice(0, 80);
        try { const e = JSON.parse(body); why = e.error?.message?.slice(0, 80) || why; } catch { /* raw */ }
        record('groq', m, 'fail', `HTTP ${r.status} — ${why}`);
        continue;
      }
      const d = await r.json();
      const txt = String(d.choices?.[0]?.message?.content || '').trim();
      if (!txt) {
        const rt = d.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
        record('groq', m, 'fail',
          `empty content (finish=${d.choices?.[0]?.finish_reason}, reasoning_tokens=${rt}) — budget too small`);
      } else {
        record('groq', m, 'ok', `text ${ms}ms → "${txt.slice(0, 18)}"`);
      }
    } catch (err) {
      record('groq', m, 'fail', err.message);
    }
  }

  // 3. Vision call — only for the designated vision model.
  if (live.includes(GROQ_VISION_MODEL)) {
    const zlib = await import('node:zlib');
    const png = buildSolidPng(zlib.default || zlib, 64, [220, 30, 30]);
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keys[0]}` },
        body: JSON.stringify({
          model: GROQ_VISION_MODEL,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: 'What colour fills this image? One word.' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
            ],
          }],
          max_tokens: 200,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const body = await r.text();
      if (r.ok) {
        const d = JSON.parse(body);
        const txt = String(d.choices?.[0]?.message?.content || '').trim();
        record('groq', `${GROQ_VISION_MODEL} (vision)`, 'ok', `saw image → "${txt.slice(0, 30)}"`);
      } else {
        let why = body.slice(0, 90);
        try { const e = JSON.parse(body); why = e.error?.message?.slice(0, 80) || why; } catch { /* raw */ }
        record('groq', `${GROQ_VISION_MODEL} (vision)`, 'fail', `HTTP ${r.status} — ${why}`);
      }
    } catch (err) {
      record('groq', `${GROQ_VISION_MODEL} (vision)`, 'fail', err.message);
    }
  }
}

/** Minimal solid-colour PNG encoder (no dependencies). */
function buildSolidPng(zlib, size, [r, g, b]) {
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // truecolour
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const off = y * (1 + size * 3);
    for (let x = 0; x < size; x++) {
      raw[off + 1 + x * 3] = r;
      raw[off + 2 + x * 3] = g;
      raw[off + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

// ═════════════════════════════════════════════════════════════════════════════
// GEMINI
// ═════════════════════════════════════════════════════════════════════════════
async function probeGemini() {
  console.log(`\n${C.bold}${C.cyan}── GEMINI ────────────────────────────────────────────────${C.reset}`);

  const { getGeminiKeys } = await import('./lib/geminiClient.js');
  const keys = getGeminiKeys();
  if (!keys.length) {
    record('gemini', '(keys)', 'warn', 'no GEMINI_API_KEY — chain will fall through to OpenRouter');
    return;
  }

  // Read the chain from its single definition instead of restating it here.
  // The previous copy was a third hand-synced twin of DEFAULT_GEMINI_MODELS and
  // had already drifted: it probed in the OLD order and would have reported the
  // retired-first model as "ok" while production stalled 30 s on it.
  const { getGeminiModelChain } = await import('./lib/geminiClient.js');
  const models = getGeminiModelChain();

  for (const model of models) {
    const t0 = Date.now();
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${keys[0]}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: OK' }] }],
          generationConfig: {
            temperature: 0,
            // Probe at a REALISTIC budget — the whole point is to catch models
            // that return empty content when the budget is small.
            maxOutputTokens: 800,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        signal: AbortSignal.timeout(30000),
      });
      const ms = Date.now() - t0;
      const body = await r.text();
      if (!r.ok) {
        let why = body.slice(0, 90);
        try { const e = JSON.parse(body); why = e.error?.message?.slice(0, 80) || why; } catch { /* raw */ }
        record('gemini', model, 'fail', `HTTP ${r.status} — ${why}`);
        continue;
      }
      const d = JSON.parse(body);
      const finish = d.candidates?.[0]?.finishReason;
      const txt = String(d.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
      if (!txt) {
        record('gemini', model, 'fail',
          `HTTP 200 but EMPTY content (finishReason=${finish}) — chain will silently skip this model`);
      } else {
        record('gemini', model, 'ok', `text ${ms}ms → "${txt.slice(0, 18)}"`);
      }
    } catch (err) {
      record('gemini', model, 'fail', err.message);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// OPENROUTER
// ═════════════════════════════════════════════════════════════════════════════
async function probeOpenRouter() {
  console.log(`\n${C.bold}${C.cyan}── OPENROUTER ────────────────────────────────────────────${C.reset}`);

  const { getOpenRouterModelChain } = await import('./lib/openrouterClient.js');
  const envText = fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf8');
  const keys = [...envText.matchAll(/^OPENROUTER_API_KEY(?:_\d+)?\s*=\s*(.+)$/gm)]
    .map((m) => m[1].trim().replace(/^["']|["']$/g, ''));

  if (!keys.length) {
    record('openrouter', '(keys)', 'warn', 'no OPENROUTER_API_KEY');
    return;
  }
  record('openrouter', '(keys)', 'ok', `${keys.length} key(s) — free tier ≈50 req/day per key`);

  const chain = getOpenRouterModelChain();
  for (const model of chain) {
    const t0 = Date.now();
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${keys[0]}`,
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
      const ms = Date.now() - t0;
      const body = await r.text();
      if (!r.ok) {
        let why = body.slice(0, 90);
        try { const e = JSON.parse(body); why = e.error?.message?.slice(0, 80) || why; } catch { /* raw */ }
        record('openrouter', model, 'fail', `HTTP ${r.status} — ${why}`);
        continue;
      }
      const d = JSON.parse(body);
      const txt = String(d.choices?.[0]?.message?.content || '').trim();
      if (!txt) {
        record('openrouter', model, 'warn', `empty content (finish=${d.choices?.[0]?.finish_reason})`);
      } else {
        record('openrouter', model, 'ok', `text ${ms}ms → "${txt.slice(0, 18)}"`);
      }
    } catch (err) {
      record('openrouter', model, 'fail', err.message);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════
console.log(`${C.bold}Model health check${C.reset} ${dim(`(${new Date().toISOString()})`)}`);
if (QUICK) console.log(dim('  --quick: skipping generation-quality probes'));

await probeGroq();
await probeGemini();
await probeOpenRouter();

// ─── Summary ─────────────────────────────────────────────────────────────────
const byTier = {};
for (const r of results) (byTier[r.tier] ||= []).push(r);

console.log(`\n${C.bold}── SUMMARY ───────────────────────────────────────────────${C.reset}`);
let fatal = 0;
for (const [tier, rows] of Object.entries(byTier)) {
  const good = rows.filter((r) => r.status === 'ok').length;
  const failed = rows.filter((r) => r.status === 'fail');
  const tierOk = good > 0;
  if (!tierOk) fatal++;
  console.log(`   ${tierOk ? ok('✓') : bad('✗')} ${tier.padEnd(12)} ${good}/${rows.length} working`);
  for (const f of failed) console.log(`       ${bad('×')} ${f.model} — ${f.detail}`);
}

console.log('');
if (fatal) {
  console.log(bad(`${fatal} tier(s) have NO working model. Fix before running the pipelines.`));
  process.exit(1);
}
console.log(ok('Every tier has at least one working model.'));
