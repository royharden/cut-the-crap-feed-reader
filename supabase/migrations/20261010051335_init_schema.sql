/*
# Cut the Crap — initial schema

1. New Tables
- batches: one row per Jev batch request (item_count, jev_request, jev_response, latency_ms)
- items: normalized feed items (HN + RSS + demo bundle)
- scores: one Jev scoring record per item (answers jsonb, model, latency, tokens, cost)
- feedback: reader feedback on wrong decisions (false_hide / false_keep)
- sources: user-added RSS/Atom feed URLs
- usage_counters: per-day per-function call counter for the daily demo cap

2. Security
- RLS enabled on all six tables with fully permissive anon + authenticated policies.
- This is an intentional single public demo workspace with no auth, so USING (true)
  / WITH CHECK (true) is correct here because all data is deliberately shared.

3. Notes
- Idempotent (IF NOT EXISTS) so the migration can safely be re-run.
- Edge functions use the service role key server-side and bypass RLS; these policies
  let the anon-key browser client read and write everything directly.
*/

CREATE TABLE IF NOT EXISTS batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_count int NOT NULL DEFAULT 0,
  jev_request jsonb,
  jev_response jsonb,
  latency_ms int,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  external_id text NOT NULL,
  title text NOT NULL,
  url text NOT NULL DEFAULT '',
  author text,
  published_at timestamptz,
  snippet text NOT NULL DEFAULT '',
  points int,
  comments int,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS items_published_idx ON items (published_at DESC);

CREATE TABLE IF NOT EXISTS scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE,
  batch_id uuid REFERENCES batches(id),
  answers jsonb NOT NULL,
  model text NOT NULL,
  latency_ms int,
  input_tokens int,
  cost_usd numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_counters (
  day date NOT NULL,
  fn text NOT NULL,
  calls int NOT NULL DEFAULT 0,
  PRIMARY KEY (day, fn)
);

ALTER TABLE batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_select_batches" ON batches;
CREATE POLICY "public_select_batches" ON batches FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "public_insert_batches" ON batches;
CREATE POLICY "public_insert_batches" ON batches FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "public_update_batches" ON batches;
CREATE POLICY "public_update_batches" ON batches FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "public_delete_batches" ON batches;
CREATE POLICY "public_delete_batches" ON batches FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "public_select_items" ON items;
CREATE POLICY "public_select_items" ON items FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "public_insert_items" ON items;
CREATE POLICY "public_insert_items" ON items FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "public_update_items" ON items;
CREATE POLICY "public_update_items" ON items FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "public_delete_items" ON items;
CREATE POLICY "public_delete_items" ON items FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "public_select_scores" ON scores;
CREATE POLICY "public_select_scores" ON scores FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "public_insert_scores" ON scores;
CREATE POLICY "public_insert_scores" ON scores FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "public_update_scores" ON scores;
CREATE POLICY "public_update_scores" ON scores FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "public_delete_scores" ON scores;
CREATE POLICY "public_delete_scores" ON scores FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "public_select_feedback" ON feedback;
CREATE POLICY "public_select_feedback" ON feedback FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "public_insert_feedback" ON feedback;
CREATE POLICY "public_insert_feedback" ON feedback FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "public_update_feedback" ON feedback;
CREATE POLICY "public_update_feedback" ON feedback FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "public_delete_feedback" ON feedback;
CREATE POLICY "public_delete_feedback" ON feedback FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "public_select_sources" ON sources;
CREATE POLICY "public_select_sources" ON sources FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "public_insert_sources" ON sources;
CREATE POLICY "public_insert_sources" ON sources FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "public_update_sources" ON sources;
CREATE POLICY "public_update_sources" ON sources FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "public_delete_sources" ON sources;
CREATE POLICY "public_delete_sources" ON sources FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "public_select_usage_counters" ON usage_counters;
CREATE POLICY "public_select_usage_counters" ON usage_counters FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "public_insert_usage_counters" ON usage_counters;
CREATE POLICY "public_insert_usage_counters" ON usage_counters FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "public_update_usage_counters" ON usage_counters;
CREATE POLICY "public_update_usage_counters" ON usage_counters FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "public_delete_usage_counters" ON usage_counters;
CREATE POLICY "public_delete_usage_counters" ON usage_counters FOR DELETE TO anon, authenticated USING (true);
