/**
 * Follow-up probe: confirm which Groq model actually does vision, and whether
 * the gpt-oss models need a larger token budget (they returned HTTP 200 with
 * EMPTY content at max_tokens=32 — the classic reasoning-model budget trap).
 *
 * Usage: node scratch/groq_probe2.mjs
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

const env = fs.readFileSync('.env.local', 'utf8');
const keys = [...env.matchAll(/^GROQ_API_KEY(?:_\d+)?\s*=\s*(.+)$/gm)]
  .map((m) => m[1].trim().replace(/^["']|["']$/g, ''));
const KEY = keys[0];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Solid-colour PNG of the given size. */
function solidPng(size, [r, g, b]) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour RGB
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const off = y * (1 + size * 3);
    raw[off] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      raw[off + 1 + x * 3] = r;
      raw[off + 2 + x * 3] = g;
      raw[off + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const RED_64 = solidPng(64, [220, 30, 30]).toString('base64');
console.log(`Test image: 64x64 solid red PNG, ${RED_64.length} base64 chars\n`);

// ── Vision test ──────────────────────────────────────────────────────────────
const visionCandidates = ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'groq/compound-mini'];
console.log('── Vision test (64x64 red image) ──');
for (const m of visionCandidates) {
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: m,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'What colour fills this image? Answer with one word.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_64}` } },
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
      console.log(`   VISION   ${m.padEnd(26)} -> "${txt.slice(0, 60)}"`);
    } else {
      let why = body.slice(0, 80);
      try { const e = JSON.parse(body); why = `${e.error?.code || ''} ${String(e.error?.message || '').slice(0, 70)}`; } catch { /* raw */ }
      console.log(`   no-img   ${m.padEnd(26)} HTTP ${r.status} ${why}`);
    }
  } catch (err) {
    console.log(`   no-img   ${m.padEnd(26)} ${err.message}`);
  }
}

// ── Token-budget test for the gpt-oss models ─────────────────────────────────
console.log('\n── gpt-oss token budget test ──');
for (const m of ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']) {
  for (const budget of [32, 256, 1024]) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model: m,
          messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
          max_tokens: budget,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const body = await r.text();
      if (r.ok) {
        const d = JSON.parse(body);
        const txt = String(d.choices?.[0]?.message?.content || '').trim();
        const reason = d.choices?.[0]?.finish_reason;
        const rt = d.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
        console.log(`   ${m.padEnd(24)} budget=${String(budget).padEnd(5)} -> "${txt.slice(0, 12)}" finish=${reason} reasoning_tokens=${rt}`);
      } else {
        console.log(`   ${m.padEnd(24)} budget=${String(budget).padEnd(5)} HTTP ${r.status}`);
      }
    } catch (err) {
      console.log(`   ${m.padEnd(24)} budget=${String(budget).padEnd(5)} ${err.message}`);
    }
  }
}

// ── Quality/latency comparison for the real task: write a short X post ───────
console.log('\n── Writing quality + latency (real task) ──');
const PROMPT = `Write ONE short X post (120-260 characters) about an AI coding agent that confidently rewrote a file nobody asked it to touch. Open with a 2-7 word blunt hook, then one concrete ironic detail, then a short question to the reader. Output only the post text, no quotes, no hashtags, no brackets.`;

for (const m of ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'groq/compound-mini', 'allam-2-7b']) {
  const t0 = Date.now();
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: m, messages: [{ role: 'user', content: PROMPT }], max_tokens: 800, temperature: 0.9 }),
      signal: AbortSignal.timeout(40000),
    });
    const ms = Date.now() - t0;
    const body = await r.text();
    if (r.ok) {
      const d = JSON.parse(body);
      const txt = String(d.choices?.[0]?.message?.content || '').trim();
      const hasBracket = /[[\]{}<>]/.test(txt);
      console.log(`   ${m.padEnd(24)} ${String(ms + 'ms').padEnd(8)} len=${String(txt.length).padEnd(5)} brackets=${hasBracket ? 'YES ⚠' : 'no'}`);
      console.log(`      "${txt.replace(/\n/g, ' | ').slice(0, 150)}"`);
    } else {
      console.log(`   ${m.padEnd(24)} ${String(ms + 'ms').padEnd(8)} HTTP ${r.status} ${body.slice(0, 60)}`);
    }
  } catch (err) {
    console.log(`   ${m.padEnd(24)} ${Date.now() - t0}ms  ${err.message}`);
  }
}
