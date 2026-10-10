const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-1.13.0";
const BATCH_SIZE = 10;
const MAX_TRIES = 3;
const PRICE_PER_M_INPUT = 0.042;

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

function buildRequest(interests: string, items: ScoredItem[]) {
  const state: Record<string, unknown> = {
    reader_interests: interests,
    items: Object.fromEntries(
      items.map((it, i) => [`i${i}`, { title: it.title, snippet: it.snippet.slice(0, 400), source: it.source }])
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

async function callTypesafe(payload: unknown, apiKey: string): Promise<{ data: any; latency: number; usage: any }> {
  let delay = 500;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const start = Date.now();
    const res = await fetch(TYPESAFE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const latency = Date.now() - start;
    if (res.ok) {
      const data = await res.json();
      console.log("response.model:", data?.model);
      return { data, latency, usage: data?.usage ?? null };
    }
    if ((res.status === 429 || res.status === 529) && attempt < MAX_TRIES) {
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
      continue;
    }
    throw new Error(`TypeSafe request failed (${res.status}): ${await res.text()}`);
  }
  throw new Error("TypeSafe request failed after retries");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  try {
    const apiKey = Deno.env.get("TYPESAFE_API_KEY");
    if (!apiKey) throw new Error("TYPESAFE_API_KEY not configured");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const body = await req.json();
    const interests: string = body.reader_interests ?? "";
    const allItems: ScoredItem[] = body.items ?? [];
    if (!Array.isArray(allItems) || allItems.length === 0) {
      return new Response(JSON.stringify({ results: [], model: MODEL, usage: null, latency_ms: 0, cost_usd: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const restHeaders = {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      apikey: serviceKey,
    };

    // Increment usage counter; reject once over the daily cap
    const capRes = await fetch(`${supabaseUrl}/rest/v1/rpc/check_usage_cap`, {
      method: "POST",
      headers: restHeaders,
      body: JSON.stringify({ p_fn: "jev-score" }),
    });
    if (!capRes.ok) {
      const t = await capRes.text();
      if (capRes.status === 429 || t.includes("Daily demo limit")) {
        return new Response(JSON.stringify({ error: "Daily demo limit reached" }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      console.error("cap check failed:", t);
    }

    const results: Array<{ item_id: string; answers: Answer }> = [];
    let totalInputTokens = 0;
    let totalLatency = 0;
    let totalCost = 0;

    for (let i = 0; i < allItems.length; i += BATCH_SIZE) {
      const chunk = allItems.slice(i, i + BATCH_SIZE);
      const payload = buildRequest(interests, chunk);
      const batchStart = Date.now();
      let resp: { data: any; latency: number; usage: any };
      try {
        resp = await callTypesafe(payload, apiKey);
      } catch (e) {
        const msg = String((e as Error).message ?? e);
        if (msg.includes("size") || msg.includes("too large") || msg.includes("batch")) {
          // Split the batch in half and retry each half
          if (chunk.length > 1) {
            const mid = Math.ceil(chunk.length / 2);
            for (const half of [chunk.slice(0, mid), chunk.slice(mid)]) {
              const r = await callTypesafe(buildRequest(interests, half), apiKey);
              resp = r;
            }
          } else throw e;
        } else throw e;
      }
      const batchLatency = Date.now() - batchStart;

      const answersByQuestion: Record<string, any> = resp.data?.answers ?? {};
      const batchId = crypto.randomUUID();

      const perItem: Record<string, Answer> = {};
      for (const [qid, ans] of Object.entries(answersByQuestion)) {
        const [itemKey, field] = qid.split("__");
        const idx = Number(itemKey.replace("i", ""));
        const itemId = chunk[idx]?.item_id;
        if (!itemId || !field) continue;
        perItem[itemId] = perItem[itemId] ?? {};
        (perItem[itemId] as Record<string, unknown>)[field] = ans;
      }

      // Store batch + scores
      await fetch(`${supabaseUrl}/rest/v1/batches`, {
        method: "POST",
        headers: { ...restHeaders, Prefer: "return=minimal" },
        body: JSON.stringify({
          id: batchId,
          item_count: chunk.length,
          jev_request: payload,
          jev_response: resp.data,
          latency_ms: batchLatency,
        }),
      });

      const inputTokens = resp.usage?.input_tokens ?? resp.usage?.prompt_tokens ?? 0;
      const cost = (inputTokens * PRICE_PER_M_INPUT) / 1_000_000;
      totalInputTokens += inputTokens;
      totalLatency += batchLatency;
      totalCost += cost;

      const scoreRows = Object.entries(perItem).map(([itemId, answers]) => ({
        item_id: itemId,
        batch_id: batchId,
        answers,
        model: resp.data?.model ?? MODEL,
        latency_ms: Math.round(batchLatency / chunk.length),
        input_tokens: Math.round(inputTokens / chunk.length),
        cost_usd: cost / chunk.length,
      }));
      if (scoreRows.length) {
        await fetch(`${supabaseUrl}/rest/v1/scores`, {
          method: "POST",
          headers: { ...restHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(scoreRows),
        });
      }

      for (const it of chunk) {
        results.push({ item_id: it.item_id, answers: perItem[it.item_id] ?? {} });
      }
    }

    return new Response(
      JSON.stringify({
        results,
        model: MODEL,
        usage: { input_tokens: totalInputTokens },
        latency_ms: totalLatency,
        cost_usd: Number(totalCost.toFixed(8)),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message ?? "jev-score failed" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
