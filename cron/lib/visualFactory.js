/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   ORIGINAL VISUAL FACTORY                                        ║
 * ║   cron/lib/visualFactory.js                                      ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Renders original post visuals (PNG) from HTML templates using  ║
 * ║   headless Chromium, then hosts them on Supabase Storage.        ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * X's Original Content Rewards (Sept 2026) penalise "minimally modified" and
 * "aggregated" content. The pipelines were scraping a Reddit/X post, rewriting
 * the caption, and attaching THE ORIGINAL AUTHOR'S IMAGE. Whatever the caption
 * said, the asset doing the work in the feed was somebody else's — that is
 * aggregation by definition, and it is why the account is ineligible.
 *
 * This module produces the missing piece: an asset the account actually owns.
 * A chart, a stat card, a comparison — rendered from data the pipeline computed,
 * in a consistent on-brand style. Nothing is borrowed.
 *
 * ── WHY CHROMIUM AND NOT AN IMAGE MODEL ──────────────────────────────────────
 * Playwright + Chromium is already a dependency (v7 uses it), and it renders
 * TEXT AND DATA EXACTLY. An image-generation model would hallucinate the numbers
 * and garble the text — useless for a technical account where the digits are the
 * point. Rendering real HTML also means the visual can be diffed, reviewed and
 * regenerated deterministically.
 *
 * ── HOW IT REACHES X ─────────────────────────────────────────────────────────
 * Buffer's GraphQL API only accepts a PUBLIC URL (`assets: [{ image: { url } }]`),
 * not an upload. So the render is uploaded to the project's existing public
 * `media-cache` Supabase Storage bucket, and that URL is handed to Buffer.
 *
 * Usage:
 *   import { renderVisual, renderAndUpload, closeVisualFactory } from './visualFactory.js';
 *
 *   const v = await renderAndUpload({
 *     kind: 'statCard',
 *     eyebrow: 'AI CODE REVIEW',
 *     stat: '47%',
 *     statLabel: 'of AI-generated pull requests are merged without a human reading them',
 *     context: 'Measured across 1,200 repos in the Sept 2026 survey.',
 *   });
 *   // v.url -> https://<project>.supabase.co/storage/v1/object/public/media-cache/...
 *
 * CLI demo (renders every template to scratch/visuals/):
 *   node cron/lib/visualFactory.js
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { isPlaceholderText } from './utils.js';

// Consistent with the other lib modules: load .env.local so the module works
// both when imported by a pipeline and when run directly as a CLI.
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

// ─── Canvas ──────────────────────────────────────────────────────────────────
// 1200x675 is 16:9 — fills the X in-feed image slot without letterboxing.
export const CANVAS = { width: 1200, height: 675 };

// ─── Brand palette ───────────────────────────────────────────────────────────
// Dark card on a dark feed reads as "technical" and keeps white body text at
// maximum contrast. Accent is a single hue so a grid of these looks like a set.
const PALETTE = {
  bg: '#0B0F14',
  bgSoft: '#121821',
  border: '#1F2937',
  text: '#F3F4F6',
  textMuted: '#9CA3AF',
  textDim: '#6B7280',
  accent: '#38BDF8',      // sky-400
  accentSoft: '#0EA5E9',
  warn: '#FB7185',        // rose-400 — used for the "old way" panel
  ok: '#34D399',          // emerald-400 — used for the "new way" panel
};

const HANDLE = '@M_jawad_yasin';

/**
 * System font stacks only — no webfont download. CI must not depend on network
 * access for fonts, and a missing font silently changes the layout.
 */
const FONT_SANS = `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "DejaVu Sans", sans-serif`;
const FONT_MONO = `ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Escape text for safe HTML interpolation. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Remove emoji from card copy.
 *
 * Source titles are full of them, and headless Chromium on a CI runner has no
 * colour-emoji font — so an emoji renders as an empty box (tofu) on the live
 * post. Stripping is better than shipping a broken glyph. Variation selectors
 * and zero-width joiners must go too, or they leave stray spacing behind.
 */
function stripEmoji(s) {
  return String(s ?? '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\uFE0F\uFE0E\u200D]/g, '');
}

/**
 * Scale a font size down as text gets longer, so long headlines shrink instead
 * of overflowing the fixed canvas. Returns a CSS clamp() expression.
 */
function fitSize(text, { base, min, at = 40, over = 90 }) {
  const len = String(text || '').length;
  if (len <= at) return `${base}px`;
  if (len >= over) return `${min}px`;
  const t = (len - at) / (over - at);
  return `${Math.round(base - (base - min) * t)}px`;
}

// ─── Shared shell ────────────────────────────────────────────────────────────

function shell(inner) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body {
    width:${CANVAS.width}px; height:${CANVAS.height}px;
    background:${PALETTE.bg};
    font-family:${FONT_SANS};
    color:${PALETTE.text};
    -webkit-font-smoothing:antialiased;
  }
  .card {
    position:relative; width:100%; height:100%;
    padding:56px 64px 48px 64px;
    display:flex; flex-direction:column;
    background:
      radial-gradient(900px 420px at 88% -12%, rgba(56,189,248,0.10), transparent 62%),
      radial-gradient(700px 380px at 4% 108%, rgba(14,165,233,0.07), transparent 60%),
      ${PALETTE.bg};
  }
  /* Left accent rail — makes a set of cards read as one brand. */
  .rail {
    position:absolute; left:0; top:0; bottom:0; width:8px;
    background:linear-gradient(180deg, ${PALETTE.accent}, ${PALETTE.accentSoft});
  }
  .eyebrow {
    font-size:19px; font-weight:700; letter-spacing:0.16em;
    text-transform:uppercase; color:${PALETTE.accent};
    margin-bottom:26px;
  }
  .footer {
    margin-top:auto; padding-top:26px;
    display:flex; align-items:center; justify-content:space-between;
    border-top:1px solid ${PALETTE.border};
    font-size:20px; color:${PALETTE.textDim};
  }
  .handle { font-weight:700; color:${PALETTE.textMuted}; letter-spacing:0.02em; }
  .source { font-family:${FONT_MONO}; font-size:17px; color:${PALETTE.textDim}; }
</style></head>
<body><div class="card"><div class="rail"></div>${inner}</div></body></html>`;
}

function footer(sourceLabel) {
  return `<div class="footer">
    <span class="handle">${esc(HANDLE)}</span>
    ${sourceLabel ? `<span class="source">${esc(sourceLabel)}</span>` : ''}
  </div>`;
}

// ─── Templates ───────────────────────────────────────────────────────────────

/** A single number, made unmissable. Use when the source has one hard fact. */
function statCard({ eyebrow, stat, statLabel, context, sourceLabel }) {
  const statSize = fitSize(stat, { base: 168, min: 96, at: 4, over: 10 });
  return shell(`
    ${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ''}
    <div style="font-size:${statSize}; font-weight:800; line-height:0.92; letter-spacing:-0.035em;
                color:${PALETTE.accent}; margin-bottom:20px;">${esc(stat)}</div>
    <div style="font-size:${fitSize(statLabel, { base: 40, min: 26, at: 50, over: 130 })};
                font-weight:650; line-height:1.24; max-width:1000px; letter-spacing:-0.012em;">
      ${esc(statLabel)}
    </div>
    ${context ? `<div style="margin-top:22px; font-size:23px; line-height:1.45;
        color:${PALETTE.textMuted}; max-width:940px;">${esc(context)}</div>` : ''}
    ${footer(sourceLabel)}
  `);
}

/** A headline plus 3 supporting points. The workhorse for analysis posts. */
function insightCard({ eyebrow, headline, points = [], sourceLabel }) {
  const shown = points.filter(Boolean).slice(0, 3);
  return shell(`
    ${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ''}
    <div style="font-size:${fitSize(headline, { base: 52, min: 32, at: 52, over: 150 })};
                font-weight:750; line-height:1.16; letter-spacing:-0.022em; max-width:1020px;
                margin-bottom:${shown.length ? '30px' : '0'};">
      ${esc(headline)}
    </div>
    ${shown.length ? `<div style="display:flex; flex-direction:column; gap:16px; max-width:1010px;">
      ${shown.map((p, i) => `
        <div style="display:flex; gap:16px; align-items:flex-start;">
          <div style="flex:0 0 auto; width:34px; height:34px; border-radius:9px;
                      background:rgba(56,189,248,0.13); border:1px solid rgba(56,189,248,0.30);
                      display:flex; align-items:center; justify-content:center;
                      font-family:${FONT_MONO}; font-size:17px; font-weight:700; color:${PALETTE.accent};
                      margin-top:2px;">${i + 1}</div>
          <div style="font-size:${fitSize(p, { base: 26, min: 20, at: 70, over: 140 })};
                      line-height:1.38; color:${PALETTE.text}; flex:1;">${esc(p)}</div>
        </div>`).join('')}
    </div>` : ''}
    ${footer(sourceLabel)}
  `);
}

/** Two opposing columns. Use for "old way vs AI way" and before/after framing. */
function comparisonCard({ eyebrow, headline, left = {}, right = {}, sourceLabel }) {
  const panel = (side, tone, label) => `
    <div style="flex:1; background:${PALETTE.bgSoft}; border:1px solid ${PALETTE.border};
                border-top:3px solid ${tone}; border-radius:14px; padding:26px 28px;">
      <div style="font-size:19px; font-weight:750; letter-spacing:0.10em; text-transform:uppercase;
                  color:${tone}; margin-bottom:18px;">${esc(side.title)}</div>
      <div style="display:flex; flex-direction:column; gap:13px;">
        ${(side.items || []).filter(Boolean).slice(0, 4).map((it) => `
          <div style="display:flex; gap:12px; align-items:flex-start;">
            <div style="flex:0 0 auto; color:${tone}; font-size:21px; line-height:1.35;">&mdash;</div>
            <div style="font-size:22px; line-height:1.36; color:${PALETTE.text}; flex:1;">${esc(it)}</div>
          </div>`).join('')}
      </div>
    </div>`;
  return shell(`
    ${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ''}
    ${headline ? `<div style="font-size:${fitSize(headline, { base: 46, min: 30, at: 50, over: 130 })};
        font-weight:750; line-height:1.16; letter-spacing:-0.02em; max-width:1020px; margin-bottom:28px;">
      ${esc(headline)}</div>` : ''}
    <div style="display:flex; gap:22px; align-items:flex-start; flex:1; min-height:0;">
      ${panel(left, PALETTE.warn)}
      ${panel(right, PALETTE.ok)}
    </div>
    ${footer(sourceLabel)}
  `);
}

/** One striking line. Use for a sharp take worth screenshotting. */
function quoteCard({ eyebrow, quote, attribution, sourceLabel }) {
  return shell(`
    ${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ''}
    <div style="flex:1; display:flex; flex-direction:column; justify-content:center; max-width:1010px;">
      <div style="font-size:86px; line-height:0.7; color:${PALETTE.accent}; opacity:0.42;
                  font-weight:800; margin-bottom:12px;">&ldquo;</div>
      <div style="font-size:${fitSize(quote, { base: 46, min: 28, at: 70, over: 200 })};
                  font-weight:650; line-height:1.28; letter-spacing:-0.018em;">
        ${esc(quote)}
      </div>
      ${attribution ? `<div style="margin-top:26px; font-size:22px; color:${PALETTE.textMuted};
          font-family:${FONT_MONO};">&mdash; ${esc(attribution)}</div>` : ''}
    </div>
    ${footer(sourceLabel)}
  `);
}

export const TEMPLATES = { statCard, insightCard, comparisonCard, quoteCard };

// ─── Renderer ────────────────────────────────────────────────────────────────

let browserPromise = null;

/**
 * Lazily launch one Chromium instance and reuse it. Launching per render costs
 * ~700ms; a pipeline renders several visuals per run.
 */
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
export async function closeVisualFactory() {
  if (!browserPromise) return;
  try {
    const b = await browserPromise;
    await b.close();
  } catch { /* already gone */ }
  browserPromise = null;
}

/**
 * Render a visual to a PNG buffer.
 *
 * @param {object} spec - must include `kind` (one of TEMPLATES' keys)
 * @param {object} [opts]
 * @param {number} [opts.deviceScaleFactor=2] - 2x for retina-crisp text on X
 * @returns {Promise<{ok: boolean, buffer?: Buffer, kind?: string, reason?: string}>}
 */
export async function renderVisual(spec, opts = {}) {
  const { kind } = spec || {};
  const template = TEMPLATES[kind];
  if (!template) {
    return { ok: false, reason: `unknown template "${kind}" (expected: ${Object.keys(TEMPLATES).join(', ')})` };
  }

  let html;
  try {
    html = template(spec);
  } catch (err) {
    return { ok: false, reason: `template render failed: ${err.message}` };
  }

  try {
    const browser = await getBrowser();
    const page = await browser.newPage({
      viewport: { width: CANVAS.width, height: CANVAS.height },
      deviceScaleFactor: opts.deviceScaleFactor ?? 2,
    });
    try {
      // 'load' is enough — there are no external resources by design.
      await page.setContent(html, { waitUntil: 'load' });

      // Overflow guard. The canvas is a fixed 1200x675, so a long headline or too
      // many points will silently run past the bottom edge and get CLIPPED in the
      // screenshot — the text would just be missing from the live post. Detect it
      // here rather than discovering it on the timeline.
      const box = await page.evaluate(() => {
        const card = document.querySelector('.card');
        return { scrollH: card.scrollHeight, clientH: card.clientHeight };
      });
      const overflowed = box.scrollH > box.clientH + 2;
      if (overflowed) {
        console.warn(
          `  ⚠ visual "${kind}" content overflows the canvas ` +
          `(${box.scrollH}px > ${box.clientH}px) — text will be clipped. ` +
          `Shorten the copy or split across two visuals.`
        );
      }

      const buffer = await page.screenshot({ type: 'png' });
      return { ok: true, buffer, kind, overflowed };
    } finally {
      await page.close();
    }
  } catch (err) {
    return { ok: false, reason: `chromium render failed: ${err.message}` };
  }
}

/** Write a rendered visual to disk (used by the CLI demo and for debugging). */
export function saveVisual(buffer, filename, dir = path.join('scratch', 'visuals')) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, filename);
  fs.writeFileSync(p, buffer);
  return p;
}

// ─── Spec builder — turn a scraped post + generated text into a visual ───────

/**
 * Find the single most "quotable" number in a piece of text.
 * Prefers percentages and money, then magnitudes with a unit.
 * @returns {?string}
 */
function extractHeadlineStat(text) {
  const t = String(text || '');
  const patterns = [
    /\$\s?\d[\d,.]*\s?(?:[KMB]\b|billion|million|thousand)?/i,  // $1.2B, $40,000
    /\b\d[\d,.]*\s?%/,                                          // 47%
    /\b\d[\d,.]*\s?(?:x|×)\b/i,                                 // 3x
    /\b\d[\d,.]*\s?(?:GB|TB|MB|ms|fps|tok\/s)\b/i,              // 128GB, 40ms
    /\b\d{1,3}(?:,\d{3})+\b/,                                   // 10,000
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

/** Split prose into sentence-ish chunks, dropping fragments. */
function sentences(text, max = 3) {
  return stripEmoji(String(text || ''))
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 25 && s.length <= 190)
    .slice(0, max);
}

/**
 * Build a visual spec from pipeline data.
 *
 * This implements Path 1 from STRATEGY_original_content.md: the ASSET becomes
 * ours even though the underlying fact came from a source. It is a real
 * improvement (no borrowed image) but it is not the whole fix — Path 2, changing
 * what the model is asked to produce, is what makes the TEXT original too.
 *
 * Strategy:
 *   - A headline number exists  -> statCard  (isolate the number, the post explains it)
 *   - Otherwise                 -> insightCard (source claim as headline, our points beneath)
 *
 * @param {object} input
 * @param {string} input.sourceTitle  - the scraped post's title
 * @param {string} [input.sourceText] - the scraped post's body, if any
 * @param {string} [input.generatedText] - our generated post text
 * @param {string} [input.eyebrow]    - category label, e.g. "AI NEWS"
 * @param {string} [input.sourceLabel] - small footer attribution
 * @returns {?object} a spec accepted by renderVisual(), or null if nothing usable
 */
export function buildVisualSpec({ sourceTitle, sourceText = '', generatedText = '', eyebrow, sourceLabel }) {
  // Titles come from Reddit/X with markdown, emoji and trailing fluff attached.
  const title = stripEmoji(String(sourceTitle || ''))
    .replace(/[*_`~]/g, '')
    .replace(/\s*\[[^\]]*\]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (title.length < 20) return null; // too thin to carry a card

  // ── Refuse to render prompt/template debris ────────────────────────────────
  // Measured over 200 real rows: a small share of stored text is not post copy at
  // all — it is unfilled template text or an echoed generation instruction (e.g.
  // "No hashtags, emojis, or markdown."). Upstream filters catch most of these,
  // but the visual factory is now called on five paths and must not depend on
  // every caller having cleaned its input first: rendering debris bakes it into a
  // 1200x675 PNG that goes to the feed, where it is far more visible than a bad
  // caption and cannot be edited after the fact.
  //
  // Rejecting here means the caller falls back per its own policy, which is
  // strictly safer than publishing a card whose headline is an instruction.
  if (looksLikeTemplateDebris(title)) {
    console.warn('  ⚠ Original visual: refused to render template/prompt debris');
    return null;
  }

  // ── Supporting points, minus anything that just repeats the headline ───────
  // REAL DEFECT, found by rendering 12 production posts and looking at them:
  // the pipelines pass the post text as BOTH sourceTitle and generatedText, so
  // the headline and point 1 were the same sentence verbatim — the card appeared
  // to stutter. The headline is the card's only job; repeating it directly
  // beneath itself makes the account look broken, and it wastes the single
  // supporting slot that was supposed to add context.
  //
  // Fixed here rather than at the five call sites: the duplication is a property
  // of the CARD, so the card builder is the right place to guarantee it, and a
  // caller cannot forget to pass the right flag.
  const points = sentences(generatedText, 3).filter((p) => !isRestatementOf(p, title));

  // 1. A hard number in the source beats prose every time.
  const stat = extractHeadlineStat(title) || extractHeadlineStat(sourceText.slice(0, 300));
  if (stat) {
    const statLabel = title.length > 150 ? truncateWords(title, 147) : title;
    return {
      kind: 'statCard',
      eyebrow: eyebrow || undefined,
      stat,
      statLabel,
      // Only worth showing if it is not a restatement of the label.
      context: (points[0] && !isRestatementOf(points[0], statLabel)) ? points[0] : undefined,
      sourceLabel: sourceLabel || undefined,
    };
  }

  // 2. No number — lead with the source's claim and put our analysis underneath.
  const headline = title.length > 130 ? truncateWords(title, 127) : title;
  return {
    kind: 'insightCard',
    eyebrow: eyebrow || undefined,
    headline,
    points,
    sourceLabel: sourceLabel || undefined,
  };
}

// ─── The single decision point every pipeline calls ───────────────────────────

/**
 * Feature flag. Read once at module load, consistent with the other lib modules.
 * Set `ORIGINAL_VISUALS=true` in the workflow env to switch a pipeline over.
 */
export const ORIGINAL_VISUALS = process.env.ORIGINAL_VISUALS === 'true';

/**
 * Decide which image URL to publish, preferring one WE rendered over the source
 * author's.
 *
 * ── WHY THIS IS A SHARED HELPER AND NOT AN INLINE BLOCK ──────────────────────
 * Five call sites across v3, v4 and v6 need the same decision. v3 had it inline;
 * the other four did not have it at all. Copying it four more times would
 * reproduce exactly the failure mode that caused this whole audit — the same
 * policy implemented independently in several places, which then drifts (see the
 * X_SAFE_MAX_CHARS 1200-vs-24000 incident, and the three separate validators that
 * were supposed to share one floor). One function, one policy.
 *
 * ── THE FALLBACK POLICY ──────────────────────────────────────────────────────
 * When rendering fails, the caller decides what happens next via `fallback`:
 *
 *   'source'  — publish the original author's image. Keeps the post alive and
 *               visually intact, but re-opens Axis A (borrowed media) for that
 *               one post. This is the safe, non-destructive default.
 *
 *   'none'    — publish with NO image. Preserves originality even when the
 *               render fails, at the cost of a text-only post. Defensible: a
 *               text-only post is still eligible, a borrowed-media post is not.
 *
 * The distinction only matters on failure. Both are correct for different risk
 * appetites, so it is a parameter rather than a hard-coded choice.
 *
 * @param {object} input
 * @param {string} input.sourceTitle   - scraped post's title (drives the card)
 * @param {string} [input.sourceText]  - scraped post's body, if any
 * @param {string} [input.generatedText] - our generated post text
 * @param {?string} [input.sourceImageUrl] - the source author's image, if any
 * @param {string} [input.eyebrow]     - category label, e.g. "AI NEWS"
 * @param {string} [input.sourceLabel] - small footer attribution
 * @param {string} [input.filenamePrefix] - e.g. 'v4' — makes uploads traceable
 * @param {'source'|'none'} [input.fallback] - behaviour when rendering fails
 * @param {boolean} [input.enabled]    - override the flag (tests pass explicit)
 * @returns {Promise<{url: ?string, original: boolean, kind?: string, reason?: string}>}
 *   `url` is what to hand Buffer (may be null = publish text-only).
 *   `original` is true only when the returned url is one we rendered.
 */
export async function resolvePublishImage({
  sourceTitle,
  sourceText = '',
  generatedText = '',
  sourceImageUrl = null,
  eyebrow,
  sourceLabel,
  filenamePrefix = 'post',
  fallback = 'source',
  enabled,
} = {}) {
  const active = enabled === undefined ? ORIGINAL_VISUALS : enabled;

  // Not enabled: behave exactly as the pipeline did before.
  if (!active) return { url: sourceImageUrl, original: false, reason: 'disabled' };

  const spec = buildVisualSpec({ sourceTitle, sourceText, generatedText, eyebrow, sourceLabel });
  if (!spec) {
    console.warn('  ⚠ Original visual: source too thin to build a card');
    return fallback === 'none'
      ? { url: null, original: false, reason: 'no-spec-text-only' }
      : { url: sourceImageUrl, original: false, reason: 'no-spec' };
  }

  const visual = await renderAndUpload(spec, { filename: `${filenamePrefix}-${Date.now()}.png` });
  if (visual.ok) {
    console.log(`  🎨 Original visual (${spec.kind}, ${Math.round(visual.bytes / 1024)}KB) — source image dropped`);
    return { url: visual.url, original: true, kind: spec.kind };
  }

  console.warn(`  ⚠ Original visual failed (${visual.reason}) — fallback: ${fallback}`);
  return fallback === 'none'
    ? { url: null, original: false, reason: visual.reason, kind: spec.kind }
    : { url: sourceImageUrl, original: false, reason: visual.reason, kind: spec.kind };
}

// ─── Template / prompt debris ────────────────────────────────────────────────

/**
 * Is this string actually post copy, or is it template/prompt debris that must
 * never be baked into a published image?
 *
 * Delegates to the shared `isPlaceholderText()` in utils.js rather than carrying
 * its own pattern list. Two independent placeholder detectors is precisely the
 * failure mode this codebase already suffered (three validators meant to share
 * one floor, and `X_SAFE_MAX_CHARS` living at 1200 in one file and 24000 in
 * another) — one definition, one policy.
 *
 * Added on top: the echoed-instruction shapes. These are not `[placeholder]`
 * text, they are the model repeating a rule it was given ("No hashtags, no
 * markdown, no emojis"). `cleanTweetText()` rejects them upstream, but the
 * visual factory is called from five paths and cannot assume every caller
 * cleaned its input — a card is permanent and far more visible than a caption.
 *
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeTemplateDebris(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (isPlaceholderText(t)) return true;

  // Bare instruction echoes — checked as a prefix, the way cleanTweetText does,
  // so a legitimate post that merely mentions markdown is not rejected.
  const lower = t.toLowerCase();
  const ECHOES = [
    'no hashtags', 'no emojis', 'no emoji', 'no markdown', 'no thread',
    'no prefixes', 'hashtags:', 'emoji rule', 'tweet rules:', 'output:',
    'here is the tweet', "here's the tweet", 'final answer',
  ];
  return ECHOES.some((p) => lower.startsWith(p));
}

/**
 * Is `point` just the headline again?
 *
 * Handles the truncation the card applies: a long title is cut to 127 chars plus
 * an ellipsis, but the sentence it was cut from is still the full string — so a
 * naive `===` misses the very case that occurs most often in production (long
 * first sentences).
 *
 * Comparison is done on a normalised prefix: lowercase, punctuation collapsed,
 * then "does one start with the other's first N characters". N is deliberately
 * generous but not so short that unrelated sentences collide — 40 characters of
 * shared opening is not coincidence in prose.
 *
 * @param {string} point
 * @param {string} headline
 * @returns {boolean}
 */
function isRestatementOf(point, headline) {
  const norm = (s) => String(s || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d"']/g, '') // quote styles vary between sources
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const a = norm(point);
  const b = norm(headline).replace(/\.\.\.$/, '').trim();
  if (!a || !b) return false;
  if (a === b) return true;

  // Truncated headline: its normalised form is a prefix of the full sentence.
  if (a.startsWith(b) || b.startsWith(a)) return true;

  // Same opening either way (guards against the ellipsis stripping above).
  const N = 40;
  return a.length >= N && b.length >= N && a.slice(0, N) === b.slice(0, N);
}

/**
 * Truncate to a character budget WITHOUT cutting a word in half.
 *
 * Found by rendering real posts: a raw `title.slice(0, 127)` produced headlines
 * ending "...faster t..." — mid-word, which reads as a broken render and is very
 * visible when it is the largest text on a 1200x675 card. Cuts on the last whole
 * word that fits, then strips any trailing punctuation so the ellipsis does not
 * sit after a comma or colon.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncateWords(text, max) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  // Only back off to a word boundary if that leaves a usable amount of text.
  const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.replace(/[\s,;:.!?-]+$/, '')}...`;
}

// ─── Supabase Storage upload ─────────────────────────────────────────────────

const MEDIA_BUCKET = process.env.MEDIA_BUCKET || 'media-cache';

/**
 * Upload a PNG buffer to the public media bucket and return its public URL.
 * Buffer's API requires a public URL — it cannot take a file upload.
 *
 * @param {Buffer} buffer
 * @param {string} [filename]
 * @returns {Promise<{ok: boolean, url?: string, path?: string, reason?: string}>}
 */
export async function uploadVisual(buffer, filename) {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return { ok: false, reason: 'VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' };
  }

  const name = filename || `visual-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`;
  const objectPath = `visuals/${name}`;

  try {
    const res = await fetch(`${url}/storage/v1/object/${MEDIA_BUCKET}/${objectPath}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=31536000',
        'x-upsert': 'true',
      },
      body: buffer,
      signal: AbortSignal.timeout(45000),
    });

    if (!res.ok) {
      const body = await res.text();
      return { ok: false, reason: `storage upload HTTP ${res.status}: ${body.slice(0, 200)}` };
    }

    const publicUrl = `${url}/storage/v1/object/public/${MEDIA_BUCKET}/${objectPath}`;
    return { ok: true, url: publicUrl, path: objectPath };
  } catch (err) {
    return { ok: false, reason: `storage upload failed: ${err.message}` };
  }
}

/**
 * Render a visual and host it. This is the function pipelines should call —
 * it returns a URL ready to hand to Buffer's `assets` field.
 *
 * @param {object} spec - see renderVisual
 * @param {object} [opts]
 * @returns {Promise<{ok: boolean, url?: string, kind?: string, bytes?: number, reason?: string}>}
 */
export async function renderAndUpload(spec, opts = {}) {
  const rendered = await renderVisual(spec, opts);
  if (!rendered.ok) return rendered;

  const uploaded = await uploadVisual(rendered.buffer, opts.filename);
  if (!uploaded.ok) {
    // Keep the render on disk so a failed upload can be inspected/reused.
    const p = saveVisual(rendered.buffer, `failed-upload-${Date.now()}.png`);
    console.warn(`  ⚠ Visual rendered but upload failed (${uploaded.reason}); saved to ${p}`);
    return { ok: false, reason: uploaded.reason, kind: rendered.kind };
  }

  return {
    ok: true,
    url: uploaded.url,
    path: uploaded.path,
    kind: rendered.kind,
    bytes: rendered.buffer.length,
  };
}

// ─── CLI demo ────────────────────────────────────────────────────────────────
// `node cron/lib/visualFactory.js` renders every template to scratch/visuals/
// so the output can be eyeballed before wiring it into a pipeline.
// `--upload` additionally exercises the Supabase Storage path.

/** True only when this file is the entrypoint, not when it is imported. */
function isDirectRun() {
  if (!process.argv[1]) return false; // e.g. `node -e "import(...)"`
  try {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const samples = [
    {
      kind: 'statCard', name: 'statCard',
      eyebrow: 'AI Code Review',
      stat: '47%',
      statLabel: 'of AI-generated pull requests are merged without a human reading them',
      context: 'Measured across 1,200 repositories. The review step is where teams think their safety net is.',
      sourceLabel: 'n=1,200 repos',
    },
    {
      kind: 'insightCard', name: 'insightCard',
      eyebrow: 'Agent Architecture',
      headline: 'Your agent does not need a bigger model. It needs a smaller loop.',
      points: [
        'Most failures come from the loop, not the model — retries without state, tools without schemas.',
        'A 20B model with a tight loop beats a 400B model with a vague one on real tasks.',
        'Log every tool call. The bug is almost always in the third one.',
      ],
      sourceLabel: 'agent-patterns.md',
    },
    {
      kind: 'comparisonCard', name: 'comparisonCard',
      eyebrow: '2026 Reality Check',
      headline: 'What actually changed in the last 18 months',
      left: { title: 'Then', items: ['Write the code', 'Read the diff', 'Own the bug'] },
      right: { title: 'Now', items: ['Describe the intent', 'Read the diff anyway', 'Still own the bug'] },
      sourceLabel: 'engineer survey',
    },
    {
      kind: 'quoteCard', name: 'quoteCard',
      eyebrow: 'Debate',
      quote: 'The compiler never asked for your trust. The model does, and that is the whole problem.',
      attribution: 'internal design review, 2026',
      sourceLabel: null,
    },
  ];

  console.log('Rendering sample visuals...\n');
  let failures = 0;
  for (const s of samples) {
    const { name, ...spec } = s;
    const r = await renderVisual(spec);
    if (!r.ok) {
      failures++;
      console.log(`  ✗ ${name.padEnd(16)} ${r.reason}`);
      continue;
    }
    const p = saveVisual(r.buffer, `${name}.png`);
    console.log(`  ✓ ${name.padEnd(16)} ${String(r.buffer.length).padStart(7)} bytes  ->  ${p}`);
  }

  // Optional live upload check — opt-in via `--upload` so repeated local runs
  // don't litter the media bucket with demo files.
  if (process.argv.includes('--upload')) {
    if (!process.env.VITE_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.log('\n  ✗ --upload requested but Supabase credentials are not in env');
      failures++;
    } else {
      console.log('\nUploading one sample to Supabase Storage...');
      const { name, ...spec } = samples[0];
      const up = await renderAndUpload(spec, { filename: `demo-statCard-${Date.now()}.png` });
      console.log(up.ok ? `  ✓ public URL: ${up.url}` : `  ✗ ${up.reason}`);
      if (!up.ok) failures++;
    }
  } else {
    console.log('\n(skipping upload — pass --upload to test the Supabase Storage path)');
  }

  await closeVisualFactory();
  console.log(failures ? `\n${failures} failure(s).` : '\nAll templates rendered.');
  process.exit(failures ? 1 : 0);
}
