/**
 * Tests for the v10 editorial topic bank.
 *
 * Run: node cron/lib/insightTopics.test.js
 */

import assert from 'node:assert/strict';

const { TOPICS, pickTopics, topicDedupUrl } = await import('./insightTopics.js');

// ─── Bank size ───────────────────────────────────────────────────────────────
// 2 posts/day against a 30-day dedup window needs >= 60 topics, or the bank
// runs dry before the first topic's cooldown expires.
assert.ok(TOPICS.length >= 60, `bank should hold >= 60 topics, has ${TOPICS.length}`);

// ─── Slugs unique, topics fully formed ───────────────────────────────────────
const slugs = new Set(TOPICS.map((t) => t.slug));
assert.equal(slugs.size, TOPICS.length, 'topic slugs must be unique');
for (const t of TOPICS) {
  assert.ok(t.slug && t.category && t.title && t.angle, `topic ${t.slug || '?'} is missing a field`);
}

// ─── Dedup URL shape ─────────────────────────────────────────────────────────
assert.equal(topicDedupUrl(TOPICS[0]), `insight://${TOPICS[0].slug}`);
assert.match(topicDedupUrl(TOPICS[0]), /^insight:\/\/[a-z0-9-]+$/, 'dedup URL must be a stable slug key');

// ─── Rotation ────────────────────────────────────────────────────────────────
const day = new Date(Date.UTC(2026, 8, 19));
const order1 = pickTopics(day).map((t) => t.slug);
const order2 = pickTopics(day).map((t) => t.slug);
assert.deepEqual(order1, order2, 'same day must produce the same order');
assert.equal(order1.length, TOPICS.length, 'rotation returns the whole bank');
assert.equal(new Set(order1).size, TOPICS.length, 'rotation covers every topic exactly once');

const nextDayFirst = pickTopics(new Date(Date.UTC(2026, 8, 20)))[0].slug;
assert.notEqual(order1[0], nextDayFirst, 'consecutive days must start on different topics');

console.log('✅ insightTopics.test.js — all assertions passed');
