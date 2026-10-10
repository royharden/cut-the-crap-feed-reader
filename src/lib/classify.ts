import type { Answers, ClassifyResult, Policy } from "./types";

const SIGNAL_LEGEND = ["None", "Low", "Solid", "High"];

/**
 * Pure decision function: Jev's answers + the user's policy -> keep/blur/hide,
 * a rank score, and the list of rules that fired. No I/O, unit-test friendly.
 */
export function classify(
  answers: Answers | undefined,
  policy: Policy,
  publishedAt: string | null,
  now: number = Date.now()
): ClassifyResult {
  if (!answers || !answers.signal) {
    return { decision: "keep", rank: 0, reasons: [], firedRules: ["unscored"] };
  }

  const signal = answers.signal.score ?? 0;
  const slop = answers.slop?.noul ?? 0;
  const clickbait = answers.clickbait?.noul ?? 0;
  const relevant = (answers.relevant?.noul ?? 0) >= 0.5 ? 1 : 0;

  const firedRules: string[] = [];
  const reasons: string[] = [];

  if (slop >= policy.slopHide) {
    firedRules.push(`slop ${slop.toFixed(2)} >= ${policy.slopHide}`);
    reasons.push("AI slop");
  }
  if (signal < policy.signalMin) {
    firedRules.push(`signal ${signal} < ${policy.signalMin}`);
    reasons.push("low signal");
  }
  const blur = clickbait >= policy.clickbaitBlur;
  if (blur) {
    firedRules.push(`clickbait ${clickbait.toFixed(2)} >= ${policy.clickbaitBlur}`);
  }

  const hours = publishedAt ? Math.max(0, (now - new Date(publishedAt).getTime()) / 3_600_000) : 24;
  const recencyBoost = Math.pow(0.5, hours / policy.recencyHalfLifeHours);

  const rank = signal * 1.0 + relevant * policy.relevanceWeight - clickbait * 0.5 + recencyBoost;

  let decision: ClassifyResult["decision"] = "keep";
  if (reasons.length > 0) decision = "hide";
  else if (blur) decision = "blur";

  return { decision, rank, reasons, firedRules };
}

export function neutralTitleStub(snippet: string): string {
  const words = snippet.trim().split(/\s+/).slice(0, 8).join(" ");
  return words ? `${words}…` : "Untitled item";
}

export { SIGNAL_LEGEND };
