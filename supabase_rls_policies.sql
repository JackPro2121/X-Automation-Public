-- Run in Supabase SQL Editor after tables exist.
-- GitHub Actions uses service_role and bypasses RLS. The unauthenticated
-- dashboard is deliberately read-only until Supabase Auth is implemented.

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
  -- Remove every legacy anonymous policy, including the previous full-CRUD one.
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

  -- Public dashboard data may be viewed, but never changed with the public anon key.
  -- pipeline_runs and api_keys remain service_role-only.
  FOREACH t IN ARRAY ARRAY[
    'creators', 'configs', 'viral_posts', 'generated_posts',
    'audience_gaps', 'pipeline_settings'
  ]
  LOOP
    EXECUTE format('CREATE POLICY anon_select ON %I FOR SELECT TO anon USING (true)', t);
  END LOOP;
END $$;
