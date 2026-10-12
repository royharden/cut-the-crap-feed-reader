import { supabase } from "./supabase";
import type { Answers, Item, ScoreRow, BatchRow } from "./types";

export interface FeedResult {
  items: Item[];
  count: number;
  mode: string;
}

export interface JevScoreResult {
  results: Array<{ item_id: string; answers: Answers }>;
  model: string;
  usage: { input_tokens: number } | null;
  latency_ms: number;
  cost_usd: number;
}

/** Calls an Edge Function (anon JWT attached by supabase-js) and surfaces its error message. */
async function invoke<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    const ctx = (error as unknown as { context?: Response }).context;
    if (ctx && ctx.status === 429) throw new Error("Daily demo limit reached");
    let message = error.message;
    try {
      const payload = ctx ? await ctx.json() : null;
      if (payload && typeof payload.error === "string") message = payload.error;
    } catch { /* non-JSON error body */ }
    throw new Error(message);
  }
  return data as T;
}

export async function refreshFeeds(mode: "live" | "offline", feeds: string[]): Promise<FeedResult> {
  return invoke<FeedResult>("feeds", { mode, feeds });
}

export async function scoreBatch(
  interests: string,
  items: Array<{ item_id: string; title: string; snippet: string; source: string }>
): Promise<JevScoreResult> {
  return invoke<JevScoreResult>("jev-score", { reader_interests: interests, items });
}

export async function askWhy(item: {
  title: string;
  snippet: string;
  source: string;
  signal: number | null;
}, interests: string, mock: boolean): Promise<string> {
  const data = await invoke<{ text: string }>("llm", { action: "why", item, reader_interests: interests, mock });
  return data.text;
}

export async function askDigest(
  items: Array<{ title: string; url: string; source: string; snippet: string }>,
  interests: string,
  mock: boolean
): Promise<string[]> {
  const data = await invoke<{ bullets: string[] }>("llm", { action: "digest", items, reader_interests: interests, mock });
  return data.bullets;
}

export async function fetchItems(): Promise<Item[]> {
  const { data, error } = await supabase
    .from("items")
    .select("*")
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(300);
  if (error) throw new Error(error.message);
  return (data ?? []) as Item[];
}

export async function fetchScores(): Promise<ScoreRow[]> {
  const { data, error } = await supabase.from("scores").select("*");
  if (error) throw new Error(error.message);
  return (data ?? []) as ScoreRow[];
}

export async function fetchBatches(): Promise<BatchRow[]> {
  const { data, error } = await supabase
    .from("batches")
    .select("id, item_count, jev_request, jev_response, latency_ms, created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as BatchRow[];
}

// Writes go through the feeds Edge Function (service role); the browser only has read access.

export async function recordFeedback(itemId: string, kind: "false_hide" | "false_keep"): Promise<void> {
  await invoke("feeds", { action: "feedback", item_id: itemId, kind });
}

export async function addSource(url: string): Promise<void> {
  await invoke("feeds", { action: "add_source", url });
}

export async function removeSource(id: string): Promise<void> {
  await invoke("feeds", { action: "remove_source", id });
}
