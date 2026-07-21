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

export interface RecordSummary {
  id: string;
  type: RecordType;
  status: string;
  title: string;
  updated_at: string;
  last_verified_at: string | null;
}

export interface PromotedProposalSummary extends RecordSummary {
  durable_target_ids: string[];
  has_exactly_one_durable_target: boolean;
}
export interface LegacyLineageAmbiguity {
  record_id: string;
  target_id: string;
  reason: string;
}

export interface LineageAmbiguityReport {
  total: number;
  items: LegacyLineageAmbiguity[];
  truncated: boolean;
}

export interface MigrationReport {
  mode: "preview" | "applied";
  path: string;
  from_schema_version: 1;
  to_schema_version: 2;
  legacy_link_count: number;
  promotion_count: number;
  replacement_count: number;
  ambiguity_count: number;
  ambiguities: LegacyLineageAmbiguity[];
  ambiguities_truncated: boolean;
  promoted_proposal_review_count: number;
  promoted_proposal_review: Array<{
    proposal_id: string;
    durable_target_ids: string[];
  }>;
  promoted_proposal_review_truncated: boolean;
  quick_check: string;
}

export interface MaintenanceReport {
  generated_at: string;
  stale_days: number;
  database: {
    path: string;
    size_bytes: number;
    quick_check: string;
  };
  stale_open_or_blocked_handoffs: RecordSummary[];
  promoted_proposals: PromotedProposalSummary[];
  rejected_proposals: RecordSummary[];
  closed_or_archived_handoffs: RecordSummary[];
  inactive_durable_records: RecordSummary[];
  active_durable_missing_verification: RecordSummary[];
  lineage_migration_ambiguities: LineageAmbiguityReport;
}

export interface BackupResult {
  path: string;
  created_at: string;
  size_bytes: number;
  quick_check: "ok";
}

export interface PruneCandidate {
  id: string;
  type: "proposal" | "handoff";
  status: "promoted" | "rejected" | "archived";
  updated_at: string;
  reason: string;
  durable_target_id?: string;
}

export interface PruneResult {
  applied: boolean;
  candidates: PruneCandidate[];
  deleted_ids: string[];
  backup_path: string | null;
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
  promoted_from: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
  last_verified_at: string | null;
  source: Source;
}

export interface SearchFilters {
  type?: string;
  status?: string;
  project?: string;
  limit?: number;
}

export type SearchRetrievalList = "exact_id" | "phrase" | "and" | "title_tags" | "or";

export interface SearchRetrievalContribution {
  list: SearchRetrievalList;
  rank: number;
  weight: number;
  rrf_contribution: number;
}

export interface SearchMetadataComponents {
  status: number;
  type: number;
  confidence: number;
  freshness: number;
  raw_total: number;
  bounded_contribution: number;
}

export interface SearchDiagnosticHit {
  id: string;
  type: RecordType;
  status: string;
  project: string | null;
  confidence: Confidence;
  title: string;
  summary: string;
  ranking_mode: "lexical" | "recency";
  exact_id_match: boolean;
  raw_rrf_score: number;
  normalized_lexical_score: number;
  metadata: SearchMetadataComponents;
  exact_id_bonus: number;
  final_score: number;
  retrieval_lists: SearchRetrievalContribution[];
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
  promoted_from?: string | null;
  superseded_by?: string | null;
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
