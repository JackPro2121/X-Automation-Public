/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   v8 VIRAL CONVERSATION MAGNET GENERATOR                         ║
 * ║   cron/v8/viral_magnet_generator.js                              ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Generates short, high-reply viral thought posts across         ║
 * ║   5 proven archetypes to trigger 27x algorithmic depth.          ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import { callOpenRouter } from '../lib/openrouterClient.js';
import { callGemini, isGeminiConfigured } from '../lib/geminiClient.js';
import { stripMarkdown, stripMentions, fixStaleModelNames, isLikelyEnglish, isMetaTextCaption, stripReasoning, isGenericAIText } from '../lib/utils.js';

export const ARCHETYPES = [
  {
    id: 'vibe_coding_irony',
    name: 'Vibe Coding & Dev Reality Irony',
    prompt: `You are @M_jawad_yasin, an AI engineer and founder.
Write a punchy, humorous, and brutally relatable observation about "vibe coding", autonomous AI agents, or modern software development bugs.

FORMAT & STRUCTURE:
- Opening: Short capitalized bold hook (e.g., "VIBE CODING IS BRUTAL." or "ORCHESTRATING AGENTS IS WILD.")
- Middle: 2 to 3 short lines describing the ironic loop (e.g., "You fix one bug, three appear. You fix those, the first one is back.")
- Closing: A short question asking other developers to share their experience.
- Spacing: Clean blank line between sections.
- Target Length: 150 to 260 characters.
- Strict rules: NO hashtags. Max 1 emoji. 100% natural, casual English.`
  },
  {
    id: 'dev_identity_crisis',
    name: 'Dev Identity Crisis Provocation',
    prompt: `You are @M_jawad_yasin, a verified AI engineer on X.
Write a short, provocative contrast challenging what software developers actually do in 2026.

FORMAT & STRUCTURE:
AI writes the code.
AI finds the bugs.
AI fixes the bugs.
AI reviews the PR.

so what exactly is the [developer / senior engineer] doing?

(Vary the actions and punchline creatively while keeping this exact rhythmic format).
- Target Length: 120 to 220 characters.
- Strict rules: NO hashtags, NO emojis, NO markdown. Output only the post text.`
  },
  {
    id: 'generational_shift',
    name: 'Generational Shift (3-Liner)',
    prompt: `You are @M_jawad_yasin, an AI builder on X.
Write a mind-bending 3-line historical progression ending with a futuristic cliffhanger question about tech/coding.

FORMAT & STRUCTURE:
our parents [old method/habit].
we [current AI method/habit].

what does the next one do ?

(Vary the topic: e.g. googling vs prompting, memorizing syntax vs orchestrating models, deploying servers vs running local agents).
- Target Length: 80 to 180 characters.
- Strict rules: Lowercase or minimal styling, empty line before question, NO hashtags.`
  },
  {
    id: 'community_roast_magnet',
    name: 'Drop Your Project / Roast Magnet',
    prompt: `You are @M_jawad_yasin, an AI engineer and builder on X.
Write an authentic community invite post asking builders and founders to drop their projects in the replies so you can give them candid feedback.

FORMAT & STRUCTURE:
Line 1: "drop your [saas / github project / ai agent / portfolio] below 👇"
Line 2: (blank line)
Line 3: What you will do for them (e.g. "I'll pretend I'm your user and tell you the 1 reason I'd bounce." or "I'll review your architecture and give you 1 brutal fix.")

- Target Length: 100 to 180 characters.
- Strict rules: Authentic, helpful, zero sales pitch, NO hashtags.`
  },
  {
    id: 'under_1k_reality',
    name: 'Contrarian Truth for Builders',
    prompt: `You are @M_jawad_yasin, a verified tech founder on X.
Write a crisp reality check for early tech builders and creators on X.

FORMAT & STRUCTURE:
- Opening: "If you're under [1,000 followers / 10 customers], stop expecting [miracle]."
- Middle: 2-3 short, punchy truth lines about why distribution and conversations matter more than vanity virality.
- Closing: "Your replies are your distribution." (or a similar memorable maxim).
- Target Length: 160 to 260 characters.
- Strict rules: Spaced lines, zero fluff, NO hashtags.`
  }
];

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

  if (text.length < 40 || text.length > 350 || !isLikelyEnglish(text)) return null;

  // 3. Final leak guard — reject any tag-less reasoning / prompt-label leak that
  //    survived (parity with groqClient.cleanTweetText + bufferClient posting).
  if (isMetaTextCaption(text)) {
    console.warn('  ⚠ v8 magnet rejected — meta-text / reasoning leak detected');
    return null;
  }

  // 4. Authenticity gate — reject generic AI-slop (X Creator Rewards flags it).
  if (isGenericAIText(text)) {
    console.warn('  ⚠ v8 magnet rejected — generic AI-slop, regenerating');
    return null;
  }
  return text;
}

/**
 * Generate a viral conversation magnet post.
 * Rotates or randomly selects an archetype.
 */
export async function generateViralMagnet(openRouterKeys, groqKeys, preferredArchetypeId = null) {
  let archetype = ARCHETYPES.find(a => a.id === preferredArchetypeId);
  if (!archetype) {
    archetype = ARCHETYPES[Math.floor(Math.random() * ARCHETYPES.length)];
  }

  console.log(`\n  🎯 Selected Archetype: "${archetype.name}" (${archetype.id})`);

  // 1. Try Gemini first (Primary)
  if (isGeminiConfigured()) {
    try {
      const generated = await callGemini(archetype.prompt, {
        temperature: 0.85,
        maxTokens: 350,
        validator: (raw) => {
          const cleaned = cleanMagnetText(raw);
          if (!cleaned) return null;
          return cleaned;
        }
      });
      if (generated) {
        return { text: generated, archetype: archetype.id };
      }
    } catch (err) {
      console.warn(`  ⚠ Gemini viral generation failed: ${err.message}`);
    }
  }

  // 2. Try OpenRouter second (Secondary)
  if (openRouterKeys) {
    try {
      const generated = await callOpenRouter(openRouterKeys, {
        prompt: archetype.prompt,
        temperature: 0.85,
        maxTokens: 250,
        validator: (raw) => {
          const cleaned = cleanMagnetText(raw);
          if (!cleaned) return null;
          return cleaned;
        }
      });
      if (generated) {
        return { text: generated, archetype: archetype.id };
      }
    } catch (err) {
      console.warn(`  ⚠ OpenRouter viral generation failed: ${err.message}`);
    }
  }

  // 2. Fallback to Groq. Model IDs are config-driven (GROQ_TEXT_MODELS, comma-
  //    separated) so a churned/404'd model can be swapped without a code change.
  if (groqKeys) {
    const groqModels = (process.env.GROQ_TEXT_MODELS && process.env.GROQ_TEXT_MODELS.trim())
      ? process.env.GROQ_TEXT_MODELS.split(',').map(s => s.trim()).filter(Boolean)
      : ['qwen/qwen3.8-27b', 'llama-3.3-70b-versatile', 'qwen/qwen3.6-27b'];
    for (const model of groqModels) {
      try {
        const result = await groqKeys.execute(async (apiKey) => {
          const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: archetype.prompt }],
              temperature: 0.8,
              max_tokens: 250
            }),
            signal: AbortSignal.timeout(15000)
          });
          if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
          return res.json();
        });
        const raw = result?.choices?.[0]?.message?.content;
        const cleaned = cleanMagnetText(raw);
        if (cleaned) {
          console.log(`  ✓ Groq [${model}] generated viral magnet`);
          return { text: cleaned, archetype: archetype.id };
        }
      } catch (err) {
        console.warn(`  ⚠ Groq model ${model} failed: ${err.message}`);
      }
    }
  }

  // 3. Fallback to OrcaRouter if available
  const orcaKey = process.env.ORCAROUTER_API_KEY;
  if (orcaKey) {
    try {
      console.log('  ▶ Trying OrcaRouter fallback for viral magnet...');
      const res = await fetch('https://api.orcarouter.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${orcaKey}`
        },
        body: JSON.stringify({
          model: 'z-ai/glm-5.3-flash-free',
          messages: [{ role: 'user', content: archetype.prompt }],
          max_tokens: 1200,
          temperature: 0.7
        }),
        signal: AbortSignal.timeout(25000)
      });
      if (res.ok) {
        const data = await res.json();
        const raw = data.choices?.[0]?.message?.content;
        const cleaned = cleanMagnetText(raw);
        if (cleaned) {
          console.log('  ✓ OrcaRouter generated viral magnet');
          return { text: cleaned, archetype: archetype.id };
        }
      }
    } catch (orcaErr) {
      console.warn(`  ⚠ OrcaRouter fallback failed: ${orcaErr.message}`);
    }
  }

  return null;
}
