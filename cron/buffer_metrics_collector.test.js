import assert from 'node:assert/strict';
import {
  buildReport,
  buildSnapshotId,
  normalizeMetrics,
  pipelineForPost,
  shouldRefresh,
} from './buffer_metrics_collector.js';

const metrics = normalizeMetrics([
  { type: 'reactions', name: 'Reactions', value: 4, unit: 'count' },
  { type: 'engagementRate', name: 'Engagement Rate', value: 12.5, unit: 'percentage' },
  { type: 'invalid', value: 'not-a-number', unit: 'count' },
]);

assert.deepEqual(metrics, {
  reactions: { name: 'Reactions', value: 4, unit: 'count' },
  engagementRate: { name: 'Engagement Rate', value: 12.5, unit: 'percentage' },
});
assert.equal(pipelineForPost({ source_url: 'https://github.com/example/repo' }), 'v9');
assert.equal(pipelineForPost({ source_url: 'v11://agent-reliability/123' }), 'v11');
assert.equal(pipelineForPost({ source_url: 'https://example.com/post' }), 'other');

const now = Date.parse('2026-09-25T12:00:00Z');
assert.equal(shouldRefresh(null, 20, now), true);
assert.equal(shouldRefresh('2026-09-25T10:00:00Z', 3, now), false);
assert.equal(shouldRefresh('2026-09-24T12:00:00Z', 20, now), true);
assert.equal(shouldRefresh('invalid', 20, now), true);
assert.equal(shouldRefresh('2026-09-26T12:00:00Z', 20, now), true);
assert.equal(buildSnapshotId('post-123', '2026-09-25T12:00:00Z'), 'post-123-1790337600000');

const report = buildReport({
  candidates: 2,
  saved: 2,
  pending: 0,
  failures: 0,
  results: [
    { post: { source_url: 'https://github.com/example/repo' }, metrics: { reactions: { value: 3 }, engagementRate: { value: 10 } } },
    { post: { source_url: 'v11://agent-reliability/123' }, metrics: { comments: { value: 2 } } },
  ],
});
assert.equal(report.pipelines.v9.posts, 1);
assert.equal(report.pipelines.v9.reactions, 3);
assert.equal(report.pipelines.v9.engagementRate, 10);
assert.equal(report.pipelines.v11.posts, 1);
assert.equal(report.pipelines.v11.comments, 2);

console.log('buffer_metrics_collector tests passed');
