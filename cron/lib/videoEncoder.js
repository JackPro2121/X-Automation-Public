/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   VIDEO ENCODER — v12 SCREEN-RECORDING PIPELINE                ║
 * ║   cron/lib/videoEncoder.js                                      ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Turns Playwright's raw WebM into a publishable X/Buffer MP4.  ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * WHY A TRANSCODER IS MANDATORY (verified, not assumed)
 *
 * Playwright's `recordVideo` can only emit WebM. The encoder it ships
 * (`ms-playwright/ffmpeg-*`) was probed directly and exposes ONE video
 * encoder: `libvpx` (VP8). There is no libx264 and no AAC. Playwright's own
 * source throws if you ask for any other extension:
 *     if (!outputFile.endsWith('.webm')) throw new Error('File must have .webm extension');
 *
 * X rejects WebM outright. Buffer documents the same. So a real ffmpeg with
 * libx264 is a hard requirement, and it is NOT preinstalled on the
 * ubuntu-24.04 GitHub runner image (verified against the full
 * actions/runner-images manifest — `mediainfo` is present, `ffmpeg` is not).
 * The workflow must install it; this module assumes `ffmpeg` is on PATH and
 * fails loudly and specifically if it is not.
 *
 * Every spec below is enforced by `validateVideoSpecs()` BEFORE the file is
 * uploaded. A video that fails validation is never published — it is discarded
 * and the pipeline degrades, because a rejected Buffer upload is silent and
 * would leave a "published" row with no media.
 */

/**
 * The publish target. Every value is a VERIFIED platform limit, not a guess.
 * Sources: Buffer video troubleshooting docs, X video specs (2026).
 */
export const VIDEO_SPEC = {
  // X accepts MP4 and MOV only. WebM/VP8 is rejected outright.
  container: 'mp4',
  // Buffer: "Codec: H.264. This is the most important setting." HEVC, AV1,
  // VP9 and ProRes all fail.
  videoCodec: 'h264',
  profile: 'high',
  // X: max resolution 1920x1200 landscape. 16:9 is the safe, non-letterboxed
  // choice and matches the reference recording.
  width: 1920,
  height: 1080,
  // X supports up to 60fps; 30 is the recommended safe default.
  maxFps: 60,
  // Playwright's screencast records at ~25fps and nothing in this pipeline
  // raises it. The output rate is pinned to that so a looping overlay input
  // cannot dictate the frame rate (it had pushed the result to 60fps).
  sourceFps: 25,
  // Buffer: "ideally under 25 Mbps". CRF encoding lands well under this.
  maxBitrateMbps: 25,
  // X standard accounts: 140s. Kept far below so a slow run can never
  // accidentally produce an over-length video.
  maxDurationSec: 120,
  minDurationSec: 6,
  // Supabase Storage: the free plan's global per-file cap is 50 MB and the
  // bucket sets no per-bucket override (verified live via the Storage API).
  // Staying under this means the pipeline works on either plan without
  // anyone having to know which plan is active.
  maxBytes: 45 * 1024 * 1024,
  // X rejects videos whose aspect ratio falls outside 1:2.39 - 2.39:1.
  minAspect: 1 / 2.39,
  maxAspect: 2.39,
};

/** Filename/content-type pair for the Supabase upload. */
export const VIDEO_MIME = 'video/mp4';

/** True when ffmpeg is callable. Checked once, with a specific error. */
export async function assertFfmpegAvailable() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    const { stdout } = await run('ffmpeg', ['-version'], { timeout: 15000 });
    return { ok: true, version: (stdout.split('\n')[0] || '').trim() };
  } catch (err) {
    return {
      ok: false,
      reason:
        `ffmpeg not runnable (${err.code || err.message}). It is NOT preinstalled on the ` +
        `ubuntu-24.04 runner image — the workflow must run 'sudo apt-get install -y ffmpeg'. ` +
        `A real ffmpeg with libx264 is required because Playwright's bundled encoder is VP8-only.`,
    };
  }
}

/**
 * Geometry for the macOS-style window the page recording is composited into.
 *
 * WHY A FRAME, AND WHY THE PAGE IS NOT RESAMPLED AT ALL
 *
 * Two earlier approaches were wrong, and both were caught by measuring rather
 * than by looking at the file size:
 *
 *   1. Recording at a 1920 CSS viewport filled only 44% of the frame. The rest
 *      was page background and the composition sat left.
 *   2. Shrinking the layout viewport to 1280 and scaling UP to 1920 filled 65%
 *      — but a 1.5x upscale softens every glyph. The file also got SMALLER,
 *      which is the visible symptom of that softening having been mistaken for
 *      an improvement.
 *
 * This is what a real recording editor does (Recordly, and the OpenScreen
 * lineage it forked from): the capture stays at native resolution and the
 * composition is built AROUND it. What was dead margin becomes the desktop
 * backdrop — the strongest available "composed, not screenshotted" signal.
 *
 * The content hole is inset by `radius` on every side so the frame's rounded
 * corners overlap the page's square corners. The hole is sized to the SOURCE,
 * so at the current capture size the page is composited 1:1 and no resampling
 * kernel touches a glyph. See the sizing block below for the defect that forced
 * this.
 *
 * PURE — no I/O — so the geometry is unit-testable.
 */
// The capture size is owned by the recorder, but the encoder's geometry is
// meaningless without it: deriving the hole from the OUTPUT is exactly what let a
// 1280 capture get upscaled inside a "downscale only" frame. Imported rather
// than duplicated so the two can never drift apart again. Not a cycle —
// repoRecorder.js imports no encoder module.
import { CSS_VIEWPORT } from './repoRecorder.js';

/**
 * @param {object} [opts]
 * @param {number} [opts.width=1920]       - output frame width
 * @param {number} [opts.height=1080]      - output frame height
 * @param {number} [opts.titlebar=44]      - window titlebar height
 * @param {number} [opts.radius=16]        - window corner radius
 * @param {number} [opts.pad=52]           - backdrop kept visible on every side
 * @param {number} [opts.sourceWidth]      - capture width; caps the hole
 * @param {number} [opts.sourceHeight]     - capture height; caps the hole
 * @param {number} [opts.cropX=0]          - left edge of the content crop
 * @param {number} [opts.cropW]            - content crop width
 * @param {number} [opts.cropH]            - content crop height
 * @returns {object} geometry, plus `native` (page needs no resample) and
 *                    `pageScale` (never > 1)
 */
export function frameGeometry({
  width = VIDEO_SPEC.width,
  height = VIDEO_SPEC.height,
  titlebar = 44,
  radius = 16,
  pad = 52,
  sourceWidth = CSS_VIEWPORT.width,
  sourceHeight = CSS_VIEWPORT.height,
  cropX = 0,
  cropW = sourceWidth,
  cropH = sourceHeight,
} = {}) {
  // The backdrop has to be VISIBLE, so the window is capped to leave `pad` on
  // every side. Sizing the hole from the output's aspect (rather than fixing a
  // margin and letting the page float inside a mismatched hole) is what makes
  // the page fill the window edge to edge — a fixed margin produced a 1.99:1
  // hole against the page's 1.78:1, so the page fitted by height and left
  // 167px of empty window beside it.
  const maxWinW = width - pad * 2;
  const maxWinH = height - pad * 2;
  // Fit a 16:9 content hole (plus chrome) inside the capped window box.
  const holeH = Math.round(maxWinH - titlebar - radius * 2); // vertical-first
  const holeW = Math.round((holeH * width) / height);
  const winW = holeW + radius * 2;
  const winH = holeH + titlebar + radius * 2;
  // If width became the binding constraint, shrink the height to match.
  const scaleW = maxWinW / winW;
  const k = Math.min(1, scaleW);
  const fW = Math.round(winW * k);
  const fH = Math.round(winH * k);

  // ── The hole is the CROP size, capped by the box above ──────────────────
  // This is the fix for the softness the frame work was supposed to remove.
  // The first framed build sized the hole from the OUTPUT (1600x900) and still
  // ran the page through the normaliser first, so a 1280x720 capture was
  // resampled TWICE: 1.5x up to 1920x1080, then 0.83x down to 1600x900. Net
  // 1.25x upscale — the exact defect that prompted the frame, still there, with
  // an extra generation of softening on top.
  //
  // So the hole is now the largest box the CROP fits into, never more. The crop
  // comes from the recorder measuring the content the viewer actually sees (see
  // contentCropBox()), and is a pure integer-pixel cut. At the current capture
  // that means the page reaches the encoder untouched: 1:1, no resampling
  // kernel anywhere near a glyph.
  const boxW = fW - radius * 2;
  const boxH = fH - titlebar - radius * 2;
  const fit = Math.min(1, boxW / cropW, boxH / cropH);
  const pageW = Math.round((cropW * fit) / 2) * 2; // even: yuv420p
  const pageH = Math.round((cropH * fit) / 2) * 2;

  const winWFinal = pageW + radius * 2;
  const winHFinal = pageH + titlebar + radius * 2;
  const winX = Math.round((width - winWFinal) / 2);
  const winY = Math.round((height - winHFinal) / 2);
  const holeX = winX + radius;
  const holeY = winY + titlebar;

  return {
    width, height, titlebar, radius, pad,
    winX, winY, winW: winWFinal, winH: winHFinal,
    holeX, holeY, holeW: pageW, holeH: pageH,
    pageW, pageH,
    pageX: holeX, pageY: holeY,
    margin: winX,
    // True when the page reaches the encoder at its native pixel size and the
    // resample filter can be omitted entirely.
    native: fit >= 1 && cropW % 2 === 0 && cropH % 2 === 0,
    pageScale: Number(fit.toFixed(4)),
    cropX,
    cropW,
    cropH,
  };
}

/**
 * Build the ffmpeg argument vector.
 *
 * Exported and pure so the exact command is unit-testable without ffmpeg
 * installed. Shell-quoting is never involved: the vector is passed straight to
 * execFile, so a filename can never be interpreted as a flag.
 *
 * @param {object} opts
 * @param {string} opts.input           - raw .webm from Playwright
 * @param {string} opts.output          - target .mp4
 * @param {string} [opts.overlay]       - RGBA frame PNG; enables the framed path
 * @param {number} [opts.trimStartSec=0]- drop the page-load head
 * @param {number} [opts.maxDurationSec]- hard cap on output length
 * @param {number} [opts.crf=24]        - quality; lower = bigger file
 * @param {boolean} [opts.zoom=false]   - slow push-in (ffmpeg zoompan)
 * @param {number} [opts.sourceWidth]   - capture width; caps the frame's hole
 * @param {number} [opts.sourceHeight]  - capture height; caps the frame's hole
 * @param {number} [opts.cropX=0]       - left edge of the content crop
 * @param {number} [opts.cropW]         - content crop width
 * @param {number} [opts.cropH]         - content crop height
 * @returns {string[]}
 */
export function buildTranscodeArgs({
  input,
  output,
  trimStartSec = 0,
  maxDurationSec = VIDEO_SPEC.maxDurationSec,
  crf = 24,
  zoom = false,
  overlay = null,
  width = VIDEO_SPEC.width,
  height = VIDEO_SPEC.height,
  sourceWidth = CSS_VIEWPORT.width,
  sourceHeight = CSS_VIEWPORT.height,
  cropX = 0,
  cropW = sourceWidth,
  cropH = sourceHeight,
  // Two-segment mode. `segments` is [{startSec, endSec, crop:{x,w,h}}, ...] of
  // length 2; `overlayA`/`overlayB` are the matching RGBA frame PNGs.
  segments = null,
  overlayA = null,
  overlayB = null,
} = {}) {
  // `-ss` before `-i` is the fast seek: it lets ffmpeg jump without decoding
  // every leading frame, which is what makes trimming a 16s blank page-load
  // head cheap. The caller measures that head; see repoRecorder.js.
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];

  if (trimStartSec > 0) args.push('-ss', trimStartSec.toFixed(2));
  args.push('-i', input);
  if (segments && overlayA && overlayB) {
    // Both overlays loop. `-loop 1` makes a still PNG a continuous stream —
    // without it the overlay input is a single frame and the composite ends
    // after one frame, which measured as a 0.0s output that then failed the
    // duration gate.
    for (const ov of [overlayA, overlayB]) {
      args.push('-loop', '1', '-framerate', String(VIDEO_SPEC.sourceFps), '-i', ov);
    }
  } else if (overlay) {
    args.push('-loop', '1', '-framerate', String(VIDEO_SPEC.sourceFps), '-i', overlay);
  }

  const filters = [
    // Normalise to exactly the target box. `increase` + `crop` guarantees a
    // full-bleed frame with no letterbox bars, whatever the source aspect was.
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
  ];

  if (zoom) {
    // A genuine camera push-in, done in the encoder rather than with a CSS
    // transform on the page. A CSS transform was tried first and rejected: it
    // scales the laid-out box without re-laying it out, which left black bars
    // at the frame edges. Encoding is post-layout, so it cannot do that.
    //
    // `fps` IS DELIBERATELY ABSENT. zoompan's fps sets the OUTPUT frame rate;
    // pinning it to VIDEO_SPEC.maxFps (60) against Playwright's 25fps source
    // made ffmpeg lose 11.67s of a 20s clip — 58% of the video silently
    // destroyed, while every spec check still passed because the surviving
    // 8.33s was perfectly valid H.264. Omitting it lets zoompan inherit the
    // source rate, which measures 20.00s with zero drift.
    // See regression test: "zoom must not pin an output frame rate".
    filters.push(
      `zoompan=z='min(zoom+0.00035,1.10)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}`
    );
  }

  // ── Framed composite ──────────────────────────────────────────────────
  // With a pre-rendered RGBA overlay this becomes a two-input filter_complex:
  // the page is scaled DOWN into the window's content hole and composited over
  // the desktop backdrop. `lanczos` because the only resample in the chain is a
  // downscale, and lanczos is the sharpest kernel for that direction.
  //
  // Note there is no upscale anywhere: pageW/pageH are derived from a hole that
  // is smaller than the output box, so this can only add detail.
  let filterComplex = null;
  let mapped = null;
  if (segments && segments.length === 2 && overlayA && overlayB) {
    // ── Two-segment composite ──────────────────────────────────────────────
    // The capture is filmed ONCE and unbroken — cutting it into two files and
    // concatenating would cost a second encode and a visible seam. Instead both
    // composites are computed from the same input in one pass and switched with
    // an `enable` time gate on the overlay, so the output is a single continuous
    // file and the pixels are encoded exactly once.
    //
    // The gate is on the OVERLAY, not the page: the page is split once and both
    // halves are cropped differently, then each overlay is enabled only in its
    // own time range. Gating the page instead would need a concat and would
    // restart the decoder at the seam.
    const [sa, sb] = segments;
    const ga = frameGeometry({ width, height, sourceWidth, sourceHeight, cropX: sa.crop.x, cropW: sa.crop.w, cropH: sa.crop.h });
    const gb = frameGeometry({ width, height, sourceWidth, sourceHeight, cropX: sb.crop.x, cropW: sb.crop.w, cropH: sb.crop.h });
    // The gate must be a plain number ffmpeg can evaluate, and it must not be
    // Infinity — `lt(t,Infinity)` is valid but `gte(t,Infinity)` never fires,
    // which would silently leave the whole clip on segment A.
    const switchAt = Number.isFinite(sa.endSec) ? sa.endSec.toFixed(2) : String(VIDEO_SPEC.maxDurationSec);
    const chainFor = (g) => {
      const parts = [`crop=${g.cropW}:${g.cropH}:${g.cropX}:0`];
      if (!g.native) parts.push(`scale=${g.pageW}:${g.pageH}:flags=lanczos`);
      return parts.join(',');
    };
    // Segment B's window is narrower, so its page must be drawn in the RIGHT
    // place inside segment A's backdrop. Overlaying B's page on top of A's
    // composited output is what makes the switch invisible: both are full-frame,
    // and B is opaque wherever A is not.
    filterComplex = [
      `[0:v]${chainFor(ga)},format=yuva420p[pga]`,
      `[0:v]${chainFor(gb)},format=yuva420p[pgb]`,
      '[1:v]format=rgba[ova]',
      '[2:v]format=rgba[ovb]',
      `[ova][pga]overlay=x=${ga.pageX}:y=${ga.pageY}:format=auto:enable='lt(t,${switchAt})'[va]`,
      // B is composited on its own full-frame backdrop, then gated, then laid
      // over A. Segment B's backdrop is fully opaque, so covering A entirely
      // from the switch onward leaves no seam.
      `[ovb][pgb]overlay=x=${gb.pageX}:y=${gb.pageY}:format=auto[vb]`,
      `[va][vb]overlay=x=0:y=0:format=auto:enable='gte(t,${switchAt})'[v]`,
    ].join(';');
    mapped = '[v]';
  } else if (overlay) {
    const g = frameGeometry({ width, height, sourceWidth, sourceHeight, cropX, cropW, cropH });
    // The page goes DIRECTLY from the capture to the hole: a pure integer-pixel
    // crop, then a scale only if the crop still does not fit. The normaliser
    // above is deliberately NOT applied here — it targets the full 1920x1080
    // output, so running it first upscaled a 1280x720 capture 1.5x and the hole
    // scale scaled it back down: two generations of softening and a net 1.25x
    // upscale, in a filter chain whose comment claimed no upscale existed.
    //
    // When the crop is already the right size the `scale` is dropped. A 1:1
    // `scale` is arithmetically a no-op but still round-trips every pixel through
    // swscale with chroma conversion, which is a real (if small) loss on text
    // that has to survive being watched at 400px wide on a phone.
    const parts = [`crop=${g.cropW}:${g.cropH}:${g.cropX}:0`];
    if (!g.native) parts.push(`scale=${g.pageW}:${g.pageH}:flags=lanczos`);
    const pageChain = `[0:v]${parts.join(',')},format=yuva420p[pg]`;
    filterComplex = [
      pageChain,
      '[1:v]format=rgba[ov]',
      // The overlay's transparent hole lets the page show through; the frame's
      // rounded corners and border cover the page's square corners.
      `[ov][pg]overlay=x=${g.pageX}:y=${g.pageY}:format=auto[v]`,
    ].join(';');
    mapped = '[v]';
  }

  const encodeTail = [
    // X: "Video Codec: H264 High Profile". Anything else may fail to process.
    '-c:v', 'libx264',
    '-profile:v', VIDEO_SPEC.profile,
    '-preset', 'medium',
    '-crf', String(crf),
    // yuv420p is the pixel format every X/Buffer consumer expects; libx264 will
    // refuse some inputs without it, and it is what makes the file play in
    // Safari/QuickTime as well.
    '-pix_fmt', 'yuv420p',
    // Move the moov atom to the front so playback can start before the file is
    // fully downloaded. Without this a Buffer/X fetch of the file can stall.
    '-movflags', '+faststart',
    // Silent by design. X plays silent video fine, and dropping the audio
    // track removes any dependency on an AAC encoder and cuts file size ~30%.
    '-an',
  ];

  if (filterComplex) {
    // The overlay loops forever, so the output must be bounded explicitly.
    // `-t` is an OUTPUT option and MUST come after `-filter_complex`: placed
    // before it, it was silently not honoured and the encode ran until killed
    // (a 22s clip produced 120s and one diagnostic run hung outright).
    // `-shortest` ends the output when the page input ends, so the clip length
    // is the PAGE's length, with `-t` only as an upper bound.
    // `-r` pins the rate instead of letting the overlay's loop rate dictate it,
    // which had pushed the result to 60fps.
    args.push('-filter_complex', filterComplex, '-map', mapped, ...encodeTail);
    args.push('-r', String(VIDEO_SPEC.sourceFps), '-shortest');
    if (maxDurationSec > 0) args.push('-t', String(maxDurationSec));
    args.push(output);
    return args;
  }

  args.push('-vf', filters.join(','), ...encodeTail);
  if (maxDurationSec > 0) args.push('-t', String(maxDurationSec));
  args.push(output);
  return args;
}

/**
 * Probe a file with ffprobe. Returns a normalized summary, never throws.
 * @param {string} file
 * @returns {Promise<{ok: boolean, reason?: string, specs?: object}>}
 */
export async function probeVideo(file) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      file,
    ], { timeout: 30000, maxBuffer: 1 << 24 });

    const parsed = JSON.parse(stdout);
    const video = (parsed.streams || []).find((s) => s.codec_type === 'video');
    if (!video) return { ok: false, reason: 'no video stream in file' };

    const [num, den] = String(video.r_frame_rate || '0/1').split('/');
    const fps = den && Number(den) !== 0 ? Number(num) / Number(den) : 0;
    const width = Number(video.width) || 0;
    const height = Number(video.height) || 0;
    const bytes = Number(parsed.format?.size) || 0;
    const duration = Number(parsed.format?.duration) || 0;
    const bitrate = Number(video.bit_rate || parsed.format?.bit_rate || 0);

    return {
      ok: true,
      specs: {
        codec: video.codec_name,
        profile: video.profile,
        pixFmt: video.pix_fmt,
        width, height, fps,
        bytes,
        mb: bytes / (1024 * 1024),
        duration,
        bitrateMbps: bitrate ? bitrate / 1_000_000 : 0,
        aspect: height ? width / height : 0,
        hasAudio: (parsed.streams || []).some((s) => s.codec_type === 'audio'),
      },
    };
  } catch (err) {
    return { ok: false, reason: `ffprobe failed: ${err.message}` };
  }
}

/**
 * Interpret a series of per-frame luma means.
 *
 * WHY THIS EXISTS
 * validateVideoSpecs() checks container, codec, resolution, duration, bitrate
 * and size. Every one of those is a property of the FILE. None of them is a
 * property of the PICTURE. A recording in which Playwright never scrolled, or
 * which captured an empty page, produces a perfectly valid H.264 MP4 of the
 * right length and it would sail through every existing gate and go to X as a
 * motionless rectangle. That is the worst failure this pipeline has, because it
 * is invisible in the logs and looks fine in Buffer.
 *
 * MEASURED, not assumed. signalstats YAVG over a real capture and three
 * deliberately broken ones:
 *
 *     video                    YAVG min   avg     max    spread
 *     real scrolling capture     33.8     35.2    38.4     4.6
 *     solid black                 16.0     16.0    16.0     0.0
 *     solid white                235.0    235.0   235.0     0.0
 *     real content, frozen        35.5     35.5    35.5     0.0
 *
 * The last row is the important one. A FROZEN video has the same average
 * luma as a real one — a "is it too dark / too bright" check passes it. Only
 * the SPREAD across the whole clip separates them, because scrolling is
 * precisely what makes frame-to-frame brightness vary. So both checks are
 * required, and neither one is sufficient alone.
 *
 * PURE — no I/O — so the thresholds are unit-testable.
 *
 * @param {number[]} yavg - per-frame mean luma, 0-255
 * @returns {{ok:boolean, reason?:string, mean?:number, min?:number, max?:number, spread?:number}}
 */
export function assessFrameContent(yavg) {
  if (!Array.isArray(yavg) || yavg.length < 2) {
    return { ok: false, reason: `only ${yavg?.length ?? 0} frame(s) sampled — cannot judge content` };
  }
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of yavg) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const n = yavg.filter(Number.isFinite).length;
  if (n < 2) return { ok: false, reason: 'too few valid frame samples' };
  const mean = sum / n;
  const spread = max - min;
  const stats = { mean: Number(mean.toFixed(2)), min: Number(min.toFixed(2)), max: Number(max.toFixed(2)), spread: Number(spread.toFixed(2)) };

  // Uniform black / white / any single flat tone. YAVG of 16 is black and 235
  // is white in limited range; the band between is deliberately wide so a dark
  // but real GitHub dark-mode page (measured 33.8-38.4) is nowhere near it.
  if (spread < 1.0) {
    if (mean <= 24) return { ok: false, reason: `frame is uniformly black (mean luma ${stats.mean}, spread ${stats.spread}) — nothing was filmed`, ...stats };
    if (mean >= 200) return { ok: false, reason: `frame is uniformly white (mean luma ${stats.mean}, spread ${stats.spread}) — nothing was filmed`, ...stats };
    return { ok: false, reason: `frame never changes (mean luma ${stats.mean}, spread ${stats.spread}) — the page did not scroll, so this is a still image, not a recording`, ...stats };
  }
  return { ok: true, ...stats };
}

/**
 * Measure per-frame luma across a whole file with ffmpeg signalstats.
 * Scales to 64x36 first so this stays cheap on a 20s 1080p clip.
 * @param {string} file
 * @returns {Promise<{ok:boolean, reason?:string, yavg?:number[]}>}
 */
export async function measureFrameLuma(file) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    // `metadata=print:file=-` writes to stdout, so the values arrive on stdout
    // rather than stderr. Sampling every 10th frame keeps this ~30 samples on
    // a 12s clip, which is ample to see whether anything moved.
    const { stdout } = await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', file,
      '-vf', 'scale=64:36,select=not(mod(n\\,10)),signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
      '-f', 'null', '-',
    ], { timeout: 120000, maxBuffer: 1 << 24 });
    const yavg = (stdout.match(/YAVG=([0-9.]+)/g) || [])
      .map((m) => Number(m.slice(5)))
      .filter(Number.isFinite);
    return { ok: true, yavg };
  } catch (err) {
    // Measurement failure must NOT block a good video. The content gate is a
    // safety net, not the primary check; a missing ffmpeg filter must degrade
    // to "could not measure" rather than to "reject".
    return { ok: false, reason: `could not measure frame content: ${err.message}` };
  }
}

/**
 * Gate a probed file against VIDEO_SPEC. Returns a REASON on failure so the
 * pipeline log names the actual problem instead of "video failed".
 * @param {object} probe - result of probeVideo()
 * @returns {{ok: boolean, reason: string|null, specs: object|null}}
 */
export function validateVideoSpecs(probe) {
  if (!probe?.ok) return { ok: false, reason: probe?.reason || 'probe failed', specs: null };
  const s = probe.specs;

  if (s.codec !== VIDEO_SPEC.videoCodec) {
    return { ok: false, reason: `codec is ${s.codec}, X requires ${VIDEO_SPEC.videoCodec}`, specs: s };
  }
  if (s.pixFmt !== 'yuv420p') {
    return { ok: false, reason: `pixel format is ${s.pixFmt}, X requires yuv420p`, specs: s };
  }
  if (s.width > 1920 || s.height > 1920) {
    return { ok: false, reason: `resolution ${s.width}x${s.height} exceeds X's 1920px limit`, specs: s };
  }
  if (s.aspect < VIDEO_SPEC.minAspect || s.aspect > VIDEO_SPEC.maxAspect) {
    return { ok: false, reason: `aspect ratio ${s.aspect.toFixed(2)} is outside X's allowed range`, specs: s };
  }
  if (s.fps > VIDEO_SPEC.maxFps + 1) {
    return { ok: false, reason: `${s.fps.toFixed(0)}fps exceeds X's ${VIDEO_SPEC.maxFps}fps limit`, specs: s };
  }
  if (s.bitrateMbps > VIDEO_SPEC.maxBitrateMbps) {
    return { ok: false, reason: `${s.bitrateMbps.toFixed(1)}Mbps exceeds Buffer's ${VIDEO_SPEC.maxBitrateMbps}Mbps guidance`, specs: s };
  }
  if (s.duration > VIDEO_SPEC.maxDurationSec) {
    return { ok: false, reason: `${s.duration.toFixed(1)}s exceeds the ${VIDEO_SPEC.maxDurationSec}s cap`, specs: s };
  }
  if (s.duration < VIDEO_SPEC.minDurationSec) {
    return { ok: false, reason: `${s.duration.toFixed(1)}s is below the ${VIDEO_SPEC.minDurationSec}s minimum — nothing to watch`, specs: s };
  }
  if (s.bytes > VIDEO_SPEC.maxBytes) {
    return { ok: false, reason: `${s.mb.toFixed(1)}MB exceeds the ${(VIDEO_SPEC.maxBytes / 1048576).toFixed(0)}MB storage-safe ceiling`, specs: s };
  }

  return { ok: true, reason: null, specs: s };
}

/**
 * Full transcode + validate. Never throws.
 * @param {object} opts - see buildTranscodeArgs, plus `output`
 * @returns {Promise<{ok: boolean, reason?: string, specs?: object, args?: string[]}>}
 */
export async function transcodeToMp4(opts) {
  // zoompan lives in the unframed `-vf` chain. The framed path builds a
  // two-input graph and does not consume it, so combining them would drop the
  // zoom SILENTLY — a valid-looking encode with no push-in. Rejected loudly
  // instead. No caller does this today; v12 passes zoom:false whenever it frames.
  if (opts.overlay && opts.zoom) {
    return {
      ok: false,
      reason:
        'zoom + overlay is not supported: the framed filter graph does not apply zoompan, ' +
        'so the zoom would be silently discarded. Pass zoom:false, or omit the overlay.',
    };
  }

  const ffmpeg = await assertFfmpegAvailable();
  if (!ffmpeg.ok) return { ok: false, reason: ffmpeg.reason };

  // When compositing over a looping overlay, the output length must be pinned to
  // the PAGE's length, not the cap.
  //
  // `-shortest` is not reliable here: with `-t` also set, ffmpeg kept producing
  // the full 120s cap for a ~25s clip, and a diagnostic run without a working
  // bound hung until killed. So the source is probed first and the exact
  // remaining duration becomes `-t`. That is measurable rather than inferred
  // from flag semantics, and it costs one ffprobe call we already make.
  let effective = opts;
  // Both single-crop and two-segment framing must bound the length the same way:
  // the source is probed and the exact remaining duration becomes `-t`.
  if (opts.overlay || (opts.segments && opts.overlayA && opts.overlayB)) {
    const src = await probeVideo(opts.input);
    if (!src.ok) return { ok: false, reason: `cannot probe source for framing: ${src.reason}` };
    const remaining = Math.max(0.1, src.specs.duration - (opts.trimStartSec || 0));
    const cap = opts.maxDurationSec > 0 ? opts.maxDurationSec : VIDEO_SPEC.maxDurationSec;
    const exact = Math.min(remaining, cap);
    if (exact < opts.maxDurationSec) {
      console.log(`  ⏱ frame bound: source ${src.specs.duration.toFixed(1)}s − trim ${(opts.trimStartSec || 0).toFixed(1)}s = ${exact.toFixed(1)}s output`);
    }
    effective = { ...opts, maxDurationSec: exact };
  }

  const args = buildTranscodeArgs(effective);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  try {
    await run('ffmpeg', args, { timeout: opts.timeoutMs || 240000, maxBuffer: 1 << 24 });
  } catch (err) {
    const detail = (err.stderr || err.message || '').toString().trim().split('\n').slice(-2).join(' | ');
    return { ok: false, reason: `ffmpeg transcode failed: ${detail || 'unknown error'}`, args };
  }

  const probe = await probeVideo(opts.output);
  const verdict = validateVideoSpecs(probe);
  if (!verdict.ok) return { ...verdict, args, ffmpegVersion: ffmpeg.version };

  // ── Content gate ────────────────────────────────────────────────────────
  // The spec gate above validates the FILE. This validates the PICTURE. Without
  // it a motionless or blank recording is a valid H.264 MP4 of the right
  // length and reaches X unnoticed. See assessFrameContent() for the numbers.
  const luma = await measureFrameLuma(opts.output);
  if (!luma.ok) {
    console.warn(`  ⚠ content gate skipped: ${luma.reason}`);
    return { ...verdict, args, ffmpegVersion: ffmpeg.version, contentGate: 'unavailable' };
  }
  const content = assessFrameContent(luma.yavg);
  if (!content.ok) {
    return {
      ok: false,
      reason: content.reason,
      specs: probe.specs,
      args,
      ffmpegVersion: ffmpeg.version,
      contentGate: 'rejected',
    };
  }
  console.log(
    `  ✓ content gate: ${luma.yavg.length} samples, mean luma ${content.mean}, ` +
    `spread ${content.spread} — real motion, not a still image`
  );
  return { ...verdict, args, ffmpegVersion: ffmpeg.version, contentGate: 'passed', content };
}
