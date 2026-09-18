/**
 * Scan the PENDING queue — the rows that are about to go live on X.
 *
 * `auto_poster.js` consumes this queue and runs no finalizer, so whatever is in
 * `approved` will publish as-is. This script shows what that actually is, scored
 * with the same guards the pipelines use, so the consumer fix can be justified
 * (or not) with evidence rather than reasoning.
 *
 * Usage: node scratch/scan_pending_queue.mjs
 */

import fs from 'node:fs';

process.env.X_PREMIUM = 'true';
const { finalizePostText, hasInformationDelta } = await import('../cron/lib/utils.js');

const env = fs.readFileSync('.env.local', 'utf8');
const get = (k) => env.match(new RegExp(`^${k}\\s*=\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '');
const url = get('VITE_SUPABASE_URL');
const key = get('SUPABASE_SERVICE_ROLE_KEY');

const res = await fetch(
  `${url}/rest/v1/generated_posts?select=id,status,generated_text,original_text,creator_handle,cta_included,character_count,created_at&status=eq.approved&limit=200`,
  { headers: { apikey: key, Authorization: `Bearer ${key}` } },
);
const rows = await res.json();
console.log(`${rows.length} rows in 'approved' (pending publish)\n`);

if (!rows.length) process.exit(0);

// ─── How many would the guards reject? ───────────────────────────────────────
const verdicts = rows.map((r) => ({
  ...r,
  f: finalizePostText(r.generated_text || '', {
    sourceText: r.original_text || '',
    label: 'queue',
  }),
}));

const bad = verdicts.filter((v) => !v.f.ok);
console.log(`Would be REJECTED by the guard chain: ${bad.length}/${rows.length} (${((bad.length / rows.length) * 100).toFixed(0)}%)\n`);
const reasons = {};
for (const v of bad) reasons[v.f.reason] = (reasons[v.f.reason] || 0) + 1;
for (const [r, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${r}`);
}

// ─── Information delta on the survivors ──────────────────────────────────────
const ok = verdicts.filter((v) => v.f.ok);
const deltas = ok.map((v) => hasInformationDelta(v.f.text, v.original_text || '', { explain: true }));
const reasoned = deltas.filter((d) => d.reasoned).length;
const ambiguous = deltas.filter((d) => d.ambiguous).length;
console.log(`\nOf the ${ok.length} that would pass:`);
console.log(`  ${reasoned}  reasoned (derived analysis)`);
console.log(`  ${ambiguous}  ambiguous novel figure`);
console.log(`  ${ok.length - reasoned - ambiguous}  no information delta — reads as a summary`);

// ─── CTA handle check ────────────────────────────────────────────────────────
console.log('\n══ CTA handles present in the queue ══');
const ctas = {};
for (const r of rows) {
  const m = (r.cta_included || '').match(/@[A-Za-z0-9_]+/g) || [];
  for (const h of m) ctas[h] = (ctas[h] || 0) + 1;
}
for (const [h, n] of Object.entries(ctas).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${h}`);

// ─── Age of the pending rows ─────────────────────────────────────────────────
console.log('\n══ Age of pending rows ══');
const now = Date.now();
const ages = rows.map((r) => (now - new Date(r.created_at).getTime()) / 86400000).sort((a, b) => a - b);
if (ages.length) {
  console.log(`  oldest ${ages[ages.length - 1].toFixed(1)} days · median ${ages[Math.floor(ages.length / 2)].toFixed(1)} days · newest ${ages[0].toFixed(1)} days`);
}

// ─── Show the worst offenders ────────────────────────────────────────────────
console.log('\n══ Sample of rows that would be rejected ══\n');
for (const v of bad.slice(0, 8)) {
  console.log(`[${v.creator_handle}] ${v.f.reason}`);
  console.log(`   GEN: ${(v.generated_text || '').replace(/\s+/g, ' ').slice(0, 170)}`);
  console.log('');
}
