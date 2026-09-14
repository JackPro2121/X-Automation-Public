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
import { stripMarkdown, stripMentions, fixStaleModelNames, isLikelyEnglish, stripReasoning, isMetaTextCaption, isTooSimilarToSource } from '../lib/utils.js';
import { smartTrimToTarget } from '../tweetLimits.js';

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
  'fascinating read'
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

  // Final leak guard — reject reasoning / prompt-label leaks that slipped through.
  if (isMetaTextCaption(text)) return null;

  // Originality — a reply that just echoes the tweet/comment adds no value and
  // reads as a bot. Reject near-copies so the model regenerates a real take.
  if (sourceText && isTooSimilarToSource(text, sourceText)) return null;
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
  const prompt = `You are @M_jawad_yasin, an AI engineer, tech creator, and founder. A user just commented on your post.
Your task is to write an authentic, smart, and engaging direct reply.

YOUR POST TOPIC: "${postTitle || 'AI & Tech Breakthroughs'}"
COMMENT FROM USER (@${commentAuthor}${isVerified ? ' - Verified' : ''}): "${commentText}"

REPLY GUIDELINES:
- Tone: Friendly, authoritative yet humble tech builder. Sound like a real person, not an AI bot.
- Value: If they asked a question, give a clear, direct answer. If they praised the post, thank them and add one insightful nuance or ask their take. If they debated, acknowledge their point constructively.
- Length: 1 to 2 short sentences (maximum 220 characters).
- Constraints: NO hashtags, NO emojis spam (max 1 natural emoji), NO generic bot fluff like "Great comment! Thanks for sharing".
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
            model: 'llama-3.3-70b-versatile',
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
            model: 'llama-3.3-70b-versatile',
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
