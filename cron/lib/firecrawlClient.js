/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   FIRECRAWL SEARCH & SCRAPER CLIENT — Content Radar              ║
 * ║   cron/lib/firecrawlClient.js                                    ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Extracts high-signal Markdown from tech repositories, papers,  ║
 * ║   and live engineering breakdowns using Firecrawl API.           ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const FIRECRAWL_API_BASE = 'https://api.firecrawl.dev/v1';
const REQUEST_TIMEOUT_MS = 25000;

export function isFirecrawlConfigured() {
  const key = process.env.FIRECRAWL_API_KEY;
  return Boolean(key && key.trim());
}

function getApiKey() {
  return process.env.FIRECRAWL_API_KEY?.trim() || null;
}

/**
 * Perform a web search via Firecrawl.
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit=5]
 * @returns {Promise<Array<{title: string, url: string, description: string}>>}
 */
export async function searchFirecrawl(query, { limit = 5 } = {}) {
  const apiKey = getApiKey();
  if (!apiKey) return [];

  try {
    const res = await fetch(`${FIRECRAWL_API_BASE}/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, limit }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.warn(`  ⚠ Firecrawl Search HTTP ${res.status}: ${err.slice(0, 120)}`);
      return [];
    }

    const data = await res.json();
    return Array.isArray(data.data) ? data.data : [];
  } catch (err) {
    console.warn(`  ⚠ Firecrawl Search failed: ${err.message}`);
    return [];
  }
}

/**
 * Scrape a specific URL into clean Markdown via Firecrawl.
 * @param {string} url
 * @returns {Promise<string|null>}
 */
export async function scrapeMarkdown(url) {
  const apiKey = getApiKey();
  if (!apiKey || !url) return null;

  try {
    const res = await fetch(`${FIRECRAWL_API_BASE}/scrape`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        onlyMainContent: true,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.warn(`  ⚠ Firecrawl Scrape HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    return data.data?.markdown || null;
  } catch (err) {
    console.warn(`  ⚠ Firecrawl Scrape failed: ${err.message}`);
    return null;
  }
}
