/**
 * Introspect the `generated_posts` queue table: which columns exist, and whether
 * the SOURCE text is stored alongside the generated text.
 *
 * Why it matters: `auto_poster.js` is the queue consumer — the single choke point
 * where queued rows actually go live on X. It runs no finalizer, so it needs one.
 * But how much it can check depends on whether the source text is in the row: with
 * it, the consumer can run the full originality + information-delta chain; without
 * it, only the structural/quality/fabrication guards.
 *
 * Usage: node scratch/inspect_queue_schema.mjs
 */

import fs from 'node:fs';

const env = fs.readFileSync('.env.local', 'utf8');
const get = (k) => env.match(new RegExp(`^${k}\\s*=\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '');
const url = get('VITE_SUPABASE_URL');
const key = get('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !key) { console.error('Missing Supabase credentials in .env.local'); process.exit(1); }

const res = await fetch(`${url}/rest/v1/generated_posts?select=*&limit=3`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
});
if (!res.ok) { console.error(`HTTP ${res.status}: ${await res.text()}`); process.exit(1); }

const rows = await res.json();
if (!rows.length) { console.log('Table is empty — cannot introspect columns from a row.'); process.exit(0); }

const cols = Object.keys(rows[0]);
console.log(`generated_posts has ${cols.length} columns:\n`);
for (const c of cols) {
  const v = rows[0][c];
  const preview = v === null ? 'NULL' : String(v).replace(/\s+/g, ' ').slice(0, 55);
  console.log(`  ${c.padEnd(24)} ${preview}`);
}

const sourceish = cols.filter((c) => /source|title|url|subreddit|creator|text/.test(c));
console.log(`\nColumns that could carry SOURCE context:\n  ${sourceish.join('\n  ') || '(none)'}`);

const hasSourceText = cols.some((c) => /source_text|selected_post|original_text/.test(c));
console.log(`\nSource TEXT stored in the row? ${hasSourceText ? 'YES — full guard chain possible' : 'NO — structural/quality/fabrication guards only'}`);

// How much of the queue is populated, and by which pipeline?
const all = await (await fetch(`${url}/rest/v1/generated_posts?select=status,creator_handle,source_url,created_at&limit=1000`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
})).json();
const byStatus = {};
for (const r of all) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
console.log(`\nQueue composition (last ${all.length} rows):`);
for (const [s, n] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${s}`);
