/**
 * Tests for the GitHub client used by the v9 Repo Spotlight pipeline.
 *
 * Run: node cron/lib/githubClient.test.js
 */

import assert from 'node:assert/strict';

const { isPostableRepo, repoToPost, currentTopic, topicIndexForPostCount } = await import('./githubClient.js');

const baseRepo = {
  full_name: 'acme/cool-cli',
  html_url: 'https://github.com/acme/cool-cli',
  description: 'A fast CLI for automating release notes from git history',
  stargazers_count: 2400,
  language: 'Rust',
  topics: ['cli', 'automation'],
  fork: false,
  archived: false,
  disabled: false,
  pushed_at: '2026-09-18T00:00:00Z',
};

// ─── isPostableRepo ──────────────────────────────────────────────────────────
assert.equal(isPostableRepo(baseRepo), true, 'a well-formed repo is postable');
assert.equal(isPostableRepo(null), false);
assert.equal(isPostableRepo({ ...baseRepo, description: 'too short' }), false, 'thin description rejected');
assert.equal(isPostableRepo({ ...baseRepo, description: null }), false, 'missing description rejected');
assert.equal(isPostableRepo({ ...baseRepo, fork: true }), false, 'forks rejected');
assert.equal(isPostableRepo({ ...baseRepo, archived: true }), false, 'archived repos rejected');
assert.equal(isPostableRepo({ ...baseRepo, disabled: true }), false, 'disabled repos rejected');
assert.equal(isPostableRepo({ ...baseRepo, stargazers_count: 100 }), false, 'below the star floor rejected');

// ─── repoToPost normalization ────────────────────────────────────────────────
const post = repoToPost(baseRepo);
assert.equal(post.redditUrl, baseRepo.html_url, 'the dedup key must be the canonical repo URL');
assert.equal(post.imageUrl, null, 'v9 never attaches a borrowed image');
assert.equal(post.source, 'github');
assert.equal(post.subreddit, 'github');
assert.equal(post.upvotes, 2400, 'stars map onto the engagement field');
assert.equal(post.repo.starsLabel, '2.4k');
assert.equal(post.repo.fullName, 'acme/cool-cli');
assert.ok(post.title.includes('acme/cool-cli'));
assert.ok(post.title.includes('automating release notes'));
assert.ok(post.selftext.includes('Stars: 2400'));
assert.ok(post.selftext.includes('Rust'));

// ─── currentTopic rotation ───────────────────────────────────────────────────
const t1 = currentTopic(0);
const t2 = currentTopic(0);
assert.deepEqual(t1, t2, 'same slot must resolve to the same topic');
assert.ok(t1.topic.length > 0 && t1.label.length > 0);
assert.notDeepEqual(currentTopic(0), currentTopic(1), 'adjacent slots rotate the topic');

// ─── topicIndexForPostCount: drift-immune daily rotation ─────────────────────
// Regression: v9 used a 12-hour wall-clock slot, but it runs 3x/day at 14/18/21
// UTC — all inside the same 12h bucket — so every post used one topic. The index
// now comes from the day's post count, which cannot be collapsed by cron drift.
assert.equal(topicIndexForPostCount(0), 0);
assert.equal(topicIndexForPostCount(1), 1);
assert.equal(topicIndexForPostCount(2), 2);

const dailyTopics = [0, 1, 2].map(i => currentTopic(topicIndexForPostCount(i)).topic);
assert.equal(new Set(dailyTopics).size, 3, `the 3 daily runs must use 3 distinct topics, got ${dailyTopics.join(',')}`);

// Unknown count (Supabase count query failed -> -1) must not produce a bad index.
assert.equal(topicIndexForPostCount(-1), 0, 'negative count falls back to slot 0');
assert.equal(topicIndexForPostCount(NaN), 0, 'NaN falls back to slot 0');
assert.equal(topicIndexForPostCount(undefined), 0, 'undefined falls back to slot 0');

// Wraps cleanly once a full cycle is exhausted.
assert.equal(topicIndexForPostCount(10), 0, 'wraps at the pool size');
assert.equal(topicIndexForPostCount(11), 1);

console.log('✅ githubClient.test.js — all assertions passed');
