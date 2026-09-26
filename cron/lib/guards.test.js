/**
 * Regression tests for the quality-guard layer in `lib/utils.js`.
 *
 * Every assertion here corresponds to a defect that actually shipped to the live
 * account. See AUDIT_2026-09-15.md.
 *
 * Run: node cron/lib/guards.test.js
 *
 * NOTE ON ENV: `tweetLimits.js` reads X_PREMIUM at module-evaluation time, and
 * ESM hoists static imports above statements. X_PREMIUM is therefore set first
 * and the modules are pulled in with a dynamic import so the premium limits
 * (X_SAFE_MAX_CHARS = 1200, TWEET_TARGET_CHARS = 1000) are the ones under test —
 * that is the production configuration for @M_jawad_yasin.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.X_PREMIUM = 'true';

const {
  isPlaceholderText,
  isOffTopicContent,
  isGenericAIText,
  isSecondOrderAISlop,
  endsCleanly,
  finalizePostText,
  finalizeOrReject,
} = await import('./utils.js');

const { X_SAFE_MAX_CHARS, TWEET_TARGET_CHARS, MIN_TWEET_CHARS } = await import('../tweetLimits.js');

// ─── Sanity: the length constants must stay ordered ──────────────────────────
// The original bug was a trim target (450) far below the generator cap (1200),
// which let the publish layer silently cut validated posts.
assert.ok(
  TWEET_TARGET_CHARS <= X_SAFE_MAX_CHARS,
  `TWEET_TARGET_CHARS (${TWEET_TARGET_CHARS}) must not exceed X_SAFE_MAX_CHARS (${X_SAFE_MAX_CHARS})`
);

// ═══ §1 — Placeholder scaffolding (the string that was published live) ═══════
const LEAKED_V8_POST = `drop your [saas / github project / ai agent / portfolio] below 👇

I'll pretend I'm your user and tell you the 1 reason I'd bounce.`;

assert.equal(
  isPlaceholderText(LEAKED_V8_POST),
  true,
  'the exact placeholder text that shipped live must be detected'
);

// Other scaffolding shapes an LLM emits when it treats a template as a spec.
assert.equal(isPlaceholderText('[Punchy closing reaction or debate question]'), true);
assert.equal(isPlaceholderText('{insert your hook here}'), true);
assert.equal(isPlaceholderText('Here is your post: <add CTA>'), true);
assert.equal(isPlaceholderText('drop your [project] below'), true);

// Must NOT fire on legitimate prose.
assert.equal(isPlaceholderText('The array is indexed from zero, so [0] is the first element.'), false);
assert.equal(isPlaceholderText('AI writes the code. AI finds the bugs. So what is left for us?'), false);

// ═══ §5 — Off-topic / off-brand gate ═════════════════════════════════════════
// These are real headlines that went out on an AI-engineering account.
assert.equal(isOffTopicContent('Trump refusing a slowdown cements what builders already knew'), true);
assert.equal(isOffTopicContent('The pay gap between political leaders is wilder than you think.'), true);
assert.equal(isOffTopicContent('Is the silence in the Atlantic a sign of a broken climate consensus?'), true);
assert.equal(isOffTopicContent('Bitcoin is about to make a lot of builders very rich'), true);

// Legitimate technical content must pass — including AI *regulation*, which is
// on-brand for this account and deliberately NOT filtered.
assert.equal(isOffTopicContent('New EU AI Act rules change how you document training data.'), false);
assert.equal(isOffTopicContent('AI agents are quietly replacing the first hour of every debugging session.'), false);

// ═══ Truncation gate ═════════════════════════════════════════════════════════
assert.equal(endsCleanly('You fix one bug, three appear. You fix those, and the first one is back.'), true);
assert.equal(endsCleanly('The real problem is that the model is confident and'), false);
assert.equal(endsCleanly('Here is what nobody tells you about context windows,'), false);
assert.equal(endsCleanly('AI writes the code.\nAI finds the bugs.\nWhat is left for us?'), true);

// ═══ finalizePostText — the TOCTOU fix ═══════════════════════════════════════
// THE BUG: guards validated one string, the publish layer shipped a shorter one.
// finalizePostText trims FIRST, then re-runs the whole chain, so its output is
// byte-for-byte what gets published.

// 1. A clean post passes through unchanged.
// NOTE ON FIXTURE LENGTH: MIN_TWEET_CHARS was raised 160 → 280 on Sep 15, 2026
// (X Premium, 25,000-char platform limit, intended working range 300–1200). Every
// "should pass" fixture below must therefore clear 280, or it fails on length and
// masks the guard it is actually testing. That is not hypothetical — this raise
// broke four fixtures the moment it landed, which is the test doing its job.
const cleanPost = 'AI writes the code.\nAI finds the bugs.\nAI fixes the bugs.\nAI reviews the pull request.\nAI writes the tests and the migration.\n\nso what exactly is the engineer still doing here every single day, and why does nobody ask that question out loud in the standup any more, when the answer changes what we should be hiring for?';
const okResult = finalizePostText(cleanPost, { label: 'test clean' });
assert.equal(okResult.ok, true, `clean post should pass (reason: ${okResult.reason})`);
assert.equal(okResult.text, cleanPost, 'a post within limits must not be altered');
assert.ok(cleanPost.length >= MIN_TWEET_CHARS, 'the passing fixture must clear the minimum length');

// 2. Over-length text is trimmed to the safe cap and still passes.
// Scale the over-length fixture to the active cap so this stays a real
// over-length test at any X Premium limit (the cap is 24,000, not 1,200).
const overLong = `${'A concrete engineering insight worth reading. '.repeat(Math.ceil(X_SAFE_MAX_CHARS / 45) + 2)}Final line here.`;
assert.ok(overLong.length > X_SAFE_MAX_CHARS, 'fixture must exceed the safe cap');
const trimmedResult = finalizePostText(overLong, { label: 'test trim' });
assert.equal(trimmedResult.ok, true, `trimmed post should still pass (reason: ${trimmedResult.reason})`);
assert.ok(
  trimmedResult.text.length <= X_SAFE_MAX_CHARS,
  `finalized text must respect the safe cap (got ${trimmedResult.text.length})`
);

// 3. THE REGRESSION: a post that only fails AFTER trimming must be rejected,
//    not silently published in its cut form.
assert.ok(
  finalizePostText(overLong, { label: 'test trim' }).text.length >= MIN_TWEET_CHARS,
  `finalized output must still meet the minimum length (${MIN_TWEET_CHARS})`
);

// 4. Placeholder text is rejected by the finalizer.
const phResult = finalizePostText(LEAKED_V8_POST, { label: 'test placeholder' });
assert.equal(phResult.ok, false);
assert.match(phResult.reason, /placeholder/i);

// 5. Off-topic text is rejected by the finalizer.
const otResult = finalizePostText('Trump refusing a slowdown cements what builders already knew today.', { label: 'test off-topic' });
assert.equal(otResult.ok, false);
assert.match(otResult.reason, /off-topic/i);

// 6. Truncated text is rejected by the finalizer.
const truncResult = finalizePostText('The real problem with context windows is that the model is', { label: 'test truncation' });
assert.equal(truncResult.ok, false);

// 7. Too-short text is rejected.
const shortResult = finalizePostText('Short.', { label: 'test short' });
assert.equal(shortResult.ok, false);
assert.match(shortResult.reason, /too short/i);

// 8. Empty / null input is rejected without throwing.
assert.equal(finalizePostText('', {}).ok, false);
assert.equal(finalizePostText(null, {}).ok, false);
assert.equal(finalizePostText('   ', {}).ok, false);

// 9. minChars override is honoured (v8 magnets are intentionally short).
const shortMagnet = 'our parents memorised the syntax.\nwe describe the intent.\n\nwhat does the next one do?';
const magnetResult = finalizePostText(shortMagnet, { label: 'test magnet', minChars: 70 });
assert.equal(magnetResult.ok, true, `short magnet should pass with minChars:70 (reason: ${magnetResult.reason})`);

// 10. finalizeOrReject returns null on rejection instead of throwing.
assert.equal(finalizeOrReject(LEAKED_V8_POST, { label: 'test wrapper' }), null);
assert.equal(finalizeOrReject(cleanPost, { label: 'test wrapper' }), cleanPost);

// 10b. Claude-blog anti-slop lexicon checks
const CLAUDE_BLOG_SLOP_SAMPLES = [
  'In today\'s digital landscape, engineers must navigate the complexity of distributed systems with agility.',
  'It\'s important to note that developers should delve into the architecture before deploying microservices.',
  'This new framework seamlessly connects databases, serving as a beacon of modern engineering excellence.',
];
for (const s of CLAUDE_BLOG_SLOP_SAMPLES) {
  assert.equal(isGenericAIText(s), true, `Claude-blog slop must be detected: ${s}`);
  const r = finalizePostText(s, { label: 'test slop', minChars: 50 });
  assert.equal(r.ok, false, `slop post must be rejected by finalizer: ${s}`);
  assert.match(r.reason, /generic AI slop/i);
}

// 10c. Second-order structural slop checks (openers & formulaic endings)
const STRUCTURAL_SLOP_SAMPLES = [
  'The key takeaway is that stateful replication breaks down without strict quorum consistency.',
  'What is important here is that locks held too long degrade throughput.',
  'Postgres partitioned tables handle high write throughput. What are your thoughts?',
];
for (const s of STRUCTURAL_SLOP_SAMPLES) {
  assert.equal(isSecondOrderAISlop(s), true, `Second-order slop must be detected: ${s}`);
  const r = finalizePostText(s, { label: 'test structural slop', minChars: 50 });
  assert.equal(r.ok, false, `structural slop post must be rejected: ${s}`);
  assert.match(r.reason, /second-order AI structural slop/i);
}

// 11. Fabricated authority is rejected. These pipelines have exactly one source
//     (the post below), so a claim of evidence from anywhere else is
//     unverifiable by construction. Caught in the first live A/B run: given a
//     headline with no numbers, the model wrote "Anthropic's next-model
//     telemetry shows Opus 5 High matching Kimi K3 on 40% of frontend tasks".
//     No telemetry, no 40%, no latency figure — the source was a title.
const FABRICATED_AUTHORITY = [
  "Anthropic's next-model telemetry shows Opus 5 High matching Kimi K3 on 40% of frontend tasks, but latency remains 2x higher for the same workload.",
  'Internal documents indicate the team shipped the change three weeks before the announcement, which changes how the timeline reads for anyone evaluating it.',
  'Studies show that developers abandon tools like this within a month, so the retention curve matters far more than the launch numbers here.',
  'Analysts expect the pricing to drop sharply next quarter once the second vendor ships a comparable model at the same tier.',
];
for (const t of FABRICATED_AUTHORITY) {
  const r = finalizePostText(t, { label: 'test fabricated authority' });
  assert.equal(r.ok, false, `fabricated authority must be rejected: ${t.slice(0, 60)}...`);
  assert.match(r.reason, /fabricated authority|not provided/i);
}

// 12. Legitimate references to the SOURCE's own data must still pass — the guard
//     is deliberately narrow so it does not strangle normal analysis.
//     minChars is overridden so this isolates the GUARD under test from the
//     length policy: a fixture that fails on length would mask what it is here
//     to prove. (Same reason the fabricated-* fixtures below assert the reason.)
const LEGIT_DATA_REFERENCE =
  'The benchmark data in that post suggests the memory halving matters more for batch throughput than for hobbyists, which is the part nobody is actually arguing about right now.';
const legit = finalizePostText(LEGIT_DATA_REFERENCE, { label: 'test legit data ref', minChars: 100 });
assert.equal(legit.ok, true, `referring to the source's own data must pass (reason: ${legit.reason})`);

// 13. Borrowed-authority check runs BEFORE the length check, so an operator sees
//     the specific cause rather than a misleading "too short".
const shortFab = finalizePostText('Reports indicate it failed.', { label: 'test order' });
assert.equal(shortFab.ok, false);
assert.match(shortFab.reason, /fabricated authority|not provided/i, 'the specific cause must win over the length check');

// 14. Fabricated FIRST-HAND EXPERIENCE is rejected. Same A/B run, the sibling
//     failure: fixing the derivative-output problem made the model reach for
//     unnamed authority instead of named authority. This pipeline scrapes a post
//     and writes a caption — it never runs the tool, so any claim of having
//     observed or tested something is false by construction.
//     The first fixture is the verbatim output that exposed it.
const FABRICATED_EXPERIENCE = [
  'The release notes highlight zero-shot capability but omit the compute cost. I see teams burning through GPU hours on ambiguous queries, forcing a manual review step that kills the velocity gain in production.',
  'We tested this on a single A100 and the throughput numbers did not match the announcement, which matters a lot more than the headline benchmark for anyone deciding this week.',
  'In my experience, tools like this fall over the moment you push past a few thousand requests, and the maintenance burden lands on whoever is on call that weekend.',
  'From my benchmarks, the latency improvement is real but it disappears entirely once you add the retrieval step, which is the part that actually matters here.',
];
for (const t of FABRICATED_EXPERIENCE) {
  const r = finalizePostText(t, { label: 'test fabricated experience' });
  assert.equal(r.ok, false, `fabricated experience must be rejected: ${t.slice(0, 60)}...`);
  assert.match(r.reason, /first-hand observation|never performed/i);
}

// 15. OPINION markers must still pass. The guard targets claims of witnessed
//     events, not judgements — "my read is X" is explicitly encouraged by the
//     prompt and must not be caught by the net.
const OPINIONS = [
  'My read is that the memory halving matters far more for batch throughput than for hobbyists, and the real cost shows up in serving rather than in training runs.',
  "I'd bet the pricing collapses within two quarters once a second vendor ships a comparable model, because that is what happened to the last three tiers of this market.",
];
for (const t of OPINIONS) {
  const r = finalizePostText(t, { label: 'test opinion', minChars: 100 });
  assert.equal(r.ok, true, `opinion must pass (reason: ${r.reason}): ${t.slice(0, 60)}...`);
}

// Pipelines that render an original visual create a shared Playwright browser.
// It must be closed in a finally block or Node remains alive after publishing
// and GitHub Actions cancels the run at its timeout.
for (const pipeline of ['../v4/seed_and_post.js', '../v6/seed_and_post.js', '../daily_catchup.js']) {
  const source = fs.readFileSync(new URL(pipeline, import.meta.url), 'utf8');
  assert.match(source, /import\s*\{[^}]*closeVisualFactory[^}]*\}\s*from/, `${pipeline} must import closeVisualFactory`);
  assert.match(source, /finally\s*\{[\s\S]*?await\s+closeVisualFactory\(\)/, `${pipeline} must close Playwright in finally`);
}

// Every PAUSED publishing pipeline must refuse to run unless its enable flag is
// explicitly set. v7's sniper posted through Playwright — bypassing Buffer,
// DIRECT_X_PUBLISH_ENABLED and every bufferClient quality guard — with no guard
// at all, so a single manual dispatch could publish. Lock the pattern in.
for (const [pipeline, flag] of [
  ['../v5/seed_and_post.js', 'V5_ENABLED'],
  ['../v6/seed_and_post.js', 'V6_ENABLED'],
  ['../v7/sniper_reply.js', 'V7_ENABLED'],
  ['../v7/auto_reply_comments.js', 'V7_ENABLED'],
  ['../v8/publish_magnet.js', 'V8_ENABLED'],
]) {
  const source = fs.readFileSync(new URL(pipeline, import.meta.url), 'utf8');
  assert.match(
    source,
    new RegExp(`process\\.env\\.${flag}\\s*!==\\s*'true'`),
    `${pipeline} must gate on ${flag} === 'true' before publishing`,
  );
}

// Template-artifact guard — regression protection for the defects that shipped in
// the live f/prompts.chat post on Sep 26, 2026. Every rule below is an exact
// substring or shape from that post.
const TEMPLATE_ARTIFACT_FIXTURES = [
  {
    label: 'template label leak',
    text: 'Gated platforms lock your prompt libraries. This one does not.\n\nresult: zero-cost infrastructure for institutional prompt management.',
  },
  {
    label: 'broken sentence after forced tool intro',
    text: "Data sovereignty matters more than per-seat pricing for most teams shipping agents today, and this repository makes that trade explicit rather than hiding it behind a vendor lock-in. it's called prompts.chat. is a massive, community-driven library of curated prompts.",
  },
  {
    label: 'meaningless tech-stack flex',
    text: 'Self-hostable prompt infrastructure changes the cost curve completely once you cross a few hundred internal prompts and start paying per seat instead.\n\nBuilt with HTML and backed by 143k+ GitHub stars.',
  },
  {
    label: 'README-style arrow dump',
    text: 'The maintenance cost is where this breaks down for most teams that adopt it at scale.\n\nthis is what it does on its own:\n→ aggregates high-performing prompts from the community\n→ categorizes roles and personas for different AI models\n→ provides a self-hostable framework for organizational privacy',
  },
  {
    label: 'lowercase sentence start',
    text: 'Self-hosting solves the privacy problem cleanly and without much operational overhead for small teams.\n\nis a massive, community-driven library of curated prompts.',
  },
];

for (const fixture of TEMPLATE_ARTIFACT_FIXTURES) {
  const r = finalizePostText(fixture.text, { label: fixture.label, minChars: 40 });
  assert.equal(r.ok, false, `must reject: ${fixture.label}`);
  assert.match(r.reason, /template artifact/i, `reason must name the template defect: ${fixture.label} (got "${r.reason}")`);
}

// A genuine long-form engineer post with none of those artifacts must still pass.
const CLEAN_POST = 'Self-hosting a prompt library solves the privacy problem but not the maintenance one.\n\nThe collection may hold 143k+ prompts and still be worth little, because prompt quality drifts silently with every model release. A prompt tuned against one version can underperform on the next and nothing surfaces the regression.\n\nAt a few hundred internal prompts the real cost is not storage. It is re-verifying them against each new model and knowing which ones quietly stopped working. That needs a scored evaluation loop, not a folder.\n\nSelf-hosting buys you control of the data. It does not buy you freshness, and most teams conflate the two.';
const cleanResult = finalizePostText(CLEAN_POST, { label: 'clean long-form', minChars: 40 });
assert.equal(cleanResult.ok, true, `a clean engineer post must still pass (reason: ${cleanResult.reason})`);

console.log('✓ guard regression checks passed (placeholder, off-topic, truncation, finalize, fabricated authority, fabricated experience, paused-pipeline enable flags, template artifacts)');
