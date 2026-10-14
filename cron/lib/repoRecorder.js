/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   REPO RECORDER — v12 GITHUB SCREEN-RECORDING ENGINE            ║
 * ║   cron/lib/repoRecorder.js                                       ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Films a real GitHub repository page in headless Chromium and   ║
 * ║   produces a raw WebM for videoEncoder.js to transcode.          ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * WHY A REAL PAGE RECORDING (not a rendered mockup)
 *
 * The account's existing v9 card is a Playwright screenshot of the real repo
 * wrapped in a rendered macOS frame. The v12 format is a real screen
 * recording: the actual github.com DOM, in dark mode, scrolled and
 * text-selected live. It is the format the reference recording uses, and it
 * reads as a person actually looking at the repository.
 *
 * It also satisfies X's Original Content Rewards on its own terms — the asset
 * is a capture of the real page, not somebody else's artwork.
 *
 * THE PAGE-LOAD PROBLEM (measured, not assumed)
 *
 * `recordVideo` is a CONTEXT option, so recording begins the moment the
 * context is created — which is BEFORE navigation. GitHub takes 10-22s to
 * reach networkidle in CI, and all of it lands in the file as a blank frame.
 * The first attempt produced a 27s video of which roughly 15s was black.
 *
 * Playwright offers no way to start recording later, so the head is measured
 * (ms from context creation to "page is ready to film") and handed to
 * videoEncoder.js, which trims it with a fast `-ss` seek. A small safety
 * margin is added so the cut can never land mid-paint.
 *
 * LENGTH IS BUDGETED, NOT DERIVED
 *
 * Clip duration is a product requirement — the reference clip is ~21s — so
 * scroll time is budgeted rather than stepped. A fixed wheel step size made
 * scroll duration scale with page height: a 20,000px README produced 35s while
 * a short one produced 10s from identical code. Budgeting the time and solving
 * for the step size pins the total and keeps the pacing consistent.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Capture geometry, chosen by measurement rather than by picking the biggest
 * number X allows.
 *
 * `CSS_VIEWPORT` is what GitHub lays out for. The encoded frame is 1920x1080.
 *
 * MEASURED content-column fill (share of frame width occupied by the README):
 *     1920 CSS px  ->  44% fill, 1082px dead   (the original setting)
 *     1600 CSS px  ->  52% fill,  914px dead
 *     1440 CSS px  ->  58% fill,  802px dead
 *     1280 CSS px  ->  65% fill,  664px dead   <- chosen
 *     1152 CSS px  ->  62% fill,  736px dead   (column hits a floor, worse again)
 *
 * GitHub's README column is roughly 840-1260 CSS px regardless of viewport, so
 * a wider viewport just adds empty margin around it. The first real v12
 * recording showed this as a dead right third with the composition pushed left.
 * Recording at 1280 CSS px and letting the encoder scale to 1920 fixes it.
 *
 * WHY deviceScaleFactor IS PINNED TO 1
 *
 * The obvious alternative — a 1280 CSS viewport at deviceScaleFactor 1.5 — was
 * tried first on the theory that it would yield true 1920x1080 device pixels
 * with no upscale. It does not work. The recorded WebM reports 1920x1080, but
 * the page content occupies only the top-left 1280x720 of it and the remainder
 * is a partially-composited gradient: Chromium's screencast surface and
 * Playwright's video encoder disagree about the frame size. The result is a
 * visibly broken frame, so dSF stays at 1 and the 1.5x scale happens once, in
 * the encoder, where it is deterministic and testable. GitHub's body text is
 * 14-16px, which stays legible at that scale.
 */
export const CSS_VIEWPORT = { width: 1280, height: 720 };
export const DEVICE_SCALE_FACTOR = 1;

/** Final encoded frame. Matches X's landscape ceiling and is exactly 16:9. */
export const OUTPUT_VIEWPORT = { width: 1920, height: 1080 };

/** Kept for callers that only care about the encoded frame. */
export const RECORD_VIEWPORT = OUTPUT_VIEWPORT;

/** How long to wait after networkidle before the page is considered filmable. */
const SETTLE_MS = 1400;

/**
 * Wall-clock budget for ONE scroll beat.
 *
 * 4 beats x (SCROLL_BUDGET_MS + BEAT_HOLD_MS) + FINAL_HOLD_MS ~= 17s of
 * deliberate motion, plus the selection beat — landing near the 21s reference.
 */
const SCROLL_BUDGET_MS = 1500;

/** How long each scroll section is held, so it can actually be read. */
const BEAT_HOLD_MS = 2000;

/** Hold on the final frame before the cut. */
const FINAL_HOLD_MS = 1600;

/** Safety margin added to the measured load time, so the trim never cuts mid-paint. */
const TRIM_MARGIN_SEC = 0.35;

/**
 * How much of the settled landing view to keep immediately before the
 * selection sweep, so the clip opens on the repo rather than mid-highlight.
 * Measured: the sweep itself is ~1.5s, so 0.8s of lead-in is enough to read the
 * repo name and star count before the cursor starts moving.
 */
export const PRE_SWEEP_HOLD_SEC = 0.8;

const NAV_TIMEOUT_MS = 35000;
const IDLE_TIMEOUT_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Selectors for the About sidebar description, in order of preference.
 *
 * MEASURED, NOT GUESSED. A DOM probe of a live repo page found the About text
 * as:
 *     <p class="SidebarAbout-module__description__xTkIP prc-Text-Text-9mHv3">
 * and found NO <aside> element anywhere — GitHub has replaced the old
 * `.BorderGrid-cell` / `aside .f4` layout this codebase was written against,
 * which is why every class-based selector silently matched nothing.
 *
 * That class is a CSS-Module name whose trailing hash is regenerated on every
 * GitHub deploy, so an exact class match would rot without warning. The stable,
 * matchable part is the prefix, hence the attribute-substring form.
 * `resolveSelectionTarget` still ends in a geometric fallback that depends on
 * no class name at all.
 */
export const ABOUT_DESCRIPTION_SELECTORS = [
  'p[class*="SidebarAbout"][class*="description"]',
  '[data-testid="about-description"]',
  '[class*="BorderGrid-cell"] p',
  'aside p',
  'aside .f4',
];

/**
 * Minimum text length for an element to be worth sweeping a selection across.
 *
 * 18, not 40. Measured: langchain-ai/langchain has a 31-character About
 * description, and a 40-char floor rejected it — so the selection beat silently
 * vanished on exactly the repos most likely to be featured. A 31-character
 * highlight across a 272px-wide block still reads as a deliberate drag, and the
 * width/height/column checks are what keep stray tab labels and topic pills out.
 */
const MIN_SELECTION_CHARS = 18;

/**
 * Resolve a text-dense element to sweep-select, plus its box.
 *
 * Strategy: try the known selectors, then fall back to GEOMETRY. The geometric
 * pass finds the largest text block in the right-hand column, which is where the
 * About description lives on every GitHub layout this account has seen — and it
 * keeps working when GitHub renames its CSS modules, which it does frequently
 * and without warning.
 *
 * Returns null when nothing suitable is found; the caller then SKIPS the
 * selection beat. A missing highlight is cosmetic, a thrown error is not.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{box: object, source: string, chars: number}|null>}
 */
export async function resolveSelectionTarget(page) {
  for (const selector of ABOUT_DESCRIPTION_SELECTORS) {
    let handle;
    try {
      handle = await page.$(selector);
    } catch {
      continue; // selector this GitHub build cannot parse — try the next
    }
    if (!handle) continue;
    try {
      const text = ((await handle.innerText()) || '').trim();
      const box = await handle.boundingBox();
      if (box && text.length > MIN_SELECTION_CHARS && box.height > 18 && box.width > 120) {
        return { box, source: selector, chars: text.length };
      }
    } catch {
      /* detached mid-query */
    } finally {
      await handle.dispose().catch(() => {});
    }
  }

  // Geometric fallback — no class names involved.
  try {
    const found = await page.evaluate(
      ({ minX, minChars, minW, minH, padTop, padBottom }) => {
        let best = null;
        document.querySelectorAll('p, div, span').forEach((el) => {
          if (el.children.length > 0) return; // leaves only
          const t = (el.innerText || '').trim();
          if (t.length < minChars) return;
          const r = el.getBoundingClientRect();
          if (r.width < minW || r.height < minH) return;
          if (r.x < minX) return;              // right-hand column only
          // Only what is on camera can be selected, so the vertical window is
          // bounded by the viewport rather than the document.
          if (r.y < padTop || r.y > window.innerHeight - padBottom) return;
          const score = t.length + r.height * 4;
          if (!best || score > best.score) {
            best = { score, chars: t.length, x: r.x, y: r.y, width: r.width, height: r.height };
          }
        });
        return best;
      },
      {
        minX: CSS_VIEWPORT.width * 0.55,
        minChars: MIN_SELECTION_CHARS,
        minW: 150,
        minH: 20,
        padTop: 80,
        padBottom: 80,
      }
    );

    if (found) {
      return {
        box: { x: found.x, y: found.y, width: found.width, height: found.height },
        source: 'geometric:right-column',
        chars: found.chars,
      };
    }
  } catch { /* fall through to null */ }

  return null;
}

/**
 * Weights for the kinds of content that make a frame worth looking at.
 *
 * WHY THIS EXISTS — the defect it fixes
 *
 * Beats were previously fixed fractions of the scrollable range. That made
 * clip LENGTH predictable (good) but it sampled the page blindly, so a
 * fraction landing in the middle of a wall of prose produced a beat nobody
 * could read. Measured on a real recording: the last 8 of 20.8 seconds were
 * unbroken paragraphs about SQLite adapters and token budgets, with no
 * heading, code block or image anywhere in frame — and because that was the
 * LAST beat it was also the final frame a viewer saw.
 *
 * Beats are now chosen for visual content, and only fall back to fractions on
 * a page that genuinely has none.
 */
export const CONTENT_WEIGHTS = {
  pre: 5,        // a code block is the single most skimmable thing on a README
  table: 4,      // architecture tables read as a diagram
  img: 4,        // diagrams, badges, screenshots
  video: 4,
  heading: 3,    // h1/h2/h3 gives the eye an anchor
  list: 2,       // bullets are scannable
  blockquote: 2,
  hr: 1,
};

/** A paragraph longer than this is treated as prose mass, not a feature. */
const PROSE_BLOCK_MIN_CHARS = 220;

/**
 * Score candidate scroll positions by what would actually be visible.
 *
 * PURE and exported so it is unit-testable without a browser. `candidates` are
 * absolute document Y positions; `anchors` are the Y positions of attractive
 * elements; `prose` are the Y positions of long paragraphs.
 *
 * A candidate scores the weighted sum of anchors visible in its viewport,
 * minus a penalty proportional to how much unbroken prose shares that viewport.
 * The prose penalty is what stops a beat from landing inside a wall of text
 * even when a heading happens to be nearby.
 *
 * @param {Array<{y:number}>} candidates
 * @param {Array<{y:number, weight:number}>} anchors
 * @param {Array<{y:number, chars:number}>} prose
 * @param {number} viewportH
 * @returns {Array<{y:number, score:number, features:number, proseChars:number}>}
 */
export function scoreCandidates(candidates, anchors, prose, viewportH) {
  const scored = candidates.map((c) => {
    const top = c.y;
    const bottom = c.y + viewportH;
    let features = 0;
    for (const a of anchors) {
      // An element counts as visible if any part of it is inside the viewport.
      if (a.y >= top && a.y <= bottom) features += a.weight;
    }
    let proseChars = 0;
    for (const p of prose) {
      if (p.y >= top && p.y <= bottom) proseChars += p.chars;
    }
    // ~1 point per 400 prose characters, so a heading surrounded by two long
    // paragraphs still loses to a heading surrounded by a code block.
    const score = features - proseChars / 400;
    return { y: c.y, score, features, proseChars };
  });
  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Choose the final beat set from scored candidates.
 *
 * Requirements this encodes, each from an observed failure:
 *   - N beats, spread out, minimum spacing (a walkthrough, not a jump-cut).
 *   - The LAST beat must be a good one — it is the final frame of the video.
 *   - Never deeper than the last attractive content plus one viewport.
 *   - Falls back to even fractions when a page has no attractive content at all,
 *     because a boring clip beats no clip.
 *
 * @param {object} p
 * @param {Array} p.candidates  scored candidates (any order)
 * @param {number} p.maxY       deepest scrollable position
 * @param {number} p.viewportH
 * @param {number} [p.count=4]
 * @param {number} [p.minGapRatio=0.12] - min gap between beats, as a share of maxY
 * @returns {Array<{label:string, y:number, score:number}>}
 */
export function selectBeats({ candidates, maxY, viewportH, count = 4, minGapRatio = 0.12 }) {
  const minGap = Math.max(400, maxY * minGapRatio);
  const hasFeatures = candidates.some((c) => c.features > 0);

  // Filler for pages with nothing worth looking at.
  const filler = Array.from({ length: count }, (_, i) => ({
    label: `scroll-${Math.round(((i + 1) / (count + 1)) * 100)}pct`,
    y: (maxY * (i + 1)) / (count + 1),
    score: 0,
  }));
  if (!hasFeatures) return filler;

  // Greedy pick, highest score first, respecting the minimum gap.
  const pool = [...candidates].sort((a, b) => b.score - a.score);
  const chosen = [];
  for (const c of pool) {
    if (chosen.length >= count) break;
    if (chosen.some((k) => Math.abs(k.y - c.y) < minGap)) continue;
    chosen.push(c);
  }
  // Backfill from the even fractions if greedy could not fill the slots.
  for (const f of filler) {
    if (chosen.length >= count) break;
    if (chosen.some((k) => Math.abs(k.y - f.y) < minGap)) continue;
    chosen.push({ ...f, score: 0 });
  }
  if (!chosen.length) return filler;

  chosen.sort((a, b) => a.y - b.y);

  // Clamp the walkthrough to the last attractive content plus one viewport, so
  // the clip never ends in the dead zone below the final feature.
  const lastFeature = Math.max(...candidates.filter((c) => c.features > 0).map((c) => c.y), 0);
  const depthCap = Math.min(maxY, lastFeature + viewportH * 1.15);
  const clamped = chosen.filter((c) => c.y <= depthCap);
  if (!clamped.length) clamped.push(chosen[0]);

  return clamped.map((c) => ({
    label: c.features > 0 ? `feature(${c.features})` : c.label,
    y: Math.round(c.y),
    score: Number(c.score.toFixed(2)),
  }));
}

/**
 * Plan the scroll walkthrough.
 *
 * Reads the live DOM, scores every plausible scroll position by the visual
 * content that would be in frame, and hands the decision to selectBeats().
 * See CONTENT_WEIGHTS for why this replaced fixed fractions.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{beats: Array<{label: string, y: number, score: number}>, maxY: number}>}
 */
export async function planScrollBeats(page) {
  const data = await page.evaluate(() => {
    const abs = (el) => el.getBoundingClientRect().top + window.scrollY;
    const anchors = [];
    const prose = [];

    const addAnchor = (el, weight) => {
      const y = abs(el);
      // Ignore anything that is collapsed or effectively invisible.
      const r = el.getBoundingClientRect();
      if (r.height < 4 || r.width < 4) return;
      if (y < 0) return;
      anchors.push({ y, weight });
    };

    const root = document.querySelector('article.markdown-body') || document.body;

    root.querySelectorAll('pre').forEach((el) => addAnchor(el, 5));
    root.querySelectorAll('table').forEach((el) => addAnchor(el, 4));
    root.querySelectorAll('img').forEach((el) => addAnchor(el, 4));
    root.querySelectorAll('video').forEach((el) => addAnchor(el, 4));
    root.querySelectorAll('h1, h2, h3').forEach((el) => addAnchor(el, 3));
    root.querySelectorAll('ul, ol').forEach((el) => addAnchor(el, 2));
    root.querySelectorAll('blockquote').forEach((el) => addAnchor(el, 2));
    root.querySelectorAll('hr').forEach((el) => addAnchor(el, 1));

    // Prose mass: leaf paragraphs with no inline structure worth looking at.
    root.querySelectorAll('p').forEach((el) => {
      if (el.querySelector('pre, table, img')) return;
      const chars = (el.innerText || '').trim().length;
      if (chars < 220) return;
      prose.push({ y: abs(el), chars });
    });

    const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const viewportH = window.innerHeight;

    // Sample candidate positions densely; scoring is cheap and the selector
    // then picks the best spread from these.
    const candidates = [];
    const step = Math.max(150, Math.floor(viewportH / 6));
    for (let y = 0; y <= maxY; y += step) {
      candidates.push({ y, anchors, prose, viewportH });
      // Only pass the big arrays once; the scorer needs them per candidate.
      candidates[candidates.length - 1] = { y };
    }
    return { anchors, prose, maxY, viewportH, candidates: candidates.map((c) => c.y), step };
  });

  // Score outside the page context so the pure function is the single source
  // of truth for the weighting.
  const scored = scoreCandidates(
    data.candidates.map((y) => ({ y })),
    data.anchors,
    data.prose,
    data.viewportH
  );

  const beats = selectBeats({ candidates: scored, maxY: data.maxY, viewportH: data.viewportH });
  return { beats, maxY: data.maxY };
}

/**
 * Merge an on-screen content extent into a running union, for the frame crop.
 *
 * WHY THIS EXISTS
 * GitHub's README column is a fixed ~870px wide no matter how wide the viewport
 * is, and the repo landing page renders no file-tree sidebar at all. Measured on
 * affaan-m/ECC at five scroll depths:
 *
 *     viewport    scroll 0 (header)   scroll 0.15-0.75 (README)
 *     1280x720    x    0..1248        x   33..903    (68% fill)
 *     1600x900    x    0..1555        x  193..1063   (54% fill)
 *
 * So a fixed crop cannot work — the header needs 1248px and the README needs
 * 903px, and widening the capture makes the void WORSE, not better, because the
 * extra width becomes padding. Instead the extent is measured at each scroll
 * position the recorder already visits and the union is cropped to, so the
 * crop contains exactly what the video shows and never clips any of it.
 *
 * PURE — no I/O — so the union logic is unit-testable without a browser.
 *
 * @param {{left:number,right:number}|null} current - running union, or null
 * @param {{left:number,right:number}|null} sample  - one measurement, or null
 * @param {number} viewportWidth
 * @returns {{left:number,right:number}|null}
 */
export function mergeContentExtent(current, sample, viewportWidth) {
  if (!sample || !(sample.right > sample.left)) return current;
  const left = Math.max(0, Math.floor(Math.min(current ? current.left : sample.left, sample.left)));
  const right = Math.min(
    viewportWidth,
    Math.ceil(Math.max(current ? current.right : sample.right, sample.right))
  );
  return right > left ? { left, right } : current;
}

/**
 * Turn a merged extent into a crop box for the frame composite.
 *
 * The crop is a pure integer-pixel CUT, so it cannot soften anything — which is
 * the whole point, since the alternative (scaling the capture to fill the frame)
 * was what destroyed the text.
 *
 * @param {{left:number,right:number}|null} extent
 * @param {object} [opts]
 * @param {number} [opts.viewportWidth]
 * @param {number} [opts.viewportHeight]
 * @param {number} [opts.minWidthFrac=0.55] - below this, the page is too sparse
 *   to crop confidently and the full viewport is kept
 * @param {number} [opts.slackPx=8]        - breathing room at each edge
 * @returns {{x:number, y:number, w:number, h:number, cropped:boolean}}
 */
export function contentCropBox(extent, {
  viewportWidth,
  viewportHeight,
  minWidthFrac = 0.55,
  slackPx = 8,
} = {}) {
  const full = { x: 0, y: 0, w: viewportWidth, h: viewportHeight, cropped: false };
  if (!extent) return full;

  // Snap OUTWARD to even pixels: yuv420p needs even dimensions and an odd crop
  // width would force a resample on the very path that exists to avoid one.
  const pad = Math.ceil(slackPx / 2) * 2;
  const left = Math.max(0, Math.floor((extent.left - pad) / 2) * 2);
  const right = Math.min(
    viewportWidth,
    Math.ceil((extent.right + pad) / 2) * 2
  );
  const w = right - left;
  if (w < viewportWidth * minWidthFrac) return full;
  // A crop that saves less than a few percent is not worth the extra geometry
  // for — keep the whole viewport and let the frame centre it.
  if (w > viewportWidth * 0.98) return full;

  return { x: left, y: 0, w, h: viewportHeight, cropped: true };
}

/**
 * Measure the horizontal extent of text that is ACTUALLY ON SCREEN right now.
 *
 * The vertical filter is the load-bearing part. An earlier probe skipped it for
 * the horizontal pass, so the About sidebar — which exists only near the top of
 * the page — inflated the right edge to 1248px at EVERY scroll depth and
 * reported a 98% fill that the rendered video frame plainly contradicts. An
 * element scrolled off the top of the viewport still has a rect.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{left:number,right:number}|null>}
 */
async function measureOnScreenExtent(page) {
  return page.evaluate(() => {
    const vh = window.innerHeight;
    let left = Infinity;
    let right = -Infinity;
    for (const el of document.querySelectorAll('body *')) {
      // Only the element's OWN text counts. Using textContent would make every
      // ancestor as wide as the whole page and always report a full-bleed box.
      const ownText = Array.from(el.childNodes)
        .some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 1);
      if (!ownText) continue;
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      if (b.bottom < 0 || b.top > vh) continue; // scrolled out of the viewport
      if (b.x < left) left = b.x;
      if (b.right > right) right = b.right;
    }
    return Number.isFinite(left) && right > left ? { left, right } : null;
  });
}

/**
 * Resolve when the page has finished rendering, so the trim can keep the
 * landing view instead of cutting it away.
 *
 * WHY THIS EXISTS
 * `trimStartSec` used to be measured after `networkidle` + a fixed settle. That
 * lands the cut at the LATEST possible moment, and everything that happened
 * between "the page is ready" and "the network went quiet" was thrown away.
 * Measured on affaan-m/ECC:
 *
 *     domcontentloaded        7.32s
 *     repo header ready       7.78s
 *     0.8s later              166 on-screen text elements, 35/35 images
 *     3.7s later              199 on-screen text elements, 52/52 images
 *     4.5s / 5.8s / 6.4s      199 and 52/52 — IDENTICAL, render is done
 *     networkidle            16.16s
 *     after the old settle   17.57s   <-- where trimStartSec used to land
 *
 * So roughly SIX seconds of a fully-rendered, stable landing view was being
 * discarded. That is the best-looking frame in the video — repo name, star and
 * fork counts, file tree, About sidebar, topics — and it was the frame the
 * trim existed to protect the viewer from.
 *
 * A fixed wait cannot fix this, because the render time is a property of the
 * repo and the network, not of this file. So the page is POLLED and the cut is
 * placed at the first moment the rendered content stops changing. A slow page
 * waits longer; a fast one cuts earlier; both keep the landing view.
 *
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 * @param {number} [opts.quietMs=700]   - unchanged for this long = settled
 * @param {number} [opts.timeoutMs=9000]- never wait longer than this
 * @param {number} [opts.intervalMs=250]
 * @returns {Promise<{stable: boolean, elapsedMs: number, signature: string}>}
 */
export async function waitForRenderStable(page, {
  quietMs = 700,
  timeoutMs = 9000,
  intervalMs = 250,
} = {}) {
  const started = Date.now();
  let lastSig = null;
  let unchangedSince = Date.now();

  // Only the content actually ON SCREEN counts, for the same reason
  // measureOnScreenExtent() applies its vertical filter: an element scrolled
  // out of view still has a rect, and counting it would make the page look
  // settled before it has painted.
  const sample = () => page.evaluate(() => {
    const vh = window.innerHeight;
    let textEls = 0;
    for (const el of document.querySelectorAll('body *')) {
      const own = Array.from(el.childNodes)
        .some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 1);
      if (!own) continue;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      if (b.bottom < 0 || b.top > vh) continue;
      textEls++;
    }
    const imgs = Array.from(document.images).filter((i) => i.complete && i.naturalWidth > 0).length;
    const header = !!document.querySelector(
      '#repository-container-header, [data-testid="repository-container-header"]'
    );
    return `${textEls}|${imgs}|${header ? 1 : 0}`;
  }).catch(() => null);

  const firstSample = await sample();
  lastSig = firstSample;
  let stable = false;

  while (Date.now() - started < timeoutMs) {
    await page.waitForTimeout(intervalMs);
    const next = await sample();
    if (next && next === lastSig) {
      if (Date.now() - unchangedSince >= quietMs) { stable = true; break; }
    } else if (next) {
      lastSig = next;
      unchangedSince = Date.now();
    }
  }
  const signature = String(lastSig);
  const [textEls, imgs, header] = signature.split('|');
  // A page that never settled is still usable — the caller falls back to the
  // old behaviour — but it must be reported, not silently accepted.
  return {
    stable,
    // An ABSOLUTE timestamp, not a duration. The caller needs to place the trim
    // against `contextCreatedAt` (the instant recording began), and a duration
    // measured from here would have to be re-based on the caller — which is
    // exactly the off-by-`waitForSelector` bug this avoids.
    settledAt: Date.now(),
    signature: `text=${textEls} imgs=${imgs} header=${header === '1'}`,
  };
}

/**
 * Scroll smoothly to an absolute Y using real wheel events.
 *
 * Wheel (rather than scrollTo) is what produces the natural, eased motion in
 * the reference recording; a programmatic scrollTo jump reads as a teleport.
 *
 * Duration is bounded by design: the distance is covered within a fixed time
 * budget by choosing the step size, so a 20,000px README and a 2,000px one
 * both take the same wall-clock time and the clip length stays predictable.
 *
 * @param {import('playwright').Page} page
 * @param {number} targetY
 * @param {object} [opts]
 * @param {number} [opts.budgetMs=SCROLL_BUDGET_MS]
 * @param {number} [opts.minStepPx=220] - never scroll slower than this per event
 * @param {number} [opts.maxStepMs=70]   - never pause longer than this per event
 */
export async function wheelTo(
  page,
  targetY,
  { budgetMs = SCROLL_BUDGET_MS, minStepPx = 220, maxStepMs = 70 } = {}
) {
  const startY = await page.evaluate(() => window.scrollY);
  const distance = Math.abs(targetY - startY);
  if (distance < 12) return;

  // Solve for a step size that lands the whole distance inside the budget.
  const desiredSteps = Math.max(1, Math.round(budgetMs / maxStepMs));
  const stepPx = Math.max(minStepPx, Math.ceil(distance / desiredSteps));
  const stepCount = Math.ceil(distance / stepPx);
  const stepMs = Math.max(8, Math.min(maxStepMs, Math.round(budgetMs / stepCount)));

  for (let guard = 0; guard < 400; guard++) {
    const y = await page.evaluate(() => window.scrollY);
    const delta = targetY - y;
    if (Math.abs(delta) < 12) break;
    await page.mouse.wheel(0, Math.sign(delta) * Math.min(stepPx, Math.abs(delta)));
    await sleep(stepMs);
  }
}

let browserPromise = null;

/** Lazily launch one Chromium and reuse it for the whole run. */
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import('playwright');
      return chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    })();
  }
  return browserPromise;
}

/** Release the shared browser. Call once at the end of a run. */
export async function closeRepoRecorder() {
  if (!browserPromise) return;
  try {
    const b = await browserPromise;
    await b.close();
  } catch { /* already gone */ }
  browserPromise = null;
}

/**
 * Film a GitHub repository page.
 *
 * @param {string} repoUrl  - e.g. https://github.com/owner/repo
 * @param {object} [opts]
 * @param {string} [opts.workDir]        - where the raw .webm is written
 * @param {boolean} [opts.selectText=true] - film the text-selection sweep
 * @returns {Promise<{ok: boolean, webmPath?: string, workDir?: string,
 *                    trimStartSec?: number, loadMs?: number, contentSec?: number,
 *                    beats?: string[], selectedChars?: number,
 *                    selectionSource?: ?string, selectionSkipped?: boolean,
 *                    reason?: string}>}
 *
 * Never throws. Every failure path returns a reason the caller can log.
 */
export async function recordRepoWalkthrough(repoUrl, opts = {}) {
  if (!repoUrl || !repoUrl.startsWith('http')) {
    return { ok: false, reason: 'invalid repo URL' };
  }

  const workDir = opts.workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'v12-rec-'));
  fs.mkdirSync(workDir, { recursive: true });

  const contextCreatedAt = Date.now();
  let browser;
  let context;

  try {
    browser = await getBrowser();
    // recordVideo MUST be set on the context. colorScheme dark makes GitHub
    // serve its dark theme (verified: body background becomes rgb(13,17,23)).
    // deviceScaleFactor stays at 1 — a 2x context would record 3840x2160 and
    // blow past X's resolution ceiling for no visible gain on a scrolling page.
    context = await browser.newContext({
      // Lay out at the TIGHT viewport. See CSS_VIEWPORT for the measurement
      // behind this and for why deviceScaleFactor is pinned to 1.
      viewport: CSS_VIEWPORT,
      colorScheme: 'dark',
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      // The recording is captured at the CSS viewport's own size — 1:1, no
      // rescale. The single, deterministic 1.5x to 1920x1080 happens in the
      // encoder (see buildTranscodeArgs), so there is exactly one scale step and
      // no second rescale fighting it.
      recordVideo: { dir: workDir, size: CSS_VIEWPORT },
    });
    const page = await context.newPage();

    // ── 1. Load ──────────────────────────────────────────────────────────
    const gotoAt = Date.now();
    await page.goto(repoUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page
      .waitForSelector('#repository-container-header, main, article.markdown-body', { timeout: 15000 })
      .catch(() => {});

    // Mark the moment the page has actually finished painting. The trim is
    // placed HERE, not after networkidle — see waitForRenderStable() for the
    // measurement that motivated it, and for why a fixed wait cannot replace it.
    const render = await waitForRenderStable(page);

    // Still wait for the network to go quiet before filming, so the recorded
    // scroll is smooth and no images pop in mid-clip. This affects the FILMING
    // only; the trim below is already fixed.
    await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS }).catch(() => {});
    await sleep(SETTLE_MS);

    // Everything from here on is the part worth keeping. The cut is at the
    // render-stable point, so the finished landing view — repo name, stars,
    // file tree, About — stays in the output instead of being trimmed away.
    const loadMs = Date.now() - gotoAt;
    let trimStartSec = Number(
      ((render.settledAt - contextCreatedAt) / 1000 + TRIM_MARGIN_SEC).toFixed(2)
    );

    // Confirm we actually landed on a repo page and not a 404 or a rate-limit
    // interstitial. A polished-looking video of an error page is worse than
    // no video, and it would ship a wrong claim about a real repository.
    const pageOk = await page.evaluate(() => {
      const hasRepo = !!document.querySelector(
        '#repository-container-header, [data-testid="repository-container-header"]'
      );
      const looksLikeError = /Page not found|rate limit|Whoa there|Something went wrong/i.test(
        document.body.innerText.slice(0, 800)
      );
      return { hasRepo, looksLikeError, title: document.title };
    });
    if (pageOk.looksLikeError) {
      return { ok: false, reason: `GitHub returned an error/interstitial page ("${pageOk.title}")` };
    }
    if (!pageOk.hasRepo) {
      return { ok: false, reason: `repo header never rendered; title="${pageOk.title}"` };
    }

    console.log(
      `    ⏱ render: ${render.stable ? 'settled' : 'DID NOT SETTLE (using the settled point anyway)'} ` +
      `at t=${(trimStartSec - TRIM_MARGIN_SEC).toFixed(2)}s (${render.signature})`
    );

    // ── 2. Plan the walkthrough BEFORE anything is filmed ──────────────────
    // ORDERING, and it is load-bearing.
    //
    // planScrollBeats() reads element geometry through a single page.evaluate
    // and never scrolls, but on a long README it takes ~15s of wall clock. If
    // it runs after the trim point — as it originally did — that time is filmed:
    // the page sits motionless on the landing view and the output opens with
    // ~21s of dead air. Measured on a real affaan-m/ECC run after moving the
    // render-stable trim: 20 of 40 output seconds were near-identical to the
    // previous second.
    //
    // So the plan runs first, while the footage is still discarded, and the
    // visible part of the recording begins at the selection sweep.
    const { beats, maxY } = await planScrollBeats(page);

    // ── 3. Cursor drift into frame ───────────────────────────────────────
    // Playwright's mouse works in CSS pixels of the layout viewport, NOT in the
    // encoded frame — so these use CSS_VIEWPORT. Getting this wrong after the
    // viewport change would park the cursor outside the visible area.
    await page.mouse.move(CSS_VIEWPORT.width * 0.74, CSS_VIEWPORT.height * 0.32, { steps: 26 });
    await sleep(600);

    // The visible part of the clip starts just before the sweep, so the video
    // opens on the finished landing view and the signature selection move, with
    // none of the planning time in front of it. The page is at the top here
    // because planning does not scroll, which is what makes the About block
    // reliably selectable again after the reorder.
    const sweepStartSec = Number(((Date.now() - contextCreatedAt) / 1000).toFixed(2));
    trimStartSec = Math.max(0, Number((sweepStartSec - PRE_SWEEP_HOLD_SEC).toFixed(2)));

    // ── 4. Text-selection sweep (the reference's signature move) ─────────
    let selectedChars = 0;
    let target = null;
    if (opts.selectText !== false) {
      target = await resolveSelectionTarget(page);
      if (target) {
        const x0 = target.box.x + 5;
        const y0 = target.box.y + 7;
        await page.mouse.move(x0, y0, { steps: 20 });
        await sleep(350);
        await page.mouse.down();
        // Drag diagonally down-right so the highlight sweeps line by line the
        // way a hand drag does, rather than snapping to a full block.
        const steps = 26;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          await page.mouse.move(
            x0 + (target.box.width - 10) * t,
            y0 + target.box.height * 0.92 * t,
            { steps: 2 }
          );
          await sleep(40);
        }
        await page.mouse.up();
        await sleep(450);
        selectedChars = await page.evaluate(() => (window.getSelection()?.toString() || '').length);
        // Release the highlight before scrolling so the clip does not open on a
        // wall of blue selection.
        await page.evaluate(() => window.getSelection()?.removeAllRanges());
        await sleep(200);
      }
    }

    // ── 5. Cinematic scroll walkthrough ──────────────────────────────────
    const filmedBeats = [];
    // TWO extents, not one, because the video contains two genuinely different
    // layouts. Measured on affaan-m/ECC:
    //     landing view (seconds 0-3)   x    0..1248   full width
    //     README walkthrough          x   33..903    870px of content
    // A single crop must serve both, and therefore serves neither well: no crop
    // leaves a 377px void beside the README, and cropping to 903px slices the nav
    // bar off the landing view and deletes the whole About sidebar.
    //
    // So the capture is filmed ONCE, unbroken, and composited in two segments —
    // each with its own overlay and its own crop. See buildTranscodeArgs().
    const landingExtent = await measureOnScreenExtent(page);
    // Video-timeline second at which the walkthrough begins. Measured AFTER the
    // sweep, because the sweep is the last thing that happens on the full-width
    // landing view — gating the switch here means segment A covers exactly the
    // sweep plus the walkthrough's first frame, and no scrolling.
    const walkStartSec = Number(((Date.now() - contextCreatedAt) / 1000).toFixed(2));
    let walkExtent = null;
    for (const beat of beats) {
      const targetY = Math.min(beat.y, maxY);
      if (targetY <= 120) continue;
      await wheelTo(page, targetY);
      filmedBeats.push(beat.label);
      // Sampled after the scroll settles, at the same point in the beat the
      // viewer will be looking at.
      walkExtent = mergeContentExtent(
        walkExtent,
        await measureOnScreenExtent(page),
        CSS_VIEWPORT.width
      );
      await sleep(BEAT_HOLD_MS);
      // A small cursor move between sections. Costs nothing and stops the frame
      // reading as an automated scroll.
      await page.mouse
        .move(
          CSS_VIEWPORT.width * (0.45 + Math.random() * 0.35),
          CSS_VIEWPORT.height * (0.4 + Math.random() * 0.3),
          { steps: 18 }
        )
        .catch(() => {});
      await sleep(400);
    }
    // Finish a little deeper than the last beat so the clip does not end on a
    // frame the viewer has already finished reading.
    if (maxY > 0) {
      await wheelTo(page, Math.min(maxY, (beats.at(-1)?.y || 0) + 1100));
      walkExtent = mergeContentExtent(
        walkExtent,
        await measureOnScreenExtent(page),
        CSS_VIEWPORT.width
      );
      await sleep(FINAL_HOLD_MS);
    }

    // Each segment is cropped independently. A segment whose content already
    // spans the viewport keeps the full width, so the two-segment path degrades
    // to today's behaviour on any repo that does not have the split.
    const cropFor = (extent) => contentCropBox(extent, {
      viewportWidth: CSS_VIEWPORT.width,
      viewportHeight: CSS_VIEWPORT.height,
    });
    const segments = [
      { name: 'landing', startSec: 0, endSec: walkStartSec, crop: cropFor(landingExtent) },
      { name: 'walk', startSec: walkStartSec, endSec: Infinity, crop: cropFor(walkExtent) },
    ];
    // If both segments resolve to the same crop there is nothing to switch, and
    // the caller should use the single-crop path rather than paying for two
    // overlay composites.
    const twoSegment = segments[0].crop.w !== segments[1].crop.w
      || segments[0].crop.x !== segments[1].crop.x;
    const cropBox = twoSegment
      ? segments[1].crop
      : contentCropBox(mergeContentExtent(landingExtent, walkExtent, CSS_VIEWPORT.width), {
          viewportWidth: CSS_VIEWPORT.width,
          viewportHeight: CSS_VIEWPORT.height,
        });

    const contentSec = Number(((Date.now() - gotoAt) / 1000 - loadMs / 1000).toFixed(2));

    // ── 5. Close to flush the file ───────────────────────────────────────
    // Playwright only guarantees the video is on disk after the context closes,
    // so the handle must be taken BEFORE close and read AFTER.
    const video = page.video();
    await context.close();
    context = null;

    const handle = await video.path();
    const webmPath = path.join(workDir, path.basename(handle));
    if (!fs.existsSync(webmPath)) {
      return { ok: false, reason: 'webm not written after context close' };
    }
    if (fs.statSync(webmPath).size < 50 * 1024) {
      return { ok: false, reason: 'webm is implausibly small — nothing was filmed' };
    }

    return {
      ok: true,
      webmPath,
      workDir,
      trimStartSec,
      loadMs,
      renderSettled: render.stable,
      renderSignature: render.signature,
      contentSec,
      beats: filmedBeats,
      cropBox,
      segments: twoSegment ? segments : null,
      selectedChars,
      selectionSource: target ? target.source : null,
      selectionSkipped: !target || selectedChars === 0,
    };
  } catch (err) {
    return { ok: false, reason: `recording failed: ${err.message}` };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

/** Remove a run's temp working directory. Safe to call twice. */
export function cleanupWorkDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* best effort */ }
}
