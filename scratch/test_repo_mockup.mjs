import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

export async function testRender(repoUrl, outputPath, gradient = 'sunset') {
  console.log(`Testing render for: ${repoUrl}`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1200, height: 1500 },
    deviceScaleFactor: 2,
  });

  const GRADIENTS = {
    sunset: 'linear-gradient(135deg, #fb923c 0%, #f43f5e 50%, #8b5cf6 100%)',
    emerald: 'linear-gradient(135deg, #34d399 0%, #059669 50%, #064e3b 100%)',
    cyber: 'linear-gradient(135deg, #38bdf8 0%, #6366f1 50%, #a855f7 100%)',
    peach: 'linear-gradient(135deg, #fbcfe8 0%, #f472b6 40%, #fb923c 100%)',
  };

  const bgGradient = GRADIENTS[gradient] || GRADIENTS.sunset;

  try {
    await page.goto(repoUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('article.markdown-body', { timeout: 10000 }).catch(() => {});
    
    // Check if readme exists
    const readmeExists = await page.$('article.markdown-body');
    console.log('Readme exists:', !!readmeExists);

    // Let's inject styling to turn the page into a gorgeous mockup presentation
    const screenshotBuffer = await page.evaluate(async (bg) => {
      const readme = document.querySelector('article.markdown-body');
      if (!readme) return null;

      // Extract license or tabs if available
      const licenseEl = document.querySelector('a[href*="LICENSE"], a[href*="license"]');
      const licenseText = licenseEl ? licenseEl.innerText.trim() : 'License';

      // Create mockup wrapper
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
            z-index: 999999;
            background: ${bg};
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 48px;
            box-sizing: border-box;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          }
          .mockup-window {
            width: 880px;
            max-height: 1100px;
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
          }
          .mockup-body img {
            max-width: 100%;
            height: auto;
            border-radius: 8px;
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
          <div class="mockup-body">
          </div>
        </div>
      `;

      document.body.appendChild(overlay);
      const bodyTarget = overlay.querySelector('.mockup-body');
      
      const clone = readme.cloneNode(true);
      const ghAnchors = clone.querySelectorAll('.anchor');
      ghAnchors.forEach(a => a.remove());

      bodyTarget.appendChild(clone);
      return true;
    }, bgGradient);

    if (!screenshotBuffer) {
      console.log('Failed to create overlay');
      return;
    }

    await page.waitForTimeout(1500);

    const overlayEl = await page.$('#spotlight-mockup-overlay');
    const image = await overlayEl.screenshot({ type: 'png' });

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, image);
    console.log(`Saved screenshot to ${outputPath}`);
  } finally {
    await browser.close();
  }
}

testRender('https://github.com/browser-use/browser-use', './scratch/mockup_browser_use.png', 'sunset');

