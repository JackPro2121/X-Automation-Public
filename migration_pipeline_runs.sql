-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION: Add pipeline_runs logging table
-- Run this in Supabase Dashboard → SQL Editor → New Query → Paste → Run
-- Date: 2026-07-24
-- ═══════════════════════════════════════════════════════════════════════════════

-- Pipeline Runs Logging Table
-- Records every v3, v4, and auto_poster pipeline execution
-- Tracks: subreddit, selected post, generated text, image, Buffer ID,
--         Apify key status, success/failure, timing, Slack notification

CREATE TABLE IF NOT EXISTS pipeline_runs (
    id TEXT PRIMARY KEY,
    pipeline TEXT NOT NULL,                    -- 'v3', 'v4', 'auto_poster'
    status TEXT DEFAULT 'running',             -- 'running', 'success', 'failed', 'no_posts'
    subreddit TEXT,                            -- which subreddit was scraped
    selected_post_title TEXT,                  -- Reddit post title
    selected_post_url TEXT,                    -- Reddit post URL
    selected_post_upvotes INTEGER,             -- Reddit upvotes
    generated_text TEXT,                       -- tweet text (MiMo output)
    image_url TEXT,                            -- image URL attached to post
    buffer_post_id TEXT,                       -- Buffer API post ID
    error_message TEXT,                        -- error message if failed
    apify_keys_status JSONB,                   -- multi-key status snapshot
    started_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()),
    completed_at TIMESTAMP WITH TIME ZONE,     -- when the run finished
    duration_seconds REAL,                     -- elapsed time in seconds
    slack_sent BOOLEAN DEFAULT FALSE,          -- whether Slack notification was sent
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

-- Indexes for fast dashboard queries
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_created ON pipeline_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline ON pipeline_runs (pipeline, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs (status, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION: Add groq_keys_status & mimo_keys_status columns to pipeline_runs
-- Run this in Supabase Dashboard → SQL Editor → New Query → Paste → Run
-- Date: 2026-08-05
-- Fixes: "Could not find the 'groq_keys_status' column of 'pipeline_runs'"
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE pipeline_runs
    ADD COLUMN IF NOT EXISTS mimo_keys_status JSONB,
    ADD COLUMN IF NOT EXISTS groq_keys_status JSONB;

-- ═══════════════════════════════════════════════════════════════════════════════
-- DONE. Columns added. Logger will now save MiMo + Groq key status snapshots.
-- ═══════════════════════════════════════════════════════════════════════════════
