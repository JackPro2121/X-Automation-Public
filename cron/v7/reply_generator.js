/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║   v7 AI REPLY GENERATOR (OpenRouter + Groq Fallback)         ║
 * ║   cron/v7/reply_generator.js                                 ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║   Generates high-signal replies for:                         ║
 * ║   - Inbound: Responses to comments on @M_jawad_yasin posts    ║
 * ║   - Outbound: Value-add comments on top AI creators' posts   ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

import { callOpenRouter } from '../lib/openrouterClient.js';
import { callGemini, isGeminiConfigured } from '../lib/geminiClient.js';
// GROQ_TEXT_MODELS is the single source of truth for Groq model IDs, live-probed
// against GET /v1/models. The ID previously hard-coded here
// (`llama-3.3-70b-versatile`) no longer exists on the platform, so this entire
// Groq fallback tier was dead. Do not hard-code a Groq model ID — import it.
import { GROQ_TEXT_MODELS } from '../lib/groqClient.js';
import { stripMarkdown, stripMentions, fixStaleModelNames, isLikelyEnglish, stripReasoning, replyGuardFloor } from '../lib/utils.js';
import { smartTrimToTarget } from '../tweetLimits.js';

/** Fastest verified Groq model — replies are latency-sensitive. */
const GROQ_REPLY_MODEL = GROQ_TEXT_MODELS[0];

const MAX_REPLY_CHARS = 260; // Safe under 280 X cap

const BANNED_CLICHES = [
  'great post',
  'thanks for sharing',
  'thank you for sharing',
  'interesting take',
  'agree with this',
  'well said',
  'nice post',
  'awesome post',
  'love this post',
  'couldn\'t agree more',
  'as an ai',
  'i hope this helps',
  'fascinating read',
  'great question',
  'thanks for asking',
  'spot on',
  '100% agree',
  'game-changer',
  'delve into',
  'in today\'s digital landscape',
];

function cleanReplyText(raw, sourceText = '') {
  if (!raw) return null;
  let text = stripReasoning(raw);   // strip reasoning-model chain-of-thought first
  if (!text) return null;
  text = stripMarkdown(text);
  text = stripMentions(text);
  text = fixStaleModelNames(text);
  text = text.replace(/^["']|["']$/g, '');
  text = text.replace(/#[\w]+/g, ''); // no hashtags in replies
  text = text.replace(/\s+/g, ' ').trim();

  // Anti-bot cliché filter — protects reputation from generic filler
  const lower = text.toLowerCase();
  if (BANNED_CLICHES.some(cliche => lower.includes(cliche))) {
    return null;
  }

  if (text.length > MAX_REPLY_CHARS) {
    text = smartTrimToTarget(text, MAX_REPLY_CHARS);
  }

  if (text.length < 15 || !isLikelyEnglish(text)) return null;

  // The shared must-never-ship floor (see replyGuardFloor in utils.js). Kept in one
  // place so this validator cannot drift behind the feed pipelines again.
  const floor = replyGuardFloor(text, sourceText);
  if (floor) return null;

  return text;
}

function isTruncated(text) {
  const t = text.trim();
  if (t.length < 20) return true;
  if (/\b(a|an|the|and|but|or|of|to|it|is|in|on|for|with|as|at|by|this|that|most|more|just|their|your|our)\s*$/i.test(t)) return true;
  if (/[a-z0-9]-$/i.test(t)) return true;
  if (!/[.!?…"')]$/.test(t)) return true;
  return false;
}

/**
 * Generate an Inbound reply to a comment on @M_jawad_yasin's post.
 */
export async function generateInboundReply({ postTitle, commentAuthor, commentText, isVerified = false }, openRouterKeys, groqKeys) {
  const prompt = `You are @M_jawad_yasin, an active AI engineer, creator, and founder on X.
A reader just left a comment on your post.
Your task is to write a genuine, high-signal, human-to-human reply.

POST TOPIC: "${postTitle || 'AI & Engineering Systems'}"
COMMENT FROM USER (@${commentAuthor}${isVerified ? ' - Verified' : ''}): "${commentText}"

HUMAN VOICE & CLAUDE-BLOG CRITERIA:
- Voice: Direct, friendly peer engineer. Talk like you're chatting in a developer Slack or technical X thread.
- Answer-First: If they asked a question or hit a doubt, give the exact technical answer or operational tradeoff immediately.
- Nuance: If they agreed, point out an interesting edge case or next hurdle. If they disagreed, validate their perspective respectfully and share the counter-tradeoff.
- Conciseness: Exactly 1 to 2 natural sentences (strictly under 220 characters).
- Absolute Bans: NO hashtags, NO emojis spam (at most 1 natural emoji or zero), NO robotic openers ("Great point!", "Thanks for commenting!", "I agree!"), NO generic AI filler.
- Language: 100% English.

Write ONLY the reply text, nothing else:`;

  // Try Gemini first (Primary)
  if (isGeminiConfigured()) {
    try {
      const generated = await callGemini(prompt, {
        temperature: 0.75,
        maxTokens: 150,
        validator: (raw) => {
          const cleaned = cleanReplyText(raw, commentText);
          if (!cleaned || isTruncated(cleaned)) return null;
          return cleaned;
        }
      });
      if (generated) return generated;
    } catch (err) {
      console.warn(`  ⚠ Gemini inbound generation failed: ${err.message}`);
    }
  }

  // Try OpenRouter second
  if (openRouterKeys) {
    try {
      const generated = await callOpenRouter(openRouterKeys, {
        prompt,
        temperature: 0.75,
        maxTokens: 120,
        validator: (raw) => {
          const cleaned = cleanReplyText(raw, commentText);
          if (!cleaned || isTruncated(cleaned)) return null;
          return cleaned;
        }
      });
      if (generated) return generated;
    } catch (err) {
      console.warn(`  ⚠ OpenRouter inbound generation failed: ${err.message}`);
    }
  }

  // Fallback to Groq if available
  if (groqKeys) {
    try {
      const result = await groqKeys.execute(async (apiKey) => {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: GROQ_REPLY_MODEL,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
            max_tokens: 120
          }),
          signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
        return res.json();
      });
      const raw = result?.choices?.[0]?.message?.content;
      const cleaned = cleanReplyText(raw, commentText);
      if (cleaned && !isTruncated(cleaned)) return cleaned;
    } catch (err) {
      console.warn(`  ⚠ Groq inbound fallback failed: ${err.message}`);
    }
  }

  return null;
}

/**
 * Generate an Outbound value-add comment on a top creator's post.
 */
export async function generateOutboundComment({ tweetAuthor, tweetText, isVerified = true }, openRouterKeys, groqKeys) {
  const prompt = `You are @M_jawad_yasin, a verified AI engineer and tech builder on X.
A top tech creator/founder just posted a high-engagement tweet. You are writing a high-value public comment to contribute to their discussion.

ORIGINAL TWEET BY @${tweetAuthor}:
"${tweetText}"

COMMENT OBJECTIVES:
1. Provide a sharp, insightful technical or industry perspective that expands on their point.
2. Pose an intelligent question or counter-perspective that provokes the creator and community to reply.
3. Establish technical credibility without sounding arrogant.

STRICT RULES:
- Never say "Great post!", "Agree with this!", or generic cheerleading.
- Do NOT repeat what the author said. Add NEW substance, nuance, or practical developer reality.
- Length: 1 to 3 punchy sentences (maximum 250 characters).
- NO hashtags. NO @mentions. NO markdown formatting.
- 100% natural, fluent English.

Write ONLY the comment text:`;

  // Try Gemini first (Primary)
  if (isGeminiConfigured()) {
    try {
      const generated = await callGemini(prompt, {
        temperature: 0.8,
        maxTokens: 200,
        validator: (raw) => {
          const cleaned = cleanReplyText(raw, tweetText);
          if (!cleaned || isTruncated(cleaned)) return null;
          return cleaned;
        }
      });
      if (generated) return generated;
    } catch (err) {
      console.warn(`  ⚠ Gemini outbound generation failed: ${err.message}`);
    }
  }

  // Try OpenRouter second
  if (openRouterKeys) {
    try {
      const generated = await callOpenRouter(openRouterKeys, {
        prompt,
        temperature: 0.8,
        maxTokens: 150,
        validator: (raw) => {
          const cleaned = cleanReplyText(raw, tweetText);
          if (!cleaned || isTruncated(cleaned)) return null;
          return cleaned;
        }
      });
      if (generated) return generated;
    } catch (err) {
      console.warn(`  ⚠ OpenRouter outbound generation failed: ${err.message}`);
    }
  }

  if (groqKeys) {
    try {
      const result = await groqKeys.execute(async (apiKey) => {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: GROQ_REPLY_MODEL,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.75,
            max_tokens: 150
          }),
          signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
        return res.json();
      });
      const raw = result?.choices?.[0]?.message?.content;
      const cleaned = cleanReplyText(raw, tweetText);
      if (cleaned && !isTruncated(cleaned)) return cleaned;
    } catch (err) {
      console.warn(`  ⚠ Groq outbound fallback failed: ${err.message}`);
    }
  }

  return null;
}
