import { createHash } from "node:crypto";
import { chmodSync, closeSync, lstatSync, openSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { openDb, kbPath } from "./db.ts";
import { assertNoObviousSecrets } from "./secrets.ts";
import {
  allowedStatuses,
  confidences,
  defaultStatus,
  durableTypes,
  recordTypes,
  sources,
  type BackupResult,
  type DurableType,
  type KbRecord,
  type MaintenanceReport,
  type PromoteInput,
  type PromotedProposalSummary,
  type PruneCandidate,
  type PruneResult,
  type RecordSummary,
  type RecordType,
  type SearchDiagnosticHit,
  type SearchFilters,
  type SearchMetadataComponents,
  type SearchRetrievalContribution,
  type SearchRetrievalList,
  type Source,
  type UpsertInput,
} from "./types.ts";

function now(): string { return new Date().toISOString(); }
function includes<T extends readonly string[]>(list: T, value: string): value is T[number] { return list.some((item) => item === value); }
function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || !value.trim()) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("Expected JSON array");
  return parsed.map(String);
}
function objectRow(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected SQLite row object.");
  }
  return value;
}
function stringField(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error(`Expected string field '${name}'.`);
  return value;
}
function nullableStringField(row: Record<string, unknown>, name: string): string | null {
  const value = row[name];
  if (value !== null && typeof value !== "string") throw new Error(`Expected nullable string field '${name}'.`);
  return value;
}
function rowToRecord(value: unknown): KbRecord {
  const row = objectRow(value);
  const type = stringField(row, "type");
  const confidence = stringField(row, "confidence");
  const source = stringField(row, "source");
  assertType(type);
  assertConfidence(confidence);
  assertSource(source);
  return {
    id: stringField(row, "id"),
    type,
    title: stringField(row, "title"),
    status: stringField(row, "status"),
    project: nullableStringField(row, "project"),
    tags: parseJsonArray(row.tags),
    body: stringField(row, "body"),
    summary: stringField(row, "summary"),
    confidence,
    evidence: parseJsonArray(row.evidence),
    supersedes: nullableStringField(row, "supersedes"),
    created_at: stringField(row, "created_at"),
    updated_at: stringField(row, "updated_at"),
    last_verified_at: nullableStringField(row, "last_verified_at"),
    source,
  };
}
function assertType(type: string): asserts type is RecordType {
  if (!includes(recordTypes, type)) throw new Error(`Invalid type '${type}'.`);
}
function assertDurable(type: string): asserts type is DurableType {
  if (!includes(durableTypes, type)) throw new Error(`Invalid durable type '${type}'.`);
}
function assertConfidence(confidence: string): void {
  if (!includes(confidences, confidence)) throw new Error(`Invalid confidence '${confidence}'.`);
}
function assertSource(source: string): asserts source is Source {
  if (!includes(sources, source)) throw new Error(`Invalid source '${source}'.`);
}
function assertStatus(type: RecordType, status: string): void {
  if (!allowedStatuses[type].includes(status)) throw new Error(`Invalid status '${status}' for ${type}.`);
}
/** Reciprocal Rank Fusion smoothing constant (Cormack et al.). */
const RRF_K = 60;
/** Candidate pool per lexical list before fusion. */
const CANDIDATE_POOL = 50;

function tokenize(query: string): string[] {
  return query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
}
function quoteToken(token: string): string {
  return `"${token.replaceAll('"', '""')}"`;
}
function ftsOr(tokens: string[]): string {
  return tokens.map(quoteToken).join(" OR ");
}
function ftsAnd(tokens: string[]): string {
  return tokens.map(quoteToken).join(" AND ");
}
/** FTS5 phrase query: consecutive tokens in order. */
function ftsPhrase(tokens: string[]): string {
  return `"${tokens.map((t) => t.replaceAll('"', '""')).join(" ")}"`;
}
/** Column-scoped OR over title + tags (identifier / label bias). */
function ftsTitleTags(tokens: string[]): string {
  return `{title tags}: ${ftsOr(tokens)}`;
}

type RankedList = { name: SearchRetrievalList; weight: number; ids: string[] };

interface FusedRrf {
  scores: Map<string, number>;
  contributions: Map<string, SearchRetrievalContribution[]>;
}

interface RankedSearchHit {
  record: KbRecord;
  diagnostic: SearchDiagnosticHit;
}

/** Terminal / non-authoritative statuses: still returnable, but demoted unless filtered explicitly. */
const DEMOTED_STATUSES = new Set([
  "promoted", "deprecated", "superseded", "archived", "rejected", "closed",
]);

function fuseRrf(lists: RankedList[]): FusedRrf {
  const scores = new Map<string, number>();
  const contributions = new Map<string, SearchRetrievalContribution[]>();
  for (const { name, weight, ids } of lists) {
    ids.forEach((id, index) => {
      const rank = index + 1;
      const contribution = weight / (RRF_K + rank);
      scores.set(id, (scores.get(id) ?? 0) + contribution);
      const item = { list: name, rank, weight, rrf_contribution: contribution };
      const existing = contributions.get(id);
      if (existing) existing.push(item);
      else contributions.set(id, [item]);
    });
  }
  return { scores, contributions };
}

function statusBoost(type: string, status: string): number {
  if (status === "promoted") {
    // Prefer the durable twin over an already-promoted proposal.
    return -0.22;
  }
  if (status === "deprecated" || status === "superseded" || status === "archived" || status === "rejected") {
    return -0.3;
  }
  if (type === "handoff") {
    // Continuity records stay findable, but must not dominate durable answers.
    if (status === "open") return 0.03;
    if (status === "blocked") return 0;
    if (status === "closed") return -0.12;
    return DEMOTED_STATUSES.has(status) ? -0.2 : 0;
  }
  switch (status) {
    case "active":
    case "done":
      return 0.12;
    case "open":
      return 0.08;
    case "draft":
    case "blocked":
      return 0;
    case "closed":
      return -0.08;
    default:
      return DEMOTED_STATUSES.has(status) ? -0.2 : 0;
  }
}

function typeBoost(type: string): number {
  switch (type) {
    case "decision":
    case "procedure":
    case "preference":
    case "troubleshoot":
    case "landscape":
      return 0.1;
    case "handoff":
      // Working state; keyword-heavy bodies otherwise crowd out durable truth.
      return -0.04;
    case "proposal":
      return -0.06;
    default:
      return 0;
  }
}

function confidenceBoost(confidence: string): number {
  if (confidence === "high") return 0.05;
  if (confidence === "medium") return 0.02;
  return 0;
}

/** Type-aware freshness: modest handoff recency; durable types do not decay merely for age. */
function freshnessBoost(rec: KbRecord, nowMs: number): number {
  const raw = rec.last_verified_at || rec.updated_at;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return 0;
  const ageDays = (nowMs - ts) / 86_400_000;

  if (rec.type === "handoff") {
    if (ageDays <= 3) return 0.05;
    if (ageDays <= 14) return 0.02;
    if (ageDays <= 30) return 0;
    return -0.08;
  }
  if (rec.type === "troubleshoot") {
    if (ageDays <= 90) return 0.04;
    if (ageDays <= 365) return 0;
    return -0.04;
  }
  // decision / procedure / preference / landscape / proposal: no pure age decay.
  if (rec.last_verified_at) {
    if (ageDays <= 30) return 0.05;
    if (ageDays <= 180) return 0.02;
  }
  return 0;
}

/** Maximum metadata adjustment after calibration; total metadata range is [-0.05, +0.05]. */
const METADATA_MAX_CONTRIBUTION = 0.05;
/** Maximum attainable positive sum from the four metadata component functions. */
const METADATA_MAX_POSITIVE_RAW = 0.32;
/** Largest attainable negative magnitude from compatible type/status component combinations. */
const METADATA_MAX_NEGATIVE_RAW = 0.36;
/** Separates exact IDs from every non-exact score, whose maximum is 1.05. */
const EXACT_ID_BONUS = 2;

function boundedMetadataContribution(rawTotal: number): number {
  if (rawTotal === 0) return 0;
  const scale = rawTotal > 0 ? METADATA_MAX_POSITIVE_RAW : METADATA_MAX_NEGATIVE_RAW;
  const normalized = Math.max(-1, Math.min(1, rawTotal / scale));
  return normalized * METADATA_MAX_CONTRIBUTION;
}

function metadataComponents(rec: KbRecord, nowMs: number, apply: boolean): SearchMetadataComponents {
  const status = statusBoost(rec.type, rec.status);
  const type = typeBoost(rec.type);
  const confidence = confidenceBoost(rec.confidence);
  const freshness = freshnessBoost(rec, nowMs);
  const rawTotal = status + type + confidence + freshness;
  return {
    status,
    type,
    confidence,
    freshness,
    raw_total: rawTotal,
    bounded_contribution: apply ? boundedMetadataContribution(rawTotal) : 0,
  };
}

function diagnosticHit(
  rec: KbRecord,
  values: {
    rankingMode: "lexical" | "recency";
    exactIdMatch: boolean;
    rawRrfScore: number;
    normalizedLexicalScore: number;
    metadata: SearchMetadataComponents;
    retrievalLists: SearchRetrievalContribution[];
  },
): SearchDiagnosticHit {
  const exactIdBonus = values.exactIdMatch ? EXACT_ID_BONUS : 0;
  return {
    id: rec.id,
    type: rec.type,
    status: rec.status,
    project: rec.project,
    confidence: rec.confidence,
    title: rec.title,
    summary: rec.summary,
    ranking_mode: values.rankingMode,
    exact_id_match: values.exactIdMatch,
    raw_rrf_score: values.rawRrfScore,
    normalized_lexical_score: values.normalizedLexicalScore,
    metadata: values.metadata,
    exact_id_bonus: exactIdBonus,
    final_score: values.normalizedLexicalScore + values.metadata.bounded_contribution + exactIdBonus,
    retrieval_lists: values.retrievalLists,
  };
}

/**
 * Query-relative score:
 *   final = rawRrf / maxRawRrf + boundedMetadata + exactIdBonus
 * Non-exact lexical relevance is [0, 1], metadata is [-0.05, 0.05], and exactIdBonus is 2.
 */
function scoreLexicalHit(
  rec: KbRecord,
  rawRrfScore: number,
  maxRawRrfScore: number,
  query: string,
  nowMs: number,
  retrievalLists: SearchRetrievalContribution[],
): SearchDiagnosticHit {
  return diagnosticHit(rec, {
    rankingMode: "lexical",
    exactIdMatch: rec.id === query,
    rawRrfScore,
    normalizedLexicalScore: maxRawRrfScore > 0 ? rawRrfScore / maxRawRrfScore : 0,
    metadata: metadataComponents(rec, nowMs, true),
    retrievalLists,
  });
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "record";
}

const DAY_MS = 86_400_000;
const BACKUP_FRESH_MS = 15 * 60_000;
const BACKUP_MARKER_KEY = "maintenance_backup_v1";
const DURABLE_SQL = "'decision','procedure','troubleshoot','landscape','preference'";

interface BackupMarker {
  format: 1;
  source_path: string;
  source_signature: string;
  created_at: string;
}

function assertPositiveDays(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 36_500) {
    throw new Error(`${name} must be an integer from 1 to 36500.`);
  }
}

function assertIsoCalendarDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("date must use YYYY-MM-DD.");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid calendar date '${value}'.`);
  }
}

function rowToSummary(value: unknown): RecordSummary {
  const row = objectRow(value);
  const type = stringField(row, "type");
  assertType(type);
  return {
    id: stringField(row, "id"),
    type,
    status: stringField(row, "status"),
    title: stringField(row, "title"),
    updated_at: stringField(row, "updated_at"),
    last_verified_at: nullableStringField(row, "last_verified_at"),
  };
}

function quickCheck(db: DatabaseSync): string {
  const row = objectRow(db.prepare("PRAGMA quick_check").get());
  return stringField(row, "quick_check");
}

function parseBackupMarker(value: unknown): BackupMarker {
  if (typeof value !== "string") throw new Error("Backup lacks a maintenance validation marker.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("Backup has an invalid maintenance validation marker.", { cause: error });
  }
  const marker = objectRow(parsed);
  if (
    marker.format !== 1
    || typeof marker.source_path !== "string"
    || typeof marker.source_signature !== "string"
    || typeof marker.created_at !== "string"
  ) {
    throw new Error("Backup has an invalid maintenance validation marker.");
  }
  return {
    format: 1,
    source_path: marker.source_path,
    source_signature: marker.source_signature,
    created_at: marker.created_at,
  };
}

export class KbStore {
  db: DatabaseSync;

  private readonly dbPath: string;

  constructor(db: DatabaseSync = openDb(), path = kbPath()) {
    this.db = db;
    this.dbPath = resolve(path);
  }
  path(): string { return this.dbPath; }
  dispose(): void { this.db.close(); }
  init(): { path: string; schemaVersion: number } { return { path: this.path(), schemaVersion: 1 }; }

  get(id: string): KbRecord | null {
    const row = this.db.prepare("SELECT * FROM records WHERE id = ?").get(id);
    return row ? rowToRecord(row) : null;
  }

  upsert(input: UpsertInput, opts: { forceDurable?: boolean } = {}): KbRecord {
    if (!input.id?.trim()) throw new Error("id is required.");
    if (!input.title?.trim()) throw new Error("title is required.");
    assertType(input.type);
    const existing = this.get(input.id);
    const durableNew = includes(durableTypes, input.type) && !existing;
    if (durableNew && !opts.forceDurable) throw new Error("New durable records require forceDurable/--durable; agents should create proposals then promote.");
    if (existing && existing.type !== input.type) throw new Error(`Cannot change type for existing record ${input.id} (${existing.type} -> ${input.type}).`);
    const status = input.status ?? existing?.status ?? defaultStatus(input.type);
    assertStatus(input.type, status);
    const confidence = input.confidence ?? existing?.confidence ?? "medium";
    assertConfidence(confidence);
    const source = input.source ?? existing?.source ?? "user";
    assertSource(source);
    const tags = input.tags ?? existing?.tags ?? [];
    const evidence = input.evidence ?? existing?.evidence ?? [];
    const body = input.body ?? existing?.body ?? "";
    const summary = input.summary ?? existing?.summary ?? "";
    const project = input.project !== undefined ? input.project : existing?.project ?? null;
    assertNoObviousSecrets([input.id, input.title, project, summary, body, ...tags, ...evidence]);
    const ts = now();
    const record = {
      id: input.id.trim(), type: input.type, title: input.title.trim(), status,
      project: project?.trim() || null, tags: JSON.stringify(tags), body, summary,
      confidence, evidence: JSON.stringify(evidence), supersedes: input.supersedes ?? existing?.supersedes ?? null,
      created_at: existing?.created_at ?? ts, updated_at: ts,
      last_verified_at: input.last_verified_at !== undefined ? input.last_verified_at : existing?.last_verified_at ?? null,
      source,
    };
    this.db.prepare(`INSERT INTO records (id,type,title,status,project,tags,body,summary,confidence,evidence,supersedes,created_at,updated_at,last_verified_at,source)
      VALUES (@id,@type,@title,@status,@project,@tags,@body,@summary,@confidence,@evidence,@supersedes,@created_at,@updated_at,@last_verified_at,@source)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,status=excluded.status,project=excluded.project,tags=excluded.tags,body=excluded.body,summary=excluded.summary,confidence=excluded.confidence,evidence=excluded.evidence,supersedes=excluded.supersedes,updated_at=excluded.updated_at,last_verified_at=excluded.last_verified_at,source=excluded.source`).run(record);
    const saved = this.get(input.id);
    if (!saved) throw new Error(`Failed to read saved record ${input.id}.`);
    return saved;
  }

  promote(sourceId: string, input: PromoteInput, opts: { allowHandoff?: boolean } = {}): KbRecord {
    const src = this.get(sourceId);
    if (!src) throw new Error(`Source record not found: ${sourceId}.`);
    if (src.type !== "proposal" && !(opts.allowHandoff && src.type === "handoff")) throw new Error("Promote source must be a proposal unless allowHandoff is explicit.");
    assertDurable(input.type);
    const status = input.status ?? (input.type === "troubleshoot" && src.status === "closed" ? "done" : "active");
    assertStatus(input.type, status);
    const title = input.title ?? src.title;
    const id = input.id ?? `${input.type}:${slug(title)}`;
    const durable = this.upsert({
      id, type: input.type, title, status, project: input.project !== undefined ? input.project : src.project,
      tags: input.tags ?? src.tags, body: input.body ?? src.body, summary: input.summary ?? src.summary,
      confidence: input.confidence ?? src.confidence, evidence: input.evidence ?? src.evidence,
      supersedes: sourceId, last_verified_at: input.last_verified_at ?? null, source: src.source === "user" ? "user" : "agent_promoted",
    }, { forceDurable: true });
    if (src.type === "proposal") this.upsert({ ...src, status: "promoted" }, { forceDurable: false });
    return durable;
  }

  close(id: string, status = "closed"): KbRecord {
    const rec = this.get(id);
    if (!rec) throw new Error(`Record not found: ${id}.`);
    if (rec.type !== "handoff") throw new Error("close only applies to handoff records.");
    return this.upsert({ ...rec, status }, { forceDurable: false });
  }

  supersede(oldId: string, newId: string): KbRecord {
    const old = this.get(oldId);
    if (!old) throw new Error(`Old record not found: ${oldId}.`);
    if (!this.get(newId)) throw new Error(`New record not found: ${newId}.`);
    const status = old.type === "decision" ? "superseded" : allowedStatuses[old.type].includes("deprecated") ? "deprecated" : "archived";
    return this.upsert({ ...old, status, supersedes: newId }, { forceDurable: includes(durableTypes, old.type) });
  }

  /**
   * Hybrid lexical search: FTS candidate lists → RRF → calibrated metadata rerank.
   * Existing callers receive full records; diagnostics use the same ranked result internally.
   */
  search(query = "", filters: SearchFilters = {}): KbRecord[] {
    return this.rankSearch(query, filters).map((hit) => hit.record);
  }

  /** Compact opt-in score diagnostics. Full body, evidence, tags, and lineage are excluded. */
  searchWithDiagnostics(query = "", filters: SearchFilters = {}): SearchDiagnosticHit[] {
    return this.rankSearch(query, filters).map((hit) => hit.diagnostic);
  }

  private rankSearch(query: string, filters: SearchFilters): RankedSearchHit[] {
    const limit = Math.max(1, Math.min(filters.limit ?? 20, 100));
    const filterClauses: string[] = [];
    const filterParams: Record<string, unknown> = {};
    if (filters.type) { assertType(filters.type); filterClauses.push("r.type = @type"); filterParams.type = filters.type; }
    if (filters.status) { filterClauses.push("r.status = @status"); filterParams.status = filters.status; }
    if (filters.project) { filterClauses.push("r.project = @project"); filterParams.project = filters.project; }

    const passesFilters = (row: KbRecord): boolean => {
      if (filters.type && row.type !== filters.type) return false;
      if (filters.status && row.status !== filters.status) return false;
      if (filters.project && row.project !== filters.project) return false;
      return true;
    };

    const listByRecency = (): RankedSearchHit[] => {
      const where = filterClauses.length ? `WHERE ${filterClauses.join(" AND ")}` : "";
      const nowMs = Date.now();
      return this.db.prepare(
        `SELECT r.* FROM records r ${where} ORDER BY r.updated_at DESC LIMIT @limit`,
      ).all({ ...filterParams, limit }).map(rowToRecord).map((record) => ({
        record,
        diagnostic: diagnosticHit(record, {
          rankingMode: "recency",
          exactIdMatch: false,
          rawRrfScore: 0,
          normalizedLexicalScore: 0,
          metadata: metadataComponents(record, nowMs, false),
          retrievalLists: [],
        }),
      }));
    };

    const trimmed = query.trim();
    const tokens = tokenize(trimmed);
    if (!trimmed || tokens.length === 0) return listByRecency();

    const pool = Math.max(limit, Math.min(CANDIDATE_POOL, 100));
    const runFts = (matchExpr: string): string[] => {
      try {
        const clauses = [...filterClauses, "records_fts MATCH @query"];
        const where = `WHERE ${clauses.join(" AND ")}`;
        return this.db.prepare(
          `SELECT r.id AS id FROM records_fts f JOIN records r ON r.id = f.id ${where} ORDER BY bm25(records_fts), r.updated_at DESC LIMIT @pool`,
        ).all({ ...filterParams, query: matchExpr, pool }).map((value) => stringField(objectRow(value), "id"));
      } catch {
        // Invalid or unsupported FTS expression for this query shape — skip the list.
        return [];
      }
    };

    const lists: RankedList[] = [];

    // Exact id hit (highest weight): full trimmed string matches a record id.
    const exact = this.get(trimmed);
    if (exact && passesFilters(exact)) {
      lists.push({ name: "exact_id", weight: 3.0, ids: [exact.id] });
    }

    // Phrase match for multi-token queries (exact token sequence).
    if (tokens.length >= 2) {
      const phraseIds = runFts(ftsPhrase(tokens));
      if (phraseIds.length) lists.push({ name: "phrase", weight: 2.0, ids: phraseIds });
    }

    // All terms must appear (stricter than OR).
    if (tokens.length >= 2) {
      const andIds = runFts(ftsAnd(tokens));
      if (andIds.length) lists.push({ name: "and", weight: 1.5, ids: andIds });
    }

    // Title / tags bias: good for short labels and identifiers.
    const titleTagIds = runFts(ftsTitleTags(tokens));
    if (titleTagIds.length) lists.push({ name: "title_tags", weight: 1.5, ids: titleTagIds });

    // Broad OR lexical net (always when tokens exist).
    const orIds = runFts(ftsOr(tokens));
    if (orIds.length) lists.push({ name: "or", weight: 1.0, ids: orIds });

    if (lists.length === 0) return [];

    const fused = fuseRrf(lists);
    let maxRawRrfScore = 0;
    for (const score of fused.scores.values()) {
      if (score > maxRawRrfScore) maxRawRrfScore = score;
    }

    const nowMs = Date.now();
    const ranked: RankedSearchHit[] = [];
    for (const [id, rawRrfScore] of fused.scores) {
      const record = this.get(id);
      if (!record || !passesFilters(record)) continue;
      ranked.push({
        record,
        diagnostic: scoreLexicalHit(
          record,
          rawRrfScore,
          maxRawRrfScore,
          trimmed,
          nowMs,
          fused.contributions.get(id) ?? [],
        ),
      });
    }
    ranked.sort((a, b) =>
      b.diagnostic.final_score - a.diagnostic.final_score
      || a.record.id.localeCompare(b.record.id));
    return ranked.slice(0, limit);
  }

  maintain(staleDays = 14): MaintenanceReport {
    assertPositiveDays(staleDays, "stale-days");
    const cutoff = new Date(Date.now() - staleDays * DAY_MS).toISOString();
    const summaryColumns = "id,type,status,title,updated_at,last_verified_at";
    const summaries = (where: string, params: Record<string, string> = {}): RecordSummary[] =>
      this.db.prepare(`SELECT ${summaryColumns} FROM records WHERE ${where} ORDER BY updated_at ASC,id ASC`).all(params).map(rowToSummary);

    const promoted = summaries("type='proposal' AND status='promoted'");
    const targets = this.db.prepare(
      `SELECT supersedes AS proposal_id,id AS target_id FROM records
       WHERE type IN (${DURABLE_SQL}) AND supersedes IN
       (SELECT id FROM records WHERE type='proposal' AND status='promoted')
       ORDER BY id`,
    ).all();
    const targetsByProposal = new Map<string, string[]>();
    for (const value of targets) {
      const row = objectRow(value);
      const proposalId = stringField(row, "proposal_id");
      const existing = targetsByProposal.get(proposalId);
      const targetId = stringField(row, "target_id");
      if (existing) existing.push(targetId);
      else targetsByProposal.set(proposalId, [targetId]);
    }
    const promotedProposals: PromotedProposalSummary[] = promoted.map((proposal) => {
      const durableTargetIds = targetsByProposal.get(proposal.id) ?? [];
      return {
        ...proposal,
        durable_target_ids: durableTargetIds,
        has_exactly_one_durable_target: durableTargetIds.length === 1,
      };
    });

    return {
      generated_at: now(),
      stale_days: staleDays,
      database: {
        path: this.path(),
        size_bytes: statSync(this.path()).size,
        quick_check: quickCheck(this.db),
      },
      stale_open_or_blocked_handoffs: summaries("type='handoff' AND status IN ('open','blocked') AND updated_at < @cutoff", { cutoff }),
      promoted_proposals: promotedProposals,
      rejected_proposals: summaries("type='proposal' AND status='rejected'"),
      closed_or_archived_handoffs: summaries("type='handoff' AND status IN ('closed','archived')"),
      inactive_durable_records: summaries(`type IN (${DURABLE_SQL}) AND status IN ('deprecated','superseded','archived')`),
      active_durable_missing_verification: summaries(`type IN (${DURABLE_SQL}) AND status IN ('active','done') AND last_verified_at IS NULL`),
    };
  }

  private lifecycleSummary(id: string): RecordSummary {
    const row = this.db.prepare(
      "SELECT id,type,status,title,updated_at,last_verified_at FROM records WHERE id = ?",
    ).get(id);
    if (!row) throw new Error(`Record not found: ${id}.`);
    return rowToSummary(row);
  }

  archive(id: string): RecordSummary {
    const record = this.lifecycleSummary(id);
    const allowed =
      (record.type === "handoff" && record.status === "closed")
      || (record.type === "proposal" && (record.status === "promoted" || record.status === "rejected"))
      || (record.type === "decision" && record.status === "superseded")
      || ((record.type === "procedure" || record.type === "landscape" || record.type === "preference") && record.status === "deprecated")
      || (record.type === "troubleshoot" && (record.status === "done" || record.status === "deprecated"));
    if (!allowed) {
      throw new Error(`Cannot archive ${record.type} '${id}' from status '${record.status}'. Only terminal records may be archived.`);
    }
    this.db.prepare("UPDATE records SET status='archived',updated_at=? WHERE id=?").run(now(), id);
    return this.lifecycleSummary(id);
  }

  restore(id: string, status: string): RecordSummary {
    const record = this.lifecycleSummary(id);
    if (record.status !== "archived") throw new Error(`Restore requires archived status; '${id}' is '${record.status}'.`);
    assertStatus(record.type, status);
    if (status === "archived") throw new Error("Restore status must differ from archived.");
    this.db.prepare("UPDATE records SET status=?,updated_at=? WHERE id=?").run(status, now(), id);
    return this.lifecycleSummary(id);
  }

  verify(id: string, date: string): RecordSummary {
    assertIsoCalendarDate(date);
    this.lifecycleSummary(id);
    this.db.prepare("UPDATE records SET last_verified_at=?,updated_at=? WHERE id=?").run(date, now(), id);
    return this.lifecycleSummary(id);
  }

  private databaseSignature(db: DatabaseSync): string {
    const metadata = db.prepare(
      "SELECT id,type,status,updated_at,last_verified_at,supersedes FROM records ORDER BY id",
    ).all();
    return createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
  }

  async backup(output?: string): Promise<BackupResult> {
    const createdAt = now();
    const generated = `${this.path()}.backup-${createdAt.replaceAll(/[-:.]/g, "")}.sqlite`;
    if (output !== undefined && (!output.trim() || output.includes("\0"))) {
      throw new Error("Backup output must be a non-empty filesystem path.");
    }
    const destination = resolve(output ?? generated);
    if (destination === this.path()) throw new Error("Backup output must differ from the source database.");

    let reserved = false;
    try {
      const fd = openSync(destination, "wx", 0o600);
      closeSync(fd);
      reserved = true;
      await backup(this.db, destination);

      const backupDb = new DatabaseSync(destination);
      try {
        const sourceSignature = this.databaseSignature(this.db);
        const backupSignature = this.databaseSignature(backupDb);
        if (sourceSignature !== backupSignature) throw new Error("Backup does not match current source metadata.");
        const marker: BackupMarker = {
          format: 1,
          source_path: this.path(),
          source_signature: sourceSignature,
          created_at: createdAt,
        };
        backupDb.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)").run(BACKUP_MARKER_KEY, JSON.stringify(marker));
        if (quickCheck(backupDb) !== "ok") throw new Error("Backup quick_check failed.");
      } finally {
        backupDb.close();
      }
      chmodSync(destination, 0o600);
      return { path: destination, created_at: createdAt, size_bytes: statSync(destination).size, quick_check: "ok" };
    } catch (error) {
      if (reserved) {
        try {
          unlinkSync(destination);
        } catch (cleanupError) {
          throw new Error(`Backup failed and cleanup of '${destination}' also failed.`, { cause: new AggregateError([error, cleanupError]) });
        }
      }
      if (!reserved && typeof error === "object" && error !== null && Reflect.get(error, "code") === "EEXIST") {
        throw new Error(`Backup output already exists: ${destination}.`, { cause: error });
      }
      throw error;
    }
  }

  private validateFreshBackup(path: string): string {
    if (!path.trim() || path.includes("\0")) throw new Error("backup must be a non-empty filesystem path.");
    const backupPath = resolve(path);
    if (backupPath === this.path()) throw new Error("The live source database is not a backup.");
    const file = lstatSync(backupPath);
    if (!file.isFile()) throw new Error("Backup path must name a regular file.");
    if ((file.mode & 0o077) !== 0) throw new Error("Backup permissions are not private.");

    const backupDb = new DatabaseSync(backupPath, { readOnly: true });
    try {
      if (quickCheck(backupDb) !== "ok") throw new Error("Backup quick_check failed.");
      const markerValue = backupDb.prepare("SELECT value FROM meta WHERE key=?").get(BACKUP_MARKER_KEY);
      if (!markerValue) throw new Error("Backup lacks a maintenance validation marker.");
      const marker = parseBackupMarker(objectRow(markerValue).value);
      if (resolve(marker.source_path) !== this.path()) throw new Error("Backup was produced for a different source database.");
      const createdMs = Date.parse(marker.created_at);
      const age = Date.now() - createdMs;
      if (!Number.isFinite(createdMs) || age < -60_000 || age > BACKUP_FRESH_MS) {
        throw new Error("Backup is not fresh; create one within 15 minutes of prune --apply.");
      }
      const sourceSignature = this.databaseSignature(this.db);
      const backupSignature = this.databaseSignature(backupDb);
      if (marker.source_signature !== sourceSignature || backupSignature !== sourceSignature) {
        throw new Error("Backup no longer matches the source database state.");
      }
      return backupPath;
    } finally {
      backupDb.close();
    }
  }

  pruneCandidates(): PruneCandidate[] {
    const promotedCutoff = new Date(Date.now() - 30 * DAY_MS).toISOString();
    const terminalCutoff = new Date(Date.now() - 90 * DAY_MS).toISOString();
    const rows = this.db.prepare(
      `SELECT r.id,r.type,r.status,r.updated_at,
        (SELECT COUNT(*) FROM records d WHERE d.supersedes=r.id AND d.type IN (${DURABLE_SQL})) AS target_count,
        (SELECT MIN(d.id) FROM records d WHERE d.supersedes=r.id AND d.type IN (${DURABLE_SQL})) AS target_id
       FROM records r
       WHERE (r.type='proposal' AND r.status IN ('promoted','archived') AND r.updated_at<=@promoted_cutoff)
          OR (r.type='proposal' AND r.status='rejected' AND r.updated_at<=@terminal_cutoff)
          OR (r.type='handoff' AND r.status='archived' AND r.updated_at<=@terminal_cutoff)
       ORDER BY r.id`,
    ).all({ promoted_cutoff: promotedCutoff, terminal_cutoff: terminalCutoff });
    const candidates: PruneCandidate[] = [];
    for (const value of rows) {
      const row = objectRow(value);
      const id = stringField(row, "id");
      const type = stringField(row, "type");
      const status = stringField(row, "status");
      const updatedAt = stringField(row, "updated_at");
      if (type === "proposal" && (status === "promoted" || status === "archived")) {
        if (Number(row.target_count) !== 1) continue;
        candidates.push({
          id,
          type,
          status,
          updated_at: updatedAt,
          reason: status === "archived"
            ? "archived promoted proposal retained at least 30 days since archival/update with exactly one durable promotion target"
            : "promoted proposal retained at least 30 days with exactly one durable promotion target",
          durable_target_id: stringField(row, "target_id"),
        });
      } else if (type === "proposal" && status === "rejected") {
        candidates.push({ id, type, status, updated_at: updatedAt, reason: "rejected proposal retained at least 90 days" });
      } else if (type === "handoff" && status === "archived") {
        candidates.push({ id, type, status, updated_at: updatedAt, reason: "archived handoff retained at least 90 days" });
      }
    }
    return candidates;
  }

  prune(): PruneResult;
  prune(options: { apply: true; backupPath: string }): PruneResult;
  prune(options?: { apply: true; backupPath: string }): PruneResult {
    if (!options) {
      return { applied: false, candidates: this.pruneCandidates(), deleted_ids: [], backup_path: null };
    }

    let result: PruneResult;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const candidates = this.pruneCandidates();
      const backupPath = this.validateFreshBackup(options.backupPath);
      const remove = this.db.prepare("DELETE FROM records WHERE id=?");
      for (const candidate of candidates) remove.run(candidate.id);
      if (this.db.prepare("PRAGMA foreign_key_check").all().length !== 0) {
        throw new Error("foreign_key_check failed after prune.");
      }
      if (quickCheck(this.db) !== "ok") throw new Error("quick_check failed after prune.");
      result = {
        applied: true,
        candidates,
        deleted_ids: candidates.map((candidate) => candidate.id),
        backup_path: backupPath,
      };
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new Error("Prune failed and the transaction could not be rolled back.", { cause: new AggregateError([error, rollbackError]) });
      }
      throw error;
    }
    if (quickCheck(this.db) !== "ok") throw new Error("quick_check failed after prune commit; restore from the reported backup.");
    return result;
  }

  purgeCandidates(staleDays = 14): KbRecord[] {
    assertPositiveDays(staleDays, "stale-days");
    const cutoff = new Date(Date.now() - staleDays * DAY_MS).toISOString();
    return this.db.prepare(`SELECT * FROM records WHERE status IN ('closed','archived','rejected','promoted','deprecated','superseded') OR (type='handoff' AND updated_at < @cutoff) ORDER BY updated_at ASC LIMIT 100`).all({ cutoff }).map(rowToRecord);
  }

  status(): { path: string; counts: Array<{ type: string; status: string; count: number }> } {
    const counts = this.db.prepare(
      "SELECT type,status,COUNT(*) AS count FROM records GROUP BY type,status ORDER BY type,status",
    ).all().map((value) => {
      const row = objectRow(value);
      return { type: stringField(row, "type"), status: stringField(row, "status"), count: Number(row.count) };
    });
    return { path: this.path(), counts };
  }
}

export function createStore(): KbStore { return new KbStore(); }
