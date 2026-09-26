import assert from 'node:assert/strict';
import {
  ARCHETYPES,
  buildPrompt,
  V11_MIN_CHARS,
  V11_MAX_CHARS,
  isSemanticDuplicate,
} from './viral_prompts.js';
import { finalizePostText } from '../lib/utils.js';

console.log('--- Testing v11 Viral Prompts Pipeline ---');

// 1. Check Archetypes
assert.ok(ARCHETYPES.length >= 5, 'Should have at least 5 archetypes');
for (const a of ARCHETYPES) {
  assert.ok(a.id, 'Archetype must have an id');
  assert.ok(a.name, 'Archetype must have a name');
  assert.ok(Array.isArray(a.seeds) && a.seeds.length > 0, `Archetype ${a.id} must have seeds`);
}
console.log('✓ Archetypes structure verified');

// 2. Check Prompt Builder
const sampleArchetype = ARCHETYPES[0];
const sampleSeed = sampleArchetype.seeds[0];
const prompt = buildPrompt(sampleArchetype, sampleSeed);
assert.ok(prompt.includes(sampleArchetype.name), 'Prompt must include archetype name');
assert.ok(prompt.includes('production AI agents'), 'Prompt must reference the account niche');
assert.ok(prompt.includes('No markdown'), 'Prompt must enforce clean post output');
console.log('✓ Prompt builder verified');

assert.equal(isSemanticDuplicate(
  'Agent tool calls can look successful while returning wrong output.',
  ['Agent tool calls can look successful while returning semantically wrong output.']
), true);
assert.equal(isSemanticDuplicate(
  'Local inference changes latency, but retrieval quality still decides usefulness.',
  ['A system prompt is architecture, not a personality.']
), false);
console.log('✓ Semantic duplicate detection verified');

// 3. Verify Guard Acceptance of concise technical posts
// These must clear the SAME 280-char account floor every other pipeline uses.
// A 40-char floor once let 41-char posts ship; keeping the fixtures short here
// would silently re-admit that bug.
const testTweets = [
  'Agent tool calls can look successful while returning semantically wrong output. The call returns HTTP 200, the schema validates, and the model reports done. But the retrieved document answered a different question than the one the agent asked. Validation has to check semantic fit, not just shape.',
  'Local inference changes latency, but retrieval quality still decides whether the answer is useful. A smaller model with tight context routinely beats a frontier model drowning in irrelevant documents. If you are optimizing the wrong layer, no amount of model tuning will fix the product.',
  'The hardest part of an AI agent is knowing when a tool result is not trustworthy enough to continue. Most failures are silent: the tool returned something plausible. You need explicit stopping conditions and verification boundaries, not just a longer prompt telling the model to be careful.',
  'A memory layer should store decisions and evidence, not every raw conversation token. Persisting the whole transcript means every future run re-pays the context tax and re-reads decisions that were already settled. Store what was decided and why, then let the raw text die with the run.',
  'The right model is rarely the bottleneck in production. Context assembly usually is. Teams spend weeks tuning model parameters and then discover their retrieval layer is returning stale, duplicated, or contradictory chunks. Fix the context pipeline first and the model choice becomes a much smaller decision.',
  'A system prompt is architecture, not a personality. Treat it like an interface with a reliability contract. Define what the model must do, what it must never do, and what it should hand back when it is unsure. Vague tone instructions produce unpredictable behavior you cannot test.',
];

for (const t of testTweets) {
  const res = finalizePostText(t, { minChars: V11_MIN_CHARS, label: 'v11 test' });
  assert.equal(res.ok, true, `Expected valid tweet to pass guard: "${t.slice(0, 50)}..." — reason: ${res.reason}`);
  assert.ok(res.text.length >= V11_MIN_CHARS, 'Length must be above minimum');
  assert.ok(res.text.length <= V11_MAX_CHARS, 'Length must be under maximum');
}
console.log('✓ Concise technical posts pass quality guards');

// 4. Verify Guard Rejection of Bad Tweets
// These test what finalizePostText() itself rejects — guards that live in other
// layers (cleanTweetText, isValidCandidate) are not tested here.
const bad2 = finalizePostText('Short.', { minChars: V11_MIN_CHARS, label: 'v11 test' });
assert.equal(bad2.ok, false, 'Too short tweet must be rejected');

const bad4 = finalizePostText(
  'I built a tool that automatically generates videos from your GitHub repos.',
  { minChars: V11_MIN_CHARS, label: 'v11 test' }
);
assert.equal(bad4.ok, false, 'False first-person attribution must be rejected');

// hasBorrowedAuthority: must match BORROWED_AUTHORITY_RE exactly
const bad5 = finalizePostText(
  'Benchmarks show this model is 3x faster than GPT-4 on coding tasks.',
  { minChars: V11_MIN_CHARS, label: 'v11 test' }
);
assert.equal(bad5.ok, false, 'Fabricated benchmark citation must be rejected');

// hasFabricatedExperience: first-person claim of witnessed event
const bad6a = finalizePostText(
  'I see teams burning through GPU hours on ambiguous queries — it kills the velocity gain.',
  { minChars: V11_MIN_CHARS, label: 'v11 test' }
);
assert.equal(bad6a.ok, false, 'Fabricated first-person observation must be rejected');

// isPlaceholderText: unfilled template
const bad6 = finalizePostText(
  '[INSERT HOOK HERE] — the real bottleneck is [TOOL NAME].',
  { minChars: V11_MIN_CHARS, label: 'v11 test' }
);
assert.equal(bad6.ok, false, 'Unfilled placeholder must be rejected');

console.log('✓ Quality guard negative checks pass');
console.log('✅ v11 viral_prompts.test.js — all assertions passed');
