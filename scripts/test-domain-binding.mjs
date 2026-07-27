#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const root = mkdtempSync(join(tmpdir(), "agent-kb-bind-domain-"));
const home = join(root, "home");
const database = join(root, "unbound.sqlite");
const cli = resolve(import.meta.dirname, "../src/cli.ts");
const initial = "11111111-1111-4111-8111-111111111111";
const bound = "22222222-2222-4222-8222-222222222222";
const env = { ...process.env, HOME: home, AGENT_KB_PATH: database };
delete env.AGENT_KB_EXPECTED_DOMAIN;

function run(args, additional = {}) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...env, ...additional }, encoding: "utf8" });
}
function machine(result) {
  assert.equal(result.stderr, "", result.stderr);
  return JSON.parse(result.stdout);
}
function expectError(args, code) {
  const result = run(args);
  assert.equal(result.status, 2, result.stdout || result.stderr);
  assert.equal(machine(result).error.code, code);
}
function initializeUnbound(path) {
  const result = run(["init", "--authority-domain", initial, "--json"], { AGENT_KB_PATH: path });
  assert.equal(result.status, 0, result.stdout || result.stderr);
  const db = new DatabaseSync(path);
  db.prepare("DELETE FROM meta WHERE key='authority_domain_id'").run();
  db.close();
}
function expectSchemaMismatch(path) {
  const result = run(["bind-domain", "--authority-domain", bound, "--json"], { AGENT_KB_PATH: path });
  assert.equal(result.status, 2, result.stdout || result.stderr);
  assert.equal(machine(result).error.code, "SCHEMA_MISMATCH");
  const db = new DatabaseSync(path);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='authority_domain_id'").get(), undefined, "failed schema validation left a domain binding");
  db.close();
}
function createV2(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta(key,value) VALUES('schema_version','2');
    CREATE TABLE records (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, project TEXT,
      tags TEXT NOT NULL DEFAULT '[]', body TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
      confidence TEXT NOT NULL DEFAULT 'medium', evidence TEXT NOT NULL DEFAULT '[]', promoted_from TEXT,
      superseded_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_verified_at TEXT,
      source TEXT NOT NULL DEFAULT 'user'
    );
    CREATE TABLE lineage_migration_ambiguities (
      record_id TEXT NOT NULL, target_id TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(record_id,target_id)
    );
    CREATE VIRTUAL TABLE records_fts USING fts5(id UNINDEXED,title,summary,body,project,tags);
    CREATE TRIGGER records_ai AFTER INSERT ON records BEGIN
      INSERT INTO records_fts(id,title,summary,body,project,tags)
      VALUES(new.id,new.title,new.summary,new.body,COALESCE(new.project,''),new.tags);
    END;
    CREATE TRIGGER records_ad AFTER DELETE ON records BEGIN DELETE FROM records_fts WHERE id=old.id; END;
    CREATE TRIGGER records_au AFTER UPDATE ON records BEGIN
      DELETE FROM records_fts WHERE id=old.id;
      INSERT INTO records_fts(id,title,summary,body,project,tags)
      VALUES(new.id,new.title,new.summary,new.body,COALESCE(new.project,''),new.tags);
    END;
  `);
  db.close();
}



let report;
try {
  let result = run(["init", "--authority-domain", initial, "--json"]);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  let db = new DatabaseSync(database);
  db.prepare("DELETE FROM meta WHERE key='authority_domain_id'").run();
  db.exec("PRAGMA foreign_keys = OFF; CREATE TABLE orphan_test(parent_id TEXT REFERENCES meta(key)); INSERT INTO orphan_test(parent_id) VALUES('missing-parent'); PRAGMA foreign_keys = ON;");
  db.close();
  const foreignKeyResult = run(["bind-domain", "--authority-domain", bound, "--json"]);
  assert.equal(foreignKeyResult.status, 2, foreignKeyResult.stdout || foreignKeyResult.stderr);
  assert.equal(machine(foreignKeyResult).error.code, "SCHEMA_MISMATCH");
  db = new DatabaseSync(database);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='authority_domain_id'").get(), undefined, "failed integrity validation left a domain binding");
  db.exec("DROP TABLE orphan_test");
  db.close();

  result = run(["bind-domain", "--authority-domain", bound, "--json"]);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  assert.deepEqual(machine(result).data, { path: database, authorityDomainId: bound });
  result = run(["status", "--json"], { AGENT_KB_EXPECTED_DOMAIN: bound });
  assert.equal(result.status, 0, result.stdout || result.stderr);
  assert.equal(machine(result).data.authorityDomainId, bound);

  expectError(["bind-domain", "--authority-domain", bound, "--json"], "CONFLICT");
  expectError(["bind-domain", "--authority-domain", "not-a-uuid", "--json"], "INVALID_INPUT");

  const malformed = join(root, "malformed.sqlite");
  const malformedDb = new DatabaseSync(malformed);
  malformedDb.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)");
  malformedDb.prepare("INSERT INTO meta(key,value) VALUES('schema_version','3')").run();
  malformedDb.close();
  expectSchemaMismatch(malformed);

  const nearSchema = join(root, "near-schema.sqlite");
  const nearSchemaDb = new DatabaseSync(nearSchema);
  nearSchemaDb.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta(key,value) VALUES('schema_version','3');
    CREATE TABLE records (
      id TEXT PRIMARY KEY,
      evidence TEXT NOT NULL DEFAULT '[]',
      assertion_basis TEXT,
      as_of TEXT,
      expires_at TEXT,
      canonical_ids TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE lineage_migration_ambiguities (
      record_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      PRIMARY KEY(record_id,target_id)
    );
    CREATE VIRTUAL TABLE records_fts USING fts5(id UNINDEXED,title,summary,body,project,tags);
  `);
  nearSchemaDb.close();
  expectSchemaMismatch(nearSchema);

  const missingIndex = join(root, "missing-index.sqlite");
  initializeUnbound(missingIndex);
  const missingIndexDb = new DatabaseSync(missingIndex);
  missingIndexDb.exec("DROP INDEX idx_records_status");
  missingIndexDb.close();
  expectSchemaMismatch(missingIndex);

  const missingTrigger = join(root, "missing-trigger.sqlite");
  initializeUnbound(missingTrigger);
  const missingTriggerDb = new DatabaseSync(missingTrigger);
  missingTriggerDb.exec("DROP TRIGGER records_au");
  missingTriggerDb.close();
  const migrated = join(root, "migrated-v3.sqlite");
  createV2(migrated);
  result = run(["migrate", "--apply", "--json"], { AGENT_KB_PATH: migrated });
  assert.equal(result.status, 0, result.stdout || result.stderr);
  result = run(["bind-domain", "--authority-domain", bound, "--json"], { AGENT_KB_PATH: migrated });
  assert.equal(result.status, 0, result.stdout || result.stderr);
  assert.equal(machine(result).data.authorityDomainId, bound, "migrated schema-v3 database was not bindable");

  expectSchemaMismatch(missingTrigger);

  report = { bound_database: database, positive: true, negative_cases: 7, failed_integrity_rollback: true, schema_contract_rollback: true };
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok: true, ...report, cleanup: true }, null, 2));
