/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   v8 VIRAL CONVERSATION MAGNET GENERATOR                         ║
 * ║   cron/v8/viral_magnet_generator.js                              ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Generates short, high-reply viral thought posts across         ║
 * ║   weighted archetypes to trigger algorithmic depth (replies).    ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * ── WHAT WAS WRONG (fixed Sep 15, 2026) ──────────────────────────────────────
 *
 * 1. LITERAL TEMPLATE TEXT WAS PUBLISHED LIVE.
 *    Every archetype prompt contained a fill-in-the-blank *example* as if it
 *    were the spec, e.g. `drop your [saas / github project / ai agent /
 *    portfolio] below 👇`. Language models treat a bracketed list inside an
 *    instruction as a slot to copy, not as an illustration to avoid. That exact
 *    string went out on the live account 3 times. The prompts now describe the
 *    SHAPE of a post in prose and never contain a copyable output sample.
 *
 * 2. THE SAME POST WAS REGENERATED EVERY DAY.
 *    `getArchetypeByHour()` returned a hard-coded archetype per UTC hour bucket
 *    and each archetype had ONE fixed topic, so the 12:00 and 21:00 runs
 *    produced near-identical text day after day. Archetypes now carry weighted
 *    topic seeds and angle lists that are sampled per run, and selection
 *    excludes the archetypes used in the most recent runs.
 *
 * 3. NO SELF-DEDUP.
 *    Nothing compared a new magnet against what was already published, so a
 *    repeat could only be caught by a human reading the timeline. The generator
 *    now accepts `recentTexts` / `recentArchetypes` and retries on collision.
 *
 * See AUDIT_2026-09-15.md §2.
 */

import { callOpenRouter } from '../lib/openrouterClient.js';
import { callGemini, isGeminiConfigured, getLastGeminiModel } from '../lib/geminiClient.js';
import { callOllama, isOllamaConfigured, getLastOllamaModel } from '../lib/ollamaClient.js';
import {
  stripMarkdown,
  stripMentions,
  fixStaleModelNames,
  isLikelyEnglish,
  isMetaTextCaption,
  stripReasoning,
  isGenericAIText,
  isPlaceholderText,
  isOffTopicContent,
  endsCleanly,
  hasFalseAttribution,
} from '../lib/utils.js';

// ─── Length envelope for a reply-magnet post ─────────────────────────────────
// These are deliberately SHORT: the whole point of v8 is a post that is cheap to
// read and easy to answer. This is why publish_magnet.js passes minChars: 80 to
// the finalizer instead of the 160-char default used by the long-form pipelines.
export const MAGNET_MIN_CHARS = 70;
export const MAGNET_MAX_CHARS = 420;

// ─── Hard rules appended to every prompt ─────────────────────────────────────
// This block exists specifically to prevent the failure modes seen live. The
// bracketed-characters ban is the direct fix for the published placeholder text.
const HARD_RULES = `
ABSOLUTE RULES — if you break any of these the post is discarded:
- Output ONLY the finished post text. No preamble, no headings, no labels, no quotation marks around it.
- NEVER use square brackets, curly braces or angle brackets. Not once. Never write a fill-in-the-blank slot. Every word must be final copy.
- NEVER write instruction vocabulary: hook, CTA, body, closing, angle, tone, style, placeholder, insert.
- No hashtags. At most one emoji, and only if it genuinely adds something.
- Plain natural English. No markdown, no bold, no asterisk bullets.
- Never state or imply that you are an AI, a model, or that this text was generated.
- Never invent statistics, studies, or quoted numbers.`;

// ─── Topic seeds & angles ────────────────────────────────────────────────────
// Sampling one seed + one angle per run is what makes two runs of the same
// archetype produce different posts. Add freely; the picker is random.

const SEEDS = {
  vibe_coding_irony: [
    'an autonomous coding agent that confidently rewrote a file nobody asked it to touch',
    'vibe-coding a side project all the way to production in a single weekend',
    'the moment an AI code reviewer approves a bug that it introduced itself',
    'running four agents in parallel and losing track of which one broke the build',
    'context windows and how much of your architecture the model quietly forgets',
    'AI autocomplete suggesting a deprecated API with total confidence',
    'a refactor that only existed because the AI generated the original mess',
    'debugging code that no human on the team actually remembers writing',
    'the token bill from an agent loop that never converges',
    'shipping on a Friday with an AI-generated migration nobody reviewed',
    'being paged at 3am for an incident caused by a hallucinated dependency',
    'running local models on consumer hardware to escape a cloud bill',
    'the pull request that is 4,000 lines long and titled "minor cleanup"',
    'spending 45 minutes prompt engineering an agent to fix a bug you could have solved in 30 seconds',
    'when an AI code review bot writes three paragraphs about variable naming but misses a critical race condition',
    'paying $250 a month in LLM tokens just to build a CRUD app with 4 users',
    'migrating a simple modular monolith into 14 microservices and spending the sprint debugging network latency',
  ],
  dev_identity_crisis: [
    'writing code, finding bugs, fixing bugs, reviewing pull requests and writing the tests',
    'planning the sprint, scaffolding the service, wiring the pipeline and writing the postmortem',
    'reading the docs, writing the migration, updating the schema and shipping the release',
    'drafting the design doc, generating the boilerplate, refactoring the module and closing the ticket',
    'triaging the alert, writing the hotfix, cutting the release and apologising in the channel',
  ],
  generational_shift: [
    'how people searched for an answer to a technical problem',
    'how people learned a brand new framework',
    'how people deployed a server for the first time',
    'how people debugged something they did not understand',
    'how people memorised syntax before an interview',
    'how people wrote documentation nobody wanted to write',
    'how people hired their first engineer',
    'how people kept and found their own notes',
    'how people started a company with almost no money',
  ],
  community_roast_magnet: [
    'developers shipping their first SaaS product',
    'people building AI agents and MCP servers',
    'open-source maintainers whose repo nobody has starred yet',
    'indie hackers with a landing page and no users',
    'engineers building developer tools and browser extensions',
    'people building local-first and self-hosted apps',
    'solo founders who just launched and heard nothing back',
  ],
  contrarian_builder_truth: [
    'follower counts versus actual paying customers',
    'launch day hype versus the quiet weeks that follow it',
    'chasing one viral thread versus replying to ten real people',
    'building in public for an audience that will never buy anything',
    'growth hacks versus talking to users one at a time',
    'waiting for a bigger audience before shipping anything at all',
    'collecting tools instead of finishing one project',
  ],
};

const ANGLES = {
  vibe_coding_irony: [
    'the fix-one-break-two loop: you patch a bug, two new ones appear, and the first one comes back',
    'the gap between how fast it writes code and how slow it is to actually be correct',
    'confidence is the real bug — the output looks right and is not',
    'the job now feels like managing a brilliant intern with no memory and no fear',
    'you spend longer reviewing the output than you would have spent writing it',
    'it removed the typing and left you with all the thinking, which was the hard part',
  ],
  community_roast_magnet: [
    'you will use their product as a real user for five minutes and name the single reason you would leave',
    'you will read their architecture and give them one fix that actually matters',
    'you will find the one sentence on their landing page that is costing them signups',
    'you will tell them the one thing to cut from their product this week',
    'you will give them the first three things a stranger notices about their product',
  ],
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ─── Prompt builders ─────────────────────────────────────────────────────────
// Each builder receives a sampled seed (and angle where relevant) and returns a
// prompt that describes the SHAPE of the post in prose. No copyable sample text.

const BUILDERS = {
  vibe_coding_irony: (seed, angle) => `You are @M_jawad_yasin, an AI engineer and founder posting on X.

Write ONE short post about this specific situation: ${seed}.

Angle to take: ${angle}.

Shape — three beats:
1. An opening line of two to seven words. It must be a claim or a blunt statement, not a topic label. Do not open with the word "AI".
2. One or two lines that land the irony using a concrete, specific detail. Specific beats abstract every time.
3. Turn it to the reader with a short question they can answer from their own experience.

Target length: 140-320 characters. Do not explain the joke.
${HARD_RULES}`,

  dev_identity_crisis: (seed) => `You are @M_jawad_yasin, a senior AI engineer posting on X.

Write ONE short post built as a descending list of five to six short lines.

Each line must begin with the word "AI", followed by a verb and an object, all lowercase, with no punctuation at the end of the line. Use these engineering activities as your material: ${seed}.

Vary the verbs so the list builds momentum instead of repeating one sentence pattern. Every line must describe a real, specific engineering task — no filler and no vague abstractions.

After the list, leave one blank line, then write a single short lowercase question of no more than eight words asking what is actually left for the engineer to do.

Target length: 130-300 characters.
${HARD_RULES}`,

  generational_shift: (seed) => `You are @M_jawad_yasin, an AI builder posting on X.

Write ONE short post as a three-beat progression about ${seed}.

Beat 1: one lowercase line that begins with the words "our parents" and describes the old way people did this.
Beat 2: one lowercase line that begins with the word "we" and describes how builders do it now, with AI.
Then leave one blank line.
Beat 3: a short lowercase question of under ten words asking what the next generation will do instead.

Write the real habit in each line. Do not use the words "old method" or "current method".
Target length: 90-220 characters.
${HARD_RULES}`,

  community_roast_magnet: (seed, angle) => `You are @M_jawad_yasin, an AI engineer and builder posting on X.

Write ONE short post inviting ${seed} to share what they are working on, so that you can give them genuinely useful feedback.

What you will do for them: ${angle}.

Shape: an opening line that invites them in, written entirely in your own words. Then one blank line. Then one or two lines stating exactly what you will do for them and how quickly. Be concrete and generous — name the specific thing you will look at.

Write the invitation yourself. Do not produce a menu of options for the reader to pick from, do not use a pointing-hand emoji, and do not list categories.
Target length: 120-300 characters. Zero sales pitch, no links.
${HARD_RULES}`,

  contrarian_builder_truth: (seed) => `You are @M_jawad_yasin, a technical founder posting on X.

Write ONE short post that is a blunt reality check for early builders, about ${seed}.

Shape — three beats:
1. An opening line that sets a condition: it names a specific number and a specific expectation that people wrongly hold. Phrase it as a condition the reader either meets or does not.
2. Two or three short lines of hard truth about why distribution and real conversations beat vanity metrics.
3. A closing maxim under twelve words that people would want to quote.

Target length: 150-330 characters. No motivational fluff.
${HARD_RULES}`,
};

// ─── Archetype registry ──────────────────────────────────────────────────────
// `weight`      — relative selection frequency.
// `preferredHours` — UTC hour buckets where this archetype performs best. This
//                    is a MULTIPLIER, not a hard pin: the old code returned a
//                    fixed archetype per hour, which is why the same post
//                    reappeared every day at the same time.
export const ARCHETYPES = [
  {
    id: 'vibe_coding_irony',
    name: 'Vibe Coding & Dev Reality Irony',
    weight: 1.4,
    preferredHours: [12, 13, 14, 16, 17, 18, 19, 21, 22, 23, 0, 1, 2],
    build: (seed, angle) => BUILDERS.vibe_coding_irony(seed, angle),
  },
  {
    id: 'dev_identity_crisis',
    name: 'Dev Identity Crisis Provocation',
    weight: 1.2,
    preferredHours: [16, 17, 18, 19, 12, 13],
    build: (seed) => BUILDERS.dev_identity_crisis(seed),
  },
  {
    id: 'generational_shift',
    name: 'Generational Shift (3-Liner)',
    weight: 1.1,
    preferredHours: [21, 22, 23, 0, 1, 2],
    build: (seed) => BUILDERS.generational_shift(seed),
  },
  {
    id: 'community_roast_magnet',
    name: 'Drop Your Project / Feedback Magnet',
    // Lowest weight on purpose: this is the archetype that leaked placeholder
    // text, and an invite post repeated too often reads as engagement-bait.
    weight: 0.9,
    preferredHours: [16, 17, 18, 19, 12, 13],
    build: (seed, angle) => BUILDERS.community_roast_magnet(seed, angle),
  },
  {
    id: 'contrarian_builder_truth',
    name: 'Contrarian Truth for Builders',
    weight: 1.1,
    preferredHours: [12, 13, 14, 16, 17, 18],
    build: (seed) => BUILDERS.contrarian_builder_truth(seed),
  },
];

/**
 * Build a concrete prompt for an archetype by sampling fresh topic material.
 * @param {object} archetype
 * @returns {{prompt: string, seed: string, angle: ?string}}
 */
export function buildArchetypePrompt(archetype) {
  const seed = pick(SEEDS[archetype.id] || ['software engineering with AI']);
  const angleList = ANGLES[archetype.id];
  const angle = angleList ? pick(angleList) : null;
  return { prompt: archetype.build(seed, angle), seed, angle };
}

/**
 * Weighted archetype selection, biased toward the current hour and away from
 * archetypes used in the immediately preceding runs.
 *
 * @param {object} [opts]
 * @param {?string} [opts.preferredId]      - honoured only if not recently used
 * @param {string[]} [opts.recentArchetypes] - most-recent-first list of used ids
 * @param {number} [opts.hourUtc]
 * @returns {object} archetype
 */
export function pickArchetype({ preferredId = null, recentArchetypes = [], hourUtc = new Date().getUTCHours() } = {}) {
  // Avoid a repeat until at least 3 other archetypes have run.
  const recent = new Set(recentArchetypes.slice(0, 3));

  if (preferredId) {
    const wanted = ARCHETYPES.find((a) => a.id === preferredId);
    if (wanted && !recent.has(wanted.id)) return wanted;
  }

  let candidates = ARCHETYPES.filter((a) => !recent.has(a.id));
  // If every archetype was used recently, fall back to the least-recent one.
  if (candidates.length === 0) {
    const last = recentArchetypes[0];
    candidates = ARCHETYPES.filter((a) => a.id !== last);
    if (candidates.length === 0) candidates = ARCHETYPES;
  }

  const pool = [];
  for (const a of candidates) {
    let w = a.weight || 1;
    if (a.preferredHours?.includes(hourUtc)) w *= 2.5; // bias, never pin
    for (let i = 0; i < Math.round(w * 10); i++) pool.push(a);
  }
  return pool[Math.floor(Math.random() * pool.length)] || candidates[0];
}

// ─── Self-dedup ──────────────────────────────────────────────────────────────
// Deliberately implemented locally rather than reusing `isTooSimilarToSource`:
// that helper reads ORIGINALITY_TRIGRAM_MAX / ORIGINALITY_VERBATIM_MAX from the
// environment, which are tuned for "generated vs. scraped source" comparisons.
// Dedup between two posts of the SAME archetype needs a tighter, fixed
// threshold, because shared structural phrasing ("our parents …", "AI writes …")
// is expected and must NOT count as a duplicate.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that',
  'these', 'those', 'you', 'your', 'we', 'our', 'they', 'their', 'i', 'my', 'me',
  'as', 'at', 'by', 'from', 'into', 'about', 'so', 'than', 'then', 'when', 'while',
  'do', 'does', 'did', 'can', 'will', 'would', 'not', 'no', 'all', 'just', 'now',
  'what', 'who', 'how', 'why', 'still', 'more', 'most', 'up', 'out', 'one', 'get',
]);

function contentWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));
}

function trigrams(words) {
  const set = new Set();
  for (let i = 0; i + 2 < words.length; i++) set.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return set;
}

function longestRun(a, b) {
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return best;
}

/**
 * Compare a candidate post against already-published posts.
 * @param {string} text
 * @param {string[]} recentTexts
 * @param {object} [opts]
 * @param {number} [opts.trigramThreshold=0.55] - share of the candidate's content
 *        trigrams that must also appear in a previous post to call it a duplicate
 * @param {number} [opts.verbatimRunWords=7]    - consecutive identical content words
 * @returns {?string} the offending previous post, or null when the candidate is novel
 */
export function findDuplicate(text, recentTexts = [], opts = {}) {
  const trigramThreshold = opts.trigramThreshold ?? 0.55;
  const verbatimRunWords = opts.verbatimRunWords ?? 7;
  const words = contentWords(text);
  if (words.length < 6) return null;
  const grams = trigrams(words);

  for (const prev of recentTexts) {
    if (!prev) continue;
    const prevWords = contentWords(prev);
    if (prevWords.length < 6) continue;

    if (longestRun(words, prevWords) >= verbatimRunWords) return prev;

    if (grams.size < 3) continue;
    const prevGrams = trigrams(prevWords);
    let shared = 0;
    for (const g of grams) if (prevGrams.has(g)) shared++;
    if (shared / grams.size >= trigramThreshold) return prev;
  }
  return null;
}

// ─── Cleaning / validation ───────────────────────────────────────────────────

function cleanMagnetText(raw) {
  if (!raw) return null;

  // 1. Strip reasoning-model chain-of-thought (tags + unclosed openers) FIRST.
  let text = stripReasoning(raw);
  if (!text) return null;

  // 2. Standard sanitization.
  text = stripMarkdown(text);
  text = stripMentions(text);
  text = fixStaleModelNames(text);
  text = text.replace(/^["']|["']$/g, '');
  text = text.replace(/#[\w]+/g, ''); // no hashtags
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  if (text.length < MAGNET_MIN_CHARS || text.length > MAGNET_MAX_CHARS) {
    console.warn(`  ⚠ v8 magnet rejected — length ${text.length} outside ${MAGNET_MIN_CHARS}-${MAGNET_MAX_CHARS}`);
    return null;
  }
  if (!isLikelyEnglish(text)) {
    console.warn('  ⚠ v8 magnet rejected — not English');
    return null;
  }

  // 3. Final leak guard — reject any tag-less reasoning / prompt-label leak that
  //    survived (parity with groqClient.cleanTweetText + bufferClient posting).
  if (isMetaTextCaption(text)) {
    console.warn('  ⚠ v8 magnet rejected — meta-text / reasoning leak detected');
    return null;
  }

  // 4. THE placeholder guard — this is the one that stops literal template
  //    scaffolding ("drop your [saas / github project ...] below") from shipping.
  if (isPlaceholderText(text)) {
    console.warn('  ⚠ v8 magnet rejected — unfilled template placeholder detected');
    return null;
  }

  // 5. Authenticity gate — reject generic AI-slop (X Creator Rewards flags it).
  if (isGenericAIText(text)) {
    console.warn('  ⚠ v8 magnet rejected — generic AI-slop, regenerating');
    return null;
  }

  // 6. Brand gate — no politics / crypto / sports / disaster framing.
  if (isOffTopicContent(text)) {
    console.warn('  ⚠ v8 magnet rejected — off-topic / off-brand');
    return null;
  }

  // 7. Truncation gate — a magnet that ends mid-sentence kills the reply ask.
  if (!endsCleanly(text)) {
    console.warn('  ⚠ v8 magnet rejected — ends mid-thought');
    return null;
  }

  // 8. First-person fabrication gate.
  if (hasFalseAttribution(text)) {
    console.warn('  ⚠ v8 magnet rejected — false first-person attribution');
    return null;
  }

  return text;
}

// ─── Provider tiers ──────────────────────────────────────────────────────────

/**
 * Ask one provider tier for a completion. Returns raw text or null.
 * @returns {Promise<?string>}
 */
async function callOpenRouterTier(openRouterKeys, prompt, temperature) {
  if (!openRouterKeys) return null;
  try {
    return await callOpenRouter(openRouterKeys, {
      prompt,
      temperature,
      maxTokens: 600,
    });
  } catch (err) {
    console.warn(`  ⚠ OpenRouter viral generation failed: ${err.message}`);
    return null;
  }
}

async function callGroqTier(groqKeys, prompt, temperature) {
  if (!groqKeys) return null;
  // Live-verified against GET /v1/models on Sep 15, 2026. The previous default
  // list contained two IDs that do not exist (`llama-3.3-70b-versatile`,
  // `qwen/qwen3.6-27b`), so this tier silently 404'd on every call.
  // Do not add an ID here without probing it: node cron/verify_models.js
  const groqModels = (process.env.GROQ_TEXT_MODELS && process.env.GROQ_TEXT_MODELS.trim())
    ? process.env.GROQ_TEXT_MODELS.split(',').map((s) => s.trim()).filter(Boolean)
    : ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'groq/compound-mini'];

  for (const model of groqModels) {
    try {
      const result = await groqKeys.execute(async (apiKey) => {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature,
            max_tokens: 600,
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
        return res.json();
      });
      const raw = result?.choices?.[0]?.message?.content;
      if (raw) {
        console.log(`  ✓ Groq [${model}] responded`);
        return raw;
      }
    } catch (err) {
      console.warn(`  ⚠ Groq model ${model} failed: ${err.message}`);
    }
  }
  return null;
}

async function callOrcaRouterTier(prompt, temperature) {
  const orcaKey = process.env.ORCAROUTER_API_KEY;
  if (!orcaKey) return null;
  try {
    console.log('  ▶ Trying OrcaRouter fallback for viral magnet...');
    const res = await fetch('https://api.orcarouter.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${orcaKey}`,
      },
      body: JSON.stringify({
        model: 'z-ai/glm-5.3-flash-free',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1200,
        temperature,
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.warn(`  ⚠ OrcaRouter fallback failed: ${err.message}`);
    return null;
  }
}

/**
 * Generate a viral conversation magnet post.
 *
 * Retries across archetypes when a candidate is rejected by the quality gates or
 * collides with a recently published post, so a single bad sample never costs
 * the run.
 *
 * @param {object} openRouterKeys - KeyManager for OpenRouter
 * @param {object} groqKeys       - KeyManager from initGroqKeys()
 * @param {object|string|null} [options] - options object, or (legacy) an archetype id
 * @param {string} [options.preferredArchetypeId]
 * @param {string[]} [options.recentTexts]       - recently published v8 post texts
 * @param {string[]} [options.recentArchetypes]  - most-recent-first archetype ids
 * @param {number} [options.maxAttempts=3]
 * @returns {Promise<?{text: string, archetype: string, seed: string, attempts: number}>}
 */
export async function generateViralMagnet(openRouterKeys, groqKeys, options = {}) {
  // Back-compat: the third argument used to be a bare archetype id string.
  const opts = (typeof options === 'string' || options === null)
    ? { preferredArchetypeId: options }
    : (options || {});

  let {
    preferredArchetypeId = null,
    recentTexts = [],
    recentArchetypes = [],
    maxAttempts = 3,
  } = opts;

  const triedArchetypes = [];
  let lastRejection = 'no output';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const archetype = pickArchetype({
      preferredId: attempt === 1 ? preferredArchetypeId : null,
      // Never try the same archetype twice in one run.
      recentArchetypes: [...triedArchetypes, ...recentArchetypes],
    });
    triedArchetypes.push(archetype.id);

    const { prompt, seed } = buildArchetypePrompt(archetype);
    console.log(`\n  🎯 Attempt ${attempt}/${maxAttempts} — Archetype: "${archetype.name}" (${archetype.id})`);
    console.log(`     Seed: ${seed}`);

    const temperature = 0.9;

    // 0. Ollama Cloud — PRIMARY writer (gemma4:31b).
    //    Fastest & cheapest; highest originality score because it is not
    //    shared with any other posting pipeline.
    let raw = null;
    let model = null;
    if (isOllamaConfigured()) {
      try {
        raw = await callOllama(prompt, { temperature, model: process.env.OLLAMA_MODEL || 'gemma4:31b' });
        if (raw) {
          model = `ollama:${getLastOllamaModel()}`;
          console.log(`  ✓ Ollama Cloud [${getLastOllamaModel()}] responded (primary)`);
        }
      } catch (err) {
        console.warn(`  ⚠ Ollama Cloud viral generation failed: ${err.message}`);
      }
    }

    // 1. Gemini (secondary). Generous budget — the primary model returns empty
    //    content when its budget is small (see geminiClient MODEL_MIN_TOKENS).
    if (!raw && isGeminiConfigured()) {
      try {
        raw = await callGemini(prompt, { temperature, maxTokens: 900 });
        if (raw) {
          model = `gemini:${getLastGeminiModel()}`;
          console.log(`  ✓ Gemini [${getLastGeminiModel()}] responded (secondary)`);
        }
      } catch (err) {
        console.warn(`  ⚠ Gemini viral generation failed: ${err.message}`);
      }
    }

    // 2. OpenRouter (tertiary)
    if (!raw) {
      raw = await callOpenRouterTier(openRouterKeys, prompt, temperature);
      if (raw) model = 'openrouter';
    }

    // 3. Groq (quaternary) — model IDs are config-driven via GROQ_TEXT_MODELS so a
    //    churned/404'd model can be swapped without a code change.
    if (!raw) {
      raw = await callGroqTier(groqKeys, prompt, temperature);
      if (raw) model = 'groq';
    }

    // 4. OrcaRouter (last resort)
    if (!raw) {
      raw = await callOrcaRouterTier(prompt, temperature);
      if (raw) model = 'orcarouter';
    }

    if (!raw) {
      lastRejection = 'all providers returned nothing';
      console.warn(`  ⚠ Attempt ${attempt}: ${lastRejection}`);
      continue;
    }

    const cleaned = cleanMagnetText(raw);
    if (!cleaned) {
      lastRejection = 'failed quality gates';
      continue;
    }

    const duplicateOf = findDuplicate(cleaned, recentTexts);
    if (duplicateOf) {
      lastRejection = 'too similar to a recent post';
      console.warn(`  ⚠ Attempt ${attempt}: duplicate of a recent post — regenerating`);
      console.warn(`     previous: "${duplicateOf.substring(0, 90)}..."`);
      // Feed the collision back in so the next attempt must beat it too.
      recentTexts = [...recentTexts, cleaned];
      continue;
    }

    console.log(`  ✓ Accepted magnet (${cleaned.length} chars, archetype ${archetype.id})`);
    // `model` tells you which tier actually wrote it — without it, a silent
    // fall-through to a weaker provider is indistinguishable from a good post.
    return { text: cleaned, archetype: archetype.id, seed, attempts: attempt, model };
  }

  console.error(`  ❌ Viral magnet generation failed after ${maxAttempts} attempts (${lastRejection})`);
  return null;
}
