import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { BUFFER_API_URL } from './lib/constants.js';
import { sendSlack } from './lib/slackClient.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_REFRESH_HOURS = 20;
const DEFAULT_MAX_CANDIDATES = 10;
const MAX_RETRIES = 2;
const BUFFER_METRICS_TIMEOUT_MS = 15000;
const SUPABASE_TIMEOUT_MS = 20000;
const GET_POST_METRICS = `
  query GetPostMetrics($input: PostInput!) {
    post(input: $input) {
      id
      channelId
      metrics {
        type
        name
        value
        unit
      }
      metricsUpdatedAt
    }
  }
`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatError(error) {
  const message = error?.message || String(error || 'Unknown error');
  return message.length > 300 ? `${message.substring(0, 300)}...` : message;
}

function getSupabaseClient() {
  const url = process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(url, serviceRoleKey, {
    global: {
      fetch: (input, init = {}) => fetch(input, {
        ...init,
        signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
      }),
    },
  });
}

export function normalizeMetrics(metrics) {
  if (!Array.isArray(metrics)) return {};
  const normalized = {};
  for (const metric of metrics) {
    if (!metric?.type) continue;
    const value = Number(metric.value);
    if (!Number.isFinite(value)) continue;
    normalized[metric.type] = {
      name: metric.name || metric.type,
      value,
      unit: metric.unit || null,
    };
  }
  return normalized;
}

export function pipelineForPost(post) {
  const source = String(post?.source_url || '');
  const id = String(post?.id || '');
  if (source.startsWith('v11://') || id.startsWith('v11')) return 'v11';
  if (source.startsWith('https://github.com/') || id.startsWith('v9')) return 'v9';
  return 'other';
}

export function shouldRefresh(lastUpdatedAt, refreshHours = DEFAULT_REFRESH_HOURS, now = Date.now()) {
  if (!lastUpdatedAt) return true;
  const lastUpdated = Date.parse(lastUpdatedAt);
  if (!Number.isFinite(lastUpdated)) return true;
  return now < lastUpdated || now - lastUpdated >= refreshHours * 60 * 60 * 1000;
}

export function buildSnapshotId(bufferPostId, metricsUpdatedAt) {
  const timestamp = Date.parse(metricsUpdatedAt);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid Buffer metricsUpdatedAt: ${metricsUpdatedAt}`);
  }
  return `${bufferPostId}-${timestamp}`;
}

async function requestBufferPostMetrics(bufferPostId, retryCount = 0) {
  const apiKey = process.env.BUFFER_API_KEY;
  if (!apiKey) throw new Error('Missing BUFFER_API_KEY');

  try {
    const response = await fetch(BUFFER_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: GET_POST_METRICS,
        variables: { input: { id: bufferPostId } },
      }),
      signal: AbortSignal.timeout(BUFFER_METRICS_TIMEOUT_MS),
    });

    if (response.status === 429 && retryCount < MAX_RETRIES - 1) {
      const retryAfter = Math.min(Math.max(parseInt(response.headers.get('retry-after') || '1', 10) || 1, 1), 30);
      await sleep(retryAfter * 1000);
      return requestBufferPostMetrics(bufferPostId, retryCount + 1);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Buffer HTTP ${response.status}: ${body.substring(0, 200)}`);
    }

    const payload = await response.json();
    if (payload?.errors?.length) {
      throw new Error(`Buffer GraphQL: ${payload.errors.map(error => error.message).join('; ')}`);
    }
    return payload?.data?.post || null;
  } catch (error) {
    if (retryCount < MAX_RETRIES - 1 && /HTTP 5\d\d|timed out|network|fetch failed/i.test(error.message)) {
      await sleep(1000 * (retryCount + 1));
      return requestBufferPostMetrics(bufferPostId, retryCount + 1);
    }
    throw error;
  }
}

async function loadPublishedPosts(supabase, lookbackDays) {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('generated_posts')
    .select('id, buffer_post_id, source_url, db_created_at')
    .eq('status', 'published')
    .not('buffer_post_id', 'is', null)
    .gte('db_created_at', since)
    .order('db_created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function loadLatestSnapshots(supabase, lookbackDays) {
  const since = new Date(Date.now() - (lookbackDays + 2) * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('buffer_post_metrics')
    .select('buffer_post_id, metrics_updated_at')
    .gte('collected_at', since)
    .order('metrics_updated_at', { ascending: false });
  if (error) throw error;

  const latest = new Map();
  for (const snapshot of data || []) {
    if (!latest.has(snapshot.buffer_post_id)) {
      latest.set(snapshot.buffer_post_id, snapshot.metrics_updated_at);
    }
  }
  return latest;
}

function createPipelineSummary() {
  return {
    posts: 0,
    reactions: 0,
    comments: 0,
    reposts: 0,
    shares: 0,
    impressions: 0,
    reach: 0,
    views: 0,
    engagementRate: null,
    engagementRateCount: 0,
  };
}

function addMetric(summary, metrics, type) {
  const metric = metrics[type];
  if (!metric || !Number.isFinite(metric.value)) return;
  if (type === 'engagementRate') {
    summary.engagementRateCount += 1;
    summary.engagementRate = ((summary.engagementRate || 0) * (summary.engagementRateCount - 1) + metric.value) / summary.engagementRateCount;
    return;
  }
  summary[type] += metric.value;
}

export function buildReport({ candidates, saved, pending, failures, results, skipped = 0 }) {
  const pipelines = {
    v9: createPipelineSummary(),
    v11: createPipelineSummary(),
    other: createPipelineSummary(),
  };

  for (const result of results) {
    const pipeline = pipelineForPost(result.post);
    const summary = pipelines[pipeline];
    summary.posts += 1;
    for (const type of ['reactions', 'comments', 'reposts', 'shares', 'impressions', 'reach', 'views', 'engagementRate']) {
      addMetric(summary, result.metrics, type);
    }
  }

  return {
    candidates,
    saved,
    pending,
    failures,
    skipped,
    pipelines,
  };
}

function formatPipelineSummary(name, summary) {
  const parts = [`${name}: ${summary.posts} posts`];
  for (const type of ['reactions', 'comments', 'reposts', 'shares', 'impressions', 'reach', 'views']) {
    if (summary[type]) parts.push(`${type} ${summary[type]}`);
  }
  if (summary.engagementRate !== null) {
    parts.push(`avg engagement rate ${summary.engagementRate.toFixed(2)}%`);
  }
  return parts.join(' | ');
}

export async function sendBufferMetricsDigest(report) {
  const text = [
    '*Buffer metrics snapshot complete*',
    `Candidates: ${report.candidates} | Saved: ${report.saved} | Pending: ${report.pending} | Deferred: ${report.skipped} | Failures: ${report.failures}`,
    formatPipelineSummary('v9', report.pipelines.v9),
    formatPipelineSummary('v11', report.pipelines.v11),
    formatPipelineSummary('other', report.pipelines.other),
  ].join('\n');
  return sendSlack({ text });
}

export async function collectBufferMetrics({
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  refreshHours = DEFAULT_REFRESH_HOURS,
  maxCandidates = DEFAULT_MAX_CANDIDATES,
  notify = true,
} = {}) {
  const supabase = getSupabaseClient();
  const posts = await loadPublishedPosts(supabase, lookbackDays);
  const latestSnapshots = await loadLatestSnapshots(supabase, lookbackDays);
  const allCandidates = posts.filter(post => shouldRefresh(latestSnapshots.get(post.buffer_post_id), refreshHours));
  const candidates = allCandidates.slice(0, Math.max(0, maxCandidates));
  const skipped = allCandidates.length - candidates.length;
  const results = [];
  let pending = 0;
  let failures = 0;

  console.log(`Buffer metrics candidates: ${candidates.length}; deferred: ${skipped}`);
  for (const [index, post] of candidates.entries()) {
    console.log(`[${index + 1}/${candidates.length}] Checking Buffer post ${post.buffer_post_id}`);
    try {
      const bufferPost = await requestBufferPostMetrics(post.buffer_post_id);
      const metrics = normalizeMetrics(bufferPost?.metrics);
      if (!bufferPost?.metricsUpdatedAt || Object.keys(metrics).length === 0) {
        pending += 1;
        continue;
      }

      const metricsUpdatedAt = new Date(bufferPost.metricsUpdatedAt).toISOString();
      const { error } = await supabase.from('buffer_post_metrics').upsert({
        id: buildSnapshotId(bufferPost.id || post.buffer_post_id, metricsUpdatedAt),
        buffer_post_id: post.buffer_post_id,
        generated_post_id: post.id,
        channel_id: bufferPost.channelId || null,
        metrics_updated_at: metricsUpdatedAt,
        collected_at: new Date().toISOString(),
        metrics,
      }, { onConflict: 'id' });
      if (error) throw error;
      results.push({ post, metrics });
    } catch (error) {
      failures += 1;
      console.error(`Buffer metrics failed for ${post.buffer_post_id}: ${formatError(error)}`);
    }
  }

  const report = buildReport({ candidates: candidates.length, saved: results.length, pending, failures, results, skipped });
  if (notify) await sendBufferMetricsDigest(report);
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  collectBufferMetrics().catch(error => {
    console.error(`Buffer metrics collector failed: ${formatError(error)}`);
    process.exitCode = 1;
  });
}
