/**
 * Verify the telemetry insert against the LIVE database.
 *
 * Two things to prove:
 *   1. Does the migration need to be run? (Check whether the columns exist.)
 *   2. Does the code work EITHER WAY? (The pre-migration fallback must save the
 *      post with telemetry dropped, not lose it.)
 *
 * This writes a real row and deletes it. It uses status='draft' so it can never
 * be picked up by anything that consumes the queue, and it cleans up after
 * itself.
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const { insertGeneratedPost, generateId } = await import('../cron/lib/utils.js');

const sb = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const PROBE_ID = generateId('probe');

// ── 1. Do the columns exist? ────────────────────────────────────────────────
console.log('── column check ──');
const { error: colErr } = await sb
  .from('generated_posts')
  .select('model_used, shape_used, derivation_used')
  .limit(1);

if (colErr) {
  console.log(`  ✗ columns NOT present: ${colErr.message}`);
  console.log('  → migration_generated_posts_telemetry.sql must be run in the Supabase SQL editor');
} else {
  console.log('  ✓ all three columns exist');
}

// ── 2. Can we write with telemetry? (Exercises the real fallback path) ──────
console.log('\n── insert probe (status=draft so nothing consumes it) ──');
const res = await insertGeneratedPost(sb, {
  id: PROBE_ID,
  generated_text: 'telemetry probe — safe to delete',
  character_count: 33,
  status: 'draft',
  source_url: 'https://example.invalid/probe',
}, {
  model: 'gemini',
  shape: 'field_note',
  derivation: 'consequence',
});

console.log(`  result: ok=${res.ok}${res.error ? ` error=${res.error}` : ''} telemetryDropped=${res.telemetryDropped ?? false}`);

if (!res.ok) {
  console.log('  ✗ INSERT FAILED — this would lose posts in production');
} else if (res.telemetryDropped) {
  console.log('  ✓ insert succeeded via the PRE-MIGRATION fallback (post saved, telemetry dropped)');
  console.log('    → run the migration to start collecting quality data');
} else {
  console.log('  ✓ insert succeeded WITH telemetry');
}

// ── 3. Read back what actually landed ──────────────────────────────────────
const { data: row, error: readErr } = await sb
  .from('generated_posts')
  .select('*')
  .eq('id', PROBE_ID)
  .maybeSingle();

if (readErr) {
  console.log(`\n  ⚠ read-back failed: ${readErr.message}`);
} else if (!row) {
  console.log('\n  ⚠ probe row not found — insert reported success but nothing is there');
} else {
  console.log('\n── read-back ──');
  console.log(`  model_used      = ${JSON.stringify(row.model_used)}`);
  console.log(`  shape_used      = ${JSON.stringify(row.shape_used)}`);
  console.log(`  derivation_used = ${JSON.stringify(row.derivation_used)}`);
}

// ── 4. Clean up ────────────────────────────────────────────────────────────
const { error: delErr } = await sb.from('generated_posts').delete().eq('id', PROBE_ID);
console.log(`\n${delErr ? `⚠ cleanup failed: ${delErr.message}` : '✓ probe row deleted'}`);
