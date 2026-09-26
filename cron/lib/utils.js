/**
 * Shared utilities for all cron pipelines.
 * Dedup, ID generation, shuffle, env validation.
 */

import { DEDUP_WINDOW_HOURS } from './constants.js';
import { X_SAFE_MAX_CHARS, smartTrimToTarget, MIN_TWEET_CHARS } from '../tweetLimits.js';

// ─── Dedup Check (null-safe, fail-safe) ────────────────────────────────────────

/**
 * Check if a Reddit URL has already been posted within the dedup window.
 * Returns true if posted, false if not, true on error (fail-safe to prevent duplicates).
 *
 * Fixes:
 *  - C2: null source_url now returns true (skip) instead of false (repost)
 *  - H3: Supabase errors now return true (fail-safe) instead of false (fail-open)
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string|null} sourceUrl
 * @param {number} [windowHours=DEDUP_WINDOW_HOURS]
 * @returns {Promise<boolean>}
 */
export async function isDuplicate(supabase, sourceUrl, windowHours = DEDUP_WINDOW_HOURS) {
  // Null/empty URL — treat as duplicate to prevent posting without a source.
  // Without this, posts with null source_url escape dedup permanently.
  if (!sourceUrl) return true;

  try {
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('generated_posts')
      .select('id')
      .eq('source_url', sourceUrl)
      .gte('db_created_at', since)
      .limit(1);

    if (error) {
      // Fail-safe: on DB error, assume duplicate to prevent re-posting.
      console.warn(`  ⚠ Dedup check failed (${error.message}) — assuming duplicate`);
      return true;
    }

    return data && data.length > 0;
  } catch (err) {
    // Fail-safe on network/timeout errors
    console.warn(`  ⚠ Dedup check error (${err.message}) — assuming duplicate`);
    return true;
  }
}

// ─── ID Generation (collision-safe) ────────────────────────────────────────────

/**
 * Generate a unique post ID with timestamp + random suffix.
 * Fixes M8: Date.now() alone could collide if manual + scheduled runs overlap.
 *
 * @param {string} prefix - e.g. 'v3', 'v4', 'ap'
 * @returns {string}
 */
export function generateId(prefix) {
  const rand = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${Date.now()}_${rand}`;
}

// ─── Fisher-Yates Shuffle ─────────────────────────────────────────────────────

/**
 * Unbiased shuffle returning the first `count` elements.
 * Fixes M9: Array.sort(() => Math.random() - 0.5) produces biased results.
 *
 * @template T
 * @param {T[]} arr
 * @param {number} count - number of elements to return
 * @returns {T[]}
 */
export function shuffleArray(arr, count) {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

// ─── Env Validation ───────────────────────────────────────────────────────────

/**
 * Validate required environment variables are set.
 * Exits with a clear error message if any are missing.
 * Fixes M7: cryptic errors when env vars are missing.
 *
 * @param {string[]} required - list of env var names
 */
export function validateEnv(required) {
  const missing = required.filter(name => !process.env[name]);
  if (missing.length > 0) {
    console.error(`\n❌ FATAL: Missing required environment variables:\n  ${missing.join('\n  ')}\n`);
    console.error('Set these in .env.local (local dev) or GitHub Actions secrets (CI).');
    process.exit(1);
  }
}

// ─── Text Sanitization ────────────────────────────────────────────────────────

/**
 * Strip markdown formatting from LLM output.
 * Fixes M6: MiMo sometimes returns **bold**, *italic*, or backtick code.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripMarkdown(text) {
  if (!text) return text;
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold** → bold
    .replace(/\*(.+?)\*/g, '$1')         // *italic* → italic
    .replace(/`([^`]+)`/g, '$1')         // `code` → code
    .replace(/```[\s\S]*?```/g, '')      // code blocks → remove
    .replace(/^>\s?/gm, '')              // > quote → text
    .replace(/^[*]\s+/gm, '• ')          // * bullet → clean • bullet
    .replace(/[\u2014]/g, ', ')          // em-dash (—) → comma
    .replace(/[\u2013]/g, ', ')          // en-dash (–) → comma
    .replace(/\s*--\s*/g, ', ')          // double-hyphen (--) → comma
    .replace(/[^\S\r\n]+,/g, ',')        // remove space before comma on same line
    .replace(/,\s*,/g, ',')              // collapse double commas
    .replace(/[\u2018\u2019]/g, "'")     // smart quotes → straight
    .replace(/[\u201C\u201D]/g, '"')     // smart double quotes → straight
    .replace(/[\uFF1F]/g, '?')           // full-width ？→ ?
    .replace(/[\uFF0C]/g, ',')           // full-width ，→ ,
    .replace(/[\uFF01]/g, '!')           // full-width ！→ !
    .replace(/[\uFF1B]/g, ';')           // full-width ；→ ;
    .replace(/[\uFF1A]/g, ':')           // full-width ：→ :
    .replace(/[\u3002]/g, '.')           // CJK 。→ .
    .replace(/[\u2026]/g, '...')         // ellipsis (…) → three dots
    .replace(/[^\S\r\n]{2,}/g, ' ')      // collapse horizontal spaces ONLY (never squash \n)
    .replace(/\n{3,}/g, '\n\n')          // normalize 3+ newlines to clean double newline
    .trim();
}

/**
 * Clean up @username mentions from generated text while preserving line breaks.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripMentions(text) {
  if (!text) return text;
  return text
    .replace(/Follow @\w+/gi, '')                 // Remove "Follow @username" CTAs
    .replace(/(?:^|\s)@(\w{1,15})(?=\s|[.,!?;:']|$)/g, ' $1') // Remove @ prefix from mentions so subject/brand name is preserved
    .replace(/[^\S\r\n]{2,}/g, ' ')               // Collapse horizontal spaces only
    .replace(/\n{3,}/g, '\n\n')                   // Keep clean paragraph separation
    .trim();
}

/**
 * Enforce clean paragraph formatting for viral X posts:
 * - Trims each line individually
 * - Preserves double newlines (\n\n) between paragraphs
 * - Eliminates 3+ excessive empty lines
 *
 * @param {string} text
 * @returns {string}
 */
export function formatPostWhitespace(text) {
  if (!text) return '';
  return text
    .split('\n')
    .map(line => line.replace(/[^\S\r\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Reasoning / Chain-of-Thought Stripper ───────────────────────────────────
// Reasoning models (nvidia/nemotron, qwen-thinking, glm, deepseek-r1, etc.) emit
// their scratchpad either inside <think>…</think> / <reasoning>…</reasoning> tags,
// OR — when max_tokens cuts them off — as an UNCLOSED opener with no matching tag.
// This strips both shapes so no chain-of-thought ever survives into a tweet.
// Returns the answer portion, or '' when the text is ENTIRELY reasoning (the
// caller then rejects it → the model chain rotates to the next model / retries).
const REASONING_TAGS = 'think|thinking|reason|reasoning|thought|scratchpad|analysis';
const REASONING_BLOCK_RE = new RegExp(`<(${REASONING_TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, 'gi');
const REASONING_CLOSE_RE = new RegExp(`<\\/(?:${REASONING_TAGS})>`, 'gi');
const REASONING_OPEN_RE = new RegExp(`<(?:${REASONING_TAGS})\\b[^>]*>`, 'i');

/**
 * Remove reasoning-model chain-of-thought from raw LLM output.
 * @param {string} text
 * @returns {string} the answer text (may be '' if the output was all reasoning)
 */
export function stripReasoning(text) {
  if (!text) return '';
  let t = String(text);

  // 1. Remove all balanced <think>…</think>-style blocks.
  t = t.replace(REASONING_BLOCK_RE, '');

  // 2. If an unbalanced CLOSING tag survives, the real answer is after the LAST
  //    one (model opened before the window we saw, or nested oddly).
  let m, lastCloseEnd = -1;
  REASONING_CLOSE_RE.lastIndex = 0;
  while ((m = REASONING_CLOSE_RE.exec(t)) !== null) lastCloseEnd = m.index + m[0].length;
  if (lastCloseEnd >= 0) t = t.slice(lastCloseEnd);

  // 3. If an OPENING tag survives with no close after it (max_tokens cut the model
  //    off mid-thought), everything from that opener onward is thinking → drop it.
  const om = t.match(REASONING_OPEN_RE);
  if (om) t = t.slice(0, om.index);

  return t.trim();
}

// ─── Language Detection (English-only guard) ─────────────────────────────────
// Old filter used non-ASCII ratio (>0.3), but Latin-script languages
// (Spanish, French, German, Turkish, etc.) are mostly ASCII with a few accents
// (e.g. "¡BOMBA EXPLOSIVA!" ~10% non-ASCII) and slipped through. This checks
// non-Latin scripts, Spanish inversion marks, and accented-letter density.

const NON_LATIN_SCRIPT_RE = [
  /\p{Script=Han}/u,      // Chinese / Japanese kanji
  /\p{Script=Hiragana}/u, // Japanese
  /\p{Script=Katakana}/u, // Japanese
  /\p{Script=Hangul}/u,   // Korean
  /\p{Script=Cyrillic}/u, // Russian, Ukrainian, etc.
  /\p{Script=Arabic}/u,   // Arabic, Urdu, Persian
  /\p{Script=Devanagari}/u, // Hindi
  /\p{Script=Greek}/u,
  /\p{Script=Hebrew}/u,
  /\p{Script=Thai}/u,
  /\p{Script=Armenian}/u,
  /\p{Script=Georgian}/u,
];

const ACCENTED_LATIN_RE = /[áàâäãåéèêëíìîïóòôöõúùûüñçğışöçéàèù]/giu;
const SPANISH_MARKS_RE = /[¡¿]/u;

// High-frequency function words. English words that rarely appear in
// Spanish/French/German/Turkish translations; non-English words that almost
// never appear in genuine English text. Comparison of hit counts decides.
const EN_STOPWORDS = new Set([
  'a', 'the', 'and', 'of', 'to', 'is', 'in', 'that', 'it', 'for', 'on', 'this',
  'with', 'you', 'are', 'your', 'was', 'be', 'as', 'at', 'by', 'have', 'not',
  'we', 'they', 'he', 'she', 'his', 'her', 'from', 'or', 'an', 'will', 'their',
  'there', 'than', 'then', 'when', 'which', 'what', 'how', 'why', 'so', 'can',
  'but', 'about', 'into', 'its', 'our', 'your', 'just', 'like', 'more',
  'please', 'help', 'new', 'make', 'made', 'see', 'one', 'all', 'up', 'out',
]);

const NON_EN_STOPWORDS = new Set([
  // Spanish (avoid English words: no, me)
  'de', 'la', 'el', 'que', 'y', 'los', 'del', 'las', 'una', 'un', 'para', 'por',
  'con', 'su', 'al', 'lo', 'como', 'más', 'pero', 'sus', 'ya', 'también',
  'desde', 'hasta', 'este', 'esta', 'muy', 'todo', 'entre', 'tiene', 'puede',
  'está', 'son', 'es', 'hay', 'sin', 'sobre', 'se', 'te', 'nos',
  'cuando', 'donde', 'porque', 'antes', 'después', 'ahora', 'hoy',
  'ser', 'hacer', 'pueden', 'puedes', 'bien', 'gran', 'gente', 'vida', 'tiempo',
  'casa', 'ver', 'solo', 'cada', 'nuevo', 'nueva', 'estos', 'esas', 'años',
  'día', 'noche', 'mejor', 'peor', 'aprender', 'trabajo', 'cómo', 'qué',
  // French (avoid English words: on)
  'le', 'la', 'les', 'de', 'du', 'des', 'un', 'une', 'et', 'est', 'que', 'qui',
  'dans', 'pour', 'sur', 'pas', 'nous', 'vous', 'ils', 'elles', 'ce', 'cette',
  'ces', 'mais', 'plus', 'tout', 'avec', 'être', 'avoir', 'faire', 'par',
  'son', 'sa', 'ses', 'leur', 'leurs', 'je', 'tu', 'il', 'elle',
  'au', 'aux', 'comme', 'aussi', 'très', 'faut', 'sont', 'fait',
  // German (avoid English words: in)
  'der', 'die', 'das', 'und', 'ist', 'den', 'von', 'mit', 'nicht', 'ein', 'eine',
  'auf', 'für', 'sich', 'des', 'im', 'dem', 'dass', 'wird', 'auch', 'bei', 'nach',
  'wie', 'wir', 'sie', 'ich', 'er', 'es', 'kann', 'war', 'sind', 'zu',
  'aus', 'über', 'haben', 'werden', 'einen', 'sein', 'ihre', 'neue', 'neuen',
  'gibt', 'mehr', 'nur', 'schon', 'deutsch', 'jetzt', 'gut', 'sehr', 'dann',
  'mal', 'heute',
  // Turkish
  've', 'bir', 'için', 'bu', 'ile', 'olan', 'da', 'çok', 'daha', 'ne',
  'ben', 'sen', 'biz', 'siz', 'onlar', 'ama', 'gibi', 'kadar', 'göre', 'sonra',
  'önce', 'şimdi', 'bugün', 'var', 'yok', 'iyi', 'kötü', 'her', 'diye',
  'olarak', 'milyonlarca', 'kitabi', 'ücretsiz', 'indirebilirsiniz', 'pdf', 'site',
  // Portuguese (avoid English words: no)
  'da', 'do', 'em', 'para', 'uma', 'os', 'as', 'mais',
  'não', 'dos', 'das', 'ao', 'na', 'ter',
  // Italian (avoid English words: a, in)
  'di', 'che', 'il', 'sono', 'questo', 'anche', 'si', 'più', 'ora', 'oggi',
]);

/**
 * Reject text that is clearly not English.
 * Combines non-Latin script detection, Spanish inversion marks, accented-letter
 * density, and stopword comparison (English vs Spanish/French/German/Turkish/...).
 * Returns false for non-English, true for likely-English.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isLikelyEnglish(text) {
  if (!text || text.length === 0) return false;

  // Strip noise (URLs, mentions, hashtags, emojis) so it doesn't skew detection
  const cleaned = text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@\w+/g, '')
    .replace(/#\w+/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, '')
    .trim();

  if (!cleaned) return false;

  // 1. Non-Latin scripts → definitely not English
  for (const re of NON_LATIN_SCRIPT_RE) {
    if (re.test(cleaned)) return false;
  }

  // 2. Spanish inversion marks (¡¿) never appear in English
  if (SPANISH_MARKS_RE.test(cleaned)) return false;

  // 3. Accented Latin letters — English has at most 1-2 (café, résumé, naïve).
  //    Spanish/French/German/Portuguese/Turkish have many.
  const accented = cleaned.match(ACCENTED_LATIN_RE) || [];
  if (accented.length >= 3) return false;

  const letters = cleaned.match(/[a-z]/giu) || [];
  const accentedRatio = letters.length > 0 ? accented.length / letters.length : 0;
  if (accentedRatio > 0.05) return false;

  // 4. Stopword comparison — decisive for Latin-script languages that avoid
  //    accents (e.g. all-caps Spanish "TELEVISIÓN" or "EN").
  const words = cleaned.toLowerCase().match(/[a-zà-ÿ']+/g) || [];
  let enHits = 0;
  let nonEnHits = 0;
  for (const w of words) {
    if (EN_STOPWORDS.has(w)) enHits++;
    if (NON_EN_STOPWORDS.has(w)) nonEnHits++;
  }
  if (nonEnHits >= 2 && nonEnHits > enHits) return false;

  // 5. Zero English function words + at least one non-English stopword + an
  //    accented character strongly suggests a foreign language (e.g. Spanish
  //    "BOMBA EXPLOSIVA EN TELEVISIÓN NACIONAL": no English words, "en" hit,
  //    and accented Ó).
  if (nonEnHits >= 1 && enHits === 0 && accented.length >= 1) return false;

  return true;
}

// ─── AI Image-Prompt Detection ─────────────────────────────────────────────────
// Reddit image posts from r/midjourney, r/StableDiffusion, etc. use the raw
// generation prompt as the title (e.g. "a castle at dawn --ar 16:9 --v 6.0").
// When the LLM fallback chain fails, the raw title gets posted as-is, which
// looks like command spam. Detect these and skip the post instead.

const AI_PROMPT_FLAG_RE = /--(?:ar|aspect|style|stylize|v|version|seed|no|s|quality|q|chaos|c|iw|video|niji|sref|cref|w|h|weird|tile|profile|repeat|stop|relax|anime|turbo)\b/i;
const AI_PROMPT_FRAGMENT_RE = /(?:^|\s)(?:--[\w]+|-[a-z]{1,3}\s+\d+(?:\.\d+)?)/g;

/**
 * Detect raw AI image-generation prompts (Midjourney/SD/Flux style) that should
 * never be posted as a tweet. Returns true for prompt-like text.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isAIPromptText(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 5 || t.length > 300) return false;

  // Midjourney/SD CLI-style flags (--ar 16:9, --stylize 750, --seed 123)
  if (AI_PROMPT_FLAG_RE.test(t)) return true;

  // Repeated short dash-flags (common in SD prompts) — at least 2 hits
  const fragments = t.match(AI_PROMPT_FRAGMENT_RE) || [];
  if (fragments.length >= 2) return true;

  return false;
}

// ─── Raw-Title Quality Guard ────────────────────────────────────────────────────
// Raw-title fallback (used when MiMo/Groq fail) sometimes posts a too-short,
// generic string (e.g. "Web development", "Fantasy RPG Portraits", "What to do
// with old HDDs"). These look low-effort and hurt the account. Reject raw titles
// that are too short, too few words, or generic labels so the post is skipped.

const GENERIC_LABEL_RE = /^(web development|development|design|art|photography|nature|sky|portrait|landscape|logo|video|music|fun|random|cool|awesome|nice|test|idea|help|new|update|release|join|check|look|wow|me|my|go|no|ok|top|best)\b/i;

// Help-request titles: the OP is asking for assistance ("Please guide me...",
// "Can anyone help...") — not shareable content. Rejected as raw fallback.
const HELP_REQUEST_RE = /^(please\s+(guide|help|teach|tell|explain|suggest|advise)\b)|^(can|could)\s+(anyone|somebody|someone)\b|\b(help me out|help me)\b|^(i need\s+(help|advice|guidance))\b/i;

// Versioned release-announcement titles (e.g. "Curium v0.6.4 — Privacy-First
// QR Customizer") read like changelog spam on X. Reject when a v-prefixed
// version (v0.6.4) or full semver (0.6.4) appears in the first 25 chars.
// "Ubuntu 24.04 LTS" stays (2-part, no v-prefix).
const VERSION_TITLE_RE = /^.{0,25}\b(v\d+\.\d+(\.\d+)?|\d+\.\d+\.\d+)\b/i;

// Engagement-bait titles ("I asked ChatGPT to...", "Someone asked me...")
// — low-effort filler, not shareable content. Rejected as raw fallback.
const ASKED_TITLE_RE = /^(i asked|someone asked)\b/i;

/**
 * Decide whether a raw title is good enough to post as a fallback tweet.
 * Rejects empty, very short (< 40 chars), very few-word (< 4 words), or generic
 * one-two-word labels that would look like spam on X.
 *
 * @param {string} title
 * @returns {boolean}
 */
export function isQualityFallbackTitle(title) {
  if (!title) return false;
  const t = title.trim();
  if (t.length < 40) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  if (GENERIC_LABEL_RE.test(t.toLowerCase())) return false;
  if (HELP_REQUEST_RE.test(t)) return false;
  if (VERSION_TITLE_RE.test(t)) return false;
  if (ASKED_TITLE_RE.test(t)) return false;
  return true;
}

// ─── Meta-Text Caption Detector (final defense before Buffer) ────────────────
// Catches LLM prompt/thinking leaks that survived generation cleanup:
// "Emoji Rule: ...", "Context: The title ...", "Image: Shows ...",
// "Post: Title: ...", "Wait, is it a recipe? ..." — all went LIVE in
// Aug 23-25 (Groq fallback era). Shared by groqClient cleanTweetText and
// bufferClient immediate/queue/video posting paths.
const META_TEXT_RE = [
  /^\d+\.\s*(emoji|content|hook|body|cta|intent|tone|style|rewrite|translate|title|char\s*(limit|count|s)?|visuals?)\s*:/i,
  /^(intent|content|hook|body|cta|tone|style|char\s*(limit|count|s)?|emoji(\s+(rule|choice))?|context|image(\/text)?(\s+(shown|shows|description|details|analysis))?|post(\s+title)?|visuals?(\s+(brief|breakdown|shown|details))?|image analysis)\s*:/i,
  /^(the post is|this post (is|shows|contains)|this is a screenshot of|this is likely about|this image shows|the image shows|shows the|displays the)\b/i,
  /^(must start with|start the tweet|pick by intent|emoji rule|start with exactly one emoji|post to tweet about|visual breakdown|task:|hook style)\b/i,
  /^wait[,.!\s]/i,
  /^(here('s| is)|i ('ll|will|am going to))\b/i,
  /^(caption|tweet|comment)\s*(text|rules)?\s*:/i,
  // Chain-of-thought openers (nemotron/glm reasoning models emit these as content)
  /^(the user wants?|we need to|let me|i should|i'll start by)\b/i,
  /thinking process|^analysis:|^step \d+/i,
];

export function isMetaTextCaption(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (META_TEXT_RE.some(re => re.test(trimmed))) return true;
  // Also check if any strong leak label appears right at start or inside text
  if (/\b(visuals?|visual brief|image analysis):\s*(shows|the|a|an)\b/i.test(trimmed)) return true;
  if (/\b(must start with exactly one emoji|start the tweet with exactly one)\b/i.test(trimmed)) return true;
  return false;
}

// ─── Generic "AI-Slop" Authenticity Gate ─────────────────────────────────────
// X Creator Rewards downranks/flags content that reads like generic LLM output.
// This deterministic gate (zero extra API cost) rejects posts that show the
// tell-tale signs of AI-generated hype so the pipeline regenerates a fresher,
// more human-sounding one. Tuned to need MULTIPLE weak signals or ONE hard
// tell — over-rejecting would starve the feed, so keep the hard list tight.

// Phrases that almost never appear in an authentic technical creator's voice —
// pure marketing/AI-assistant filler. A single hit is enough to reject.
// Sourced from live audits + AgriciDaniel/claude-blog first-order AI phrase inventory.
const AI_SLOP_HARD = [
  'game-changer', 'game changer', 'gamechanger', 'revolutionize', 'revolutionise',
  'in today\'s fast-paced', 'in today\'s digital landscape', 'in today\'s digital world',
  'in the ever-evolving', 'ever-evolving landscape',
  'unlock the power', 'unleash the power', 'harness the power', 'the power of',
  'dive into the world', 'let\'s dive in', 'dive into', 'delve into',
  'buckle up', 'the possibilities are endless',
  'the future is here', 'the future of', 'stay tuned', 'we can\'t wait to see',
  'take it to the next level', 'elevate your', 'supercharge your', 'seamless integration',
  'seamlessly', 'cutting-edge', 'cutting edge',
  'in conclusion', 'without further ado', 'look no further', 'say goodbye to',
  'welcome to the future', 'a new era', 'the holy grail', 'this is huge', 'mind-blowing',
  'it\'s not just', 'this isn\'t just', 'more than just a', 'a testament to',
  'it\'s important to note', 'it is important to note', 'demystify', 'demystifying',
  'beacon of', 'multifaceted', 'navigate the landscape', 'navigating the landscape',
  'embark on', 'rich tapestry', 'tapestry of', 'crucial role', 'revolutionize the way',
];

// Softer signals — need 2+ combined to reject (any one alone is tolerable).
const AI_SLOP_SOFT = [
  'delve', 'delving', 'leverage', 'leveraging', 'robust',
  'transformative', 'paradigm', 'synergy', 'empower', 'empowering', 'streamline', 'streamlining',
  'ecosystem', 'landscape', 'realm', 'tapestry', 'testament', 'pivotal', 'crucial',
  'unprecedented', 'groundbreaking', 'innovative solution', 'exciting', 'thrilled',
  'excited to share', 'imagine a world', 'what if i told you', 'let that sink in',
  'foster', 'fostering', 'holistic', 'bespoke', 'catalyst', 'spearhead',
];

/**
 * Detect generic AI-generated "slop" that X Creator Rewards flags as low-quality.
 * @param {string} text
 * @returns {boolean} true if the post reads as generic AI hype and should be regenerated
 */
export function isGenericAIText(text) {
  if (!text) return false;
  const lower = text.toLowerCase();

  // 1. Any hard tell → reject.
  for (const p of AI_SLOP_HARD) {
    if (lower.includes(p)) return true;
  }

  // 2. Two or more soft tells → reject.
  let soft = 0;
  for (const p of AI_SLOP_SOFT) {
    if (lower.includes(p)) { soft++; if (soft >= 2) return true; }
  }

  // 3. Emoji flood — real people rarely use 4+ emojis in one short post.
  const emojis = text.match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu) || [];
  if (emojis.length >= 4) return true;

  // 4. "Rhetorical question + hype answer" bot cadence, e.g. "The result? Insane."
  if (/\b\w[\w\s]{0,40}\?\s+(the (result|answer|verdict|kicker|best part)\?|and|but|well)\b/i.test(text)
      && soft >= 1) return true;

  return false;
}

/**
 * Second-order structural reflex scanner adapted from Claude-Blog
 * (skills/blog/references/ai-slop-detection.md).
 * Catches structural patterns that survive basic vocabulary edits:
 * - Formulaic openers ("Here is why...", "What's important here is...")
 * - Lazy rhetorical closing engagement bait ("Thoughts?", "What are your thoughts?")
 * - Excessive hedging clusters in short text
 *
 * @param {string} text
 * @returns {boolean} true if structural AI reflexes are detected
 */
export function isSecondOrderAISlop(text) {
  if (!text) return false;
  const trimmed = text.trim();

  // 1. Formulaic robotic openers
  if (/^(?:here(?:'s| is) (?:why|what|how|the reason)|the key takeaway is|what(?:'s| is) important here is|at the end of the day)\b/i.test(trimmed)) {
    return true;
  }

  // 2. Generic non-technical question engagement bait closers
  if (/\b(?:what (?:are your thoughts|do you think)|thoughts\?|agree or disagree\?|what are your takes\?)\s*$/i.test(trimmed)) {
    return true;
  }

  // 3. Excessive hedge clusters in short posts (>= 3 in text under 600 chars)
  if (trimmed.length < 600) {
    const hedges = trimmed.match(/\b(typically|generally|often|arguably|potentially)\b/gi) || [];
    if (hedges.length >= 3) return true;
  }

  return false;
}

// ─── False First-Person Attribution Detector ─────────────────────────────────
// When curating community posts / tools (v3, v4, v6), LLMs sometimes hallucinate
// and write in the first person ("I built a tool...", "I coded an app...", "My project").
// This falsely implies the account owner built someone else's work.
// Reject these so the generator is forced to write from an expert curator/analyst perspective.
const FALSE_ATTRIBUTION_RE = /\b(i (built|created|coded|developed|launched|released|trained|fine-tuned)|my (tool|library|repo|script|extension|package|app|project|build))\b/i;

export function hasFalseAttribution(text) {
  if (!text) return false;
  return FALSE_ATTRIBUTION_RE.test(text);
}

// ─── Borrowed-Authority Detector ─────────────────────────────────────────────
// WHY THIS EXISTS (Sep 15, 2026)
//
// The derivation prompt rewrite fixed the derivative-output problem but opened a
// new failure mode, caught in the first live A/B run. Given a source with no
// numbers, the model invented an authority to anchor its claim:
//
//   source: "Opus 5 High Comes Close, but Kimi K3 Still Leads on Frontend"
//   post:   "Anthropic's next-model telemetry shows Opus 5 High matching Kimi K3
//            on 40% of frontend tasks, but latency remains 2x higher."
//
// No telemetry. No 40%. No latency figure. The source is a headline.
//
// These pipelines have exactly ONE source: the post below. So a phrase that
// asserts evidence from anywhere else is, by construction, unverifiable — and in
// practice it is fabricated. That makes this safe to ENFORCE rather than shadow,
// unlike the information-delta signal: the pattern has no legitimate use here.
//
// Deliberately narrow. Phrases like "the data suggests" are excluded because a
// post may legitimately refer to the source's own data. Only claims of evidence
// from an external or unavailable source are matched.
const BORROWED_AUTHORITY_RE = new RegExp(
  [
    'telemetry (shows|suggests|indicates|reveals)',
    'reports (indicate|suggest|show)',
    'sources (say|indicate|suggest)',
    'analysts (expect|say|predict)',
    'studies (show|suggest|find)',
    'research (shows|suggests|indicates)',
    'a (study|report|survey) (found|shows|found that)',
    'internal (documents|data|memos)',
    'leaked (documents|memos|internal)',
    'benchmarks? (show|suggest|indicate|reveal)',
    'according to (reports|sources|analysts)',
  ].join('|'),
  'i'
);

export function hasBorrowedAuthority(text) {
  if (!text) return false;
  return BORROWED_AUTHORITY_RE.test(text);
}

// ─── Fabricated-Experience Detector ──────────────────────────────────────────
// The sibling of the guard above, added after the same A/B run. Fixing the
// derivative-output problem made the model reach for *unnamed* authority too:
//
//   "I see teams burning through GPU hours on ambiguous queries, forcing a
//    manual review step that kills the velocity gain."
//
// Nobody saw that. This pipeline scrapes a post, reads it, and writes a caption —
// it never runs the tool, benchmarks anything, or talks to a team. So any
// first-person claim of perception or testing is false by construction.
//
// Deliberately narrow: it targets verbs that assert a WITNESSED EVENT, and
// excludes opinion markers. "My read is X", "I would bet X", "I suspect X" are
// judgements and are explicitly encouraged by the prompt. "I see teams doing X"
// is a claim of fact and is not.
const FABRICATED_EXPERIENCE_RE = new RegExp(
  [
    "\\bi (?:see|saw|watched|noticed|observed|keep seeing|have seen|have noticed|have observed)\\b",
    "\\bi'?ve (?:seen|watched|noticed|observed|tested|benchmarked|measured|run)\\b",
    // First-person ACTION verbs. `i ran` was missing on the first pass — the test
    // fixture "I ran this in prod last month" slipped straight through, while
    // `we ran` was covered. Any first-person claim of running, testing, profiling,
    // or deploying is fabricated: this pipeline scrapes and writes, nothing else.
    "\\bi (?:ran|tested|tried|benchmarked|measured|profiled|deployed|shipped|migrated)\\b",
    "\\bwe (?:see|saw|watched|noticed|observed|ran|tested|tried|benchmarked|measured|profiled|deployed|migrated)\\b",
    "\\bin (?:my|our) (?:experience|testing|benchmarks?|lab|setup|pipeline|prod|production)\\b",
    "\\bfrom (?:my|our) (?:testing|benchmarks?|experience|lab)\\b",
    "\\b(?:every|most|many) (?:teams?|developers?|engineers?) (?:i'?ve|we'?ve) (?:talked|spoken|worked|seen)\\b",
  ].join('|'),
  'i'
);

export function hasFabricatedExperience(text) {
  if (!text) return false;
  return FABRICATED_EXPERIENCE_RE.test(text);
}

// ─── Originality Gate (source-copy / minimal-edit detector) ───────────────────
// X's Original Content Rewards Program (Sept 2026) makes "minimally modified"
// and "aggregated" content INELIGIBLE — i.e. a scraped Reddit/X post that was
// only reworded. This deterministic gate (zero API cost) compares a generated
// caption against its SOURCE text and rejects it when it is really just a copy,
// so the generator is forced to produce a genuinely original take/analysis.
//
// Two independent tells, either one rejects:
//   1. A long VERBATIM word-run copied straight from the source (hard plagiarism).
//   2. High word-TRIGRAM overlap with the source (a light reword of the source).
// Topic words legitimately overlap (model names, benchmarks), so we key on
// phrase-level (trigram) overlap and verbatim runs, never single-word overlap.

function normalizeForCompare(text) {
  return (text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')      // drop URLs
    .replace(/[^a-z0-9\s]/g, ' ')          // strip punctuation/emoji
    .replace(/\s+/g, ' ')
    .trim();
}

function wordTrigrams(words) {
  const grams = new Set();
  for (let i = 0; i + 2 < words.length; i++) {
    grams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  return grams;
}

/**
 * Longest run of consecutive words from `genWords` that appears verbatim,
 * in order, as a contiguous slice of the source word array.
 */
function longestVerbatimRun(genWords, srcWords) {
  if (genWords.length === 0 || srcWords.length === 0) return 0;
  const srcJoined = ' ' + srcWords.join(' ') + ' ';
  let best = 0;
  for (let i = 0; i < genWords.length; i++) {
    for (let len = Math.min(genWords.length - i, 40); len > best; len--) {
      const phrase = ' ' + genWords.slice(i, i + len).join(' ') + ' ';
      if (srcJoined.includes(phrase)) { best = len; break; }
    }
  }
  return best;
}

/**
 * Detect that a generated caption is just a copy / minimal reword of its source.
 * @param {string} generated - the LLM-produced caption/tweet
 * @param {string} source - the scraped source text (title + selftext / tweet text)
 * @param {object} [opts]
 * @param {number} [opts.trigramThreshold=0.5] - reject if this fraction of the
 *        caption's trigrams also appear in the source (0-1). Env override:
 *        ORIGINALITY_TRIGRAM_MAX.
 * @param {number} [opts.verbatimRunWords=8] - reject if this many consecutive
 *        words are copied verbatim. Env override: ORIGINALITY_VERBATIM_MAX.
 * @returns {boolean} true if too similar to the source (should be regenerated)
 */
export function isTooSimilarToSource(generated, source, opts = {}) {
  const gen = normalizeForCompare(generated);
  const src = normalizeForCompare(source);
  if (!gen || !src) return false;

  const genWords = gen.split(' ').filter(Boolean);
  const srcWords = src.split(' ').filter(Boolean);

  // Too little source or output to judge reliably — don't block.
  if (genWords.length < 6 || srcWords.length < 6) return false;

  const verbatimMax = Number(process.env.ORIGINALITY_VERBATIM_MAX) || opts.verbatimRunWords || 8;
  const trigramMax = Number(process.env.ORIGINALITY_TRIGRAM_MAX) || opts.trigramThreshold || 0.5;

  // 1. Verbatim copied phrase — hard plagiarism tell.
  if (longestVerbatimRun(genWords, srcWords) >= verbatimMax) return true;

  // 2. Phrase-level (trigram) overlap — catches light rewording.
  const genGrams = wordTrigrams(genWords);
  if (genGrams.size < 3) return false; // caption too short for a stable ratio
  const srcGrams = wordTrigrams(srcWords);
  let shared = 0;
  for (const g of genGrams) if (srcGrams.has(g)) shared++;
  const overlap = shared / genGrams.size;
  return overlap >= trigramMax;
}

// ─── Paraphrase Detection ─────────────────────────────────────────────────────
// `isTooSimilarToSource()` above catches VERBATIM copying — long identical word
// runs and high trigram overlap. It does not catch a PARAPHRASE: the same claims
// in the same order with synonyms swapped and clauses reordered.
//
// That gap is the one that matters for X's Original Content Rewards. A post can
// be word-for-word original and still contain no information the source did not
// already have — and "minimally modified / aggregated" content is exactly what
// the programme excludes. Being different is not the same as being original.
//
// The signal used here: a paraphrase tracks the source SENTENCE BY SENTENCE.
// Each generated sentence is matched against every source sentence and scored by
// its best trigram overlap. If most generated sentences have a close source
// counterpart, the post is a restatement. Genuine analysis produces sentences
// whose best source match is weak, because the claim itself is new.
//
// A second, independent signal covers the title-only case (Reddit posts whose
// source is just a headline): how much of the post's content vocabulary is
// borrowed from the source. A restatement reuses the source's nouns and verbs;
// analysis introduces its own.

/** Split prose into sentences worth comparing. */
function sentenceSplit(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.split(' ').length >= 4);
}

/** Fraction of `a`'s trigrams that also appear in `b`. */
function trigramOverlap(aWords, bWords) {
  const a = wordTrigrams(aWords);
  if (a.size === 0) return 0;
  const b = wordTrigrams(bWords);
  let shared = 0;
  for (const g of a) if (b.has(g)) shared++;
  return shared / a.size;
}

/** Content words only — stopwords carry no topical information. */
const PARAPHRASE_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that',
  'these', 'those', 'you', 'your', 'we', 'our', 'they', 'their', 'i', 'my', 'me',
  'as', 'at', 'by', 'from', 'into', 'about', 'so', 'than', 'then', 'when', 'while',
  'do', 'does', 'did', 'can', 'will', 'would', 'not', 'no', 'all', 'just', 'now',
  'what', 'who', 'how', 'why', 'still', 'more', 'most', 'up', 'out', 'one', 'get',
  'has', 'have', 'had', 'there', 'here', 'also', 'very', 'much', 'many', 'some',
]);

function contentWordsOf(text) {
  return normalizeForCompare(text).split(' ').filter((w) => w.length > 2 && !PARAPHRASE_STOPWORDS.has(w));
}

/**
 * @typedef {object} ParaphraseVerdict
 * @property {boolean} isParaphrase
 * @property {number} sentenceOverlap - median best-match score across generated sentences (0-1)
 * @property {number} vocabularyBorrowed - fraction of the post's content words present in the source (0-1)
 * @property {string} reason
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ⚠ UNWIRED — DIAGNOSTIC ONLY. DO NOT WIRE THIS INTO A PIPELINE.
 * ═══════════════════════════════════════════════════════════════════════════════
 * This was built as the fix for Axis B (derivative text) and then FALSIFIED by
 * measurement before it was ever connected. Kept only so the calibration scripts
 * in scratch/ can reproduce the finding.
 *
 * Calibration against 82 real published posts vs their real scraped sources:
 *     sentence-trigram overlap   median 0.00, max 0.33  → 1/82 would reject
 *     vocabulary borrowed        median 0.15
 * At every candidate threshold it rejected ~1% of posts, i.e. nothing. The posts
 * are not lexically derivative — they are INFORMATIONALLY derivative, which no
 * similarity metric can see. The real fix was the prompt rewrite (see
 * DERIVATION_MODES in groqClient.js) plus `hasInformationDelta` below.
 *
 * `isTooSimilarToSource()` above IS wired and IS load-bearing — it catches
 * verbatim copies. This function is the one that does nothing. If you are reading
 * this because you are considering enabling it: don't. Run
 * `npm run calibrate:delta` first.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Decide whether a generated post restates its source rather than adding to it.
 *
 * @param {string} generated
 * @param {string} source
 * @param {object} [opts]
 * @param {number} [opts.sentenceOverlap=0.55] - median best-match threshold. Env: PARAPHRASE_SENTENCE_MAX
 * @param {number} [opts.vocabularyBorrowed=0.82] - vocabulary-borrowing threshold. Env: PARAPHRASE_VOCAB_MAX
 * @param {boolean} [opts.explain=false] - return the full verdict object
 * @returns {boolean|ParaphraseVerdict}
 */
export function isParaphraseOfSource(generated, source, opts = {}) {
  const sentenceThreshold = Number(process.env.PARAPHRASE_SENTENCE_MAX) || opts.sentenceOverlap || 0.55;
  const vocabThreshold = Number(process.env.PARAPHRASE_VOCAB_MAX) || opts.vocabularyBorrowed || 0.82;

  const genSentences = sentenceSplit(generated);
  const srcSentences = sentenceSplit(source);
  const srcPrepared = srcSentences.map((s) => normalizeForCompare(s).split(' ').filter(Boolean));

  // Sentence-tracking signal — needs a multi-sentence source to mean anything.
  let sentenceOverlap = 0;
  if (genSentences.length >= 2 && srcPrepared.length >= 1) {
    const bestMatches = [];
    for (const sentence of genSentences) {
      const words = normalizeForCompare(sentence).split(' ').filter(Boolean);
      if (words.length < 4) continue;
      let best = 0;
      for (const srcWords of srcPrepared) {
        const r = trigramOverlap(words, srcWords);
        if (r > best) best = r;
      }
      bestMatches.push(best);
    }
    if (bestMatches.length >= 2) {
      // Median, not mean: one strongly-matching sentence is normal (the post has
      // to name its subject). The MEDIAN being high means the whole post tracks.
      const sorted = [...bestMatches].sort((a, b) => a - b);
      sentenceOverlap = sorted[Math.floor(sorted.length / 2)];
    }
  }

  // Vocabulary-borrowing signal — works even when the source is a bare title.
  const genContent = contentWordsOf(generated);
  const srcContent = new Set(contentWordsOf(source));
  let vocabularyBorrowed = 0;
  if (genContent.length >= 8 && srcContent.size >= 3) {
    let borrowed = 0;
    for (const w of new Set(genContent)) if (srcContent.has(w)) borrowed++;
    vocabularyBorrowed = borrowed / new Set(genContent).size;
  }

  const bySentence = sentenceOverlap >= sentenceThreshold;
  const byVocabulary = vocabularyBorrowed >= vocabThreshold;
  const isParaphrase = bySentence || byVocabulary;

  if (opts.explain) {
    return {
      isParaphrase,
      sentenceOverlap: Number(sentenceOverlap.toFixed(3)),
      vocabularyBorrowed: Number(vocabularyBorrowed.toFixed(3)),
      reason: bySentence
        ? `tracks the source sentence-by-sentence (median overlap ${sentenceOverlap.toFixed(2)} >= ${sentenceThreshold})`
        : byVocabulary
          ? `reuses the source's vocabulary (${(vocabularyBorrowed * 100).toFixed(0)}% borrowed >= ${(vocabThreshold * 100).toFixed(0)}%)`
          : 'adds content the source does not contain',
    };
  }
  return isParaphrase;
}

// ─── Information Delta ────────────────────────────────────────────────────────
// WHY THIS EXISTS (Sep 15, 2026)
//
// Two rounds of calibration against 82 real published posts and their real
// scraped sources falsified the "derivative text = paraphrase" hypothesis:
// sentence-trigram overlap came back with a median of 0.00, and only 3/82 posts
// (4%) copied the source's opening line. The posts are not lexically derivative.
// They are INFORMATIONALLY derivative — different words, same information — and
// no similarity metric can see that. So `isParaphraseOfSource` above is kept as a
// cheap degenerate-case catcher, and this is the signal that actually matters.
//
// What it measures: whether the post contains anything a reader could not have
// produced from the source alone. Two independent indicators:
//   1. computed  — a number in the post that is NOT in the source. The model did
//                  arithmetic, or it fabricated. (Those are separable: fabrication
//                  is caught by the factual-grounding prompt contract, and a
//                  derived figure is by design absent from the source.)
//   2. reasoned  — a high-precision phrase that only appears when a model is
//                  analysing rather than restating ("works out to", "my read",
//                  "the bottleneck", "which means the cost").
//
// DELIBERATELY A SIGNAL, NOT A GATE. Default is shadow mode: it logs the delta
// for every post so the pass rate can be measured on real output BEFORE anything
// is rejected. Enforcing an unmeasured gate is exactly how the paraphrase gate
// ended up rejecting ~1% of posts and doing nothing. Set REQUIRE_INFO_DELTA=true
// to turn it into a hard rejection, once the shadow numbers justify it.

/** High-precision phrases that indicate analysis rather than restatement. */
const DERIVATION_MARKERS = [
  // arithmetic / computation
  'works out to', 'which works out', 'that works out', 'works out at',
  "that's about", 'that is about', 'roughly half', 'about half', 'closer to half',
  'per item', 'per user', 'per token', 'per request', 'per seat', 'per call',
  'divided by', 'multiplied by', 'break-even', 'break even', 'at that price',
  'half a cent', 'a fraction of', 'an order of magnitude',
  'at that scale', 'only work at', 'only works at', 'comes out to', 'which is about',
  'cost per', 'costs about', 'cheaper per', 'the math',
  // arithmetic expressed in WORDS — found missing by the thread fixtures, where a
  // legitimate derivation read "halving it means 12GB ... that doubles throughput
  // per GPU-hour" and scored ambiguous because no digit-bearing operator appeared.
  'halving', 'halves the', 'doubling the', 'doubles the', 'triples the',
  'twice the', 'half the cost', 'a third of', 'a quarter of', 'two thirds',
  'per replica', 'per gpu', 'per hour', 'per dollar', 'per watt', 'per core',
  'means you fit', 'means two', 'fits two', 'instead of one',
  // consequence / mechanism
  'which means the', 'which means you', 'which means it', 'what that means',
  'the second-order', 'second order effect', 'makes it cheap', 'makes it obsolete',
  'no longer worth', 'stops being', 'the real cost', 'the actual cost',
  // constraint / failure
  'the bottleneck', 'bottlenecks at', 'bites first', 'bites at', 'falls over',
  'falls apart', 'breaks down at', 'breaks at', 'the catch is', 'the catch:',
  'the tradeoff', 'the trade-off', 'the caveat', 'the fine print', 'leaves out',
  'does not mention', "doesn't mention", 'omits', 'conspicuously',
  // owned judgement / prediction
  'my read', "my read is", "i'd bet", 'i would bet', "i'd argue", 'i expect',
  'if i am right', "if i'm right", 'my guess', 'the risk here', 'i suspect',
  'by the end of', 'next quarter', 'within a year',
];

/** Extract numeric tokens, normalised (commas stripped) for comparison. */
function numericTokens(text) {
  const out = [];
  const re = /\b\d[\d,]*(?:\.\d+)?\b/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const raw = m[0].replace(/,/g, '');
    // Strip a trailing zero-decimal so "1200" and "1200.0" compare equal.
    out.push(raw.endsWith('.0') ? raw.slice(0, -2) : raw);
  }
  return out;
}

/**
 * Extract only the numbers that indicate ACTUAL COMPUTATION.
 *
 * Why this is not just `numericTokens`: the first calibration run flagged a
 * post as "computed" on novelNumbers=[3, 2026, 13, 2002, 2013] — and that post
 * was a verbatim restatement of its source. The novel numbers were the current
 * year injected by the prompt's CURRENT DATE line, two historical years used as
 * date references, and two trivial integers. So "a number not in the source" is
 * dominated by noise and cannot be used as-is.
 *
 * A number now only counts when it carries a unit or sits inside an arithmetic
 * expression. That is high-precision at the cost of recall — a derived figure
 * written in words ("half a cent per item") is missed, and that is the right
 * trade for a measurement.
 */
function computationalNumbers(text) {
  const s = String(text || '');
  const out = [];
  const push = (v) => { const n = v.replace(/,/g, ''); if (n) out.push(n.endsWith('.0') ? n.slice(0, -2) : n); };
  const NUM = '(\\d[\\d,]*(?:\\.\\d+)?)';
  const patterns = [
    new RegExp('\\$\\s?' + NUM, 'gi'),                      // $1.2B, $5
    new RegExp(NUM + '\\s*%', 'g'),                          // 90%
    new RegExp(NUM + '\\s*(?:x|×)\\b', 'gi'),                // 3x
    new RegExp(NUM + '\\s*(?:gb|tb|mb|kb|ms)\\b', 'gi'),     // 128GB, 40ms
    new RegExp(NUM + '\\s*(?:≈|=|÷)', 'g'),                  // 5 ≈
    new RegExp('(?:≈|=|÷)\\s*' + NUM, 'g'),                  // ≈ 5
    new RegExp(NUM + '\\s*per\\b', 'gi'),                    // 3 per item
    new RegExp(NUM + '\\s*(?:bn|k)\\b', 'g'),                // 12k, 1.2bn
  ];
  for (const re of patterns) {
    for (const m of s.matchAll(re)) push(m[1]);
  }
  return out;
}

/** True when the token is a year reference (1900-2100) — a date, not a figure. */
function isYearLike(token) {
  const n = Number(token);
  return Number.isInteger(n) && n >= 1900 && n <= 2100;
}

/**
 * True when the post shows the inputs behind a figure — an arithmetic relation or
 * an explicit unit conversion sitting in the text.
 *
 * Closes a recall gap found in the live A/B: the hackathon post derived
 * "48 hours → 2,400 minutes" on the page, which is exactly the behaviour the
 * prompt asks for, but it used no marker phrase and so scored "ambiguous". When a
 * novel figure is accompanied by its working, the derivation is visible and the
 * verdict should not be ambiguous.
 */
function showsWorking(text) {
  const s = String(text || '');
  if (/[×÷=≈]/.test(s)) return true;
  if (/\b(times|divided by|multiplied by|half of|split across|over the course of)\b/i.test(s)) return true;
  // "48 hours is 2880 minutes" / "48 hours → 2,880 minutes" / "48h makes 2880m"
  if (/\b\d[\d,.]*\s*(?:hours?|hrs?|h|minutes?|mins?|m|days?|d|weeks?|w|months?|mo|years?|yrs?)\b\s*(?:is|are|equals?|makes?|→|->|becomes?)\s*\d/i.test(s)) return true;
  return false;
}

/**
 * @typedef {object} InfoDeltaVerdict
 * @property {boolean} hasDelta - the post reads as analysis rather than as a summary
 * @property {boolean} reasoned - a high-precision analysis marker is present (TRUSTWORTHY signal)
 * @property {boolean} novelFigure - a unit-bearing figure absent from the source is present (AMBIGUOUS)
 * @property {boolean} ambiguous - novelFigure without reasoned — derivation or fabrication, unknowable lexically
 * @property {string[]} novelNumbers - unit-bearing figures in the post but not the source
 * @property {string[]} markers - which derivation markers matched
 * @property {number} vocabularyBorrowed - fraction of the post's content words in the source (0-1)
 * @property {string} reason
 */

/**
 * Measure whether a post reads as analysis of its source or as a summary of it.
 *
 * HONEST SCOPE — read this before trusting a number from this function.
 * It cannot prove a figure was DERIVED rather than INVENTED. No lexical metric
 * can; the two look identical. Separating them is the prompt contract's job (see
 * the four-tier claim rules in `buildTweetPrompt`), not this function's. What
 * this measures is the observable proxy: does the post reason, or does it restate.
 *
 * `reasoned` is the trustworthy signal. `novelFigure` is deliberately marked
 * ambiguous, because calibration showed what it actually fires on. Scoring the 8
 * posts it flagged under the old prompt:
 *     92% of developers...   from source "why do i get like this"          → invented
 *     36% of users want...   from source "New 100B Liquid AI model coming" → invented poll
 *     25% weekly limits...   from source "decrease of about 20%"           → invented
 *     $15M+ stock grants...  from a source title carrying no figure        → unverifiable
 * (Caveat: the calibration corpus stores only the source TITLE, so a figure
 * could in principle be grounded in a body the model saw and the corpus lacks.
 * Two of the four above are visibly fabricated regardless.)
 *
 * Measured against 82 real published posts written under the OLD prompt:
 *   reasoned                     2/82   2%   ← the number the prompt rewrite must move
 *   novelFigure only (ambiguous) 8/82  10%
 *   no delta at all             72/82  88%
 * By pipeline: catchup 18%, v3 5%, v4 0%, v6 1/1.
 *
 * @param {string} generated
 * @param {string} source
 * @param {object} [opts]
 * @param {boolean} [opts.explain=false] - return the full verdict object
 * @returns {boolean|InfoDeltaVerdict}
 */
export function hasInformationDelta(generated, source, opts = {}) {
  // Novel COMPUTATIONAL figures only. Raw numeric tokens are unusable here:
  // calibration flagged a verbatim restatement as "computed" because the prompt
  // injects CURRENT DATE and the post used historical years as references.
  const srcNumbers = new Set([...numericTokens(source), ...computationalNumbers(source)]);
  const novelNumbers = [...new Set(computationalNumbers(generated))]
    .filter((n) => !srcNumbers.has(n))
    .filter((n) => !isYearLike(n));

  const genLower = String(generated || '').toLowerCase();
  const markers = DERIVATION_MARKERS.filter((mk) => genLower.includes(mk));

  // Vocabulary borrowing, reused from the paraphrase analysis — high borrowing
  // WITH no delta is the exact failure signature we are hunting.
  const genContent = new Set(contentWordsOf(generated));
  const srcContent = new Set(contentWordsOf(source));
  let vocabularyBorrowed = 0;
  if (genContent.size >= 8 && srcContent.size >= 3) {
    let borrowed = 0;
    for (const w of genContent) if (srcContent.has(w)) borrowed++;
    vocabularyBorrowed = borrowed / genContent.size;
  }

  const novelFigure = novelNumbers.length > 0;
  // `reasoned` is true when analysis language is present, OR when a novel figure
  // is shown alongside its own working — the latter is a visible derivation, so
  // it is not ambiguous. See showsWorking() for the A/B case that motivated it.
  const workedOut = novelFigure && showsWorking(generated);
  const reasoned = markers.length > 0 || workedOut;
  // A novel figure with no reasoning and no visible working is ambiguous BY
  // CONSTRUCTION: a derivation whose inputs were not shown, or an invented
  // statistic. Nothing lexical separates those, so it is surfaced as ambiguous
  // rather than counted as either.
  const ambiguous = novelFigure && !reasoned;
  const hasDelta = reasoned || novelFigure;

  if (opts.explain) {
    return {
      hasDelta,
      reasoned,
      novelFigure,
      ambiguous,
      novelNumbers: novelNumbers.slice(0, 8),
      markers: markers.slice(0, 8),
      vocabularyBorrowed: Number(vocabularyBorrowed.toFixed(3)),
      reason: workedOut
        ? `shows the working behind a figure it produced (${novelNumbers.slice(0, 3).join(', ')})`
        : reasoned && novelFigure
          ? `reasons about a figure it produced (${novelNumbers.slice(0, 3).join(', ')}; marker: "${markers[0]}")`
          : reasoned
            ? `reasons rather than restates (marker: "${markers[0]}")`
            : novelFigure
              ? `AMBIGUOUS — figure absent from source (${novelNumbers.slice(0, 3).join(', ')}) with no reasoning or working attached; derivation or fabrication is not decidable lexically`
              : vocabularyBorrowed >= 0.82
                ? `restates the source: ${(vocabularyBorrowed * 100).toFixed(0)}% of its vocabulary is borrowed and it adds no new claim`
                : 'no reasoned or computed content detected — reads as a summary',
    };
  }
  return hasDelta;
}

/**
 * Shadow-mode logger for the information delta. Called on every generated post.
 * Logs only — never rejects unless REQUIRE_INFO_DELTA=true, and never throws.
 *
 * @param {string} generated
 * @param {string} source
 * @param {string} [label] - pipeline tag for the log line
 * @returns {InfoDeltaVerdict}
 */
export function logInformationDelta(generated, source, label = 'post') {
  let verdict;
  try {
    verdict = hasInformationDelta(generated, source, { explain: true });
  } catch (err) {
    return { hasDelta: true, reasoned: false, novelFigure: false, ambiguous: false, novelNumbers: [], markers: [], vocabularyBorrowed: 0, reason: `delta check failed: ${err.message}` };
  }
  const tag = verdict.reasoned ? '✓ reasoned'
    : verdict.ambiguous ? '~ ambiguous figure'
      : '⚠ NO DELTA';
  console.log(`  ▸ Info delta [${label}] ${tag} — ${verdict.reason}`);
  return verdict;
}

/** True when the information-delta signal should hard-reject (default: off). */
export function isInfoDeltaEnforced() {
  return process.env.REQUIRE_INFO_DELTA === 'true';
}

// ─── Telemetry-aware generated_posts insert ──────────────────────────────────
// WHY THIS EXISTS
//
// Every quality lever in this codebase is sampled per generation: the post SHAPE,
// the DERIVATION MODE, and (through the Gemini → OpenRouter → Groq chain) the
// writer MODEL. None of them was recorded, which means a feed that improved looks
// identical in the database to one that degraded — you cannot attribute a change
// in quality to the thing that changed.
//
// This matters right now, concretely: `hasInformationDelta()` is in shadow mode
// and the decision to enforce it needs a pass-rate measured on Gemini sliced by
// shape and mode. Without these columns there is nothing to measure, so the gate
// can only ever be flipped on faith — which is exactly how the `one_liner` shape
// (target [80,200] against a 280 floor) got shipped as a guaranteed-failure slot.
//
// FOLLOWS THE ESTABLISHED DRIFT PATTERN: if the migration has not been applied,
// the insert is retried without the new columns rather than failing the post.
// Persisting telemetry must never be the reason a post is lost.

/** Columns added by migration_generated_posts_telemetry.sql. */
const TELEMETRY_COLUMNS = ['model_used', 'shape_used', 'derivation_used'];

/**
 * Insert a row into generated_posts, carrying generation telemetry.
 *
 * @param {object} supabase - Supabase client
 * @param {object} row      - the row to insert (must include `id`)
 * @param {object} [gen]    - generation metadata from the LLM result
 * @param {?string} [gen.model]      - which tier wrote it
 * @param {?string} [gen.shape]      - POST_SHAPES id
 * @param {?string} [gen.derivation] - DERIVATION_MODES id
 * @returns {Promise<{ok: boolean, error?: string, telemetryDropped?: boolean}>}
 */
export async function insertGeneratedPost(supabase, row, gen = {}) {
  const payload = { ...row };
  if (gen.model) payload.model_used = String(gen.model).slice(0, 60);
  if (gen.shape) payload.shape_used = String(gen.shape).slice(0, 40);
  if (gen.derivation) payload.derivation_used = String(gen.derivation).slice(0, 40);

  let { error } = await supabase.from('generated_posts').insert(payload);

  // Pre-migration fallback: drop the telemetry columns and retry, so the post is
  // still recorded. Matches the error_message / character_count pattern.
  let telemetryDropped = false;
  if (error && TELEMETRY_COLUMNS.some((c) => payload[c] !== undefined) &&
      /column.*does not exist|could not find the .* column|schema cache/i.test(error.message)) {
    telemetryDropped = true;
    for (const c of TELEMETRY_COLUMNS) delete payload[c];
    ({ error } = await supabase.from('generated_posts').insert(payload));
  }

  if (error) return { ok: false, error: error.message, telemetryDropped };
  if (telemetryDropped) {
    console.warn('  ⚠ Saved without telemetry — run migration_generated_posts_telemetry.sql to enable quality attribution');
  }
  return { ok: true, telemetryDropped };
}

// ─── Fix Stale Model Names ────────────────────────────────────────────────────
// MiMo LLM is trained on older data, so it sometimes generates outdated model
// names (GPT-4o, Llama 2, Claude 3, Gemini 1.5, etc.). This post-processing
// filter replaces stale names with the latest ones as of Jul 2026.
// Update this map when new models are released.

const MODEL_REPLACEMENTS = [
  // OpenAI
  [/\bGPT-5\.6 Sol\b/gi, 'GPT-5.6 Sol'],           // already correct, normalize case
  [/\bGPT-5\.6\b(?! Sol\b)/gi, 'GPT-5.6 Sol'],
  [/\bGPT-5\b(?!\.\d)/gi, 'GPT-5.6 Sol'],
  [/\bGPT-4o\b(?!\.\d)/gi, 'GPT-5.6 Sol'],
  [/\bGPT-4[- ]?Turbo\b/gi, 'GPT-5.6 Sol'],
  [/\bGPT-4\b(?!\.\d)/gi, 'GPT-5.6 Sol'],
  [/\bGPT-3\.5\b(?!\.\d)/gi, 'GPT-5.6 Sol'],
  [/\bChatGPT-4\b/gi, 'GPT-5.6 Sol'],
  // Anthropic
  [/\bClaude Opus 5\b/gi, 'Claude Opus 5'],         // already correct
  [/\bClaude 4\b/gi, 'Claude Opus 5'],
  [/\bClaude 3\.5\b(?!\.\d)/gi, 'Claude Opus 5'],
  [/\bClaude 3\b(?!\.\d)/gi, 'Claude Opus 5'],
  [/\bClaude 2\b/gi, 'Claude Opus 5'],
  [/\bClaude Sonnet\b/gi, 'Claude Opus 5'],
  // Google
  [/\bGemini 3\.6 Flash\b/gi, 'Gemini 3.6 Flash'],  // already correct
  [/\bGemini 3\.6\b(?! Flash\b)/gi, 'Gemini 3.6 Flash'],
  [/\bGemini 3\b(?!\.\d)/gi, 'Gemini 3.6 Flash'],
  [/\bGemini 2\b(?!\.\d)/gi, 'Gemini 3.6 Flash'],
  [/\bGemini 1\.5\b(?!\.\d)/gi, 'Gemini 3.6 Flash'],
  [/\bGemini Pro\b/gi, 'Gemini 3.6 Flash'],
  [/\bGemini Ultra\b/gi, 'Gemini 3.6 Flash'],
  // Meta
  [/\bLlama 4\b/gi, 'Llama 4'],                     // already correct
  [/\bLlama 3\.3\b(?!\.\d)/gi, 'Llama 4'],
  [/\bLlama 3\.2\b(?!\.\d)/gi, 'Llama 4'],
  [/\bLlama 3\.1\b(?!\.\d)/gi, 'Llama 4'],
  [/\bLlama 3\b(?!\.\d)/gi, 'Llama 4'],
  [/\bLlama 2\b(?!\.\d)/gi, 'Llama 4'],
  [/\bLLaMA[- ]?3\b(?!\.\d)/gi, 'Llama 4'],
  [/\bLLaMA[- ]?2\b(?!\.\d)/gi, 'Llama 4'],
  // Mistral
  [/\bMistral Large 3\b/gi, 'Mistral Large 3'],     // already correct
  [/\bMistral Large 2\b/gi, 'Mistral Large 3'],
  [/\bMistral Large\b(?! ?\d)/gi, 'Mistral Large 3'],
  [/\bMixtral\b/gi, 'Mistral Large 3'],
  // Others
  [/\bDeepSeek[- ]?R1\b/gi, 'DeepSeek-R1'],         // keep as-is, still relevant
  [/\bDeepSeek[- ]?V3\b/gi, 'DeepSeek-V3'],
  [/\bQwen[- ]?2\.5\b/gi, 'Qwen 2.5'],              // keep
];

/**
 * Replace stale LLM model names with latest ones.
 *
 * ⚠️ HALLUCINATION RISK: blind find-replace here INJECTS specific model names
 * (e.g. "GPT-5.6 Sol", "Claude Opus 5") into every post. If any target name is
 * wrong or not yet released, the system manufactures a false claim on a live,
 * monetized account — exactly what X Creator Rewards flags as low-quality/spam.
 * A wrong specific name is worse than the model's own source-grounded wording.
 *
 * Therefore the name-rewriting is DISABLED by default and only runs when
 * ENABLE_MODEL_NAME_REWRITE=true AND MODEL_REPLACEMENTS has been verified against
 * currently-released models. The always-on part is the safe year bump only.
 *
 * @param {string} text
 * @returns {string}
 */
export function fixStaleModelNames(text) {
  if (!text) return text;
  let result = text;

  // Opt-in only — keep off unless the replacement map is known-accurate.
  if (process.env.ENABLE_MODEL_NAME_REWRITE === 'true') {
    for (const [pattern, replacement] of MODEL_REPLACEMENTS) {
      result = result.replace(pattern, replacement);
    }
  }

  // Always-safe: bump a stale future-year reference (e.g. "ready for 2025?" in 2026+).
  const currentYear = new Date().getFullYear();
  result = result.replace(/\b(ready for|coming in|dropping in|launching in|arriving in)\s+(?:202[0-5])\b/gi, `$1 ${currentYear}`);
  return result;
}

// ─── Template-Placeholder Detector ───────────────────────────────────────────
// v8 published this, THREE times, on a live account:
//     [Punchy closing reaction, bold take, or debate question to drive.
// It is the literal placeholder from the prompt template. `isMetaTextCaption()`
// could not catch it because that detector anchors on `^word` shapes and this
// starts with `[`. Same class of bug let
//     drop your [saas / github project / ai agent / portfolio] below 👇
// go live with the brackets intact.
//
// This rejects unfilled template scaffolding — bracketed/braced runs that read
// like instructions rather than content.

const PLACEHOLDER_KEYWORDS = 'hook|body|cta|emoji|context|closing|reaction|debate|question|insert|placeholder|optional|target|tone|style|angle|take|punchy|magnetic|bold|your|e\\.g\\.|example|or a similar|vary|pick one';
const TEMPLATE_PLACEHOLDER_RE = [
  new RegExp(`\\[[^\\]]*\\b(${PLACEHOLDER_KEYWORDS})\\b[^\\]]*\\]`, 'i'),
  new RegExp(`\\{[^}]*\\b(${PLACEHOLDER_KEYWORDS})\\b[^}]*\\}`, 'i'),
  new RegExp(`<[^>]*\\b(${PLACEHOLDER_KEYWORDS})\\b[^>]*>`, 'i'),
  // A post that is ONLY a bracketed fragment
  /^\s*\[[^\]]{3,}\]\s*[.!?]?\s*$/,
  // Known literal leak shapes seen live
  /\[\s*(saas|github project|ai agent|portfolio|1-line|magnetic|punchy)/i,
  /\bdrop your\s*\[/i,
];

/**
 * Detect unfilled template scaffolding (placeholders) in generated text.
 * @param {string} text
 * @returns {boolean} true if the text contains placeholder scaffolding
 */
export function isPlaceholderText(text) {
  if (!text) return false;
  const t = String(text).trim();
  if (!t) return false;
  if (TEMPLATE_PLACEHOLDER_RE.some(re => re.test(t))) return true;
  // A post cut off inside an open bracket is a half-filled template.
  if (t.endsWith('[') || t.endsWith('{')) return true;
  return false;
}

// ─── Off-Topic / Content-Policy Gate (final text) ────────────────────────────
// `isOffTopic()` in seed_and_post.js only inspected the SOURCE TITLE, and only in
// v3. That is why these went live on an "AI engineering" account:
//   "Is the absolute silence in the Atlantic a sign of a broken climate consensus?"
//   "Trump refusing a slowdown cements what builders already knew"
//   "The pay gap between political leaders is wilder than you think."
// This gate runs on the FINAL generated text and is shared by every pipeline.
//
// Scope note: AI *policy and regulation* commentary is legitimate and valuable for
// this account. What is filtered here is PARTISAN politics, named politicians,
// elections, speculative finance, pro sports and disaster/tragedy framing — none
// of which fit the brand or belong on a monetised technical account.

const OFF_TOPIC_CONTENT_PATTERNS = [
  // Partisan politics, named politicians, elections & legislature
  /\b(trump|biden|harris|desantis|maga|gop|democrats?|republicans?)\b/i,
  /\b(election|ballot|voters?|voting|polling|congress|senate|parliament|white house|prime minister)\b/i,
  /\b(partisan|political leaders?|political party|political spectrum)\b/i,
  /\b(immigration policy|border wall|abortion|gun control)\b/i,
  // Climate & energy as a political/ideological subject.
  // Deliberately narrow: "the climate cost of training models" is legitimate
  // on-brand engineering commentary, while "climate consensus" / "climate
  // deniers" is ideological framing that does not belong here.
  /\b(climate (change|consensus|crisis|deniers?|activists?|policy|accord|treaty))\b/i,
  /\b(global warming|net zero|carbon tax|green new deal|emissions target)\b/i,
  // Geopolitics / conflict
  /\b(war in |invasion of|missile strike|ceasefire|genocide|refugee crisis)\b/i,
  // Speculative finance
  /\b(bitcoin|ethereum|crypto(currency)?|altcoin|memecoin|nft|airdrop|token sale)\b/i,
  // Pro sports
  /\b(nfl|nba|fifa|premier league|super bowl|world cup|olympic)\b/i,
  // Disaster / tragedy framing
  /\b(hurricane|earthquake|wildfire|tsunami|mass shooting|death toll|fatalities)\b/i,
];

/**
 * Detect content that is off-brand / off-topic for a technical AI account.
 * @param {string} text
 * @returns {boolean} true if the text should be rejected
 */
export function isOffTopicContent(text) {
  if (!text) return false;
  return OFF_TOPIC_CONTENT_PATTERNS.some(re => re.test(text));
}

// ─── Ends-Cleanly Check (reusable) ───────────────────────────────────────────
// Extracted from cleanTweetText so the POST-TRIM finalizer can re-run it on the
// exact string that will be published.

const DANGLING_END_RE = /\b(a|an|the|and|but|or|of|to|it|is|are|was|were|in|on|for|with|as|at|by|this|that|these|those|most|more|just|their|your|our|my|his|her|its|looks|seemed|seems|feels|felt|appears|sounds|turns|becomes|makes|gets|gives|shows|wants|needs|tries|starts|continues|being|been|will|would|can|could|should|than|then|when|while|from|into|about|over|under|between|during|after|before|its|it's|that's|they're|we're|don't|doesn't|isn't|can't|won't)$/i;

/**
 * Decide whether text ends as a finished thought rather than a cut-off fragment.
 * Tolerant of legitimate bullet-list endings, strict about dangling words.
 * @param {string} text
 * @returns {boolean}
 */
export function endsCleanly(text) {
  if (!text) return false;
  const t = String(text).trim();
  if (t.length < 25) return false;
  const last = t.slice(-1);
  if ([',', '-', '(', '[', '{', ':', ';', '&', '/'].includes(last)) return false;
  if (/[.!?…"')\]•]$/.test(t)) return true;
  // Ends on a bare word — fine unless it is a dangling connector/verb.
  return !DANGLING_END_RE.test(t);
}

// ─── Template-artifact guard ────────────────────────────────────────────────
// The repo_spotlight prompt used to MANDATE a rigid blueprint ("it's called
// [ToolName]." … "result: [outcome]"). The model obeyed, and every post shipped
// with: the tool name repeated twice, a broken sentence ("...prompts.chat. is a
// massive..."), a leftover "result:" label, and a meaningless "Built with HTML"
// flex. These are defects of the template, not the writer — so the template was
// rewritten AND these are now hard blocks, or a future prompt edit will
// reintroduce them silently.

const TEMPLATE_ARTIFACT_RULES = [
  {
    re: /(^|\n)\s*result\s*:/i,
    why: 'template label leak ("result:")',
  },
  {
    re: /it'?s called\b[^.\n]{0,80}\.\s+(is|are|was|were|has|have)\s/i,
    why: 'broken sentence after a forced "it\'s called X." template line',
  },
  {
    re: /built with html\b/i,
    why: 'meaningless tech-stack flex ("built with HTML")',
  },
  {
    re: /(?:^|\n)[ \t]*→[ \t][^\n]*(?:\n[ \t]*→[ \t][^\n]*){2,}/,
    why: 'README-style arrow feature dump (3+ bullets)',
  },
  {
    re: /[.!?]\s+(is|are|was|were)\s+[a-z]/,
    why: 'sentence starting in lowercase after a full stop',
  },
];

/**
 * True when the post shows structural debris from a rigid generation template.
 * @param {string} text
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function checkTemplateArtifacts(text) {
  const t = String(text || '');
  for (const rule of TEMPLATE_ARTIFACT_RULES) {
    if (rule.re.test(t)) {
      return { ok: false, reason: rule.why };
    }
  }
  return { ok: true };
}

// ─── Finalizer: the single gate every post must pass before it is saved ──────
// THE BUG THIS EXISTS TO PREVENT
// Quality guards used to run on the GENERATED text, and then `bufferClient.js`
// silently re-cut that text to 450 chars at publish time. The pipeline therefore
// validated one string and published a different, shorter one — so ~12% of live
// posts lost their ending and their CTA while the DB stored the intact version.
//
// finalizePostText() is now the LAST step before save: it trims to the safe cap
// first, then re-runs the full guard chain on that exact string. Whatever it
// returns is byte-for-byte what gets published.

/**
 * @typedef {object} FinalizeResult
 * @property {boolean} ok
 * @property {?string} text  - the publishable text (null when rejected)
 * @property {?string} reason - why it was rejected
 */

/**
 * Trim a generated post to the safe cap and re-validate the result.
 * @param {string} text - raw generated text
 * @param {object} [opts]
 * @param {string} [opts.sourceText] - source post text, for the originality gate
 * @param {string} [opts.label='post'] - label used in log lines
 * @param {number} [opts.minChars] - minimum acceptable length
 * @param {boolean} [opts.checkOriginality=true]
 * @returns {FinalizeResult}
 */
export function finalizePostText(text, opts = {}) {
  const { sourceText = '', label = 'post', checkOriginality = true } = opts;
  // Default floor comes from tweetLimits.js (MIN_TWEET_CHARS), not a literal —
  // callers that legitimately need shorter text (thread tweets, replies, v8
  // magnets) pass an explicit minChars override.
  const minChars = opts.minChars ?? MIN_TWEET_CHARS;

  if (!text || !String(text).trim()) return { ok: false, text: null, reason: 'empty' };
  let t = String(text).trim();

  // 1. Trim FIRST — everything below inspects the string that actually ships.
  if (t.length > X_SAFE_MAX_CHARS) {
    const before = t.length;
    t = smartTrimToTarget(t, X_SAFE_MAX_CHARS);
    console.log(`  ✂ Finalized trim ${before} → ${t.length} chars (safe cap ${X_SAFE_MAX_CHARS})`);
  }

  // 2. Re-run the full guard chain on the trimmed text.
  //    Order is deliberate. "Must never ship" checks run before "quality" checks,
  //    because the rejection reason is what an operator sees in the logs:
  //      a) structural garbage — placeholders, prompt leaks
  //      b) brand policy       — off-topic / off-brand
  //      c) quality            — length, language, slop, attribution, truncation
  //    The leaked v8 placeholder post was only 131 chars, so a length-first
  //    order would have logged a useless "too short" instead of naming the bug.
  if (isMetaTextCaption(t)) return { ok: false, text: null, reason: 'meta-text / prompt leak' };
  if (isPlaceholderText(t)) return { ok: false, text: null, reason: 'unfilled template placeholder' };
  const artifact = checkTemplateArtifacts(t);
  if (!artifact.ok) return { ok: false, text: null, reason: `template artifact: ${artifact.reason}` };
  if (isOffTopicContent(t)) return { ok: false, text: null, reason: 'off-topic / off-brand' };
  // Factual-integrity violation, so it belongs in the "must never ship" group
  // rather than the quality group — and it runs before the length check so a
  // short fabricated post reports its real cause instead of a misleading
  // "too short".
  if (hasBorrowedAuthority(t)) return { ok: false, text: null, reason: 'cites evidence from a source that was not provided (fabricated authority)' };
  if (hasFabricatedExperience(t)) return { ok: false, text: null, reason: 'claims first-hand observation or testing the pipeline never performed' };
  if (t.length < minChars) return { ok: false, text: null, reason: `too short (${t.length} < ${minChars})` };
  if (!isLikelyEnglish(t)) return { ok: false, text: null, reason: 'not English' };
  if (isGenericAIText(t)) return { ok: false, text: null, reason: 'generic AI slop' };
  if (isSecondOrderAISlop(t)) return { ok: false, text: null, reason: 'second-order AI structural slop' };
  if (hasFalseAttribution(t)) return { ok: false, text: null, reason: 'false first-person attribution' };
  if (!endsCleanly(t)) return { ok: false, text: null, reason: 'ends mid-thought (truncated)' };
  if (checkOriginality && sourceText && isTooSimilarToSource(t, sourceText)) {
    return { ok: false, text: null, reason: 'too similar to source' };
  }

  // 3. Information-delta signal — SHADOW MODE by default.
  //    This is the axis that actually determines monetization eligibility, and it
  //    is invisible to every similarity metric (see the note above
  //    `hasInformationDelta`). It logs on every post so the real pass rate can be
  //    measured against live output. It only rejects when REQUIRE_INFO_DELTA=true,
  //    because shipping an unmeasured gate is how the paraphrase gate ended up
  //    rejecting ~1% of posts and accomplishing nothing.
  let delta = null;
  if (checkOriginality && sourceText) {
    delta = logInformationDelta(t, sourceText, label);
    if (isInfoDeltaEnforced() && !delta.hasDelta) {
      return { ok: false, text: null, reason: `no information delta (${delta.reason})`, delta };
    }
  }

  return { ok: true, text: t, reason: null, delta };
}

/**
 * Convenience wrapper: finalize, log the rejection reason, and return the text or null.
 * @param {string} text
 * @param {object} [opts] - see finalizePostText
 * @returns {?string}
 */
export function finalizeOrReject(text, opts = {}) {
  const res = finalizePostText(text, opts);
  if (!res.ok) {
    console.warn(`  ⚠ Finalize rejected ${opts.label || 'post'}: ${res.reason}`);
    return null;
  }
  return res.text;
}

/**
 * The shared "must never ship" floor for REPLY text (v7).
 *
 * WHY THIS EXISTS (Sep 15, 2026) — validator drift.
 * There were three independent validators that should all enforce the same
 * factual-integrity floor:
 *   1. finalizePostText()            — the feed pipelines
 *   2. cleanReplyText() in v7/sniper_reply.js
 *   3. cleanReplyText() in v7/reply_generator.js
 * When the fabricated-authority and fabricated-experience guards were added, they
 * went into (1) only. Both reply validators kept publishing unguarded — and v7's
 * prompt was simultaneously asking the model to "frame it from hands-on builder
 * experience", so it was actively soliciting the exact thing nothing was checking.
 *
 * Copying the guard list into two more places would have fixed today's symptom and
 * guaranteed the next drift. So the floor lives here, once, and all three callers
 * use it. A reply validator that forgets to call this is the only way to regress.
 *
 * Returns the rejection reason, or null when the text is publishable.
 *
 * @param {string} text
 * @param {string} [sourceText]
 * @returns {?string}
 */
export function replyGuardFloor(text, sourceText = '') {
  if (!text) return 'empty';
  if (isMetaTextCaption(text)) return 'meta-text / prompt leak';
  if (isPlaceholderText(text)) return 'unfilled template placeholder';
  if (isOffTopicContent(text)) return 'off-topic / off-brand';
  if (hasBorrowedAuthority(text)) return 'cites evidence from a source that was not provided (fabricated authority)';
  if (hasFabricatedExperience(text)) return 'claims first-hand observation or testing the pipeline never performed';
  if (sourceText && isTooSimilarToSource(text, sourceText)) return 'too similar to source';
  return null;
}

/**
 * Validate an assembled multi-tweet THREAD as a single unit.
 *
 * WHY THIS EXISTS (Sep 15, 2026)
 * The v3 and v4 thread paths called finalizePostText() per tweet with
 * `checkOriginality: false`, under a comment claiming "the thread generator
 * already de-dupes vs source". That comment was FALSE — `parseThread()` in
 * groqClient.js does stripMarkdown/stripMentions/fixStaleModelNames and nothing
 * else. There was no source-similarity check anywhere on the thread path.
 *
 * That left the format MOST prone to summarisation completely unguarded: threads
 * are only generated when a full article body is available, and the prompt used
 * to literally ask the model to "write a 2-3 tweet THREAD summarizing it". Both
 * call sites (cron/seed_and_post.js, cron/v4/seed_and_post.js) are live.
 *
 * Per-tweet checking is the wrong unit: a 250-char fragment of a legitimate
 * thread will not carry the derivation on its own, so judging each tweet for
 * information delta would be noise. The thread is the content unit, so the
 * originality and delta checks run on the JOINED text.
 *
 * Returns { ok: false } when the thread restates its source; both call sites
 * already have a "thread failed → fall back to a single tweet" path, and the
 * single-tweet path IS guarded, so rejecting here degrades safely.
 *
 * @param {string[]} tweets
 * @param {object} [opts]
 * @param {string} [opts.sourceText]
 * @param {string} [opts.label]
 * @returns {{ok: boolean, tweets: string[], reason: ?string, delta: ?InfoDeltaVerdict}}
 */
export function finalizeThread(tweets, opts = {}) {
  const { sourceText = '', label = 'thread' } = opts;
  if (!Array.isArray(tweets) || tweets.length < 2) {
    return { ok: false, tweets: [], reason: 'thread needs at least 2 tweets', delta: null };
  }

  const joined = tweets.join('\n\n');

  // 1. The whole thread must not restate its source.
  if (sourceText && isTooSimilarToSource(joined, sourceText)) {
    return { ok: false, tweets: [], reason: 'thread is too similar to its source', delta: null };
  }

  // 2. Information-delta signal on the joined text — shadow mode, same as posts.
  let delta = null;
  if (sourceText) {
    delta = logInformationDelta(joined, sourceText, label);
    if (isInfoDeltaEnforced() && !delta.hasDelta) {
      return { ok: false, tweets: [], reason: `no information delta (${delta.reason})`, delta };
    }
  }

  return { ok: true, tweets, reason: null, delta };
}
