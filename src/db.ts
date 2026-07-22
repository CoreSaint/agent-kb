import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { KbError } from "./errors.ts";
import { DDL, SCHEMA_VERSION } from "./schema.ts";

export const AUTHORITY_DOMAIN_KEY = "authority_domain_id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function discoverContractVault(start = process.cwd()): string | null {
  let current = realpathSync(start);
  while (true) {
    if (isFile(join(current, "CONTRACT.md")) && isFile(join(current, "MAP.md"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function kbPath(start?: string): string {
  const explicit = process.env.AGENT_KB_PATH?.trim();
  if (explicit) return resolve(explicit.replace(/^~(?=\/|$)/, homedir()));
  const vault = discoverContractVault(start ?? process.cwd());
  if (vault) return join(vault, ".agent-kb", "kb.sqlite");
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
  if (version === 1) {
    throw new KbError("MIGRATION_REQUIRED", "Agent-KB schema v1 requires explicit migration. Run `kb migrate` to preview, then `kb migrate --apply`.");
  }
  if (version !== SCHEMA_VERSION) {
    throw new KbError("SCHEMA_MISMATCH", `Unsupported agent-KB schema version ${version}; expected ${SCHEMA_VERSION}.`);
  }
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

export function readAuthorityDomain(db: DatabaseSync): string | null {
  return authorityDomain(db);
}
