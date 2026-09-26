/**
 * Measure what `buildVisualSpec` produces over REAL scraped sources.
 *
 * Before switching every pipeline to original visuals, I want to know the
 * distribution of card kinds and — more importantly — how often the text is too
 * thin to build a card at all (which is the case that silently falls back to a
 * borrowed image).
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const { buildVisualSpec } = await import('../cron/lib/visualFactory.js');

const sb = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Real published rows carry the text we generated; source_url gives us the
// original. We want the ORIGINAL title/body, so pull from the source-side fields.
const { data, error } = await sb
  .from('generated_posts')
  .select('id, generated_text, source_url, creator_handle, status, created_at')
  .order('created_at', { ascending: false })
  .limit(200);

if (error) {
  console.error('query failed:', error.message);
  process.exit(1);
}

console.log(`rows: ${data.length}\n`);

const kinds = { statCard: 0, insightCard: 0, NONE: 0 };
const noneSamples = [];
const statSamples = [];
const insightSamples = [];

for (const row of data) {
  // We do not have the source title in this table, so approximate the worst
  // case: the generated text alone. If a card is buildable from THAT, it is
  // buildable in production where we additionally pass the real title.
  const spec = buildVisualSpec({
    sourceTitle: row.generated_text || '',
    sourceText: '',
    generatedText: row.generated_text || '',
    eyebrow: 'AI NEWS',
  });

  if (!spec) {
    kinds.NONE++;
    if (noneSamples.length < 5) noneSamples.push({ id: row.id, len: (row.generated_text || '').length });
  } else if (spec.kind === 'statCard') {
    kinds.statCard++;
    if (statSamples.length < 5) statSamples.push({ id: row.id, stat: spec.stat, label: (spec.statLabel || '').slice(0, 70) });
  } else {
    kinds.insightCard++;
    if (insightSamples.length < 5) insightSamples.push({ id: row.id, headline: (spec.headline || '').slice(0, 70) });
  }
}

const total = data.length || 1;
const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;

console.log('── card kind distribution (worst case: generated text only) ──');
console.log(`  statCard    ${String(kinds.statCard).padStart(4)}  ${pct(kinds.statCard)}`);
console.log(`  insightCard ${String(kinds.insightCard).padStart(4)}  ${pct(kinds.insightCard)}`);
console.log(`  NONE (falls back to source image) ${String(kinds.NONE).padStart(4)}  ${pct(kinds.NONE)}`);

console.log('\n── NONE samples (these would borrow the source image) ──');
for (const s of noneSamples) console.log(`  ${s.id}  len=${s.len}`);

console.log('\n── statCard samples ──');
for (const s of statSamples) console.log(`  ${s.id}  stat="${s.stat}"  ${s.label}`);

console.log('\n── insightCard samples ──');
for (const s of insightSamples) console.log(`  ${s.id}  ${s.headline}`);
