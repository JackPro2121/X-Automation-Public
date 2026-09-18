import assert from 'node:assert/strict';
import { replyGuardFloor } from './utils.js';

// The reply pipelines (v7) publish via Playwright on a live schedule, so a
// fabricated claim there goes straight out under the account's name.
//
// This test exists because of a real drift: when the fabricated-authority and
// fabricated-experience guards were added, they went into finalizePostText() only.
// Both v7 reply validators kept publishing unguarded for a full session — while
// the v7 prompt was simultaneously asking the model to "frame it from hands-on
// builder experience". The floor now lives in one place; this locks it.

// 1. Fabricated authority must be rejected.
assert.equal(
  replyGuardFloor('Reports indicate the latency improvement is real, but it disappears once you add retrieval to the pipeline.'),
  'cites evidence from a source that was not provided (fabricated authority)'
);
assert.equal(
  replyGuardFloor('Internal documents suggest the team shipped this three weeks before the announcement went out.'),
  'cites evidence from a source that was not provided (fabricated authority)'
);

// 2. Fabricated first-hand experience must be rejected. This is the pattern the
//    v7 prompt was actively soliciting before the prompt was fixed.
assert.equal(
  replyGuardFloor('I ran this in prod last month and the throughput numbers did not hold up past a few thousand requests.'),
  'claims first-hand observation or testing the pipeline never performed'
);
assert.equal(
  replyGuardFloor('In my experience these tools fall over the moment you push past a few thousand concurrent requests.'),
  'claims first-hand observation or testing the pipeline never performed'
);

// 3. Prompt leaks and placeholders must be rejected.
assert.equal(replyGuardFloor(''), 'empty');
assert.equal(replyGuardFloor(null), 'empty');

// 4. Genuine reasoning must PASS — the floor targets fabricated evidence, not
//    opinion. A reply that reasons from the tweet is exactly what we want.
assert.equal(
  replyGuardFloor('The real cost is not the inference, it is the retrieval step. If the index is cold you pay for the whole round trip twice.'),
  null
);
assert.equal(
  replyGuardFloor("My read is that the bottleneck moves to the memory bus once you batch, not the compute."),
  null
);

// 5. Source-similarity is enforced when a source is supplied, and skipped when not.
const tweet = 'We just shipped a new open source model that runs on a single consumer GPU and uses half the memory.';
assert.equal(
  replyGuardFloor('We just shipped a new open source model that runs on a single consumer GPU and uses half the memory.', tweet),
  'too similar to source'
);
assert.equal(
  replyGuardFloor('Half the memory is the interesting part, because it changes how many replicas fit on one card.', tweet),
  null
);
assert.equal(
  replyGuardFloor('Half the memory is the interesting part, because it changes how many replicas fit on one card.'),
  null,
  'with no source supplied, only the fabrication floor applies'
);

// 6. Every rejection reason must be a non-empty, human-readable string — the
//    reason is what an operator sees in the logs at 3am.
for (const bad of [
  'Reports indicate it failed.',
  'I tested this myself and it broke.',
]) {
  const r = replyGuardFloor(bad);
  assert.ok(typeof r === 'string' && r.length > 10, `reason must be descriptive for: ${bad}`);
}

console.log('reply guard floor checks passed');
