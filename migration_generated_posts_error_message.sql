-- Migration: add error_message to generated_posts
-- Why: failed posts previously stored no failure reason, making Buffer
--      rejections undiagnosable. All cron write paths already handle the
--      column being absent (best-effort retry without it), so this migration
--      is safe to run at any time after deploying the code.
-- Run: Supabase SQL Editor (service_role context).

ALTER TABLE generated_posts
    ADD COLUMN IF NOT EXISTS error_message TEXT;
