/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   FRAME RENDERER — macOS-STYLE WINDOW CHROME                    ║
 * ║   cron/lib/frameRenderer.js                                      ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Renders the RGBA overlay the page recording is composited     ║
 * ║   into: desktop backdrop, drop shadow, rounded window, titlebar  ║
 * ║   with traffic lights, and a transparent content hole.           ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * WHY THIS EXISTS
 *
 * A raw 1920x1080 browser capture fills only ~44% of the frame with content;
 * the rest is page background and the composition sits left. Two fixes were
 * tried and rejected:
 *
 *   - A narrow layout viewport filled 65% but required a 1.5x UPSCALE, which
 *     softens every glyph. The file also shrank, which is the symptom of that
 *     softening being mistaken for an improvement.
 *   - Injecting CSS to widen GitHub's container moved it 44% -> 46%. GitHub's
 *     Primer layout caps the root at `max-width: 1280px` and the sidebar split
 *     takes the rest; overriding it reliably is a fight against hashed
 *     CSS-module class names that change per deploy.
 *
 * What a real recording editor does instead (Recordly, and the OpenScreen
 * lineage it forked from) is compose AROUND the native capture. The page is
 * scaled DOWN into the window, so nothing is ever upscaled, and the space that
 * was dead margin becomes the desktop backdrop. The hole is inset by the corner
 * radius so the frame's rounded corners cover the page's square corners — the
 * same trick a real window manager uses.
 *
 * Rendered with the same headless Chromium the recorder already drives, so it
 * needs no new dependency and no per-pixel ffmpeg expression.
 */

import { frameGeometry } from './videoEncoder.js';

/**
 * Desktop backdrops. Chosen to read as a macOS desktop rather than as a colour
 * wash, and dark enough that GitHub's own dark theme sits inside the window
 * without a harsh luminance jump at the window edge.
 */
export const BACKDROPS = {
  deepSpace: {
    label: 'Deep space',
    css: 'radial-gradient(120% 90% at 22% 8%, #1e3a8a 0%, #0f172a 42%, #05070d 100%)',
    accent: '#3b82f6',
  },
  graphite: {
    label: 'Graphite',
    css: 'radial-gradient(110% 80% at 78% 4%, #334155 0%, #111827 45%, #06080f 100%)',
    accent: '#64748b',
  },
  aurora: {
    label: 'Aurora',
    css: 'radial-gradient(120% 100% at 15% 0%, #065f46 0%, #0f172a 50%, #05070d 100%)',
    accent: '#10b981',
  },
  ember: {
    label: 'Ember',
    css: 'radial-gradient(120% 90% at 80% 0%, #7c2d12 0%, #1c1917 45%, #05070d 100%)',
    accent: '#f97316',
  },
};

const BACKDROP_KEYS = Object.keys(BACKDROPS);

/** Pick a backdrop. Rotates by day so consecutive posts do not look identical. */
export function pickBackdrop(seedOffset = 0) {
  const day = Math.floor(Date.now() / 86400000) + (seedOffset || 0);
  return BACKDROPS[BACKDROP_KEYS[day % BACKDROP_KEYS.length]];
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Build the overlay HTML. Pure string generation — unit-testable without a
 * browser, and the single source of truth for the chrome's appearance.
 *
 * @param {object} [o]
 * @param {string} [o.title]    - window title, usually owner/repo
 * @param {object} [o.geometry] - from frameGeometry()
 * @param {object} [o.backdrop] - from BACKDROPS
 * @returns {string} full HTML document
 */
export function buildOverlayHtml({ title = '', geometry, backdrop } = {}) {
  const g = geometry || frameGeometry();
  const bd = backdrop || BACKDROPS.graphite;
  // The hole is punched with a transparent element; the page lands exactly in
  // its box. Inset by the radius so the frame covers the page's square corners.
  const holeStyle = `left:${g.holeX}px;top:${g.holeY}px;width:${g.holeW}px;height:${g.holeH}px;border-radius:${g.radius}px;`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${g.width}px;height:${g.height}px;overflow:hidden}
  body{
    background:${bd.css};
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  /* Soft vignette so the backdrop is not a flat wash. */
  body::after{
    content:"";position:absolute;inset:0;pointer-events:none;
    background:radial-gradient(130% 100% at 50% 0%,rgba(255,255,255,.07) 0%,rgba(0,0,0,0) 55%);
  }
  .window{
    position:absolute;left:${g.winX}px;top:${g.winY}px;width:${g.winW}px;height:${g.winH}px;
    border-radius:${g.radius}px;
    background:#0d1117;
    box-shadow:0 40px 90px -20px rgba(0,0,0,.75),0 18px 40px -18px rgba(0,0,0,.6),
               0 0 0 1px rgba(255,255,255,.09);
    overflow:hidden;
  }
  .titlebar{
    height:${g.titlebar}px;display:flex;align-items:center;gap:${Math.max(10, Math.round(g.radius * 0.7))}px;
    padding:0 ${Math.round(g.radius * 1.1)}px;background:linear-gradient(180deg,#161b22 0%,#11161d 100%);
    border-bottom:1px solid rgba(255,255,255,.06);
  }
  .dot{width:12px;height:12px;border-radius:50%;flex:0 0 auto;
       box-shadow:inset 0 0 0 .5px rgba(0,0,0,.35)}
  .dot.r{background:#ff5f56}.dot.y{background:#ffbd2e}.dot.g{background:#28c840}
  .title{
    margin-left:${Math.round(g.radius * 0.6)}px;font-size:13px;font-weight:600;color:#8b949e;
    letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  }
  .title .sep{color:#484f58;margin:0 7px}
  .title .owner{color:#6e7681}
  /* The punch-out the page video shows through. */
  .hole{position:absolute;${holeStyle}background:transparent}
</style></head>
<body>
  <div class="window">
    <div class="titlebar">
      <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
      ${title ? `<span class="title"><span class="owner">${escapeHtml(title)}</span></span>` : ''}
    </div>
    <div class="hole"></div>
  </div>
</body></html>`;
}

/**
 * Render the overlay to a PNG on disk.
 *
 * The page is rendered at exactly the output size with deviceScaleFactor 1 and
 * `omitBackground: true`, so everything the window does not cover stays
 * transparent and the composited page shows through the hole.
 *
 * @param {string} outPath
 * @param {object} [opts] - see buildOverlayHtml
 * @returns {Promise<{ok: boolean, path?: string, reason?: string}>}
 */
export async function renderFrameOverlay(outPath, opts = {}) {
  let browser;
  try {
    const { chromium } = await import('playwright');
    const geometry = opts.geometry || frameGeometry();
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage({
      viewport: { width: geometry.width, height: geometry.height },
      deviceScaleFactor: 1,
      omitBackground: true,
    });
    await page.setContent(buildOverlayHtml({ ...opts, geometry }), { waitUntil: 'load' });
    // Fonts and the backdrop gradients need one frame to settle.
    await page.waitForTimeout(220);
    await page.screenshot({ path: outPath, type: 'png', omitBackground: true });
    return { ok: true, path: outPath };
  } catch (err) {
    return { ok: false, reason: `frame overlay failed: ${err.message}` };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
