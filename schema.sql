-- Create creators table
CREATE TABLE creators (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar TEXT,
    category TEXT,
    followers_count INTEGER DEFAULT 0,
    posts_count INTEGER DEFAULT 0,
    bio TEXT,
    verified BOOLEAN DEFAULT FALSE,
    last_scraped TEXT,
    top_virality_score INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

-- Create configs table
CREATE TABLE configs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,
    target_icp TEXT,
    niche_focus TEXT,
    brand_voice TEXT,
    content_pillars JSONB DEFAULT '[]'::jsonb,
    hook_analysis_rules JSONB DEFAULT '[]'::jsonb,
    custom_ctas JSONB DEFAULT '[]'::jsonb,
    website_url TEXT,
    active BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

-- Create viral_posts table
CREATE TABLE viral_posts (
    id TEXT PRIMARY KEY,
    creator_handle TEXT,
    creator_name TEXT,
    creator_avatar TEXT,
    text TEXT,
    likes INTEGER DEFAULT 0,
    retweets INTEGER DEFAULT 0,
    replies INTEGER DEFAULT 0,
    virality_score INTEGER DEFAULT 0,
    hook_type TEXT,
    post_url TEXT,
    posted_at TEXT,
    has_media BOOLEAN DEFAULT FALSE,
    media_type TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

-- Create generated_posts table
CREATE TABLE generated_posts (
    id TEXT PRIMARY KEY,
    original_post_id TEXT,
    creator_handle TEXT,
    creator_name TEXT,
    creator_avatar TEXT,
    original_text TEXT,
    original_virality_score INTEGER,
    original_hook_type TEXT,
    generated_text TEXT,
    virality_hook_tag TEXT,
    hook_formula_explanation TEXT,
    cta_included TEXT,
    character_count INTEGER,
    infographic JSONB,
    created_at TEXT,
    status TEXT DEFAULT 'draft', -- 'draft', 'approved', 'posting', 'published', 'failed'
    CONSTRAINT valid_status CHECK (status IN ('draft', 'approved', 'posting', 'published', 'failed')),
    source_url TEXT,
    buffer_post_id TEXT,
    error_message TEXT,                  -- why a post landed in 'failed' (Buffer reason etc.)
    retry_count INTEGER DEFAULT 0,
    claimed_at TIMESTAMP WITH TIME ZONE,
    db_created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

-- Create audience_gaps table
CREATE TABLE audience_gaps (
    id TEXT PRIMARY KEY,
    competitor_handle TEXT,
    original_post_snippet TEXT,
    user_reply_comment TEXT,
    unanswered_pain_point TEXT,
    suggested_counter_hook TEXT,
    demand_score INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

-- Create api_keys table (Single row configuration)
CREATE TABLE api_keys (
    id TEXT PRIMARY KEY DEFAULT 'default',
    apify_key TEXT,
    anthropic_key TEXT,
    gemini_key TEXT,
    openai_key TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

-- Create pipeline_settings table (Single row configuration)
CREATE TABLE pipeline_settings (
    id TEXT PRIMARY KEY DEFAULT 'default',
    config_id TEXT,
    source_index INTEGER DEFAULT 0,
    posts_per_creator INTEGER DEFAULT 20,
    lookback_days INTEGER DEFAULT 30,
    min_virality_score INTEGER DEFAULT 85,
    auto_generate_infographics BOOLEAN DEFAULT TRUE,
    include_ctas BOOLEAN DEFAULT TRUE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- INDEXES — Optimize common query patterns
-- ═══════════════════════════════════════════════════════════════════════════════

-- Queue queries: status + date (most critical for auto_poster)
CREATE INDEX IF NOT EXISTS idx_generated_posts_status_date ON generated_posts (status, db_created_at);

-- Queue lock: atomic claim pattern (status = 'approved' for claimNextPost)
CREATE INDEX IF NOT EXISTS idx_generated_posts_approved ON generated_posts (status, db_created_at) WHERE status = 'approved';

-- Creator lookups
CREATE INDEX IF NOT EXISTS idx_creators_handle ON creators (handle);
CREATE INDEX IF NOT EXISTS idx_creators_category ON creators (category);

-- Viral posts filtering
CREATE INDEX IF NOT EXISTS idx_viral_posts_creator_handle ON viral_posts (creator_handle);
CREATE INDEX IF NOT EXISTS idx_viral_posts_virality_score ON viral_posts (virality_score DESC);

-- Audience gaps filtering
CREATE INDEX IF NOT EXISTS idx_audience_gaps_competitor_handle ON audience_gaps (competitor_handle);
CREATE INDEX IF NOT EXISTS idx_audience_gaps_demand_score ON audience_gaps (demand_score DESC);

-- Config active lookup
CREATE INDEX IF NOT EXISTS idx_configs_active ON configs (active) WHERE active = TRUE;

-- Dedup check: source_url + recent posts
CREATE INDEX IF NOT EXISTS idx_generated_posts_source_url ON generated_posts (source_url, db_created_at);

-- Row Level Security: enable + apply policies in supabase_rls_policies.sql
-- (GitHub Actions uses SUPABASE_SERVICE_ROLE_KEY and bypasses RLS.)

-- ═══════════════════════════════════════════════════════════════════════════════
-- PIPELINE RUNS — Logging table for every pipeline execution
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pipeline_runs (
    id TEXT PRIMARY KEY,
    pipeline TEXT NOT NULL,              -- 'v3', 'v4', 'v5', 'catchup', 'auto_poster'
    status TEXT DEFAULT 'running',       -- 'running', 'success', 'failed', 'no_posts'
    subreddit TEXT,                      -- which subreddit was scraped
    selected_post_title TEXT,            -- Reddit post title
    selected_post_url TEXT,              -- Reddit post URL
    selected_post_upvotes INTEGER,       -- Reddit upvotes
    generated_text TEXT,                 -- tweet text (MiMo output)
    image_url TEXT,                      -- image URL attached
    buffer_post_id TEXT,                 -- Buffer API post ID
    error_message TEXT,                  -- error if failed
    apify_keys_status JSONB,             -- multi-key status snapshot
    mimo_keys_status JSONB,              -- MiMo key status snapshot
    groq_keys_status JSONB,              -- Groq key status snapshot
    started_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()),
    completed_at TIMESTAMP WITH TIME ZONE,
    duration_seconds REAL,               -- elapsed time in seconds
    slack_sent BOOLEAN DEFAULT FALSE,    -- whether Slack notification was sent
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

-- Index for quick dashboard queries
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_created ON pipeline_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline ON pipeline_runs (pipeline, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs (status, created_at DESC);
