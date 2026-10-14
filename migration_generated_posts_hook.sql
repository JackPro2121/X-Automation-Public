-- Migration: add hook_used to generated_posts
--
-- Why: the HOOK ANGLE is a third sampled quality lever, alongside the post
--      SHAPE and the DERIVATION MODE, and it is the one that was visibly
--      failing. Four consecutive live v9 posts (09-24 → 09-26: browser-use,
--      prompts.chat, open-webui, oh-my-openagent) opened with the same
--      construction — "Gated platforms lock your X behind proprietary clouds" —
--      because all five hook angles carried a literal fill-in-the-blank
--      `Structural pattern:` and only five of them existed for three posts a
--      day.
--
--      The angle is now chosen by `pickGitHubHook()`, which excludes recently
--      used angles so a repeat cannot occur within the exclusion window. That
--      rotation is only enforceable if the angle actually used is recorded:
--      without this column the next run cannot know what to avoid, and the
--      repetition cannot be measured after the fact either.
--
--      Same argument as model_used/shape_used/derivation_used: a feed that
--      improves must be distinguishable from one that degrades.
--
-- Safe to run at any time: `insertGeneratedPost()` treats this column as
-- best-effort and retries the insert without it when the migration has not
-- been applied, so no post is ever lost to missing telemetry.
--
-- Run: Supabase SQL Editor (service_role context).

ALTER TABLE generated_posts
    ADD COLUMN IF NOT EXISTS hook_used TEXT;  -- bottleneck | friction | deployment | limitation | ...

-- Supports "which angle performs best" and "did the rotation actually hold".
CREATE INDEX IF NOT EXISTS idx_generated_posts_hook_date
    ON generated_posts (hook_used, db_created_at);
