import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";

const root = mkdtempSync(join(tmpdir(), "agent-kb-maintenance-"));
const databasePath = join(root, "kb.sqlite");
const cliPath = join(import.meta.dirname, "../src/cli.ts");
process.env.AGENT_KB_PATH = databasePath;
const { createStore } = await import("../src/store.ts");
const store = createStore();

const old30 = "2026-05-01T00:00:00.000Z";
const old90 = "2026-01-01T00:00:00.000Z";
const fresh = new Date().toISOString();
const terminalIds = ["proposal:linked", "proposal:archive-linked", "proposal:rejected-old", "handoff:archived-old"];

function put(input, forceDurable = false) {
  return store.upsert({
    title: input.id,
    body: `test-only-body-${input.id}`,
    summary: `summary-${input.id}`,
    ...input,
  }, { forceDurable });
}

function setUpdated(id, timestamp) {
  store.db.prepare("UPDATE records SET updated_at=? WHERE id=?").run(timestamp, id);
}

function databaseSnapshot() {
  return JSON.stringify({
    meta: store.db.prepare("SELECT * FROM meta ORDER BY key").all(),
    records: store.db.prepare("SELECT * FROM records ORDER BY id").all(),
    fts: store.db.prepare("SELECT rowid,* FROM records_fts ORDER BY rowid").all(),
  });
}

function ids(items) {
  return items.map((item) => item.id).sort();
}

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, AGENT_KB_PATH: databasePath },
  });
}

try {
  store.init();
  put({ id: "handoff:stale-open", type: "handoff", status: "open" });
  put({ id: "handoff:fresh-blocked", type: "handoff", status: "blocked" });
  put({ id: "handoff:closed", type: "handoff", status: "closed" });
  put({ id: "handoff:archived-old", type: "handoff", status: "archived", body: "eligible archived handoff ftsprunetoken" });
  put({ id: "handoff:blocked-old", type: "handoff", status: "blocked" });

  put({ id: "proposal:linked", type: "proposal", status: "promoted", body: "eligible linked proposal ftsprunetoken" });
  put({ id: "proposal:unlinked", type: "proposal", status: "promoted" });
  put({ id: "proposal:double-linked", type: "proposal", status: "promoted" });
  put({ id: "proposal:rejected-old", type: "proposal", status: "rejected", body: "eligible rejected proposal ftsprunetoken" });
  put({ id: "proposal:rejected-fresh", type: "proposal", status: "rejected" });
  put({ id: "proposal:open-old", type: "proposal", status: "open" });
  put({ id: "proposal:archived-old", type: "proposal", status: "archived" });
  put({ id: "proposal:archive-linked", type: "proposal", status: "promoted", body: "eligible archived linked proposal ftsprunetoken" });
  put({ id: "proposal:archive-unlinked", type: "proposal", status: "promoted" });
  put({ id: "proposal:archive-double", type: "proposal", status: "promoted" });

  put({ id: "decision:linked-target", type: "decision", status: "active", supersedes: "proposal:linked", body: "active durable activetoken" }, true);
  put({ id: "procedure:double-one", type: "procedure", status: "active", supersedes: "proposal:double-linked" }, true);
  put({ id: "procedure:double-two", type: "procedure", status: "active", supersedes: "proposal:double-linked" }, true);
  put({ id: "procedure:deprecated", type: "procedure", status: "deprecated" }, true);
  put({ id: "decision:active-missing", type: "decision", status: "active", body: "protected durable activetoken" }, true);
  put({ id: "decision:active-verified", type: "decision", status: "active", last_verified_at: "2026-07-01" }, true);
  put({ id: "decision:archive-linked-target", type: "decision", status: "active", supersedes: "proposal:archive-linked", last_verified_at: "2026-07-01" }, true);
  put({ id: "procedure:archive-double-one", type: "procedure", status: "active", supersedes: "proposal:archive-double", last_verified_at: "2026-07-01" }, true);
  put({ id: "procedure:archive-double-two", type: "procedure", status: "active", supersedes: "proposal:archive-double", last_verified_at: "2026-07-01" }, true);

  for (const id of [
    "handoff:stale-open", "handoff:archived-old", "handoff:blocked-old",
    "proposal:rejected-old", "proposal:open-old", "proposal:archived-old",
  ]) setUpdated(id, old90);
  for (const id of ["proposal:linked", "proposal:unlinked", "proposal:double-linked"]) setUpdated(id, old30);
  setUpdated("proposal:rejected-fresh", fresh);

  const beforeReport = databaseSnapshot();
  const changesBeforeReport = store.db.prepare("SELECT total_changes() AS count").get().count;
  const report = store.maintain(14);
  assert.equal(databaseSnapshot(), beforeReport, "maintenance report mutated the database");
  assert.equal(store.db.prepare("SELECT total_changes() AS count").get().count, changesBeforeReport, "maintenance report executed a write");
  assert.deepEqual(ids(report.stale_open_or_blocked_handoffs), ["handoff:blocked-old", "handoff:stale-open"]);
  assert.deepEqual(ids(report.rejected_proposals), ["proposal:rejected-fresh", "proposal:rejected-old"]);
  assert.deepEqual(ids(report.closed_or_archived_handoffs), ["handoff:archived-old", "handoff:closed"]);
  assert.deepEqual(ids(report.inactive_durable_records), ["procedure:deprecated"]);
  assert.deepEqual(ids(report.active_durable_missing_verification), [
    "decision:active-missing", "decision:linked-target", "procedure:double-one", "procedure:double-two",
  ]);
  const linkedReport = report.promoted_proposals.find((item) => item.id === "proposal:linked");
  const unlinkedReport = report.promoted_proposals.find((item) => item.id === "proposal:unlinked");
  const doubleReport = report.promoted_proposals.find((item) => item.id === "proposal:double-linked");
  assert.deepEqual(linkedReport?.durable_target_ids, ["decision:linked-target"]);
  assert.equal(linkedReport?.has_exactly_one_durable_target, true);
  assert.equal(unlinkedReport?.has_exactly_one_durable_target, false);
  assert.equal(doubleReport?.durable_target_ids.length, 2);
  assert.equal(report.database.path, databasePath);
  assert.equal(report.database.quick_check, "ok");
  assert.equal(JSON.stringify(report).includes("test-only-body"), false, "report leaked a record body");
  const cliReport = runCli(["maintain", "--stale-days", "14"]);
  assert.equal(cliReport.status, 0, cliReport.stderr);
  assert.equal(databaseSnapshot(), beforeReport, "CLI maintenance report mutated the database");

  assert.equal(store.archive("handoff:closed").status, "archived");
  assert.equal(store.restore("handoff:closed", "closed").status, "closed");
  assert.throws(() => store.restore("handoff:closed", "open"), /requires archived/);
  assert.equal(store.archive("handoff:closed").status, "archived");
  assert.throws(() => store.restore("handoff:closed", "active"), /Invalid status/);
  assert.throws(() => store.archive("handoff:stale-open"), /Only terminal/);
  assert.throws(() => store.archive("handoff:blocked-old"), /Only terminal/);
  assert.throws(() => store.archive("decision:active-missing"), /Only terminal/);

  assert.equal(store.archive("proposal:archive-linked").status, "archived");
  assert.equal(store.archive("proposal:archive-unlinked").status, "archived");
  assert.equal(store.archive("proposal:archive-double").status, "archived");
  const immediateArchiveDryRun = store.prune();
  assert.equal(
    immediateArchiveDryRun.candidates.some((item) => item.id === "proposal:archive-linked"),
    false,
    "newly archived linked proposal bypassed 30-day retention",
  );
  for (const id of ["proposal:archive-linked", "proposal:archive-unlinked", "proposal:archive-double"]) {
    setUpdated(id, old30);
  }

  const verifyBefore = store.get("decision:active-missing");
  assert.ok(verifyBefore);
  const verified = store.verify("decision:active-missing", "2026-07-20");
  assert.equal(verified.last_verified_at, "2026-07-20");
  const verifyAfter = store.get("decision:active-missing");
  assert.ok(verifyAfter);
  const changedFields = Object.keys(verifyAfter).filter((key) => JSON.stringify(verifyAfter[key]) !== JSON.stringify(verifyBefore[key])).sort();
  assert.deepEqual(changedFields, ["last_verified_at", "updated_at"]);
  assert.throws(() => store.verify("decision:active-missing", "2026-02-30"), /Invalid calendar date/);
  assert.throws(() => store.verify("decision:active-missing", "20-07-2026"), /YYYY-MM-DD/);
  assert.equal(store.get("decision:active-missing")?.last_verified_at, "2026-07-20");

  const backupPath = join(root, "verified-backup.sqlite");
  const backupResult = await store.backup(backupPath);
  assert.equal(backupResult.path, backupPath);
  assert.equal(backupResult.quick_check, "ok");
  assert.equal(statSync(backupPath).mode & 0o777, 0o600);
  const backupDb = new DatabaseSync(backupPath, { readOnly: true });
  assert.equal(backupDb.prepare("PRAGMA quick_check").get().quick_check, "ok");
  backupDb.close();
  const originalBackupSize = statSync(backupPath).size;
  await assert.rejects(store.backup(backupPath));
  assert.equal(statSync(backupPath).size, originalBackupSize, "overwrite refusal changed backup");

  const beforeDryRun = databaseSnapshot();
  const changesBeforeDryRun = store.db.prepare("SELECT total_changes() AS count").get().count;
  const dryRun = store.prune();
  assert.equal(databaseSnapshot(), beforeDryRun, "prune dry-run mutated the database");
  assert.equal(store.db.prepare("SELECT total_changes() AS count").get().count, changesBeforeDryRun, "prune dry-run executed a write");
  const cliDryRun = runCli(["prune"]);
  assert.equal(cliDryRun.status, 0, cliDryRun.stderr);
  assert.equal(databaseSnapshot(), beforeDryRun, "CLI prune dry-run mutated the database");
  assert.deepEqual(ids(dryRun.candidates), terminalIds.slice().sort());
  assert.deepEqual(dryRun.deleted_ids, []);
  const archivedLinkedCandidate = dryRun.candidates.find((item) => item.id === "proposal:archive-linked");
  assert.equal(archivedLinkedCandidate?.status, "archived");
  assert.match(archivedLinkedCandidate?.reason ?? "", /30 days since archival\/update/);
  assert.equal(dryRun.backup_path, null);
  for (const protectedId of [
    "handoff:stale-open", "handoff:blocked-old", "proposal:open-old", "proposal:unlinked",
    "proposal:double-linked", "proposal:rejected-fresh", "proposal:archived-old",
    "proposal:archive-unlinked", "proposal:archive-double",
    "decision:active-missing", "procedure:deprecated",
  ]) assert.equal(dryRun.candidates.some((item) => item.id === protectedId), false, `${protectedId} was prune-eligible`);

  const noBackup = runCli(["prune", "--apply"]);
  assert.equal(noBackup.status, 1);
  assert.match(noBackup.stderr, /--backup is required/);
  const missingBackupCount = store.status().counts.reduce((sum, item) => sum + item.count, 0);
  assert.throws(() => store.prune({ apply: true, backupPath: join(root, "missing.sqlite") }));
  assert.equal(store.status().counts.reduce((sum, item) => sum + item.count, 0), missingBackupCount);

  const arbitraryBackup = join(root, "arbitrary-valid.sqlite");
  await sqliteBackup(store.db, arbitraryBackup);
  chmodSync(arbitraryBackup, 0o600);
  assert.throws(() => store.prune({ apply: true, backupPath: arbitraryBackup }), /maintenance validation marker/);
  assert.equal(store.status().counts.reduce((sum, item) => sum + item.count, 0), missingBackupCount);

  const staleBackupPath = join(root, "stale-backup.sqlite");
  await store.backup(staleBackupPath);
  const staleDb = new DatabaseSync(staleBackupPath);
  const markerRow = staleDb.prepare("SELECT value FROM meta WHERE key='maintenance_backup_v1'").get();
  const marker = JSON.parse(markerRow.value);
  marker.created_at = "2026-01-01T00:00:00.000Z";
  staleDb.prepare("UPDATE meta SET value=? WHERE key='maintenance_backup_v1'").run(JSON.stringify(marker));
  staleDb.close();
  assert.throws(() => store.prune({ apply: true, backupPath: staleBackupPath }), /not fresh/);

  const mismatchedBackupPath = join(root, "mismatched-backup.sqlite");
  await store.backup(mismatchedBackupPath);
  store.verify("decision:active-verified", "2026-07-20");
  assert.throws(() => store.prune({ apply: true, backupPath: mismatchedBackupPath }), /no longer matches/);

  const freshBackupPath = join(root, "fresh-prune-backup.sqlite");
  await store.backup(freshBackupPath);
  const applied = store.prune({ apply: true, backupPath: freshBackupPath });
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.deleted_ids.slice().sort(), terminalIds.slice().sort());
  assert.equal(applied.backup_path, freshBackupPath);
  for (const id of terminalIds) assert.equal(store.get(id), null, `${id} survived prune`);
  assert.ok(store.get("decision:active-missing"));
  assert.ok(store.search("activetoken").some((record) => record.id === "decision:active-missing"));
  assert.deepEqual(store.search("ftsprunetoken"), []);
  for (const id of terminalIds) {
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM records_fts WHERE id=?").get(id).count, 0);
  }
  assert.equal(store.db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);

  const help = runCli(["help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /kb maintain/);
  assert.match(help.stdout, /kb prune \[--apply --backup/);
  const invalidDate = runCli(["verify", "decision:active-missing", "--date", "2026-13-01"]);
  assert.equal(invalidDate.status, 1);
  assert.match(invalidDate.stderr, /Invalid calendar date/);
  const invalidInteger = runCli(["maintain", "--stale-days", "1.5"]);
  assert.equal(invalidInteger.status, 1);
  assert.match(invalidInteger.stderr, /positive integer/);
  const unknownFlag = runCli(["maintain", "--unknown"]);
  assert.equal(unknownFlag.status, 1);
  assert.match(unknownFlag.stderr, /Unknown flag/);

  console.log(JSON.stringify({
    ok: true,
    database: databasePath,
    report_categories_checked: 6,
    prune_candidates: terminalIds,
    deleted_ids: applied.deleted_ids,
    backup_path: freshBackupPath,
    quick_check: "ok",
    fts_checked: true,
  }, null, 2));
} finally {
  store.dispose();
  rmSync(root, { recursive: true, force: true });
}
