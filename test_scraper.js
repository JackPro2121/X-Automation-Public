/**
 * Quick test: apidojo/tweet-scraper with media filter
 * Tests if scraper returns media URLs
 */

import { createKeyManager } from './cron/lib/keyManager.js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const apifyKeys = createKeyManager('APIFY', [
  process.env.APIFY_API_KEY,
  process.env.APIFY_API_KEY_2,
  process.env.APIFY_API_KEY_3,
  process.env.APIFY_API_KEY_4,
  process.env.APIFY_API_KEY_5,
  process.env.APIFY_API_KEY_6,
  process.env.APIFY_API_KEY_7,
  process.env.APIFY_API_KEY_8,
  process.env.APIFY_API_KEY_9,
  process.env.APIFY_API_KEY_10,
  process.env.APIFY_API_KEY_11,
]);

async function test() {
  console.log('Testing apidojo/tweet-scraper with media filter...');
  console.log(`Keys available: ${apifyKeys.totalKeys}`);

  try {
    const items = await apifyKeys.execute(async (apiKey) => {
      const res = await fetch('https://api.apify.com/v2/acts/apidojo~tweet-scraper/runs?token=' + apiKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchTerms: ['from:0x0SojalSec filter:media'],
          sort: 'Latest',
          maxItems: 5
        }),
        signal: AbortSignal.timeout(30000)
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const runId = data.data?.id;
      if (!runId) throw new Error('No run ID');

      // Wait for completion
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const sRes = await fetch('https://api.apify.com/v2/actor-runs/' + runId + '?token=' + apiKey, {
          signal: AbortSignal.timeout(10000)
        });
        const sData = await sRes.json();

        if (sData.data?.status === 'SUCCEEDED') {
          const dId = sData.data?.defaultDatasetId;
          if (dId) {
            const iRes = await fetch('https://api.apify.com/v2/datasets/' + dId + '/items?token=' + apiKey + '&format=json&limit=3', {
              signal: AbortSignal.timeout(15000)
            });
            return await iRes.json();
          }
        }
        if (sData.data?.status === 'FAILED') throw new Error('Run failed');
      }
      throw new Error('Timeout');
    });

    console.log(`\nFound ${items?.length || 0} tweets`);

    if (items && items.length > 0) {
      const first = items[0];
      console.log('\n=== FIRST TWEET ===');
      console.log('Text:', first.text?.substring(0, 100));
      console.log('Likes:', first.likeCount);
      console.log('Retweets:', first.retweetCount);
      console.log('URL:', first.url);

      console.log('\n=== MEDIA CHECK ===');
      console.log('Has media?', !!first.media);
      console.log('Has photos?', !!first.photos);
      console.log('Has videos?', !!first.videos);
      console.log('Has extended_entities?', !!first.extended_entities);
      console.log('Has article?.media?', !!first.article?.contentState?.media);

      if (first.media) console.log('media:', JSON.stringify(first.media, null, 2)?.substring(0, 1000));
      if (first.article?.contentState?.media) console.log('article media:', JSON.stringify(first.article.contentState.media));

      // Check all keys
      console.log('\n=== ALL KEYS ===');
      console.log(Object.keys(first).join(', '));
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
}

test().catch(console.error);
