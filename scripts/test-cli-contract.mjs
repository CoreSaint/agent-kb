#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

process.umask(0o077);
const root = mkdtempSync(join(tmpdir(), "agent-kb-contract-"));
const home = join(root, "home");
const databasePath = join(root, "authority", "kb.sqlite");
const cliPath = join(import.meta.dirname, "../src/cli.ts");
const domain = "33333333-3333-4333-8333-333333333333";
const baseEnv = { ...process.env, HOME: home, AGENT_KB_PATH: databasePath };
delete baseEnv.AGENT_KB_EXPECTED_DOMAIN;
assert.ok(resolve(baseEnv.HOME).startsWith(`${resolve(root)}/`));
assert.ok(resolve(baseEnv.AGENT_KB_PATH).startsWith(`${resolve(root)}/`));
process.chdir(root);

function run(args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: root,
      env: { ...baseEnv, ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolveResult({ status, signal, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });
}

function envelope(result) {
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "", `machine stderr was not empty: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.contract_version, "1");
  return parsed;
}

async function expectError(args, code, options) {
  const result = await run(args, options);
  assert.equal(result.status, 2, `${args.join(" ")} exit code`);
  const parsed = envelope(result);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.command, args[0]);
  assert.equal(parsed.error.code, code);
  return parsed;
}

async function writeJson(value) {
  const result = await run(["upsert", "--input", "-", "--json"], { input: JSON.stringify(value) });
  assert.equal(result.status, 0, result.stdout || result.stderr);
  const parsed = envelope(result);
  assert.equal(parsed.ok, true);
  return parsed.data;
}

let report;
try {
  const absentParent = dirname(databasePath);
  for (const args of [["help"], ["version", "--json"], ["contract", "--json"], ["path", "--json"]]) {
    const result = await run(args);
    assert.equal(result.status, 0, `${args[0]} failed`);
    assert.equal(existsSync(absentParent), false, `${args[0]} created the database parent`);
  }

  await expectError(["status", "--json"], "DB_NOT_INITIALIZED");
  await expectError(["search", "anything", "--json"], "DB_NOT_INITIALIZED");
  await expectError(["migrate", "--apply", "--json"], "DB_NOT_INITIALIZED");
  assert.equal(existsSync(absentParent), false, "read or migration created the database parent");

  const existingParent = join(root, "pre-existing-parent");
  const existingDatabase = join(existingParent, "kb.sqlite");
  mkdirSync(existingParent, { mode: 0o700 });
  chmodSync(existingParent, 0o750);
  const existingParentInit = await run(
    ["init", "--authority-domain", "55555555-5555-4555-8555-555555555555", "--json"],
    { env: { AGENT_KB_PATH: existingDatabase } },
  );
  assert.equal(existingParentInit.status, 0, existingParentInit.stdout || existingParentInit.stderr);
  assert.equal(statSync(existingParent).mode & 0o777, 0o750, "init changed a pre-existing parent mode");
  assert.equal(statSync(existingDatabase).mode & 0o777, 0o600, "init database mode was not private");

  const initResult = await run(["init", "--authority-domain", domain, "--json"]);
  assert.equal(initResult.status, 0);
  const init = envelope(initResult);
  assert.deepEqual(init.data, { path: resolve(databasePath), schemaVersion: 2, authorityDomainId: domain });
  assert.deepEqual(readdirSync(absentParent), ["kb.sqlite"]);
  assert.equal(statSync(absentParent).mode & 0o777, 0o700);
  assert.equal(statSync(databasePath).mode & 0o777, 0o600);

  const db = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, "2");
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='authority_domain_id'").get().value, domain);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 0);
  db.close();

  const statusResult = await run(["status", "--json"], { env: { AGENT_KB_EXPECTED_DOMAIN: domain } });
  assert.equal(statusResult.status, 0);
  const status = envelope(statusResult);
  assert.equal(status.ok, true);
  assert.equal(status.command, "status");
  assert.equal(status.data.authorityDomainId, domain);

  await expectError(["status", "--json"], "DOMAIN_MISMATCH", { env: { AGENT_KB_EXPECTED_DOMAIN: "44444444-4444-4444-8444-444444444444" } });
  await expectError(["get", "missing", "--json"], "NOT_FOUND");
  await expectError(["no-such-command", "--json"], "INVALID_COMMAND");
  await expectError(["upsert", "--input", "-", "--json"], "INVALID_INPUT", { input: JSON.stringify({ id: "proposal:bad", type: "proposal", title: "Bad", unknown: true }) });

  const arrayRecord = await writeJson({
    id: "proposal:arrays",
    type: "proposal",
    title: "Comma arrays",
    tags: ["alpha,beta", "gamma"],
    evidence: ["https://example.invalid/a,b", "local observation"],
  });
  assert.deepEqual(arrayRecord.tags, ["alpha,beta", "gamma"]);
  assert.deepEqual(arrayRecord.evidence, ["https://example.invalid/a,b", "local observation"]);
  assert.equal(arrayRecord.source, "agent");

  await writeJson({ id: "proposal:collision", type: "proposal", title: "Collision", source: "agent" });
  await writeJson({ id: "decision:collision", type: "decision", title: "Existing", source: "agent", durable: true });
  await expectError(["promote", "proposal:collision", "--input", "-", "--json"], "CONFLICT", { input: JSON.stringify({ id: "decision:collision", type: "decision" }) });
  const collisionProposal = envelope(await run(["get", "proposal:collision", "--json"]));
  assert.equal(collisionProposal.data.status, "open");
  const collisionDurable = envelope(await run(["get", "decision:collision", "--json"]));
  assert.equal(collisionDurable.data.title, "Existing");
  assert.equal(collisionDurable.data.promoted_from, null);

  await writeJson({ id: "proposal:atomic", type: "proposal", title: "Atomic", source: "agent" });
  const writable = new DatabaseSync(databasePath);
  writable.exec("CREATE TRIGGER reject_atomic_promotion BEFORE UPDATE ON records WHEN old.id='proposal:atomic' AND new.status='promoted' BEGIN SELECT RAISE(ABORT, 'injected atomic failure'); END;");
  writable.close();
  const atomicFailure = await run(["promote", "proposal:atomic", "--input", "-", "--json"], { input: JSON.stringify({ id: "decision:atomic", type: "decision" }) });
  assert.equal(atomicFailure.status, 1);
  assert.equal(envelope(atomicFailure).error.code, "INTERNAL_FAILURE");
  const atomicCheck = new DatabaseSync(databasePath);
  assert.equal(atomicCheck.prepare("SELECT status FROM records WHERE id='proposal:atomic'").get().status, "open");
  assert.equal(atomicCheck.prepare("SELECT COUNT(*) AS count FROM records WHERE id='decision:atomic'").get().count, 0);
  atomicCheck.exec("DROP TRIGGER reject_atomic_promotion");
  atomicCheck.close();

  await writeJson({ id: "proposal:concurrent", type: "proposal", title: "Concurrent", source: "agent" });
  const promotionInput = JSON.stringify({ id: "decision:concurrent", type: "decision" });
  const concurrent = await Promise.all([
    run(["promote", "proposal:concurrent", "--input", "-", "--json"], { input: promotionInput }),
    run(["promote", "proposal:concurrent", "--input", "-", "--json"], { input: promotionInput }),
  ]);
  assert.deepEqual(concurrent.map((result) => result.status).sort(), [0, 2]);
  const failedConcurrent = concurrent.find((result) => result.status === 2);
  assert.equal(envelope(failedConcurrent).error.code, "CONFLICT");
  const lineage = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(lineage.prepare("SELECT status FROM records WHERE id='proposal:concurrent'").get().status, "promoted");
  assert.equal(lineage.prepare("SELECT promoted_from FROM records WHERE id='decision:concurrent'").get().promoted_from, "proposal:concurrent");
  assert.equal(lineage.prepare("SELECT COUNT(*) AS count FROM records WHERE promoted_from='proposal:concurrent'").get().count, 1);
  lineage.close();

  report = {
    ok: true,
    contract_version: "1",
    cases: 9,
    authority_domain: domain,
    isolated_root: root,
    live_database_touched: false,
  };
} finally {
  process.chdir(tmpdir());
  rmSync(root, { recursive: true, force: true });
}
assert.equal(existsSync(root), false, "contract test cleanup failed");
console.log(JSON.stringify({ ...report, cleanup: true }, null, 2));
