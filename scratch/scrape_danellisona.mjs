import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const APIFY_TOKEN = process.env.APIFY_API_TOKEN || process.env.APIFY_API_KEY;

if (!APIFY_TOKEN) {
  console.error('ERROR: No APIFY_API_TOKEN found in .env.local');
  process.exit(1);
}

const handle = 'danellisona';
console.log(`Starting Apify scrape for @${handle}...`);

async function scrapeProfile() {
  const actorId = 'apidojo~tweet-scraper';
  
  // 1. Trigger the actor run
  const runRes = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      twitterHandles: [handle],
      maxItems: 60,
      sort: 'Latest',
    }),
  });

  if (!runRes.ok) {
    const errText = await runRes.text();
    console.error(`Apify run launch failed: HTTP ${runRes.status} - ${errText}`);
    process.exit(1);
  }

  const runData = await runRes.json();
  const runId = runData.data?.id;
  const datasetId = runData.data?.defaultDatasetId;
  console.log(`Run started: runId=${runId}, datasetId=${datasetId}`);

  // 2. Poll for completion
  let status = 'RUNNING';
  const startTime = Date.now();
  while (status === 'RUNNING' || status === 'READY') {
    await new Promise((r) => setTimeout(r, 4000));
    const pollRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
    if (!pollRes.ok) {
      console.warn(`Poll check HTTP ${pollRes.status}`);
      continue;
    }
    const pollData = await pollRes.json();
    status = pollData.data?.status;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`Status after ${elapsed}s: ${status}`);
    if (status === 'SUCCEEDED' || status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
      break;
    }
  }

  if (status !== 'SUCCEEDED') {
    console.error(`Scrape did not succeed. Final status: ${status}`);
    process.exit(1);
  }

  // 3. Fetch all dataset items
  const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=100`);
  if (!itemsRes.ok) {
    console.error(`Failed to fetch dataset items: HTTP ${itemsRes.status}`);
    process.exit(1);
  }

  const items = await itemsRes.json();
  console.log(`Fetched ${items.length} items from @${handle}`);

  const outPath = path.resolve(process.cwd(), 'scratch/danellisona_scrape.json');
  fs.writeFileSync(outPath, JSON.stringify(items, null, 2), 'utf-8');
  console.log(`Saved items to ${outPath}`);
}

scrapeProfile().catch((err) => {
  console.error('Fatal error during scrape:', err);
  process.exit(1);
});
