import type { DatabaseSync } from "node:sqlite";
import { openDb, kbPath } from "./db.ts";
import { assertNoObviousSecrets } from "./secrets.ts";
import { allowedStatuses, confidences, defaultStatus, durableTypes, recordTypes, sources, type DurableType, type KbRecord, type PromoteInput, type RecordType, type Source, type UpsertInput } from "./types.ts";

function now(): string { return new Date().toISOString(); }
function includes<T extends readonly string[]>(list: T, value: string): value is T[number] { return list.includes(value as T[number]); }
function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || !value.trim()) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("Expected JSON array");
  return parsed.map(String);
}
function rowToRecord(row: any): KbRecord {
  return { ...row, tags: parseJsonArray(row.tags), evidence: parseJsonArray(row.evidence) } as KbRecord;
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

type RankedList = { weight: number; ids: string[] };

/** Terminal / non-authoritative statuses: still returnable, but demoted unless filtered explicitly. */
const DEMOTED_STATUSES = new Set([
  "promoted", "deprecated", "superseded", "archived", "rejected", "closed",
]);

function fuseRrf(lists: RankedList[]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const { weight, ids } of lists) {
    ids.forEach((id, index) => {
      const rank = index + 1;
      scores.set(id, (scores.get(id) ?? 0) + weight / (RRF_K + rank));
    });
  }
  return scores;
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

function rerankScore(
  rec: KbRecord,
  rrf: number,
  opts: { query: string; nowMs: number },
): number {
  // Exact id paste must always win over near-ties.
  if (rec.id === opts.query) return rrf + 10;
  return (
    rrf +
    statusBoost(rec.type, rec.status) +
    typeBoost(rec.type) +
    confidenceBoost(rec.confidence) +
    freshnessBoost(rec, opts.nowMs)
  );
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "record";
}

export class KbStore {
  db: DatabaseSync;

  constructor(db: DatabaseSync = openDb()) {
    this.db = db;
  }
  path(): string { return kbPath(); }
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
    const durableNew = durableTypes.includes(input.type as DurableType) && !existing;
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
    return this.get(input.id)!;
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
    return this.upsert({ ...old, status, supersedes: newId }, { forceDurable: durableTypes.includes(old.type as DurableType) });
  }

  /**
   * Hybrid lexical search: FTS candidate lists → RRF → metadata-aware rerank.
   * Lists (when applicable): exact id, phrase, AND, title/tags, OR.
   * Rerank uses status, type, confidence, and type-aware freshness (no LLM).
   * Empty / non-token queries fall back to recency under the same filters.
   */
  search(query = "", filters: { type?: string; status?: string; project?: string; limit?: number } = {}): KbRecord[] {
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

    const listByRecency = (): KbRecord[] => {
      const where = filterClauses.length ? `WHERE ${filterClauses.join(" AND ")}` : "";
      return this.db.prepare(
        `SELECT r.* FROM records r ${where} ORDER BY r.updated_at DESC LIMIT @limit`,
      ).all({ ...filterParams, limit }).map(rowToRecord);
    };

    const trimmed = query.trim();
    const tokens = tokenize(trimmed);
    if (!trimmed || tokens.length === 0) return listByRecency();

    const pool = Math.max(limit, Math.min(CANDIDATE_POOL, 100));
    const runFts = (matchExpr: string): string[] => {
      try {
        const clauses = [...filterClauses, "records_fts MATCH @query"];
        const where = `WHERE ${clauses.join(" AND ")}`;
        const rows = this.db.prepare(
          `SELECT r.id AS id FROM records_fts f JOIN records r ON r.id = f.id ${where} ORDER BY bm25(records_fts), r.updated_at DESC LIMIT @pool`,
        ).all({ ...filterParams, query: matchExpr, pool }) as Array<{ id: string }>;
        return rows.map((r) => r.id);
      } catch {
        // Invalid or unsupported FTS expression for this query shape — skip the list.
        return [];
      }
    };

    const lists: RankedList[] = [];

    // Exact id hit (highest weight): full trimmed string matches a record id.
    const exact = this.get(trimmed);
    if (exact && passesFilters(exact)) {
      lists.push({ weight: 3.0, ids: [exact.id] });
    }

    // Phrase match for multi-token queries (exact token sequence).
    if (tokens.length >= 2) {
      const phraseIds = runFts(ftsPhrase(tokens));
      if (phraseIds.length) lists.push({ weight: 2.0, ids: phraseIds });
    }

    // All terms must appear (stricter than OR).
    if (tokens.length >= 2) {
      const andIds = runFts(ftsAnd(tokens));
      if (andIds.length) lists.push({ weight: 1.5, ids: andIds });
    }

    // Title / tags bias: good for short labels and identifiers.
    const titleTagIds = runFts(ftsTitleTags(tokens));
    if (titleTagIds.length) lists.push({ weight: 1.5, ids: titleTagIds });

    // Broad OR lexical net (always when tokens exist).
    const orIds = runFts(ftsOr(tokens));
    if (orIds.length) lists.push({ weight: 1.0, ids: orIds });

    if (lists.length === 0) return [];

    const rrfScores = fuseRrf(lists);
    const nowMs = Date.now();
    const ranked: Array<{ rec: KbRecord; score: number }> = [];
    for (const [id, rrf] of rrfScores) {
      const rec = this.get(id);
      if (!rec || !passesFilters(rec)) continue;
      ranked.push({
        rec,
        score: rerankScore(rec, rrf, { query: trimmed, nowMs }),
      });
    }
    ranked.sort((a, b) => b.score - a.score || a.rec.id.localeCompare(b.rec.id));
    return ranked.slice(0, limit).map((x) => x.rec);
  }

  purgeCandidates(staleDays = 14): KbRecord[] {
    const cutoff = new Date(Date.now() - staleDays * 86400_000).toISOString();
    return this.db.prepare(`SELECT * FROM records WHERE status IN ('closed','archived','rejected','promoted','deprecated','superseded') OR (type='handoff' AND updated_at < @cutoff) ORDER BY updated_at ASC LIMIT 100`).all({ cutoff }).map(rowToRecord);
  }

  status(): { path: string; counts: Array<{ type: string; status: string; count: number }> } {
    return { path: this.path(), counts: this.db.prepare("SELECT type,status,COUNT(*) AS count FROM records GROUP BY type,status ORDER BY type,status").all() as any };
  }
}

export function createStore(): KbStore { return new KbStore(); }
