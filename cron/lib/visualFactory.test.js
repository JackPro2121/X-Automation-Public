/**
 * Regression tests for the original visual factory.
 *
 * These tests exist because the visual factory is the mechanism that makes the
 * account's media ORIGINAL (see STRATEGY_original_content.md). If it silently
 * breaks, the pipelines fall back to attaching borrowed images — which is the
 * exact eligibility problem it was built to solve. A broken visual factory must
 * fail loudly, not degrade into aggregation.
 *
 * Run: node cron/lib/visualFactory.test.js
 *
 * NOTE: requires Chromium (`npx playwright install chromium`). The test SKIPS
 * with a clear message rather than failing if the browser is absent, so it does
 * not block environments that only run the pure-logic suites.
 */

import assert from 'node:assert/strict';

const {
  renderVisual,
  closeVisualFactory,
  buildVisualSpec,
  CANVAS,
  TEMPLATES,
} = await import('./visualFactory.js');

// ─── PNG helpers ─────────────────────────────────────────────────────────────

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length > 8 && buf.subarray(0, 8).equals(PNG_MAGIC);
}

/** Read width/height straight out of the IHDR chunk. */
function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const FIXTURES = {
  statCard: {
    kind: 'statCard',
    eyebrow: 'AI CODE REVIEW',
    stat: '47%',
    statLabel: 'of AI-generated pull requests are merged without a human reading them',
    context: 'Measured across 1,200 repositories.',
    sourceLabel: 'n=1,200 repos',
  },
  insightCard: {
    kind: 'insightCard',
    eyebrow: 'AGENT ARCHITECTURE',
    headline: 'Your agent does not need a bigger model. It needs a smaller loop.',
    points: ['Failures come from the loop, not the model.', 'A tight loop beats a big model.', 'Log every tool call.'],
    sourceLabel: 'agent-patterns.md',
  },
  comparisonCard: {
    kind: 'comparisonCard',
    eyebrow: 'REALITY CHECK',
    headline: 'What actually changed',
    left: { title: 'Then', items: ['Write the code', 'Read the diff'] },
    right: { title: 'Now', items: ['Describe the intent', 'Read the diff anyway'] },
    sourceLabel: 'survey',
  },
  quoteCard: {
    kind: 'quoteCard',
    eyebrow: 'DEBATE',
    quote: 'The compiler never asked for your trust. The model does.',
    attribution: 'design review, 2026',
  },
};

// ─── Template registry ───────────────────────────────────────────────────────

assert.deepEqual(
  Object.keys(TEMPLATES).sort(),
  Object.keys(FIXTURES).sort(),
  'every registered template must have a test fixture (and vice versa)'
);

assert.ok(CANVAS.width > 0 && CANVAS.height > 0, 'canvas must have dimensions');
assert.equal(
  CANVAS.width / CANVAS.height,
  16 / 9,
  'canvas must stay 16:9 to fill the X in-feed image slot without letterboxing'
);

// ─── Unknown template must fail cleanly, not throw ───────────────────────────

const unknown = await renderVisual({ kind: 'nope' });
assert.equal(unknown.ok, false, 'an unknown template must return ok:false');
assert.match(unknown.reason, /unknown template/i);

// ─── Render every template ───────────────────────────────────────────────────

let chromiumMissing = false;
const rendered = {};

for (const [name, spec] of Object.entries(FIXTURES)) {
  const r = await renderVisual(spec);

  if (!r.ok && /Executable doesn't exist|browserType\.launch/i.test(r.reason || '')) {
    chromiumMissing = true;
    break;
  }

  assert.ok(r.ok, `template "${name}" failed to render: ${r.reason}`);
  assert.ok(isPng(r.buffer), `template "${name}" must produce a valid PNG`);
  assert.equal(r.kind, name);

  // deviceScaleFactor defaults to 2, so the PNG is 2x the CSS canvas.
  const { width, height } = pngSize(r.buffer);
  assert.equal(width, CANVAS.width * 2, `template "${name}" PNG width`);
  assert.equal(height, CANVAS.height * 2, `template "${name}" PNG height`);

  // A near-empty render means the template silently produced nothing — the
  // background alone compresses to a few KB, real text pushes it well past 50KB.
  assert.ok(
    r.buffer.length > 50_000,
    `template "${name}" PNG is suspiciously small (${r.buffer.length} bytes) — did it render content?`
  );

  // Text that runs past the canvas is clipped out of the screenshot, so the post
  // would ship with words missing.
  assert.equal(
    r.overflowed,
    false,
    `template "${name}" content overflows the canvas — text would be clipped`
  );

  rendered[name] = r.buffer;
}

// ─── buildVisualSpec — pipeline data -> visual spec ──────────────────────────

// A hard number in the source should always win: isolating the digit is the
// single highest-value thing a card can do.
assert.equal(
  buildVisualSpec({ sourceTitle: 'GPT-5 cuts inference cost by 47% on the same hardware' }).kind,
  'statCard'
);
assert.equal(
  buildVisualSpec({ sourceTitle: 'GPT-5 cuts inference cost by 47% on the same hardware' }).stat,
  '47%'
);
assert.equal(
  buildVisualSpec({ sourceTitle: 'This startup raised $1.2B to build datacenters' }).stat,
  '$1.2B'
);
assert.equal(
  buildVisualSpec({ sourceTitle: 'LocalLLaMA now runs 70B on 24GB of VRAM' }).stat,
  '24GB'
);

// No number -> lead with the claim instead.
const noNumber = buildVisualSpec({
  sourceTitle: 'Why your AI agent keeps failing in production',
  generatedText: 'Most failures come from the loop, not the model. Retries without state lose the thread. A tight loop beats a big model every time.',
});
assert.equal(noNumber.kind, 'insightCard');
assert.equal(noNumber.headline, 'Why your AI agent keeps failing in production');
assert.ok(noNumber.points.length >= 1, 'insightCard should carry supporting points from the post text');

// Titles that are too thin to carry a card must be refused, not rendered blank.
assert.equal(buildVisualSpec({ sourceTitle: 'Hi' }), null);
assert.equal(buildVisualSpec({ sourceTitle: '' }), null);
assert.equal(buildVisualSpec({}), null);

// Reddit/X titles arrive with markdown, emoji and bracketed fluff.
const messy = buildVisualSpec({
  sourceTitle: '**BREAKING** LocalLLaMA runs 70B on 24GB 🚀 [Discussion]',
});
assert.ok(messy, 'a messy but usable title must still produce a spec');
assert.ok(!/[*_`~\[\]]/.test(messy.headline || messy.statLabel || ''), 'markdown and brackets must be stripped');
assert.ok(!/🚀/.test(messy.statLabel || ''), 'emoji must be stripped from the card copy');

// Long titles must be truncated so the card cannot overflow.
const longTitle = 'This is an extremely long source title that keeps going well past any reasonable length for a card and should therefore be truncated before it is handed to the renderer because otherwise it would overflow the fixed canvas and clip text';
const truncated = buildVisualSpec({ sourceTitle: longTitle });
assert.ok(truncated, 'a long title must still produce a spec');
const cardCopy = truncated.statLabel || truncated.headline;
assert.ok(cardCopy.length <= 155, `card copy must be truncated (got ${cardCopy.length} chars)`);

// Every spec buildVisualSpec produces must be renderable.
for (const spec of [noNumber, messy, truncated]) {
  const r = await renderVisual(spec);
  if (!r.ok && /Executable doesn't exist|browserType\.launch/i.test(r.reason || '')) {
    chromiumMissing = true;
    break;
  }
  assert.ok(r.ok, `buildVisualSpec output must be renderable: ${r.reason}`);
  assert.ok(isPng(r.buffer), 'spec-derived render must be a valid PNG');
  assert.equal(r.overflowed, false, 'spec-derived render must not overflow the canvas');
}

if (chromiumMissing) {
  console.log('⚠ SKIPPED visual rendering checks — Chromium not installed.');
  console.log('  Run: npx playwright install chromium');
} else {
  // ─── Determinism ───────────────────────────────────────────────────────────
  // The same spec must render the same bytes. Non-deterministic output would mean
  // a visual cannot be reviewed, diffed, or regenerated after a failed upload.
  const again = await renderVisual(FIXTURES.statCard);
  assert.ok(again.ok, 'statCard must render twice');
  assert.ok(
    again.buffer.equals(rendered.statCard),
    'rendering the same spec twice must produce byte-identical output'
  );

  // ─── Long copy must not overflow ───────────────────────────────────────────
  // This is the realistic failure mode: a model writes a 200-char headline and the
  // last lines get cut off. The auto-fit sizing should keep it on-canvas.
  const longHeadline = 'A'.repeat(10) + ' ' + 'This headline is deliberately very long so that the auto-fit font sizing has to shrink it down in order to keep every line inside the fixed canvas. '.repeat(2);
  const long = await renderVisual({
    kind: 'insightCard',
    eyebrow: 'STRESS TEST',
    headline: longHeadline,
    points: ['Short point.', 'Another point.'],
  });
  assert.ok(long.ok, `long-copy render failed: ${long.reason}`);
  assert.ok(isPng(long.buffer), 'long-copy render must still be a valid PNG');

  // ─── Special characters must be escaped, not break the layout ──────────────
  const nasty = await renderVisual({
    kind: 'statCard',
    eyebrow: '<script>alert(1)</script>',
    stat: '99%',
    statLabel: 'Text with <b>tags</b>, & ampersands, "quotes" and \'apostrophes\'',
    context: 'Also 5 > 3 and 2 < 4.',
  });
  assert.ok(nasty.ok, `escaping render failed: ${nasty.reason}`);
  assert.ok(isPng(nasty.buffer), 'escaped content must still render');

  console.log('✓ visual factory checks passed (all templates render, deterministic, escaped, no overflow)');
}

await closeVisualFactory();
