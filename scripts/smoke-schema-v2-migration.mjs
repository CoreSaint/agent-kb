import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { backup, DatabaseSync } from "node:sqlite";
import { initDb, openDb } from "../src/db.ts";
import { migrateV1ToV2 } from "../src/migration.ts";
import { KbStore } from "../src/store.ts";

const root = mkdtempSync(join(tmpdir(), "agent-kb-schema-v2-"));
process.env.HOME = join(root, "home");
process.env.AGENT_KB_PATH = join(root, "explicit-unused.sqlite");
assert.ok(resolve(process.env.AGENT_KB_PATH).startsWith(`${resolve(root)}/`), "disposable DB escaped test root");
process.chdir(root);
const cliPath = join(import.meta.dirname, "../src/cli.ts");
const oldTimestamp = "2026-01-01T00:00:00.000Z";

const v1Ddl = `
PRAGMA journal_mode = WAL;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE records (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  project TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  body TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT 'medium',
  evidence TEXT NOT NULL DEFAULT '[]',
  supersedes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT,
  source TEXT NOT NULL DEFAULT 'user'
);
CREATE VIRTUAL TABLE records_fts USING fts5(id UNINDEXED,title,summary,body,project,tags);
CREATE TRIGGER records_ai AFTER INSERT ON records BEGIN
  INSERT INTO records_fts(id,title,summary,body,project,tags)
  VALUES(new.id,new.title,new.summary,new.body,COALESCE(new.project,''),new.tags);
END;
CREATE TRIGGER records_ad AFTER DELETE ON records BEGIN
  DELETE FROM records_fts WHERE id=old.id;
END;
CREATE TRIGGER records_au AFTER UPDATE ON records BEGIN
  DELETE FROM records_fts WHERE id=old.id;
  INSERT INTO records_fts(id,title,summary,body,project,tags)
  VALUES(new.id,new.title,new.summary,new.body,COALESCE(new.project,''),new.tags);
END;
INSERT INTO meta(key,value) VALUES('schema_version','1');
`;

function createV1(path, records) {
  const db = new DatabaseSync(path);
  db.exec(v1Ddl);
  const insert = db.prepare(`INSERT INTO records
    (id,type,title,status,project,tags,body,summary,confidence,evidence,supersedes,created_at,updated_at,last_verified_at,source)
    VALUES(@id,@type,@title,@status,NULL,'[]',@body,@summary,'medium','[]',@supersedes,@created_at,@updated_at,NULL,'user')`);
  for (const record of records) {
    insert.run({
      id: record.id,
      type: record.type,
      title: record.id,
      status: record.status,
      body: `body-${record.id}-fts-preservation-token`,
      summary: `summary-${record.id}`,
      supersedes: record.supersedes ?? null,
      created_at: oldTimestamp,
      updated_at: oldTimestamp,
    });
  }
  db.close();
}

function inspect(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      version: db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value,
      columns: db.prepare("PRAGMA table_info(records)").all().map((row) => row.name),
      records: db.prepare("SELECT * FROM records ORDER BY id").all(),
      fts: db.prepare("SELECT id,title,summary,body,project,tags FROM records_fts ORDER BY id").all(),
      quickCheck: db.prepare("PRAGMA quick_check").get().quick_check,
    };
  } finally {
    db.close();
  }
}
function rawSnapshot(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      schema: db.prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
      ).all(),
      foreignData: db.prepare("SELECT * FROM foreign_data ORDER BY id").all(),
    };
  } finally {
    db.close();
  }
}


function runCli(path, args) {
  assert.ok(resolve(path).startsWith(`${resolve(root)}/`), "CLI database escaped test root");
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, AGENT_KB_PATH: path },
  });
}

const records = [
  { id: "proposal:single", type: "proposal", status: "promoted" },
  { id: "proposal:double", type: "proposal", status: "promoted" },
  { id: "proposal:unlinked", type: "proposal", status: "promoted" },
  { id: "handoff:explicit", type: "handoff", status: "closed" },
  { id: "decision:single", type: "decision", status: "active", supersedes: "proposal:single" },
  { id: "procedure:double-one", type: "procedure", status: "active", supersedes: "proposal:double" },
  { id: "procedure:double-two", type: "procedure", status: "active", supersedes: "proposal:double" },
  { id: "landscape:from-handoff", type: "landscape", status: "active", supersedes: "handoff:explicit" },
  { id: "decision:replacement-old", type: "decision", status: "superseded", supersedes: "decision:replacement-new" },
  { id: "decision:replacement-new", type: "decision", status: "active" },
  { id: "decision:missing", type: "decision", status: "active", supersedes: "proposal:absent" },
  { id: "decision:self", type: "decision", status: "superseded", supersedes: "decision:self" },
];

let result;
try {
  const sourcePath = join(root, "synthetic-v1.sqlite");
  createV1(sourcePath, records);
  const sourceBefore = inspect(sourcePath);
  const normalAccess = runCli(sourcePath, ["get", "proposal:single"]);
  assert.equal(normalAccess.status, 1);
  assert.match(normalAccess.stderr, /requires explicit migration/);
  assert.equal(inspect(sourcePath).version, "1", "normal access migrated schema v1");

  const preview = migrateV1ToV2(sourcePath, false);
  assert.equal(preview.mode, "preview");
  assert.equal(preview.promotion_count, 4);
  assert.equal(preview.replacement_count, 1);
  assert.equal(preview.ambiguity_count, 2);
  assert.deepEqual(preview.ambiguities.map((item) => item.reason), ["missing_target", "self_link"]);
  assert.equal(preview.promoted_proposal_review_count, 2);
  assert.deepEqual(inspect(sourcePath), sourceBefore, "preview changed the source database");
  const cliPreview = runCli(sourcePath, ["migrate"]);
  assert.equal(cliPreview.status, 0, cliPreview.stderr);
  assert.equal(JSON.parse(cliPreview.stdout).mode, "preview");
  assert.deepEqual(inspect(sourcePath), sourceBefore, "CLI preview changed the source database");

  const privateCopyPath = join(root, "private-copy.sqlite");
  const sourceDb = new DatabaseSync(sourcePath, { readOnly: true });
  await backup(sourceDb, privateCopyPath);
  sourceDb.close();
  chmodSync(privateCopyPath, 0o600);
  const applied = migrateV1ToV2(privateCopyPath, true);
  assert.equal(applied.mode, "applied");
  assert.equal(applied.quick_check, "ok");
  const migrated = inspect(privateCopyPath);
  assert.equal(migrated.version, "2");
  assert.equal(migrated.columns.includes("supersedes"), false);
  assert.equal(migrated.columns.includes("promoted_from"), true);
  assert.equal(migrated.columns.includes("superseded_by"), true);
  assert.deepEqual(migrated.fts, sourceBefore.fts, "migration changed FTS content");
  assert.equal(migrated.records.length, sourceBefore.records.length);
  const promotedFromById = {
    "decision:single": "proposal:single",
    "procedure:double-one": "proposal:double",
    "procedure:double-two": "proposal:double",
    "landscape:from-handoff": "handoff:explicit",
  };
  const supersededByById = {
    "decision:replacement-old": "decision:replacement-new",
  };
  const expectedMigratedRecords = sourceBefore.records.map(({ supersedes: _legacyLineage, ...preserved }) => ({
    ...preserved,
    promoted_from: promotedFromById[preserved.id] ?? null,
    superseded_by: supersededByById[preserved.id] ?? null,
  }));
  assert.deepEqual(
    migrated.records.map((row) => ({ ...row })),
    expectedMigratedRecords,
    "migration changed non-lineage record fields or assigned incorrect schema-v2 lineage",
  );
  assert.equal(inspect(sourcePath).version, "1", "private-copy migration changed its source");
  assert.throws(() => migrateV1ToV2(privateCopyPath, true), /already schema v2/);

  const store = new KbStore(openDb(privateCopyPath), privateCopyPath);
  try {
    assert.equal(store.get("decision:single")?.promoted_from, "proposal:single");
    assert.equal(store.get("landscape:from-handoff")?.promoted_from, "handoff:explicit");
    assert.equal(store.get("decision:replacement-old")?.superseded_by, "decision:replacement-new");
    assert.equal(store.get("decision:missing")?.promoted_from, null);
    assert.equal(store.get("decision:missing")?.superseded_by, null);
    const superseded = store.supersede("decision:single", "decision:replacement-new");
    assert.equal(superseded.promoted_from, "proposal:single", "supersession erased promotion provenance");
    assert.equal(superseded.superseded_by, "decision:replacement-new");
    assert.throws(() => store.supersede("decision:single", "decision:single"), /cannot supersede itself/);
    assert.ok(store.search("fts preservation token").length > 0);
    const maintenance = store.maintain(14);
    assert.equal(maintenance.lineage_migration_ambiguities.total, 2);
    assert.equal(maintenance.lineage_migration_ambiguities.items.length, 2);
    assert.equal(JSON.stringify(maintenance).includes("body-"), false);
    const candidateIds = store.prune().candidates.map((item) => item.id);
    assert.ok(candidateIds.includes("proposal:single"));
    assert.equal(candidateIds.includes("proposal:unlinked"), false);
    assert.equal(candidateIds.includes("proposal:double"), false);
  } finally {
    store.dispose();
  }

  const cliApplyPath = join(root, "cli-apply.sqlite");
  const cliSource = new DatabaseSync(sourcePath, { readOnly: true });
  await backup(cliSource, cliApplyPath);
  cliSource.close();
  const cliApply = runCli(cliApplyPath, ["migrate", "--apply"]);
  assert.equal(cliApply.status, 0, cliApply.stderr);
  assert.equal(JSON.parse(cliApply.stdout).mode, "applied");
  assert.equal(inspect(cliApplyPath).quickCheck, "ok");

  const rollbackPath = join(root, "rollback.sqlite");
  createV1(rollbackPath, records.slice(0, 2));
  const rollbackDb = new DatabaseSync(rollbackPath);
  rollbackDb.exec("CREATE TABLE lineage_migration_ambiguities (wrong_column TEXT);");
  rollbackDb.close();
  assert.throws(() => migrateV1ToV2(rollbackPath, true), /already exists/);
  const rolledBack = inspect(rollbackPath);
  assert.equal(rolledBack.version, "1");
  assert.equal(rolledBack.columns.includes("supersedes"), true);
  assert.equal(rolledBack.columns.includes("promoted_from"), false);

  const boundedPath = join(root, "bounded.sqlite");
  createV1(boundedPath, Array.from({ length: 101 }, (_, index) => ({
    id: `decision:missing-${String(index).padStart(3, "0")}`,
    type: "decision",
    status: "active",
    supersedes: `proposal:absent-${index}`,
  })));
  const bounded = migrateV1ToV2(boundedPath, false);
  assert.equal(bounded.ambiguity_count, 101);
  assert.equal(bounded.ambiguities.length, 100);
  assert.equal(bounded.ambiguities_truncated, true);

  const noMetaPath = join(root, "foreign-no-meta.sqlite");
  const noMetaDb = new DatabaseSync(noMetaPath);
  noMetaDb.exec("CREATE TABLE foreign_data(id TEXT PRIMARY KEY,value TEXT NOT NULL);");
  noMetaDb.prepare("INSERT INTO foreign_data(id,value) VALUES(?,?)").run("foreign:one", "preserve-me");
  noMetaDb.close();
  const noMetaBefore = rawSnapshot(noMetaPath);
  assert.throws(
    () => openDb(noMetaPath),
    /no agent-KB schema metadata/,
  );
  assert.deepEqual(rawSnapshot(noMetaPath), noMetaBefore, "no-meta refusal mutated foreign schema or content");

  const newPath = join(root, "new-v2.sqlite");
  const initialized = initDb(newPath, "22222222-2222-4222-8222-222222222222");
  assert.equal(initialized.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, "2");
  assert.equal(initialized.db.prepare("SELECT value FROM meta WHERE key='authority_domain_id'").get().value, "22222222-2222-4222-8222-222222222222");
  initialized.db.close();

  result = {
    ok: true,
    cases: 14,
    records_preserved: sourceBefore.records.length,
    exact_record_fields_preserved: true,
    fts_rows_preserved: sourceBefore.fts.length,
    promotions_classified: preview.promotion_count,
    replacements_classified: preview.replacement_count,
    ambiguities_preserved: preview.ambiguity_count,
    bounded_ambiguities_reported: bounded.ambiguities.length,
    quick_check: applied.quick_check,
  };
} finally {
  process.chdir(tmpdir());
  rmSync(root, { recursive: true, force: true });
}
assert.equal(existsSync(root), false, "migration smoke cleanup failed");
console.log(JSON.stringify({ ...result, cleanup: true }, null, 2));
