import assert from 'node:assert/strict';
import {
  ARCHETYPES,
  buildPrompt,
  V11_MIN_CHARS,
  V11_MAX_CHARS,
  isSemanticDuplicate,
  isValidCandidate,
  unwrapCompletion,
} from './viral_prompts.js';
import { finalizePostText, isMetaTextCaption } from '../lib/utils.js';
import { GENERATION_MAX_TOKENS } from '../lib/groqClient.js';

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

// 5. REGRESSION — the fallback chain must not be short-circuited by prompt leak
//
// THE BUG: isValidCandidate() only checked length + false attribution, so the
// primary model — which ignores `reasoning: {exclude: true}` and emits its
// scratchpad as untagged prose — was scored as a WINNER. generateViralPrompt
// returned the leak as a valid candidate and never tried Gemini or Groq.
// Measured live: 0/5 generations publishable, every run ended in `throw`.
// Gemini, the very next tier, returns a clean post on the identical prompt.
//
// These are the verbatim shapes observed from nvidia/nemotron-3.5-lightning and
// nvidia/nemotron-3-super-120b-a12b, padded to their real output length. The
// length assertion below is load-bearing: a leak shorter than the floor would be
// rejected on length alone and would prove nothing about the leak check.
const promptLeaks = [
  "Here's a thinking process:\n\n1. Analyze the Request:\n - Persona: M_jawad_yasin, AI engineer and builder focused on production AI agents, local LLMs, and open-source infrastructure.\n - Task: Write one useful, original X post.\n - Theme: Systems Reality Check\n - Seed Concept: {\"claim\":\"A successful tool call is not evidence of a successful task\",\"prompt\":\"Describe the validation layer.\"}\n - Constraint: Translate seed into production AI engineering lesson. If off-topic, use only its underlying tension.\n - Voice Rules:\n - Answer first in opening sentence.\n - One specific technical insight, tradeoff, or practical lesson.\n - Natural short paragraphs and varied sentence rhythm.\n - Do not repeat generic motivational or engagement-bait language.\n - Absolute Rules: output only the finished post text, no markdown, no labels, no preamble, no hashtags, no meta commentary.",
  'We need to output a post, 280-24000 chars, no hashtags, no markdown, no meta. Direct peer-to-peer technical voice. Answer first in opening sentence. Provide one specific technical insight/tradeoff/practical lesson. Use short paragraphs, varied sentence rhythm. No generic motivational language. No asking for engagement. No invented numbers/dates/quotes/authority. No claim of building/testing third-party product. So we need to talk about "More context does not automatically make an agent smarter" and "Explain the retrieval and noise tradeoff." Provide a lesson: retrieval-augmented generation: more context can increase noise, degrade reasoning, cause hallucinations, latency. Provide trade',
  "We need to output a single X post (Twitter style) with no hashtags, no markdown, just plain text. Must be between 280 and 24000 characters. Must start with answer first in opening sentence. Must include one specific technical insight/tradeoff/lesson. Must be direct peer-to-peer technical voice, speaking to AI engineers, agent builders, founders, indie developers. Must not repeat generic motivational or engagement-bait language. Must not ask to like, follow etc. Must not end with generic phrases like \"Thoughts?\" or \"What do you think?\" A question allowed only if precise technical question. Must preserve theme: Systems Reality Check, seed concept: \"More context does not automatically",
];
for (const leak of promptLeaks) {
  assert.ok(leak.length >= V11_MIN_CHARS, 'Fixture must clear the length floor, or it proves nothing');
  assert.equal(isMetaTextCaption(leak), true, 'Fixture must be a real meta-text leak');
  assert.equal(
    isValidCandidate(leak, []),
    false,
    `isValidCandidate must REJECT a prompt leak so the next tier is tried: "${leak.slice(0, 45)}..."`
  );
}
console.log('✓ Prompt-leak candidates are rejected so the fallback chain stays reachable');

// 6. REGRESSION — the Gemini tier must be reachable
//
// THE BUG: the tier read `if (res && res.text)`. callGemini() returns the
// completion as a plain STRING, so `res.text` was always undefined and the whole
// tier was unreachable — the same signature mistake fixed for callOpenRouter in
// 90cbfe7 and never applied here. Gemini returns a clean, publishable post on the
// identical prompt, so this silently wasted the only working writer in v11.
//
// unwrapCompletion() is the fix, and it is tested here with no network access so
// the shape contract cannot regress unnoticed.
for (const [label, value, expected] of [
  ['plain string (the real shape)', 'a real post', 'a real post'],
  ['null', null, null],
  ['undefined', undefined, null],
  ['empty string', '', null],
  ['legacy {text} object', { text: 'from an object' }, 'from an object'],
]) {
  assert.equal(
    unwrapCompletion(value),
    expected,
    `unwrapCompletion must map ${label} to ${JSON.stringify(expected)}`
  );
}
console.log('✓ callGemini string return shape is handled (tier is reachable)');

// 7. REGRESSION — v11 must share the repo-wide generation token budget
//
// THE BUG: v11 requested maxTokens: 150 while every other path uses the shared
// GENERATION_MAX_TOKENS (800). 150 tokens truncated generation mid-sentence:
// measured 3/6 rejected as "ends mid-thought", plus 3 more that "passed" while
// actually shipping fragments ending in "…as a developer", "Stop", and
// "the model's attention".
assert.ok(
  GENERATION_MAX_TOKENS >= 800,
  `Shared generation budget must stay >= 800 (got ${GENERATION_MAX_TOKENS}) — v11 truncated mid-sentence at 150`
);
const budgetPrompt = buildPrompt(ARCHETYPES[0], ARCHETYPES[0].seeds[0]);
assert.ok(
  !/Stay between \d+ and \d+ characters/.test(budgetPrompt),
  'Prompt must not ask for a 280-24000 char range; that band is a ceiling, not a target'
);
assert.ok(
  /Write 300-700 characters/.test(budgetPrompt),
  'Prompt must state a realistic, finite length target'
);
console.log('✓ Generation budget and prompt length target verified');

console.log('✅ v11 viral_prompts.test.js — all assertions passed');
