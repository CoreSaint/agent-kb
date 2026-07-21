import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DDL, SCHEMA_VERSION } from "./schema.ts";

export function kbPath(): string {
  const explicit = process.env.AGENT_KB_PATH?.trim();
  if (explicit) return explicit.replace(/^~(?=\/|$)/, homedir());
  return join(homedir(), ".local", "share", "agent-kb", "kb.sqlite");
}
function readSchemaVersion(db: DatabaseSync): number | null {
  const meta = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if (typeof meta !== "object" || meta === null || Array.isArray(meta) || Number(meta.count) === 0) return null;
  const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  if (typeof row !== "object" || row === null || Array.isArray(row) || typeof row.value !== "string" || !/^\d+$/.test(row.value)) {
    throw new Error("Invalid or missing agent-KB schema_version metadata.");
  }
  return Number(row.value);
}


export function openDb(path = kbPath()): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    // Allow concurrent CLI + Pi extension writers to wait instead of failing immediately.
    db.exec("PRAGMA busy_timeout = 5000;");
    const version = readSchemaVersion(db);
    if (version === null) {
      const schemaObjects = db.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
      ).get();
      if (
        typeof schemaObjects !== "object"
        || schemaObjects === null
        || Array.isArray(schemaObjects)
        || Number(schemaObjects.count) !== 0
      ) {
        throw new Error("Database has application schema objects but no agent-KB metadata; refusing schema-v2 bootstrap.");
      }
    }
    if (version === 1) {
      throw new Error("Agent-KB schema v1 requires explicit migration. Run `kb migrate` to preview, then `kb migrate --apply`.");
    }
    if (version !== null && version !== SCHEMA_VERSION) {
      throw new Error(`Unsupported agent-KB schema version ${version}; expected ${SCHEMA_VERSION}.`);
    }
    db.exec(DDL);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
