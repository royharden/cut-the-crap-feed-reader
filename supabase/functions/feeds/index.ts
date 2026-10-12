import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import demoItems from "./demo_items.json" with { type: "json" };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// Request and payload bounds
const MAX_BODY_BYTES = 64 * 1024;
const MAX_FEEDS = 20;
const MAX_SOURCES = 20;
const MAX_URL_CHARS = 2048;
const MAX_ITEMS_PER_FEED = 25;
const MAX_HEAD_CHARS = 64 * 1024;
const MAX_RAW_HTML_CHARS = 16 * 1024;
const MAX_TITLE_CHARS = 300;
const MAX_SNIPPET_CHARS = 600;
const MAX_AUTHOR_CHARS = 120;
const HN_STORIES = 30;

// Outbound fetch limits
const FETCH_TIMEOUT_MS = 10_000;
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEEDBACK_KINDS = new Set(["false_hide", "false_keep"]);
const TYPE_ORDER = ["tutorial", "news", "opinion", "launch", "discussion", "uncertain"];

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

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

class BlockedUrlError extends Error {}

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

/** Reads a byte stream into a string, giving up (null) once it exceeds maxBytes. */
async function readTextCapped(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

async function readJsonBody(req: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, "Request body too large");
  const text = req.body ? await readTextCapped(req.body, maxBytes) : "";
  if (text === null) throw new HttpError(413, "Request body too large");
  if (!text.trim()) return {};
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

// ---------------------------------------------------------------------------
// SSRF guard for user-supplied feed URLs
// ---------------------------------------------------------------------------

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "kubernetes.default",
]);
const BLOCKED_HOST_SUFFIXES = [".localhost", ".internal", ".local", ".localdomain", ".home.arpa"];

function normalizeHostname(hostname: string): string {
  let h = hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h.replace(/\.+$/, "");
}

function parseIPv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function parseIPv6(s: string): number[] | null {
  if (!s.includes(":") || s.includes("%")) return null; // zone ids are never allowed
  let addr = s;
  if (addr.includes(".")) {
    // Embedded IPv4 tail (e.g. ::ffff:127.0.0.1) -> two hextets
    const lastColon = addr.lastIndexOf(":");
    const v4 = parseIPv4(addr.slice(lastColon + 1));
    if (!v4) return null;
    addr = `${addr.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups: string[];
  if (halves.length === 2) {
    if (head.length + tail.length > 7) return null;
    groups = [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

function isBlockedIPv4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this" network
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF assignments, TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 6to4 relay
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

function isBlockedIPv6(h: number[]): boolean {
  // Only global unicast 2000::/3 is allowed. That excludes ::, ::1, IPv4-mapped
  // ::ffff:0:0/96, IPv4-compatible ::/96, NAT64 64:ff9b::/96, discard 100::/64,
  // unique-local fc00::/7, link-local fe80::/10 and multicast ff00::/8.
  if ((h[0] & 0xe000) !== 0x2000) return true;
  if (h[0] === 0x2001 && h[1] < 0x0200) return true; // 2001::/23 IETF assignments (incl. Teredo)
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation
  if (h[0] === 0x2002) return true; // 6to4 (embeds an IPv4 address)
  if ((h[0] & 0xfff0) === 0x3ff0) return true; // 3fff::/20 documentation
  return false;
}

function isBlockedAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return isBlockedIPv4(v4);
  const v6 = parseIPv6(ip);
  if (v6) return isBlockedIPv6(v6);
  return true; // unparseable: fail closed
}

function isBlockedHostname(host: string): boolean {
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  if (host.startsWith("metadata.") || host.startsWith("instance-data.")) return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

async function resolveAll(host: string, signal: AbortSignal): Promise<string[]> {
  if (typeof Deno.resolveDns !== "function") throw new BlockedUrlError("DNS resolution unavailable");
  const lookups = await Promise.allSettled([
    Deno.resolveDns(host, "A", { signal }),
    Deno.resolveDns(host, "AAAA", { signal }),
  ]);
  const addrs: string[] = [];
  for (const r of lookups) {
    if (r.status === "fulfilled") addrs.push(...r.value);
    // "No records of this type" is fine; any other DNS failure fails closed.
    else if (!(r.reason instanceof Deno.errors.NotFound)) throw new BlockedUrlError(`DNS lookup failed for ${host}`);
  }
  return addrs;
}

/** Throws BlockedUrlError unless the URL is http(s) and every address it resolves to is public. */
async function assertPublicUrl(url: URL, signal: AbortSignal): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedUrlError("Only http(s) URLs are allowed");
  if (url.username || url.password) throw new BlockedUrlError("Credentials in URLs are not allowed");
  const host = normalizeHostname(url.hostname);
  if (isBlockedHostname(host)) throw new BlockedUrlError(`Blocked host ${host}`);
  if (parseIPv4(host) || host.includes(":")) {
    if (isBlockedAddress(host)) throw new BlockedUrlError(`Blocked address ${host}`);
    return;
  }
  if (!host.includes(".")) throw new BlockedUrlError(`Blocked single-label host ${host}`);
  const addrs = await resolveAll(host, signal);
  if (addrs.length === 0) throw new BlockedUrlError(`No addresses for ${host}`);
  const bad = addrs.find(isBlockedAddress);
  if (bad) throw new BlockedUrlError(`${host} resolves to blocked address ${bad}`);
}

/**
 * Fetches a user-supplied URL as text: http(s) only, manual redirects (max 3,
 * each hop re-validated), DNS checked on every hop, overall timeout and a
 * streamed size cap. Returns null on any failure.
 */
async function fetchUserUrlText(rawUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let url = new URL(rawUrl);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicUrl(url, controller.signal);
      const res = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "CutTheCrap/1.0 (demo)" },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!location) return null;
        url = new URL(location, url);
        continue;
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) {
        await res.body.cancel().catch(() => {});
        return null;
      }
      return await readTextCapped(res.body, MAX_FEED_BYTES);
    }
    console.warn(`feed fetch: too many redirects for ${rawUrl}`);
    return null;
  } catch (err) {
    console.warn(`feed fetch failed for ${rawUrl}:`, (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Feed parsing (linear-time helpers so a hostile 2 MB feed can't burn CPU)
// ---------------------------------------------------------------------------

function isTagBoundary(ch: string | undefined): boolean {
  return ch === undefined || ch === ">" || ch === "/" || /\s/.test(ch);
}

/** Finds the next `<tag` start (case-insensitive, whole tag name) at or after `from`. */
function findOpenTag(lower: string, tag: string, from: number): number {
  const needle = `<${tag.toLowerCase()}`;
  let pos = from;
  while (true) {
    const i = lower.indexOf(needle, pos);
    if (i === -1) return -1;
    if (isTagBoundary(lower[i + needle.length])) return i;
    pos = i + needle.length;
  }
}

function extractBlocks(xml: string, tag: string, max: number): string[] {
  const lower = xml.toLowerCase();
  const close = `</${tag.toLowerCase()}>`;
  const out: string[] = [];
  let pos = 0;
  while (out.length < max) {
    const start = findOpenTag(lower, tag, pos);
    if (start === -1) break;
    const end = lower.indexOf(close, start);
    if (end === -1) break;
    out.push(xml.slice(start, end + close.length));
    pos = end + close.length;
  }
  return out;
}

function removeBlocks(s: string, tag: string): string {
  const lower = s.toLowerCase();
  const close = `</${tag.toLowerCase()}>`;
  let out = "";
  let pos = 0;
  while (true) {
    const start = findOpenTag(lower, tag, pos);
    if (start === -1) break;
    const end = lower.indexOf(close, start);
    if (end === -1) break;
    out += s.slice(pos, start);
    pos = end + close.length;
  }
  return out + s.slice(pos);
}

function stripTags(s: string): string {
  let out = "";
  let pos = 0;
  while (pos < s.length) {
    const lt = s.indexOf("<", pos);
    if (lt === -1) break;
    const gt = s.indexOf(">", lt + 1);
    if (gt === -1) break;
    if (gt === lt + 1) {
      out += s.slice(pos, gt + 1);
    } else {
      out += `${s.slice(pos, lt)} `;
    }
    pos = gt + 1;
  }
  return out + s.slice(pos);
}

function stripHtml(html: string): string {
  return stripTags(removeBlocks(removeBlocks(html.slice(0, MAX_RAW_HTML_CHARS), "script"), "style"))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Raw `<link ...>` start tags in an entry. */
function linkTags(entry: string, lower = entry.toLowerCase()): string[] {
  const out: string[] = [];
  let pos = 0;
  while (out.length < 20) {
    const start = findOpenTag(lower, "link", pos);
    if (start === -1) break;
    const end = lower.indexOf(">", start);
    if (end === -1) break;
    out.push(entry.slice(start, end + 1));
    pos = end + 1;
  }
  return out;
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? m[1] : null;
}

function tagText(xml: string, tag: string, lower = xml.toLowerCase()): string | null {
  const start = findOpenTag(lower, tag, 0);
  const openEnd = start === -1 ? -1 : lower.indexOf(">", start);
  const close = openEnd === -1 ? -1 : lower.indexOf(`</${tag.toLowerCase()}>`, openEnd);
  if (close === -1) {
    // try self-closing / attribute forms commonly used for links
    if (tag === "link") {
      for (const t of linkTags(xml, lower)) {
        const href = attr(t, "href");
        if (href) return href;
      }
    }
    return null;
  }
  const inner = xml.slice(openEnd + 1, close);
  // handle CDATA
  const cdataStart = inner.indexOf("<![CDATA[");
  if (cdataStart !== -1) {
    const cdataEnd = inner.indexOf("]]>", cdataStart);
    if (cdataEnd !== -1) return inner.slice(cdataStart + 9, cdataEnd).trim();
  }
  return inner.trim();
}

function safeHttpUrl(raw: string | null | undefined, base?: string): string {
  if (!raw) return "";
  try {
    const u = new URL(raw.trim(), base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    const s = u.toString();
    return s.length <= MAX_URL_CHARS ? s : "";
  } catch {
    return "";
  }
}

function pickUrl(entryXml: string, lower = entryXml.toLowerCase()): string {
  const tags = linkTags(entryXml, lower);
  const alternate = tags.find((t) => attr(t, "href") && attr(t, "rel")?.toLowerCase() === "alternate");
  if (alternate) return attr(alternate, "href")!;
  for (const t of tags) {
    const href = attr(t, "href");
    if (href) return href;
  }
  const l = tagText(entryXml, "link", lower);
  if (l && l.startsWith("http")) return l;
  const guid = tagText(entryXml, "guid", lower);
  if (guid && guid.startsWith("http")) return guid;
  return "";
}

function snippetOf(entryXml: string, lower = entryXml.toLowerCase()): string {
  const raw = tagText(entryXml, "content:encoded", lower) ?? tagText(entryXml, "content", lower) ?? tagText(entryXml, "description", lower) ?? tagText(entryXml, "summary", lower) ?? "";
  return stripHtml(raw).slice(0, MAX_SNIPPET_CHARS);
}

function parseDate(entryXml: string, lower = entryXml.toLowerCase()): string {
  const raw = tagText(entryXml, "pubDate", lower) ?? tagText(entryXml, "published", lower) ?? tagText(entryXml, "updated", lower) ?? tagText(entryXml, "dc:date", lower);
  const d = raw ? new Date(raw) : new Date();
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function parseRss(xml: string, feedUrl: string): NormalizedItem[] {
  const isAtom = findOpenTag(xml.toLowerCase(), "feed", 0) !== -1;
  const entries = extractBlocks(xml, isAtom ? "entry" : "item", MAX_ITEMS_PER_FEED);
  const head = xml.slice(0, MAX_HEAD_CHARS);
  const channelTitle = tagText(head, "title") ?? "rss";
  const out: NormalizedItem[] = [];
  entries.forEach((entry, i) => {
    const lower = entry.toLowerCase();
    const title = stripHtml(tagText(entry, "title", lower) ?? "").slice(0, MAX_TITLE_CHARS);
    if (!title) return;
    const link = safeHttpUrl(pickUrl(entry, lower), feedUrl);
    const author = stripHtml(tagText(entry, "author", lower) ?? tagText(entry, "dc:creator", lower) ?? "") || channelTitle;
    out.push({
      source: new URL(link || "https://rss.local").hostname.replace(/^www\./, "").split(".")[0] || channelTitle.slice(0, 20),
      external_id: link || `${channelTitle.slice(0, 40)}-${i}`,
      title,
      url: link,
      author: author.slice(0, MAX_AUTHOR_CHARS),
      published_at: parseDate(entry, lower),
      snippet: snippetOf(entry, lower),
      points: null,
      comments: null,
    });
  });
  return out;
}

async function fetchHackerNews(): Promise<NormalizedItem[]> {
  const topRes = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json", {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!topRes.ok) throw new Error(`HN topstories failed: ${topRes.status}`);
  const top = await topRes.json();
  const ids = (Array.isArray(top) ? top : []).filter((id) => Number.isInteger(id)).slice(0, HN_STORIES) as number[];
  const items = await Promise.all(
    ids.map(async (id) => {
      try {
        const res = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) return null;
        const it = (await res.json()) as Record<string, unknown> | null;
        if (!it || !it.title) return null;
        const hnLink = `https://news.ycombinator.com/item?id=${id}`;
        return {
          source: "hackernews",
          external_id: String(id),
          title: String(it.title).slice(0, MAX_TITLE_CHARS),
          url: safeHttpUrl(typeof it.url === "string" ? it.url : null) || hnLink,
          author: typeof it.by === "string" ? it.by.slice(0, MAX_AUTHOR_CHARS) : null,
          published_at: new Date((Number(it.time) || 0) * 1000).toISOString(),
          snippet: stripHtml(String(it.text ?? "")).slice(0, MAX_SNIPPET_CHARS),
          points: Number.isInteger(it.score) ? (it.score as number) : null,
          comments: Number.isInteger(it.descendants) ? (it.descendants as number) : null,
        } as NormalizedItem;
      } catch {
        return null;
      }
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

/** Pre-scored answers for the offline demo bundle, in Jev's answer shape. */
function demoAnswers(d: DemoItem["demo"]) {
  const signalProbs = [0, 1, 2, 3].map((s) => (s === d.signal ? 0.88 : 0.04));
  return {
    signal: { score: d.signal, confidence: 0.88, probabilities: signalProbs },
    slop: { noul: d.slop },
    clickbait: { noul: d.clickbait },
    relevant: { noul: d.relevant ? 0.9 : 0.1 },
    type: {
      choice: d.type,
      confidence: d.type_probs[d.type] ?? 0,
      probabilities: TYPE_ORDER.map((t) => d.type_probs[t] ?? 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function parseFeedUrls(raw: unknown): string[] {
  if (raw === undefined || raw === null) return DEFAULT_FEEDS;
  if (!Array.isArray(raw)) throw new HttpError(400, "feeds must be an array of URLs");
  if (raw.length === 0) return DEFAULT_FEEDS;
  if (raw.length > MAX_FEEDS) throw new HttpError(422, `At most ${MAX_FEEDS} feeds per refresh`);
  const urls = raw.map((u) => {
    if (typeof u !== "string" || u.length > MAX_URL_CHARS) throw new HttpError(422, "Invalid feed URL");
    const safe = safeHttpUrl(u);
    if (!safe) throw new HttpError(422, "Feed URLs must be http(s)");
    return safe;
  });
  return [...new Set(urls)];
}

async function refresh(db: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const mode = body.mode ?? "live";
  if (mode !== "live" && mode !== "offline") throw new HttpError(400, "mode must be live or offline");
  const feedUrls = parseFeedUrls(body.feeds);

  let normalized: NormalizedItem[];
  if (mode === "offline") {
    normalized = (demoItems as DemoItem[]).map(demoToNormalized);
  } else {
    const [hn, ...rss] = await Promise.all([
      fetchHackerNews(),
      ...feedUrls.map(async (url) => {
        const xml = await fetchUserUrlText(url);
        if (xml === null) return [];
        try {
          return parseRss(xml, url);
        } catch (err) {
          console.warn(`feed parse failed for ${url}:`, (err as Error).message);
          return [];
        }
      }),
    ]);
    normalized = [...hn, ...rss.flat()];
  }

  // De-duplicate on the conflict key so a single upsert never touches a row twice.
  const unique = new Map<string, NormalizedItem>();
  for (const it of normalized) unique.set(`${it.source}\u0000${it.external_id}`, it);
  normalized = [...unique.values()];

  if (normalized.length === 0) {
    return json({ items: [], new_item_ids: [], message: "No items found" });
  }

  // Upsert items (whitelisted columns only), merging existing (source, external_id) pairs
  const { data: inserted, error } = await db
    .from("items")
    .upsert(
      normalized.map(({ source, external_id, title, url, author, published_at, snippet, points, comments }) => ({
        source, external_id, title, url, author, published_at, snippet, points, comments,
      })),
      { onConflict: "source,external_id" }
    )
    .select("*");
  if (error || !inserted) {
    console.error("items upsert failed:", error?.message);
    throw new HttpError(500, "Could not save feed items");
  }

  if (mode === "offline") {
    // The demo bundle ships pre-scored, so Offline demo never needs Jev or an API key.
    const byExternalId = new Map((demoItems as DemoItem[]).map((d) => [`${d.source}\u0000${d.external_id}`, d]));
    const scoreRows = (inserted as Array<{ id: string; source: string; external_id: string }>).flatMap((row) => {
      const d = byExternalId.get(`${row.source}\u0000${row.external_id}`);
      return d ? [{ item_id: row.id, answers: demoAnswers(d.demo), model: "demo", cost_usd: 0 }] : [];
    });
    if (scoreRows.length) {
      const { error: scoreErr } = await db
        .from("scores")
        .upsert(scoreRows, { onConflict: "item_id", ignoreDuplicates: true });
      if (scoreErr) console.error("demo scores upsert failed:", scoreErr.message);
    }
  }

  // merge-duplicates returns every row, so we can't tell which ones are new; the
  // client filters against existing scores.
  const ids = (inserted as Array<{ id: string }>).map((r) => r.id);
  return json({ items: inserted, new_item_ids: ids, count: ids.length, mode });
}

async function addSource(db: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const raw = typeof body.url === "string" ? body.url.trim() : "";
  if (!raw || raw.length > MAX_URL_CHARS) throw new HttpError(422, "Enter a valid feed URL");
  const url = safeHttpUrl(raw);
  if (!url) throw new HttpError(422, "Feed URLs must start with http:// or https://");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    await assertPublicUrl(new URL(url), controller.signal);
  } catch (err) {
    console.warn(`rejected source ${url}:`, (err as Error).message);
    throw new HttpError(422, "That feed URL points to a blocked or unresolvable host");
  } finally {
    clearTimeout(timer);
  }

  const { count, error: countErr } = await db.from("sources").select("id", { count: "exact", head: true });
  if (countErr || count === null) {
    console.error("sources count failed:", countErr?.message);
    throw new HttpError(500, "Could not add source");
  }
  if (count >= MAX_SOURCES) throw new HttpError(422, `At most ${MAX_SOURCES} sources`);

  const { error } = await db.from("sources").insert({ url });
  if (error) {
    if (error.code === "23505") throw new HttpError(409, "That feed is already in your sources");
    console.error("sources insert failed:", error.message);
    throw new HttpError(500, "Could not add source");
  }
  return json({ ok: true });
}

async function removeSource(db: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const id = body.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) throw new HttpError(400, "Invalid source id");
  const { error } = await db.from("sources").delete().eq("id", id);
  if (error) {
    console.error("sources delete failed:", error.message);
    throw new HttpError(500, "Could not remove source");
  }
  return json({ ok: true });
}

async function recordFeedback(db: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const itemId = body.item_id;
  const kind = body.kind;
  if (typeof itemId !== "string" || !UUID_RE.test(itemId)) throw new HttpError(400, "Invalid item_id");
  if (typeof kind !== "string" || !FEEDBACK_KINDS.has(kind)) throw new HttpError(400, "Invalid feedback kind");
  const { error } = await db.from("feedback").insert({ item_id: itemId, kind });
  if (error) {
    if (error.code === "23503") throw new HttpError(404, "Unknown item");
    console.error("feedback insert failed:", error.message);
    throw new HttpError(500, "Could not record feedback");
  }
  return json({ ok: true });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const body = await readJsonBody(req, MAX_BODY_BYTES);

    const db = serviceClient();
    if (!db) {
      console.error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured");
      return json({ error: "Service unavailable" }, 503);
    }

    switch (body.action ?? "refresh") {
      case "refresh":
        return await refresh(db, body);
      case "add_source":
        return await addSource(db, body);
      case "remove_source":
        return await removeSource(db, body);
      case "feedback":
        return await recordFeedback(db, body);
      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error("feeds failed:", err);
    return json({ error: "feeds failed" }, 500);
  }
});
