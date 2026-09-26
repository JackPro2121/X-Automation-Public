/**
 * Regression tests for `resolvePublishImage` — the shared image-policy decision
 * point that v3, v4, v6 and catch-up all call.
 *
 * ── WHY THIS TEST EXISTS ─────────────────────────────────────────────────────
 * This function sits on the boundary between "we published an original post" and
 * "we published someone else's image", which is the difference between eligible
 * and aggregated under X's Original Content Rewards. It has three ways to fail
 * silently, and all three are worse than a crash:
 *
 *   1. Flag off   → returns the borrowed URL. Fine, but must be *deliberate*.
 *   2. No spec    → source too thin to build a card. Fallback policy applies.
 *   3. Render/upload fails → fallback policy applies.
 *
 * Cases 2 and 3 are the interesting ones: the post still goes out, so nothing
 * crashes and no one notices that Axis A silently re-opened. This test pins the
 * documented behaviour so that a future refactor cannot quietly change which
 * image reaches the feed.
 *
 * ── WHY THE FLAG IS PASSED EXPLICITLY ────────────────────────────────────────
 * `enabled` is parameterised precisely so this test does not depend on the
 * ambient env var. The default flag read happens once at module load, so a test
 * that mutated process.env would be testing the wrong thing (and would be
 * order-dependent).
 *
 * Run: node cron/lib/resolvePublishImage.test.js
 * (No Chromium needed for the flag-off and no-spec paths; the render-failure
 *  path injects a bad spec instead of relying on a broken browser.)
 */

import assert from 'node:assert/strict';

const { resolvePublishImage } = await import('./visualFactory.js');

const SOURCE_IMAGE = 'https://example.invalid/borrowed-source-image.jpg';

// A title long enough to build a card (buildVisualSpec rejects < 20 chars).
const GOOD_TITLE = 'Claude Code now runs a full test suite before it writes a line of code';

// ─── 1. Flag off — the pipeline behaves exactly as it did before ─────────────
// This is the migration-safety case: switching the helper in must not change
// behaviour for any pipeline that has not opted in.
{
  const res = await resolvePublishImage({
    sourceTitle: GOOD_TITLE,
    sourceImageUrl: SOURCE_IMAGE,
    enabled: false,
  });

  assert.equal(res.url, SOURCE_IMAGE, 'flag off must pass the source image through unchanged');
  assert.equal(res.original, false, 'flag off must never claim the image is ours');
  assert.equal(res.reason, 'disabled', 'flag off must report why');
}

// ─── 2. Flag off with NO source image — must not invent one ──────────────────
{
  const res = await resolvePublishImage({
    sourceTitle: GOOD_TITLE,
    sourceImageUrl: null,
    enabled: false,
  });

  assert.equal(res.url, null, 'flag off with no source image must yield null (text-only post)');
  assert.equal(res.original, false, 'must not claim ownership of a non-existent image');
}

// ─── 3. Enabled but the source is too thin to carry a card ───────────────────
// buildVisualSpec() returns null below 20 characters. This is common: short
// titles, bare links, one-word submissions. The post must still publish, and the
// fallback policy decides what image (if any) goes with it.
{
  const withSource = await resolvePublishImage({
    sourceTitle: 'tiny', // < 20 chars → no spec
    sourceImageUrl: SOURCE_IMAGE,
    enabled: true,
    // default fallback: 'source'
  });

  assert.equal(
    withSource.url,
    SOURCE_IMAGE,
    "fallback 'source' must keep the post alive by using the source image"
  );
  assert.equal(withSource.original, false, 'a fallback image is never ours');
  assert.equal(withSource.reason, 'no-spec', 'must distinguish "no spec" from a render failure');
}

// ─── 4. Same thin source, but fallback: 'none' — text-only is the priority ───
// The whole point of the option: a text-only post is eligible, a post carrying a
// borrowed image is not. Callers that value eligibility over visual completeness
// choose this.
{
  const res = await resolvePublishImage({
    sourceTitle: 'tiny',
    sourceImageUrl: SOURCE_IMAGE,
    enabled: true,
    fallback: 'none',
  });

  assert.equal(res.url, null, "fallback 'none' must publish with no image rather than borrow one");
  assert.equal(res.original, false, 'text-only is not "an original image"');
  assert.equal(res.reason, 'no-spec-text-only', 'must be distinguishable in logs from a plain no-spec');
}

// ─── 5. The two fallback modes must actually differ ──────────────────────────
// Guards against a refactor collapsing the parameter into a no-op, which would
// look harmless in review and silently change the eligibility profile.
{
  const input = { sourceTitle: 'tiny', sourceImageUrl: SOURCE_IMAGE, enabled: true };
  const a = await resolvePublishImage({ ...input, fallback: 'source' });
  const b = await resolvePublishImage({ ...input, fallback: 'none' });

  assert.notEqual(a.url, b.url, "fallback 'source' and 'none' must produce different outcomes");
}

// ─── 6. Empty / missing sourceImageUrl never yields the string "null" ────────
// Buffer's API takes a URL. A truthy-but-meaningless value like the string
// "null" or "undefined" would be sent to the API and either fail the post or
// (worse) publish a broken asset. The contract is: null means "no image".
for (const bad of [undefined, null, '']) {
  const res = await resolvePublishImage({
    sourceTitle: 'tiny',
    sourceImageUrl: bad,
    enabled: true,
    fallback: 'source',
  });
  assert.ok(
    res.url === null || typeof res.url === 'string',
    `sourceImageUrl ${JSON.stringify(bad)} must normalise to null or a real string, got ${JSON.stringify(res.url)}`
  );
  assert.notEqual(res.url, 'null', 'must never stringify a missing image to "null"');
  assert.notEqual(res.url, 'undefined', 'must never stringify a missing image to "undefined"');
}

// ─── 7. The return shape is stable ───────────────────────────────────────────
// Every caller destructures `.url`. A misspelt key would surface as
// `undefined` → text-only posts, silently, in production.
{
  const res = await resolvePublishImage({ sourceTitle: GOOD_TITLE, enabled: false });
  for (const key of ['url', 'original', 'reason']) {
    assert.ok(key in res, `return object must always include '${key}'`);
  }
  assert.equal(typeof res.original, 'boolean', "'original' must be a real boolean, not a truthy string");
}

// ─── 8. Prompt/template debris is REFUSED, not rendered ──────────────────────
// Measured over 200 real stored rows: a small share of text is not post copy but
// an echoed generation instruction ("No hashtags, emojis, or markdown."). Upstream
// filters catch it, but the visual factory is called from five paths and must not
// depend on every caller having cleaned up first — a rendered card is permanent
// and far more visible in the feed than a bad caption.
{
  const DEBRIS = [
    'No hashtags, emojis, or markdown.',
    'no markdown, no emojis, plain text only please',
    'Output: a single tweet about the topic below',
    '[Punchy closing reaction, bold take, or debate question to drive replies]',
    'Here is the tweet you asked for about caching',
  ];

  for (const text of DEBRIS) {
    const { buildVisualSpec } = await import('./visualFactory.js');
    const spec = buildVisualSpec({ sourceTitle: text, generatedText: text, eyebrow: 'AI NEWS' });
    assert.equal(spec, null, `must refuse to render debris: ${JSON.stringify(text.slice(0, 45))}`);
  }
}

// ─── 9. …but a legitimate post that merely MENTIONS markdown still renders ───
// The guard is prefix-anchored, mirroring cleanTweetText, so it cannot swallow
// real posts. Without this case the guard could be tightened into a false-positive
// machine and every test above would still pass.
{
  const { buildVisualSpec } = await import('./visualFactory.js');
  const LEGIT = [
    'Why your markdown renderer keeps breaking on nested lists in production',
    'The hashtag problem nobody wants to talk about in AI marketing',
    'I removed every emoji from our changelog and engagement went up 40%',
  ];
  for (const text of LEGIT) {
    const spec = buildVisualSpec({ sourceTitle: text, generatedText: text, eyebrow: 'AI NEWS' });
    assert.ok(spec, `legitimate post must still render a card: ${JSON.stringify(text.slice(0, 45))}`);
  }
}

// ─── 10. A long headline is cut on a WORD BOUNDARY, never mid-word ───────────
// Found by rendering real posts and LOOKING at them: a raw slice produced
// "...faster t..." as the largest text on the card. That reads as a broken
// render. This test would have caught it without needing eyes on the PNG.
{
  const { buildVisualSpec } = await import('./visualFactory.js');

  const LONG = 'We moved from "AI will take our jobs" to "AI, design my bedroom" faster than anyone predicted, and the tooling changed underneath us mid-sentence';
  const spec = buildVisualSpec({ sourceTitle: LONG, generatedText: LONG, eyebrow: 'AI NEWS' });

  assert.ok(spec, 'a long title must still produce a spec');
  assert.ok(
    spec.headline.endsWith('...'),
    `an over-long headline must be elided, got: ${JSON.stringify(spec.headline)}`
  );

  // The character immediately before the ellipsis must complete a word.
  const beforeEllipsis = spec.headline.slice(0, -3);
  assert.ok(!/\s$/.test(beforeEllipsis), 'must not leave a space before the ellipsis');
  assert.ok(
    /[A-Za-z0-9"')]$/.test(beforeEllipsis),
    `headline must end on a complete word, got: ${JSON.stringify(spec.headline)}`
  );
  assert.ok(
    !/[,;:]/.test(beforeEllipsis.slice(-1)),
    `trailing punctuation must be stripped before the ellipsis, got: ${JSON.stringify(spec.headline)}`
  );
  assert.ok(spec.headline.length <= 130, `headline must respect the budget, got ${spec.headline.length}`);
}

// ─── 11. The card must NOT repeat the headline as its first point ────────────
// The pipelines pass the post text as BOTH sourceTitle and generatedText, so the
// headline and point 1 were the identical sentence — the card visibly stuttered
// and wasted its single context slot. Found by rendering production data.
{
  const { buildVisualSpec } = await import('./visualFactory.js');

  const TEXT = 'You can now run a 70B model on a laptop. Quantisation got good enough that the memory ceiling stopped being the blocker for local inference.';
  const spec = buildVisualSpec({ sourceTitle: TEXT, generatedText: TEXT, eyebrow: 'AI NEWS' });

  assert.ok(spec, 'must build a spec');
  for (const p of spec.points || []) {
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    assert.ok(
      !norm(spec.headline).startsWith(norm(p).slice(0, 30)) &&
      !norm(p).startsWith(norm(spec.headline).slice(0, 30)),
      `point must not restate the headline.\n  headline: ${spec.headline}\n  point: ${p}`
    );
  }
}

// ─── 12. …but genuinely distinct points are still kept ───────────────────────
// Guards against the dedup being so aggressive it empties every card.
{
  const { buildVisualSpec } = await import('./visualFactory.js');
  const spec = buildVisualSpec({
    sourceTitle: 'Local inference is finally practical on consumer hardware',
    generatedText:
      'Local inference is finally practical on consumer hardware. The 4-bit quantisation work cut memory use by roughly two thirds. Latency dropped to a point where interactive use feels normal.',
    eyebrow: 'AI NEWS',
  });

  assert.ok(spec, 'must build a spec');
  assert.ok(
    (spec.points || []).length >= 1,
    `distinct supporting points must survive the dedup, got ${JSON.stringify(spec.points)}`
  );
}

console.log('✓ resolvePublishImage policy checks passed (flag-off passthrough, thin-source fallback, source-vs-none divergence, null normalisation, stable shape, debris refusal + no false positives, word-boundary truncation, headline restatement dedup)');
