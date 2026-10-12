import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Newspaper, Sparkles, Wifi, WifiOff } from "lucide-react";
import { supabase } from "@/lib/supabase";
import FeedCard from "@/components/FeedCard";
import HiddenDrawer, { type HiddenEntry } from "@/components/HiddenDrawer";
import ItemInspector from "@/components/ItemInspector";
import PolicyPanel from "@/components/PolicyPanel";
import SourcesPanel from "@/components/SourcesPanel";
import StatsPanel from "@/components/StatsPanel";
import DigestModal from "@/components/DigestModal";
import { classify } from "@/lib/classify";
import type { Policy, Item, ScoreRow, BatchRow } from "@/lib/types";
import * as api from "@/lib/api";

const DEFAULT_POLICY: Policy = {
  slopHide: 0.7,
  clickbaitBlur: 0.6,
  signalMin: 1.0,
  relevanceWeight: 1.5,
  recencyHalfLifeHours: 12,
  interests: "AI agents, developer tools, databases, startups",
};

const LLM_CONSTANTS_KEY = "ctc-llm-constants";
const DEFAULT_LLM_CONSTANTS = { inputPerM: 2.5, outputPerM: 10, tokensPerItem: 150, inputTokensPerItem: 400 };

type LlmConstants = typeof DEFAULT_LLM_CONSTANTS;

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export default function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [scores, setScores] = useState<Map<string, ScoreRow>>(new Map());
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [sources, setSources] = useState<Array<{ id: string; url: string; enabled: boolean }>>([]);
  const [policy, setPolicy] = useState<Policy>(() => loadJson("ctc-policy", DEFAULT_POLICY));
  const [llmConstants, setLlmConstants] = useState<LlmConstants>(() => loadJson(LLM_CONSTANTS_KEY, DEFAULT_LLM_CONSTANTS));
  const [mode, setMode] = useState<"live" | "offline">("live");
  const [llmMock, setLlmMock] = useState<boolean>(() => localStorage.getItem("ctc-llm-mock") === "true");
  const [capHit, setCapHit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [overrides, setOverrides] = useState<Set<string>>(new Set());
  const [whyTexts, setWhyTexts] = useState<Map<string, { text: string; loading: boolean }>>(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [digest, setDigest] = useState<{ open: boolean; loading: boolean; bullets: string[] }>({ open: false, loading: false, bullets: [] });

  useEffect(() => { localStorage.setItem("ctc-policy", JSON.stringify(policy)); }, [policy]);
  useEffect(() => { localStorage.setItem("ctc-llm-constants", JSON.stringify(llmConstants)); }, [llmConstants]);
  useEffect(() => { localStorage.setItem("ctc-llm-mock", String(llmMock)); }, [llmMock]);

  const reload = useCallback(async () => {
    const [its, scs, bs, srcs] = await Promise.all([
      api.fetchItems(),
      api.fetchScores(),
      api.fetchBatches(),
      supabaseSources(),
    ]);
    setItems(its);
    setScores(new Map(scs.map((s) => [s.item_id, s])));
    setBatches(bs);
    setSources(srcs);
  }, []);

  useEffect(() => { reload().catch((e) => setError(e.message)); }, [reload]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const feedUrls = sources.filter((s) => s.enabled).map((s) => s.url);
      await api.refreshFeeds(mode, feedUrls);
      const its = await api.fetchItems();
      const scs = await api.fetchScores();
      const scored = new Set(scs.map((s) => s.item_id));
      // Offline demo items arrive pre-scored; only Live mode calls Jev.
      const toScore = mode === "live" ? its.filter((it) => !scored.has(it.id)) : [];

      const chunks: typeof toScore[] = [];
      for (let i = 0; i < toScore.length; i += 10) chunks.push(toScore.slice(i, i + 10));
      setProgress({ done: 0, total: chunks.length });

      for (let c = 0; c < chunks.length; c++) {
        await api.scoreBatch(
          policy.interests,
          chunks[c].map((it) => ({ item_id: it.id, title: it.title, snippet: it.snippet, source: it.source }))
        );
        setProgress({ done: c + 1, total: chunks.length });
      }
      await reload();
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("Daily demo limit")) {
        setCapHit(true);
        setMode("offline");
      } else {
        setError(msg);
      }
    } finally {
      setRefreshing(false);
      setProgress(null);
    }
  }, [mode, policy.interests, reload, sources]);

  const scoredItems = useMemo(
    () =>
      items.map((it) => {
        const s = scores.get(it.id);
        const c = classify(s?.answers, policy, it.published_at);
        return { item: it, score: s, c };
      }),
    [items, scores, policy]
  );

  const hiddenEntries: HiddenEntry[] = useMemo(
    () =>
      scoredItems
        .filter(({ item, c }) => c.decision === "hide" && !overrides.has(item.id))
        .map(({ item, c }) => ({ item, reasons: c.reasons })),
    [scoredItems, overrides]
  );

  const hiddenIds = useMemo(() => new Set(hiddenEntries.map((e) => e.item.id)), [hiddenEntries]);

  const kept = useMemo(
    () =>
      scoredItems
        .filter(({ item, c }) => !hiddenIds.has(item.id))
        .sort((a, b) => b.c.rank - a.c.rank),
    [scoredItems, hiddenIds]
  );

  const stats = useMemo(() => {
    const blurred = kept.filter(({ c }) => c.decision === "blur").length;
    const bySource = new Map<string, { total: number; slop: number }>();
    for (const { score, item } of scoredItems) {
      const slop = score?.answers.slop?.noul;
      if (slop == null) continue;
      const rec = bySource.get(item.source) ?? { total: 0, slop: 0 };
      rec.total += 1;
      rec.slop += slop;
      bySource.set(item.source, rec);
    }
    const slopBySource = [...bySource.entries()]
      .map(([source, r]) => ({ source, rate: r.slop / r.total }))
      .sort((a, b) => b.rate - a.rate)
      .slice(0, 6);
    const latencies = batches.map((b) => b.latency_ms ?? 0).filter(Boolean);
    const itemLatencies = [...scores.values()].map((s) => s.latency_ms ?? 0).filter(Boolean);
    const jevCost = [...scores.values()].reduce((sum, s) => sum + (s.cost_usd ? Number(s.cost_usd) : 0), 0);
    const llmCost =
      (scores.size * llmConstants.inputTokensPerItem * llmConstants.inputPerM +
        scores.size * llmConstants.tokensPerItem * llmConstants.outputPerM) /
      1_000_000;
    return {
      kept: kept.length - blurred,
      blurred,
      hidden: hiddenEntries.length,
      slopBySource,
      avgBatchLatency: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
      avgItemLatency: itemLatencies.length ? itemLatencies.reduce((a, b) => a + b, 0) / itemLatencies.length : null,
      jevCost,
      llmCost,
    };
  }, [kept, hiddenEntries, batches, scores, llmConstants, scoredItems]);

  const askWhy = useCallback(
    async (itemId: string) => {
      const it = items.find((i) => i.id === itemId);
      if (!it) return;
      setWhyTexts((m) => new Map(m).set(itemId, { text: m.get(itemId)?.text ?? "", loading: true }));
      try {
        const text = await api.askWhy(
          { title: it.title, snippet: it.snippet, source: it.source, signal: scores.get(it.id)?.answers.signal?.score ?? null },
          policy.interests,
          llmMock
        );
        setWhyTexts((m) => new Map(m).set(itemId, { text, loading: false }));
      } catch (e) {
        const msg = (e as Error).message;
        setWhyTexts((m) => new Map(m).set(itemId, { text: msg.includes("Daily demo limit") ? "Daily demo limit reached — try again tomorrow." : `Why failed: ${msg}`, loading: false }));
      }
    },
    [items, scores, policy.interests, llmMock]
  );

  const makeDigest = useCallback(async () => {
    setDigest({ open: true, loading: true, bullets: [] });
    try {
      const top10 = kept
        .filter(({ score }) => score)
        .slice(0, 10)
        .map(({ item }) => ({ title: item.title, url: item.url, source: item.source, snippet: item.snippet }));
      const bullets = await api.askDigest(top10, policy.interests, llmMock);
      setDigest({ open: true, loading: false, bullets });
    } catch (e) {
      setDigest({ open: true, loading: false, bullets: [`Digest failed: ${(e as Error).message}`] });
    }
  }, [kept, policy.interests, llmMock]);

  const restoreItem = useCallback(async (itemId: string) => {
    setOverrides((s) => new Set(s).add(itemId));
    try { await api.recordFeedback(itemId, "false_hide"); } catch { /* demo feedback is best-effort */ }
  }, []);

  const selected = items.find((i) => i.id === selectedId) ?? null;
  const selectedEntry = selected ? scoredItems.find(({ item }) => item.id === selected.id) : null;
  const selectedBatch = selectedEntry?.score?.batch_id
    ? batches.find((b) => b.id === selectedEntry.score?.batch_id) ?? null
    : null;

  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-800 bg-zinc-950/90 px-6 py-8 backdrop-blur">
        <div className="mx-auto max-w-7xl">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-amber-500 p-2.5">
                <Newspaper className="h-6 w-6 text-zinc-950" />
              </div>
              <h1 className="font-serif text-2xl font-medium leading-tight text-zinc-100 sm:text-3xl">
                Cut the Crap: <span className="text-amber-500">Jev reads the feed so you don't have to.</span>
              </h1>
            </div>
            <div className="flex items-center gap-3">
              <Toggle
                options={[{ value: "live", label: "Live", icon: Wifi }, { value: "offline", label: "Offline demo", icon: WifiOff }]}
                value={mode}
                onChange={(v) => setMode(v as "live" | "offline")}
              />
              <Toggle
                options={[{ value: "live", label: "LLM live" }, { value: "mock", label: "Mock LLM" }]}
                value={llmMock ? "mock" : "live"}
                onChange={(v) => setLlmMock(v === "mock")}
              />
              <button
                onClick={makeDigest}
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-amber-400"
              >
                <Sparkles className="h-4 w-4" /> Digest
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6">
        {capHit && (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-amber-700/50 bg-amber-950/40 px-4 py-3 text-sm text-amber-300">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Daily demo limit reached — switched to Offline demo mode with pre-scored items. The cap resets tomorrow.
          </div>
        )}
        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
          <div className="space-y-3">
            {kept.length === 0 && !refreshing && (
              <div className="rounded-xl border border-dashed border-zinc-800 p-10 text-center text-sm text-zinc-500">
                No items yet — hit "Refresh feed" in the Sources panel.
              </div>
            )}
            {kept.map(({ item, score, c }) => (
              <div key={item.id} className="space-y-1">
                <FeedCard
                  item={{ ...item, score }}
                  blurred={c.decision === "blur"}
                  rank={kept.findIndex((k) => k.item.id === item.id)}
                  onOpen={() => setSelectedId(item.id)}
                  onWhy={() => askWhy(item.id)}
                  whyLoading={whyTexts.get(item.id)?.loading ?? false}
                />
                {whyTexts.get(item.id)?.text && !whyTexts.get(item.id)?.loading && (
                  <p className="ml-14 rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-sm italic text-amber-200/90">
                    {whyTexts.get(item.id)!.text}
                  </p>
                )}
              </div>
            ))}
          </div>

          <div className="space-y-4">
            <PolicyPanel policy={policy} onChange={setPolicy} />
            <SourcesPanel
              sources={sources}
              onAdd={async (url) => {
                try {
                  await api.addSource(url);
                  await reload();
                } catch (e) { setError((e as Error).message); }
              }}
              onRemove={async (id) => {
                try {
                  await api.removeSource(id);
                  await reload();
                } catch (e) { setError((e as Error).message); }
              }}
              onRefresh={refresh}
              refreshing={refreshing}
              progress={progress}
            />
            <StatsPanel
              {...stats}
              llmConstants={llmConstants}
              onConstantsChange={(c) => setLlmConstants((prev) => ({ ...prev, ...c }))}
            />
          </div>
        </div>
      </main>

      <HiddenDrawer entries={hiddenEntries} onRestore={restoreItem} />

      {selected && selectedEntry && (
        <ItemInspector
          item={{ ...selected, score: selectedEntry.score }}
          batch={selectedBatch}
          firedRules={selectedEntry.c.firedRules}
          onClose={() => setSelectedId(null)}
        />
      )}

      {digest.open && (
        <DigestModal loading={digest.loading} bullets={digest.bullets} onClose={() => setDigest((d) => ({ ...d, open: false }))} />
      )}
    </div>
  );
}

function Toggle({ options, value, onChange }: {
  options: Array<{ value: string; label: string; icon?: React.ComponentType<{ className?: string }> }>;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex rounded-lg border border-zinc-700 p-0.5">
      {options.map((o) => {
        const Icon = o.icon;
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
              active ? "bg-amber-500 text-zinc-950" : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {Icon && <Icon className="h-3 w-3" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

async function supabaseSources(): Promise<Array<{ id: string; url: string; enabled: boolean }>> {
  const { data, error } = await supabase.from("sources").select("id, url, enabled").order("created_at");
  if (error) throw new Error(error.message);
  return data ?? [];
}
