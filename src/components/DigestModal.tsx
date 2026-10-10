import { useState } from "react";
import { Check, Copy, Loader2, Sparkles, X } from "lucide-react";

interface Props {
  loading: boolean;
  bullets: string[];
  onClose: () => void;
}

export default function DigestModal({ loading, bullets, onClose }: Props) {
  const [copied, setCopied] = useState(false);

  const markdown = bullets.map((b) => `- ${b}`).join("\n");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-serif text-xl font-medium text-zinc-100">
            <Sparkles className="h-5 w-5 text-amber-500" /> Today's digest
          </h2>
          <button onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
            <X className="h-5 w-5" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin text-amber-500" /> Jev picked the top items — writing the digest…
          </div>
        ) : (
          <>
            <ul className="space-y-3">
              {bullets.map((b, i) => (
                <li key={i} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-sm leading-relaxed text-zinc-300">
                  {b}
                </li>
              ))}
            </ul>
            <button
              onClick={copy}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-amber-600 hover:text-amber-400"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy as Markdown"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
