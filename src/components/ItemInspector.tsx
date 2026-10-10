import { X } from "lucide-react";
import type { BatchRow, ScoredItem } from "@/lib/types";
import { SIGNAL_LEGEND } from "@/lib/classify";

interface Props {
  item: ScoredItem;
  batch: BatchRow | null;
  firedRules: string[];
  onClose: () => void;
}

function Bar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-zinc-400">{label}</span>
        <span className="font-mono text-zinc-300">{value.toFixed(2)}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, value * 100)}%` }} />
      </div>
    </div>
  );
}

export default function ItemInspector({ item, batch, firedRules, onClose }: Props) {
  const a = item.score?.answers;
  const signal = a?.signal;
  const type = a?.type;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="font-serif text-xl font-medium text-zinc-100">{item.title}</h2>
          <button onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
            <X className="h-5 w-5" />
          </button>
        </div>

        {!a && <p className="text-sm text-zinc-500">This item hasn't been scored by Jev yet.</p>}

        {a && (
          <div className="space-y-5">
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-500">Jev's answers</h3>
              <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                {signal && (
                  <div>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="text-zinc-400">Signal — {SIGNAL_LEGEND[signal.score]}</span>
                      <span className="font-mono text-zinc-300">score {signal.score}, conf {signal.confidence?.toFixed(2)}</span>
                    </div>
                    <div className="flex h-2 overflow-hidden rounded-full">
                      {signal.probabilities?.map((p, i) => (
                        <div key={i} className={["bg-red-500/70", "bg-orange-500/70", "bg-amber-500/80", "bg-emerald-500/80"][i] ?? "bg-zinc-600"} style={{ width: `${p * 100}%` }} />
                      ))}
                    </div>
                  </div>
                )}
                {a.slop && <Bar label="Slop (AI filler)" value={a.slop.noul} color="bg-fuchsia-500" />}
                {a.clickbait && <Bar label="Clickbait" value={a.clickbait.noul} color="bg-orange-500" />}
                {a.relevant && <Bar label="Relevant to your interests" value={a.relevant.noul} color="bg-sky-500" />}
                {type && (
                  <div>
                    <div className="mb-1 text-xs text-zinc-400">
                      Type: <span className="font-medium text-zinc-200">{type.choice}</span>
                      {typeof type.confidence === "number" && (
                        <span className="ml-2 font-mono text-zinc-500">conf {type.confidence.toFixed(2)}</span>
                      )}
                    </div>
                    <div className="flex h-2 overflow-hidden rounded-full">
                      {type.probabilities?.map((p, i) => (
                        <div key={i} className={i % 2 ? "bg-zinc-500" : "bg-zinc-400"} style={{ width: `${p * 100}%` }} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-500">Rules that fired</h3>
              {firedRules.length ? (
                <ul className="space-y-1">
                  {firedRules.map((r, i) => (
                    <li key={i} className="rounded-md bg-red-950/40 px-3 py-1.5 font-mono text-xs text-red-300">{r}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-zinc-500">No rules fired — this item was kept.</p>
              )}
            </section>

            {batch && (
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-500">
                  Raw batch ({batch.item_count} items, {batch.latency_ms}ms)
                </h3>
                <details className="rounded-xl border border-zinc-800 bg-zinc-900/50">
                  <summary className="cursor-pointer px-4 py-2 text-sm text-zinc-400">Request JSON</summary>
                  <pre className="max-h-64 overflow-auto border-t border-zinc-800 p-4 font-mono text-[11px] text-zinc-500">
                    {JSON.stringify(batch.jev_request, null, 2)}
                  </pre>
                </details>
                <details className="mt-2 rounded-xl border border-zinc-800 bg-zinc-900/50">
                  <summary className="cursor-pointer px-4 py-2 text-sm text-zinc-400">Response JSON</summary>
                  <pre className="max-h-64 overflow-auto border-t border-zinc-800 p-4 font-mono text-[11px] text-zinc-500">
                    {JSON.stringify(batch.jev_response, null, 2)}
                  </pre>
                </details>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
