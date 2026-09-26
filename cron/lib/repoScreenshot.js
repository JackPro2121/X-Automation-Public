/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   REPO SCREENSHOT — v9 VIRAL MAC MOCKUP ENGINE                   ║
 * ║   cron/lib/repoScreenshot.js                                     ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Captures a GitHub repo page as a gorgeous 4:5 vertical macOS   ║
 * ║   presentation card on a vibrant radiant gradient canvas, then   ║
 * ║   uploads the high-res PNG to Supabase Storage.                  ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Built for X's Original Content Rewards:
 * 1. 100% Original Media — dynamically rendered with Playwright, never borrowed.
 * 2. 4:5 Vertical Aspect Ratio (1200x1500) — maximizes feed dwell time on mobile.
 * 3. macOS Window Frame — sleek titlebar with traffic light buttons (🔴 🟡 🟢)
 *    and clean README showcase.
 */

import { uploadVisual } from './visualFactory.js';

export const MOCKUP_VIEWPORT = { width: 1200, height: 1500 };
const NAV_TIMEOUT_MS = 25000;
const SETTLE_MS = 1500;

export const GRADIENT_THEMES = {
  sunset: 'linear-gradient(135deg, #fb923c 0%, #f43f5e 50%, #8b5cf6 100%)',
  emerald: 'linear-gradient(135deg, #34d399 0%, #059669 50%, #064e3b 100%)',
  cyber: 'linear-gradient(135deg, #38bdf8 0%, #6366f1 50%, #a855f7 100%)',
  peach: 'linear-gradient(135deg, #fbcfe8 0%, #f472b6 40%, #fb923c 100%)',
};

const THEME_KEYS = Object.keys(GRADIENT_THEMES);

export function getRandomGradient() {
  return THEME_KEYS[Math.floor(Math.random() * THEME_KEYS.length)];
}

let browserPromise = null;

/** Lazily launch one Chromium instance and reuse it within a run. */
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
export async function closeRepoScreenshotter() {
  if (!browserPromise) return;
  try {
    const b = await browserPromise;
    await b.close();
  } catch { /* already gone */ }
  browserPromise = null;
}

/**
 * Screenshot a GitHub repo as a high-converting macOS presentation mockup card.
 * @param {string} repoUrl - e.g. https://github.com/owner/repo
 * @param {object} [opts]
 * @param {string} [opts.filename] - storage filename
 * @param {string} [opts.gradient] - 'sunset' | 'emerald' | 'cyber' | 'peach'
 * @returns {Promise<{ok: boolean, url?: string, reason?: string}>}
 */
export async function captureRepoScreenshot(repoUrl, opts = {}) {
  if (!repoUrl || !repoUrl.startsWith('http')) {
    return { ok: false, reason: 'invalid repo URL' };
  }

  const gradientKey = opts.gradient || getRandomGradient();
  const bgGradient = GRADIENT_THEMES[gradientKey] || GRADIENT_THEMES.sunset;

  try {
    const browser = await getBrowser();
    const page = await browser.newPage({
      viewport: MOCKUP_VIEWPORT,
      deviceScaleFactor: 2, // retina-crisp text on X
    });

    try {
      await page.goto(repoUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await page.waitForSelector('article.markdown-body', { timeout: 8000 }).catch(() => {});

      // Inject the macOS presentation mockup wrapper directly over the page
      const injected = await page.evaluate((bg) => {
        const readme = document.querySelector('article.markdown-body');
        if (!readme) return false;

        // Extract detected license if present on page
        const licenseEl = document.querySelector('a[href*="LICENSE"], a[href*="license"]');
        const licenseText = licenseEl ? licenseEl.innerText.trim().slice(0, 20) : 'License';

        const overlay = document.createElement('div');
        overlay.id = 'spotlight-mockup-overlay';
        overlay.innerHTML = `
          <style>
            #spotlight-mockup-overlay {
              position: fixed;
              top: 0;
              left: 0;
              width: 100vw;
              height: 100vh;
              z-index: 9999999;
              background: ${bg};
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 48px 40px;
              box-sizing: border-box;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            }
            .mockup-window {
              width: 920px;
              max-height: 1180px;
              background: #ffffff;
              border-radius: 18px;
              box-shadow: 0 35px 70px -15px rgba(0, 0, 0, 0.4), 0 20px 40px -20px rgba(0, 0, 0, 0.3);
              overflow: hidden;
              display: flex;
              flex-direction: column;
              border: 1px solid rgba(255, 255, 255, 0.25);
            }
            .mockup-titlebar {
              background: #ffffff;
              padding: 16px 24px;
              display: flex;
              align-items: center;
              border-bottom: 1px solid #f1f5f9;
            }
            .window-dots {
              display: flex;
              gap: 8px;
              margin-right: 32px;
            }
            .dot {
              width: 12px;
              height: 12px;
              border-radius: 50%;
            }
            .dot-red { background: #ff5f56; }
            .dot-yellow { background: #ffbd2e; }
            .dot-green { background: #27c93f; }
            .tabs-container {
              display: flex;
              gap: 24px;
              align-items: center;
              font-size: 13px;
              font-weight: 600;
              color: #64748b;
            }
            .tab-item.active {
              color: #0f172a;
              position: relative;
              padding-bottom: 4px;
            }
            .tab-item.active::after {
              content: '';
              position: absolute;
              bottom: -16px;
              left: 0;
              right: 0;
              height: 2px;
              background: #f97316;
            }
            .mockup-body {
              padding: 36px 44px;
              overflow: hidden;
              background: #ffffff;
              color: #1e293b;
              font-size: 15px;
              line-height: 1.6;
            }
            .mockup-body img {
              max-width: 100%;
              height: auto;
              border-radius: 8px;
            }
            .mockup-body table {
              border-collapse: collapse;
              width: 100%;
              margin: 16px 0;
            }
            .mockup-body table th, .mockup-body table td {
              border: 1px solid #e2e8f0;
              padding: 8px 12px;
            }
            .mockup-body pre {
              background: #f8fafc;
              border-radius: 8px;
              padding: 16px;
              overflow: hidden;
            }
          </style>
          <div class="mockup-window">
            <div class="mockup-titlebar">
              <div class="window-dots">
                <span class="dot dot-red"></span>
                <span class="dot dot-yellow"></span>
                <span class="dot dot-green"></span>
              </div>
              <div class="tabs-container">
                <span class="tab-item active">README</span>
                <span class="tab-item">Contributing</span>
                <span class="tab-item">${licenseText}</span>
              </div>
            </div>
            <div class="mockup-body"></div>
          </div>
        `;

        document.body.appendChild(overlay);
        const bodyTarget = overlay.querySelector('.mockup-body');

        // Clone the README markdown body and clean any anchor clutter
        const clone = readme.cloneNode(true);
        const ghAnchors = clone.querySelectorAll('.anchor');
        ghAnchors.forEach((a) => a.remove());

        bodyTarget.appendChild(clone);
        return true;
      }, bgGradient);

      let buffer;
      if (injected) {
        await page.waitForTimeout(SETTLE_MS);
        const overlayEl = await page.$('#spotlight-mockup-overlay');
        buffer = await (overlayEl || page).screenshot({ type: 'png' });
      } else {
        // Fallback: take clean page screenshot if no readme container found
        await page.addStyleTag({
          content: '[data-testid="notice-banner"], .js-notice, [aria-label="Cookie banner"], #js-cookie-banner, .SignupPrompt-module__container { display:none !important; }',
        }).catch(() => {});
        buffer = await page.screenshot({ type: 'png' });
      }

      const uploaded = await uploadVisual(buffer, opts.filename || `v9-repo-${Date.now()}.png`);
      if (!uploaded.ok) return { ok: false, reason: uploaded.reason };
      return { ok: true, url: uploaded.url };
    } finally {
      await page.close();
    }
  } catch (err) {
    return { ok: false, reason: `screenshot failed: ${err.message}` };
  }
}
