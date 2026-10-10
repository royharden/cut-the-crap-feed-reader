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

export async function refreshFeeds(mode: "live" | "offline", feeds: string[]): Promise<FeedResult> {
  const { data, error } = await supabase.functions.invoke("feeds", {
    body: { mode, feeds },
  });
  if (error) {
    const ctx = (error as unknown as { context?: Response }).context;
    if (ctx && ctx.status === 429) throw new Error("Daily demo limit reached");
    throw new Error(error.message);
  }
  return data as FeedResult;
}

export async function scoreBatch(
  interests: string,
  items: Array<{ item_id: string; title: string; snippet: string; source: string }>
): Promise<JevScoreResult> {
  const { data, error } = await supabase.functions.invoke("jev-score", {
    body: { reader_interests: interests, items },
  });
  if (error) {
    const ctx = (error as unknown as { context?: Response }).context;
    if (ctx && ctx.status === 429) throw new Error("Daily demo limit reached");
    throw new Error(error.message);
  }
  return data as JevScoreResult;
}

export async function askWhy(item: {
  title: string;
  snippet: string;
  source: string;
  signal: number | null;
}, interests: string, mock: boolean): Promise<string> {
  const { data, error } = await supabase.functions.invoke("llm", {
    body: { action: "why", item, reader_interests: interests, mock },
  });
  if (error) {
    const ctx = (error as unknown as { context?: Response }).context;
    if (ctx && ctx.status === 429) throw new Error("Daily demo limit reached");
    throw new Error(error.message);
  }
  return (data as { text: string }).text;
}

export async function askDigest(
  items: Array<{ title: string; url: string; source: string; snippet: string }>,
  interests: string,
  mock: boolean
): Promise<string[]> {
  const { data, error } = await supabase.functions.invoke("llm", {
    body: { action: "digest", items, reader_interests: interests, mock },
  });
  if (error) {
    const ctx = (error as unknown as { context?: Response }).context;
    if (ctx && ctx.status === 429) throw new Error("Daily demo limit reached");
    throw new Error(error.message);
  }
  return (data as { bullets: string[] }).bullets;
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

export async function recordFeedback(itemId: string, kind: "false_hide" | "false_keep"): Promise<void> {
  const { error } = await supabase.from("feedback").insert({ item_id: itemId, kind });
  if (error) throw new Error(error.message);
}
