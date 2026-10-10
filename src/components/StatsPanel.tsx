import { useState } from "react";
import { PieChart, Pie, Cell, BarChart, Bar as RBar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { RefreshCw, Settings2 } from "lucide-react";

interface Props {
  kept: number;
  blurred: number;
  hidden: number;
  slopBySource: Array<{ source: string; rate: number }>;
  avgBatchLatency: number | null;
  avgItemLatency: number | null;
  jevCost: number;
  llmCost: number;
  llmConstants: { inputPerM: number; outputPerM: number; tokensPerItem: number };
  onConstantsChange: (c: { inputPerM: number; outputPerM: number; tokensPerItem: number }) => void;
}

const DONUT_COLORS = ["#10b981", "#f59e0b", "#ef4444"];

export default function StatsPanel(p: Props) {
  const [showSettings, setShowSettings] = useState(false);
  const donut = [
    { name: "Kept", value: p.kept },
    { name: "Blurred", value: p.blurred },
    { name: "Hidden", value: p.hidden },
  ].filter((d) => d.value > 0);

  const ratio = p.jevCost > 0 ? p.llmCost / p.jevCost : null;

  return (
    <aside className="space-y-4">
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-amber-500">Feed decisions</h3>
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={donut} dataKey="value" nameKey="name" innerRadius={45} outerRadius={70} paddingAngle={3}>
                {donut.map((_, i) => (
                  <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8, fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="flex justify-center gap-4 text-xs text-zinc-400">
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" /> kept {p.kept}</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-500" /> blurred {p.blurred}</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-500" /> hidden {p.hidden}</span>
        </div>
      </section>

      {p.slopBySource.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-amber-500">Slop rate by source</h3>
          <div className="h-40">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={p.slopBySource} layout="vertical" margin={{ left: 10 }}>
                <XAxis type="number" domain={[0, 1]} hide />
                <YAxis type="category" dataKey="source" width={80} tick={{ fill: "#a1a1aa", fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip formatter={(v: unknown) => Number(v).toFixed(2)} contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8, fontSize: 12 }} />
                <RBar dataKey="rate" fill="#d946ef" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-amber-500">Jev performance</h3>
        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between"><dt className="text-zinc-400">Avg latency / batch</dt><dd className="font-mono text-zinc-200">{p.avgBatchLatency != null ? `${Math.round(p.avgBatchLatency)} ms` : "—"}</dd></div>
          <div className="flex justify-between"><dt className="text-zinc-400">Avg latency / item</dt><dd className="font-mono text-zinc-200">{p.avgItemLatency != null ? `${Math.round(p.avgItemLatency)} ms` : "—"}</dd></div>
          <div className="flex justify-between"><dt className="text-zinc-400">Jev cost (scored items)</dt><dd className="font-mono text-emerald-400">${p.jevCost.toFixed(6)}</dd></div>
          <div className="flex justify-between"><dt className="text-zinc-400">LLM-judge equivalent</dt><dd className="font-mono text-red-400">${p.llmCost.toFixed(4)}</dd></div>
          {ratio && (
            <div className="flex justify-between border-t border-zinc-800 pt-1.5">
              <dt className="text-zinc-400">Savings factor</dt>
              <dd className="font-mono font-semibold text-amber-400">{ratio.toFixed(0)}x cheaper</dd>
            </div>
          )}
        </dl>
        <button
          onClick={() => setShowSettings((s) => !s)}
          className="mt-3 inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-amber-400"
        >
          {showSettings ? <RefreshCw className="h-3 w-3" /> : <Settings2 className="h-3 w-3" />}
          {showSettings ? "hide constants" : "edit LLM cost constants"}
        </button>
        {showSettings && (
          <div className="mt-2 grid grid-cols-3 gap-2">
            {([
              ["inputPerM", "$/M input"],
              ["outputPerM", "$/M output"],
              ["tokensPerItem", "out tok/item"],
            ] as const).map(([key, label]) => (
              <label key={key} className="text-[10px] text-zinc-500">
                {label}
                <input
                  type="number"
                  value={p.llmConstants[key]}
                  onChange={(e) => p.onConstantsChange({ ...p.llmConstants, [key]: Number(e.target.value) || 0 })}
                  className="mt-0.5 w-full rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 font-mono text-xs text-zinc-200"
                />
              </label>
            ))}
          </div>
        )}
      </section>
    </aside>
  );
}
