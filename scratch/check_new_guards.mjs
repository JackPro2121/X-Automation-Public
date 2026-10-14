/**
 * Measure the rejection rate of the two NEW enforced guards against real output.
 *
 * `hasBorrowedAuthority` and `hasFabricatedExperience` are enforced (not shadow),
 * on the rationale that a single-source pipeline has no legitimate use for either
 * pattern. That rationale is sound, but the rejection rate is still an empirical
 * question — and enforcing an unmeasured gate is exactly the mistake that made
 * the paraphrase gate useless. So: run them over every real post in the corpus
 * and look at what they would have killed.
 *
 * Usage: node scratch/check_new_guards.mjs
 */

import fs from 'node:fs';

process.env.X_PREMIUM = 'true';
const { hasBorrowedAuthority, hasFabricatedExperience, finalizePostText } = await import('../cron/lib/utils.js');

const pairs = JSON.parse(fs.readFileSync('scratch/pairs.json', 'utf8'));
console.log(`Checking ${pairs.length} real published posts against the two new enforced guards\n`);

const fabAuthority = pairs.filter((p) => hasBorrowedAuthority(p.generated));
const fabExperience = pairs.filter((p) => hasFabricatedExperience(p.generated));
const either = pairs.filter((p) => hasBorrowedAuthority(p.generated) || hasFabricatedExperience(p.generated));

const pct = (n) => `${((n / pairs.length) * 100).toFixed(1)}%`;
console.log(`  fabricated authority   ${String(fabAuthority.length).padStart(3)}/${pairs.length}  ${pct(fabAuthority.length)}`);
console.log(`  fabricated experience  ${String(fabExperience.length).padStart(3)}/${pairs.length}  ${pct(fabExperience.length)}`);
console.log(`  either (would reject)  ${String(either.length).padStart(3)}/${pairs.length}  ${pct(either.length)}`);

if (either.length) {
  console.log('\n══ What they would have killed ══\n');
  for (const p of either.slice(0, 12)) {
    const why = hasBorrowedAuthority(p.generated) ? 'AUTHORITY' : 'EXPERIENCE';
    console.log(`[${p.pipeline}] ${why}`);
    console.log(`   ${p.generated.replace(/\n/g, ' | ').slice(0, 200)}`);
    console.log('');
  }
} else {
  console.log('\nNo existing post trips either guard — zero collateral damage on real output.');
}

// Full finalizer pass, to see the total rejection rate with every guard active.
console.log('══ Full finalizer over the corpus (all guards active) ══\n');
const rejected = pairs.filter((p) => {
  const r = finalizePostText(p.generated, { sourceText: p.source, label: p.pipeline });
  return !r.ok;
});
console.log(`  ${rejected.length}/${pairs.length} would be rejected (${pct(rejected.length)})`);
const reasons = {};
for (const p of pairs) {
  const r = finalizePostText(p.generated, { sourceText: p.source, label: p.pipeline });
  if (!r.ok) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
}
for (const [reason, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
  console.log(`     ${String(n).padStart(3)}  ${reason}`);
}
