/**
 * End-to-end proof that the visual path works on REAL data.
 *
 * Renders cards from a sample of actual stored posts and writes them to
 * scratch/visuals/ so they can be eyeballed. Also exercises the full
 * renderAndUpload path (Supabase Storage) if --upload is passed.
 *
 * The point: switching ORIGINAL_VISUALS=true in four workflows must not be done
 * on faith. If the renderer produces garbage on real input, the pipelines would
 * silently fall back to borrowed images and Axis A would stay wide open.
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const { buildVisualSpec, renderVisual, saveVisual, renderAndUpload, closeVisualFactory } =
  await import('../cron/lib/visualFactory.js');

const DO_UPLOAD = process.argv.includes('--upload');

const sb = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data, error } = await sb
  .from('generated_posts')
  .select('id, generated_text, creator_handle, status')
  .not('generated_text', 'is', null)
  .order('created_at', { ascending: false })
  .limit(120);

if (error) { console.error(error.message); process.exit(1); }

// Take a spread across the corpus rather than the first N.
const sample = [];
for (let i = 0; i < 12; i++) {
  const row = data[Math.floor((i + 1) * (data.length / 13))];
  if (row && (row.generated_text || '').length > 20) sample.push(row);
}

console.log(`Sampling ${sample.length} real posts\n`);

let rendered = 0, refused = 0, failed = 0;
const kinds = {};

for (const row of sample) {
  const spec = buildVisualSpec({
    sourceTitle: row.generated_text,
    sourceText: '',
    generatedText: row.generated_text,
    eyebrow: 'AI ENGINEERING',
    sourceLabel: row.creator_handle ? `via ${row.creator_handle}` : undefined,
  });

  if (!spec) {
    refused++;
    console.log(`  — refused   ${row.id}`);
    continue;
  }

  const r = await renderVisual(spec);
  if (!r.ok) {
    failed++;
    console.log(`  ✗ FAILED    ${row.id}  ${r.reason}`);
    continue;
  }

  rendered++;
  kinds[spec.kind] = (kinds[spec.kind] || 0) + 1;
  const p = saveVisual(r.buffer, `${spec.kind}-${row.id}.png`);
  const kb = Math.round(r.buffer.length / 1024);
  console.log(`  ✓ ${spec.kind.padEnd(12)} ${kb}KB  ${path.basename(p)}`);

  if (DO_UPLOAD) {
    const up = await renderAndUpload(spec, { filename: `probe-${row.id}.png` });
    console.log(`      upload: ${up.ok ? 'OK ' + up.url.slice(0, 78) : 'FAILED ' + up.reason}`);
  }
}

console.log(`\n── summary ──`);
console.log(`  rendered ${rendered}   refused ${refused}   failed ${failed}`);
console.log(`  kinds: ${JSON.stringify(kinds)}`);

await closeVisualFactory();
