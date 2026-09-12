-- SECURITY HARDENING MIGRATION
-- Run once in Supabase SQL Editor. It makes the unauthenticated dashboard
-- read-only and leaves all writes to GitHub Actions service_role credentials.

ALTER TABLE creators ENABLE ROW LEVEL SECURITY;
ALTER TABLE configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE viral_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE generated_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE audience_gaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_runs ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'creators', 'configs', 'viral_posts', 'generated_posts',
    'audience_gaps', 'pipeline_settings', 'pipeline_runs', 'api_keys'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS app_anon_all ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS anon_select ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS anon_insert ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS anon_update ON %I', t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY[
    'creators', 'configs', 'viral_posts', 'generated_posts',
    'audience_gaps', 'pipeline_settings'
  ]
  LOOP
    EXECUTE format('CREATE POLICY anon_select ON %I FOR SELECT TO anon USING (true)', t);
  END LOOP;
END $$;
