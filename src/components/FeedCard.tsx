import { useState } from "react";
import { Eye, EyeOff, ExternalLink, HelpCircle, Loader2, ChevronUp, MessageSquare, ShieldAlert } from "lucide-react";
import type { ScoredItem } from "@/lib/types";
import { neutralTitleStub, SIGNAL_LEGEND } from "@/lib/classify";

const TYPE_COLORS: Record<string, string> = {
  tutorial: "bg-emerald-900/60 text-emerald-300",
  news: "bg-sky-900/60 text-sky-300",
  opinion: "bg-orange-900/60 text-orange-300",
  launch: "bg-fuchsia-900/60 text-fuchsia-300",
  discussion: "bg-cyan-900/60 text-cyan-300",
  uncertain: "bg-zinc-800 text-zinc-400",
};

function ageOf(iso: string | null): string {
  if (!iso) return "";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

interface Props {
  item: ScoredItem;
  blurred: boolean;
  rank: number;
  onOpen: () => void;
  onWhy: () => void;
  whyLoading: boolean;
}

export default function FeedCard({ item, blurred, rank, onOpen, onWhy, whyLoading }: Props) {
  const [revealed, setRevealed] = useState(false);
  const type = item.score?.answers.type?.choice;
  const signal = item.score?.answers.signal?.score ?? null;

  return (
    <article
      onClick={onOpen}
      className="group cursor-pointer rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 transition-all hover:border-amber-700/60 hover:bg-zinc-900"
    >
      <div className="flex items-start gap-3">
        <div className="flex w-10 shrink-0 flex-col items-center rounded-lg bg-zinc-800/70 py-1.5 text-center">
          <ChevronUp className="h-3.5 w-3.5 text-amber-500" />
          <span className="text-sm font-semibold text-zinc-300">{item.points ?? "—"}</span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-xs text-zinc-600">#{rank + 1}</span>
            {blurred && !revealed ? (
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="blurred-title truncate font-serif text-lg font-medium text-zinc-100">
                  {item.title}
                </h2>
                <button
                  onClick={(e) => { e.stopPropagation(); setRevealed(true); }}
                  className="shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-amber-400"
                  title="Show original title"
                >
                  <Eye className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <h2 className="truncate font-serif text-lg font-medium text-zinc-100">
                {blurred && revealed ? (
                  <span className="flex items-center gap-2">
                    <span className="truncate">{item.title}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); setRevealed(false); }}
                      className="shrink-0 rounded p-0.5 text-zinc-500 hover:text-amber-400"
                      title="Hide original title"
                    >
                      <EyeOff className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ) : (
                  <>
                    {blurred ? neutralTitleStub(item.snippet) : item.title}
                    {blurred && <ShieldAlert className="ml-1 inline h-3.5 w-3.5 text-amber-500" />}
                  </>
                )}
              </h2>
            )}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <span className="text-zinc-400">{item.source}</span>
            <span>·</span>
            <span>{ageOf(item.published_at)}</span>
            {item.comments != null && (
              <>
                <span>·</span>
                <span className="inline-flex items-center gap-0.5">
                  <MessageSquare className="h-3 w-3" /> {item.comments}
                </span>
              </>
            )}
            {type && (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${TYPE_COLORS[type] ?? TYPE_COLORS.uncertain}`}>
                {type}
              </span>
            )}
            {signal !== null && (
              <span className="inline-flex items-center gap-1" title={`Signal: ${SIGNAL_LEGEND[signal]}`}>
                {[0, 1, 2, 3].map((i) => (
                  <span
                    key={i}
                    className={`h-1.5 w-4 rounded-full ${i <= signal ? "bg-amber-500" : "bg-zinc-700"}`}
                  />
                ))}
              </span>
            )}
          </div>

          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); onWhy(); }}
              disabled={whyLoading}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition hover:border-amber-600 hover:text-amber-400 disabled:opacity-50"
            >
              {whyLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <HelpCircle className="h-3 w-3" />}
              why
            </button>
            {item.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 text-xs text-zinc-500 transition hover:text-amber-400"
              >
                <ExternalLink className="h-3 w-3" /> open
              </a>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
