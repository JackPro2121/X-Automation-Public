/**
 * Shared utilities for all cron pipelines.
 * Dedup, ID generation, shuffle, env validation.
 */

import { DEDUP_WINDOW_HOURS } from './constants.js';

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
const AI_SLOP_HARD = [
  'game-changer', 'game changer', 'gamechanger', 'revolutionize', 'revolutionise',
  'in today\'s fast-paced', 'in the ever-evolving', 'ever-evolving landscape',
  'unlock the power', 'unleash the power', 'harness the power', 'the power of',
  'dive into the world', 'let\'s dive in', 'buckle up', 'the possibilities are endless',
  'the future is here', 'the future of', 'stay tuned', 'we can\'t wait to see',
  'take it to the next level', 'elevate your', 'supercharge your', 'seamless integration',
  'in conclusion', 'without further ado', 'look no further', 'say goodbye to',
  'welcome to the future', 'a new era', 'the holy grail', 'this is huge', 'mind-blowing',
  'it\'s not just', 'this isn\'t just', 'more than just a', 'a testament to',
];

// Softer signals — need 2+ combined to reject (any one alone is tolerable).
const AI_SLOP_SOFT = [
  'delve', 'delving', 'leverage', 'leveraging', 'robust', 'cutting-edge', 'cutting edge',
  'transformative', 'paradigm', 'synergy', 'empower', 'empowering', 'streamline',
  'ecosystem', 'landscape', 'realm', 'tapestry', 'testament', 'pivotal', 'crucial',
  'unprecedented', 'groundbreaking', 'innovative solution', 'exciting', 'thrilled',
  'excited to share', 'imagine a world', 'what if i told you', 'let that sink in',
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
