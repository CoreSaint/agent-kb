#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.umask(0o077);
const root = mkdtempSync(join(tmpdir(), "agent-kb-vault-discovery-"));
const home = join(root, "home");
const vault = join(root, "contract-vault");
const nested = join(vault, "projects", "example", "notes");
const fallbackCwd = join(root, "not-a-vault", "child");
const cliPath = resolve(import.meta.dirname, "../src/cli.ts");
const baseEnv = { ...process.env, HOME: home };
delete baseEnv.AGENT_KB_PATH;
delete baseEnv.AGENT_KB_EXPECTED_DOMAIN;
assert.ok(resolve(baseEnv.HOME).startsWith(`${resolve(root)}/`));
process.chdir(root);

function run(cwd, args, env = {}) {
  assert.ok(resolve(cwd).startsWith(`${resolve(root)}/`), "CLI cwd escaped test root");
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: { ...baseEnv, ...env },
    encoding: "utf8",
  });
  assert.equal(result.signal, null);
  return result;
}

function machine(result) {
  assert.equal(result.stderr, "", `machine stderr was not empty: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

let report;
try {
  mkdirSync(nested, { recursive: true, mode: 0o700 });
  mkdirSync(fallbackCwd, { recursive: true, mode: 0o700 });
  writeFileSync(join(vault, "CONTRACT.md"), "# Test contract\n", { mode: 0o600 });
  writeFileSync(join(vault, "MAP.md"), "# Test map\n", { mode: 0o600 });
  chmodSync(vault, 0o750);
  const discoveredDatabase = join(vault, ".agent-kb", "kb.sqlite");

  const rootPath = run(vault, ["path", "--json"]);
  assert.equal(rootPath.status, 0);
  assert.equal(machine(rootPath).data.path, discoveredDatabase);

  const nestedPath = run(nested, ["path", "--json"]);
  assert.equal(nestedPath.status, 0);
  assert.equal(machine(nestedPath).data.path, discoveredDatabase);

  const overrideDatabase = join(root, "explicit", "override.sqlite");
  const overridePath = run(nested, ["path", "--json"], { AGENT_KB_PATH: overrideDatabase });
  assert.equal(overridePath.status, 0);
  assert.equal(machine(overridePath).data.path, overrideDatabase);
  assert.equal(existsSync(join(vault, ".agent-kb")), false, "path resolution created vault state");

  const fallbackPath = run(fallbackCwd, ["path", "--json"]);
  assert.equal(fallbackPath.status, 0);
  assert.equal(machine(fallbackPath).data.path, join(home, ".local", "share", "agent-kb", "kb.sqlite"));

  for (const command of [["status", "--json"], ["search", "missing", "--json"]]) {
    const result = run(nested, command);
    assert.equal(result.status, 2);
    const error = machine(result);
    assert.equal(error.error.code, "DB_NOT_INITIALIZED");
    assert.match(error.error.message, /contract-vault\/\.agent-kb\/kb\.sqlite/);
    assert.equal(existsSync(join(vault, ".agent-kb")), false, `${command[0]} created vault state`);
  }

  const symlinkCwd = join(root, "linked-vault-subdirectory");
  symlinkSync(nested, symlinkCwd, "dir");
  const symlinkPath = run(symlinkCwd, ["path", "--json"]);
  assert.equal(symlinkPath.status, 0);
  assert.equal(machine(symlinkPath).data.path, discoveredDatabase);

  const init = run(nested, ["init", "--authority-domain", "66666666-6666-4666-8666-666666666666", "--json"]);
  assert.equal(init.status, 0, init.stdout || init.stderr);
  assert.equal(machine(init).data.path, discoveredDatabase);
  assert.equal(statSync(vault).mode & 0o777, 0o750, "init changed the vault root mode");
  assert.equal(statSync(join(vault, ".agent-kb")).mode & 0o777, 0o700);
  assert.equal(statSync(discoveredDatabase).mode & 0o777, 0o600);

  report = {
    ok: true,
    cases: 6,
    discovery: "physical path upward from cwd",
    fallback: join(home, ".local", "share", "agent-kb", "kb.sqlite"),
    cleanup: false,
  };
} finally {
  process.chdir(tmpdir());
  rmSync(root, { recursive: true, force: true });
}
assert.equal(existsSync(root), false, "vault discovery cleanup failed");
console.log(JSON.stringify({ ...report, cleanup: true }, null, 2));
