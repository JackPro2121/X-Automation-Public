import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { createKeyManager } from '../cron/lib/keyManager.js';
import { generateTweetWithFallback } from '../cron/lib/groqClient.js';
import { finalizePostText } from '../cron/lib/utils.js';
import { fetchReadmeExcerpt } from '../cron/lib/githubClient.js';

const llmKeys = createKeyManager('OPENROUTER', [
  process.env.OPENROUTER_API_KEY,
  process.env.OPENROUTER_API_KEY_2,
  process.env.OPENROUTER_API_KEY_3,
]);

async function testV9Post() {
  const repo = {
    fullName: 'browser-use/browser-use',
    url: 'https://github.com/browser-use/browser-use',
    description: 'Make websites accessible for AI agents',
    stars: 115000,
    starsLabel: '115k',
  };

  const post = {
    title: `${repo.fullName} — ${repo.description}`,
    selftext: `GitHub repo: ${repo.fullName}\nStars: ${repo.stars}\n${repo.description}`,
    redditUrl: repo.url,
    source: 'github',
    repo,
  };

  const readme = await fetchReadmeExcerpt(repo.fullName);
  if (readme) {
    post.selftext += `\n\nREADME excerpt: ${readme}`;
  }

  console.log('Generating tweet for:', repo.fullName);
  const result = await generateTweetWithFallback(post, llmKeys, false);
  console.log('\n--- LLM RAW OUTPUT ---');
  console.log(result?.text);

  const handle = process.env.X_CREATOR_HANDLE || '@M_jawad_yasin';
  const cleanUrl = post.repo.url.replace(/^https?:\/\//, '');
  const sourceLine = `Source 🔗: ${cleanUrl}`;
  const ctaLine = `Follow ${handle} for more amazing AI, Coding & Web Dev insights 💎`;
  const tagsLine = `#ai #coding #opensource #programming #webdevelopment #developer`;

  const fullPostText = `${result?.text?.trim()}\n\n${sourceLine}\n\n${ctaLine}\n\n${tagsLine}`;

  console.log('\n--- FULL ASSEMBLED POST ---');
  console.log(fullPostText);

  const finalized = finalizePostText(fullPostText, {
    sourceText: [post.title, post.selftext].filter(Boolean).join(' '),
    label: 'v9',
  });

  console.log('\n--- FINALIZE STATUS ---');
  console.log('Ok:', finalized.ok);
  if (!finalized.ok) console.log('Reason:', finalized.reason);
  else console.log('Final text length:', finalized.text.length);
}

testV9Post();
