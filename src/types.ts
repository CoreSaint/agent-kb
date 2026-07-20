export const recordTypes = ["handoff", "decision", "procedure", "troubleshoot", "landscape", "preference", "proposal"] as const;
export const durableTypes = ["decision", "procedure", "troubleshoot", "landscape", "preference"] as const;
export const confidences = ["high", "medium", "low"] as const;
export const sources = ["user", "agent_promoted", "import", "agent"] as const;

export type RecordType = (typeof recordTypes)[number];
export type DurableType = (typeof durableTypes)[number];
export type Confidence = (typeof confidences)[number];
export type Source = (typeof sources)[number];

export const allowedStatuses: Record<RecordType, readonly string[]> = {
  handoff: ["open", "blocked", "closed", "archived"],
  decision: ["draft", "active", "superseded", "archived"],
  procedure: ["draft", "active", "deprecated", "archived"],
  troubleshoot: ["draft", "active", "done", "deprecated", "archived"],
  landscape: ["draft", "active", "deprecated", "archived"],
  preference: ["draft", "active", "deprecated", "archived"],
  proposal: ["open", "rejected", "promoted", "archived"],
};

export function defaultStatus(type: RecordType): string {
  if (type === "handoff" || type === "proposal") return "open";
  return "draft";
}

export interface KbRecord {
  id: string;
  type: RecordType;
  title: string;
  status: string;
  project: string | null;
  tags: string[];
  body: string;
  summary: string;
  confidence: Confidence;
  evidence: string[];
  supersedes: string | null;
  created_at: string;
  updated_at: string;
  last_verified_at: string | null;
  source: Source;
}

export interface UpsertInput {
  id: string;
  type: RecordType;
  title: string;
  status?: string;
  project?: string | null;
  tags?: string[];
  body?: string;
  summary?: string;
  confidence?: Confidence;
  evidence?: string[];
  supersedes?: string | null;
  last_verified_at?: string | null;
  source?: Source;
}

export interface PromoteInput {
  id?: string;
  type: DurableType;
  title?: string;
  status?: "active" | "done";
  project?: string | null;
  tags?: string[];
  body?: string;
  summary?: string;
  confidence?: Confidence;
  evidence?: string[];
  last_verified_at?: string | null;
}
