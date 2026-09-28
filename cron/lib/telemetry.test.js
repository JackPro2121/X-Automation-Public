/**
 * Regression tests for generation telemetry.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Every quality lever in this codebase is sampled per generation: the post SHAPE,
 * the DERIVATION MODE, and — through the Gemini → OpenRouter → Groq chain — the
 * writer MODEL. Until now none of the three was recorded anywhere.
 *
 * The consequence is specific and blocking: `hasInformationDelta()` is in shadow
 * mode awaiting a decision, and that decision needs a pass-rate measured on
 * Gemini sliced by shape and mode. With nothing recorded, the gate can only be
 * flipped on faith — which is exactly how the `one_liner` shape (target [80,200]
 * against a 280 floor) shipped as a guaranteed-failure slot.
 *
 * These tests pin the two things that can silently break it:
 *   1. The selection must be readable after a prompt is built.
 *   2. Persisting telemetry must NEVER be the reason a post is lost — if the
 *      migration has not run, the insert must retry without the new columns.
 *
 * Run: node cron/lib/telemetry.test.js
 */

import assert from 'node:assert/strict';

const { buildTweetPrompt, getLastPromptSelection, POST_SHAPES } = await import('./groqClient.js');
const { insertGeneratedPost } = await import('./utils.js');

// ─── 1. The selection is recorded when a prompt is built ─────────────────────
// Shape and derivation are sampled INSIDE buildTweetPrompt, so this side-channel
// is the only way a caller that writes the DB row can learn what was used.
{
  const sel0 = getLastPromptSelection();
  assert.ok('shapeId' in sel0 && 'derivationId' in sel0, 'selection must expose shapeId and derivationId');

  buildTweetPrompt({ title: 'A source headline with 47% more numbers than usual' }, false);

  const sel = getLastPromptSelection();
  assert.ok(sel.shapeId, 'a shape must be recorded after building a prompt');
  assert.ok(
    POST_SHAPES.some((s) => s.id === sel.shapeId),
    `recorded shape '${sel.shapeId}' must be a real POST_SHAPES id`
  );
  assert.ok(sel.derivationId, 'a derivation mode must be recorded after building a prompt');
}

// ─── 2. It reflects the MOST RECENT call, not the first ──────────────────────
// A stale value would attribute post N's shape to post N+1 — worse than no data,
// because it looks trustworthy.
{
  const seen = new Set();
  for (let i = 0; i < 25; i++) {
    buildTweetPrompt({ title: `Headline number ${i} about caching layers` }, false);
    seen.add(getLastPromptSelection().shapeId);
  }
  assert.ok(seen.size >= 2, `selection must vary across calls (saw ${[...seen].join(', ')}) — a constant would make the data useless`);
}

// ─── 3. It returns a COPY, not the live object ───────────────────────────────
// Callers spread this into DB rows. Handing out the internal reference would let
// one caller mutate another's telemetry.
{
  const a = getLastPromptSelection();
  a.shapeId = 'TAMPERED';
  const b = getLastPromptSelection();
  assert.notEqual(b.shapeId, 'TAMPERED', 'mutating the returned object must not affect the stored selection');
}

// ─── 4. Telemetry is attached to the row, not dropped on the floor ───────────
// A fake Supabase client that records what it was asked to insert.
{
  const inserted = [];
  const fake = { from: () => ({ insert: async (row) => { inserted.push(row); return { error: null }; } }) };

  const res = await insertGeneratedPost(fake, { id: 'v3_test', generated_text: 'hello' }, {
    model: 'gemini',
    shape: 'field_note',
    derivation: 'consequence',
  });

  assert.equal(res.ok, true, 'insert must succeed');
  assert.equal(inserted.length, 1, 'exactly one insert');
  assert.equal(inserted[0].model_used, 'gemini');
  assert.equal(inserted[0].shape_used, 'field_note');
  assert.equal(inserted[0].derivation_used, 'consequence');
  assert.equal(inserted[0].id, 'v3_test', 'the original row fields must survive');
}

// ─── 5. …but a missing migration must never lose the post ────────────────────
// This is the failure mode that matters: pre-migration, Supabase rejects unknown
// columns. The post must still be saved, minus telemetry, with a warning.
{
  const attempts = [];
  const fake = {
    from: () => ({
      insert: async (row) => {
        attempts.push({ ...row });
        if ('model_used' in row) {
          return { error: { message: "column \"model_used\" does not exist" } };
        }
        return { error: null };
      },
    }),
  };

  const res = await insertGeneratedPost(fake, { id: 'v3_pre_migration', generated_text: 'hello' }, {
    model: 'gemini',
    shape: 'hot_take',
    derivation: 'comparison',
  });

  assert.equal(attempts.length, 2, 'must retry once without the telemetry columns');
  assert.ok(!('model_used' in attempts[1]), 'the retry must drop model_used');
  assert.ok(!('shape_used' in attempts[1]), 'the retry must drop shape_used');
  assert.ok(!('derivation_used' in attempts[1]), 'the retry must drop derivation_used');
  assert.equal(attempts[1].id, 'v3_pre_migration', 'the post itself must survive the retry');
  assert.equal(res.ok, true, 'the post must be considered saved');
  assert.equal(res.telemetryDropped, true, 'the drop must be reported so it is not silent');
}

// ─── 6. A genuine insert error is still an error ─────────────────────────────
// The fallback must not swallow real failures — only the missing-column case.
{
  const fake = {
    from: () => ({
      insert: async () => ({ error: { message: 'duplicate key value violates unique constraint' } }),
    }),
  };

  const res = await insertGeneratedPost(fake, { id: 'dup' }, { model: 'gemini' });
  assert.equal(res.ok, false, 'a real error must be reported as a failure');
  assert.match(res.error, /duplicate key/, 'the reason must be surfaced');
}

// ─── 7. Absent telemetry must not create null columns needlessly ─────────────
// v6 reads its shape off the client and a thread path has no model; passing
// undefined must omit the key rather than write a null.
{
  const inserted = [];
  const fake = { from: () => ({ insert: async (row) => { inserted.push(row); return { error: null }; } }) };

  await insertGeneratedPost(fake, { id: 'plain' }, {});
  assert.ok(!('model_used' in inserted[0]), 'undefined model must not produce a model_used key');
  assert.ok(!('shape_used' in inserted[0]), 'undefined shape must not produce a shape_used key');
}

console.log('✓ telemetry checks passed (selection recorded + varies + copied, attached to row, pre-migration fallback without data loss, real errors surfaced, undefined omitted)');
