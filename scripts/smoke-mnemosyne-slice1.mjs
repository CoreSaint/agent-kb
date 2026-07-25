#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initDb } from "../src/db.ts";
import { migrateV2ToV3 } from "../src/migration.ts";
import { KbStore } from "../src/store.ts";

process.umask(0o077);
const root = mkdtempSync(join(tmpdir(), "agent-kb-mnemosyne-slice1-"));
const home = join(root, "home");
const database = join(root, "fresh-v3.sqlite");
const cliPath = join(import.meta.dirname, "../src/cli.ts");
const liveDatabase = "/var/home/marcin/vaults/work/.agent-kb/kb.sqlite";
const now = "2026-07-25T12:00:00.000Z";
const hash = "a".repeat(64);
const baseEnv = { ...process.env, HOME: home, AGENT_KB_PATH: database };
delete baseEnv.AGENT_KB_EXPECTED_DOMAIN;
assert.ok(resolve(database).startsWith(`${resolve(root)}/`));
assert.notEqual(resolve(database), liveDatabase);

function runCli(command, input, databasePath = database) {
  const result = spawnSync(process.execPath, [cliPath, ...command], {
    cwd: root,
    env: { ...baseEnv, AGENT_KB_PATH: databasePath },
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: "utf8",
  });
  return result;
}

function machineData(command, input) {
  const result = runCli([...command, "--json"], input);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  return envelope.data;
}

function expectInvalid(command, input) {
  const result = runCli([...command, "--json"], input);
  assert.equal(result.status, 2, `${command.join(" ")} unexpectedly succeeded: ${result.stdout}`);
  assert.equal(result.stderr, "");
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "INVALID_INPUT");
}

function rawSnapshot(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      version: db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value,
      meta: db.prepare("SELECT key,value FROM meta ORDER BY key").all(),
      records: db.prepare("SELECT * FROM records ORDER BY id").all(),
      fts: db.prepare("SELECT id,title,summary,body,project,tags FROM records_fts ORDER BY id").all(),
      lineage: db.prepare("SELECT * FROM lineage_migration_ambiguities ORDER BY record_id,target_id").all(),
      quickCheck: db.prepare("PRAGMA quick_check").get().quick_check,
    };
  } finally {
    db.close();
  }
}

function createV2(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE records (
      id TEXT PRIMARY KEY,type TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,project TEXT,
      tags TEXT NOT NULL DEFAULT '[]',body TEXT NOT NULL DEFAULT '',summary TEXT NOT NULL DEFAULT '',
      confidence TEXT NOT NULL DEFAULT 'medium',evidence TEXT NOT NULL DEFAULT '[]',promoted_from TEXT,
      superseded_by TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_verified_at TEXT,
      source TEXT NOT NULL DEFAULT 'user'
    );
    CREATE TABLE lineage_migration_ambiguities (
      record_id TEXT NOT NULL,target_id TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(record_id,target_id)
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
    INSERT INTO meta(key,value) VALUES('schema_version','2');
    INSERT INTO meta(key,value) VALUES('authority_domain_id','77777777-7777-4777-8777-777777777777');
  `);
  const insert = db.prepare(`INSERT INTO records
    (id,type,title,status,project,tags,body,summary,confidence,evidence,promoted_from,superseded_by,created_at,updated_at,last_verified_at,source)
    VALUES(@id,'troubleshoot',@title,'active','migration-project','["legacy"]',@body,@summary,'high',@evidence,@promoted_from,@superseded_by,@created_at,@updated_at,@last_verified_at,'agent_promoted')`);
  insert.run({
    id: "troubleshoot:legacy-old", title: "Legacy old", body: "body-old", summary: "summary-old",
    evidence: JSON.stringify(["legacy observation", "file:///tmp/source.txt"]), promoted_from: "proposal:legacy",
    superseded_by: "troubleshoot:legacy-new", created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-02-01T00:00:00.000Z", last_verified_at: "2026-02-01",
  });
  insert.run({
    id: "troubleshoot:legacy-new", title: "Legacy new", body: "body-new", summary: "summary-new",
    evidence: "[]", promoted_from: null, superseded_by: null, created_at: "2026-03-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z", last_verified_at: null,
  });
  db.prepare("INSERT INTO lineage_migration_ambiguities(record_id,target_id,reason) VALUES(?,?,?)")
    .run("troubleshoot:legacy-old", "missing:legacy", "fixture");
  db.close();
}

let report;
try {
  const initialized = initDb(database, "66666666-6666-4666-8666-666666666666");
  const store = new KbStore(initialized.db, database);
  try {
    const snapshot = (uri) => ({ kind: "snapshot", uri, observed_at: "2026-07-25T11:00:00.000Z", sha256: hash });
    const add = (input) => store.upsert({ type: "troubleshoot", status: "active", assertion_basis: "asserted", ...input }, { forceDurable: true });
    add({
      id: "troubleshoot:fresh-snapshot-zephyr", title: "Fresh snapshot zephyr", summary: "Use the verified zephyr repair.",
      evidence_items: [snapshot("file:///tmp/zephyr-snapshot")], as_of: "2026-07-25T11:00:00.000Z",
      expires_at: "2026-07-26T12:00:00.000Z", canonical_ids: ["canon:zephyr"], source: "agent_promoted",
    });
    add({
      id: "troubleshoot:expiry-boundary-quartz", title: "Expiry boundary quartz", summary: "Boundary repair.",
      evidence_items: [snapshot("file:///tmp/quartz-snapshot")], as_of: "2026-07-25T10:00:00.000Z",
      expires_at: now, canonical_ids: ["canon:quartz"], source: "agent_promoted",
    });
    add({
      id: "troubleshoot:missing-canonical-onyx", title: "Missing canonical onyx", summary: "Onyx repair.",
      evidence_items: [snapshot("file:///tmp/onyx-snapshot")], canonical_ids: ["canon:missing"], source: "agent_promoted",
    });
    add({
      id: "troubleshoot:canonical-overflow-topaz", title: "Canonical overflow topaz", summary: "Topaz repair.",
      evidence_items: [snapshot("file:///tmp/topaz-snapshot")], canonical_ids: ["canon:a", "canon:b", "canon:c", "canon:d"], source: "agent_promoted",
    });
    add({
      id: "troubleshoot:lineage-old-saffron", title: "Lineage saffron repair", summary: "Old saffron repair.",
      evidence_items: [snapshot("file:///tmp/saffron-old")], source: "agent_promoted",
    });
    add({
      id: "troubleshoot:lineage-new-saffron", title: "Lineage saffron repair", summary: "New saffron repair.",
      evidence_items: [snapshot("file:///tmp/saffron-new")], source: "agent_promoted",
    });
    store.supersede("troubleshoot:lineage-old-saffron", "troubleshoot:lineage-new-saffron");
    add({
      id: "troubleshoot:pointer-indigo", title: "Pointer indigo", summary: "Weak indigo pointer.",
      evidence_items: [{ kind: "pointer", uri: "memory:indigo" }], source: "agent",
    });
    add({
      id: "troubleshoot:oversized-memory-cobalt", title: "Oversized memory cobalt", summary: "M".repeat(2_000),
      evidence_items: [snapshot("file:///tmp/cobalt-snapshot")], source: "agent_promoted",
    });
    add({
      id: "troubleshoot:oversized-canonical-copper", title: "Oversized canonical copper", summary: "Copper repair.",
      evidence_items: [snapshot("file:///tmp/copper-snapshot")], canonical_ids: ["canon:oversized"], source: "agent_promoted",
    });
    assert.throws(
      () => store.upsert({
        id: "proposal:dual-evidence-store", type: "proposal", title: "Dual evidence",
        evidence: ["memory:legacy"], evidence_items: [{ kind: "pointer", uri: "memory:typed" }],
      }),
      /only one of evidence and evidence_items/,
    );
  } finally {
    store.dispose();
  }

  const canonical = (id) => ({ id, text: `Verified canonical text for ${id}`, verified_at: now });
  const assemble = (query, riskClass, canonicalSnippets = [], liveIds = [], limits = undefined) => machineData(
    ["assemble", "--input", "-"],
    { query, risk_class: riskClass, now, canonical_snippets: canonicalSnippets, live_verified_record_ids: liveIds, limits },
  );

  const fresh = assemble("troubleshoot:fresh-snapshot-zephyr", "R2", [canonical("canon:zephyr")]);
  assert.equal(fresh.gate.allowed, true);
  assert.equal(fresh.items[0].stale, false);

  const boundary = assemble("troubleshoot:expiry-boundary-quartz", "R2", [canonical("canon:quartz")]);
  assert.equal(boundary.items[0].stale, true, "expires_at equal to now must be stale");
  assert.equal(boundary.gate.allowed, false);
  assert(boundary.gate.reasons.some((reason) => reason.code === "live_verification_required"));

  const boundaryVerified = assemble(
    "troubleshoot:expiry-boundary-quartz", "R2", [canonical("canon:quartz")], ["troubleshoot:expiry-boundary-quartz"],
  );
  assert.equal(boundaryVerified.gate.allowed, true);

  const missing = assemble("troubleshoot:missing-canonical-onyx", "R3");
  assert.equal(missing.gate.allowed, false);
  assert(missing.gate.reasons.some((reason) => reason.code === "canonical_verification_missing" && reason.canonical_id === "canon:missing"));

  const overflow = assemble(
    "troubleshoot:canonical-overflow-topaz", "R2", [canonical("canon:a"), canonical("canon:b"), canonical("canon:c"), canonical("canon:d")],
  );
  assert.equal(overflow.gate.allowed, false);
  assert.deepEqual(overflow.omitted_canonical_ids, ["canon:d"]);
  assert(overflow.gate.reasons.some((reason) => reason.code === "canonical_budget_exceeded"));

  const lineage = assemble("lineage saffron repair", "R0");
  const oldLineage = lineage.items.find((item) => item.id === "troubleshoot:lineage-old-saffron");
  assert(oldLineage?.conflicts.includes("troubleshoot:lineage-new-saffron"));

  const degraded = assemble("troubleshoot:pointer-indigo", "R0");
  assert.equal(degraded.gate.allowed, true);
  assert(degraded.items[0].verification_required.includes("live"));
  assert(degraded.gate.reasons.some((reason) => reason.code === "live_verification_required"));

  const oversizedMemoryR0 = assemble(
    "troubleshoot:oversized-memory-cobalt", "R0", [], [], { max_context_chars: 500 },
  );
  assert.equal(oversizedMemoryR0.gate.allowed, true);
  assert(oversizedMemoryR0.budget.estimated_context_chars <= oversizedMemoryR0.budget.max_context_chars);
  assert.deepEqual(oversizedMemoryR0.omitted_memory_ids, ["troubleshoot:oversized-memory-cobalt"]);
  assert(oversizedMemoryR0.gate.reasons.some((reason) => reason.code === "memory_context_omitted"));
  assert(oversizedMemoryR0.gate.reasons.some((reason) => reason.code === "context_budget_exceeded"));
  const oversizedMemoryR2 = assemble(
    "troubleshoot:oversized-memory-cobalt", "R2", [], [], { max_context_chars: 500 },
  );
  assert.equal(oversizedMemoryR2.gate.allowed, false);
  assert(oversizedMemoryR2.budget.estimated_context_chars <= oversizedMemoryR2.budget.max_context_chars);

  const oversizedCanonical = {
    id: "canon:oversized", text: "C".repeat(2_000), verified_at: now,
  };
  const oversizedCanonicalR0 = assemble(
    "troubleshoot:oversized-canonical-copper", "R0", [oversizedCanonical], [], { max_context_chars: 500 },
  );
  assert.equal(oversizedCanonicalR0.gate.allowed, true);
  assert(oversizedCanonicalR0.budget.estimated_context_chars <= oversizedCanonicalR0.budget.max_context_chars);
  assert.deepEqual(oversizedCanonicalR0.omitted_canonical_ids, ["canon:oversized"]);
  assert.deepEqual(oversizedCanonicalR0.omitted_memory_ids, ["troubleshoot:oversized-canonical-copper"]);
  assert.equal(oversizedCanonicalR0.canonical_snippets.length, 0);
  const oversizedCanonicalR3 = assemble(
    "troubleshoot:oversized-canonical-copper", "R3", [oversizedCanonical], [], { max_context_chars: 500 },
  );
  assert.equal(oversizedCanonicalR3.gate.allowed, false);
  assert(oversizedCanonicalR3.budget.estimated_context_chars <= oversizedCanonicalR3.budget.max_context_chars);

  expectInvalid(["upsert", "--input", "-"], {
    id: "proposal:bad-evidence", type: "proposal", title: "Bad", evidence_items: [{ kind: "unknown", uri: "x" }],
  });
  expectInvalid(["upsert", "--input", "-"], {
    id: "proposal:bad-time", type: "proposal", title: "Bad", as_of: "not-a-time",
  });
  expectInvalid(["upsert", "--input", "-"], {
    id: "proposal:bad-hash", type: "proposal", title: "Bad",
    evidence_items: [{ kind: "snapshot", uri: "file:///tmp/x", observed_at: now, sha256: "1234" }],
  });
  expectInvalid(["assemble", "--input", "-"], { query: "x", risk_class: "RX" });
  expectInvalid(["assemble", "--input", "-"], { query: "x", risk_class: "R0", unknown: true });
  expectInvalid(["assemble", "--input", "-"], {
    query: "x", risk_class: "R0", canonical_snippets: [{ id: "c", text: "t", verified_at: now, unknown: true }],
  });
  expectInvalid(["assemble", "--input", "-"], {
    query: "x", risk_class: "R0", now,
    canonical_snippets: [{ id: "canon:future", text: "future", verified_at: "2026-07-25T12:00:00.001Z" }],
  });

  const v2Path = join(root, "legacy-v2.sqlite");
  createV2(v2Path);
  const before = rawSnapshot(v2Path);
  const preview = migrateV2ToV3(v2Path, false);
  assert.equal(preview.mode, "preview");
  assert.equal(preview.record_count, 2);
  assert.equal(preview.wrapped_pointer_count, 2);
  assert.deepEqual(rawSnapshot(v2Path), before, "v2 preview mutated the database");
  const applied = migrateV2ToV3(v2Path, true);
  assert.equal(applied.mode, "applied");
  const after = rawSnapshot(v2Path);
  assert.equal(after.version, "3");
  assert.equal(after.quickCheck, "ok");
  assert.equal(after.records.length, before.records.length);
  assert.deepEqual(after.fts, before.fts);
  assert.deepEqual(after.lineage, before.lineage);
  assert.deepEqual(after.meta.find((row) => row.key === "authority_domain_id"), before.meta.find((row) => row.key === "authority_domain_id"));
  const migratedOld = after.records.find((row) => row.id === "troubleshoot:legacy-old");
  const originalOld = before.records.find((row) => row.id === "troubleshoot:legacy-old");
  assert.deepEqual(JSON.parse(migratedOld.evidence), [
    { kind: "pointer", uri: "legacy observation" },
    { kind: "pointer", uri: "file:///tmp/source.txt" },
  ]);
  for (const field of ["title", "status", "project", "tags", "body", "summary", "confidence", "promoted_from", "superseded_by", "created_at", "updated_at", "last_verified_at", "source"]) {
    assert.equal(migratedOld[field], originalOld[field], `migration changed ${field}`);
  }
  assert.equal(migratedOld.assertion_basis, null);
  assert.equal(migratedOld.as_of, null);
  assert.equal(migratedOld.expires_at, null);
  assert.equal(migratedOld.canonical_ids, "[]");

  report = {
    ok: true,
    cases: 14,
    schema_version: 3,
    isolated_root: root,
    live_database_touched: false,
    installed_extension_touched: false,
    network_used: false,
  };
} finally {
  rmSync(root, { recursive: true, force: true });
}
assert.equal(existsSync(root), false, "Slice 1 smoke cleanup failed");
console.log(JSON.stringify({ ...report, cleanup: true }, null, 2));
