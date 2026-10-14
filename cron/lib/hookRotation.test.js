/**
 * Regression tests for the v9 GitHub-spotlight anti-repetition machinery.
 *
 * THE OBSERVED BUG
 * Four consecutive live posts (09-24 → 09-26: browser-use, prompts.chat,
 * open-webui, oh-my-openagent) opened with the same construction — "Gated
 * platforms lock your X behind proprietary clouds…". Two causes, both fixed
 * here:
 *
 *   1. Only FIVE hook angles for three posts a day, picked with a bare
 *      Math.random(). Each recurred roughly every 1.7 days.
 *   2. EVERY angle carried a literal `Structural pattern: "…"` with
 *      fill-in-the-blank slots. The blanks existed so the model could not copy
 *      a capability claim — but the SENTENCE SHAPE got copied, and the shape is
 *      what the reader sees.
 *
 * The fixtures below are the real openers from those four posts.
 */
import assert from 'node:assert/strict';
import {
  GITHUB_HOOK_ANGLES,
  pickGitHubHook,
  hasRepeatedOpening,
  buildTweetPrompt,
  getLastPromptSelection,
} from './groqClient.js';

console.log('--- Testing v9 hook rotation & repetition guard ---');

// ─── 1. Pool shape ───────────────────────────────────────────────────────────
assert.ok(GITHUB_HOOK_ANGLES.length >= 10,
  `hook pool must be large enough to survive 3 posts/day without repeats; got ${GITHUB_HOOK_ANGLES.length}`);
const names = GITHUB_HOOK_ANGLES.map((h) => h.name);
assert.equal(new Set(names).size, names.length, 'hook names must be unique');
for (const h of GITHUB_HOOK_ANGLES) {
  assert.ok(h.name && h.guidance, `every hook needs a name and guidance: ${JSON.stringify(h)}`);
  assert.ok(h.guidance.length > 60, `guidance for "${h.name}" is too thin to steer a writer`);
}

// A pool of 5 for 3 posts/day means a repeat every ~1.7 days. 12 gives ~4 days,
// and the exclusion window then guarantees no repeat inside a single day.
assert.ok(GITHUB_HOOK_ANGLES.length >= 9, 'need at least 9 angles for a 3-deep window over 3 posts/day');

console.log(`✓ hook pool has ${GITHUB_HOOK_ANGLES.length} unique angles`);

// ─── 2. The template that caused the bug is gone ─────────────────────────────
// Not "no hook has a pattern" — patterns are useful. The specific failure was
// that EVERY hook had one, so every post was forced into the same shape.
const withPattern = GITHUB_HOOK_ANGLES.filter((h) => /Structural pattern:/.test(h.guidance));
const withoutPattern = GITHUB_HOOK_ANGLES.filter((h) => !/Structural pattern:/.test(h.guidance));
assert.ok(withoutPattern.length >= 4,
  `at least 4 angles must have NO fill-in-the-blank pattern, or the feed stays templated; got ${withoutPattern.length}`);
assert.ok(withoutPattern.length / GITHUB_HOOK_ANGLES.length >= 0.3,
  'a third of angles must be pattern-free');

// The exact Sovereignty pattern that produced four identical openers must be
// absent from the whole pool.
const poolText = GITHUB_HOOK_ANGLES.map((h) => h.guidance).join(' ');
assert.ok(!/usually means depending on/i.test(poolText),
  'the "usually means depending on" template must be gone — it caused the observed repetition');
assert.ok(!/Gated platforms lock/i.test(poolText),
  'the observed repeated opener must not be reachable from any angle');
console.log(`✓ ${withPattern.length} patterned / ${withoutPattern.length} pattern-free angles; sovereignty template removed`);

// ─── 3. pickGitHubHook actually rotates ──────────────────────────────────────
const picked = pickGitHubHook([]);
assert.ok(names.includes(picked.name), 'must return a hook from the pool');

// Never return a banned angle, while alternatives exist.
for (let i = 0; i < 200; i++) {
  const banned = [names[i % 4], names[(i + 1) % 4], names[(i + 2) % 4]];
  const hook = pickGitHubHook(banned);
  assert.ok(!banned.includes(hook.name),
    `pickGitHubHook returned a banned angle: ${hook.name} (banned: ${banned.join(', ')})`);
}

// The realistic case: v9 bans the last 3 angles used, 3x a day.
const recent = names.slice(0, 3);
for (let i = 0; i < 200; i++) {
  assert.ok(!recent.includes(pickGitHubHook(recent).name),
    'a 3-deep exclusion window must hold across many draws');
}

// If everything is banned, fall back to the full pool rather than returning
// undefined and taking the run down.
const allBanned = names;
const fallback = pickGitHubHook(allBanned);
assert.ok(fallback && names.includes(fallback.name),
  'banning the whole pool must fall back to the pool, not return undefined');
assert.equal(pickGitHubHook(null).name !== undefined, true, 'a null history must not throw');
assert.equal(pickGitHubHook(undefined).name !== undefined, true, 'an undefined history must not throw');
assert.throws(() => pickGitHubHook([], []), /empty hook pool/, 'a genuinely empty pool is a programming error');
console.log('✓ pickGitHubHook honours the exclusion window and degrades safely');

// ─── 4. hasRepeatedOpening on the real repeated openers ──────────────────────
// These four shipped live and are near-identical in their first clause.
const browserUse = 'Gated platforms lock your browser data behind proprietary clouds and per-seat pricing, but browser-use lets you run the agent locally via a Python library. The rest of the stack stays yours.';
const promptsChat = 'Gated platforms lock your prompt libraries behind proprietary clouds and per-seat pricing. prompts.chat gives you total data sovereignty by letting you host the whole thing yourself.';
const openWebui = 'Gated platforms lock your data behind proprietary clouds and per-seat pricing. Open WebUI gives you total data sovereignty by letting you run your entire AI stack locally.';
const ohMyOpenagent = 'Gated platforms lock your agentic workflows behind proprietary clouds and per-seat pricing. OmO gives you total data sovereignty by letting you run the whole harness yourself.';

assert.equal(hasRepeatedOpening(promptsChat, [browserUse]), true,
  'a verbatim repeat of the shipped opener MUST be caught');
assert.equal(hasRepeatedOpening(openWebui, [browserUse, promptsChat]), true,
  'the third post in the run must be caught too');
assert.equal(hasRepeatedOpening(ohMyOpenagent, [browserUse, promptsChat, openWebui]), true,
  'and the fourth — this is the case that actually shipped');

// Different repos SHOULD be allowed to share vocabulary later in the post.
const differentRepo = 'Most teams reach for a vector database before they have measured what they are actually retrieving. Chroma keeps the embedding step in-process, which removes a network hop and a deployment surface from the smallest possible setup. It stops being the right call once the index outgrows a single node.';
assert.equal(hasRepeatedOpening(differentRepo, [browserUse, promptsChat, openWebui]), false,
  'a genuinely different opener must pass — over-rejecting would starve the feed');

// A short or empty candidate must not false-positive.
assert.equal(hasRepeatedOpening('Too short.', [browserUse]), false, 'a 2-word opening is not comparable');
assert.equal(hasRepeatedOpening('', [browserUse]), false, 'empty text must not throw or match');
assert.equal(hasRepeatedOpening(browserUse, []), false, 'no history means no repeat');
assert.equal(hasRepeatedOpening(browserUse, ['', '   ', null]), false, 'blank history rows must be ignored');
assert.equal(hasRepeatedOpening(null, [browserUse]), false, 'null candidate must not throw');
console.log('✓ hasRepeatedOpening catches the four real repeated openers and passes distinct ones');

// ─── 5. buildTweetPrompt wires the rotation through ──────────────────────────
const post = {
  title: 'browser-use',
  selftext: 'Let your AI drive a browser',
  redditUrl: 'https://github.com/browser-use/browser-use',
  imageUrl: null,
  subreddit: 'github',
  upvotes: 0,
  comments: 0,
  source: 'github',
};

const banned = names.slice(0, 3);
buildTweetPrompt(post, false, null, { recentHookNames: banned });
const sel = getLastPromptSelection();
assert.ok(sel.hookName, 'buildTweetPrompt must record the chosen hook angle');
assert.ok(!banned.includes(sel.hookName),
  `the prompt must not have used a banned angle; got ${sel.hookName}`);
console.log(`✓ buildTweetPrompt selected "${sel.hookName}" while avoiding ${banned.length} recent angles`);

// A pinned angle is honoured (needed for reproducible A/B runs).
buildTweetPrompt(post, false, null, { forcedHookName: names[5] });
assert.equal(getLastPromptSelection().hookName, names[5], 'forcedHookName must be honoured');

// Non-GitHub sources must not be affected by hook rotation.
const redditPost = { ...post, source: 'reddit', subreddit: 'programming' };
buildTweetPrompt(redditPost, false, null, { recentHookNames: names });
assert.equal(getLastPromptSelection().hookName, null,
  'a non-GitHub source has no hook angle and must not report one');
console.log('✓ hook rotation is scoped to the GitHub path only');

console.log('✅ v9 hook rotation & repetition tests — all assertions passed');
