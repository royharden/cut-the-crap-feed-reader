import { useState } from "react";
import { Plus, Rss, Trash2 } from "lucide-react";

interface Props {
  sources: Array<{ id: string; url: string; enabled: boolean }>;
  onAdd: (url: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onRefresh: () => void;
  refreshing: boolean;
  progress: { done: number; total: number } | null;
}

export default function SourcesPanel({ sources, onAdd, onRemove, onRefresh, refreshing, progress }: Props) {
  const [url, setUrl] = useState("");

  const submit = async () => {
    if (!url.trim()) return;
    await onAdd(url.trim());
    setUrl("");
  };

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <h3 className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-amber-500">
        <Rss className="h-3.5 w-3.5" /> Sources
      </h3>

      <div className="mb-3 flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="https://example.com/rss.xml"
          className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:border-amber-600 focus:outline-none"
        />
        <button
          onClick={submit}
          className="rounded-lg border border-zinc-700 px-2 text-zinc-400 transition hover:border-amber-600 hover:text-amber-400"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <ul className="mb-3 space-y-1.5">
        {sources.map((s) => (
          <li key={s.id} className="flex items-center gap-2 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.enabled ? "bg-emerald-500" : "bg-zinc-600"}`} />
            <span className="min-w-0 flex-1 truncate text-zinc-400">{s.url}</span>
            <button
              onClick={() => onRemove(s.id)}
              className="shrink-0 text-zinc-600 transition hover:text-red-400"
              title="Remove source"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>

      <button
        onClick={onRefresh}
        disabled={refreshing}
        className="w-full rounded-lg bg-amber-500 px-3 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-amber-400 disabled:opacity-60"
      >
        {refreshing ? "Refreshing…" : "Refresh feed"}
      </button>

      {progress && progress.total > 0 && (
        <div className="mt-2">
          <div className="mb-1 flex justify-between text-[10px] text-zinc-500">
            <span>scoring batches</span>
            <span>{progress.done}/{progress.total}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-amber-500 transition-all"
              style={{ width: `${(progress.done / progress.total) * 100}%` }}
            />
          </div>
        </div>
      )}
    </section>
  );
}
