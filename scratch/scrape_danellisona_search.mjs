import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
const APIFY_TOKEN = process.env.APIFY_API_TOKEN || process.env.APIFY_API_KEY;

async function runSearch(query, outFile) {
  console.log(`Running search for query: "${query}"...`);
  const actorId = 'apidojo~tweet-scraper';
  const runRes = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      searchTerms: [query],
      maxItems: 20,
      sort: 'Top',
    }),
  });

  if (!runRes.ok) {
    console.error('Run failed:', await runRes.text());
    return;
  }
  const runData = await runRes.json();
  const runId = runData.data?.id;
  const datasetId = runData.data?.defaultDatasetId;

  console.log(`Started: runId=${runId}`);
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const sRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
    const sData = await sRes.json();
    const st = sData.data?.status;
    if (st === 'SUCCEEDED') break;
    if (st === 'FAILED' || st === 'ABORTED') {
      console.error(`Failed with status: ${st}`);
      return;
    }
  }

  const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}`);
  const items = await itemsRes.json();
  console.log(`Found ${items.length} items for query "${query}"`);
  fs.writeFileSync(outFile, JSON.stringify(items, null, 2), 'utf8');
}

async function main() {
  await runSearch('from:danellisona min_faves:50', 'scratch/danellisona_viral_50.json');
  await runSearch('from:danellisona until:2026-10-05', 'scratch/danellisona_older.json');
}

main().catch(console.error);
