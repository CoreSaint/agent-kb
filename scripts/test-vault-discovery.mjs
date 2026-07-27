#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

process.umask(0o077);
const root = await import("node:fs").then(({ mkdtempSync }) => mkdtempSync(join(tmpdir(), "agent-kb-path-resolution-")));
const home = join(root, "home");
const vault = join(root, "contract-vault");
const nested = join(vault, "projects", "example", "notes");
const ordinary = join(root, "ordinary-cwd");
const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli.ts");
const baseEnv = { ...process.env, HOME: home };
delete baseEnv.AGENT_KB_PATH;
delete baseEnv.AGENT_KB_EXPECTED_DOMAIN;
const defaultDatabase = join(home, ".local", "share", "agent-kb", "kb.sqlite");

function run(cwd, args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, env: { ...baseEnv, ...env }, encoding: "utf8" });
}
function envelope(result) {
  assert.equal(result.stderr, "", result.stderr);
  return JSON.parse(result.stdout);
}

let report;
try {
  mkdirSync(nested, { recursive: true, mode: 0o700 });
  mkdirSync(ordinary, { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(vault, "CONTRACT.md"), "# Test contract\n", { mode: 0o600 });
  writeFileSync(join(vault, "MAP.md"), "# Test map\n", { mode: 0o600 });

  for (const cwd of [vault, nested, ordinary]) {
    const result = run(cwd, ["path", "--json"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(envelope(result).data.path, defaultDatabase);
  }
  const linked = join(root, "linked-vault-subdirectory");
  symlinkSync(nested, linked, "dir");
  const linkedResult = run(linked, ["path", "--json"]);
  assert.equal(linkedResult.status, 0, linkedResult.stderr || linkedResult.stdout);
  assert.equal(envelope(linkedResult).data.path, defaultDatabase);
  assert.equal(existsSync(join(vault, ".agent-kb")), false, "path resolution created vault state");

  const overrideDatabase = join(root, "explicit", "override.sqlite");
  const overridden = run(nested, ["path", "--json"], { AGENT_KB_PATH: overrideDatabase });
  assert.equal(overridden.status, 0, overridden.stderr || overridden.stdout);
  assert.equal(envelope(overridden).data.path, overrideDatabase);

  const init = run(nested, ["init", "--authority-domain", "66666666-6666-4666-8666-666666666666", "--json"]);
  assert.equal(init.status, 0, init.stderr || init.stdout);
  assert.equal(envelope(init).data.path, defaultDatabase);
  assert.equal(existsSync(defaultDatabase), true);
  assert.equal(existsSync(join(vault, ".agent-kb")), false, "init created vault state");
  report = { default_database: defaultDatabase, cwd_independent: true, vault_state_created: false };
} finally {
  rmSync(root, { recursive: true, force: true });
}
assert.equal(existsSync(root), false, "path resolution cleanup failed");
console.log(JSON.stringify({ ok: true, ...report, cleanup: true }, null, 2));
