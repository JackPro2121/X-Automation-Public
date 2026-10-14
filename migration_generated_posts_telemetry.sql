-- Migration: add model_used / shape_used / derivation_used to generated_posts
--
-- Why: the two quality levers in play are both sampled per generation — the post
--      SHAPE (hot_take / field_note / contrarian / teardown / question / punchy)
--      and the DERIVATION MODE (arithmetic / consequence / omission / ...). The
--      writer MODEL also varies across a Gemini → OpenRouter → Groq chain.
--
--      None of the three was ever recorded. The consequence is that a feed which
--      improves looks identical to one that degrades: you cannot attribute any
--      change in quality to the thing that changed, and the measured A/B result
--      (reasoned 0% → 40%) cannot be verified against live output.
--
--      This is the blocker for deciding whether to enforce REQUIRE_INFO_DELTA —
--      that decision needs a pass-rate measured on the model that actually writes
--      (Gemini), sliced by shape and mode.
--
-- Safe to run at any time: every cron write path treats these columns as
-- best-effort and retries without them if the migration has not been applied yet
-- (same pattern as error_message / character_count before it).
--
-- Run: Supabase SQL Editor (service_role context).

ALTER TABLE generated_posts
    ADD COLUMN IF NOT EXISTS model_used TEXT,       -- gemini | openrouter | groq-vision | groq-<model>
    ADD COLUMN IF NOT EXISTS shape_used TEXT,       -- hot_take | field_note | contrarian | ...
    ADD COLUMN IF NOT EXISTS derivation_used TEXT;  -- arithmetic | consequence | omission | ...

-- Supports the quality-trend query this migration exists to enable:
--   "pass-rate of reasoned posts, by shape, over the last 2 weeks"
CREATE INDEX IF NOT EXISTS idx_generated_posts_shape_date
    ON generated_posts (shape_used, db_created_at);

CREATE INDEX IF NOT EXISTS idx_generated_posts_model_date
    ON generated_posts (model_used, db_created_at);
