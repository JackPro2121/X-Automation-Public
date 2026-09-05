/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   X-AUTOMATION — ENGAGEMENT & ANALYTICS TRACKER                  ║
 * ║   cron/analytics_tracker.js                                      ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Aggregates 24-hour performance across all pipelines            ║
 * ║   - Daily posts vs 50 target breakdown by pipeline               ║
 * ║   - Pipeline success/failure stats & run health                  ║
 * ║   - LLM model usage & avg character count                        ║
 * ║   - Delivers rich Slack Block Kit Analytics Digest               ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { sendSlack } from './lib/slackClient.js';
import { getChocodataStatus } from './lib/chocodataClient.js';
import { getGroqKeyStatus } from './lib/groqClient.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DAILY_TARGET = 50;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

/**
 * Gather analytics for the past 24 hours (or today UTC)
 */
export async function generateAnalyticsReport(hours = 24) {
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  // 1. Fetch published & failed posts
  const { data: posts, error: postErr } = await supabase
    .from('generated_posts')
    .select('creator_handle, status, character_count, db_created_at')
    .gte('db_created_at', todayStart.toISOString());

  if (postErr) console.warn('  ⚠ Analytics: post query error:', postErr.message);

  const published = (posts || []).filter(p => p.status === 'published');
  const failed = (posts || []).filter(p => p.status === 'failed');

  // Breakdown by source/pipeline
  const pipelineCounts = {
    'v3 (AI News)': 0,
    'v4 (Free Tools)': 0,
    'v6 (X Content)': 0,
    'Quote Tweets': 0,
    'Catch-up': 0,
    'Other': 0,
  };

  let totalChars = 0;

  published.forEach(p => {
    const handle = p.creator_handle || '';
    totalChars += (p.character_count || 0);

    if (handle.startsWith('quote/')) pipelineCounts['Quote Tweets']++;
    else if (handle.startsWith('x/')) pipelineCounts['v6 (X Content)']++;
    else if (handle.startsWith('r/')) {
      // Differentiate v3 vs v4 by subreddit
      const sub = handle.replace('r/', '');
      const v3Subs = ['ClaudeAI', 'singularity', 'LocalLLaMA', 'ChatGPT', 'OpenAI', 'artificial', 'midjourney'];
      if (v3Subs.includes(sub)) pipelineCounts['v3 (AI News)']++;
      else pipelineCounts['v4 (Free Tools)']++;
    } else {
      pipelineCounts['Other']++;
    }
  });

  const avgChars = published.length ? Math.round(totalChars / published.length) : 0;
  const progressPercent = Math.min(100, Math.round((published.length / DAILY_TARGET) * 100));

  // 2. Fetch pipeline run logs
  const { data: runs, error: runErr } = await supabase
    .from('pipeline_runs')
    .select('pipeline, status, duration_seconds, started_at')
    .gte('started_at', since);

  if (runErr) console.warn('  ⚠ Analytics: run logs error:', runErr.message);

  const runStats = { total: (runs || []).length, success: 0, failed: 0, noPosts: 0 };
  (runs || []).forEach(r => {
    if (r.status === 'success') runStats.success++;
    else if (r.status === 'failed') runStats.failed++;
    else if (r.status === 'no_posts') runStats.noPosts++;
  });

  const runSuccessRate = runStats.total ? Math.round((runStats.success / runStats.total) * 100) : 100;

  return {
    date: new Date().toISOString().split('T')[0],
    publishedCount: published.length,
    failedCount: failed.length,
    target: DAILY_TARGET,
    progressPercent,
    avgChars,
    pipelineCounts,
    runStats,
    runSuccessRate,
  };
}

/**
 * Format & send rich Slack Block Kit report
 */
export async function sendAnalyticsDigest() {
  console.log('\n📊 Generating Daily Analytics & Engagement Digest...');
  const report = await generateAnalyticsReport();

  const progressBar = '█'.repeat(Math.round(report.progressPercent / 10)) + '░'.repeat(10 - Math.round(report.progressPercent / 10));

  const text = `📊 *Daily Performance & Analytics Report (${report.date})* — ${report.publishedCount}/${report.target} posts (${report.progressPercent}%)`;

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `📊 Daily X-Automation Analytics (${report.date})`,
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*🎯 Daily Target:* ${report.publishedCount} / ${report.target} posts\n\`${progressBar}\` *${report.progressPercent}%*`,
        },
        {
          type: 'mrkdwn',
          text: `*⚡ Pipeline Success:* ${report.runStats.success}/${report.runStats.total} runs (${report.runSuccessRate}%)\n*❌ Failures:* ${report.failedCount} posts`,
        },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*📡 Posts by Pipeline:*\n` +
          Object.entries(report.pipelineCounts)
            .map(([pl, count]) => `• *${pl}:* ${count} posts`)
            .join('\n') +
          `\n• *Average Tweet Length:* ${report.avgChars} chars (Target: 240)`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `🤖 *LLM:* OpenRouter (Free Chain) + Groq Vision | 🔑 *Scrapers:* Chocodata (FREE) + Apify | 📅 UTC: ${new Date().toISOString().substring(11, 16)}`,
        },
      ],
    },
  ];

  console.log(text);
  console.log(`  - Published: ${report.publishedCount}`);
  console.log(`  - Runs: ${report.runStats.total} (${report.runSuccessRate}% success)`);

  const slackRes = await sendSlack({ text, blocks });
  console.log(`  ✓ Slack digest delivered: ${slackRes.ok ? 'YES' : 'NO'}`);
  return report;
}

// Direct execution
if (process.argv[1] && process.argv[1].endsWith('analytics_tracker.js')) {
  sendAnalyticsDigest().catch(err => console.error('❌ Analytics error:', err));
}
