/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   v8 VIRAL MAGNET ORCHESTRATOR — BUFFER PUBLISH                 ║
 * ║   cron/v8/publish_magnet.js                                      ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   - Generates short technical discussion posts for manual runs     ║
 * ║   - Publishes through Buffer only                                 ║
 * ║   - Paused by default; set V8_ENABLED=true for a manual run       ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

import { createKeyManager } from '../lib/keyManager.js';
import { postSingleToBuffer } from '../lib/bufferClient.js';
import { generateViralMagnet, ARCHETYPES, MAGNET_MIN_CHARS } from './viral_magnet_generator.js';
import { initGroqKeys } from '../lib/groqClient.js';
import { sendSlack } from '../lib/slackClient.js';
import { startRun } from '../lib/logger.js';
import { validateEnv, generateId, finalizePostText, insertGeneratedPost } from '../lib/utils.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

validateEnv(['VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// OpenRouter Keys (Primary)
const openRouterKeys = createKeyManager('OPENROUTER', [
  process.env.OPENROUTER_API_KEY,
  process.env.OPENROUTER_API_KEY_2,
  process.env.OPENROUTER_API_KEY_3,
]);

// Groq Keys (Fallback)
const groqKeys = initGroqKeys();

const ARCHETYPE_IDS = ARCHETYPES.map((a) => a.id);

/**
 * Load recently published v8 magnets so the generator can avoid repeating
 * itself. Previously nothing compared a new post against what was already
 * published, so a near-duplicate could only be caught by a human reading the
 * timeline. See AUDIT_2026-09-15.md §2.
 *
 * @returns {Promise<{texts: string[], archetypes: string[]}>} most-recent-first
 */
async function loadRecentMagnets(limit = 15) {
  try {
    const { data, error } = await supabase
      .from('generated_posts')
      .select('generated_text, virality_hook_tag, created_at')
      .in('virality_hook_tag', ARCHETYPE_IDS)
      .eq('status', 'published')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.warn(`  ⚠ Could not load recent magnets for dedup: ${error.message}`);
      return { texts: [], archetypes: [] };
    }

    const rows = data || [];
    console.log(`  ↺ Loaded ${rows.length} recent magnet(s) for duplicate detection`);
    return {
      texts: rows.map((r) => r.generated_text).filter(Boolean),
      archetypes: rows.map((r) => r.virality_hook_tag).filter(Boolean),
    };
  } catch (err) {
    console.warn(`  ⚠ Dedup preload error: ${err.message}`);
    return { texts: [], archetypes: [] };
  }
}

async function main() {
  const startTime = Date.now();

  if (process.env.V8_ENABLED !== 'true') {
    console.log('⏸ v8 is paused. Set V8_ENABLED=true for an explicit manual run.');
    return;
  }
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   🔥 v8 VIRAL CONVERSATION MAGNET — BUFFER PUBLISH           ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║   Mode: BUFFER ONLY                                         ║');
  console.log('║   Target: Short technical discussion post                   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const run = startRun('v8_viral_magnet');

  // Step 1: Load recent posts (for dedup) and generate a fresh post.
  // Hour-based archetype preference is now handled *inside* pickArchetype() as a
  // weighting, not as a hard per-hour pin — the old getArchetypeByHour() returned
  // a fixed archetype per hour bucket, which is why the same post reappeared
  // every day at the same time. See AUDIT_2026-09-15.md §2.
  const recent = await loadRecentMagnets();

  const generated = await generateViralMagnet(openRouterKeys, groqKeys, {
    recentTexts: recent.texts,
    recentArchetypes: recent.archetypes,
  });

  if (!generated || !generated.text) {
    console.error('❌ Failed to generate viral magnet post. Exiting.');
    await run.fail('Generation failed');
    return;
  }

  // Step 1b: Finalize — trim to the safe cap, then re-run the full guard chain on
  // the exact string that will be published. minChars is lowered to the magnet
  // envelope because v8 posts are intentionally short (the 160-char default is
  // tuned for the long-form v3/v4/v6 pipelines).
  const finalized = finalizePostText(generated.text, {
    label: `v8 magnet (${generated.archetype})`,
    minChars: MAGNET_MIN_CHARS,
    checkOriginality: false, // magnets are original by construction; dedup ran above
  });

  if (!finalized.ok) {
    console.error(`❌ Finalize rejected the magnet: ${finalized.reason}`);
    await run.fail(`Finalize rejected: ${finalized.reason}`);
    return;
  }

  const postText = finalized.text;
  console.log(`\n📝 Finalized Viral Post (${postText.length} chars, Archetype: ${generated.archetype}, attempt ${generated.attempts}):\n`);
  console.log('----------------------------------------------------');
  console.log(postText);
  console.log('----------------------------------------------------\n');

  // Step 2: Publish via Buffer (mode: shareNow)
  let publishSuccess = false;
  let tweetId = null;
  let method = 'Buffer (Publish Now)';

  console.log('🚀 Publishing Viral Magnet via Buffer (mode: shareNow)...');
  try {
    const bufferResult = await postSingleToBuffer(postText, null);
    if (bufferResult.success) {
      publishSuccess = true;
      tweetId = bufferResult.postId;
      console.log(`  ✅ Successfully published via Buffer! Post ID: ${tweetId}`);
    } else {
      console.error(`  ❌ Buffer publish failed: ${bufferResult.reason}`);
    }
  } catch (err) {
    console.error(`  ❌ Publishing error: ${err.message}`);
  }

  if (!publishSuccess) {
    console.error('❌ Failed to publish post via Buffer.');
    await run.fail('Buffer publishing failed');
    return;
  }

  // Step 3: Record in Supabase
  const postId = generateId();
  try {
    await insertGeneratedPost(supabase, {
      id: postId,
      generated_text: postText,
      status: 'published',
      character_count: postText.length,
      virality_hook_tag: generated.archetype,
      source_url: tweetId ? `https://x.com/M_jawad_yasin/status/${tweetId}` : null,
      buffer_post_id: tweetId,
      created_at: new Date().toISOString()
    }, {
      model: generated.model,
      // For v8 the ARCHETYPE is the shape equivalent — POST_SHAPES does not apply
      // to this generator, so leaving shape_used null would make v8 invisibly
      // absent from any shape-based quality query.
      shape: generated.archetype,
      // No derivation: v8 prompts are prose-only and do not use DERIVATION_MODES.
    });
    console.log('  ✓ Saved post record to Supabase generated_posts');
  } catch (err) {
    console.warn(`  ⚠ Supabase record error: ${err.message}`);
  }

  // Step 4: Slack Notification
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  try {
    const tweetLink = tweetId ? `https://x.com/M_jawad_yasin/status/${tweetId}` : 'https://x.com/M_jawad_yasin';
    await sendSlack({
      text: `🔥 [v8 Viral Magnet] Direct Published: "${postText.substring(0, 80)}..."`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '🔥 v8 Viral Conversation Magnet — Published',
            emoji: true
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Post Content:*\n>>>${postText}`
          }
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Archetype:*\n\`${generated.archetype}\`` },
            { type: 'mrkdwn', text: `*Method:*\n${method}` },
            { type: 'mrkdwn', text: `*Length:*\n${postText.length} chars` },
            { type: 'mrkdwn', text: `*Link:*\n<${tweetLink}|View on X>` }
          ]
        }
      ]
    });
  } catch (err) {
    console.warn(`  ⚠ Slack alert error: ${err.message}`);
  }
 
  run.setPost({
    title: `[v8 Magnet] ${generated.archetype}`,
    url: tweetId ? `https://x.com/M_jawad_yasin/status/${tweetId}` : null,
    generatedText: postText,
  });

  await run.success({ archetype: generated.archetype, tweetId, method });
  console.log(`\n🎉 Pipeline completed in ${elapsed}s!`);
}

main().catch(async (err) => {
  console.error('Fatal v8 error:', err);
  process.exit(1);
});
