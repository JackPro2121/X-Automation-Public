/**
 * Pull real (source title -> generated post) pairs from Supabase pipeline_runs.
 *
 * These are the ground truth for tuning the paraphrase gate: every pair is a post
 * that ACTUALLY shipped, so the detector can be calibrated against production
 * data instead of intuition.
 *
 * Usage: node scratch/fetch_pairs.mjs
 */

import fs from 'node:fs';

const env = fs.readFileSync('.env.local', 'utf8');
const url = env.match(/^VITE_SUPABASE_URL\s*=\s*(.+)$/m)[1].trim().replace(/^["']|["']$/g, '');
const key = env.match(/^SUPABASE_SERVICE_ROLE_KEY\s*=\s*(.+)$/m)[1].trim().replace(/^["']|["']$/g, '');

const res = await fetch(
  `${url}/rest/v1/pipeline_runs?select=pipeline,selected_post_title,selected_post_url,generated_text,status,created_at&generated_text=not.is.null&selected_post_title=not.is.null&order=created_at.desc&limit=500`,
  { headers: { apikey: key, Authorization: `Bearer ${key}` } }
);

if (!res.ok) {
  console.error('HTTP', res.status, (await res.text()).slice(0, 300));
  process.exit(1);
}

const rows = await res.json();
const pairs = rows
  .filter((r) => r.selected_post_title && r.generated_text && r.generated_text.length > 80)
  .map((r) => ({
    pipeline: r.pipeline,
    source: r.selected_post_title,
    generated: r.generated_text,
    status: r.status,
    created_at: r.created_at,
  }));

fs.writeFileSync('scratch/pairs.json', JSON.stringify(pairs, null, 2));

console.log(`Fetched ${rows.length} runs -> ${pairs.length} usable (source, generated) pairs`);
const byPipeline = {};
for (const p of pairs) byPipeline[p.pipeline || '?'] = (byPipeline[p.pipeline || '?'] || 0) + 1;
console.log('by pipeline:', JSON.stringify(byPipeline));
console.log('saved -> scratch/pairs.json\n');

// Show a couple so the shape is visible
for (const p of pairs.slice(0, 2)) {
  console.log(`── [${p.pipeline}] ${p.status}`);
  console.log(`   SOURCE : ${p.source.slice(0, 150)}`);
  console.log(`   POST   : ${p.generated.replace(/\n/g, ' | ').slice(0, 150)}`);
  console.log('');
}
