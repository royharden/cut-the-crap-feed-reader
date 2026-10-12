# Cut the Crap

**Jev reads the feed so you don't have to.**

Cut the Crap is a full-stack demo feed reader that pulls Hacker News and RSS items and hides the AI slop, clickbait, and low-signal posts before they ever reach your eyes.

[Jev](https://typesafe.ai) — TypeSafe AI's fast decision model — acts as "System 1": every item gets scored in batches for **signal**, **slop**, **clickbait**, **relevance**, and **type**. Code (not the model) ranks, hides, or blurs items using thresholds you control with sliders. A full LLM ("System 2") only runs on demand: a one-line "why this matters" when you open an item, and a daily digest of the top items.

## Architecture

```mermaid
graph TD
    UI[React UI<br/>dark reader feed]
    F[feeds function<br/>HN + RSS fetch, normalize, upsert,<br/>sources + feedback writes]
    J[jev-score function<br/>batched TypeSafe System One calls]
    L[llm function<br/>why + digest, on demand]
    DB[(Supabase Postgres<br/>items, scores, batches,<br/>feedback, sources, usage_counters)]

    UI -->|refresh| F
    UI -->|score new items| J
    UI -->|why / digest| L
    F --> DB
    J --> DB
    J --> TS[api.typesafe.ai<br/>jev-1.13.0]
    L --> OA[OpenAI API<br/>optional, mocked without key]
    UI -->|read-only queries| DB
```

## Why a fast calibrated scorer beats asking an LLM to rate every item

- **Batched requests.** Jev answers 5 questions about up to 10 items in a single request. One API call replaces ~50 LLM calls.
- **Roughly 100x cheaper per item.** Jev's input price is $0.042/M tokens; a typical LLM judge costs $2.50/M input + $10/M output at ~150 output tokens per item. The Stats panel computes both live so you can see the savings factor.
- **Thresholds stay in code.** The model returns calibrated probabilities; a pure TypeScript `classify()` function decides keep / blur / hide. That logic is unit-testable and instantly adjustable — no re-prompting.
- **The LLM only runs on demand.** Generating prose for every item would be wasteful. Instead, the "why" button and the digest button invoke the LLM exactly when a human wants to read.

## Setup

1. Create a Supabase project and note the URL + anon key.
2. Apply the migrations in `supabase/migrations` (`supabase db push`).
3. Set secrets (all optional — without them the app runs in Offline demo / Mock LLM mode):
   ```bash
   supabase secrets set TYPESAFE_API_KEY=... OPENAI_API_KEY=... DAILY_CALL_LIMIT=200
   ```
4. Deploy the three edge functions (JWT verification is on for all of them via `supabase/config.toml`):
   ```bash
   supabase functions deploy feeds
   supabase functions deploy jev-score
   supabase functions deploy llm
   ```
5. Run locally:
   ```bash
   npm install
   npm run dev
   ```

## Environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | frontend | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | frontend | Supabase anon key |
| `TYPESAFE_API_KEY` | edge function secret | TypeSafe API key for Jev scoring |
| `OPENAI_API_KEY` | edge function secret | LLM for "why" + digest (mocked if absent) |
| `OPENAI_BASE_URL` | edge function secret | Optional; defaults to `https://api.openai.com/v1` |
| `OPENAI_MODEL` | edge function secret | Optional; defaults to `gpt-4o-mini` |
| `DAILY_CALL_LIMIT` | edge function secret | Optional; default 200 paid upstream calls/day per function |

## Screenshots

![Feed view](screenshots/feed.png)

![Item inspector with Jev's answers](screenshots/inspector.png)

![Stats panel](screenshots/stats.png)

## Design decisions

- **Batching 10 items per request.** Jev prices per request, so packing 10 items × 5 questions into one call amortizes overhead. If a batch is rejected for size, it is split in half and retried.
- **Scoring once per item.** Scores live in a table keyed by item, so refreshes only score new arrivals. Existing items keep their scores forever.
- **The daily cap.** `jev-score` and `llm` atomically increment a `usage_counters` row (via the service-role-only `increment_usage_counter` function) right before every paid TypeSafe/OpenAI request, retries included. Past `DAILY_CALL_LIMIT` (200) they return HTTP 429 and the UI shows a friendly banner and flips to Offline demo mode. If the counter can't be read the call fails closed with HTTP 503.
- **Security model.** The browser only reads tables with the anon key; every write (items, scores, batches, sources, feedback) goes through an Edge Function using the service-role key, with whitelisted columns and bounded payloads. `usage_counters` is not readable or writable by clients at all. User-added feed URLs are fetched through an SSRF guard (http(s) only, DNS-checked on every redirect hop, private/metadata ranges blocked, 10 s timeout, 2 MB cap).
- **Offline demo fallback.** A bundle of 40 hand-written items (solid posts, slop listicles, rage bait, launches) ships inside the `feeds` function. It loads with pre-scored answers (written by the `feeds` function), so the full UI is explorable even with zero API access.
