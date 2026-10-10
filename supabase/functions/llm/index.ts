const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

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

async function callOpenAI(
  messages: Array<{ role: string; content: string }>,
  maxTokens: number
): Promise<string | null> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  const baseUrl = Deno.env.get("OPENAI_BASE_URL") || "https://api.openai.com/v1";
  const model = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
  if (!apiKey) return null;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error(`OpenAI request failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const restHeaders = {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      apikey: serviceKey,
    };

    // Usage cap check
    const capRes = await fetch(`${supabaseUrl}/rest/v1/rpc/check_usage_cap`, {
      method: "POST",
      headers: restHeaders,
      body: JSON.stringify({ p_fn: "llm" }),
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

    const body = await req.json();
    const action = body.action as "why" | "digest";
    const mock = body.mock === true;

    if (action === "why") {
      const { title, snippet, source, signal } = body.item ?? {};
      if (mock || !Deno.env.get("OPENAI_API_KEY")) {
        return new Response(JSON.stringify({ text: mockWhy(title ?? "", snippet ?? "", signal ?? null), mock: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const prompt = `A reader is interested in: ${body.reader_interests ?? "technology"}.
Feed item from ${source ?? "a feed"}:
Title: ${title}
Excerpt: ${String(snippet ?? "").slice(0, 400)}

Write ONE sentence on why this item might matter to this reader. If it is low signal (vague, promotional, or filler), start with "Probably skip:" instead.`;
      const text = await callOpenAI([{ role: "user", content: prompt }], 120);
      return new Response(JSON.stringify({ text: text ?? mockWhy(title ?? "", snippet ?? "", signal ?? null), mock: !text }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "digest") {
      const items: Array<{ title: string; url: string; source: string; snippet?: string }> = body.items ?? [];
      if (mock || !Deno.env.get("OPENAI_API_KEY")) {
        return new Response(JSON.stringify({ bullets: mockDigest(items), mock: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const list = items
        .slice(0, 10)
        .map((it, i) => `${i + 1}. ${it.title} (${it.source}) — ${String(it.snippet ?? "").slice(0, 200)} ${it.url}`)
        .join("\n");
      const prompt = `Write a 5-bullet digest of today's top feed items for a reader interested in: ${body.reader_interests ?? "technology"}.
One bullet per item, include the link, no preamble.

Items:
${list}`;
      const text = await callOpenAI([{ role: "user", content: prompt }], 500);
      const bullets = text
        ? text.split("\n").map((l) => l.replace(/^[\s\-*\d.]+/, "")).filter(Boolean).slice(0, 5)
        : mockDigest(items);
      return new Response(JSON.stringify({ bullets, mock: !text }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message ?? "llm failed" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
