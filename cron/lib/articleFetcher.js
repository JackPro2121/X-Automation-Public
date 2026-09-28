/**
 * Article Fetcher for X-Automation pipelines.
 * Fetches full article content from URLs for AI summarization.
 *
 * PRIMARY: Jina Reader (https://r.jina.ai/URL) — FREE, clean content extraction
 * FALLBACK: Native fetch + HTML strip (basic, gets some junk)
 *
 * Jina Reader returns clean, readable content without nav/footer/ads.
 * No API key needed. Free for reasonable usage.
 */

const JINA_READER_URL = 'https://r.jina.ai/';

/**
 * Fetch article content using Jina Reader (primary) with HTML fallback.
 *
 * @param {string} url - Article URL
 * @param {number} maxChars - Max characters to return (default 3000)
 * @returns {Promise<string|null>} Clean article text or null
 */
export async function fetchArticleContent(url, maxChars = 3000) {
  if (!url || !url.startsWith('http')) return null;

  // Try Jina Reader first (clean extraction)
  try {
    const jinaUrl = `${JINA_READER_URL}${url}`;
    const res = await fetch(jinaUrl, {
      headers: {
        'Accept': 'text/plain',
        'X-Return-Format': 'text',  // Get plain text, not markdown
      },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });

    if (res.ok) {
      const text = await res.text();
      if (text && text.length > 100) {
        // Clean up Jina output
        let cleaned = text.trim();
        // Remove Jina header/footer if present
        cleaned = cleaned.replace(/^Title:.*\n?/m, '');
        cleaned = cleaned.replace(/^URL Source:.*\n?/m, '');
        cleaned = cleaned.replace(/^Published Time:.*\n?/m, '');
        cleaned = cleaned.replace(/^Markdown Content:.*\n?/m, '');
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
        cleaned = cleaned.trim();

        if (cleaned.length > 100) {
          console.log(`    ✓ Jina Reader: ${cleaned.length} chars extracted`);
          return cleaned.substring(0, maxChars);
        }
      }
    }
  } catch (err) {
    console.warn(`    ⚠ Jina Reader failed: ${err.message}, trying fallback...`);
  }

  // Fallback: Native fetch + HTML strip
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; X-Automation/1.0)',
        'Accept': 'text/html,application/xhtml+xml,text/plain',
      },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    });

    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text') && !contentType.includes('html')) {
      return null;
    }

    const html = await res.text();
    const text = extractTextFromHtml(html);

    if (!text || text.length < 50) return null;
    console.log(`    ✓ HTML fallback: ${text.length} chars extracted`);
    return text.substring(0, maxChars);
  } catch (err) {
    console.warn(`    ⚠ Article fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Extract readable text from HTML (fallback method)
 * Strips scripts, styles, nav, footer, ads
 */
function extractTextFromHtml(html) {
  let text = html;

  // Remove script and style tags with content
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
  text = text.replace(/<aside[\s\S]*?<\/aside>/gi, '');

  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // Remove all HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&#\d+;/g, '');

  // Clean up whitespace
  text = text.replace(/\s+/g, ' ');
  text = text.replace(/\n\s*\n/g, '\n');
  text = text.trim();

  return text;
}

/**
 * Fetch article and return structured data
 * Used by HN/Dev.to clients to enrich post data
 *
 * @param {string} url - Article URL
 * @returns {Promise<{content: string|null, wordCount: number}>}
 */
export async function enrichPostWithArticle(url) {
  const content = await fetchArticleContent(url);
  if (!content) return { content: null, wordCount: 0 };

  const wordCount = content.split(/\s+/).length;
  return { content, wordCount };
}
