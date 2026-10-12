import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MAX_ATTEMPTS = 2;
const UPSTREAM_TIMEOUT_MS = 30_000;

// Daily cap on paid upstream calls
const COUNTER_FN = "llm";
const DEFAULT_DAILY_LIMIT = 200;

// Request bounds
const MAX_BODY_BYTES = 64 * 1024;
const MAX_DIGEST_ITEMS = 10;
const MAX_INTERESTS_CHARS = 500;
const MAX_TITLE_CHARS = 500;
const MAX_SNIPPET_CHARS = 2000;
const MAX_SOURCE_CHARS = 100;
const MAX_URL_CHARS = 2048;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type UpstreamFailure = "daily_limit" | "cap_unavailable" | "upstream_error";

class UpstreamError extends Error {
  constructor(readonly kind: UpstreamFailure) {
    super(kind);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function serviceClient(): SupabaseClient | null {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function readJsonBody(req: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, "Request body too large");
  let text = "";
  if (req.body) {
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new HttpError(413, "Request body too large");
      }
      chunks.push(value);
    }
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      buf.set(c, offset);
      offset += c.byteLength;
    }
    text = new TextDecoder().decode(buf);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function dailyLimit(): number {
  const raw = Deno.env.get("DAILY_CALL_LIMIT")?.trim();
  if (!raw) return DEFAULT_DAILY_LIMIT;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0) return n;
  console.error(`DAILY_CALL_LIMIT is not a non-negative integer; using ${DEFAULT_DAILY_LIMIT}`);
  return DEFAULT_DAILY_LIMIT;
}

/**
 * Counts one paid upstream call against today's cap. Fails closed: an RPC error
 * or a missing / non-integer counter is treated as "cap unavailable".
 */
async function consumeQuota(db: SupabaseClient): Promise<void> {
  let calls: unknown;
  try {
    const { data, error } = await db.rpc("increment_usage_counter", { p_fn: COUNTER_FN });
    if (error) {
      console.error("usage counter RPC failed:", error.message);
      throw new UpstreamError("cap_unavailable");
    }
    calls = data;
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    console.error("usage counter RPC threw:", err);
    throw new UpstreamError("cap_unavailable");
  }
  if (typeof calls !== "number" || !Number.isInteger(calls)) {
    console.error("usage counter returned a non-integer result:", calls);
    throw new UpstreamError("cap_unavailable");
  }
  if (calls > dailyLimit()) throw new UpstreamError("daily_limit");
}

function boundedString(value: unknown, max: number, field: string, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `${field} is required`);
    return "";
  }
  if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
  if (value.length > max) throw new HttpError(422, `${field} is too long`);
  return value;
}

function mockWhy(title: string, snippet: string, signal: number | null): string {
  if (signal !== null && signal < 1) {
    return `Probably skip: "${title.slice(0, 60)}" looks light on specifics and mostly promotion or filler.`;
  }
  const gist = snippet.slice(0, 120).replace(/\s+\S*$/, "");
  return `Worth a look: ${gist} — this touches topics you follow, with concrete detail in the excerpt.`;
}

function mockDigest(items: Array<{ title: string; url: string; source: string }>): string[] {
  return items.slice(0, 5).map(
    (it, i) =>
      `${i + 1}. [${it.source}] ${it.title} — the top-ranked item in today's feed, per Jev's signal scoring. (${it.url})`
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One chat completion. Every attempt (including the retry) is counted against
 * the daily cap first. Retries once, only on 429/529 or a network error.
 */
async function callOpenAI(
  db: SupabaseClient,
  apiKey: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number
): Promise<string | null> {
  const baseUrl = (Deno.env.get("OPENAI_BASE_URL") || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
  let delay = 500;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await consumeQuota(db);
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      console.error(`OpenAI network error (attempt ${attempt}):`, (err as Error).message);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(delay);
        delay *= 2;
        continue;
      }
      throw new UpstreamError("upstream_error");
    }
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const content = data?.choices?.[0]?.message?.content;
      return typeof content === "string" ? content : null;
    }
    const detail = await res.text().catch(() => "");
    console.error(`OpenAI request failed (${res.status}, attempt ${attempt}):`, detail.slice(0, 2000));
    if ((res.status === 429 || res.status === 529) && attempt < MAX_ATTEMPTS) {
      await sleep(delay);
      delay *= 2;
      continue;
    }
    throw new UpstreamError("upstream_error");
  }
  throw new UpstreamError("upstream_error");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    const action = body.action;
    const mock = body.mock === true;
    const interests = boundedString(body.reader_interests, MAX_INTERESTS_CHARS, "reader_interests") || "technology";
    const apiKey = Deno.env.get("OPENAI_API_KEY");

    if (action === "why") {
      const raw = body.item;
      if (!raw || typeof raw !== "object") throw new HttpError(400, "item is required");
      const item = raw as Record<string, unknown>;
      const title = boundedString(item.title, MAX_TITLE_CHARS, "title");
      const snippet = boundedString(item.snippet, MAX_SNIPPET_CHARS, "snippet");
      const source = boundedString(item.source, MAX_SOURCE_CHARS, "source");
      const signal = typeof item.signal === "number" && Number.isFinite(item.signal) ? item.signal : null;

      if (mock || !apiKey) {
        return json({ text: mockWhy(title, snippet, signal), mock: true });
      }
      const db = serviceClient();
      if (!db) {
        console.error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured");
        return json({ error: "Service unavailable" }, 503);
      }
      const prompt = `A reader is interested in: ${interests}.
Feed item from ${source || "a feed"}:
Title: ${title}
Excerpt: ${snippet.slice(0, 400)}

Write ONE sentence on why this item might matter to this reader. If it is low signal (vague, promotional, or filler), start with "Probably skip:" instead.`;
      const text = await callOpenAI(db, apiKey, [{ role: "user", content: prompt }], 120);
      return json({ text: text ?? mockWhy(title, snippet, signal), mock: !text });
    }

    if (action === "digest") {
      const rawItems = body.items ?? [];
      if (!Array.isArray(rawItems)) throw new HttpError(400, "items must be an array");
      if (rawItems.length > MAX_DIGEST_ITEMS) throw new HttpError(422, `At most ${MAX_DIGEST_ITEMS} items per digest`);
      const items = rawItems.map((raw) => {
        if (!raw || typeof raw !== "object") throw new HttpError(400, "Invalid item");
        const it = raw as Record<string, unknown>;
        return {
          title: boundedString(it.title, MAX_TITLE_CHARS, "title"),
          url: boundedString(it.url, MAX_URL_CHARS, "url"),
          source: boundedString(it.source, MAX_SOURCE_CHARS, "source"),
          snippet: boundedString(it.snippet, MAX_SNIPPET_CHARS, "snippet"),
        };
      });

      if (mock || !apiKey) {
        return json({ bullets: mockDigest(items), mock: true });
      }
      const db = serviceClient();
      if (!db) {
        console.error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured");
        return json({ error: "Service unavailable" }, 503);
      }
      const list = items
        .map((it, i) => `${i + 1}. ${it.title} (${it.source}) — ${it.snippet.slice(0, 200)} ${it.url}`)
        .join("\n");
      const prompt = `Write a 5-bullet digest of today's top feed items for a reader interested in: ${interests}.
One bullet per item, include the link, no preamble.

Items:
${list}`;
      const text = await callOpenAI(db, apiKey, [{ role: "user", content: prompt }], 500);
      const bullets = text
        ? text.split("\n").map((l) => l.replace(/^[\s\-*\d.]+/, "")).filter(Boolean).slice(0, 5)
        : mockDigest(items);
      return json({ bullets, mock: !text });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    if (err instanceof UpstreamError) {
      if (err.kind === "daily_limit") return json({ error: "daily_limit" }, 429);
      if (err.kind === "cap_unavailable") return json({ error: "Usage cap unavailable, try again later" }, 503);
      return json({ error: "LLM request failed" }, 502);
    }
    console.error("llm failed:", err);
    return json({ error: "llm failed" }, 500);
  }
});
