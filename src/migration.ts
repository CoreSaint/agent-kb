import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { durableTypes, type LegacyLineageAmbiguity, type MigrationReport } from "./types.ts";
import { SCHEMA_VERSION } from "./schema.ts";

const REPORT_LIMIT = 100;
const DURABLE: Readonly<Record<string, true>> = Object.fromEntries(
  durableTypes.map((type) => [type, true]),
);

type LegacyRecordFact = {
  id: string;
  type: string;
  status: string;
  supersedes: string | null;
};

type ClassifiedLink =
  | { kind: "promotion"; recordId: string; targetId: string }
  | { kind: "replacement"; recordId: string; targetId: string }
  | { kind: "ambiguous"; recordId: string; targetId: string; reason: string };

function rowObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected SQLite row object.");
  return value;
}

function rowString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new Error(`Expected string field '${field}'.`);
  return value;
}

function schemaVersion(db: DatabaseSync): number {
  const metaExists = rowObject(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='meta'").get()).count;
  if (Number(metaExists) !== 1) throw new Error("Database has no agent-KB schema metadata.");
  const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  if (!row) throw new Error("Database has no schema_version metadata.");
  const value = rowString(rowObject(row), "value");
  if (!/^\d+$/.test(value)) throw new Error(`Invalid schema_version '${value}'.`);
  return Number(value);
}

function assertV1Shape(db: DatabaseSync): void {
  const columns = new Set(db.prepare("PRAGMA table_info(records)").all().map((value) => rowString(rowObject(value), "name")));
  for (const required of ["id", "type", "status", "supersedes"]) {
    if (!columns.has(required)) throw new Error(`Schema-v1 records table lacks required column '${required}'.`);
  }
  if (columns.has("promoted_from") || columns.has("superseded_by")) {
    throw new Error("Schema-v1 metadata conflicts with schema-v2 lineage columns; refusing migration.");
  }
}

function legacyFacts(db: DatabaseSync): LegacyRecordFact[] {
  return db.prepare("SELECT id,type,status,supersedes FROM records ORDER BY id").all().map((value) => {
    const row = rowObject(value);
    const supersedes = row.supersedes;
    if (supersedes !== null && typeof supersedes !== "string") throw new Error("Legacy supersedes value is not text or null.");
    return {
      id: rowString(row, "id"),
      type: rowString(row, "type"),
      status: rowString(row, "status"),
      supersedes,
    };
  });
}

function classify(facts: readonly LegacyRecordFact[]): ClassifiedLink[] {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const links: ClassifiedLink[] = [];
  for (const fact of facts) {
    if (fact.supersedes === null) continue;
    const targetId = fact.supersedes;
    if (fact.id === targetId) {
      links.push({ kind: "ambiguous", recordId: fact.id, targetId, reason: "self_link" });
      continue;
    }
    const target = byId.get(targetId);
    if (!target) {
      links.push({ kind: "ambiguous", recordId: fact.id, targetId, reason: "missing_target" });
      continue;
    }
    if (DURABLE[target.type]) {
      links.push({ kind: "replacement", recordId: fact.id, targetId });
      continue;
    }
    if (DURABLE[fact.type] && (target.type === "proposal" || target.type === "handoff")) {
      links.push({ kind: "promotion", recordId: fact.id, targetId });
      continue;
    }
    links.push({
      kind: "ambiguous",
      recordId: fact.id,
      targetId,
      reason: `unsafe_type_combination:${fact.type}->${target.type}`,
    });
  }
  return links;
}

function quickCheck(db: DatabaseSync): string {
  return rowString(rowObject(db.prepare("PRAGMA quick_check").get()), "quick_check");
}

function buildReport(
  path: string,
  mode: "preview" | "applied",
  facts: readonly LegacyRecordFact[],
  links: readonly ClassifiedLink[],
  check: string,
): MigrationReport {
  const promotions = links.filter((link) => link.kind === "promotion");
  const replacements = links.filter((link) => link.kind === "replacement");
  const ambiguities: LegacyLineageAmbiguity[] = links
    .filter((link) => link.kind === "ambiguous")
    .map((link) => ({ record_id: link.recordId, target_id: link.targetId, reason: link.reason }));
  const promotionTargets = new Map<string, string[]>();
  for (const link of promotions) {
    const targets = promotionTargets.get(link.targetId);
    if (targets) targets.push(link.recordId);
    else promotionTargets.set(link.targetId, [link.recordId]);
  }
  const review = facts
    .filter((fact) => fact.type === "proposal" && fact.status === "promoted")
    .map((fact) => ({ proposal_id: fact.id, durable_target_ids: promotionTargets.get(fact.id) ?? [] }))
    .filter((item) => item.durable_target_ids.length !== 1);
  return {
    mode,
    path: resolve(path),
    from_schema_version: 1,
    to_schema_version: SCHEMA_VERSION,
    legacy_link_count: links.length,
    promotion_count: promotions.length,
    replacement_count: replacements.length,
    ambiguity_count: ambiguities.length,
    ambiguities: ambiguities.slice(0, REPORT_LIMIT),
    ambiguities_truncated: ambiguities.length > REPORT_LIMIT,
    promoted_proposal_review_count: review.length,
    promoted_proposal_review: review.slice(0, REPORT_LIMIT),
    promoted_proposal_review_truncated: review.length > REPORT_LIMIT,
    quick_check: check,
  };
}

export function migrateV1ToV2(path: string, apply: boolean): MigrationReport {
  if (!path.trim() || path.includes("\0")) throw new Error("Migration path must be a non-empty filesystem path.");
  const db = new DatabaseSync(path, { readOnly: !apply });
  try {
    const version = schemaVersion(db);
    if (version !== 1) {
      throw new Error(version === SCHEMA_VERSION
        ? "Database is already schema v2; refusing migration reapplication."
        : `Migration supports schema v1 only; found schema v${version}.`);
    }
    assertV1Shape(db);
    const facts = legacyFacts(db);
    const links = classify(facts);
    const beforeCheck = quickCheck(db);
    if (beforeCheck !== "ok") throw new Error(`Pre-migration quick_check failed: ${beforeCheck}.`);
    if (!apply) return buildReport(path, "preview", facts, links, beforeCheck);

    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE lineage_migration_ambiguities (
          record_id TEXT NOT NULL,
          target_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          PRIMARY KEY (record_id, target_id)
        );
        ALTER TABLE records ADD COLUMN promoted_from TEXT;
        ALTER TABLE records ADD COLUMN superseded_by TEXT;
      `);
      const setPromotion = db.prepare("UPDATE records SET promoted_from=? WHERE id=?");
      const setReplacement = db.prepare("UPDATE records SET superseded_by=? WHERE id=?");
      const addAmbiguity = db.prepare("INSERT INTO lineage_migration_ambiguities(record_id,target_id,reason) VALUES (?,?,?)");
      for (const link of links) {
        if (link.kind === "promotion") setPromotion.run(link.targetId, link.recordId);
        else if (link.kind === "replacement") setReplacement.run(link.targetId, link.recordId);
        else addAmbiguity.run(link.recordId, link.targetId, link.reason);
      }
      db.exec("ALTER TABLE records DROP COLUMN supersedes;");
      if (db.prepare("PRAGMA foreign_key_check").all().length !== 0) throw new Error("Migration foreign_key_check failed.");
      const transactionalCheck = quickCheck(db);
      if (transactionalCheck !== "ok") throw new Error(`Migration quick_check failed: ${transactionalCheck}.`);
      db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(SCHEMA_VERSION));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const afterCheck = quickCheck(db);
    if (afterCheck !== "ok") throw new Error(`Post-migration quick_check failed: ${afterCheck}.`);
    return buildReport(path, "applied", facts, links, afterCheck);
  } finally {
    db.close();
  }
}
