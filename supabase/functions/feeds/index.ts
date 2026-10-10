import demoItems from "./demo_items.json" with { type: "json" };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface DemoItem {
  source: string;
  external_id: string;
  title: string;
  url: string;
  author: string;
  hours_ago: number;
  snippet: string;
  points: number;
  comments: number;
  demo: {
    signal: number;
    slop: number;
    clickbait: number;
    relevant: boolean;
    type: string;
    type_probs: Record<string, number>;
  };
}

interface NormalizedItem {
  source: string;
  external_id: string;
  title: string;
  url: string;
  author: string | null;
  published_at: string;
  snippet: string;
  points: number | null;
  comments: number | null;
}

const DEFAULT_FEEDS = [
  "https://hnrss.org/newest?points=50",
  "https://www.theverge.com/rss/index.xml",
  "https://dev.to/feed",
];

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tagText(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) {
    // try self-closing / attribute forms commonly used for links
    if (tag === "link") {
      const lm = xml.match(/<link[^>]*href="([^"]+)"/i);
      if (lm) return lm[1];
    }
    return null;
  }
  // handle CDATA
  const cdata = m[1].match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return (cdata ? cdata[1] : m[1]).trim();
}

function pickUrl(entryXml: string): string {
  const linkAlt = entryXml.match(/<link[^>]*href="([^"]+)"[^>]*rel="alternate"/i);
  if (linkAlt) return linkAlt[1];
  const anyHref = entryXml.match(/<link[^>]*href="([^"]+)"/i);
  if (anyHref) return anyHref[1];
  const l = tagText(entryXml, "link");
  if (l && l.startsWith("http")) return l;
  const guid = tagText(entryXml, "guid");
  if (guid && guid.startsWith("http")) return guid;
  return "";
}

function snippetOf(entryXml: string): string {
  const raw = tagText(entryXml, "content:encoded") ?? tagText(entryXml, "content") ?? tagText(entryXml, "description") ?? tagText(entryXml, "summary") ?? "";
  return stripHtml(raw).slice(0, 600);
}

function parseDate(entryXml: string): string {
  const raw = tagText(entryXml, "pubDate") ?? tagText(entryXml, "published") ?? tagText(entryXml, "updated") ?? tagText(entryXml, "dc:date");
  const d = raw ? new Date(raw) : new Date();
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function parseRss(xml: string): NormalizedItem[] {
  const channelTitle = tagText(xml, "title") ?? "rss";
  const isAtom = /<feed[\s>]/i.test(xml);
  const entryRe = isAtom ? /<entry[\s\S]*?<\/entry>/gi : /<item[\s\S]*?<\/item>/gi;
  const entries = xml.match(entryRe) ?? [];
  const out: NormalizedItem[] = [];
  entries.slice(0, 25).forEach((entry, i) => {
    const title = stripHtml(tagText(entry, "title") ?? "");
    if (!title) return;
    const link = pickUrl(entry) || "";
    const author = stripHtml(tagText(entry, "author") ?? tagText(entry, "dc:creator") ?? "") || channelTitle;
    const commentsMatch = entry.match(/<comments>([\s\S]*?)<\/comments>/i);
    out.push({
      source: new URL(link || "https://rss.local").hostname.replace(/^www\./, "").split(".")[0] || channelTitle.slice(0, 20),
      external_id: link || `${channelTitle.slice(0, 40)}-${i}`,
      title,
      url: link,
      author: author.slice(0, 120),
      published_at: parseDate(entry),
      snippet: snippetOf(entry),
      points: null,
      comments: null,
    });
  });
  return out;
}

async function fetchHackerNews(): Promise<NormalizedItem[]> {
  const topRes = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
  if (!topRes.ok) throw new Error(`HN topstories failed: ${topRes.status}`);
  const ids = ((await topRes.json()) as number[]).slice(0, 30);
  const items = await Promise.all(
    ids.map(async (id) => {
      const res = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      if (!res.ok) return null;
      const it = (await res.json()) as Record<string, unknown>;
      if (!it || !it.title) return null;
      return {
        source: "hackernews",
        external_id: String(id),
        title: String(it.title),
        url: (it.url as string) || `https://news.ycombinator.com/item?id=${id}`,
        author: (it.by as string) || null,
        published_at: new Date(((it.time as number) || 0) * 1000).toISOString(),
        snippet: stripHtml(String(it.text ?? "")).slice(0, 600),
        points: (it.score as number) ?? null,
        comments: (it.descendants as number) ?? null,
      } as NormalizedItem;
    })
  );
  return items.filter(Boolean) as NormalizedItem[];
}

function demoToNormalized(d: DemoItem): NormalizedItem {
  return {
    source: d.source,
    external_id: d.external_id,
    title: d.title,
    url: d.url,
    author: d.author,
    published_at: new Date(Date.now() - d.hours_ago * 3600_000).toISOString(),
    snippet: d.snippet,
    points: d.points,
    comments: d.comments,
  };
}

async function checkUsageCap(supabaseUrl: string, serviceKey: string): Promise<void> {
  // feeds has no secrets and no paid API calls, so it is exempt from the daily cap.
  // Kept as a no-op hook for parity with jev-score / llm.
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const body = await req.json().catch(() => ({}));
    const mode = body.mode as "live" | "offline" | undefined;
    const feedUrls: string[] = Array.isArray(body.feeds) && body.feeds.length ? body.feeds : DEFAULT_FEEDS;

    // Check usage cap only in live mode (offline demo doesn't call external APIs)
    if (mode !== "offline") {
      checkUsageCap(supabaseUrl, serviceKey);
    }

    let normalized: NormalizedItem[];
    if (mode === "offline") {
      normalized = (demoItems as DemoItem[]).map(demoToNormalized);
    } else {
      const [hn, ...rss] = await Promise.all([
        fetchHackerNews(),
        ...feedUrls.map(async (url) => {
          try {
            const res = await fetch(url, { headers: { "User-Agent": "CutTheCrap/1.0 (demo)" } });
            if (!res.ok) return [];
            return parseRss(await res.text());
          } catch {
            return [];
          }
        }),
      ]);
      normalized = [...hn, ...rss.flat()];
    }

    if (normalized.length === 0) {
      return new Response(JSON.stringify({ items: [], new_item_ids: [], message: "No items found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Upsert items, skipping existing (source, external_id) pairs
    const upsertRes = await fetch(`${supabaseUrl}/rest/v1/items?on_conflict=source,external_id`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation",
        apikey: serviceKey,
      },
      body: JSON.stringify(normalized),
    });

    if (!upsertRes.ok) {
      const err = await upsertRes.text();
      throw new Error(`items upsert failed: ${err}`);
    }

    const inserted = (await upsertRes.json()) as Array<{ id: string }>;
    // merge-duplicates returns all rows; we only report new ids by filtering client-side.
    // To only return NEW ids, we re-query created within the last minute not previously present.
    // Simpler approach: return ids of rows whose created_at is within the upsert window.
    // But merge-duplicates doesn't tell us which were new. We approximate by returning all
    // inserted ids and letting the client filter against already-known ids + existing scores.
    const ids = inserted.map((r) => r.id);

    return new Response(
      JSON.stringify({ items: inserted, new_item_ids: ids, count: ids.length, mode: mode ?? "live" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const status = (err as { status?: number }).status === 429 ? 429 : 500;
    return new Response(
      JSON.stringify({ error: (err as Error).message ?? "feeds failed" }),
      { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
