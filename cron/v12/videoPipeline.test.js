/**
 * Regression tests for the v12 screen-recording pipeline.
 *
 * These cover the parts that are PURE LOGIC and therefore testable without a
 * browser, a network, or ffmpeg installed — which is exactly the surface where
 * a silent regression would be most expensive:
 *
 *   1. buildTranscodeArgs()  — the exact ffmpeg command. X rejects anything
 *      that is not H.264 High + yuv420p, so every one of those flags is a
 *      publish-or-bust decision encoded as a string.
 *   2. validateVideoSpecs()  — the gate that decides whether a file is allowed
 *      to be uploaded at all.
 *   3. The selection-target selector list — GitHub renamed its layout and
 *      every class-based selector silently matched nothing, which is how the
 *      signature selection beat went missing for two build iterations. The
 *      geometric fallback is what actually fixed it.
 *   4. Pipeline identity in the metrics report.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  buildTranscodeArgs, validateVideoSpecs, probeVideo,
  VIDEO_SPEC, VIDEO_MIME, frameGeometry, assessFrameContent,
} from '../lib/videoEncoder.js';
import { buildOverlayHtml, BACKDROPS, pickBackdrop } from '../lib/frameRenderer.js';
import { ABOUT_DESCRIPTION_SELECTORS, RECORD_VIEWPORT, CSS_VIEWPORT, OUTPUT_VIEWPORT, DEVICE_SCALE_FACTOR, scoreCandidates, selectBeats, CONTENT_WEIGHTS, mergeContentExtent, contentCropBox, PRE_SWEEP_HOLD_SEC } from '../lib/repoRecorder.js';
import { pipelineForPost } from '../buffer_metrics_collector.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const R = (rel) => path.join(HERE, '..', '..', rel);

console.log('--- Testing v12 screen-recording pipeline ---');

// ─── 1. Transcode argument vector ────────────────────────────────────────────
const base = buildTranscodeArgs({ input: 'in.webm', output: 'out.mp4' });
const joined = base.join(' ');

assert.ok(base.includes('libx264'), 'must request libx264 — Playwright only emits VP8/WebM');
assert.ok(base.includes('-profile:v'), 'must pin the H.264 profile');
assert.equal(base[base.indexOf('-profile:v') + 1], 'high', 'X/Buffer require High profile');
assert.ok(base.includes('-pix_fmt'), 'must pin the pixel format');
assert.equal(base[base.indexOf('-pix_fmt') + 1], 'yuv420p', 'yuv420p is what X will process');
assert.ok(base.includes('+faststart'), 'moov atom must precede the media data or Buffer can stall fetching');
assert.ok(base.includes('-an'), 'silent by design: drops the AAC dependency and shrinks the file');

// No audio stream, but the AAC ENCODER IS STILL SPECIFIED on some builds when
// -an is absent. This asserts we never accidentally ask for one.
assert.ok(!joined.includes('aac'), 'must never request an AAC encoder');

assert.ok(base.includes('-vf'), 'must always carry a video filter chain (scale+crop normalise the frame)');
const vf = base[base.indexOf('-vf') + 1];
assert.ok(vf.includes(`scale=${VIDEO_SPEC.width}:${VIDEO_SPEC.height}`), 'scale to the target box');
assert.ok(vf.includes(`crop=${VIDEO_SPEC.width}:${VIDEO_SPEC.height}`), 'crop to remove letterbox bars');
assert.ok(!vf.includes('zoompan'), 'zoom must be opt-in, not the default');

// Trim is only emitted when there is something to trim, and lands BEFORE -i so
// ffmpeg can fast-seek instead of decoding the whole blank page-load head.
const trimmed = buildTranscodeArgs({ input: 'a.webm', output: 'b.mp4', trimStartSec: 12.5 });
assert.ok(trimmed.includes('-ss'), 'a non-zero trim must emit -ss');
assert.equal(trimmed[trimmed.indexOf('-ss') + 1], '12.50');
assert.ok(
  trimmed.indexOf('-ss') < trimmed.indexOf('-i'),
  '-ss must precede -i for a fast seek; after -i it decodes and discards'
);
const untrimmed = buildTranscodeArgs({ input: 'a.webm', output: 'b.mp4', trimStartSec: 0 });
assert.ok(!untrimmed.includes('-ss'), 'a zero trim must not emit -ss at all');

// A negative trim would be an ffmpeg error; clamp instead of passing it through.
const negative = buildTranscodeArgs({ input: 'a.webm', output: 'b.mp4', trimStartSec: -5 });
assert.ok(!negative.includes('-ss'), 'a negative trim must be treated as no trim');

// Zoom is opt-in and must be a post-encode transform, not a DOM transform.
const zoomed = buildTranscodeArgs({ input: 'a.webm', output: 'b.mp4', zoom: true });
const zvf = zoomed[zoomed.indexOf('-vf') + 1];
assert.ok(zvf.includes('zoompan'), 'zoom:true must add the zoompan filter');
assert.ok(zvf.includes('scale') && zvf.includes('crop') && zvf.includes('zoompan'),
  'zoom must compose after scale+crop so the push-in cannot leave black bars');
// zoompan's own option list contains commas, so the chain must be checked by
// position rather than by splitting. What actually matters is the ORDER:
// scale and crop establish the frame, and the push-in must come after them,
// or every zoom step would re-crop back to a static box.
assert.ok(zvf.indexOf('zoompan') > zvf.indexOf('crop'),
  'zoompan must come after scale+crop so the push-in cannot be re-cropped away');
assert.ok(zvf.startsWith('scale='), 'the chain must begin with scale so the frame is normalised first');

// REGRESSION — zoom must NOT pin an output frame rate.
//
// zoompan's `fps` sets the OUTPUT rate. Pinning it to maxFps (60) against
// Playwright's 25fps source destroyed 11.67s of a 20s clip — 58% of the video
// silently gone. Every spec check still passed, because the surviving 8.33s
// was valid H.264: the damage was invisible to the validation gate and only a
// duration comparison against the source caught it. Measured across five
// formulations, omitting `fps` gives 20.00s with zero drift.
const zoomFilter = zvf.slice(zvf.indexOf('zoompan'));
assert.ok(
  !/[:=]fps\s*[:=]/.test(zoomFilter.replace(/s=\d+x\d+/, '')),
  'zoompan must not pin an output frame rate — it truncates the clip against a 25fps source'
);
assert.ok(!/fps=\d+/.test(zoomFilter), `zoompan must inherit the source frame rate, got: ${zoomFilter}`);

// Argument safety: the vector is passed to execFile, never to a shell, so a
// filename can never be reinterpreted as a flag. Assert the shape that
// guarantees it — no single interpolated string containing the path.
assert.equal(typeof base[base.length - 1], 'string', 'output path is the final argument');
assert.ok(base.includes('out.mp4'), 'output path is passed as its own argv entry');
assert.equal(base.filter((a) => a === '-y').length, 1, 'exactly one -y, never a shell string');
console.log('✓ ffmpeg argument vector verified (codec, pix_fmt, faststart, silent, trim ordering, zoom opt-in)');

// ─── 2. Spec gate ────────────────────────────────────────────────────────────
const good = {
  ok: true,
  specs: {
    codec: 'h264', profile: 'High', pixFmt: 'yuv420p',
    width: 1920, height: 1080, fps: 25, bytes: 4.5 * 1024 * 1024,
    mb: 4.5, duration: 21, bitrateMbps: 3.3, aspect: 1920 / 1080, hasAudio: false,
  },
};
assert.equal(validateVideoSpecs(good).ok, true, 'a spec-compliant clip must pass');
console.log('✓ spec gate accepts a compliant clip');

const rejects = [
  ['vp8 instead of h264', { codec: 'vp8' }, /codec is vp8/],
  ['hevc instead of h264', { codec: 'hevc' }, /codec is hevc/],
  ['yuv444p pixel format', { pixFmt: 'yuv444p' }, /pixel format is yuv444p/],
  ['4K resolution', { width: 3840, height: 2160 }, /exceeds X's 1920px limit/],
  ['too long', { duration: 200 }, /exceeds the .*s cap/],
  ['too short to be worth watching', { duration: 2 }, /below the .*s minimum/],
  ['over the storage-safe size', { bytes: 90 * 1024 * 1024, mb: 90 }, /exceeds the 45MB storage-safe ceiling/],
  ['bitrate above Buffer guidance', { bitrateMbps: 40 }, /exceeds Buffer's .*Mbps guidance/],
  ['frame rate above X limit', { fps: 120 }, /exceeds X's 60fps limit/],
  // Within X's pixel ceiling on BOTH axes, so only the aspect gate can fire.
  // (An earlier fixture used 4000x200, which correctly tripped the resolution
  // gate first — checks run in order and the reason must name what actually
  // failed.)
  ['aspect ratio outside X bounds', { width: 1920, height: 200, aspect: 9.6 }, /aspect ratio .* is outside/],
];
for (const [label, patch, pattern] of rejects) {
  const verdict = validateVideoSpecs({ ok: true, specs: { ...good.specs, ...patch } });
  assert.equal(verdict.ok, false, `must reject: ${label}`);
  assert.match(verdict.reason, pattern, `reason for "${label}" must name the real problem, got: ${verdict.reason}`);
}

// A probe that never ran must not read as a pass.
assert.equal(validateVideoSpecs({ ok: false, reason: 'ffprobe failed' }).ok, false);
assert.equal(validateVideoSpecs(null).ok, false);
assert.equal(validateVideoSpecs({ ok: false }).ok, false, 'a missing reason must still reject, not throw');

// The storage ceiling must stay under the Supabase free-plan global limit, or
// uploads start failing for reasons that look like network problems.
assert.ok(
  VIDEO_SPEC.maxBytes < 50 * 1024 * 1024,
  `storage ceiling (${VIDEO_SPEC.maxBytes}) must stay under Supabase's 50MB free-plan cap`
);
assert.equal(VIDEO_MIME, 'video/mp4', 'upload content type must match what Buffer/X will fetch');
console.log(`✓ spec gate rejects ${rejects.length} failure modes with a specific reason`);

// ─── 3. Selection-target selectors ───────────────────────────────────────────
// GitHub replaced the `aside` / `.BorderGrid-cell` layout this code was first
// written against, and every class selector matched nothing silently. The
// primary selector must therefore match on a STABLE SUBSTRING and never on a
// hashed CSS-module suffix, which is regenerated on each GitHub deploy.
assert.ok(ABOUT_DESCRIPTION_SELECTORS.includes('p[class*="SidebarAbout"][class*="description"]'),
  'must keep the measured CSS-module prefix selector');
for (const sel of ABOUT_DESCRIPTION_SELECTORS) {
  assert.ok(!/#[0-9a-f]{3,}/i.test(sel), `selector must not pin a hashed class suffix: ${sel}`);
  assert.ok(!/\.(xTkIP|9mHv3)\b/.test(sel), `selector must not pin an observed hash: ${sel}`);
}
assert.equal(RECORD_VIEWPORT.width, 1920, 'recording width must match the X landscape ceiling');
assert.equal(RECORD_VIEWPORT.height, 1080, 'recording height must be 16:9 to avoid letterboxing');
assert.equal(
  RECORD_VIEWPORT.width / RECORD_VIEWPORT.height, 16 / 9,
  'recording aspect must be exactly 16:9'
);

// The layout viewport must be NARROWER than the encoded frame. Recording at
// 1920 CSS px was measured to fill only 44% of the frame with content; the rest
// was page background. A tight CSS viewport fills 65% of its own capture.
//
// It is a genuine gap now, not a defect: the 1280x720 capture is composited 1:1
// into the frame's content hole and the difference becomes desktop backdrop.
// What it must NOT be is a silent upscale — see the frame-geometry section,
// which pins hole <= source.
assert.ok(CSS_VIEWPORT.width < OUTPUT_VIEWPORT.width,
  'the CSS layout viewport must be narrower than the encoded frame');
assert.equal(OUTPUT_VIEWPORT.width, 1920);
assert.equal(OUTPUT_VIEWPORT.height, 1080);
assert.equal(OUTPUT_VIEWPORT.width / OUTPUT_VIEWPORT.height, 16 / 9, 'output must be 16:9');

// REGRESSION: deviceScaleFactor > 1 breaks Playwright's screencast.
// It was tried at 1.5 to get "true" 1920x1080 device pixels with no upscale. The
// WebM did report 1920x1080, but the page content occupied only the top-left
// 1280x720 of the frame and the remainder was a partially-composited gradient —
// a visibly broken result that every spec check still passed. The scale must
// happen once, in the encoder, where it is deterministic and testable.
assert.equal(DEVICE_SCALE_FACTOR, 1,
  'deviceScaleFactor must stay 1 — above 1 yields a partially-composited frame');
assert.ok(CSS_VIEWPORT.width >= 1152,
  'below ~1152 CSS px GitHub stops narrowing its content column and fill drops again');
// The capture must be even in both axes: yuv420p needs even dimensions, and an
// odd source would force a resample on the native path that the frame exists to
// avoid.
assert.equal(CSS_VIEWPORT.width % 2, 0, 'capture width must be even for yuv420p');
assert.equal(CSS_VIEWPORT.height % 2, 0, 'capture height must be even for yuv420p');
console.log('✓ selection selectors are hash-proof; capture is native and even-sized');

// ─── 3b. Beat selection must chase visual content, not scroll position ──────
// THE OBSERVED DEFECT
// The first real v12 recording (bytedance/deer-flow, 20.84s) spent its last
// ~8 seconds on an unreadable wall of prose about SQLite adapters and token
// budgets — no heading, code block or image anywhere in frame. The beats were
// fixed fractions of the scroll range, which made LENGTH predictable but sampled
// the page blindly. The final beat was the worst content on the page, and it is
// the frame a viewer sees last.
const VH = 720;

// A page with a code block at 4000 and a heading at 8000, buried in prose.
const anchors = [
  { y: 4000, weight: CONTENT_WEIGHTS.pre },
  { y: 8000, weight: CONTENT_WEIGHTS.heading },
  { y: 8200, weight: CONTENT_WEIGHTS.pre },
];
const prose = [
  { y: 500, chars: 900 },
  { y: 9500, chars: 2400 },
  { y: 12000, chars: 3000 },
];
const cands = Array.from({ length: 61 }, (_, i) => ({ y: i * 200 }));
const scored = scoreCandidates(cands, anchors, prose, VH);

assert.ok(scored.length === cands.length, 'every candidate must be scored');
assert.ok(scored.every((c) => Number.isFinite(c.score)), 'scores must be finite');
// Highest score must be at a feature, not in the prose mass at 9500/12000.
assert.ok(scored[0].features > 0, 'the best-scoring position must show a feature');
assert.ok(
  !prose.some((p) => p.chars >= 2400 && scored[0].y >= p.y - VH && scored[0].y <= p.y + VH && scored[0].features === 0),
  'the winner must not be a prose-only viewport'
);

// Prose must actively push a position DOWN relative to the same position with
// fewer features — this is the penalty that fixes the observed defect.
const bare = scoreCandidates([{ y: 5000 }], [], [{ y: 5000, chars: 1600 }], VH)[0];
const withFeature = scoreCandidates([{ y: 5000 }], [{ y: 5000, weight: CONTENT_WEIGHTS.pre }], [{ y: 5000, chars: 1600 }], VH)[0];
assert.ok(withFeature.score > bare.score, 'a feature must outscore the same view plus prose');
assert.ok(bare.score < 0, 'a prose-only viewport must score negative');
console.log('✓ beats are scored by visible content, and prose is penalised');

// Selection: spread, capped depth, good ending.
const picked = selectBeats({ candidates: scored, maxY: 12000, viewportH: VH, count: 4 });
assert.ok(picked.length >= 2 && picked.length <= 4, `expected 2-4 beats, got ${picked.length}`);
for (let i = 1; i < picked.length; i++) {
  assert.ok(picked[i].y > picked[i - 1].y, 'beats must be ordered by depth');
}
// The ending is the last thing a viewer sees — it must be a feature, not prose.
const last = picked[picked.length - 1];
const lastHasFeature = anchors.some((a) => a.y >= last.y && a.y <= last.y + VH);
assert.ok(lastHasFeature, `the final beat must land on visible content, got y=${last.y}`);
// Depth must be capped so the clip never ends in the dead zone at the page foot.
assert.ok(last.y <= 8200 + VH * 1.15 + 1, 'walkthrough depth must be capped past the last feature');
console.log('✓ the final beat lands on content and depth is capped');

// A page with nothing worth looking at must still produce a usable clip.
const flat = Array.from({ length: 40 }, (_, i) => ({ y: i * 300, score: -5, features: 0, proseChars: 800 }));
const flatBeats = selectBeats({ candidates: flat, maxY: 12000, viewportH: VH, count: 4 });
assert.equal(flatBeats.length, 4, 'a featureless page must still yield 4 beats, not an empty clip');
assert.ok(flatBeats.every((b) => Number.isFinite(b.y)), 'fallback beat positions must be finite');
// Degenerate inputs must not throw or produce NaN.
assert.ok(selectBeats({ candidates: [], maxY: 0, viewportH: VH }).length > 0, 'empty candidates must not return nothing');
assert.ok(selectBeats({ candidates: scored, maxY: 0, viewportH: VH }).every((b) => Number.isFinite(b.y)),
  'a zero-height page must not produce NaN positions');
console.log('✓ featureless and degenerate pages degrade safely');

// If v12 posts were filed under v9, the entire reason for building it —
// comparing the two repo formats — would be impossible.
assert.equal(pipelineForPost({ source_url: 'v12://github/owner/repo' }), 'v12');
assert.equal(pipelineForPost({ source_url: 'v12://github/owner/repo', id: 'v12_1' }), 'v12');
assert.equal(pipelineForPost({ source_url: 'https://github.com/o/r', id: 'v9_1' }), 'v9');
assert.equal(pipelineForPost({ source_url: 'v11://founder_dilemma/1' }), 'v11');
assert.equal(pipelineForPost({ source_url: 'insight://some-topic' }), 'other');
assert.equal(pipelineForPost({}), 'other');
assert.equal(pipelineForPost(null), 'other');
console.log('✓ v12 is classified as its own pipeline in the metrics report');

// ─── 5. Wiring ───────────────────────────────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'package.json'), 'utf8'));
assert.ok(pkg.scripts['test:imports'].includes('cron/v12/repo_recording.js'),
  'v12 must be in the named-import check that public CI runs');
assert.ok(pkg.scripts['test:cron'].includes('v12/videoPipeline.test.js'),
  'v12 tests must run in the cron regression suite');
for (const f of ['cron/v12/repo_recording.js', 'cron/lib/repoRecorder.js', 'cron/lib/videoEncoder.js']) {
  assert.ok(fs.existsSync(path.join(HERE, '..', '..', f)), `${f} must exist`);
}
assert.ok(
  fs.existsSync(path.join(HERE, '..', '..', '.github', 'workflows', 'repo_recording_v12.yml')),
  'v12 workflow must exist'
);
const wf = fs.readFileSync(
  path.join(HERE, '..', '..', '.github', 'workflows', 'repo_recording_v12.yml'), 'utf8'
);
// The ffmpeg install is not optional and must be asserted, not assumed.
assert.ok(/apt-get install -y -qq ffmpeg/.test(wf), 'workflow must install ffmpeg — it is NOT on the runner image');
assert.ok(/grep -q libx264/.test(wf), 'workflow must fail fast if the installed ffmpeg lacks libx264');
assert.ok(/playwright install chromium/.test(wf), 'workflow must install the browser');
assert.ok(/npm run test:imports && npm run test:cron/.test(wf), 'workflow must gate publishing on the test suite');
assert.ok(/V12_DAILY_MAX/.test(wf), 'workflow must set the daily cap explicitly');
assert.ok(/DIRECT_X_PUBLISH_ENABLED: 'false'/.test(wf), 'direct X publishing must stay disabled');
console.log('✓ workflow installs ffmpeg, asserts libx264, and gates on tests');

// ─── 5b. The whole day's schedule, checked across all three pipelines ───────
// Checking one workflow against hardcoded neighbour times is weak: it goes stale
// the moment anyone moves a slot, and it cannot see that TWO pipelines now post
// at the same minute. So the real thing is asserted — read v9, v11 and v12, expand
// their crons, and validate the day as a whole.
const readWf = (f) => fs.readFileSync(
  path.join(HERE, '..', '..', '.github', 'workflows', f), 'utf8'
);

/**
 * Expand a 5-field cron into minute-of-day slots. Only the forms these
 * workflows actually use are supported (`*` and comma lists in minute/hour);
 * anything else throws, so a schedule that grows a range cannot be silently
 * under-tested.
 */
function cronToMinutes(expr) {
  const [minF, hourF, domF, monF] = expr.trim().split(/\s+/);
  if (domF !== '*' || monF !== '*') {
    throw new Error(`unsupported cron (dom/month must be *): "${expr}"`);
  }
  if (!/^[\d*,]+$/.test(minF) || !/^[\d*,]+$/.test(hourF)) {
    throw new Error(`unsupported cron (min/hour must be digits, lists or *): "${expr}"`);
  }
  const expand = (f, max) => (f === '*'
    ? Array.from({ length: max + 1 }, (_, i) => i)
    : f.split(',').map(Number));
  const out = [];
  for (const h of expand(hourF, 23)) {
    for (const m of expand(minF, 59)) out.push(h * 60 + m);
  }
  return out.sort((a, b) => a - b);
}

const liveCrons = (f) => [...readWf(f).matchAll(/^\s*-\s*cron:\s*'([^']+)'/gm)].map((m) => m[1]);
const day = [
  ...liveCrons('repo_spotlight_v9.yml').flatMap(cronToMinutes).map((t) => ({ ...label('v9'), t })),
  ...liveCrons('viral_magnets_v11.yml').flatMap(cronToMinutes).map((t) => ({ ...label('v11'), t })),
  ...liveCrons('repo_recording_v12.yml').flatMap(cronToMinutes).map((t) => ({ ...label('v12'), t })),
].sort((a, b) => a.t - b.t);
function label(n) { return { n }; }

const fmt = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;

assert.equal(day.length, 5, `the account must post exactly 5 times/day; got ${day.length}: ${day.map((d) => `${d.n}@${fmt(d.t)}`).join(', ')}`);
assert.deepEqual(day.map((d) => d.n), ['v9', 'v11', 'v9', 'v12', 'v9'],
  `pipeline order across the day changed: ${day.map((d) => `${d.n}@${fmt(d.t)}`).join(', ')}`);

// No two posts from different pipelines on the same minute.
for (let i = 1; i < day.length; i++) {
  assert.ok(day[i].t !== day[i - 1].t,
    `${day[i - 1].n}@${fmt(day[i - 1].t)} and ${day[i].n}@${fmt(day[i].t)} collide on the same minute`);
}

// The real defect this guards: a clustered morning followed by a dead evening.
// The day was 14:00 / 15:30 / 16:45 / 18:00 / 21:00 — three posts inside 2h45m
// then a three-hour hole, which makes the feed look dead all evening.
const gaps = day.slice(1).map((d, i) => (d.t - day[i].t) / 60);
const MIN_GAP_H = 1.5;
for (let i = 0; i < gaps.length; i++) {
  assert.ok(gaps[i] >= MIN_GAP_H,
    `${day[i].n}@${fmt(day[i].t)} -> ${day[i + 1].n}@${fmt(day[i + 1].t)} is only ${gaps[i].toFixed(2)}h apart; ` +
    `every neighbouring pair must be >= ${MIN_GAP_H}h or the day clusters and then goes silent`);
}
// And the spread must be even, not merely non-colliding: no single gap may be
// more than 1.75x the smallest one, which is what let a 3-hour hole through
// before while every individual pair still looked "fine".
const maxGap = Math.max(...gaps);
const minGap = Math.min(...gaps);
assert.ok(maxGap <= minGap * 1.75,
  `the day is unevenly spread: gaps ${gaps.map((g) => g.toFixed(2)).join('h, ')}h ` +
  `(min ${minGap.toFixed(2)}h, max ${maxGap.toFixed(2)}h). A late gap that dwarfs the others means a dead window in the feed.`);

// Everything inside the US+UK overlap the charter targets, and not clustered at
// either edge where only one region is awake.
const at = (h, m) => h * 60 + m;
for (const d of day) {
  assert.ok(d.t >= at(13, 0) && d.t <= at(23, 0),
    `${d.n}@${fmt(d.t)} falls outside the US/UK overlap (13:00-23:00 UTC)`);
}
// The middle of the window must be used — that is where both regions overlap.
assert.ok(day.some((d) => d.t >= at(17, 0) && d.t <= at(21, 0)),
  'no post lands in 17:00-21:00 UTC, the heart of the US/UK overlap');

// The cooldowns each pipeline enforces on itself must not be contended by a
// neighbour. v12 refuses to post inside 90 minutes of its own last post.
const V12_GAP_MIN = 90;
for (let i = 1; i < day.length; i++) {
  if (day[i].n === 'v12' || day[i - 1].n === 'v12') {
    const gapMin = day[i].t - day[i - 1].t;
    assert.ok(gapMin >= V12_GAP_MIN,
      `v12's ${V12_GAP_MIN}-minute cooldown is contended by ${day[i - 1].n}@${fmt(day[i - 1].t)} (${gapMin}min apart) — ` +
      'the run would skip itself and silently post nothing');
  }
}
console.log(
  `✓ the day is 5 evenly spread posts: ${day.map((d) => `${d.n}@${fmt(d.t)}`).join(' → ')} ` +
  `(gaps ${gaps.map((g) => g.toFixed(2)).join('h, ')}h)`
);

// ─── 6. Queue semantics ──────────────────────────────────────────────────────
// v12 must NOT report a queued post as published. In queue mode nothing has
// reached X yet, and an operator reading the database needs to see that the
// recording is awaiting review rather than live.
const v12src = fs.readFileSync(path.join(HERE, 'repo_recording.js'), 'utf8');
assert.ok(/V12_PUBLISH_MODE\s*===\s*'shareNow'\s*\?\s*'shareNow'\s*:\s*'addToQueue'/.test(v12src),
  'publish mode must default to addToQueue, never shareNow');
assert.ok(/finalStatus\s*=\s*publishMode\s*===\s*'addToQueue'\s*\?\s*'approved'\s*:\s*'published'/.test(v12src),
  "queue mode must record 'approved', not 'published' — nothing is on X yet");
assert.ok(!/bufferResult\.success\s*\?\s*'published'\s*:\s*'failed'/.test(v12src),
  'the unconditional published/failed status write must be gone');
// The run summary must not claim "published" in queue mode either — an operator
// reading the log should not be told the recording went out when it has not.
assert.ok(!/published\s*\?\s*'1 published'\s*:\s*'nothing published'/.test(v12src),
  'the run summary must not report "published" when the post is only queued');
assert.ok(/1 queued in Buffer \(not yet on X\)/.test(v12src),
  'the run summary must distinguish queued from published');
// The daily counter must still count a queued post, or queue mode would let the
// pipeline exceed V12_DAILY_MAX.
assert.ok(/\['published',\s*'approved',\s*'posting'\]/.test(v12src),
  'the daily counter must include the queued status or the cap leaks');
console.log('✓ queue mode records approved, and the daily cap still counts it');

// ─── 3c. The macOS frame must never resample the capture upward ─────────────
// THE DEFECT THIS FIXES
// A 1280-CSS capture was upscaled 1.5x to fill a 1920 frame, which softened
// every glyph — and the file got SMALLER, the visible symptom of that softening
// being mistaken for an improvement.
//
// The first attempt at a frame did not fix it. It sized the content hole from
// the OUTPUT (1600x900) and still ran the page through the output normaliser
// first, so the chain was 1280 -> 1.5x -> 1920 -> 0.83x -> 1600: a net 1.25x
// upscale, two generations of softening, inside a filter graph whose own comment
// claimed "no upscale anywhere". Every spec check passed; the video was soft.
//
// The hole is now sized to the SOURCE, so the page is composited 1:1.
const geo = frameGeometry({
  sourceWidth: CSS_VIEWPORT.width,
  sourceHeight: CSS_VIEWPORT.height,
});

assert.ok(geo.pageW <= CSS_VIEWPORT.width && geo.pageH <= CSS_VIEWPORT.height,
  `the hole must never exceed the capture; got ${geo.pageW}x${geo.pageH} from a ${CSS_VIEWPORT.width}x${CSS_VIEWPORT.height} capture`);
assert.ok(geo.pageScale <= 1,
  `the page must never be scaled UP; got ${(geo.pageScale * 100).toFixed(1)}%`);
assert.equal(geo.pageW, geo.holeW, 'the page must fill the content hole exactly');
assert.equal(geo.pageH, geo.holeH, 'the page must fill the content hole exactly');
assert.equal(geo.pageX, geo.holeX, 'the page must be aligned to the hole');
assert.equal(geo.pageY, geo.holeY, 'the page must be aligned to the hole');
// The hole matches the capture aspect, which is what makes the page fit edge to
// edge. A fixed margin produced a 1.99:1 hole against a 1.78:1 page and left
// 167px of empty window beside it.
assert.ok(
  Math.abs(geo.holeW / geo.holeH - CSS_VIEWPORT.width / CSS_VIEWPORT.height) < 0.02,
  `hole aspect ${(geo.holeW / geo.holeH).toFixed(3)} must match the capture ${(CSS_VIEWPORT.width / CSS_VIEWPORT.height).toFixed(3)}`
);
// The backdrop must be visible on every side, or the window reads as a
// full-bleed screenshot rather than a composed shot.
for (const [edge, v] of [['left', geo.winX], ['right', geo.width - geo.winX - geo.winW],
                         ['top', geo.winY], ['bottom', geo.height - geo.winY - geo.winH]]) {
  assert.ok(v >= 24, `backdrop must be visible on the ${edge} edge; got ${v}px`);
}
// Chrome must sit outside the hole, or the titlebar would cover page content.
assert.ok(geo.pageY >= geo.winY + geo.titlebar, 'the titlebar must not overlap the page');
// The whole point at the current capture size: no resample filter at all.
assert.equal(geo.native, true,
  'the capture fits the hole exactly, so the page must be passed through unscaled');
console.log(`✓ frame geometry: window ${geo.winW}x${geo.winH}, page ${geo.pageW}x${geo.pageH} ` +
            `at ${(geo.pageScale * 100).toFixed(1)}% (native 1:1, no resample)`);

// A source LARGER than the hole must still be a downscale, never an upscale.
const bigGeo = frameGeometry({ sourceWidth: 3840, sourceHeight: 2160 });
assert.ok(bigGeo.pageScale <= 1, 'an oversized source must still be scaled down');
assert.equal(bigGeo.native, false, 'an oversized source cannot be native');
assert.ok(bigGeo.pageW <= bigGeo.holeW, 'the downscale must still fill the hole');
console.log(`✓ a 3840x2160 source is capped to ${bigGeo.pageW}x${bigGeo.pageH} (${(bigGeo.pageScale * 100).toFixed(1)}% downscale), never up`);

// The framed ffmpeg invocation must loop the still overlay, and `-t` must come
// AFTER `-filter_complex` — placed before it, `-t` was silently ignored and the
// encode ran to the 120s cap (and one diagnostic run hung until killed).
const framedArgs = buildTranscodeArgs({ input: 'in.webm', output: 'o.mp4', overlay: 'f.png', maxDurationSec: 30 });
const fJoined = framedArgs.join(' ');
const fc = framedArgs[framedArgs.indexOf('-filter_complex') + 1];
assert.ok(framedArgs.includes('-loop'), 'a still overlay must be looped or the composite ends after one frame');
assert.ok(framedArgs.includes('-filter_complex'), 'framing needs a two-input filter graph');
assert.ok(!fJoined.includes('zoompan'), 'zoom must not fight the frame composite');
assert.ok(framedArgs.includes('-shortest'), 'output must end with the page input');
assert.ok(
  framedArgs.indexOf('-t') > framedArgs.indexOf('-filter_complex'),
  '-t must be an OUTPUT option placed after -filter_complex, or it is ignored'
);
assert.ok(!framedArgs.includes('-vf'), 'the framed path uses filter_complex, not a single -vf chain');
// The output rate is pinned so the overlay's loop rate cannot dictate it — it
// had pushed a 25fps capture to 60fps.
assert.equal(framedArgs[framedArgs.indexOf('-r') + 1], String(VIDEO_SPEC.sourceFps));

// THE REGRESSION, precisely: the page branch must not run through the output
// normaliser, and must not be rescaled at all when the hole is native.
assert.ok(!fc.includes('force_original_aspect_ratio'),
  `the page must not be normalised to the ${1920}x1080 output first — that is the 1.5x upscale. Got: ${fc}`);
assert.ok(!fc.includes('scale='),
  `the page must reach the encoder unscaled when the hole is native. Got: ${fc}`);
// The page branch may CROP to the content (section 3d) but must never be cropped
// or normalised to the OUTPUT box — that was the 1.5x upscale. With no crop
// supplied the default is the whole capture, so nothing should be cut at all.
const noCropArgs = buildTranscodeArgs({
  input: 'in.webm', output: 'o.mp4', overlay: 'f.png',
  sourceWidth: CSS_VIEWPORT.width, sourceHeight: CSS_VIEWPORT.height,
});
const nfc = noCropArgs[noCropArgs.indexOf('-filter_complex') + 1];
assert.ok(!nfc.includes(`crop=${OUTPUT_VIEWPORT.width}`),
  `the framed page must not be cropped to the output box. Got: ${nfc}`);
assert.ok(!nfc.includes('force_original_aspect_ratio'),
  `the page must not be normalised to the output — that is the 1.5x upscale. Got: ${nfc}`);
assert.ok(!nfc.includes('scale='),
  `the page must reach the encoder unscaled when the crop is native. Got: ${nfc}`);
assert.ok(fc.includes('overlay='), 'the page must still be composited into the window');
// A non-native source may be scaled, but only downward and straight to the hole.
const resized = buildTranscodeArgs({
  input: 'in.webm', output: 'o.mp4', overlay: 'f.png', sourceWidth: 3840, sourceHeight: 2160,
});
const rfc = resized[resized.indexOf('-filter_complex') + 1];
assert.ok(rfc.includes('scale='), 'a downscaling source must still be scaled to the hole');
assert.ok(!rfc.includes('force_original_aspect_ratio'), 'the framed path must never use the output normaliser');
console.log('✓ framed ffmpeg invocation loops the overlay, bounds the length, and does not resample the page');

// Without an overlay the single-chain path must be unchanged, normaliser included.
const plainArgs = buildTranscodeArgs({ input: 'in.webm', output: 'o.mp4' });
assert.ok(!plainArgs.includes('-filter_complex'), 'the unframed path must not use filter_complex');
assert.ok(plainArgs.includes('-vf'), 'the unframed path keeps the simple -vf chain');
assert.ok(plainArgs.join(' ').includes('force_original_aspect_ratio'),
  'the unframed path still normalises to the output box');
console.log('✓ framed ffmpeg invocation loops the overlay and bounds the output length');

// Overlay markup: real window chrome with a transparent hole.
for (const key of Object.keys(BACKDROPS)) {
  const html = buildOverlayHtml({ title: 'owner/repo', geometry: geo, backdrop: BACKDROPS[key] });
  assert.ok(html.includes('class="dot r"') && html.includes('dot y') && html.includes('dot g'),
    'the titlebar must carry all three macOS traffic lights');
  assert.ok(html.includes('owner/repo'), 'the window title must be shown');
  assert.ok(html.includes('class="hole"'), 'a transparent hole must be punched for the page');
  assert.ok(html.includes('border-radius'), 'the window and hole must be rounded');
  assert.ok(html.includes(BACKDROPS[key].css.slice(0, 24)), 'the chosen backdrop must be applied');
  assert.ok(html.includes(`width:${geo.width}px`), 'the overlay must be rendered at the output size');
}
// Title is injected into HTML, so it must be escaped.
assert.ok(!buildOverlayHtml({ title: '<img src=x onerror=alert(1)>' }).includes('<img src=x'),
  'the window title must be HTML-escaped — it comes from a scraped repo name');
assert.ok(pickBackdrop(0) && pickBackdrop(1), 'backdrop selection must always return something');
console.log('✓ overlay renders window chrome with an escaped title and a punched hole');

// ─── 3d. The crop must fit the content the viewer actually sees ─────────────
// MEASURED ON affaan-m/ECC AT FIVE SCROLL DEPTHS, NOT ASSUMED
//     viewport    scroll 0 (header)   scroll 0.15-0.75 (README)
//     1280x720    x    0..1248        x   33..903   (68% fill)
//     1600x900    x    0..1555        x  193..1063  (54% fill)
//
// Two things follow, and both are load-bearing:
//   - The README column is a FIXED ~870px. Widening the capture makes the void
//     worse, not better, because the extra width becomes padding.
//   - No file-tree sidebar renders at either width (`asides: []`), so nothing
//     ever fills the right side. The void is GitHub's layout, not a race.
// A fixed crop therefore cannot work: the header needs 1248px, the README 903px.
const capW = CSS_VIEWPORT.width, capH = CSS_VIEWPORT.height;
let union = null;
union = mergeContentExtent(union, { left: 0, right: 1248 }, capW);   // header
for (const s of [{ left: 75, right: 919 }, { left: 33, right: 903 }, { left: 33, right: 903 }]) {
  union = mergeContentExtent(union, s, capW);
}
assert.deepEqual(union, { left: 0, right: 1248 }, 'the union must span header and README');
// A sample with no on-screen text must not shrink or extend the union.
assert.equal(mergeContentExtent(union, null, capW), union, 'a null sample must be ignored');
assert.equal(mergeContentExtent(union, { left: 500, right: 500 }, capW), union,
  'a zero-width sample must be ignored');
// The union can never escape the capture.
assert.deepEqual(mergeContentExtent(null, { left: -40, right: 99999 }, capW), { left: 0, right: capW },
  'the extent must be clamped to the viewport');

// The header genuinely needs the full width, so a union including it is not
// cropped — that is correct, not a failure.
assert.equal(contentCropBox(union, { viewportWidth: capW, viewportHeight: capH }).cropped, false,
  'a full-width union must not be cropped');

// A README-only recording is the common case and must crop hard.
let readme = null;
for (const s of [{ left: 75, right: 919 }, { left: 33, right: 903 }, { left: 33, right: 903 }]) {
  readme = mergeContentExtent(readme, s, capW);
}
const crop = contentCropBox(readme, { viewportWidth: capW, viewportHeight: capH });
assert.equal(crop.cropped, true, 'a README-only recording must crop to its content');
assert.equal(crop.y, 0, 'the crop is horizontal only — vertical extent is scroll-dependent');
assert.equal(crop.h, capH, 'the crop keeps the full viewport height');
assert.ok(crop.x <= readme.left, 'the crop must not clip content on the left');
assert.ok(crop.x + crop.w >= readme.right, 'the crop must not clip content on the right');
assert.equal(crop.x % 2, 0, 'crop x must be even for yuv420p');
assert.equal(crop.w % 2, 0, 'crop width must be even for yuv420p');
assert.ok(crop.w <= capW, 'the crop can never exceed the capture');
// The measured README case: 903-33 = 870 of content in a 1280 capture.
assert.ok(crop.w / capW < 0.8,
  `the crop should reclaim the void; kept ${(100 * crop.w / capW).toFixed(0)}% of the capture`);
// A featureless page must degrade to the full viewport, never a useless sliver.
assert.equal(contentCropBox(null, { viewportWidth: capW, viewportHeight: capH }).cropped, false,
  'no measurement must fall back to the full viewport');
assert.equal(contentCropBox({ left: 600, right: 700 }, { viewportWidth: capW, viewportHeight: capH }).cropped, false,
  'a too-narrow extent must fall back rather than produce a sliver');
console.log(`✓ content crop: ${crop.w}x${crop.h} at x=${crop.x} of ${capW} (${Math.round((100 * crop.w) / capW)}% kept, even, full height)`);

// The crop must reach ffmpeg, and the geometry must be sized to it.
const cropGeo = frameGeometry({
  sourceWidth: capW, sourceHeight: capH, cropX: crop.x, cropW: crop.w, cropH: crop.h,
});
assert.equal(cropGeo.cropX, crop.x, 'the crop origin must reach the geometry');
assert.equal(cropGeo.cropW, crop.w, 'the crop width must reach the geometry');
assert.equal(cropGeo.pageW, crop.w, 'the hole must equal the crop width');
assert.equal(cropGeo.pageH, crop.h, 'the hole must equal the crop height');
assert.equal(cropGeo.native, true, 'a crop from a 1280x720 capture must stay native');
const cropArgs = buildTranscodeArgs({
  input: 'in.webm', output: 'o.mp4', overlay: 'f.png',
  cropX: crop.x, cropW: crop.w, cropH: crop.h,
});
const cropFc = cropArgs[cropArgs.indexOf('-filter_complex') + 1];
assert.ok(cropFc.includes(`crop=${crop.w}:${crop.h}:${crop.x}:0`),
  `the page must be cropped to the content before compositing. Got: ${cropFc}`);
assert.ok(!cropFc.includes('scale='), 'a native crop must not also be rescaled');
assert.ok(!cropFc.includes('force_original_aspect_ratio'), 'the framed path must never use the output normaliser');
// The window must now be tight around the content, and the backdrop visible.
assert.ok(cropGeo.winW < capW + 200, 'the window must not balloon past the capture');
for (const [edge, v] of [['left', cropGeo.winX], ['right', cropGeo.width - cropGeo.winX - cropGeo.winW]]) {
  assert.ok(v >= 24, `backdrop must be visible on the ${edge} edge; got ${v}px`);
}
console.log(`✓ crop reaches ffmpeg: crop=${crop.w}:${crop.h}:${crop.x}:0 with no scale, window ${cropGeo.winW}x${cropGeo.winH}`);

// ─── 3e. The content gate: a valid file is not the same as a real picture ────
// THE FAILURE THIS PREVENTS
// validateVideoSpecs() checks container, codec, resolution, duration, bitrate
// and size. All of those describe the FILE. None describes the PICTURE. A
// recording where Playwright never scrolled, or which filmed an empty page, is
// a perfectly valid H.264 MP4 of the correct length — it would pass every
// existing gate and reach X as a motionless rectangle, looking fine in Buffer.
//
// MEASURED with signalstats YAVG over a real capture and three broken ones:
//     real scrolling capture     mean 35.2   spread 4.6
//     solid black                 mean 16.0   spread 0.0
//     solid white                mean 235.0   spread 0.0
//     real content, FROZEN        mean 35.5   spread 0.0
//
// The frozen row is the whole point: its AVERAGE luma matches a real capture,
// so any brightness-only check passes it. Only the SPREAD separates them,
// because scrolling is exactly what makes brightness vary frame to frame.
// Both checks are therefore required and neither is sufficient alone.

// Sampled from the measured real capture.
const realLuma = [35.95, 35.94, 36.1, 37.9, 38.4, 36.2, 34.0, 33.8, 35.0, 36.9];
const realVerdict = assessFrameContent(realLuma);
assert.equal(realVerdict.ok, true, `a real capture must pass; got: ${realVerdict.reason}`);
assert.ok(realVerdict.spread > 1, 'a real capture must show luma spread');
assert.equal(realVerdict.mean > 24 && realVerdict.mean < 200, true,
  'a real capture must not look like a flat tone');

assert.equal(assessFrameContent(Array(80).fill(16)).ok, false, 'a black video must be rejected');
assert.match(assessFrameContent(Array(80).fill(16)).reason, /uniformly black/,
  'a black video must be named as black, not "invalid"');
assert.equal(assessFrameContent(Array(80).fill(235)).ok, false, 'a white video must be rejected');
assert.match(assessFrameContent(Array(80).fill(235)).reason, /uniformly white/,
  'a white video must be named as white');

// THE REGRESSION: same average as real, no motion. Only the spread catches it.
const frozen = assessFrameContent(Array(80).fill(35.5));
assert.equal(frozen.ok, false, 'a frozen recording must be rejected even at a normal brightness');
assert.match(frozen.reason, /did not scroll|still image/,
  'a frozen recording must be reported as a still image, which is the actual bug');
assert.ok(Math.abs(frozen.mean - realVerdict.mean) < 3,
  'the frozen fixture must genuinely share the real capture brightness, or this test proves nothing');

// Degenerate input must fail closed, never throw.
for (const bad of [[], [42], [NaN, NaN], [null, undefined], 'not-an-array', null, undefined]) {
  const v = assessFrameContent(bad);
  assert.equal(v.ok, false, `degenerate luma input must be rejected: ${JSON.stringify(bad)}`);
  assert.ok(typeof v.reason === 'string' && v.reason.length > 0,
    'every rejection must carry a reason naming the problem');
}
console.log('✓ content gate rejects black, white and frozen video, and passes real motion');

// The gate must be wired into the transcode, not merely available.
const encSrc = readFileSync(R('cron/lib/videoEncoder.js'), 'utf8');
assert.ok(/assessFrameContent\(/.test(encSrc), 'assessFrameContent must exist in the encoder');
assert.ok(/measureFrameLuma\(/.test(encSrc), 'measureFrameLuma must exist in the encoder');
const transcodeBody = encSrc.slice(encSrc.indexOf('export async function transcodeToMp4'));
assert.ok(/measureFrameLuma/.test(transcodeBody),
  'transcodeToMp4 must measure frame content — a gate nothing calls is dead code');
assert.ok(/contentGate/.test(transcodeBody), 'transcodeToMp4 must report the gate outcome');
// A failed content gate must NOT be reported as a pass.
assert.ok(/if \(!content\.ok\)/.test(transcodeBody),
  'a failed content gate must short-circuit the success return');
// A measurement failure must degrade to skip, never to reject — a missing
// ffmpeg filter must not block an otherwise good video.
assert.ok(/contentGate: 'unavailable'/.test(transcodeBody),
  'an unmeasurable file must be skipped, not rejected, so a missing filter cannot block publishing');
// The gate must run AFTER the spec gate so a bad file is not measured at all.
assert.ok(transcodeBody.indexOf('validateVideoSpecs(probe)') < transcodeBody.indexOf('measureFrameLuma'),
  'the content gate must run after the spec gate, not instead of it');
console.log('✓ content gate is wired into transcodeToMp4 and cannot be bypassed');

// The pipeline must treat a rejected video as fatal, not as a warning.
const v12Src = readFileSync(R('cron/v12/repo_recording.js'), 'utf8');
assert.ok(/if \(!video\.ok\)/.test(v12Src),
  'a rejected video must stop the candidate before anything is queued');
assert.ok(!/catch[\s\S]{0,40}video\.ok[\s\S]{0,200}savePost/.test(v12Src),
  'nothing may be saved or queued after a failed video');
console.log('✓ a rejected video is fatal to the candidate, before any save or queue');

// ─── 3f. Two segments: the landing view and the README need different crops ──
// WHY A SINGLE CROP CANNOT WIN
// Measured on affaan-m/ECC: the first seconds show the full-width landing view
// (file tree, About sidebar, star count, content out to x=1248) and the rest
// shows the README column at x=33..903. A single crop must serve both:
//   no crop  -> 377px of void beside the README
//   903px    -> slices the nav bar off the landing view, deletes the About
//               sidebar, truncates the tab bar (verified by forcing that crop
//               and rendering it)
//
// So the capture is filmed ONCE and composited in two time-gated segments.
// Cutting the file and concatenating was rejected: it costs a second encode and
// puts a visible seam in the middle of a scroll.
const capW3 = CSS_VIEWPORT.width, capH3 = CSS_VIEWPORT.height;
const landingBox = contentCropBox({ left: 0, right: 1248 }, { viewportWidth: capW3, viewportHeight: capH3 });
const walkBox = contentCropBox({ left: 33, right: 903 }, { viewportWidth: capW3, viewportHeight: capH3 });
assert.equal(landingBox.cropped, false, 'the landing view spans the full capture and must not be cropped');
assert.equal(walkBox.cropped, true, 'the README walkthrough must be cropped to its content');

// The switch time is shifted by the trim, because the page is trimmed but the
// gate is in the OUTPUT timeline. Miss this and the landing window is still on
// screen for `trimStartSec` seconds after the walkthrough began — reintroducing
// the exact artefact the two segments exist to remove.
const TRIM = 9.8;
const walkStart = 12.5;
const shifted = Math.max(0, walkStart - TRIM);
assert.ok(Math.abs(shifted - 2.7) < 0.01, `the switch must land in output time, got ${shifted}`);
assert.ok(shifted < walkStart, 'the switch must be earlier than the raw capture time once trimmed');

const twoArgs = buildTranscodeArgs({
  input: 'in.webm', output: 'o.mp4',
  overlayA: 'a.png', overlayB: 'b.png',
  trimStartSec: TRIM,
  segments: [
    { startSec: 0, endSec: shifted, crop: landingBox },
    { startSec: shifted, endSec: Infinity, crop: walkBox },
  ],
});
const tfc = twoArgs[twoArgs.indexOf('-filter_complex') + 1];
// Two overlays means two looped inputs — one still frame each would end the
// composite after a single frame, which measured as a 0.0s output.
assert.equal(twoArgs.filter((a) => a === '-loop').length, 2, 'both overlays must be looped');
assert.equal(twoArgs.filter((a) => a === '-i').length, 3, 'exactly one page input and two overlay inputs');
assert.ok(tfc.includes(`enable='lt(t,${shifted.toFixed(2)})'`),
  `segment A must be enabled only before the switch. Got: ${tfc}`);
assert.ok(tfc.includes(`enable='gte(t,${shifted.toFixed(2)})'`),
  `segment B must be enabled from the switch onward. Got: ${tfc}`);
assert.ok(!/Infinity/.test(tfc), 'Infinity in a filter expression would never fire and would pin the whole clip to segment A');
// Each segment crops the page to ITS OWN content width.
assert.ok(tfc.includes(`crop=${landingBox.w}:${landingBox.h}:${landingBox.x}:0`),
  'segment A must use the landing crop. Got: ' + tfc);
assert.ok(tfc.includes(`crop=${walkBox.w}:${walkBox.h}:${walkBox.x}:0`),
  'segment B must use the README crop. Got: ' + tfc);
// Neither may rescale: both crops come from the same 1280x720 capture, so both
// land 1:1.
assert.ok(!tfc.includes('scale='), 'neither segment may rescale the capture');
assert.ok(!tfc.includes('force_original_aspect_ratio'), 'the framed path must never use the output normaliser');
// The same length bound and rate pinning as the single-crop path.
assert.ok(twoArgs.indexOf('-t') > twoArgs.indexOf('-filter_complex'),
  '-t must stay an output option placed after -filter_complex');
assert.ok(twoArgs.includes('-shortest'), 'output must end with the page input');
assert.equal(twoArgs[twoArgs.indexOf('-r') + 1], String(VIDEO_SPEC.sourceFps));
console.log(`✓ two segments: landing ${landingBox.w}px then walk ${walkBox.w}px at ${shifted.toFixed(2)}s, one encode, no rescale`);

// A single segment must NOT take the two-overlay path, even if the caller
// passes segments by mistake.
const oneArgs = buildTranscodeArgs({ input: 'in.webm', output: 'o.mp4', overlay: 'f.png' });
assert.equal(oneArgs.filter((a) => a === '-i').length, 2, 'the single-crop path must have exactly two inputs');
assert.ok(!oneArgs.join(' ').includes('enable='), 'the single-crop path needs no time gate');
console.log('✓ a single segment does not take the two-overlay path');

// The recorder must actually produce the split, or none of this is reachable.
const recSrc = readFileSync(R('cron/lib/repoRecorder.js'), 'utf8');
assert.ok(/walkStartSec/.test(recSrc), 'the recorder must measure where the walkthrough begins');
assert.ok(/landingExtent/.test(recSrc) && /walkExtent/.test(recSrc),
  'the recorder must measure the landing and walkthrough extents separately');
assert.ok(/twoSegment/.test(recSrc), 'the recorder must decide whether the split applies');
// Only report segments when the two crops genuinely differ, so a repo with one
// consistent layout keeps taking the cheaper single-crop path.
assert.ok(/segments: twoSegment \? segments : null/.test(recSrc),
  'segments must be null unless the two crops actually differ');
console.log('✓ the recorder measures the split and only reports it when the crops differ');

// ─── 3g. The trim must keep the landing view, and must not film dead air ────
// TWO SEPARATE DEFECTS, BOTH MEASURED ON affaan-m/ECC
//
// 1. The trim landed too late. `trimStartSec` was computed after `networkidle`
//    plus a fixed settle, which is the LATEST possible moment, so everything
//    between "page ready" and "network quiet" was discarded:
//        domcontentloaded     7.32s
//        repo header ready    7.78s
//        render stable       11.48s   (199 text els, 52/52 images)
//        networkidle         16.16s
//        old trim point      17.57s   <-- ~6s of finished landing view lost
//
// 2. Then the fix over-corrected and produced 39s of footage that was HALF dead.
//    planScrollBeats() takes ~15s of wall clock and runs while the page sits
//    motionless on the landing view, so all of it was filmed:
//        near-identical consecutive seconds: 20 of 39
const recSrc2 = readFileSync(R('cron/lib/repoRecorder.js'), 'utf8');

// The cut must be driven by the render settling, not by a fixed sleep.
assert.ok(/waitForRenderStable/.test(recSrc2), 'the recorder must wait for the render to stabilise');
assert.ok(/render\.settledAt - contextCreatedAt/.test(recSrc2),
  'the trim must be placed from the render-settled instant, not from a post-settle Date.now()');
// A fixed wait cannot replace a measurement, so the wait must actually POLL.
assert.ok(/quietMs/.test(recSrc2) && /intervalMs/.test(recSrc2),
  'waitForRenderStable must poll for stability rather than sleep a fixed time');
assert.ok(/timeoutMs/.test(recSrc2), 'the stability wait must be bounded — a page that never settles must not hang the run');
// It must be able to report failure rather than silently accept a moving target.
assert.ok(/stable:\s*false|DID NOT SETTLE/.test(recSrc2) || /render\.stable \?/.test(recSrc2),
  'a page that never settles must be reported, not silently treated as ready');

// THE ORDERING. planScrollBeats must come BEFORE the selection sweep, so its
// slow geometry scan happens while the footage is still discarded.
// The `await ` prefix matters: a bare `indexOf('planScrollBeats(page)')` matches
// the function DEFINITION near the top of the file, which would make this
// assertion pass for the wrong reason.
const planIdx = recSrc2.indexOf('await planScrollBeats(');
const sweepIdx = recSrc2.indexOf('await resolveSelectionTarget(');
assert.ok(planIdx > 0 && sweepIdx > 0, 'both the planner and the sweep must be present');
assert.ok(planIdx < sweepIdx,
  'planScrollBeats must run BEFORE the selection sweep, or its ~15s scan is filmed as dead air');

// The trim must be re-pointed at the sweep, with a small lead-in.
assert.ok(/sweepStartSec/.test(recSrc2), 'the sweep start must be timestamped');
assert.ok(/sweepStartSec - PRE_SWEEP_HOLD_SEC/.test(recSrc2),
  'the trim must be placed just before the sweep so the clip opens on the landing view');
assert.ok(/PRE_SWEEP_HOLD_SEC/.test(recSrc2), 'the lead-in must be a named constant, not a magic number');
// The render-based trim must still exist as the fallback for a skipped sweep.
assert.ok(/render\.settledAt/.test(recSrc2), 'the render-settled trim must be retained as the base value');
// The walkthrough gate must be measured after the sweep, since the sweep is the
// last full-width frame in the clip.
assert.ok(recSrc2.indexOf('const walkStartSec') > sweepIdx,
  'walkStartSec must be captured after the sweep, not before it');
console.log('✓ the trim keeps the landing view and no longer films the planning scan');

// The pacing this is meant to produce, asserted so a regression is visible in CI
// rather than in a video someone has to watch.
assert.ok(PRE_SWEEP_HOLD_SEC >= 0.3 && PRE_SWEEP_HOLD_SEC <= 3,
  `the landing lead-in must be long enough to read the repo name and short enough to hook; got ${PRE_SWEEP_HOLD_SEC}s`);
console.log(`✓ landing lead-in is ${PRE_SWEEP_HOLD_SEC}s — a hook, not an intro`);

console.log('✅ v12 videoPipeline.test.js — all assertions passed');
