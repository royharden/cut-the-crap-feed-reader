/*
# Add check_usage_cap RPC for the daily demo limit

1. New Functions
- check_usage_cap(p_fn text): SECURITY DEFINER. Atomically increments today's
  usage_counters row for the given function name and raises an error (caught as
  HTTP 429 by callers) once DAILY_CALL_LIMIT (default 200) is passed.

2. Security
- SECURITY DEFINER is required so the counter works under RLS regardless of caller.
- No execution for anon — edge functions call it with the service role key.
*/

CREATE OR REPLACE FUNCTION check_usage_cap(p_fn text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int;
  v_calls int;
BEGIN
  SELECT COALESCE(
    NULLIF(current_setting('app.daily_call_limit', true), '')::int,
    200
  )
  INTO v_limit;

  INSERT INTO usage_counters (day, fn, calls)
  VALUES (current_date, p_fn, 1)
  ON CONFLICT (day, fn) DO UPDATE SET calls = usage_counters.calls + 1
  RETURNING calls INTO v_calls;

  IF v_calls > v_limit THEN
    RAISE EXCEPTION 'Daily demo limit reached' USING ERRCODE = '53000';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION check_usage_cap(text) FROM anon, authenticated;
