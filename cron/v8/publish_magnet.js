/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   v8 VIRAL MAGNET ORCHESTRATOR — DIRECT PUBLISH                 ║
 * ║   cron/v8/publish_magnet.js                                      ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   - Generates high-reply thought posts across 5 archetypes       ║
 * ║   - Direct Publishes via Official X API v2 (bypassing Buffer queue)║
 * ║   - Fallback to Buffer direct publish if needed                  ║
 * ║   - Runs 3x daily at peak hours (9 AM, 3 PM, 9 PM PKT)           ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

import { createKeyManager } from '../lib/keyManager.js';
import { isXApiConfigured, postXTweet } from '../lib/xApiClient.js';
import { postSingleToBuffer } from '../lib/bufferClient.js';
import { generateViralMagnet } from './viral_magnet_generator.js';
import { initGroqKeys } from '../lib/groqClient.js';
import { sendSlack } from '../lib/slackClient.js';
import { startRun } from '../lib/logger.js';
import { validateEnv, generateId } from '../lib/utils.js';

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

/**
 * Determine best archetype based on UTC hour of the day
 */
function getArchetypeByHour() {
  const currentHour = new Date().getUTCHours();

  if (currentHour >= 3 && currentHour <= 6) {
    // ~9:00 AM PKT (Morning dev commute / coffee)
    return 'vibe_coding_irony';
  } else if (currentHour >= 9 && currentHour <= 12) {
    // ~3:00 PM PKT (Midday break / SaaS builder showcase)
    return 'community_roast_magnet';
  } else if (currentHour >= 15 && currentHour <= 18) {
    // ~9:00 PM PKT (Evening deep tech philosophy & debate)
    return Math.random() > 0.5 ? 'dev_identity_crisis' : 'generational_shift';
  }
  return null; // Random rotation
}

async function main() {
  const startTime = Date.now();
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   🔥 v8 VIRAL CONVERSATION MAGNET — DIRECT PUBLISH           ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║   Mode: DIRECT PUBLISH (Bypasses Buffer Queue)               ║');
  console.log('║   Target: High-Reply viral discussion post                   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const run = startRun('v8_viral_magnet');

  // Step 1: Select archetype & generate post
  const preferredArchetype = getArchetypeByHour();
  const generated = await generateViralMagnet(openRouterKeys, groqKeys, preferredArchetype);

  if (!generated || !generated.text) {
    console.error('❌ Failed to generate viral magnet post. Exiting.');
    await run.fail('Generation failed');
    return;
  }

  const postText = generated.text;
  console.log(`\n📝 Generated Viral Post (${postText.length} chars, Archetype: ${generated.archetype}):\n`);
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
      
      // Secondary fallback to X API if configured
      if (isXApiConfigured()) {
        console.log('🔄 Secondary Fallback: Trying Official X API v2...');
        const xResult = await postXTweet(postText);
        if (xResult.success) {
          publishSuccess = true;
          tweetId = xResult.tweetId;
          method = 'Official X API';
          console.log(`  ✅ Published via X API! ID: ${tweetId}`);
        } else {
          console.error(`  ❌ X API fallback also failed: ${xResult.error}`);
        }
      }
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
    await supabase.from('generated_posts').insert({
      id: postId,
      generated_text: postText,
      status: 'published',
      character_count: postText.length,
      virality_hook_tag: generated.archetype,
      source_url: tweetId ? `https://x.com/M_jawad_yasin/status/${tweetId}` : null,
      buffer_post_id: tweetId,
      created_at: new Date().toISOString()
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

  await run.success({ archetype: generated.archetype, tweetId, method });
  console.log(`\n🎉 Pipeline completed in ${elapsed}s!`);
}

main().catch(async (err) => {
  console.error('Fatal v8 error:', err);
  process.exit(1);
});
