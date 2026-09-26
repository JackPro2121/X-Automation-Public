/**
 * Live probe of the Groq API.
 *
 * Purpose: the model IDs hard-coded across this project were written by an LLM
 * and never verified. This script asks Groq which models exist, then actually
 * calls each candidate to find out which ones work — including whether any
 * support image input (the vision tier).
 *
 * Usage: node scratch/groq_probe.mjs
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

const env = fs.readFileSync('.env.local', 'utf8');
const keys = [...env.matchAll(/^GROQ_API_KEY(?:_\d+)?\s*=\s*(.+)$/gm)]
  .map((m) => m[1].trim().replace(/^["']|["']$/g, ''));

// ── Duplicate-key detection ──────────────────────────────────────────────────
const seen = new Map();
keys.forEach((k, i) => {
  const h = crypto.createHash('sha256').update(k).digest('hex').slice(0, 10);
  if (seen.has(h)) {
    console.log(`  ⚠ DUPLICATE: key#${seen.get(h) + 1} and key#${i + 1} are the SAME key`);
  } else {
    seen.set(h, i);
  }
});
console.log(`Groq keys: ${keys.length} found, ${seen.size} unique\n`);

// ── What the API actually advertises ─────────────────────────────────────────
const listRes = await fetch('https://api.groq.com/openai/v1/models', {
  headers: { Authorization: `Bearer ${keys[0]}` },
});
const live = (await listRes.json()).data.map((m) => m.id).sort();
console.log(`── Live /v1/models (${live.length}) ──`);
for (const id of live) console.log('   ' + id);
console.log('');

// ── Which of the IDs referenced in this repo actually exist ──────────────────
const referenced = [
  'qwen/qwen3.8-27b',
  'qwen/qwen3.6-27b',
  'llama-3.3-70b-versatile',
  'meta-llama/llama-3.3-70b-instruct',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'groq/compound',
  'groq/compound-mini',
  'allam-2-7b',
];
console.log('── Referenced in code: exists? ──');
for (const m of referenced) {
  console.log(`   ${live.includes(m) ? 'EXISTS  ' : 'MISSING '} ${m}`);
}
console.log('');

// ── Live text completion test on every advertised chat model ─────────────────
const chatModels = live.filter((m) => !/whisper|prompt-guard|orpheus/.test(m));
console.log('── Text completion probe ──');
const textOk = [];
for (const m of chatModels) {
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keys[0]}` },
      body: JSON.stringify({
        model: m,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 32,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(25000),
    });
    const body = await r.text();
    if (r.ok) {
      const d = JSON.parse(body);
      const txt = String(d.choices?.[0]?.message?.content || '').trim();
      console.log(`   OK      ${m.padEnd(32)} -> "${txt.slice(0, 24)}"`);
      textOk.push(m);
    } else {
      let why = body.slice(0, 90);
      try {
        const e = JSON.parse(body);
        why = `${e.error?.code || ''} ${String(e.error?.message || '').slice(0, 80)}`;
      } catch { /* keep raw */ }
      console.log(`   FAIL    ${m.padEnd(32)} HTTP ${r.status} ${why}`);
    }
  } catch (err) {
    console.log(`   FAIL    ${m.padEnd(32)} ${err.message}`);
  }
}
console.log('');

// ── Vision probe: does any model accept an image? ────────────────────────────
// 1x1 transparent PNG — smallest valid image payload.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
console.log('── Vision (image input) probe ──');
const visionOk = [];
for (const m of textOk) {
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keys[0]}` },
      body: JSON.stringify({
        model: m,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'What colour is this image? One word.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
          ],
        }],
        max_tokens: 32,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(25000),
    });
    const body = await r.text();
    if (r.ok) {
      const d = JSON.parse(body);
      const txt = String(d.choices?.[0]?.message?.content || '').trim();
      console.log(`   VISION  ${m.padEnd(32)} -> "${txt.slice(0, 40)}"`);
      visionOk.push(m);
    } else {
      let why = body.slice(0, 90);
      try {
        const e = JSON.parse(body);
        why = `${e.error?.code || ''} ${String(e.error?.message || '').slice(0, 70)}`;
      } catch { /* keep raw */ }
      console.log(`   no-img  ${m.padEnd(32)} HTTP ${r.status} ${why}`);
    }
  } catch (err) {
    console.log(`   no-img  ${m.padEnd(32)} ${err.message}`);
  }
}

console.log('');
console.log('══ SUMMARY ══');
console.log('text-capable  :', textOk.join(', ') || 'NONE');
console.log('vision-capable:', visionOk.join(', ') || 'NONE');
