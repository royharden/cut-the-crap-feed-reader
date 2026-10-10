export interface Answers {
  signal?: { score: number; confidence: number; probabilities: number[] };
  slop?: { noul: number };
  clickbait?: { noul: number };
  relevant?: { noul: number };
  type?: { choice: string; confidence: number; probabilities: number[] };
}

export interface Item {
  id: string;
  source: string;
  external_id: string;
  title: string;
  url: string;
  author: string | null;
  published_at: string | null;
  snippet: string;
  points: number | null;
  comments: number | null;
  created_at: string;
}

export interface ScoreRow {
  item_id: string;
  batch_id: string | null;
  answers: Answers;
  model: string;
  latency_ms: number | null;
  input_tokens: number | null;
  cost_usd: number | null;
}

export interface ScoredItem extends Item {
  score?: ScoreRow;
}

export interface Policy {
  slopHide: number;
  clickbaitBlur: number;
  signalMin: number;
  relevanceWeight: number;
  recencyHalfLifeHours: number;
  interests: string;
}

export type Decision = "keep" | "blur" | "hide";

export interface ClassifyResult {
  decision: Decision;
  rank: number;
  reasons: string[];
  firedRules: string[];
}

export interface BatchRow {
  id: string;
  item_count: number;
  jev_request: unknown;
  jev_response: unknown;
  latency_ms: number | null;
  created_at: string;
}
