-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION: Add comment_replies table for v7 Auto-Reply Pipeline
-- Run this in Supabase Dashboard → SQL Editor → New Query → Paste → Run
-- Date: 2026-09-06
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS comment_replies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    comment_id TEXT UNIQUE NOT NULL,               -- X ID of the comment or creator post replied to
    parent_tweet_id TEXT,                          -- Original post ID (for threads/context)
    target_author TEXT NOT NULL,                   -- Username of the person replied to
    target_text TEXT,                              -- Original text of the comment or creator post
    is_verified BOOLEAN DEFAULT FALSE,             -- Whether the target author is verified (blue-check)
    reply_type TEXT NOT NULL CHECK (reply_type IN ('inbound', 'outbound')),
    ai_reply_text TEXT NOT NULL,                   -- Generated reply text from OpenRouter
    x_reply_id TEXT,                               -- Official X reply tweet ID returned by POST /2/tweets
    status TEXT DEFAULT 'published',               -- 'published', 'failed'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

-- Indexes for fast deduplication, creator cooldown checks, and monthly quota counting
CREATE INDEX IF NOT EXISTS idx_comment_replies_comment_id ON comment_replies (comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_replies_target_author ON comment_replies (target_author, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comment_replies_created_at ON comment_replies (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comment_replies_type ON comment_replies (reply_type, created_at DESC);

-- Enable RLS
ALTER TABLE comment_replies ENABLE ROW LEVEL SECURITY;

-- Allow read access for authenticated and service_role
CREATE POLICY "Allow public read access to comment_replies"
    ON comment_replies FOR SELECT USING (true);

-- Allow insert/update for service_role and anon
CREATE POLICY "Allow insert access to comment_replies"
    ON comment_replies FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow update access to comment_replies"
    ON comment_replies FOR UPDATE USING (true);
