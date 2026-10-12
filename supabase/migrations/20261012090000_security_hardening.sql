/*
# Security hardening: daily cap counter + client write lockdown

1. usage_counters
- RLS stays on; every anon/authenticated/public policy is dropped and all table
  privileges are revoked from PUBLIC, anon and authenticated. Clients can no
  longer read, insert, update, delete or reset the counters.

2. New Functions
- increment_usage_counter(p_fn text) RETURNS integer: SECURITY DEFINER,
  search_path pinned to public. Atomically bumps today's (UTC) counter row with
  INSERT ... ON CONFLICT DO UPDATE ... RETURNING calls. Edge Functions call it
  with the service-role client right before every paid upstream request and
  compare the result against DAILY_CALL_LIMIT themselves (fail closed on error).
- EXECUTE revoked from PUBLIC, anon, authenticated; granted to service_role only.

3. check_usage_cap(text)
- Kept for compatibility but no longer called by the Edge Functions. EXECUTE was
  only revoked from anon/authenticated before, so it was still callable through
  PUBLIC; it is now revoked from PUBLIC too and granted to service_role only.

4. App data tables (batches, items, scores, feedback, sources)
- All anon/authenticated INSERT/UPDATE/DELETE (and ALL) policies are dropped and
  write privileges revoked. Clients keep SELECT only. Every write now goes
  through an Edge Function using the service-role client with whitelisted
  columns and bounded payloads.
- Defensive CHECK constraints on feedback.kind and sources.url (NOT VALID, so
  existing rows are not rechecked).

5. Notes
- This project has no storage buckets, so there are no storage policies to change.
- Idempotent: safe to re-run.
*/

-- 1. usage_counters -----------------------------------------------------------

ALTER TABLE public.usage_counters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_select_usage_counters" ON public.usage_counters;
DROP POLICY IF EXISTS "public_insert_usage_counters" ON public.usage_counters;
DROP POLICY IF EXISTS "public_update_usage_counters" ON public.usage_counters;
DROP POLICY IF EXISTS "public_delete_usage_counters" ON public.usage_counters;

-- Sweep any other client-facing policy (e.g. one added from the dashboard).
DO $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'usage_counters'
      AND roles && ARRAY['public', 'anon', 'authenticated']::name[]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.usage_counters', p.policyname);
  END LOOP;
END $$;

REVOKE ALL ON TABLE public.usage_counters FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.usage_counters TO service_role;

-- 2. Atomic counter increment ---------------------------------------------------

CREATE OR REPLACE FUNCTION public.increment_usage_counter(p_fn text)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.usage_counters (day, fn, calls)
  VALUES ((now() AT TIME ZONE 'UTC')::date, p_fn, 1)
  ON CONFLICT (day, fn) DO UPDATE SET calls = usage_counters.calls + 1
  RETURNING calls;
$$;

REVOKE EXECUTE ON FUNCTION public.increment_usage_counter(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_usage_counter(text) TO service_role;

-- 3. Lock down the legacy check_usage_cap ---------------------------------------

REVOKE EXECUTE ON FUNCTION public.check_usage_cap(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_usage_cap(text) TO service_role;

-- 4. App data tables: clients read, Edge Functions write --------------------------

ALTER TABLE public.batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_insert_batches" ON public.batches;
DROP POLICY IF EXISTS "public_update_batches" ON public.batches;
DROP POLICY IF EXISTS "public_delete_batches" ON public.batches;

DROP POLICY IF EXISTS "public_insert_items" ON public.items;
DROP POLICY IF EXISTS "public_update_items" ON public.items;
DROP POLICY IF EXISTS "public_delete_items" ON public.items;

DROP POLICY IF EXISTS "public_insert_scores" ON public.scores;
DROP POLICY IF EXISTS "public_update_scores" ON public.scores;
DROP POLICY IF EXISTS "public_delete_scores" ON public.scores;

DROP POLICY IF EXISTS "public_insert_feedback" ON public.feedback;
DROP POLICY IF EXISTS "public_update_feedback" ON public.feedback;
DROP POLICY IF EXISTS "public_delete_feedback" ON public.feedback;

DROP POLICY IF EXISTS "public_insert_sources" ON public.sources;
DROP POLICY IF EXISTS "public_update_sources" ON public.sources;
DROP POLICY IF EXISTS "public_delete_sources" ON public.sources;

-- Sweep any other client-facing write policy on these tables.
DO $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('batches', 'items', 'scores', 'feedback', 'sources')
      AND cmd <> 'SELECT'
      AND roles && ARRAY['public', 'anon', 'authenticated']::name[]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p.policyname, p.tablename);
  END LOOP;
END $$;

-- Re-assert the read-only policies (the sweep above may have removed an ALL policy).
DROP POLICY IF EXISTS "public_select_batches" ON public.batches;
CREATE POLICY "public_select_batches" ON public.batches FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "public_select_items" ON public.items;
CREATE POLICY "public_select_items" ON public.items FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "public_select_scores" ON public.scores;
CREATE POLICY "public_select_scores" ON public.scores FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "public_select_feedback" ON public.feedback;
CREATE POLICY "public_select_feedback" ON public.feedback FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "public_select_sources" ON public.sources;
CREATE POLICY "public_select_sources" ON public.sources FOR SELECT TO anon, authenticated USING (true);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.batches, public.items, public.scores, public.feedback, public.sources
  FROM PUBLIC, anon, authenticated;
GRANT SELECT
  ON TABLE public.batches, public.items, public.scores, public.feedback, public.sources
  TO anon, authenticated;

-- Defensive constraints; NOT VALID so legacy rows never block the migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feedback_kind_check') THEN
    ALTER TABLE public.feedback
      ADD CONSTRAINT feedback_kind_check CHECK (kind IN ('false_hide', 'false_keep')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sources_url_check') THEN
    ALTER TABLE public.sources
      ADD CONSTRAINT sources_url_check
      CHECK (char_length(url) <= 2048 AND url ~* '^https?://') NOT VALID;
  END IF;
END $$;
