CREATE TABLE IF NOT EXISTS buffer_post_metrics (
    id TEXT PRIMARY KEY,
    buffer_post_id TEXT NOT NULL,
    generated_post_id TEXT,
    channel_id TEXT,
    metrics_updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
    collected_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT TIMEZONE('utc'::text, NOW()),
    metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_buffer_post_metrics_post_updated
    ON buffer_post_metrics (buffer_post_id, metrics_updated_at);

CREATE INDEX IF NOT EXISTS idx_buffer_post_metrics_generated_post
    ON buffer_post_metrics (generated_post_id, metrics_updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_buffer_post_metrics_updated
    ON buffer_post_metrics (metrics_updated_at DESC);

-- RLS: metrics are server-side only (collector uses service_role, which bypasses
-- RLS). No anon/authenticated policy is created, so nothing is readable or
-- writable from a browser. Idempotent — safe to re-run on an existing table.
ALTER TABLE buffer_post_metrics ENABLE ROW LEVEL SECURITY;
