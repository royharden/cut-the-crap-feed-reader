import { useState } from "react";
import { Archive, RotateCcw, X } from "lucide-react";
import type { Item } from "@/lib/types";

export interface HiddenEntry {
  item: Item;
  reasons: string[];
}

interface Props {
  entries: HiddenEntry[];
  onRestore: (itemId: string) => void;
}

export default function HiddenDrawer({ entries, onRestore }: Props) {
  const [open, setOpen] = useState(false);

  const byReason = new Map<string, HiddenEntry[]>();
  for (const e of entries) {
    for (const r of e.reasons.length ? e.reasons : ["other"]) {
      const list = byReason.get(r) ?? [];
      list.push(e);
      byReason.set(r, list);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm font-medium text-zinc-300 shadow-xl transition hover:border-amber-600 hover:text-amber-400"
      >
        <Archive className="h-4 w-4" />
        Hidden
        <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-400">
          {entries.length}
        </span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={() => setOpen(false)}>
          <aside
            className="h-full w-full max-w-md overflow-y-auto border-l border-zinc-800 bg-zinc-950 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-6 flex items-center justify-between">
              <h2 className="font-serif text-xl font-medium text-zinc-100">
                Hidden items <span className="text-amber-500">({entries.length})</span>
              </h2>
              <button onClick={() => setOpen(false)} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
                <X className="h-5 w-5" />
              </button>
            </div>

            {entries.length === 0 && (
              <p className="text-sm text-zinc-500">Nothing hidden yet. Adjust the sliders or refresh the feed.</p>
            )}

            {[...byReason.entries()].map(([reason, list]) => (
              <section key={reason} className="mb-6">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-500/80">{reason}</h3>
                <ul className="space-y-2">
                  {list.map(({ item }) => (
                    <li
                      key={item.id}
                      className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-sm"
                    >
                      <p className="font-medium text-zinc-300">{item.title}</p>
                      <p className="mt-0.5 text-xs text-zinc-500">{item.source}</p>
                      <button
                        onClick={() => onRestore(item.id)}
                        className="mt-2 inline-flex items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 transition hover:border-emerald-600 hover:text-emerald-400"
                      >
                        <RotateCcw className="h-3 w-3" /> this was actually good
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </aside>
        </div>
      )}
    </>
  );
}
