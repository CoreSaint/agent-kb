import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { KbError } from "./errors.ts";
import { DDL, SCHEMA_VERSION } from "./schema.ts";

export const AUTHORITY_DOMAIN_KEY = "authority_domain_id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function kbPath(): string {
  const explicit = process.env.AGENT_KB_PATH?.trim();
  if (explicit) return resolve(explicit.replace(/^~(?=\/|$)/, homedir()));
  return join(homedir(), ".local", "share", "agent-kb", "kb.sqlite");
}


export function validateAuthorityDomain(value: string): string {
  const domain = value.trim().toLowerCase();
  if (!UUID.test(domain)) throw new KbError("INVALID_INPUT", "Authority domain must be a UUID.");
  return domain;
}

function readSchemaVersion(db: DatabaseSync): number | null {
  const meta = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if (typeof meta !== "object" || meta === null || Array.isArray(meta) || Number(meta.count) === 0) return null;
  const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  if (typeof row !== "object" || row === null || Array.isArray(row) || typeof row.value !== "string" || !/^\d+$/.test(row.value)) {
    throw new KbError("SCHEMA_MISMATCH", "Invalid or missing agent-KB schema_version metadata.");
  }
  return Number(row.value);
}

function authorityDomain(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(AUTHORITY_DOMAIN_KEY);
  if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.value !== "string") return null;
  return validateAuthorityDomain(row.value);
}

function configure(db: DatabaseSync): void {
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
}

function validateInitialized(db: DatabaseSync): void {
  const version = readSchemaVersion(db);
  if (version === null) throw new KbError("SCHEMA_MISMATCH", "Database has no agent-KB schema metadata.");
  if (version === 1 || version === 2) {
    throw new KbError(
      "MIGRATION_REQUIRED",
      `Agent-KB schema v${version} requires explicit migration. Run \`kb migrate\` to preview, then \`kb migrate --apply\`.`,
    );
  }
  if (version !== SCHEMA_VERSION) {
    throw new KbError("SCHEMA_MISMATCH", `Unsupported agent-KB schema version ${version}; expected ${SCHEMA_VERSION}.`);
  }
}

function validateIntegrity(db: DatabaseSync): void {
  const integrity = db.prepare("PRAGMA integrity_check").get();
  if (!integrity || typeof integrity !== "object" || Array.isArray(integrity) || integrity.integrity_check !== "ok") {
    throw new KbError("SCHEMA_MISMATCH", "Database integrity check failed.");
  }
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length !== 0) throw new KbError("SCHEMA_MISMATCH", "Database foreign-key check failed.");
}

type ColumnContract = Readonly<{
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  primaryKey: number;
}>;

const TABLE_CONTRACTS: Readonly<Record<"meta" | "records" | "lineage_migration_ambiguities", readonly ColumnContract[]>> = {
  meta: [
    { name: "key", type: "TEXT", notNull: false, defaultValue: null, primaryKey: 1 },
    { name: "value", type: "TEXT", notNull: true, defaultValue: null, primaryKey: 0 },
  ],
  records: [
    { name: "id", type: "TEXT", notNull: false, defaultValue: null, primaryKey: 1 },
    { name: "type", type: "TEXT", notNull: true, defaultValue: null, primaryKey: 0 },
    { name: "title", type: "TEXT", notNull: true, defaultValue: null, primaryKey: 0 },
    { name: "status", type: "TEXT", notNull: true, defaultValue: null, primaryKey: 0 },
    { name: "project", type: "TEXT", notNull: false, defaultValue: null, primaryKey: 0 },
    { name: "tags", type: "TEXT", notNull: true, defaultValue: "'[]'", primaryKey: 0 },
    { name: "body", type: "TEXT", notNull: true, defaultValue: "''", primaryKey: 0 },
    { name: "summary", type: "TEXT", notNull: true, defaultValue: "''", primaryKey: 0 },
    { name: "confidence", type: "TEXT", notNull: true, defaultValue: "'medium'", primaryKey: 0 },
    { name: "evidence", type: "TEXT", notNull: true, defaultValue: "'[]'", primaryKey: 0 },
    { name: "assertion_basis", type: "TEXT", notNull: false, defaultValue: null, primaryKey: 0 },
    { name: "as_of", type: "TEXT", notNull: false, defaultValue: null, primaryKey: 0 },
    { name: "expires_at", type: "TEXT", notNull: false, defaultValue: null, primaryKey: 0 },
    { name: "canonical_ids", type: "TEXT", notNull: true, defaultValue: "'[]'", primaryKey: 0 },
    { name: "promoted_from", type: "TEXT", notNull: false, defaultValue: null, primaryKey: 0 },
    { name: "superseded_by", type: "TEXT", notNull: false, defaultValue: null, primaryKey: 0 },
    { name: "created_at", type: "TEXT", notNull: true, defaultValue: null, primaryKey: 0 },
    { name: "updated_at", type: "TEXT", notNull: true, defaultValue: null, primaryKey: 0 },
    { name: "last_verified_at", type: "TEXT", notNull: false, defaultValue: null, primaryKey: 0 },
    { name: "source", type: "TEXT", notNull: true, defaultValue: "'user'", primaryKey: 0 },
  ],
  lineage_migration_ambiguities: [
    { name: "record_id", type: "TEXT", notNull: true, defaultValue: null, primaryKey: 1 },
    { name: "target_id", type: "TEXT", notNull: true, defaultValue: null, primaryKey: 2 },
    { name: "reason", type: "TEXT", notNull: true, defaultValue: null, primaryKey: 0 },
  ],
};

const FTS_COLUMNS = ["id", "title", "summary", "body", "project", "tags"];
const INDEX_CONTRACTS = [
  ["idx_records_type", "type"],
  ["idx_records_status", "status"],
  ["idx_records_project", "project"],
  ["idx_records_updated_at", "updated_at"],
] as const;

function rowObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new KbError("SCHEMA_MISMATCH", "Database schema metadata is malformed.");
  }
  return value;
}

function tableColumns(db: DatabaseSync, table: string): Map<string, ColumnContract> {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((value) => {
    const row = rowObject(value);
    return {
      name: String(row.name),
      type: String(row.type).trim().toUpperCase(),
      notNull: Number(row.notnull) === 1,
      defaultValue: row.dflt_value === null ? null : String(row.dflt_value).trim(),
      primaryKey: Number(row.pk),
    };
  });
  return new Map(columns.map((column) => [column.name, column]));
}

function validateTable(db: DatabaseSync, table: keyof typeof TABLE_CONTRACTS): void {
  const contract = TABLE_CONTRACTS[table];
  const actual = tableColumns(db, table);
  if (actual.size !== contract.length) throw new KbError("SCHEMA_MISMATCH", `Database ${table} table has an unsupported column set.`);
  for (const expected of contract) {
    const column = actual.get(expected.name);
    if (!column
      || column.type !== expected.type
      || column.notNull !== expected.notNull
      || column.defaultValue !== expected.defaultValue
      || column.primaryKey !== expected.primaryKey) {
      throw new KbError("SCHEMA_MISMATCH", `Database ${table}.${expected.name} column does not satisfy the schema-v3 contract.`);
    }
  }
}

function validateFts(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_xinfo(records_fts)").all()
    .map(rowObject)
    .filter((row) => Number(row.hidden) === 0)
    .map((row) => ({
      name: String(row.name),
      type: String(row.type).trim(),
      notNull: Number(row.notnull),
      defaultValue: row.dflt_value,
      primaryKey: Number(row.pk),
    }));
  if (columns.length !== FTS_COLUMNS.length || columns.some((column, index) =>
    column.name !== FTS_COLUMNS[index]
    || column.type !== ""
    || column.notNull !== 0
    || column.defaultValue !== null
    || column.primaryKey !== 0)) {
    throw new KbError("SCHEMA_MISMATCH", "Database records_fts columns do not satisfy the schema-v3 contract.");
  }
}

function validateIndexes(db: DatabaseSync): void {
  const indexes = new Map(db.prepare("PRAGMA index_list(records)").all().map((value) => {
    const row = rowObject(value);
    return [String(row.name), row];
  }));
  for (const [name, column] of INDEX_CONTRACTS) {
    const index = indexes.get(name);
    const columns = db.prepare(`PRAGMA index_info(${name})`).all().map((value) => String(rowObject(value).name));
    if (!index || Number(index.unique) !== 0 || index.origin !== "c" || columns.length !== 1 || columns[0] !== column) {
      throw new KbError("SCHEMA_MISMATCH", `Database ${name} index does not satisfy the schema-v3 contract.`);
    }
  }
}

function normalizeTriggerSql(sql: string): string {
  return sql.toUpperCase().replace(/[\s"'`[\]]/g, "");
}

function triggerSql(db: DatabaseSync, name: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name);
  const sql = rowObject(row).sql;
  if (typeof sql !== "string") throw new KbError("SCHEMA_MISMATCH", `Database ${name} trigger is missing.`);
  return normalizeTriggerSql(sql);
}

const TRIGGER_CONTRACTS: Readonly<Record<string, string>> = {
  records_ai: normalizeTriggerSql(`CREATE TRIGGER records_ai AFTER INSERT ON records BEGIN
    INSERT INTO records_fts(id, title, summary, body, project, tags)
    VALUES (new.id, new.title, new.summary, new.body, COALESCE(new.project, ''), new.tags);
  END`),
  records_ad: normalizeTriggerSql(`CREATE TRIGGER records_ad AFTER DELETE ON records BEGIN
    DELETE FROM records_fts WHERE id = old.id;
  END`),
  records_au: normalizeTriggerSql(`CREATE TRIGGER records_au AFTER UPDATE ON records BEGIN
    DELETE FROM records_fts WHERE id = old.id;
    INSERT INTO records_fts(id, title, summary, body, project, tags)
    VALUES (new.id, new.title, new.summary, new.body, COALESCE(new.project, ''), new.tags);
  END`),
};

function validateTriggers(db: DatabaseSync): void {
  for (const [name, expected] of Object.entries(TRIGGER_CONTRACTS)) {
    if (triggerSql(db, name) !== expected) {
      throw new KbError("SCHEMA_MISMATCH", `Database ${name} trigger does not satisfy the schema-v3 contract.`);
    }
  }
}

function validateSchemaV3(db: DatabaseSync): void {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','virtual table')").all()
    .map((row) => rowObject(row).name);
  for (const name of ["meta", "records", "lineage_migration_ambiguities", "records_fts"]) {
    if (!tables.includes(name)) throw new KbError("SCHEMA_MISMATCH", "Database schema-v3 tables are incomplete.");
  }
  validateTable(db, "meta");
  validateTable(db, "records");
  validateTable(db, "lineage_migration_ambiguities");
  validateFts(db);
  validateIndexes(db);
  validateTriggers(db);
  db.prepare("SELECT id,type,status FROM records WHERE 0");
  db.prepare("SELECT record_id,target_id,reason FROM lineage_migration_ambiguities WHERE 0");
  db.prepare("SELECT id,title,summary,body,project,tags FROM records_fts WHERE 0");
}

function validateExpectedDomain(db: DatabaseSync, expected = process.env.AGENT_KB_EXPECTED_DOMAIN): void {
  if (!expected?.trim()) return;
  const wanted = validateAuthorityDomain(expected);
  const actual = authorityDomain(db);
  if (actual !== wanted) {
    throw new KbError("DOMAIN_MISMATCH", `Authority domain mismatch: expected ${wanted}, attached ${actual ?? "unbound legacy database"}.`);
  }
}

export function openDb(path = kbPath(), expectedDomain = process.env.AGENT_KB_EXPECTED_DOMAIN): DatabaseSync {
  const target = resolve(path);
  if (!existsSync(target)) throw new KbError("DB_NOT_INITIALIZED", `Agent-KB is not initialized at ${target}. Run \`kb init\` explicitly.`);
  const db = new DatabaseSync(target);
  try {
    configure(db);
    validateInitialized(db);
    validateSchemaV3(db);
    validateExpectedDomain(db, expectedDomain);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function initDb(path = kbPath(), explicitDomain?: string): { db: DatabaseSync; domain: string } {
  const target = resolve(path);
  if (existsSync(target)) throw new KbError("CONFLICT", `Database already exists at ${target}; refusing to initialize over it.`);
  const domain = explicitDomain === undefined ? randomUUID() : validateAuthorityDomain(explicitDomain);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  let reserved = false;
  try {
    const fd = openSync(target, "wx", 0o600);
    closeSync(fd);
    reserved = true;
    const db = new DatabaseSync(target);
    try {
      configure(db);
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(DDL);
        db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(AUTHORITY_DOMAIN_KEY, domain);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      chmodSync(target, 0o600);
      return { db, domain };
    } catch (error) {
      db.close();
      throw error;
    }
  } catch (error) {
    if (reserved) rmSync(target, { force: true });
    throw error;
  }
}

function validateBindableSchemaV3(db: DatabaseSync): void {
  try {
    validateInitialized(db);
    validateSchemaV3(db);
    validateIntegrity(db);
  } catch (error) {
    if (error instanceof KbError) throw error;
    throw new KbError("SCHEMA_MISMATCH", "Database does not satisfy the schema-v3 operational contract.", { cause: error });
  }
}

export function bindAuthorityDomain(path = kbPath(), requestedDomain: string): string {
  const target = resolve(path);
  if (!existsSync(target)) throw new KbError("DB_NOT_INITIALIZED", `Agent-KB is not initialized at ${target}.`);
  const domain = validateAuthorityDomain(requestedDomain);
  const db = new DatabaseSync(target);
  try {
    configure(db);
    db.exec("BEGIN IMMEDIATE");
    try {
      validateBindableSchemaV3(db);
      if (authorityDomain(db) !== null) {
        throw new KbError("CONFLICT", "Database authority domain is already bound; refusing to replace it.");
      }
      db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(AUTHORITY_DOMAIN_KEY, domain);
      db.exec("COMMIT");
      return domain;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

export function readAuthorityDomain(db: DatabaseSync): string | null {
  return authorityDomain(db);
}
