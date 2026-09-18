/**
 * Regression tests for the v8 viral-magnet generator.
 *
 * Every assertion maps to a defect that shipped to the live account. See
 * AUDIT_2026-09-15.md §2.
 *
 * Run: node cron/v8/viral_magnet_generator.test.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.X_PREMIUM = 'true';

const {
  ARCHETYPES,
  buildArchetypePrompt,
  pickArchetype,
  findDuplicate,
  MAGNET_MIN_CHARS,
  MAGNET_MAX_CHARS,
} = await import('./viral_magnet_generator.js');

// ═══ §2a — THE ROOT CAUSE: prompts must never contain a fill-in slot ═════════
// The published placeholder came from an example inside the prompt that was
// written as a bracketed list. A language model reads `[a / b / c]` as a slot to
// fill, not as an illustration to avoid. The prompts are now prose-only, so this
// test asserts that no bracket character exists in any generated prompt at all.

const BRACKET_CHARS = ['[', ']', '{', '}', '<', '>'];

for (const archetype of ARCHETYPES) {
  // Sample several times — seeds are randomised per call.
  for (let i = 0; i < 8; i++) {
    const { prompt } = buildArchetypePrompt(archetype);
    for (const ch of BRACKET_CHARS) {
      assert.ok(
        !prompt.includes(ch),
        `archetype "${archetype.id}" prompt must not contain "${ch}" — bracketed examples are what the model copies`
      );
    }
    // The exact phrase family that leaked live.
    assert.ok(
      !/drop your\s/i.test(prompt),
      `archetype "${archetype.id}" prompt must not contain the leaked "drop your" phrasing`
    );
  }
}

// Every archetype must be able to produce a prompt (guards against a missing
// SEEDS entry silently yielding an empty topic).
for (const archetype of ARCHETYPES) {
  const { prompt, seed } = buildArchetypePrompt(archetype);
  assert.ok(prompt.length > 200, `archetype "${archetype.id}" produced a suspiciously short prompt`);
  assert.ok(seed && seed.length > 5, `archetype "${archetype.id}" produced no topic seed`);
  assert.ok(
    prompt.includes(seed),
    `archetype "${archetype.id}" prompt must embed its sampled seed`
  );
}

// ═══ §2b — Variety: the same archetype must not produce one fixed post ═══════
// The old generator had one hard-coded topic per archetype, so the same post
// reappeared daily. Sampling must yield multiple distinct prompts.
const vibe = ARCHETYPES.find((a) => a.id === 'vibe_coding_irony');
const distinctPrompts = new Set();
for (let i = 0; i < 25; i++) distinctPrompts.add(buildArchetypePrompt(vibe).prompt);
assert.ok(
  distinctPrompts.size >= 3,
  `expected variety from seeded prompts, got only ${distinctPrompts.size} distinct prompt(s) in 25 samples`
);

// ═══ §2c — Archetype selection must not repeat recent archetypes ═════════════
const allIds = ARCHETYPES.map((a) => a.id);
assert.ok(allIds.length >= 4, 'need at least 4 archetypes for rotation to mean anything');

// The contract: the 3 MOST RECENTLY USED archetypes are excluded. With 5
// archetypes registered that leaves exactly 2 candidates, so assert membership
// rather than a single expected id.
const recent3 = allIds.slice(0, 3);
const seenAfterExclusion = new Set();
for (let i = 0; i < 40; i++) {
  const chosen = pickArchetype({ recentArchetypes: recent3, hourUtc: 17 });
  assert.ok(
    !recent3.includes(chosen.id),
    `pickArchetype returned "${chosen.id}", which was among the 3 most recently used`
  );
  seenAfterExclusion.add(chosen.id);
}
// And it must actually use the full remaining pool, not funnel to one entry.
const remainingIds = allIds.filter((id) => !recent3.includes(id));
assert.deepEqual(
  [...seenAfterExclusion].sort(),
  [...remainingIds].sort(),
  'pickArchetype should draw from every non-recent archetype'
);

// A preferred archetype is honoured when it was NOT recently used...
const preferred = allIds[0];
assert.equal(
  pickArchetype({ preferredId: preferred, recentArchetypes: [], hourUtc: 17 }).id,
  preferred,
  'preferredId must be honoured when not recently used'
);

// ...and ignored when it WAS recently used (this is what prevents the daily repeat).
assert.notEqual(
  pickArchetype({ preferredId: preferred, recentArchetypes: [preferred, allIds[1], allIds[2]], hourUtc: 17 }).id,
  preferred,
  'preferredId must be overridden when that archetype was just used'
);

// Degenerate input: more recent entries than archetypes must still resolve.
for (let i = 0; i < 10; i++) {
  const chosen = pickArchetype({ recentArchetypes: [...allIds, ...allIds], hourUtc: 12 });
  assert.ok(chosen && chosen.id, 'must still return an archetype when everything looks recent');
}

// Never returns undefined, at any hour.
for (let h = 0; h < 24; h++) {
  const chosen = pickArchetype({ hourUtc: h });
  assert.ok(chosen && chosen.id, `pickArchetype returned nothing at hour ${h}`);
}

// ═══ §2d — Self-dedup ════════════════════════════════════════════════════════
const postA = 'our parents memorised the syntax.\nwe describe the intent.\n\nwhat does the next one do?';
const postB = 'our parents bought a server.\nwe rent a gpu by the second.\n\nwhat does the next one do?';
const postA2 = 'our parents memorised the syntax.\nwe describe the intent.\n\nwhat does the next one do instead?';

// Structurally similar but genuinely different content → allowed.
assert.equal(
  findDuplicate(postB, [postA]),
  null,
  'two different topics in the same archetype shape must NOT be treated as duplicates'
);

// Near-identical wording → blocked.
assert.ok(
  findDuplicate(postA2, [postA]),
  'a near-identical repost must be detected as a duplicate'
);

// Exact repost → blocked.
assert.ok(findDuplicate(postA, [postA]), 'an exact repost must be detected');

// No history → nothing to collide with.
assert.equal(findDuplicate(postA, []), null);
assert.equal(findDuplicate(postA, [null, undefined, '']), null);

// A duplicate is deliberately added to the in-run history before retrying.
// `recentTexts` must therefore be mutable; declaring the destructured option as
// `const` crashed the live retry path with "Assignment to constant variable".
const generatorSource = fs.readFileSync(new URL('./viral_magnet_generator.js', import.meta.url), 'utf8');
assert.match(
  generatorSource,
  /let\s*\{[\s\S]*?recentTexts\s*=\s*\[\]/,
  'duplicate retry history must be mutable'
);

// Long verbatim run is the strongest signal and must trip even when the overall
// trigram ratio is diluted by extra surrounding text. The shared block must span
// at least 7 consecutive CONTENT words (stopwords are stripped before comparison).
const longShared = 'parents memorised the syntax every night before an interview and we describe the intent and let the model find the path';
const padded = `Here is something new I wanted to add first. ${longShared}`;
assert.ok(
  findDuplicate(padded, [longShared]),
  'a long verbatim run must be caught even when wrapped in extra text'
);

// ═══ §2e — Length envelope is coherent ═══════════════════════════════════════
assert.ok(
  MAGNET_MIN_CHARS < MAGNET_MAX_CHARS,
  'magnet length envelope must be ordered'
);
assert.ok(
  MAGNET_MAX_CHARS <= 1200,
  'magnet max must stay under the premium safe cap so the publish layer never trims'
);

console.log('✓ v8 magnet regression checks passed (prompt hygiene, variety, rotation, dedup)');
