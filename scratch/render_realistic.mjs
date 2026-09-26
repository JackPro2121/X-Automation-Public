/**
 * Render the cards the way the pipelines will ACTUALLY call them.
 *
 * The earlier probe passed the same string as sourceTitle and generatedText,
 * which is the degenerate case (and how I found the restatement bug). Production
 * is different: sourceTitle is the Reddit/X headline (a noun phrase), and
 * generatedText is our post (complete sentences). Those must look genuinely
 * different on the card, or the visual adds nothing.
 *
 * Also exercises the statCard path, which the previous probe never hit — all 12
 * samples came back insightCard, so statCard was untested against real input.
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const { buildVisualSpec, renderVisual, saveVisual, closeVisualFactory } =
  await import('../cron/lib/visualFactory.js');

const sb = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Realistic pairs modelled on the actual source shapes each pipeline sees.
const PAIRS = [
  {
    label: 'v3/v4 statCard (number in headline)',
    sourceTitle: 'GPT-5.6 cuts inference cost by 80% for long-context workloads',
    generatedText:
      'An 80% cost cut is not a pricing tweak, it is a change in what is viable. Workflows that were uneconomical at full price become default features. The constraint moves from budget to latency.',
    eyebrow: 'AI ENGINEERING',
    sourceLabel: 'r/LocalLLaMA',
  },
  {
    label: 'v4 insightCard (no number)',
    sourceTitle: 'We moved from AI will take our jobs to AI design my bedroom',
    generatedText:
      'The shift happened faster than the discourse anticipated. Models stopped being evaluated on what they replace and started being judged on taste. That is a different product category entirely.',
    eyebrow: 'AI ENGINEERING',
    sourceLabel: 'r/ChatGPT',
  },
  {
    label: 'v6 X-source (short headline)',
    sourceTitle: 'Local inference is finally practical on consumer hardware',
    generatedText:
      'Quantisation work did most of the heavy lifting here. Latency crossed the threshold where interactive use feels normal rather than experimental. The memory ceiling stopped being the blocker.',
    eyebrow: 'AI TOOLS',
    sourceLabel: '@somebuilder',
  },
  {
    label: 'catchup (long headline, must truncate on a word)',
    sourceTitle:
      'Benchmark results show that retrieval augmented generation consistently outperforms long context windows on documents exceeding two hundred thousand tokens',
    generatedText:
      'The result is less surprising than it looks. Retrieval scales with query specificity while context windows scale with cost. They solve different problems.',
    eyebrow: 'AI ENGINEERING',
    sourceLabel: 'r/MachineLearning',
  },
];

console.log(`Rendering ${PAIRS.length} realistic pipeline inputs\n`);

for (const p of PAIRS) {
  const spec = buildVisualSpec(p);
  if (!spec) { console.log(`  — refused: ${p.label}`); continue; }

  const r = await renderVisual(spec);
  if (!r.ok) { console.log(`  ✗ FAILED ${p.label}: ${r.reason}`); continue; }

  // Slugify: the labels contain "/" (e.g. "v3/v4"), which would be read as a
  // directory separator and crash the write. Build a filesystem-safe slug.
  const slug = p.label.split(' ')[0].replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  const file = saveVisual(r.buffer, `${spec.kind}-realistic-${slug}.png`);

  console.log(`  ✓ ${spec.kind.padEnd(12)} ${p.label}`);
  if (spec.kind === 'insightCard') {
    console.log(`      headline: ${spec.headline}`);
    spec.points.forEach((pt, i) => console.log(`      point ${i + 1}:  ${pt.slice(0, 88)}`));
  } else {
    console.log(`      stat:     ${spec.stat}`);
    console.log(`      label:    ${spec.statLabel}`);
    if (spec.context) console.log(`      context:  ${spec.context.slice(0, 88)}`);
  }
  console.log(`      -> ${path.basename(file)}\n`);
}

// Assert the two fields are actually distinct — the whole point of the card.
let bad = 0;
for (const p of PAIRS) {
  const spec = buildVisualSpec(p);
  if (!spec) continue;
  if (spec.kind === 'insightCard') {
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const pt of spec.points) {
      if (norm(spec.headline).startsWith(norm(pt).slice(0, 30))) {
        bad++;
        console.log(`  ⚠ RESTATEMENT survived: "${spec.headline.slice(0, 50)}" / "${pt.slice(0, 50)}"`);
      }
    }
  }
}
console.log(bad === 0 ? '✓ no headline/point restatement in any realistic pair' : `✗ ${bad} restatements`);

await closeVisualFactory();
