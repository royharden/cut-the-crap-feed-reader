import { SlidersHorizontal } from "lucide-react";
import type { Policy } from "@/lib/types";

interface Props {
  policy: Policy;
  onChange: (p: Policy) => void;
}

const PRESETS: Record<string, Partial<Policy>> = {
  Ruthless: { slopHide: 0.5, clickbaitBlur: 0.4, signalMin: 2, relevanceWeight: 2 },
  Balanced: { slopHide: 0.7, clickbaitBlur: 0.6, signalMin: 1, relevanceWeight: 1.5 },
  Chill: { slopHide: 0.9, clickbaitBlur: 0.85, signalMin: 0, relevanceWeight: 1 },
};

export default function PolicyPanel({ policy, onChange }: Props) {
  const set = (patch: Partial<Policy>) => onChange({ ...policy, ...patch });

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <h3 className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-amber-500">
        <SlidersHorizontal className="h-3.5 w-3.5" /> Filtering policy
      </h3>

      <div className="mb-4 flex gap-2">
        {Object.keys(PRESETS).map((name) => (
          <button
            key={name}
            onClick={() => set(PRESETS[name])}
            className="flex-1 rounded-lg border border-zinc-700 px-2 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-amber-600 hover:text-amber-400"
          >
            {name}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {([
          ["slopHide", "Hide AI slop at", 0, 1, 0.05],
          ["clickbaitBlur", "Blur clickbait at", 0, 1, 0.05],
          ["signalMin", "Hide below signal", 0, 3, 0.5],
          ["relevanceWeight", "Relevance weight", 0, 3, 0.25],
          ["recencyHalfLifeHours", "Recency half-life (h)", 1, 48, 1],
        ] as const).map(([key, label, min, max, step]) => (
          <label key={key} className="block">
            <div className="mb-1 flex justify-between text-xs">
              <span className="text-zinc-400">{label}</span>
              <span className="font-mono text-amber-400">{policy[key]}</span>
            </div>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={policy[key]}
              onChange={(e) => set({ [key]: Number(e.target.value) } as Partial<Policy>)}
              className="w-full accent-amber-500"
            />
          </label>
        ))}
      </div>

      <label className="mt-4 block">
        <span className="mb-1 block text-xs text-zinc-400">Your interests</span>
        <textarea
          value={policy.interests}
          onChange={(e) => set({ interests: e.target.value })}
          rows={2}
          className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-amber-600 focus:outline-none"
          placeholder="AI agents, developer tools, databases, startups"
        />
      </label>
    </section>
  );
}
