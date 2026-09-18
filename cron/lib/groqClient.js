/**
 * X-Automation LLM orchestrator — image analysis + tweet generation fallback chain.
 *
 * Generation fallback chain (Sep 2026):
 *   1. Gemini (gemini-3.1-flash-lite → gemini-3.5-flash → gemini-3.8-flash)  ← PRIMARY
 *   2. OpenRouter (gemma-4-31b-it:free chain)                                 ← SECONDARY
 *   3. Groq (qwen3.8-27b, with or without image)                             ← TERTIARY
 *   4. Skip post (zero raw-title policy — X Original Content Rewards Sept 2026)
 *
 * The Gemini model order is evidence-based and was re-probed at PRODUCTION SIZE
 * on Sep 16, 2026 — a 30-second timeout on a model tried first is not visible to
 * a small probe prompt. See DEFAULT_GEMINI_MODELS in ./geminiClient.js.
 *
 * ── MODEL IDS ARE VERIFIED AGAINST THE LIVE API, NOT GUESSED ─────────────────
 * The IDs previously hard-coded here were invented and never tested. A live
 * probe of GET /v1/models (Sep 15, 2026) found only 13 models, and two of the
 * three IDs this file depended on DID NOT EXIST:
 *
 *   qwen/qwen3.6-27b          → MISSING. This was GROQ_VISION_MODEL, so the
 *                               entire image-analysis tier was dead: every
 *                               call 404'd and every visual brief fell through.
 *   llama-3.3-70b-versatile   → MISSING. Text fallback + v7 replies, dead.
 *   qwen/qwen3.8-27b          → EXISTS, and is the ONLY vision-capable model
 *                               on the platform (verified: returns "Red" for a
 *                               solid red test image).
 *
 * So `qwen/qwen3.8-27b` now serves BOTH the vision and the primary text role.
 * Verified live: 236 ms, clean 110-char output, no bracket leakage — faster and
 * better than every alternative.
 *
 * Do not add a model ID here without probing it first:
 *   node cron/verify_models.js
 */

import { createKeyManager } from './keyManager.js';
import { stripMarkdown, stripMentions, fixStaleModelNames, isLikelyEnglish, isAIPromptText, isQualityFallbackTitle, isMetaTextCaption, isPlaceholderText, formatPostWhitespace, stripReasoning, isGenericAIText, isTooSimilarToSource, hasFalseAttribution, isOffTopicContent } from './utils.js';
import { smartTrimToTarget, TWEET_TARGET_CHARS, X_SAFE_MAX_CHARS, THREAD_TWEET_TARGET_CHARS, MIN_TWEET_CHARS } from '../tweetLimits.js';
import { callOpenRouter } from './openrouterClient.js';
import { callGemini, isGeminiConfigured } from './geminiClient.js';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * The only vision-capable model in Groq's catalog (verified Sep 15, 2026).
 * Also the fastest and highest-quality text model available, so it doubles as
 * the primary text model.
 */
export const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL?.trim() || 'qwen/qwen3.8-27b';

/**
 * Text-only fallback chain. Config-driven via GROQ_TEXT_MODELS (comma-separated)
 * so churned/404'd model IDs can be swapped without a code change — Groq's free
 * catalog changes model IDs periodically, and it just did.
 *
 * Every ID below was live-probed on Sep 15, 2026:
 *   qwen/qwen3.8-27b   236 ms, best output quality  ← primary
 *   openai/gpt-oss-20b ~1370 ms, works              ← fallback
 *   groq/compound-mini ~2164 ms, works              ← last resort
 *
 * Deliberately EXCLUDED:
 *   openai/gpt-oss-120b  emits EMPTY content at realistic budgets — its
 *                        reasoning tokens consume the allowance (observed:
 *                        max_tokens=800 → 0 chars, finish_reason=length).
 *                        Would need a 2-3k budget to be usable.
 *   allam-2-7b           fast but poor quality, and it emits hashtags, which
 *                        this account's prompt rules forbid.
 *   openai/gpt-oss-safeguard-20b, meta-llama/llama-prompt-guard-*  — classifiers,
 *                        not writers.
 */
export const GROQ_TEXT_MODELS = (process.env.GROQ_TEXT_MODELS && process.env.GROQ_TEXT_MODELS.trim())
  ? process.env.GROQ_TEXT_MODELS.split(',').map(s => s.trim()).filter(Boolean)
  : ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'groq/compound-mini'];

// Minimum acceptable caption length — ensures full Hook + Body + CTA structure
// Under X Premium, at least 160 characters are required; otherwise 100 characters.
// Minimum acceptable caption length. Sourced from tweetLimits.js (single source of
// truth) rather than duplicated here — the two files drifting apart is exactly how
// the 450-char silent truncation bug happened. Raised 160 → 280 on Sep 15, 2026.
const MIN_TWEET_LENGTH = MIN_TWEET_CHARS;

// Token budget for a single post. Was 300/400, which starved the models: 27% of
// live posts came in under 200 chars despite the prompt asking for 250-500, and
// reasoning models burned the whole budget before emitting any content (empty
// `finishReason: MAX_TOKENS` responses). 800 gives real headroom for a 700-char
// teardown plus any internal thinking. See AUDIT_2026-09-15.md §3.
const GENERATION_MAX_TOKENS = Number(process.env.GENERATION_MAX_TOKENS) || 800;

// ─── Groq Key Manager ────────────────────────────────────────────────────────

let groqKeys = null;

export function initGroqKeys() {
  groqKeys = createKeyManager('GROQ', [
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
  ]);
  return groqKeys;
}

export function getGroqKeyStatus() {
  return groqKeys?.getStatus() || null;
}

// ─── Post Shapes ─────────────────────────────────────────────────────────────
// WHY THIS EXISTS (AUDIT_2026-09-15.md §3)
// The previous prompt hard-coded ONE structure: hook line, blank line, 1-2
// sentences, blank line, • bullets, blank line, question. It also said
// "MANDATORY EMPTY LINES" and "Bullet points are encouraged". Measured over 200
// live posts that produced:
//     70% identical 4-part skeleton
//     73% ending in a question
//     53% containing • bullets
//     50% opening with an emoji from a closed set
// That uniformity IS the tell. X's Original Content Rewards penalises templated
// and aggregated output, and human readers pattern-match it instantly.
//
// So: several genuinely different shapes, picked at random per generation, with
// the CTA present in only about half of them. `usesLineBreaks` / `wantsCta` /
// `wantsEmoji` describe the SHAPE, not a global mandate.
//
// LENGTH REBALANCED (Sep 15, 2026) — the account is X Premium, so the platform
// allows 25,000 characters and the working range is 300–1200. The shapes used to
// target 80–700, which is why a third of the queue was failing the length floor
// and the account was shipping 77-char posts. The tiers below now map onto the
// intended spread: ~300 (short), ~500, ~800, ~1150 (long form). Length variety is
// still deliberate — a feed where every post is the same size is its own tell —
// but the FLOOR is now 300, not 80.

export const POST_SHAPES = [
  {
    id: 'hot_take',
    name: 'Single sharp take',
    // One opinionated claim, stated flatly. No list, no question, no build-up.
    instruction:
`Write ONE strong, opinionated architectural claim, stated flatly. 
Do NOT summarize the tool. Instead, explain the structural shift it creates.
3 to 4 sentences of flowing prose. No bullet points. No headings. 
Do NOT end with a question. End on a definitive, high-conviction statement.`,
    targetLen: [300, 520],
    usesLineBreaks: false,
    wantsCta: false,
    wantsEmoji: false,
    weight: 3,
  },
  {
    id: 'field_note',
    name: 'Observation from the field',
    // A concrete, specific observation about what people are actually doing.
    instruction:
`Write a concrete observation about the "implementation gap"—the difference 
between the marketing claim and the production reality. 
3 to 4 sentences. Be specific about the mechanism (e.g. "the latency spike 
at the API gateway"). No bullet points. Do NOT end with a question.`,
    targetLen: [350, 650],
    usesLineBreaks: false,
    wantsCta: false,
    wantsEmoji: false,
    weight: 3,
  },
  {
    id: 'contrarian',
    name: 'Contrarian correction',
    // Challenge the consensus / name the tradeoff nobody mentions.
    instruction:
`Identify the "consensus" view of this tech, then explain why it is 
dangerously incomplete or wrong. 3 to 5 sentences. 
Lead with the disagreement. Do NOT use bullet points. 
End on the strongest, most surprising technical claim.`,
    targetLen: [450, 850],
    usesLineBreaks: false,
    wantsCta: false,
    wantsEmoji: false,
    weight: 2,
  },
  {
    id: 'teardown',
    name: 'Creator analysis',
    // The previous bullet-heavy teardown produced generic checklist posts that
    // read like an AI audit, especially from sparse Reddit material.
    instruction:
`Write a sharp creator analysis: one framing sentence, then two short paragraphs.
Make ONE concrete observation from the source and ONE clearly-labelled personal
interpretation (for example, "My read:"). Do not use bullets, a checklist, or a
"Verdict" label. Do not stack multiple unsupported failure modes into one post.
Separate the framing and paragraphs with single blank lines.`,
    targetLen: [650, 1150],
    usesLineBreaks: true,
    wantsCta: false,
    wantsEmoji: true,
    weight: 2,
  },
  {
    id: 'question',
    name: 'Open question',
    // The ONLY shape that ends on a question.
    instruction:
`Provide 2 to 3 sentences of high-density technical context, then close with 
ONE specific, non-rhetorical question that would make an expert developer 
stop and think. Keep it to 2 short paragraphs separated by one blank line.`,
    targetLen: [300, 520],
    usesLineBreaks: true,
    wantsCta: true,
    wantsEmoji: false,
    weight: 2,
  },
  {
    id: 'punchy',
    name: 'Short sharp statement',
    // The shortest shape. Deliberately at the BOTTOM of the 300–1200 range, not
    // below it: variety in LENGTH matters as much as variety in structure, but a
    // sub-300 post is no longer a shape this account ships.
    instruction:
`Write 2 to 3 blunt, complete sentences. No fluff, no bullets, no line breaks. 
Every word must provide new information. Total roughly 300 characters. 
No question at the end.`,
    targetLen: [300, 420],
    usesLineBreaks: false,
    wantsCta: false,
    wantsEmoji: true,
    weight: 1,
  },
];

/**
 * Pick a post shape at random, weighted. Exported so pipelines/tests can use it.
 * @param {?string} [preferredId]
 * @returns {typeof POST_SHAPES[number]}
 */
export function pickPostShape(preferredId = null) {
  if (preferredId) {
    const found = POST_SHAPES.find(s => s.id === preferredId);
    if (found) return found;
  }
  const pool = [];
  for (const s of POST_SHAPES) for (let i = 0; i < (s.weight || 1); i++) pool.push(s);
  return pool[Math.floor(Math.random() * pool.length)];
}

// ─── Derivation Modes ────────────────────────────────────────────────────────
// WHY THIS EXISTS — measured, not assumed (Sep 15, 2026)
//
// The previous prompt asked the model to "add YOUR OWN angle" while at the same
// time ordering it to "Use ONLY facts, names, numbers, benchmarks, and version
// numbers that appear in the POST below". Those two rules together make a
// derivative post by construction: the opinion is unanchored because there is
// nothing to reason FROM, and the information content is capped at whatever the
// source already said. Different words, same information — which is precisely
// what X's Original Content Rewards calls "minimally modified".
//
// It is also undetectable by text-similarity metrics, which is why two rounds
// of calibration came back empty. Evidence
// (scratch/calibrate_paraphrase.mjs + calibrate2.mjs, 82 real published posts
// scored against their real scraped sources):
//     sentence-trigram overlap   median 0.00, max 0.33  → 1/82 would reject
//     first-sentence vs title    median 0.00            → 3/82 copy the opening (4%)
//     vocabulary borrowed        median 0.15
// The posts are NOT lexically derivative. They are INFORMATIONALLY derivative.
// No similarity gate can fix that, so the fix has to move upstream: change the
// task from "reword and opine" to "compute".
//
// Each mode below is a genuinely different cognitive operation on the source,
// and the mode is chosen to FIT the input — a source carrying numbers gets the
// arithmetic mode, because asking for arithmetic on a numberless source is how
// you get a fabricated statistic.

export const DERIVATION_MODES = [
  {
    id: 'arithmetic',
    name: 'Run the numbers',
    needsNumbers: true,
    weight: 3,
    instruction:
`DO THE ARITHMETIC on the source's own numbers, and SHOW THE INPUTS. Compute a
figure the source never states — a unit cost, a ratio, a growth rate, a
break-even point, a per-user or per-token cost, a scale factor, a time-to-value.
Write the arithmetic out in the post so a reader can check it: the source's
number, the operation, and the result, in one short clause. Showing the inputs is
MANDATORY and it is also your safety net — a live test of this prompt produced
"48 hours is roughly 2,400 minutes", which is wrong (it is 2,880), and the error
was only visible because the input was on the page. Do the multiplication
carefully. The figure you produce must be the source's numbers combined; if you
find yourself reaching for a number that is neither in the source nor derived
from it, stop and use a different angle.`,
  },
  {
    id: 'consequence',
    name: 'Second-order consequence',
    weight: 3,
    instruction:
`NAME THE SECOND-ORDER CONSEQUENCE. The source tells you what changed; you say
what that makes cheap, what it makes obsolete, what it breaks, and who loses.
Stay one step past the obvious implication, because the obvious implication is
the summary and the summary is not a post. Reason only from facts in the
source, but the consequence itself is yours.`,
  },
  {
    id: 'omission',
    name: 'The thing it did not say',
    weight: 3,
    instruction:
`NAME THE OMISSION. Point at the cost, caveat, benchmark condition, licence
term, or failure mode the source conspicuously leaves out. You are auditing the
claim, not restating it. If the source is a release note, the omission is
usually the operating cost or the evaluation setup. If it is a demo, it is the
input that was chosen to make it look good.`,
  },
  {
    id: 'comparison',
    name: 'Against the incumbent',
    weight: 2,
    instruction:
`PLACE IT AGAINST WHAT IT MUST BEAT. Name the thing this replaces or competes
with, then state the one axis where it genuinely wins and the one where it does
not. Your own knowledge of the incumbent is allowed here — but mark it as your
assessment ("my read", "as far as I can tell"), never as a source fact.`,
  },
  {
    id: 'constraint',
    name: 'Where it breaks',
    weight: 2,
    instruction:
`NAME THE BOTTLENECK. Identify the constraint that bites first once this is
used for real — throughput, latency, memory, cost curve, data quality,
maintenance burden, or a dependency that can be pulled out from under it. Be
specific about the threshold at which it bites. The reasoning must come from
the source; the threshold is your judgement and should read like one.`,
  },
  {
    id: 'prediction',
    name: 'Falsifiable call',
    weight: 2,
    instruction:
`MAKE A FALSIFIABLE CALL. State what happens next and by when — something a
reader could come back in three months and score you on. Reason from the facts in
the source, then commit to the call. A prediction is allowed to be wrong; it is
NOT allowed to be supported by invented present-tense data. Do not write
"telemetry shows", "reports indicate", "benchmarks suggest", or a specific
percentage you were not given, in order to make the prediction sound anchored.
If you cannot make the call from the source's facts alone, make a weaker call or
use a different angle. Vague trend-talk ("this changes everything") is the
failure mode on one side; a fabricated statistic is the failure mode on the
other. Land between them.`,
  },
];

/** Count numeric tokens in a blob of text (used to gate the arithmetic mode). */
export function countNumbers(text) {
  if (!text) return 0;
  const m = String(text).match(/\b\d[\d,]*(?:\.\d+)?\b/g);
  return m ? m.length : 0;
}

/**
 * Pick a derivation mode, weighted, fitted to the source.
 * The arithmetic mode is only offered when the source actually carries numbers
 * (>= 2 numeric tokens) — otherwise the model has nothing to compute and would
 * have to invent a figure.
 *
 * @param {string} [sourceText] - the source title + body + visual brief
 * @param {?string} [preferredId]
 * @returns {typeof DERIVATION_MODES[number]}
 */
export function pickDerivationMode(sourceText = '', preferredId = null) {
  if (preferredId) {
    const found = DERIVATION_MODES.find(m => m.id === preferredId);
    if (found) return found;
  }
  const hasNumbers = countNumbers(sourceText) >= 2;
  const pool = [];
  for (const m of DERIVATION_MODES) {
    if (m.needsNumbers && !hasNumbers) continue;
    for (let i = 0; i < (m.weight || 1); i++) pool.push(m);
  }
  if (!pool.length) return DERIVATION_MODES.find(m => m.id === 'consequence');
  return pool[Math.floor(Math.random() * pool.length)];
}

// ─── Build Tweet Prompt ──────────────────────────────────────────────────────
// Exported for testing and for the before/after calibration harness
// (scratch/ab_prompt.mjs) — the derivation mode and post shape are both randomly
// sampled per call, so the only way to measure the prompt's effect is to call it
// directly and score what comes back.

// ── Selection telemetry ──────────────────────────────────────────────────────
// Shape and derivation mode are sampled INSIDE the prompt builder, so the caller
// that actually writes the row has no other way to learn which ones were used.
//
// WHY THIS MATTERS (this is the blocker, not a nice-to-have):
// You cannot answer "did quality improve?" without knowing what changed. The two
// levers currently in play — post shape and derivation mode — are both random per
// call, and until now neither was recorded. So a feed that gets worse looks
// identical to a feed that gets better, and the A/B numbers (reasoned 0%→40%)
// cannot be reproduced against live output.
//
// A module-level variable rather than threading a return value through three
// generation tiers: `buildTweetPrompt` has three call sites across two functions
// and changing its signature would ripple through every tier. Read it immediately
// after the call that used it — the value is per-call, not per-run.
let _lastSelection = { shapeId: null, shapeName: null, derivationId: null };

/** Shape + derivation mode chosen by the most recent `buildTweetPrompt()` call. */
export function getLastPromptSelection() {
  return { ..._lastSelection };
}

/**
 * Attach the prompt selection (shape + derivation mode) to a generation result.
 *
 * Deliberately non-destructive: several tiers already set their own `model`
 * (`groq-vision`, `groq-<name>`, `openrouter`), so those are preserved and only
 * the shape/derivation are added. Overwriting `model` here would make every post
 * look like it came from the same tier — which is the exact blindness this is
 * meant to remove.
 *
 * @param {{text: string, model?: string}} result
 * @returns {{text: string, model?: string, shape?: string, derivation?: string}}
 */
function withSelection(result) {
  if (!result) return result;
  const sel = getLastPromptSelection();
  return {
    ...result,
    shape: result.shape || sel.shapeId || null,
    derivation: result.derivation || sel.derivationId || null,
  };
}

export function buildTweetPrompt(redditPost, isVideo = false, shapeId = null) {
  const today = new Date().toISOString().split('T')[0];
  const shape = pickPostShape(shapeId);

  // The mode is fitted to the source, not to the clock — a source with numbers
  // gets the arithmetic mode, a numberless one gets a reasoning mode.
  const sourceBlob = [redditPost.title, redditPost.selftext, redditPost.visualBrief]
    .filter(Boolean).join(' ');
  const derivation = pickDerivationMode(sourceBlob);

  // Record what we picked, so the pipeline can persist it alongside the post.
  _lastSelection = { shapeId: shape.id, shapeName: shape.name, derivationId: derivation.id };

  console.log(`  ▶ Post shape: ${shape.name} (${shape.id})`);
  console.log(`  ▶ Derivation: ${derivation.name} (${derivation.id}) · source numbers: ${countNumbers(sourceBlob)}`);

  const videoContext = isVideo
    ? '\nThis is a VIDEO/DEMO post. Reference the visual content.'
    : '';

  // Detect source type
  const isHN = redditPost.subreddit === 'HackerNews' || redditPost.source === 'hackernews';
  const isDevTo = redditPost.subreddit === 'Dev.to' || redditPost.source === 'devto';
  const isReddit = !isHN && !isDevTo;

  // Source-specific context
  let sourceContext = '';
  if (isHN) {
    sourceContext = '\nThis is from Hacker News — a tech news site. Use it as a signal for what is happening, then share YOUR own reaction/insight — do not summarize it.';
  } else if (isDevTo) {
    sourceContext = '\nThis is from Dev.to — a developer community. Use it as a signal, then add YOUR own developer perspective — do not summarize the article.';
  } else if (isReddit) {
    sourceContext = '\nThis is a Reddit community submission. Treat its title and image as a lead, not proof of a full architecture review. Make one narrow observation grounded in the supplied details. Any wider conclusion must be labelled as your judgement ("my read", "the risk is"), never stated as an observed fact.';
  }

  const visualContext = redditPost.visualBrief
    ? `\nVISUAL BREAKDOWN (generated from the attached image; use only these observable details):\n${redditPost.visualBrief}`
    : '';

  // Angle prompt — replaces the old "hook formula" that pushed every post into the
  // same "bold claim / provocative question" mould.
  const angles = [
    'Open on the single most concrete detail in the source',
    'Open on what this changes for someone shipping this week',
    'Open on the part of this that most people will get wrong',
    'Open on the tradeoff the announcement conveniently skips',
    'Open on how this compares to what it is replacing',
  ];
  const angle = angles[Math.floor(Math.random() * angles.length)];

  // Emoji lead only when the SHAPE invites it, and only ~45% of those times.
  // Starting every post with an emoji from a fixed set was the #1 automated tell.
  const useEmojiLead = shape.wantsEmoji && Math.random() < 0.45;

  const isPremium = process.env.X_PREMIUM === 'true';
  const [minLen, maxLen] = shape.targetLen;

  const structureRules = isPremium
    ? `POST SHAPE FOR THIS ONE: "${shape.name}"

${shape.instruction}

LENGTH: aim for ${minLen} to ${maxLen} characters.
${shape.usesLineBreaks
  ? 'Line breaks: use them as described above.'
  : 'Line breaks: do NOT use them. This is flowing prose in one block.'}
${shape.wantsCta
  ? 'Close with the question as described.'
  : 'Do NOT end with a question. No "thoughts?", no "what do you think?", no engagement bait.'}
Do NOT reuse the same opening word or rhythm you would default to. Vary sentence length.`
    : `CAPTION STRUCTURE — ${shape.name}:
${shape.instruction}
MAX 240 characters total (hard limit).
${shape.wantsCta ? 'End with the question as described.' : 'Do NOT end with a question.'}`;

  const tweetRules = isPremium
    ? `TWEET RULES:
- Sound like a specific engineer with an opinion, not a press release.
- Do NOT use the word "we" to mean the account owner's team.
- IMPORTANT: If the post title is NOT in English, first TRANSLATE the full meaning into English, then write the tweet. Output must be 100% English.
- NO hashtags, NO markdown headers (#), NO bold (**).
- NEVER include labels like "Hook:", "BODY:", "CTA:", "Shape:", "Tweet:" or any meta commentary — output ONLY the finished tweet text, nothing else.`
    : `TWEET RULES:
- MAX 240 characters (hard limit — MUST fit within X's 280-character limit)
- IMPORTANT: If the post title is NOT in English, first TRANSLATE the full meaning into English, then write the tweet. Output must be 100% English.
- Conversational, like talking to a smart colleague
- NO hashtags, NO markdown
- NO "Thread:" or "1/" prefixes
- NO "Here's a tweet:" or similar prefixes
- NEVER include labels like "Hook:", "BODY:", "CTA:", "Shape:" or notes like "(62 chars)" in your output — output ONLY the finished tweet text, nothing else`;

  return `You are @M_jawad_yasin, a working AI engineer and tech commentator on X.

CURRENT DATE: ${today}

TASK: The post below is a SOURCE SIGNAL — raw material, not a draft. You are not a
reporter summarising it and you are not a fan reacting to it. You are the engineer who
reads it and tells people something they could not have worked out from the source
alone. Output ONLY the post text.

ANGLE FOR THIS ONE: ${angle}

YOUR JOB THIS TIME — ${derivation.name}:
${derivation.instruction}

${structureRules}

${useEmojiLead
  ? `EMOJI: open with exactly ONE emoji that genuinely fits the topic, then a space. Use no other emoji in the post.`
  : `EMOJI: do NOT open with an emoji. Open with a strong word. At most one emoji anywhere, and only if it genuinely fits — a clean text-only post reads more human.`}

WHAT YOU MAY AND MAY NOT CLAIM (this account is monetized and audited):
Four tiers. Know which one you are in.
- STATED — facts that appear in the source. You may use these, but they are the setup,
  never the post. If your post is mostly stated facts, you have written a summary, and
  summaries are not paid for.
- DERIVED — figures you computed from the source's own facts: arithmetic, a ratio, a
  comparison of two numbers it gave you. Encouraged. Must be traceable — a reader with
  the source and a calculator must reach the same answer you did.
- ASSESSED — your judgement, opinion, prediction, or read on the market. Allowed and
  expected. Mark it as yours in the wording ("my read is", "I would bet", "the risk
  here is"). Never dress a judgement up as a fact.
- INVENTED — a fact that is neither in the source nor derivable from it. Never. Do not
  invent statistics, benchmarks, model names, dates, prices, or quotes. If the source
  gives no number, stay qualitative rather than manufacturing one.
- NEVER cite an authority you were not given. No "telemetry shows", "reports indicate",
  "benchmarks show", "studies find", "Anthropic says", "Google says" — unless the POST
  below is literally that source. Borrowing an authority to make a claim sound anchored
  is the fastest way to lose a monetized account.
- NEVER claim to have seen, tested, run, or benchmarked anything. You have not run the
  tool. No "I see teams doing X", "we tested it", "in my experience", "from my
  benchmarks". Judgements are welcome — state them as judgements and let the reasoning
  carry them.

SELF-CHECK BEFORE YOU ANSWER — do this silently, then answer:
1. Point to the one claim in your post that the source does not contain. If you cannot
   point to it, you have not done the task. Rewrite it.
2. Delete any sentence that could appear in the source's own summary.
3. For EVERY number you wrote, write out where it came from. If it is in the source, fine.
   If it is arithmetic on the source's numbers, show it as "source number, operation,
   result" and CHECK THE ARITHMETIC — a wrong calculation is as damaging as an invented
   one. If it is neither, it is invented: cut it.
4. Check that nothing in the post implies a source you were not given.
5. Check that you have not claimed to observe, test, or run anything. You did not.

PERSPECTIVE & ATTRIBUTION (CRITICAL — NEVER impersonate the creator):
- You are an expert industry commentator, engineer, and curator reviewing community releases.
- NEVER claim that YOU built, wrote, coded, or created the tool/model/project yourself.
- NEVER say "I built", "I created", "I made", "I coded", "I released", "My tool", "My project", "My library".
- Always attribute the release objectively or to the creator (e.g. "A developer built...", "New open-source drop: ...", "A tool designed to...").

HUMAN VOICE (write like a real engineer, not a marketing bot):
- BANNED words/phrases — never use: "game-changer", "revolutionize", "unlock/harness/unleash the power", "dive into", "buckle up", "the future of…", "stay tuned", "elevate", "supercharge", "seamless", "cutting-edge", "delve", "leverage", "robust", "transformative", "the possibilities are endless", "mind-blowing", "this isn't just…".
- Be concrete: name the actual tool/number/tradeoff. Specificity is what makes it feel real.
- Contractions are good. A little dry wit is good.

${tweetRules}

POST TO WRITE ABOUT:
Title: ${redditPost.title || 'N/A'}
Source: ${isHN ? 'Hacker News' : isDevTo ? 'Dev.to' : 'r/' + (redditPost.subreddit || 'unknown')}
Upvotes: ${redditPost.upvotes || 0}
Description: ${(redditPost.selftext || '').substring(0, 1000)}${sourceContext}${videoContext}${visualContext}

POST:`;
}

// ─── Clean Up Generated Text ─────────────────────────────────────────────────

export function cleanTweetText(text) {
  if (!text) return null;
  
  // Step 1: Strip reasoning-model chain-of-thought (<think>…</think>, unclosed
  // openers, <reasoning>, etc.) — central, shape-complete stripper in utils.js.
  text = stripReasoning(text);
  if (!text || text.length < 10) return null;

  // Step 1b: Secondary heuristic for TAG-LESS reasoning (model wrote "The user
  // wants…" / "Let me…" as plain prose with no tags). Extract the tweet-like line.
  if (
    text.includes('<think>') ||
    text.includes('thinking process') || 
    text.includes('Thinking Process') ||
    text.startsWith('Here') ||
    text.startsWith('The user') ||
    text.startsWith('This is') ||
    text.startsWith('Let me') ||
    text.startsWith('I need') ||
    text.startsWith('Looking at')
  ) {
    // No closing tag or text after is too short
    // Extract the LAST line that looks like a tweet (20-280 chars, no thinking labels)
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const tweetLines = lines.filter(l => {
      const lower = l.toLowerCase();
      // Skip thinking/reasoning lines
      if (lower.startsWith('<think>') || lower.startsWith('thinking') || lower.startsWith('here')) return false;
      if (lower.startsWith('1.') || lower.startsWith('2.') || lower.startsWith('3.')) return false;
      if (lower.startsWith('*') || lower.startsWith('-') || lower.startsWith('final')) return false;
      if (lower.startsWith('option') || lower.startsWith('note:') || lower.startsWith('output:')) return false;
      if (lower.startsWith('the ') || lower.startsWith('this ') || lower.startsWith('let ')) return false;
      if (lower.startsWith('analysis') || lower.startsWith('request') || lower.startsWith('persona')) return false;
      if (lower.startsWith('task:') || lower.startsWith('rule') || lower.startsWith('step')) return false;
      if (lower.startsWith('process') || lower.startsWith('thinking process')) return false;
      // Must be tweet-like length
      const maxLen = process.env.X_PREMIUM === 'true' ? 25000 : 280;
      return l.length >= 20 && l.length <= maxLen;
    });
    text = tweetLines.pop() || lines[lines.length - 1] || '';
  }
  
  // Step 2: Clean up text & format whitespace
  text = text.replace(/^["']|["']$/g, '');
  text = text.replace(/#[\w]+/g, '');
  text = stripMarkdown(text);
  text = stripMentions(text);
  text = fixStaleModelNames(text);
  text = formatPostWhitespace(text);
  
  // Step 2b: Enforce hard cap (1,200 for Premium, 277 for Free) — smart-trim at paragraph/sentence boundary
  if (text.length > X_SAFE_MAX_CHARS) {
    const before = text.length;
    text = smartTrimToTarget(text, X_SAFE_MAX_CHARS);
    console.log(`  ✂ Trimmed ${before} → ${text.length} chars (hard cap ${X_SAFE_MAX_CHARS})`);
  }

  // Step 3: Validate — must look like a tweet
  if (text.length < 25) {
    return null;  // Too short (truncated/incomplete)
  }

  // Step 3a: Language guard — reject clearly non-English output.
  // Prompts already instruct translation to English; this is a safety net.
  if (!isLikelyEnglish(text)) {
    console.warn('  ⚠ Non-English tweet detected — skipping');
    return null;
  }

  // Step 3b: Check if text is still thinking/reasoning/instructions (not a real tweet)
  const lowerText = text.toLowerCase();
  const garbagePatterns = [
    // Thinking/reasoning patterns
    'thinking process', 'here is', 'the user', 'this is a', 'let me',
    'i need to', 'looking at', 'analysis', 'persona', 'task:',
    'step 1', 'step 2', 'option 1', 'option 2', 'final answer',
    "here's a", 'here s a', 'here is a', 'so the',
    // Instruction/reminder patterns (LLM outputting rules instead of tweet)
    'no hashtags', 'no emojis', 'no markdown', 'no thread',
    'remember,', 'note:', 'output:', 'tweeet:', 'tweet:',
    // Garbage fragments
    'then there', 'by 2028,', 'by 2025,', 'by 2030,',
    'as an ai', 'as a language', 'i cannot', 'i can\'t',
    // Meta-commentary
    'this tweet', 'the tweet', 'my tweet', 'your tweet',
    // PROMPT LEAK PATTERNS (added after live incidents Jul 30 - Aug 27)
    'news/tool', 'post content:', 'hook style:', 'tweet rules:',
    'rewrite rules:', 'comment rules:', 'no prefixes', 'thread rules:',
    'your comment:', 'must start with', 'start the tweet with', 'start with exactly one',
    'emoji rule:', 'pick by intent:', 'caption structure:', 'post to tweet about:',
    // CAPTION LABEL LEAKS (added after live incident Aug 7 — MiMo emitted "Hook: ... (62 chars) - A bit of a stretch")
    'hook:', 'body:', 'cta:', 'hook —', 'caption structure:',
    'a bit of a stretch', 'fits the prediction style', 'fits the style',
    '(62 chars)', '(',  'chars)', 'prediction style', 'stop-scroll',
    'bold claim', 'shocking stat', 'provocative question', 'bold prediction',
    // EMOJI/STYLE SELECTION LEAKS (added Aug 7 — MiMo emitted "Selection: ⚠️ feels more cautionary, 💥 feels more provocative...")
    'selection:', 'the prompt asks',
    // META-INSTRUCTION ECHOES (added after live incident Aug 7 — Groq Vision emitted "Explain the issue: ...")
    'explain the issue:', 'explain the problem:', 'explain:',
    'describe the image:', 'describe:', 'analyze:', 'summarize:', 'rewrite:',
    'visuals:', 'visual brief:', 'image analysis:', 'image description:',
    'shows the', 'displays the',
  ];
  for (const pattern of garbagePatterns) {
    if (lowerText.startsWith(pattern)) {
      console.warn(`  ⚠ Garbage pattern detected: "${pattern}"`);
      return null;
    }
  }

  // Step 3b-1: Structured-label leaks (MiMo emits field labels / numbered
  // reasoning / meta-descriptions instead of a real tweet). Shared detector in
  // utils.js — covers "5. Emoji:", "Intent:", "Emoji Rule:", "Context:",
  // "Image: Shows...", "Post: Title:", "Wait, ..." and friends. Same patterns
  // guard the final Buffer posting paths (postSingleToBuffer/postVideoToBuffer).
  if (isMetaTextCaption(lowerText)) {
    console.warn('  ⚠ Structured label leak detected (numbered/field/meta) — rejecting');
    return null;
  }

  // Step 3b-1b: Unfilled template scaffolding. v8 published the literal prompt
  // placeholder "[Punchy closing reaction, bold take, or debate question to drive."
  // three times because isMetaTextCaption() anchors on `^word` and this starts
  // with `[`. See AUDIT_2026-09-15.md §2.
  if (isPlaceholderText(text)) {
    console.warn('  ⚠ Unfilled template placeholder detected — rejecting');
    return null;
  }

  // Step 3b-0: Authenticity gate — reject generic AI-slop so the pipeline
  // regenerates something human-sounding (X Creator Rewards flags generic hype).
  if (isGenericAIText(text)) {
    console.warn('  ⚠ Generic AI-slop detected — rejecting for regeneration');
    return null;
  }

  // Step 3b-0b: False attribution gate — reject hallucinations claiming the account
  // owner built/created the curated third-party tool ("I built a tool...").
  if (hasFalseAttribution(text)) {
    console.warn('  ⚠ False first-person attribution detected ("I built/created...") — rejecting for regeneration');
    return null;
  }

  // Step 3b-0c: Off-topic / off-brand gate. The old filter only checked the SOURCE
  // TITLE and only ran in v3, which is how a climate-consensus post and a partisan
  // politics post went live on a technical account. See AUDIT_2026-09-15.md §5.
  if (isOffTopicContent(text)) {
    console.warn('  ⚠ Off-topic / off-brand content detected — rejecting');
    return null;
  }

  // Step 3b-2: Check for prompt leak patterns ANYWHERE in text
  const promptLeaks = [
    'news/tool/debate handling',
    'hook style: start with',
    'tweet rules: max 240',
    'rewrite rules: max 240',
    'comment rules: max 240',
    'no prefixes like',
    'just the tweet text, nothing else',
    'just the rewritten tweet, nothing else',
    'just the comment text, nothing else',
    'output only the tweet',
    'must start with exactly one emoji',
    'start the tweet with exactly one',
    'emoji rule —',
    'caption structure —',
    'post to tweet about:',
    // CAPTION-ANNOTATION LEAKS (added Aug 7 — "(60 chars) - Good." and emoji reasoning)
    'chars)', 'is best.', ' - good.', 'the debate aspect',
    'feels more cautionary', 'feels more provocative',
    // STRUCTURED-LABEL ECHOES (added Aug 10 — "7. Content: Translate title if needed",
    // "5. Emoji: ... 🛠️ or 💡 fits best. I'll use 🛠️.", "Intent: ... This is likely about ...")
    'translate title if needed', 'this is likely about', 'fits best', 'no translation needed',
    // NEW SHAPES Aug 25-27 (Groq fallback era + OpenRouter hardening)
    'emoji rule:', 'emoji choice:', 'image analysis:', 'visual brief:', 'visuals:', 'image description:',
  ];
  for (const leak of promptLeaks) {
    if (lowerText.includes(leak)) {
      console.warn(`  ⚠ Prompt leak pattern detected: "${leak}"`);
      return null;
    }
  }
  // Step 3c: Check for incomplete/truncated sentences
  const lastChar = text.slice(-1);
  const endsClean = ['.', '!', '?', '"', "'", '…', '—'].includes(lastChar);
  // Even when ending with punctuation, reject a dangling sentence-completing
  // verb as the final word (live catch Aug 10: "...the "Delete" button looks."
  // — the verb demands an object/complement, so the sentence was cut).
  const danglingVerb = /\b(looks|looked|seems|seemed|feels|felt|appears|appeared|sounds|sounded|turns|turned|becomes|became|makes|made|gets|got|gives|gave|shows|showed|wants|wanted|needs|needed|tries|tried|starts|started|continues|continued)\s*[.!?]$/i;
  if (danglingVerb.test(text)) {
    console.warn(`  ⚠ Dangling verb ending detected ("${text.slice(-30)}") — likely cut mid-sentence`);
    return null;
  }
  if (!endsClean) {
    // Check for common incomplete endings (contractions cut off)
    const truncatedEndings = [
      "they're", "we're", "it's", "that's", "there's",
      "you're", "he's", "she's", "who's", "what's",
      "don't", "doesn't", "didn't", "won't", "can't",
      "isn't", "aren't", "wasn't", "weren't",
      " the", " a", " an", " and", " but", " or",
      " to", " of", " in", " for", " on", " with",
    ];
    const lowerEnd = text.slice(-15).toLowerCase();
    const isTruncated = truncatedEndings.some(e => lowerEnd.endsWith(e));

    if (isTruncated || text.length < 40) {
      console.warn(`  ⚠ Truncated text detected (ends with ${lastChar}, ${text.length} chars)`);
      return null;
    }

    // Try to fix: find last complete sentence
    const lastPeriod = text.lastIndexOf('.');
    const lastExclaim = text.lastIndexOf('!');
    const lastQuestion = text.lastIndexOf('?');
    const lastSentenceEnd = Math.max(lastPeriod, lastExclaim, lastQuestion);

    if (lastSentenceEnd > text.length * 0.5) {
      // Cut at last sentence end if it's at least half the text
      text = text.substring(0, lastSentenceEnd + 1);
    } else {
      // Cut at last space and add period
      const lastSpace = text.lastIndexOf(' ');
      if (lastSpace > 50) text = text.substring(0, lastSpace) + '.';
      else return null; // Too short to fix
    }
  }

  return text;
}

// ─── Call Groq API ───────────────────────────────────────────────────────────

async function callGroq(messages, maxTokens = 300, model = GROQ_VISION_MODEL) {
  if (!groqKeys || groqKeys.totalKeys === 0) {
    throw new Error('No Groq keys configured');
  }

  const result = await groqKeys.execute(async (apiKey) => {
    const res = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.8,
        max_tokens: maxTokens,  // Limit output to prevent long thinking
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => 'Unknown error');
      throw new Error(`Groq HTTP ${res.status} [${model}]: ${errorText}`);
    }

    return await res.json();
  });

  // Groq qwen3 models are reasoning models — strip chain-of-thought before use.
  const content = stripReasoning(result?.choices?.[0]?.message?.content || '').trim();
  return content || null;
}

// ─── Generate Tweet with Vision (image + text) ──────────────────────────────

export async function generateTweetWithVision(redditPost, isVideo = false) {
  const prompt = buildTweetPrompt(redditPost, isVideo);
  const imageUrl = redditPost.imageUrl;
  // Source text for the originality gate. MUST be declared here: this closure
  // previously referenced `sourceText` from an outer scope that did not exist,
  // so every call threw ReferenceError, the surrounding try/catch swallowed it,
  // and the Groq Vision + Groq text fallback tiers were 100% dead in production.
  const sourceText = [redditPost?.title, redditPost?.selftext].filter(Boolean).join(' ');
  const isOriginal = (c) => {
    if (!c || c.length < MIN_TWEET_LENGTH) return false;
    if (process.env.X_PREMIUM === 'true' && !c.includes('\n')) return false;
    if (sourceText && isTooSimilarToSource(c, sourceText)) return false;
    return true;
  };

  try {
    // 1. Try with image first (vision mode with qwen3.8-27b — the only
    //    vision-capable model in Groq's catalog)
    if (imageUrl) {
      const messages = [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }];

      const text = await callGroq(messages, GENERATION_MAX_TOKENS, GROQ_VISION_MODEL);
      const cleaned = cleanTweetText(text);
      if (isOriginal(cleaned)) return { text: cleaned, model: 'groq-vision' };
    }

    // 2. Fallback: text-only with active Groq models (qwen3.8-27b, compound-mini)
    const textOnlyMessages = [{
      role: 'user',
      content: prompt
    }];

    for (const textModel of GROQ_TEXT_MODELS) {
      try {
        const text = await callGroq(textOnlyMessages, GENERATION_MAX_TOKENS, textModel);
        const cleaned = cleanTweetText(text);
        if (isOriginal(cleaned)) {
          return { text: cleaned, model: `groq-${textModel.split('/').pop()}` };
        }
      } catch (mErr) {
        console.warn(`  ⚠ Groq text model ${textModel} failed: ${mErr.message}`);
      }
    }

  } catch (err) {
    console.warn(`  ⚠ Groq fallback chain failed: ${err.message}`);
  }

  return null;
}

/**
 * Turn an image-only Reddit post into a short factual brief before MiMo writes
 * the tweet. This avoids asking a text-only model to guess what the image shows.
 */
export async function generateImageBrief(redditPost) {
  if (!redditPost.imageUrl) return null;

  const prompt = `Analyze this image for a social post. Return ONLY a compact factual brief (max 450 characters).
Describe the product, UI, chart, code, tool, or result that is visibly shown. Do not invent names, claims, or numbers that are not visible.

Post title: ${redditPost.title || 'N/A'}
Post description: ${(redditPost.selftext || '').substring(0, 400) || 'No description supplied.'}`;

  try {
    const text = await callGroq([{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: redditPost.imageUrl } },
      ],
    }], 220);

    const raw = text || '';
    const stripped = stripReasoning(raw);
    const brief = stripped.replace(/\s+/g, ' ').trim();
    if (!brief || brief.length < 20) return null;
    return brief.substring(0, 450);
  } catch (err) {
    console.warn(`  ⚠ Groq image brief failed: ${err.message}`);
    return null;
  }
}

// ─── Generate Tweet with OpenRouter (PRIMARY — replaces MiMo, Aug 25 2026) ───

async function generateWithOpenRouter(llmKeys, redditPost, isVideo = false) {
  if (!llmKeys || llmKeys.totalKeys === 0) return null;

  // Source text used to reject near-copies (X Original Content Rewards: a
  // reworded scrape is "minimally modified" = ineligible). Force a fresh,
  // original take when the output just mirrors the source.
  const sourceText = [redditPost?.title, redditPost?.selftext].filter(Boolean).join(' ');

  const validator = (raw) => {
    const cleaned = cleanTweetText(raw);
    if (!cleaned || cleaned.length < MIN_TWEET_LENGTH) return null;
    if (process.env.X_PREMIUM === 'true' && !cleaned.includes('\n')) {
      console.warn('  ⚠ Single-line flat text without scannable line break rejected for X Premium');
      return null;
    }
    if (sourceText && isTooSimilarToSource(cleaned, sourceText)) {
      console.warn('  ⚠ Output too similar to source (minimal reword) — rejecting for original regeneration');
      return null;
    }
    return cleaned;
  };

  // Retry loop: buildTweetPrompt picks a RANDOM hook on every call, so a second
  // attempt with a fresh prompt often yields a usable tweet when the first one
  // comes back empty, leaked meta-text, or too thin (< MIN_TWEET_LENGTH).
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = buildTweetPrompt(redditPost, isVideo);
    try {
      const cleaned = await callOpenRouter(llmKeys, {
        prompt,
        temperature: 0.9,
        maxTokens: GENERATION_MAX_TOKENS,
        validator,
      });
      if (cleaned && cleaned.length >= MIN_TWEET_LENGTH) return { text: cleaned, model: 'openrouter' };
      console.warn(`  ⚠ OpenRouter attempt ${attempt}: unusable output — retrying`);
    } catch (err) {
      console.warn(`  ⚠ OpenRouter attempt ${attempt} failed: ${err.message}`);
    }
  }

  return null;
}

// ─── Generate Tweet with Fallback Chain ─────────────────────────────────────
// Order: Gemini → OpenRouter → Groq Vision → Groq Text → Skip

export async function generateTweetWithFallback(redditPost, llmKeys, isVideo = false) {
  // Image posts need visual facts before text-only models write — always analyze
  // images with Groq Vision first so all downstream models have visual context.
  let enrichedPost = redditPost;
  if (redditPost.imageUrl) {
    console.log('  ▶ Analyzing image with Groq Vision...');
    const visualBrief = await generateImageBrief(redditPost);
    if (visualBrief) {
      enrichedPost = { ...redditPost, visualBrief };
      console.log(`  ✓ Vision brief: ${visualBrief.substring(0, 100)}...`);
    }
  }

  const sourceText = [enrichedPost?.title, enrichedPost?.selftext].filter(Boolean).join(' ');
  const validator = (raw) => {
    const cleaned = cleanTweetText(raw);
    if (!cleaned || cleaned.length < MIN_TWEET_LENGTH) return null;
    if (process.env.X_PREMIUM === 'true' && !cleaned.includes('\n')) {
      console.warn('  ⚠ Gemini single-line flat text without scannable line break rejected for X Premium');
      return null;
    }
    if (sourceText && isTooSimilarToSource(cleaned, sourceText)) {
      console.warn('  ⚠ Gemini output too similar to source — rejecting');
      return null;
    }
    return cleaned;
  };

  // 1. Try Gemini FIRST (primary writer — fastest, highest quality Sep 2026)
  if (isGeminiConfigured()) {
    console.log('  ▶ Trying Gemini (primary writer)...');
    for (let attempt = 1; attempt <= 2; attempt++) {
      const prompt = buildTweetPrompt(enrichedPost, isVideo);
      try {
        const geminiRaw = await callGemini(prompt, { temperature: 0.9, maxTokens: GENERATION_MAX_TOKENS });
        if (geminiRaw) {
          const validated = validator(geminiRaw);
          if (validated && validated.length >= MIN_TWEET_LENGTH) {
            console.log(`  ✓ Gemini responded (attempt ${attempt})`);
            return withSelection({ text: validated, model: 'gemini' });
          }
        }
        console.warn(`  ⚠ Gemini attempt ${attempt}: unusable output — retrying`);
      } catch (err) {
        console.warn(`  ⚠ Gemini attempt ${attempt} failed: ${err.message}`);
      }
    }
  }

  // 2. Try OpenRouter SECOND (secondary writer — free model chain)
  const openRouterResult = await generateWithOpenRouter(llmKeys, enrichedPost, isVideo);
  if (openRouterResult) return withSelection(openRouterResult);

  // 3. Fallback to Groq Vision (tertiary — also sees images)
  const groqResult = await generateTweetWithVision(redditPost, isVideo);
  if (groqResult) return withSelection(groqResult);

  // 4. Under X Original Content Rewards (Sept 2026), raw scraped titles are strictly
  // ineligible and risk account demonetization/penalties. Never post raw titles.
  console.warn('  ⚠ All LLM generation attempts failed — skipping post (zero raw-title policy)');
  return null;
}

// ─── Generate Thread from Article ─────────────────────────────────────────────
// Used for HN/Dev.to fallback when full article content is available
// Generates 2-3 tweet thread summarizing the article

export async function generateThreadFromArticle(post, llmKeys) {
  if (!post.selftext || post.selftext.length < 100) {
    // Not enough content for thread, use single tweet
    return null;
  }

  const today = new Date().toISOString().split('T')[0];
  const articleExcerpt = post.selftext.substring(0, 2500);
  
  const prompt = `You are @M_jawad_yasin, an AI Engineering expert on X (Twitter) with 50K+ followers.

CURRENT DATE: ${today}

TASK: Read this article and write a 2-3 tweet THREAD that adds analysis the article
does not contain. You are NOT summarising it. A thread that restates the article is
worth nothing — X only pays for original content, and a summary is the definition of
derivative.

ARTICLE TITLE: ${post.title}
SOURCE: ${post.subreddit || 'Unknown'}
UPVOTES: ${post.upvotes || 0}

ARTICLE CONTENT:
${articleExcerpt}

THREAD RULES — this structure is the job, not a suggestion:
- Tweet 1: THE DERIVED CLAIM. The figure or implication the article never states.
  Do the arithmetic on the article's own numbers if it has any (a unit cost, a ratio,
  a break-even, a scale factor), and show the working in one short clause so a reader
  can check it. If the article has no numbers, lead with the second-order consequence
  instead: what this makes cheap, obsolete, or broken.
- Tweet 2: THE MECHANISM OR THE CONSTRAINT. Why the claim above holds — or the
  bottleneck that will bite first, stated with the threshold at which it bites.
- Tweet 3: THE CALL OR THE OMISSION. Either a dated, falsifiable prediction, or the
  cost / caveat / benchmark condition the article conspicuously left out.
- Write EXACTLY 2-3 tweets, separated by blank lines
- Each tweet: MAX 250 characters

WHAT YOU MAY AND MAY NOT CLAIM:
- Facts from the article: usable, but they are setup, never the payload.
- Figures computed from the article's own numbers: encouraged, must be traceable.
- Your judgement or prediction: allowed, but mark it as yours ("my read", "I would bet").
- Invented statistics, benchmarks, model names, dates, or quotes: NEVER.

SELF-CHECK BEFORE YOU ANSWER: point to the one claim in the thread that the article
does not contain. If you cannot point to it, you wrote a summary. Rewrite it.

- Be CONVERSATIONAL, like talking to a friend
- Make it DEBATABLE — people should want to reply
- NO hashtags, NO emojis, NO markdown
- NO "Thread:" or "1/" prefixes
- NO "Tweet 1:" labels — just the text separated by blank lines

THREAD:`;

  const parseThread = (text, modelName) => {
    let cleaned = text.replace(/^["']|["']$/g, '');
    cleaned = cleaned.replace(/#[\w]+/g, '');
    cleaned = stripMarkdown(cleaned);
    cleaned = stripMentions(cleaned);
    cleaned = fixStaleModelNames(cleaned);
    cleaned = cleaned.trim();

    // Split into individual tweets (smart-trim each to the 240-char target)
    const tweets = cleaned.split(/\n\n+/)
      .map(t => smartTrimToTarget(t.trim(), THREAD_TWEET_TARGET_CHARS))
      .filter(t => t.length > 10 && t.length <= 280)
      .slice(0, 3);

    if (tweets.length >= 2) {
      console.log(`  ✓ Generated ${tweets.length}-tweet thread (${modelName})`);
      return { tweets, model: modelName };
    }
    return null;
  };

  try {
    // 1. Primary: Gemini
    if (isGeminiConfigured()) {
      try {
        const text = await callGemini(prompt, { temperature: 0.8, maxTokens: 800, timeoutMs: 30000 });
        if (text) {
          const res = parseThread(text, 'gemini-thread');
          if (res) return res;
        }
      } catch (err) {
        console.warn(`  ⚠ Gemini thread generation failed: ${err.message}`);
      }
    }

    // 2. Secondary: OpenRouter model chain
    if (llmKeys && llmKeys.totalKeys > 0) {
      const text = await callOpenRouter(llmKeys, { prompt, temperature: 0.8, maxTokens: 500, timeoutMs: 45000 });
      if (text) {
        const res = parseThread(text, 'openrouter-thread');
        if (res) return res;
      }
    }
  } catch (err) {
    console.warn(`  ⚠ Thread generation failed: ${err.message}`);
  }

  return null;
}
