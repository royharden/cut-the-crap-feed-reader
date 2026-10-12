import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-1.13.0";
const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 2;
const UPSTREAM_TIMEOUT_MS = 25_000;
const PRICE_PER_M_INPUT = 0.042;

// Daily cap on paid upstream calls
const COUNTER_FN = "jev-score";
const DEFAULT_DAILY_LIMIT = 200;

// Request bounds
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ITEMS = 20;
const MAX_INTERESTS_CHARS = 500;
const MAX_TITLE_CHARS = 500;
const MAX_SNIPPET_CHARS = 2000;
const MAX_SOURCE_CHARS = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANSWER_FIELDS = new Set(["signal", "slop", "clickbait", "relevant", "type"]);

interface ScoredItem {
  item_id: string;
  title: string;
  snippet: string;
  source: string;
}

interface Answer {
  signal?: { score: number; confidence: number; probabilities: number[] };
  slop?: { noul: number };
  clickbait?: { noul: number };
  relevant?: { noul: number };
  type?: { choice: string; confidence: number; probabilities: number[] };
}

interface JevResponse {
  model?: string;
  answers?: Record<string, unknown>;
  usage?: { input_tokens?: number; prompt_tokens?: number } | null;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type UpstreamFailure = "daily_limit" | "cap_unavailable" | "too_large" | "upstream_error";

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

function parseItems(raw: unknown): ScoredItem[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, "items must be an array");
  if (raw.length > MAX_ITEMS) throw new HttpError(422, `At most ${MAX_ITEMS} items per request`);
  return raw.map((it) => {
    if (!it || typeof it !== "object") throw new HttpError(400, "Invalid item");
    const { item_id, title, snippet, source } = it as Record<string, unknown>;
    if (typeof item_id !== "string" || !UUID_RE.test(item_id)) throw new HttpError(400, "Invalid item_id");
    if (typeof title !== "string" || typeof snippet !== "string" || typeof source !== "string") {
      throw new HttpError(400, "Items need title, snippet and source strings");
    }
    if (title.length > MAX_TITLE_CHARS || snippet.length > MAX_SNIPPET_CHARS || source.length > MAX_SOURCE_CHARS) {
      throw new HttpError(422, "Item field too long");
    }
    return { item_id, title, snippet, source };
  });
}

function buildRequest(interests: string, items: ScoredItem[]) {
  const state: Record<string, unknown> = {
    reader_interests: interests,
    items: Object.fromEntries(
      items.map((it, i) => [`i${i}`, { title: it.title.slice(0, MAX_TITLE_CHARS), snippet: it.snippet.slice(0, 400), source: it.source.slice(0, MAX_SOURCE_CHARS) }])
    ),
  };
  const questions: Array<Record<string, unknown>> = [];
  items.forEach((_, i) => {
    const p = `items.i${i}`;
    questions.push(
      { id: `i${i}__signal`, ref: p, question: `How much real, specific information does item \`${p}\` offer a reader?`, kind: "score", criteria: [
        "None: empty, vague, or pure promotion.",
        "Low: a little substance, mostly filler.",
        "Solid: concrete facts, code, data, or first-hand experience.",
        "High: original research, deep technical detail, or important news.",
      ] },
      { id: `i${i}__slop`, ref: p, question: `Does item \`${p}\` read like generic AI-generated filler?`, kind: "noul", criteria_true: "Generic phrasing, listicle padding, no specific details or voice.", criteria_false: "Has specific details, a clear author voice, or original content." },
      { id: `i${i}__clickbait`, ref: p, question: `Does the title of item \`${p}\` withhold or exaggerate its point to get clicks?`, kind: "noul", criteria_true: "Curiosity gap, outrage, or exaggeration.", criteria_false: "The title plainly states what the item is about." },
      { id: `i${i}__relevant`, ref: p, question: `Is item \`${p}\` related to \`reader_interests\`?`, kind: "noul" },
      { id: `i${i}__type`, ref: p, question: `What kind of item is \`${p}\`?`, kind: "choice", criteria: {
        tutorial: "Teaches how to do something.",
        news: "Reports something that happened.",
        opinion: "An argument or personal take.",
        launch: "Announces a product or release.",
        discussion: "An Ask HN or open question.",
        uncertain: "Doesn't clearly fit.",
      } }
    );
  });
  return { model: MODEL, state, questions };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One TypeSafe request. Every attempt (including the retry) is counted against
 * the daily cap first. Retries once, only on 429/529 or a network error.
 */
async function callTypesafe(db: SupabaseClient, payload: unknown, apiKey: string): Promise<{ data: JevResponse; latency: number }> {
  let delay = 500;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await consumeQuota(db);
    const start = Date.now();
    let res: Response;
    try {
      res = await fetch(TYPESAFE_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      console.error(`TypeSafe network error (attempt ${attempt}):`, (err as Error).message);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(delay);
        delay *= 2;
        continue;
      }
      throw new UpstreamError("upstream_error");
    }
    const latency = Date.now() - start;
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (!data || typeof data !== "object") {
        console.error("TypeSafe returned a non-JSON body");
        throw new UpstreamError("upstream_error");
      }
      console.log("response.model:", (data as JevResponse).model);
      return { data: data as JevResponse, latency };
    }
    const detail = await res.text().catch(() => "");
    console.error(`TypeSafe request failed (${res.status}, attempt ${attempt}):`, detail.slice(0, 2000));
    if ((res.status === 429 || res.status === 529) && attempt < MAX_ATTEMPTS) {
      await sleep(delay);
      delay *= 2;
      continue;
    }
    if (res.status === 413 || (res.status >= 400 && res.status < 500 && /size|too large|batch/i.test(detail))) {
      throw new UpstreamError("too_large");
    }
    throw new UpstreamError("upstream_error");
  }
  throw new UpstreamError("upstream_error");
}

interface Run {
  db: SupabaseClient;
  apiKey: string;
  interests: string;
  results: Array<{ item_id: string; answers: Answer }>;
  totalInputTokens: number;
  totalLatency: number;
  totalCost: number;
}

async function scoreChunk(run: Run, chunk: ScoredItem[], canSplit: boolean): Promise<void> {
  const payload = buildRequest(run.interests, chunk);
  const batchStart = Date.now();
  let resp: { data: JevResponse; latency: number };
  try {
    resp = await callTypesafe(run.db, payload, run.apiKey);
  } catch (err) {
    if (err instanceof UpstreamError && err.kind === "too_large" && canSplit && chunk.length > 1) {
      // Split the batch in half and score each half (each half is counted separately)
      const mid = Math.ceil(chunk.length / 2);
      await scoreChunk(run, chunk.slice(0, mid), false);
      await scoreChunk(run, chunk.slice(mid), false);
      return;
    }
    throw err;
  }
  const batchLatency = Date.now() - batchStart;

  const answersByQuestion = resp.data.answers && typeof resp.data.answers === "object" ? resp.data.answers : {};
  const batchId = crypto.randomUUID();

  const perItem: Record<string, Answer> = {};
  for (const [qid, ans] of Object.entries(answersByQuestion)) {
    const [itemKey, field] = qid.split("__");
    const idx = Number(itemKey.replace("i", ""));
    const itemId = chunk[idx]?.item_id;
    if (!itemId || !field || !ANSWER_FIELDS.has(field)) continue;
    perItem[itemId] = perItem[itemId] ?? {};
    (perItem[itemId] as Record<string, unknown>)[field] = ans;
  }

  // Store batch + scores
  const { error: batchErr } = await run.db.from("batches").insert({
    id: batchId,
    item_count: chunk.length,
    jev_request: payload,
    jev_response: resp.data,
    latency_ms: batchLatency,
  });
  if (batchErr) console.error("batches insert failed:", batchErr.message);

  const usage = resp.data.usage ?? null;
  const rawTokens = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
  const inputTokens = Number.isFinite(rawTokens) && rawTokens > 0 ? rawTokens : 0;
  const cost = (inputTokens * PRICE_PER_M_INPUT) / 1_000_000;
  run.totalInputTokens += inputTokens;
  run.totalLatency += batchLatency;
  run.totalCost += cost;

  const model = typeof resp.data.model === "string" ? resp.data.model.slice(0, 100) : MODEL;
  const scoreRows = Object.entries(perItem).map(([itemId, answers]) => ({
    item_id: itemId,
    batch_id: batchErr ? null : batchId,
    answers,
    model,
    latency_ms: Math.round(batchLatency / chunk.length),
    input_tokens: Math.round(inputTokens / chunk.length),
    cost_usd: cost / chunk.length,
  }));
  if (scoreRows.length) {
    const { error: scoreErr } = await run.db
      .from("scores")
      .upsert(scoreRows, { onConflict: "item_id", ignoreDuplicates: true });
    if (scoreErr) console.error("scores upsert failed:", scoreErr.message);
  }

  for (const it of chunk) {
    run.results.push({ item_id: it.item_id, answers: perItem[it.item_id] ?? {} });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    const interests = body.reader_interests ?? "";
    if (typeof interests !== "string") throw new HttpError(400, "reader_interests must be a string");
    if (interests.length > MAX_INTERESTS_CHARS) throw new HttpError(422, "reader_interests is too long");
    const requested = parseItems(body.items);
    if (requested.length === 0) {
      return json({ results: [], model: MODEL, usage: null, latency_ms: 0, cost_usd: 0 });
    }

    const apiKey = Deno.env.get("TYPESAFE_API_KEY");
    if (!apiKey) return json({ error: "TYPESAFE_API_KEY not configured" }, 503);

    const db = serviceClient();
    if (!db) {
      console.error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured");
      return json({ error: "Service unavailable" }, 503);
    }

    // Score what's stored, not what the client sent: only known items that have
    // no score yet, using their saved title/snippet/source.
    const ids = [...new Set(requested.map((it) => it.item_id))];
    const [{ data: stored, error: itemsErr }, { data: scored, error: scoredErr }] = await Promise.all([
      db.from("items").select("id, title, snippet, source").in("id", ids),
      db.from("scores").select("item_id").in("item_id", ids),
    ]);
    if (itemsErr || scoredErr || !stored || !scored) {
      console.error("item lookup failed:", itemsErr?.message ?? scoredErr?.message);
      return json({ error: "Could not load items" }, 500);
    }
    const alreadyScored = new Set((scored as Array<{ item_id: string }>).map((s) => s.item_id));
    const allItems: ScoredItem[] = (stored as Array<{ id: string; title: string; snippet: string; source: string }>)
      .filter((row) => !alreadyScored.has(row.id))
      .map((row) => ({ item_id: row.id, title: row.title ?? "", snippet: row.snippet ?? "", source: row.source ?? "" }));

    const run: Run = { db, apiKey, interests, results: [], totalInputTokens: 0, totalLatency: 0, totalCost: 0 };
    for (let i = 0; i < allItems.length; i += BATCH_SIZE) {
      await scoreChunk(run, allItems.slice(i, i + BATCH_SIZE), true);
    }

    return json({
      results: run.results,
      model: MODEL,
      usage: { input_tokens: run.totalInputTokens },
      latency_ms: run.totalLatency,
      cost_usd: Number(run.totalCost.toFixed(8)),
    });
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    if (err instanceof UpstreamError) {
      if (err.kind === "daily_limit") return json({ error: "daily_limit" }, 429);
      if (err.kind === "cap_unavailable") return json({ error: "Usage cap unavailable, try again later" }, 503);
      return json({ error: "Jev scoring request failed" }, 502);
    }
    console.error("jev-score failed:", err);
    return json({ error: "jev-score failed" }, 500);
  }
});
